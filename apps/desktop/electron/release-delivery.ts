/** Common Setup metadata and verified sibling staging, independent of Electron. */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export type ReleaseChannel = 'pilot' | 'stable'

/** Bind an About preference to the installation it was chosen for. A later
 * explicit Setup selection wins, including a same-version channel change. */
export function channelPreferenceStamp(marker: unknown): string {
  const value = marker && typeof marker === 'object' ? marker as Record<string, unknown> : {}

  return createHash('sha256').update(JSON.stringify([value.pinnedCommit ?? null,
    value.releaseSequence ?? null, value.releaseChannel ?? null, value.channelSelectedAt ?? null])).digest('hex')
}

export function selectedReleaseChannel(config: unknown, marker: unknown): ReleaseChannel {
  const stored = config && typeof config === 'object' ? config as Record<string, unknown> : {}
  const installed = marker && typeof marker === 'object' ? marker as Record<string, unknown> : {}
  const value = stored.channelMarker === channelPreferenceStamp(marker) ? stored.channel : installed.releaseChannel

  return value === 'pilot' ? 'pilot' : 'stable'
}

export interface SetupRelease {
  sourceSha: string
  url: string
  sha256: string
  size: number
  sequence: number
  coordinationProtocol: 1
}

/** Never follow redirects or buffer beyond the authenticated descriptor size. */
export function downloadSetup(url: string, sizeLimit: number): Promise<Uint8Array> {
  const target = new URL(url)

  if (target.protocol !== 'https:' || target.hostname !== 'api.youtab.io' || target.port || target.username || target.password || target.search || target.hash) {
    throw new Error('UNSAFE_SETUP_URL')
  }

  if (!Number.isSafeInteger(sizeLimit) || sizeLimit < 1 || sizeLimit > 256 * 1024 * 1024) {throw new Error('INVALID_SETUP_SIZE')}

  return new Promise((resolve, reject) => {
    const request = https.get(target, { timeout: 15000 }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error('SETUP_DOWNLOAD_FAILED'))

        return
      }

      let bytes: Buffer
      try {
        bytes = Buffer.allocUnsafe(sizeLimit)
      } catch {
        request.destroy(new Error('SETUP_MEMORY_UNAVAILABLE'))
        return
      }
      let length = 0
      response.on('data', (chunk: Buffer) => {
        if (chunk.length > sizeLimit - length) {
          request.destroy(new Error('SETUP_SIZE_EXCEEDED'))
          return
        }

        chunk.copy(bytes, length)
        length += chunk.length
      })
      response.on('error', reject)
      response.on('end', () => {
        if (length !== sizeLimit) {reject(new Error('SETUP_SIZE_MISMATCH')); return}
        resolve(bytes)
      })
    })

    const deadline = setTimeout(() => request.destroy(new Error('SETUP_DOWNLOAD_TIMED_OUT')), 15 * 60 * 1000)
    request.on('timeout', () => request.destroy(new Error('SETUP_DOWNLOAD_TIMED_OUT')))
    request.on('error', reject)
    request.on('close', () => clearTimeout(deadline))
  })
}

export function releaseBase(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\/api\.youtab\.io\/pilot-runtime-[0-9a-f]{32,}\/releases$/.test(value)) {
    throw new Error('INVALID_RELEASE_BASE')
  }

  return value
}

export function channelIndex(base: string, channel: ReleaseChannel): string {
  if (channel !== 'pilot' && channel !== 'stable') {throw new Error('INVALID_RELEASE_CHANNEL')}

  return `${releaseBase(base)}/channels/${channel}/latest.json`
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('INVALID_RELEASE_METADATA')}

  return value as Record<string, unknown>
}

export function verifiedSetupRelease(base: string, latestValue: unknown, immutableValue: unknown, sequenceFloor: number): SetupRelease {
  releaseBase(base)
  const latest = object(latestValue)
  const immutable = object(immutableValue)
  const sha = immutable.source_sha

  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {throw new Error('INVALID_RELEASE_SHA')}

  if (latest.manifest_url !== `${base}/${sha}/manifest.json`) {throw new Error('INVALID_MANIFEST_BINDING')}
  const keys = Object.keys(immutable)

  if (Object.keys(latest).length !== keys.length + 1 || keys.some(key => !Object.hasOwn(latest, key) || !isDeepStrictEqual(latest[key], immutable[key]))) {
    throw new Error('LATEST_IMMUTABLE_MISMATCH')
  }

  const sequence = immutable.release_sequence

  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || !Number.isSafeInteger(sequenceFloor) || sequenceFloor < 0 || (sequence as number) < sequenceFloor) {
    throw new Error('RELEASE_DOWNGRADE_OR_INVALID_SEQUENCE')
  }

  if (immutable.platform !== 'windows' || immutable.architecture !== 'x64' || immutable.format !== 'zip') {throw new Error('UNSUPPORTED_RELEASE_PLATFORM')}

  if (immutable.setup_source_sha !== sha || immutable.updater_protocol !== 1 || (!Object.hasOwn(immutable, 'update_coordination_protocol') || immutable.update_coordination_protocol !== 1)) {throw new Error('INCOMPATIBLE_SETUP')}

  if (immutable.setup_url !== `${base}/${sha}/Youtab-Setup-${sha}.exe`) {throw new Error('INVALID_SETUP_BINDING')}

  if (typeof immutable.setup_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(immutable.setup_sha256)) {throw new Error('INVALID_SETUP_HASH')}

  if (!Number.isSafeInteger(immutable.setup_size) || (immutable.setup_size as number) < 1 || (immutable.setup_size as number) > 256 * 1024 * 1024) {throw new Error('INVALID_SETUP_SIZE')}

  return { sourceSha: sha, coordinationProtocol: 1, sequence: sequence as number, url: immutable.setup_url as string, sha256: immutable.setup_sha256, size: immutable.setup_size as number }
}

/** Verify the downloaded image before stopping the backend or writing cache. */
export function verifySetupBytes(release: SetupRelease, bytes: Uint8Array): void {
  if (!Number.isSafeInteger(release.size) || release.size < 1 || release.size > 256 * 1024 * 1024) {throw new Error('INVALID_SETUP_SIZE')}

  if (bytes.byteLength !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256) {throw new Error('SETUP_INTEGRITY_FAILURE')}
  // Read the PE header from this byte view without copying a full Setup image.
  if (bytes.byteLength < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {throw new Error('SETUP_EXECUTABLE_INVALID')}
  const image = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const header = image.getUint32(0x3c, true)

  if (header < 64 || header + 26 > bytes.byteLength || image.getUint32(header, true) !== 0x4550 || image.getUint16(header + 4, true) !== 0x8664 || !(image.getUint16(header + 22, true) & 2) || image.getUint16(header + 24, true) !== 0x20b) {throw new Error('SETUP_EXECUTABLE_INVALID')}
}

/** Caller supplies a TLS-validated, no-redirect, bounded streaming downloader.
 * Download and stage only; never replace the running Setup or launch here.
 */
export async function stageSetup(release: SetupRelease, cacheDirectory: string, download: (url: string, sizeLimit: number) => Promise<Uint8Array>): Promise<string> {
  if (!Number.isSafeInteger(release.size) || release.size < 1 || release.size > 256 * 1024 * 1024) {throw new Error('INVALID_SETUP_SIZE')}
  const bytes = await download(release.url, release.size)
  verifySetupBytes(release, bytes)
  await fs.mkdir(cacheDirectory, { recursive: true })

  if ((await fs.lstat(cacheDirectory)).isSymbolicLink()) {throw new Error('UNSAFE_SETUP_CACHE')}
  const staged = path.join(cacheDirectory, `Youtab-Setup-${release.sourceSha}-${randomBytes(16).toString('hex')}.exe`)
  // Keep failed stages for diagnosis. Node has no retained-object unlink API:
  // deleting a pathname after rejection could remove a competing file. A stage
  // is bounded to the verified release size (256 MiB); retries may accumulate.
  const handle = await fs.open(staged, 'wx+', 0o600)

  try {
    await handle.writeFile(bytes)
    await handle.sync()
    const persisted = Buffer.alloc(bytes.byteLength)
    let length = 0

    while (length < persisted.length) {
      const { bytesRead } = await handle.read(persisted, length, persisted.length - length, length)

      if (!bytesRead) {throw new Error('STAGED_SETUP_INTEGRITY_FAILURE')}
      length += bytesRead
    }

    const opened = await handle.stat()
    const current = await fs.lstat(staged)

    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
      || opened.size !== release.size || current.size !== release.size
      || createHash('sha256').update(persisted).digest('hex') !== release.sha256) {throw new Error('STAGED_SETUP_INTEGRITY_FAILURE')}
  } finally {
    await handle.close()
  }

  return staged
}
