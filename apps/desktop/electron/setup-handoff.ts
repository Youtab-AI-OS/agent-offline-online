/** Versioned handoff to the installed common Setup. The native broker owns
 * staging, cross-process admission, child launch and cache leases. */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { type SetupRelease, verifySetupBytes } from './release-delivery'
import { type SetupLease } from './setup-native-lease'

const OUTPUT_LIMIT = 4 * 1024
const HANDOFF_MIN_TIMEOUT_MS = 120_000
const HANDOFF_MAX_TIMEOUT_MS = 20 * 60_000
const HANDOFF_MIN_BYTES_PER_SECOND = 256 * 1024

/** Allow a verified large Setup to cross a slow local pipe while bounding a
 * stalled broker. The Setup size is already limited by release metadata. */
export function setupHandoffTimeoutMs(size: number): number {
  if (!Number.isSafeInteger(size) || size < 1 || size > 256 * 1024 * 1024) {
    throw new Error('SETUP_HANDOFF_INVALID_INPUT')
  }
  return Math.min(HANDOFF_MAX_TIMEOUT_MS, Math.max(
    HANDOFF_MIN_TIMEOUT_MS,
    Math.ceil(size / HANDOFF_MIN_BYTES_PER_SECOND * 1000) + 60_000
  ))
}

const BLOCKED_REASONS = new Set([
  'invalid-request', 'unsupported-platform', 'unsafe-home', 'cache-unavailable',
  'cache-full', 'input-invalid', 'integrity-failed', 'stage-unavailable',
  'launch-unconfirmed', 'lease-unconfirmed', 'process-unverifiable'
])

export interface SetupHandoffStarted {
  pid: number
  createdAt: string
  stageId: string
}

export interface SetupHandoffInput {
  executable: string
  lease: SetupLease
  home: string
  channel: 'pilot' | 'stable'
  release: SetupRelease
  bytes: Uint8Array
  mode?: 'update' | 'repair'
}

type SpawnBroker = typeof spawn

function safeWindowsPath(value: string): boolean {
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)
    && !value.includes('\0') && !value.slice(2).includes(':')
    && !value.split(/[\\/]/).slice(1).some(part => part === '..' || /[. ]$/.test(part))
}

export function parseSetupHandoffResult(raw: string, exitCode: number | null, requestId: string): SetupHandoffStarted {
  if (Buffer.byteLength(raw, 'utf8') > OUTPUT_LIMIT || raw.trim().split('\n').length !== 1) {
    throw new Error('SETUP_HANDOFF_UNCONFIRMED')
  }

  let value: unknown

  try { value = JSON.parse(raw) } catch { throw new Error('SETUP_HANDOFF_UNCONFIRMED') }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('SETUP_HANDOFF_UNCONFIRMED')}
  const result = value as Record<string, unknown>

  if (result.protocol !== 'youtab.setup-handoff' || result.version !== 2) {throw new Error('SETUP_HANDOFF_UNCONFIRMED')}

  if (exitCode === 2 && result.status === 'blocked' && typeof result.reason === 'string'
    && BLOCKED_REASONS.has(result.reason)
    && Object.keys(result).sort().join(',') === 'protocol,reason,status,version') {
    throw new Error(`SETUP_HANDOFF_BLOCKED:${result.reason}`)
  }

  if (exitCode !== 0 || result.status !== 'started'
    || result.reason !== 'lease-held'
    || Object.keys(result).sort().join(',') !== 'createdAt,pid,protocol,reason,stageId,status,version'
    || !Number.isSafeInteger(result.pid) || (result.pid as number) < 1 || (result.pid as number) > 0xffffffff
    || typeof result.createdAt !== 'string' || !/^[1-9][0-9]{0,19}$/.test(result.createdAt)
    || result.stageId !== requestId) {throw new Error('SETUP_HANDOFF_UNCONFIRMED')}

  return { pid: result.pid as number, createdAt: result.createdAt, stageId: requestId }
}

export async function launchSetupHandoffV2(
  input: SetupHandoffInput,
  deps: { spawnBroker?: SpawnBroker, timeoutMs?: number, requestId?: string } = {}
): Promise<SetupHandoffStarted> {
  let requestId: string
  try {
    if (!input.lease || typeof input.lease.close !== 'function'
      || !safeWindowsPath(input.executable) || !safeWindowsPath(input.home)
      || !['pilot', 'stable'].includes(input.channel)
      || (input.mode !== undefined && input.mode !== 'update' && input.mode !== 'repair')
      || !/^[a-f0-9]{40}$/.test(input.release.sourceSha)) {throw new Error('SETUP_HANDOFF_INVALID_INPUT')}
    setupHandoffTimeoutMs(input.release.size)
    verifySetupBytes(input.release, input.bytes)
    requestId = deps.requestId ?? randomUUID()
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) {
      throw new Error('SETUP_HANDOFF_INVALID_INPUT')
    }
  } catch (error) {
    input.lease?.close()
    throw error
  }

  const args = [
    '--setup-handoff-v2', '--home', input.home,
    '--sha256', input.release.sha256, '--size', String(input.release.size),
    '--channel', input.channel, '--source-sha', input.release.sourceSha,
    '--request-id', requestId
  ]
  if (input.mode === 'repair') {args.push('--mode', 'repair')}

  const launch = deps.spawnBroker ?? spawn
  let broker: ChildProcessWithoutNullStreams

  try {
    broker = launch(input.executable, args, {
      shell: false, windowsHide: true, cwd: path.win32.dirname(input.executable),
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
  } catch {input.lease.close(); throw new Error('SETUP_HANDOFF_UNCONFIRMED')}

  return new Promise<SetupHandoffStarted>((resolve, reject) => {
    let settled = false
    let output = ''
    let outputBytes = 0
    let stderrBytes = 0

    const timeout = setTimeout(() => {
      broker.kill()
      finish(new Error('SETUP_HANDOFF_UNCONFIRMED'))
    }, deps.timeoutMs ?? setupHandoffTimeoutMs(input.release.size))

    function finish(error?: Error, result?: SetupHandoffStarted) {
      if (settled) {return}
      settled = true
      clearTimeout(timeout)

      if (error) {reject(error)} else {resolve(result!)}
    }

    broker.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length

      if (outputBytes > OUTPUT_LIMIT) {broker.kill(); finish(new Error('SETUP_HANDOFF_UNCONFIRMED'));

 return}

      output += chunk.toString('utf8')
    })
    broker.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length

      if (stderrBytes > OUTPUT_LIMIT) {broker.kill(); finish(new Error('SETUP_HANDOFF_UNCONFIRMED'))}
    })
    broker.stdin.on('error', () => { /* Early native refusal is reported on close. */ })
    broker.on('error', () => finish(new Error('SETUP_HANDOFF_UNCONFIRMED')))
    broker.on('close', code => {
      // Release only after the native broker is actually gone, including a
      // timeout/error that settled this Promise before its close event.
      input.lease.close()
      if (stderrBytes) {finish(new Error('SETUP_HANDOFF_UNCONFIRMED'));

 return}

      try {finish(undefined, parseSetupHandoffResult(output, code, requestId))}
      catch (error) {finish(error as Error)}
    })
    broker.stdin.end(Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength))
  })
}
