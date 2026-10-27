import { createHash, createPublicKey, type JsonWebKey, verify } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'

export const INNO_UPDATE_FEED = 'https://api.youtab.io/desktop-updates/windows-v1'
export const INNO_METADATA_LIMIT = 64 * 1024
export const INNO_INSTALLER_LIMIT = 8 * 1024 * 1024 * 1024
export type InnoUpdateChannel = 'stable' | 'pilot'
export interface InnoUpdateTrustRoot {
  protocol: 1
  keyId: string
  publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  feedBaseUrl: string
  sequence: number
  buildId: string
}
export interface InnoReleasePayload {
  product: 'io.youtab.agent'
  format: 'inno-full/v1'
  platform: 'windows'
  arch: 'x64'
  sequence: number
  buildId: string
  sourceSha: string
  version: string
  channel: InnoUpdateChannel
  createdAt: number
  expiresAt: number
  dataSchema: 1
  installer: { fileName: 'Youtab-Setup.exe'; sha256: string; size: number }
  payloadManifestSha256: string
}
/** Must come from embedded trust plus verified installed bytes/accepted signed receipt, never a new envelope. */
export interface InnoReleaseFloor {
  sequence: number
  buildId: string
  payloadSha256?: string
  installerSha256?: string
}
export interface AuthenticatedInnoRelease {
  readonly keyId: string
  readonly payloadSha256: string
  readonly payload: Readonly<InnoReleasePayload>
}
export interface InnoReleaseOptions {
  channel: InnoUpdateChannel
  floor?: InnoReleaseFloor
  now?: number
}
export interface InnoHttpsResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  close: () => void
}
export type InnoHttpsTransport = (url: URL, signal: AbortSignal, bearerToken?: string) => Promise<InnoHttpsResponse>
export interface InnoTransferOptions {
  signal?: AbortSignal
  timeoutMs?: number
  bearerToken?: string
  /** Unit-test seam only. Production calls reject this field unless NODE_ENV=test. */
  testTransport?: InnoHttpsTransport
}
export interface AdmittedInnoInstaller {
  filePath: string
  sha256: string
  size: number
  release: AuthenticatedInnoRelease
}

const HASH = /^[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{40}$/
const authenticated = new WeakSet<object>()

function fail(reason: string): never {
  throw new Error(`inno-update:${reason}`)
}

const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...fields].sort().join(',')
  )
    {fail(`${label}-schema`)}

  return value as Record<string, unknown>
}

function base64url(value: unknown, bytes?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {fail('base64url')}
  const result = Buffer.from(value, 'base64url')

  if (result.toString('base64url') !== value || (bytes !== undefined && result.length !== bytes)) {fail('base64url')}

  return result
}

/** Reject ambiguous duplicate keys, malformed UTF-8 and excessive nesting before JSON interpretation. */
function json(bytes: Uint8Array): unknown {
  let text: string

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('utf8')
  }

  let index = 0

  const space = () => {
    while (/\s/.test(text[index] || '') && index < text.length) {index++}
  }

  const string = (): string => {
    const begin = index++

    while (index < text.length) {
      if (text[index++] === '"') {return JSON.parse(text.slice(begin, index)) as string}

      if (text[index - 1] === '\\') {index++}
    }

    return fail('json')
  }

  const value = (depth: number) => {
    if (depth > 8) {fail('json-depth')}
    space()

    if (text[index] === '"') {
      string()

      return
    }

    if (text[index] === '{') {
      index++
      space()
      const keys = new Set<string>()

      if (text[index] === '}') {
        index++

        return
      }

      while (index < text.length) {
        space()

        if (text[index] !== '"') {fail('json')}
        const key = string()

        if (keys.has(key)) {fail('duplicate-key')}
        keys.add(key)
        space()

        if (text[index++] !== ':') {fail('json')}
        value(depth + 1)
        space()
        const delimiter = text[index++]

        if (delimiter === '}') {return}

        if (delimiter !== ',') {fail('json')}
      }

      fail('json')
    }

    if (text[index] === '[') {
      index++
      space()

      if (text[index] === ']') {
        index++

        return
      }

      while (index < text.length) {
        value(depth + 1)
        space()
        const delimiter = text[index++]

        if (delimiter === ']') {return}

        if (delimiter !== ',') {fail('json')}
      }

      fail('json')
    }

    const begin = index

    while (index < text.length && !/[\s,}\]]/.test(text[index])) {index++}

    if (index === begin) {fail('json')}
  }

  try {
    value(0)
    space()

    if (index !== text.length) {fail('json')}

    return JSON.parse(text)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('inno-update:')) {throw error}

    return fail('json')
  }
}

export function validateInnoUpdateTrustRoot(input: unknown): InnoUpdateTrustRoot {
  const root = object(input, ['protocol', 'keyId', 'publicKey', 'feedBaseUrl', 'sequence', 'buildId'], 'trust')
  const key = object(root.publicKey, ['kty', 'crv', 'x', 'y'], 'public-key')

  if (
    root.protocol !== 1 ||
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    !integer(root.sequence) ||
    typeof root.buildId !== 'string' ||
    !HASH.test(root.buildId) ||
    root.feedBaseUrl !== INNO_UPDATE_FEED
  )
    {fail('trust-value')}

  const blob = Buffer.concat([Buffer.from('4543533120000000', 'hex'), base64url(key.x, 32), base64url(key.y, 32)])

  if (root.keyId !== hash(blob)) {fail('trust-key-id')}

  try {
    createPublicKey({ key: key as unknown as JsonWebKey, format: 'jwk' })
  } catch {
    fail('public-key')
  }

  return input as InnoUpdateTrustRoot
}

function releasePayload(input: unknown, channel: InnoUpdateChannel, now: number): InnoReleasePayload {
  const release = object(
    input,
    [
      'product',
      'format',
      'platform',
      'arch',
      'sequence',
      'buildId',
      'sourceSha',
      'version',
      'channel',
      'createdAt',
      'expiresAt',
      'dataSchema',
      'installer',
      'payloadManifestSha256'
    ],
    'payload'
  )

  const installer = object(release.installer, ['fileName', 'sha256', 'size'], 'installer')

  if (
    release.product !== 'io.youtab.agent' ||
    release.format !== 'inno-full/v1' ||
    release.platform !== 'windows' ||
    release.arch !== 'x64' ||
    release.dataSchema !== 1 ||
    release.channel !== channel ||
    !integer(release.sequence) ||
    typeof release.buildId !== 'string' ||
    !HASH.test(release.buildId) ||
    typeof release.sourceSha !== 'string' ||
    !SHA.test(release.sourceSha) ||
    typeof release.version !== 'string' ||
    !/^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(release.version) ||
    typeof release.payloadManifestSha256 !== 'string' ||
    !HASH.test(release.payloadManifestSha256) ||
    installer.fileName !== 'Youtab-Setup.exe' ||
    typeof installer.sha256 !== 'string' ||
    !HASH.test(installer.sha256) ||
    !integer(installer.size) ||
    installer.size > INNO_INSTALLER_LIMIT
  )
    {fail('payload-value')}

  if (
    !integer(now) ||
    !integer(release.createdAt) ||
    !integer(release.expiresAt) ||
    release.createdAt > now ||
    release.expiresAt <= now ||
    release.expiresAt <= release.createdAt
  )
    {fail('release-time')}

  return input as InnoReleasePayload
}

/** Producer admission only: validates bytes before key access; does not authenticate or grant download authority. */
export function validateInnoReleasePayloadForProducer(
  bytes: Uint8Array,
  channel: InnoUpdateChannel,
  now = Date.now()
): InnoReleasePayload {
  if (channel !== 'stable' && channel !== 'pilot') {fail('channel')}

  if (!bytes.byteLength || bytes.byteLength > INNO_METADATA_LIMIT) {fail('metadata-limit')}

  return releasePayload(json(bytes), channel, now)
}

export function verifyInnoReleaseEnvelope(
  bytes: Uint8Array,
  trusted: unknown,
  options: InnoReleaseOptions
): AuthenticatedInnoRelease {
  const trust = validateInnoUpdateTrustRoot(trusted)

  if (options.channel !== 'stable' && options.channel !== 'pilot') {fail('channel')}

  if (bytes.byteLength > INNO_METADATA_LIMIT || bytes.byteLength === 0) {fail('metadata-limit')}
  const envelope = object(json(bytes), ['schemaVersion', 'keyId', 'payload', 'signature'], 'envelope')

  if (envelope.schemaVersion !== 1 || envelope.keyId !== trust.keyId) {fail('envelope-value')}
  const payloadBytes = base64url(envelope.payload)
  const signature = base64url(envelope.signature, 64)
  const key = createPublicKey({ key: trust.publicKey, format: 'jwk' })

  if (!verify('sha256', payloadBytes, { key, dsaEncoding: 'ieee-p1363' }, signature)) {fail('signature')}
  const payload = releasePayload(json(payloadBytes), options.channel, options.now ?? Date.now())
  const payloadSha256 = hash(payloadBytes)
  const floor = options.floor ?? { sequence: trust.sequence, buildId: trust.buildId }

  if (
    !integer(floor.sequence) ||
    typeof floor.buildId !== 'string' ||
    !HASH.test(floor.buildId) ||
    (floor.payloadSha256 !== undefined && !HASH.test(floor.payloadSha256)) ||
    (floor.installerSha256 !== undefined && !HASH.test(floor.installerSha256)) ||
    floor.sequence < trust.sequence ||
    (floor.sequence === trust.sequence && floor.buildId !== trust.buildId)
  )
    {fail('floor')}

  if (payload.sequence < floor.sequence) {fail('rollback')}

  if (payload.sequence === floor.sequence) {
    if (payload.buildId !== floor.buildId) {fail('sequence-identity')}

    if (floor.payloadSha256 !== undefined) {
      if (payloadSha256 !== floor.payloadSha256) {fail('sequence-content')}
    } else if (!floor.installerSha256 || payload.installer.sha256 !== floor.installerSha256) {fail('sequence-proof')}
  }

  Object.freeze(payload.installer)
  Object.freeze(payload)
  const result = Object.freeze({ keyId: trust.keyId, payloadSha256, payload })
  authenticated.add(result)

  return result
}

function assertRelease(release: AuthenticatedInnoRelease) {
  if (!release || !authenticated.has(release)) {fail('unauthenticated-release')}
}

export function innoUpdateIndexUrl(trusted: unknown, channel: InnoUpdateChannel): URL {
  const trust = validateInnoUpdateTrustRoot(trusted)

  if (channel !== 'stable' && channel !== 'pilot') {fail('channel')}

  return new URL(`${trust.feedBaseUrl}/channels/${channel}/latest.json`)
}

export function innoInstallerUrl(trusted: unknown, release: AuthenticatedInnoRelease): URL {
  const trust = validateInnoUpdateTrustRoot(trusted)
  assertRelease(release)

  if (release.keyId !== trust.keyId) {fail('release-key')}

  return new URL(`${trust.feedBaseUrl}/${release.payload.sequence}/Youtab-Setup.exe`)
}

const strictHttps: InnoHttpsTransport = (url, signal, bearerToken) =>
  new Promise((resolve, reject) => {
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.youtab.io' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      {return reject(new Error('inno-update:network-origin'))}

    if (bearerToken !== undefined && (!bearerToken || bearerToken.length > 8192 || Array.from(bearerToken).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)))
      {return reject(new Error('inno-update:authorization'))}

    const request = https.get(
      url,
      {
        agent: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        signal,
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
        }
      },
      response => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          close: () => response.destroy()
        })
      }
    )

    request.once('error', reject)
  })

function transport(options: InnoTransferOptions): InnoHttpsTransport {
  if (options.testTransport) {
    if (process.env.NODE_ENV !== 'test') {fail('test-transport-in-production')}

    return options.testTransport
  }

  return strictHttps
}

function transferSignal(options: InnoTransferOptions, fallback: number) {
  if (options.signal?.aborted) {fail('cancelled')}
  const milliseconds = options.timeoutMs ?? fallback

  if (!integer(milliseconds) || milliseconds > 30 * 60_000) {fail('timeout-value')}
  const controller = new AbortController()
  const external = () => controller.abort(new Error('inno-update:cancelled'))
  options.signal?.addEventListener('abort', external, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('inno-update:timeout')), milliseconds)
  timer.unref?.()

  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', external)
    }
  }
}

function abort(signal: AbortSignal): never {
  throw signal.reason instanceof Error ? signal.reason : new Error('inno-update:cancelled')
}

async function interruptible<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {abort(signal)}

  return new Promise((resolve, reject) => {
    const cancelled = () => {
      try {
        abort(signal)
      } catch (error) {
        reject(error)
      }
    }

    signal.addEventListener('abort', cancelled, { once: true })
    void value.then(
      result => {
        signal.removeEventListener('abort', cancelled)
        resolve(result)
      },
      error => {
        signal.removeEventListener('abort', cancelled)
        reject(error)
      }
    )
  })
}

async function* chunks(response: InnoHttpsResponse, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = response.body[Symbol.asyncIterator]()

  try {
    while (true) {
      const result = await interruptible(Promise.resolve(iterator.next()), signal)

      if (result.done) {return}

      if (!(result.value instanceof Uint8Array)) {fail('response-chunk')}
      yield result.value
    }
  } finally {
    response.close()
    void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
}

function responseStatus(response: InnoHttpsResponse, expectedSize?: number) {
  if (response.statusCode >= 300 && response.statusCode < 400) {fail('redirect')}

  if (response.statusCode === 401 || response.statusCode === 403) {fail('sign-in-required')}

  if (response.statusCode !== 200) {fail(`http-${response.statusCode}`)}
  const encoding = response.headers['content-encoding']

  if (encoding !== undefined && encoding !== 'identity') {fail('content-encoding')}
  const size = response.headers['content-length']

  if (
    size !== undefined &&
    (typeof size !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(size) ||
      !Number.isSafeInteger(Number(size)) ||
      Number(size) > (expectedSize ?? INNO_METADATA_LIMIT) ||
      (expectedSize !== undefined && Number(size) !== expectedSize))
  )
    {fail('content-length')}
}

export async function fetchInnoRelease(
  trust: unknown,
  options: InnoReleaseOptions & InnoTransferOptions
): Promise<AuthenticatedInnoRelease> {
  return (await fetchInnoReleaseEnvelope(trust, options)).release
}

/** Keeps the authenticated original bytes for durable receipts and native handoff. */
export async function fetchInnoReleaseEnvelope(
  trust: unknown,
  options: InnoReleaseOptions & InnoTransferOptions
): Promise<{ release: AuthenticatedInnoRelease; envelope: Uint8Array }> {
  const url = innoUpdateIndexUrl(trust, options.channel)
  const selected = transport(options)
  const deadline = transferSignal(options, 15_000)
  let response: InnoHttpsResponse | undefined

  try {
    response = await interruptible(selected(url, deadline.signal, options.bearerToken), deadline.signal)
    responseStatus(response)
    const parts: Uint8Array[] = []
    let size = 0

    for await (const chunk of chunks(response, deadline.signal)) {
      size += chunk.byteLength

      if (size > INNO_METADATA_LIMIT) {fail('metadata-limit')}
      parts.push(chunk)
    }

    if (response.headers['content-length'] !== undefined && size !== Number(response.headers['content-length']))
      {fail('partial-metadata')}

    const envelope = Buffer.concat(parts)

    return { release: verifyInnoReleaseEnvelope(envelope, trust, options), envelope }
  } finally {
    response?.close()
    deadline.close()
  }
}

function localPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    Array.from(value).some(character => character.charCodeAt(0) <= 31) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  )
    {fail('local-path')}

  const segments = value.split(/[\\/]/).filter(Boolean)

  if (segments.some(part => part === '..' || part === '.' || /[. ]$/.test(part))) {fail('local-path')}

  if (
    process.platform === 'win32' &&
    (!/^[a-z]:[\\/]/i.test(value) ||
      value.slice(2).includes(':') ||
      segments.slice(1).some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
  )
    {fail('local-path')}

  return path.resolve(value)
}

const samePath = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

async function noLinks(value: string) {
  let current = localPath(value)

  while (true) {
    const stat = await fs.lstat(current)

    if (stat.isSymbolicLink() || !samePath(await fs.realpath(current), current)) {fail('reparse-path')}
    const parent = path.dirname(current)

    if (parent === current) {return}
    current = parent
  }
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }) {
  return left.dev === right.dev && left.ino === right.ino
}

async function receiveInstaller(
  body: AsyncIterable<Uint8Array>,
  release: AuthenticatedInnoRelease,
  directory: string,
  signal: AbortSignal
): Promise<AdmittedInnoInstaller> {
  assertRelease(release)

  if (release.payload.createdAt > Date.now() || release.payload.expiresAt <= Date.now()) {fail('release-time')}

  if (signal.aborted) {abort(signal)}
  const root = localPath(directory)
  await noLinks(root)

  if (!(await fs.lstat(root)).isDirectory()) {fail('destination-directory')}
  const filePath = path.join(root, 'Youtab-Setup.exe')

  if (path.dirname(filePath) !== root) {fail('destination-scope')}

  const handle = await fs.open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600
  )

  let owned: Stats | undefined
  let completed = false

  try {
    owned = await handle.stat()
    await noLinks(root)

    if (!sameFile(owned, await fs.lstat(filePath))) {fail('destination-changed')}
    const digest = createHash('sha256')
    let size = 0

    for await (const chunk of body) {
      if (signal.aborted) {abort(signal)}
      size += chunk.byteLength

      if (size > release.payload.installer.size || size > INNO_INSTALLER_LIMIT) {fail('installer-size')}
      digest.update(chunk)

      for (let offset = 0; offset < chunk.byteLength; ) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)

        if (bytesWritten <= 0) {fail('installer-write')}
        offset += bytesWritten
      }
    }

    if (signal.aborted) {abort(signal)}

    if (release.payload.expiresAt <= Date.now()) {fail('release-time')}
    const sha256 = digest.digest('hex')

    if (size !== release.payload.installer.size || sha256 !== release.payload.installer.sha256)
      {fail('installer-integrity')}

    await handle.sync()
    await noLinks(root)
    const result = await fs.lstat(filePath)

    if (result.isSymbolicLink() || !sameFile(owned, result) || result.size !== size) {fail('destination-changed')}
    completed = true

    return { filePath, sha256, size, release }
  } finally {
    await handle.close()

    if (!completed && owned) {
      try {
        await noLinks(root)
        const current = await fs.lstat(filePath)

        if (!current.isSymbolicLink() && sameFile(owned, current)) {await fs.unlink(filePath)}
      } catch {
        /* Never remove a replaced object or another owner's path. */
      }
    }
  }
}

export async function downloadInnoInstaller(
  release: AuthenticatedInnoRelease,
  trust: unknown,
  directory: string,
  options: InnoTransferOptions = {}
): Promise<AdmittedInnoInstaller> {
  const url = innoInstallerUrl(trust, release)
  const selected = transport(options)
  const deadline = transferSignal(options, 15 * 60_000)
  let response: InnoHttpsResponse | undefined

  try {
    response = await interruptible(selected(url, deadline.signal, options.bearerToken), deadline.signal)
    responseStatus(response, release.payload.installer.size)

    return await receiveInstaller(chunks(response, deadline.signal), release, directory, deadline.signal)
  } finally {
    response?.close()
    deadline.close()
  }
}

export async function admitOfflineInnoInstaller(
  sourceFile: string,
  release: AuthenticatedInnoRelease,
  directory: string,
  options: Pick<InnoTransferOptions, 'signal' | 'timeoutMs'> = {}
): Promise<AdmittedInnoInstaller> {
  assertRelease(release)
  const deadline = transferSignal(options, 15 * 60_000)
  let handle: FileHandle | undefined

  try {
    const source = localPath(sourceFile)

    if (path.basename(source) !== 'Youtab-Setup.exe') {fail('offline-file-name')}
    handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    await noLinks(source)
    const before = await fs.lstat(source)

    if (!before.isFile() || before.size !== release.payload.installer.size || before.size > INNO_INSTALLER_LIMIT)
      {fail('offline-file-size')}
    if (!sameFile(opened, before) || opened.size !== before.size) {fail('offline-source-changed')}
    const sourceHandle = handle

    async function* input() {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let position = 0

      while (true) {
        const { bytesRead } = await interruptible(
          sourceHandle.read(buffer, 0, buffer.length, position),
          deadline.signal
        )

        if (!bytesRead) {break}
        position += bytesRead
        yield buffer.subarray(0, bytesRead)
      }

      const after = await sourceHandle.stat()

      if (!sameFile(after, before) || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        {fail('offline-source-changed')}
    }

    return await receiveInstaller(input(), release, directory, deadline.signal)
  } finally {
    await handle?.close()
    deadline.close()
  }
}
