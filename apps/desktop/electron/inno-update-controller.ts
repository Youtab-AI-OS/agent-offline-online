import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  admitOfflineInnoInstaller,
  type AdmittedInnoInstaller,
  type AuthenticatedInnoRelease,
  downloadInnoInstaller,
  fetchInnoReleaseEnvelope,
  INNO_METADATA_LIMIT,
  type InnoHttpsTransport,
  type InnoReleaseFloor,
  type InnoUpdateChannel,
  validateInnoUpdateTrustRoot,
  verifyInnoReleaseEnvelope
} from './inno-update-release'

export type InnoUpdateSource = 'online' | 'offline'
export interface InnoInstalledIdentity {
  sequence: number
  buildId: string
  installerSha256?: string
  dataContractsSha256: string
}
export interface InnoControllerStatus {
  supported: true
  branch: 'release'
  channel?: InnoUpdateChannel
  source?: InnoUpdateSource
  reason?: string
  error?: string
  message?: string
  updateAvailable?: boolean
  behind?: number
  currentBuildId?: string
  targetBuildId?: string
  targetSha?: string
  releaseSequence?: number
  releaseNotes?: string[]
  fetchedAt?: number
}
export interface InnoControllerApplyResult {
  ok: boolean
  error?: string
  message?: string
  handedOff?: boolean
}
export interface InnoUpdateControllerDependencies {
  trust: unknown
  installed: () => InnoInstalledIdentity
  policy: () => { enabled: boolean; automaticChecks: boolean }
  channel: () => InnoUpdateChannel
  authorization: () => Promise<string>
  selectOffline: () => Promise<string | null>
  newStageDirectory: () => Promise<string>
  confirm: (release: AuthenticatedInnoRelease, source: InnoUpdateSource) => Promise<boolean>
  handoff: (input: {
    release: AuthenticatedInnoRelease
    envelope: Uint8Array
    installer: AdmittedInnoInstaller
    source: InnoUpdateSource
  }) => Promise<InnoControllerApplyResult>
  readAccepted: () => { envelope: Uint8Array; acceptedAt: number } | null
  writeAccepted: (envelope: Uint8Array, acceptedAt: number) => void
  now?: () => number
  /** No production network override. Restricted again by the release transport. */
  testTransport?: InnoHttpsTransport
}

interface Selection {
  release: AuthenticatedInnoRelease
  envelope: Uint8Array
  source: InnoUpdateSource
  offlineInstaller?: string
  channel: InnoUpdateChannel
  acceptedAt: number
}
const HASH = /^[0-9a-f]{64}$/
const positive = (value: number) => Number.isSafeInteger(value) && value > 0

const refused = (code: string): never => {
  throw new Error(`inno-update:${code}`)
}

const errorCode = (error: unknown) =>
  error instanceof Error && /^inno-update:[a-z0-9-]+$/.test(error.message)
    ? error.message.slice('inno-update:'.length)
    : 'operation-failed'

function localDescriptorPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    Array.from(value).some(character => character.charCodeAt(0) <= 31) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//') ||
    path.extname(value).toLowerCase() !== '.json'
  )
    {refused('offline-descriptor-path')}

  const parts = value.split(/[\\/]/).filter(Boolean)

  if (parts.some(part => part === '.' || part === '..' || /[. ]$/.test(part))) {refused('offline-descriptor-path')}

  if (
    process.platform === 'win32' &&
    (!/^[a-z]:[\\/]/i.test(value) ||
      value.slice(2).includes(':') ||
      parts.slice(1).some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
  )
    {refused('offline-descriptor-path')}

  return path.resolve(value)
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

async function noLinks(file: string): Promise<void> {
  let current = file

  for (;;) {
    const info = await fs.lstat(current)

    if (info.isSymbolicLink() || !samePath(await fs.realpath(current), current)) {refused('offline-descriptor-reparse')}
    const parent = path.dirname(current)

    if (parent === current) {return}
    current = parent
  }
}

async function readOfflineEnvelope(file: string, signal: AbortSignal): Promise<Uint8Array> {
  const source = localDescriptorPath(file)

  if (signal.aborted) {refused('cancelled')}
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))

  try {
    const opened = await handle.stat()
    await noLinks(source)
    const before = await fs.lstat(source)

    if (!before.isFile() || !before.size || before.size > INNO_METADATA_LIMIT) {refused('metadata-limit')}
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      {refused('offline-descriptor-changed')}

    const bytes = Buffer.alloc(before.size)
    let offset = 0

    while (offset < bytes.length) {
      if (signal.aborted) {refused('cancelled')}
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)

      if (!bytesRead) {refused('partial-metadata')}
      offset += bytesRead
    }

    const after = await handle.stat()
    await noLinks(source)
    const current = await fs.lstat(source)

    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink()
    )
      {refused('offline-descriptor-changed')}

    if (signal.aborted) {refused('cancelled')}

    return bytes
  } finally {
    await handle.close()
  }
}

/** Main-process controller. Every outward/effectful entry point independently reads native policy. */
export function createInnoUpdateController(deps: InnoUpdateControllerDependencies) {
  const trust = validateInnoUpdateTrustRoot(deps.trust)
  const clock = deps.now ?? Date.now
  let epoch = 0
  let selected: Selection | undefined
  let active: AbortController | undefined
  let applying = false

  function policy(background = false) {
    const value = deps.policy()

    if (!value || typeof value.enabled !== 'boolean' || typeof value.automaticChecks !== 'boolean')
      {refused('policy-unavailable')}

    if (!value.enabled || (background && !value.automaticChecks)) {refused('disabled')}
  }

  function installed(): InnoInstalledIdentity {
    const value = deps.installed()

    if (
      !value ||
      !positive(value.sequence) ||
      !HASH.test(value.buildId) ||
      !HASH.test(value.dataContractsSha256) ||
      (value.installerSha256 !== undefined && !HASH.test(value.installerSha256)) ||
      value.sequence < trust.sequence ||
      (value.sequence === trust.sequence && value.buildId !== trust.buildId)
    )
      {refused('installed-identity')}

    return value
  }

  function channel(): InnoUpdateChannel {
    const value = deps.channel()

    if (value !== 'stable' && value !== 'pilot') {refused('channel')}

    return value
  }

  async function authorization(): Promise<string> {
    const token = await deps.authorization().catch(() => refused('sign-in-required'))

    if (!token || token.length > 8192 || Array.from(token).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {refused('sign-in-required')}

    return token
  }

  function floor(): InnoReleaseFloor {
    const current = installed()

    const baseline: InnoReleaseFloor = {
      sequence: current.sequence,
      buildId: current.buildId,
      installerSha256: current.installerSha256
    }

    const receipt = deps.readAccepted()

    if (receipt === null) {return baseline}
    const now = clock()

    if (
      !receipt ||
      !(receipt.envelope instanceof Uint8Array) ||
      !positive(receipt.acceptedAt) ||
      receipt.acceptedAt > now
    )
      {refused('accepted-receipt-invalid')}

    let authenticated: AuthenticatedInnoRelease | undefined

    for (const receiptChannel of ['stable', 'pilot'] as const) {
      try {
        authenticated = verifyInnoReleaseEnvelope(receipt.envelope, trust, {
          channel: receiptChannel,
          floor: baseline,
          now: receipt.acceptedAt
        })

        break
      } catch {
        /* Both supported channels are signature-verified; no untrusted channel parsing. */
      }
    }

    if (!authenticated) {refused('accepted-receipt-invalid')}

    return {
      sequence: authenticated.payload.sequence,
      buildId: authenticated.payload.buildId,
      payloadSha256: authenticated.payloadSha256
    }
  }

  function start() {
    active?.abort()
    const controller = new AbortController()
    active = controller

    return { epoch: ++epoch, controller }
  }

  function guard(
    operation: { epoch: number; controller: AbortController },
    expectedChannel?: InnoUpdateChannel,
    background = false
  ) {
    if (operation.epoch !== epoch || operation.controller.signal.aborted) {refused('cancelled')}
    policy(background)

    if (expectedChannel !== undefined && channel() !== expectedChannel) {refused('release-changed')}
  }

  function status(selection: Selection): InnoControllerStatus {
    const current = installed()

    const exact =
      current.sequence === selection.release.payload.sequence &&
      current.buildId === selection.release.payload.buildId &&
      current.installerSha256 !== undefined &&
      current.installerSha256 === selection.release.payload.installer.sha256

    return {
      supported: true,
      branch: 'release',
      source: selection.source,
      channel: selection.channel,
      updateAvailable: !exact,
      behind: exact ? 0 : 1,
      currentBuildId: current.buildId,
      targetBuildId: selection.release.payload.buildId,
      targetSha: selection.release.payload.sourceSha,
      releaseSequence: selection.release.payload.sequence,
      releaseNotes: [
        `Version ${selection.release.payload.version}`,
        `Build ${selection.release.payload.buildId}`,
        `Sequence ${selection.release.payload.sequence}`
      ],
      fetchedAt: selection.acceptedAt
    }
  }

  function failure(error: unknown): InnoControllerStatus {
    const code = errorCode(error)

    return { supported: true, branch: 'release', reason: code, ...(code === 'disabled' ? {} : { error: code }) }
  }

  function reverify(selection: Selection) {
    return verifyInnoReleaseEnvelope(selection.envelope, trust, {
      channel: selection.channel,
      floor: floor(),
      now: clock()
    })
  }

  function accept(selection: Selection) {
    // Synchronous sealed receipt persistence must finish before this release becomes selectable.
    // Pin a time at which this receipt really verified, even if expiry crosses between clock reads.
    verifyInnoReleaseEnvelope(selection.envelope, trust, {
      channel: selection.channel,
      floor: floor(),
      now: selection.acceptedAt
    })
    deps.writeAccepted(Uint8Array.from(selection.envelope), selection.acceptedAt)
    selected = selection
  }

  return {
    async check(options: { background?: boolean } = {}): Promise<InnoControllerStatus> {
      let operation: ReturnType<typeof start> | undefined

      try {
        policy(options.background)

        if (applying) {refused('busy')}
        const targetChannel = channel()

        if (selected?.source === 'offline') {
          if (selected.channel !== targetChannel) {refused('release-changed')}
          reverify(selected)

          return status(selected)
        }

        operation = start()
        const minimum = floor()
        const bearerToken = await authorization()

        const result = await fetchInnoReleaseEnvelope(trust, {
          channel: targetChannel,
          floor: minimum,
          now: clock(),
          signal: operation.controller.signal,
          bearerToken,
          ...(deps.testTransport ? { testTransport: deps.testTransport } : {})
        })

        guard(operation, targetChannel, options.background)

        const release = verifyInnoReleaseEnvelope(result.envelope, trust, {
          channel: targetChannel,
          floor: floor(),
          now: clock()
        })

        const next: Selection = {
          release,
          envelope: Uint8Array.from(result.envelope),
          source: 'online',
          channel: targetChannel,
          acceptedAt: clock()
        }

        accept(next)

        return status(next)
      } catch (error) {
        return failure(error)
      } finally {
        if (operation?.epoch === epoch) {active = undefined}
      }
    },
    async importOffline(): Promise<InnoControllerStatus | null> {
      let operation: ReturnType<typeof start> | undefined

      try {
        policy()

        if (applying) {refused('busy')}
        operation = start() // Cancels older online checks before even opening the picker.
        const targetChannel = channel()
        const file = await deps.selectOffline()
        guard(operation, targetChannel)

        if (file === null) {return null}
        const descriptor = localDescriptorPath(file)
        const envelope = await readOfflineEnvelope(descriptor, operation.controller.signal)
        guard(operation, targetChannel)

        const release = verifyInnoReleaseEnvelope(envelope, trust, {
          channel: targetChannel,
          floor: floor(),
          now: clock()
        })

        const next: Selection = {
          release,
          envelope: Uint8Array.from(envelope),
          source: 'offline',
          offlineInstaller: path.join(path.dirname(descriptor), 'Youtab-Setup.exe'),
          channel: targetChannel,
          acceptedAt: clock()
        }

        accept(next)

        return status(next)
      } catch (error) {
        return failure(error)
      } finally {
        if (operation?.epoch === epoch) {active = undefined}
      }
    },
    async apply(options: { expectedSourceSha?: string; expectedBuildId?: string }): Promise<InnoControllerApplyResult> {
      let operation: ReturnType<typeof start> | undefined
      let ownsApply = false

      try {
        policy()

        if (applying) {refused('busy')}
        const selection = selected

        if (
          !selection ||
          options?.expectedBuildId !== selection.release.payload.buildId ||
          options?.expectedSourceSha !== selection.release.payload.sourceSha
        )
          {refused('release-changed')}

        if (channel() !== selection.channel) {refused('release-changed')}
        applying = true
        ownsApply = true
        operation = start()
        let release = reverify(selection)

        if (!status(selection).updateAvailable) {return { ok: false, error: 'already-installed' }}
        const confirmed = await deps.confirm(release, selection.source)
        guard(operation, selection.channel)

        if (selected !== selection) {refused('release-changed')}

        if (!confirmed) {return { ok: false, error: 'cancelled' }}
        release = reverify(selection)
        const directory = await deps.newStageDirectory()
        guard(operation, selection.channel)

        const installer =
          selection.source === 'offline'
            ? await admitOfflineInnoInstaller(selection.offlineInstaller!, release, directory, {
                signal: operation.controller.signal
              })
            : await downloadInnoInstaller(release, trust, directory, {
                signal: operation.controller.signal,
                bearerToken: await authorization(),
                ...(deps.testTransport ? { testTransport: deps.testTransport } : {})
              })

        guard(operation, selection.channel)

        if (selected !== selection) {refused('release-changed')}
        release = reverify(selection)

        // Native handoff independently revalidates signed bytes, identities, active work and policy.
        return await deps.handoff({
          release,
          envelope: Uint8Array.from(selection.envelope),
          installer,
          source: selection.source
        })
      } catch (error) {
        return { ok: false, error: errorCode(error) }
      } finally {
        if (ownsApply) {applying = false}

        if (operation?.epoch === epoch) {active = undefined}
      }
    },
    invalidate(): void {
      epoch++
      active?.abort()
      active = undefined
      selected = undefined
    }
  }
}
