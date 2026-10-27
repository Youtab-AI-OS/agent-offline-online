/** Bounded, headless common-Setup coordination. Never probes legacy GUI flags. */
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'

import { acquireSetupLease, type SetupLease, type SetupLeasePin } from './setup-native-lease'

const execute = promisify(execFile)
export const COORDINATION_TIMEOUT_MS = 15_000
export const COORDINATION_OUTPUT_LIMIT = 64 * 1024

/** Only a resolver bound to verified immutable release metadata may produce
 * this identity; updater_protocol alone does not establish headless support. */
export interface CoordinationSetup {
  executable: string
  sourceSha: string
  sha256: string
  size: number
  protocol: 1
  handoffProtocol?: 2
  lease: SetupLease
}
export type CoordinationOperation = 'inspect' | 'publish'
export type CoordinationResult =
  | { status: 'clear' | 'published', reason: string }
  | { status: 'blocked', reason: string }
export interface CoordinationDeps {
  resolveSetup: () => Promise<CoordinationSetup | null>
  execute?: (file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string, stderr: string }>
  now?: () => number
}

/** Customer About updates require the native Setup handoff. Older stamps must
 * use the preserving common-Setup migration instead of a path-based launch. */
export function canAttemptNativeCustomerHandoff(metadata: unknown): boolean {
  return !!metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    && (metadata as Record<string, unknown>).handoffProtocol === 2
}

function safeAbsolute(value: string): boolean {
  // Win32 device/NT namespace aliases are not supported admission inputs.
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)
    && !value.includes('\0') && !value.slice(2).includes(':')
    && !value.split(/[\\/]/).slice(1).some(part => part === '..' || /[. ]$/.test(part))
}

/** The executable lives in the admitted packaged code namespace, never the
 * mutable coordination HOME. Producer stages the same common Setup bytes.
 * Missing legacy resources require preserving common-Setup migration. */
export function packagedCoordinationExecutable(resourcesPath: unknown, packaged: boolean): string | null {
  if (!packaged || typeof resourcesPath !== 'string' || !safeAbsolute(resourcesPath)) {return null}
  return path.win32.join(resourcesPath, 'update-coordination', 'Youtab-Setup.exe')
}

/** Developer execution is explicit and uses the same qualified Setup under
 * an admitted private build namespace. It never probes an arbitrary HOME exe. */
export function developmentCoordinationExecutable(appRoot: unknown, metadata: unknown): string | null {
  if (typeof appRoot !== 'string' || !safeAbsolute(appRoot) || !metadata || typeof metadata !== 'object'
    || Array.isArray(metadata) || (metadata as Record<string, unknown>).developmentOnly !== true) {return null}
  return path.win32.join(appRoot, 'build', 'update-coordination', 'Youtab-Setup.exe')
}

export function parseCoordinationOutput(raw: string, operation: CoordinationOperation): CoordinationResult {
  if (Buffer.byteLength(raw, 'utf8') > COORDINATION_OUTPUT_LIMIT) {throw new Error('output-limit')}
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('schema')}
  const obj = value as Record<string, unknown>
  if (Object.keys(obj).sort().join(',') !== 'protocol,reason,status,version'
    || obj.protocol !== 'youtab.update-coordination' || obj.version !== 1
    || typeof obj.reason !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(obj.reason)
    || (obj.status !== 'blocked' && obj.status !== (operation === 'inspect' ? 'clear' : 'published'))) {
    throw new Error('schema')
  }
  const blockedReasons = new Set(['invalid-request', 'unsupported-platform', 'identity-unverifiable', 'namespace-unverifiable', 'unsafe-home', 'unsafe-object', 'namespace-changed', 'coordination-unavailable', 'marker-unverifiable', 'update-active', 'clock-unverifiable', 'invalid-publication', 'publication-unavailable'])
  if ((obj.status === 'blocked' && !blockedReasons.has(obj.reason))
    || (obj.status === 'clear' && obj.reason !== 'no-active-update')
    || (obj.status === 'published' && obj.reason !== 'handoff-published')) {throw new Error('reason-schema')}
  return { status: obj.status as CoordinationResult['status'], reason: obj.reason }
}

export async function coordinateWindowsUpdate(
  home: string,
  operation: CoordinationOperation,
  deps: CoordinationDeps,
  pid?: number
): Promise<CoordinationResult> {
  let identity: CoordinationSetup | null = null
  try {
    if (!safeAbsolute(home)) {return { status: 'blocked', reason: 'unsafe-namespace' }}
    identity = await deps.resolveSetup()
    if (!identity || identity.protocol !== 1 || !safeAbsolute(identity.executable)
      || !/^[0-9a-f]{40}$/.test(identity.sourceSha) || !/^[0-9a-f]{64}$/.test(identity.sha256)
      || !Number.isSafeInteger(identity.size) || identity.size < 64 || identity.size > 256 * 1024 * 1024
      || !identity.lease || typeof identity.lease.close !== 'function') {
      return { status: 'blocked', reason: 'compatible-setup-unavailable' }
    }
    const args = ['--update-coordination-v1', operation, '--home', home]
    if (operation === 'publish') {
      const now = (deps.now || Date.now)()
      if (!Number.isInteger(pid) || pid! < 1 || pid! > 0xffffffff || !Number.isSafeInteger(now) || now <= 0) {
        return { status: 'blocked', reason: 'invalid-handoff' }
      }
      args.push('--pid', String(pid), '--created-at', String(now), '--instance', randomUUID())
    }
    const result = await (deps.execute || execute)(identity.executable, args, {
      shell: false, windowsHide: true, timeout: COORDINATION_TIMEOUT_MS,
      maxBuffer: COORDINATION_OUTPUT_LIMIT, encoding: 'utf8',
      cwd: path.win32.dirname(identity.executable),
      // Headless Rust mode creates no children or GUI; execFile owns and kills
      // exactly this process on timeout/overflow. Native proof is mandatory.
      killSignal: 'SIGKILL'
    })
    if (String(result.stderr || '').trim()) {return { status: 'blocked', reason: 'probe-failure' }}
    return parseCoordinationOutput(String(result.stdout), operation)
  } catch (error) {
    // Native exit2 is a deliberate closed outcome, not an execution failure.
    // A killed, signalled, overflowing or otherwise failed process cannot ACK.
    const failed = error as { code?: unknown, killed?: unknown, signal?: unknown, stdout?: unknown, stderr?: unknown }
    if (failed?.code === 2 && failed.killed === false && failed.signal === null
      && typeof failed.stdout === 'string' && typeof failed.stderr === 'string' && failed.stderr === '') {
      try {
        const result = parseCoordinationOutput(failed.stdout, operation)
        if (result.status === 'blocked') {return result}
      } catch { /* malformed native failure remains closed below */ }
    }
    // No exception, null or a truthy Promise may grant clearance.
    return { status: 'blocked', reason: 'probe-failure' }
  } finally {
    // execFile resolves or rejects after the native child closes. The file
    // remains pinned during argument parsing, execution and native ACK.
    identity?.lease?.close()
  }
}


/** Verify the fixed bundled common Setup against its immutable build stamp.
 * No unknown executable is invoked to ask whether it supports this flag.
 * Timeout never launches the eventual late file-read result. */
export async function verifyCoordinationSetup(
  executable: string,
  metadata: unknown,
  sourceSha: unknown,
  developmentOnly = false,
  setupLeasePin?: SetupLeasePin,
  acquireLease: typeof acquireSetupLease = acquireSetupLease
): Promise<CoordinationSetup | null> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {return null}
  const value = metadata as Record<string, unknown>
  const keys = (developmentOnly ? ['developmentOnly'] : []).concat(value.handoffProtocol === 2 ? ['handoffProtocol'] : [], ['protocol', 'sha256', 'size', 'sourceSha'])
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || (developmentOnly && value.developmentOnly !== true)
    || value.protocol !== 1 || value.sourceSha !== sourceSha
    || typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(sourceSha)
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.size) || (value.size as number) < 64 || (value.size as number) > 256 * 1024 * 1024
    || !safeAbsolute(executable)) {return null}
  if (!setupLeasePin) {return null}
  try {
    const lease = acquireLease(executable, value.sha256 as string, value.size as number, setupLeasePin)
    return { executable, sourceSha, sha256: value.sha256 as string, size: value.size as number,
      protocol: 1, lease, ...(value.handoffProtocol === 2 ? { handoffProtocol: 2 as const } : {}) }
  } catch { return null }
}
