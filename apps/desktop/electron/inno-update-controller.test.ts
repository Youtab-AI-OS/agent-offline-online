import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInnoUpdateController, type InnoUpdateControllerDependencies } from './inno-update-controller'
import {
  INNO_UPDATE_FEED,
  type InnoHttpsTransport,
  type InnoReleasePayload,
  type InnoUpdateTrustRoot
} from './inno-update-release'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = publicKey.export({ format: 'jwk' })
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const installedBytes = Buffer.from('SYNTHETIC INSTALLED EXE; NOT EXECUTABLE')
const updateBytes = Buffer.from('SYNTHETIC UPDATE EXE; NEVER EXECUTED')

const trust: InnoUpdateTrustRoot = {
  protocol: 1,
  keyId: digest(
    Buffer.concat([
      Buffer.from('4543533120000000', 'hex'),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url')
    ])
  ),
  publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! },
  feedBaseUrl: INNO_UPDATE_FEED,
  sequence: 1,
  buildId: '1'.repeat(64)
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(root).startsWith('youtab-update-controller-')
    )
      {throw new Error('Synthetic fixture boundary changed')}

    await fs.rm(root, { recursive: true, force: true })
  }
})

function envelope(overrides: Partial<InnoReleasePayload> = {}, now = Date.now()): Uint8Array {
  const release: InnoReleasePayload = {
    product: 'io.youtab.agent',
    format: 'inno-full/v1',
    platform: 'windows',
    arch: 'x64',
    sequence: 2,
    buildId: '2'.repeat(64),
    sourceSha: 'a'.repeat(40),
    version: '0.19.3',
    channel: 'stable',
    createdAt: now - 60_000,
    expiresAt: now + 3_600_000,
    dataSchema: 1,
    installer: { fileName: 'Youtab-Setup.exe', sha256: digest(updateBytes), size: updateBytes.length },
    payloadManifestSha256: 'b'.repeat(64),
    ...overrides
  }

  const payload = Buffer.from(JSON.stringify(release))

  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      keyId: trust.keyId,
      payload: payload.toString('base64url'),
      signature: sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    })
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

function response(bytes: Uint8Array, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-length': String(bytes.length) },
    body: (async function* () {
      yield bytes
    })(),
    close: vi.fn()
  }
}

async function fixture(overrides: Partial<InnoUpdateControllerDependencies> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtab-update-controller-'))
  roots.push(root)
  let now = Date.now()
  let metadata = envelope({}, now)
  let receipt: { envelope: Uint8Array; acceptedAt: number } | null = null
  let nativePolicy = { enabled: true, automaticChecks: true }
  let nativeChannel: 'stable' | 'pilot' = 'stable'
  const calls: string[] = []
  const tokens: Array<string | undefined> = []

  const transport: InnoHttpsTransport = vi.fn(async (url, _signal, bearerToken) => {
    calls.push(url.pathname)
    tokens.push(bearerToken)

    return response(url.pathname.endsWith('latest.json') ? metadata : updateBytes)
  })

  const deps: InnoUpdateControllerDependencies = {
    trust,
    installed: vi.fn(() => ({
      sequence: 1,
      buildId: trust.buildId,
      installerSha256: digest(installedBytes),
      dataContractsSha256: 'c'.repeat(64)
    })),
    policy: vi.fn(() => nativePolicy),
    channel: vi.fn(() => nativeChannel),
    authorization: vi.fn(async () => 'test-session-token'),
    now: () => now,
    selectOffline: vi.fn(async () => path.join(root, 'release.json')),
    newStageDirectory: vi.fn(async () => fs.mkdtemp(path.join(root, 'stage-'))),
    confirm: vi.fn(async () => true),
    handoff: vi.fn(async () => ({ ok: true, handedOff: true })),
    readAccepted: vi.fn(() => receipt),
    writeAccepted: vi.fn((bytes, acceptedAt) => {
      receipt = { envelope: Uint8Array.from(bytes), acceptedAt }
    }),
    testTransport: transport,
    ...overrides
  }

  await fs.writeFile(path.join(root, 'release.json'), metadata)
  await fs.writeFile(path.join(root, 'Youtab-Setup.exe'), updateBytes)

  return {
    root,
    deps,
    calls,
    tokens,
    controller: createInnoUpdateController(deps),
    policy(value: typeof nativePolicy) {
      nativePolicy = value
    },
    channel(value: typeof nativeChannel) {
      nativeChannel = value
    },
    metadata(value: Uint8Array) {
      metadata = value
    },
    receipt(value: typeof receipt) {
      receipt = value
    },
    now(value: number) {
      now = value
    },
    get time() {
      return now
    },
    get accepted() {
      return receipt
    }
  }
}

const consent = { expectedSourceSha: 'a'.repeat(40), expectedBuildId: '2'.repeat(64) }

describe('native signed Inno controller (synthetic bytes, no Installer execution)', () => {
  it('checks online through the pinned feed and applies the exact reviewed build after hash admission', async () => {
    const f = await fixture()
    expect(await f.controller.check()).toMatchObject({
      supported: true,
      source: 'online',
      updateAvailable: true,
      behind: 1,
      targetBuildId: consent.expectedBuildId,
      targetSha: consent.expectedSourceSha
    })
    expect(f.calls).toEqual(['/desktop-updates/windows-v1/channels/stable/latest.json'])
    expect(await f.controller.apply(consent)).toEqual({ ok: true, handedOff: true })
    expect(f.calls[1]).toBe('/desktop-updates/windows-v1/2/Youtab-Setup.exe')
    expect(f.tokens).toEqual(['test-session-token', 'test-session-token'])
    expect(f.deps.authorization).toHaveBeenCalledTimes(2)
    const input = vi.mocked(f.deps.handoff).mock.calls[0][0]
    expect(input.source).toBe('online')
    expect(await fs.readFile(input.installer.filePath)).toEqual(updateBytes)
    expect(input.installer.sha256).toBe(digest(updateBytes))
    expect(f.deps.writeAccepted).toHaveBeenCalledOnce()
  })

  it('requires sign-in before online metadata and reports exact HTTP status without response text', async () => {
    const anonymous = await fixture({ authorization: vi.fn(async () => {throw new Error('secret identity detail')}) })

    expect(await anonymous.controller.check()).toMatchObject({ error: 'sign-in-required' })
    expect(anonymous.calls).toEqual([])

    const missing = await fixture({
      testTransport: vi.fn(async () => response(new Uint8Array(), 404))
    })

    expect(await missing.controller.check()).toMatchObject({ error: 'http-404' })
  })

  it('requires a current session again before downloading the selected online installer', async () => {
    const f = await fixture()

    expect(await f.controller.check()).toMatchObject({ updateAvailable: true })
    f.deps.authorization = vi.fn(async () => {throw new Error('signed out')})
    expect(await f.controller.apply(consent)).toEqual({ ok: false, error: 'sign-in-required' })
    expect(f.calls).toHaveLength(1)
    expect(f.deps.handoff).not.toHaveBeenCalled()
  })

  it.each(['check', 'importOffline', 'apply'] as const)(
    'master Off blocks direct %s before reading identity, receipts, network or picker',
    async method => {
      const f = await fixture()
      f.policy({ enabled: false, automaticChecks: true })
      expect(method === 'apply' ? await f.controller.apply(consent) : await f.controller[method]()).toMatchObject(
        method === 'apply' ? { ok: false, error: 'disabled' } : { reason: 'disabled' }
      )
      expect(f.deps.installed).not.toHaveBeenCalled()
      expect(f.deps.readAccepted).not.toHaveBeenCalled()
      expect(f.deps.selectOffline).not.toHaveBeenCalled()
      expect(f.deps.confirm).not.toHaveBeenCalled()
      expect(f.deps.handoff).not.toHaveBeenCalled()
      expect(f.calls).toEqual([])
    }
  )

  it('automatic Off blocks startup/focus/poll checks but preserves deliberate online check', async () => {
    const f = await fixture()
    f.policy({ enabled: true, automaticChecks: false })
    expect(await f.controller.check({ background: true })).toMatchObject({ reason: 'disabled' })
    expect(f.calls).toEqual([])
    expect(await f.controller.check()).toMatchObject({ updateAvailable: true })
    expect(f.calls).toHaveLength(1)
  })

  it('policy read failure refuses all effects without exposing arbitrary exception text', async () => {
    const f = await fixture({
      policy: () => {
        throw new Error('SYNTHETIC SECRET PATH')
      }
    })

    expect(await f.controller.check()).toMatchObject({ error: 'operation-failed' })
    expect(await f.controller.apply(consent)).toEqual({ ok: false, error: 'operation-failed' })
    expect(f.calls).toEqual([])
  })

  it('native Off while metadata is pending prevents both acceptance and receipt persistence', async () => {
    const pending = deferred<Awaited<ReturnType<InnoHttpsTransport>>>()
    const begun = deferred<void>()

    const f = await fixture({
      testTransport: vi.fn(async () => {
        begun.resolve()

        return pending.promise
      })
    })

    const checking = f.controller.check()
    await begun.promise
    f.policy({ enabled: false, automaticChecks: false })
    pending.resolve(response(envelope({}, f.time)))
    expect(await checking).toMatchObject({ reason: 'disabled' })
    expect(f.deps.writeAccepted).not.toHaveBeenCalled()
    expect(f.deps.confirm).not.toHaveBeenCalled()
  })

  it('imports and applies an offline sibling EXE without any online request, including repeated checks', async () => {
    const f = await fixture({
      testTransport: vi.fn(async () => {
        throw new Error('Offline must never contact network')
      })
    })

    expect(await f.controller.importOffline()).toMatchObject({ source: 'offline', updateAvailable: true })
    expect(await f.controller.check()).toMatchObject({ source: 'offline', targetBuildId: consent.expectedBuildId })
    expect(await f.controller.check({ background: true })).toMatchObject({ source: 'offline' })
    expect(await f.controller.apply(consent)).toEqual({ ok: true, handedOff: true })
    expect(f.deps.testTransport).not.toHaveBeenCalled()
    expect(vi.mocked(f.deps.handoff).mock.calls[0][0].source).toBe('offline')
  })

  it.each(['success', 'failure'] as const)(
    'offline import defeats a stale online %s and remains the selected apply source',
    async outcome => {
      const pending = deferred<Awaited<ReturnType<InnoHttpsTransport>>>()
      const begun = deferred<void>()

      const f = await fixture({
        testTransport: vi.fn(async () => {
          begun.resolve()

          return pending.promise
        })
      })

      const checking = f.controller.check()
      await begun.promise
      expect(await f.controller.importOffline()).toMatchObject({ source: 'offline' })

      if (outcome === 'success') {pending.resolve(response(envelope({ sequence: 3, buildId: '3'.repeat(64) }, f.time)))}
      else {pending.reject(new Error('Synthetic stale online failure'))}

      expect(await checking).toMatchObject({ error: 'cancelled' })
      expect(await f.controller.check()).toMatchObject({ source: 'offline', targetBuildId: consent.expectedBuildId })
      expect(await f.controller.apply(consent)).toEqual({ ok: true, handedOff: true })
      expect(vi.mocked(f.deps.handoff).mock.calls[0][0].source).toBe('offline')
    }
  )

  it('persists the highest signed selection and rejects downgrade after a new controller instance', async () => {
    const f = await fixture()
    await f.controller.check()
    f.metadata(
      envelope(
        {
          sequence: 1,
          buildId: trust.buildId,
          installer: { fileName: 'Youtab-Setup.exe', sha256: digest(installedBytes), size: installedBytes.length }
        },
        f.time
      )
    )
    const restarted = createInnoUpdateController(f.deps)
    expect(await restarted.check()).toMatchObject({ error: 'rollback' })
    expect(f.accepted).not.toBeNull()
    expect(f.deps.writeAccepted).toHaveBeenCalledOnce()
  })

  it('uses expired accepted receipts as durable floors while refusing the expired current release', async () => {
    const f = await fixture()
    await f.controller.check()
    f.now(f.time + 7_200_000)
    const restarted = createInnoUpdateController(f.deps)
    f.metadata(envelope({ sequence: 3, buildId: '3'.repeat(64) }, f.time))
    expect(await restarted.check()).toMatchObject({ releaseSequence: 3, updateAvailable: true })
    expect(f.deps.writeAccepted).toHaveBeenCalledTimes(2)
  })

  it('malformed sealed receipt fails closed before network instead of resetting the floor', async () => {
    const f = await fixture()
    f.receipt({ envelope: Buffer.from('{}'), acceptedAt: f.time })
    expect(await f.controller.check()).toMatchObject({ error: 'accepted-receipt-invalid' })
    expect(f.calls).toEqual([])
    expect(f.deps.writeAccepted).not.toHaveBeenCalled()
  })

  it('receipt persistence failure never makes the release selectable', async () => {
    const f = await fixture({
      writeAccepted: () => {
        throw new Error('Sealed storage failed')
      }
    })

    expect(await f.controller.check()).toMatchObject({ error: 'operation-failed' })
    expect(await f.controller.apply(consent)).toEqual({ ok: false, error: 'release-changed' })
    expect(f.deps.confirm).not.toHaveBeenCalled()
  })

  it.each([
    { expectedSourceSha: 'a'.repeat(40) },
    { expectedBuildId: '2'.repeat(64) },
    { expectedSourceSha: 'a'.repeat(40), expectedBuildId: '3'.repeat(64) },
    { expectedSourceSha: 'f'.repeat(40), expectedBuildId: '2'.repeat(64) }
  ])('rejects incomplete or different exact-build consent before confirmation', async options => {
    const f = await fixture()
    await f.controller.check()
    expect(await f.controller.apply(options)).toEqual({ ok: false, error: 'release-changed' })
    expect(f.deps.confirm).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(1)
  })

  it('rechecks expiry before native confirmation and never silently fetches another release', async () => {
    const f = await fixture()
    await f.controller.check()
    f.now(f.time + 7_200_000)
    expect(await f.controller.apply(consent)).toEqual({ ok: false, error: 'release-time' })
    expect(f.deps.confirm).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(1)
  })

  it('rechecks native Off after the confirmation await', async () => {
    const confirmation = deferred<boolean>()
    const begun = deferred<void>()

    const f = await fixture({
      confirm: vi.fn(async () => {
        begun.resolve()

        return confirmation.promise
      })
    })

    await f.controller.check()
    const applying = f.controller.apply(consent)
    await begun.promise
    f.policy({ enabled: false, automaticChecks: true })
    confirmation.resolve(true)
    expect(await applying).toEqual({ ok: false, error: 'disabled' })
    expect(f.deps.newStageDirectory).not.toHaveBeenCalled()
    expect(f.deps.handoff).not.toHaveBeenCalled()
  })

  it('rechecks expiry after the confirmation await without downloading an alternative release', async () => {
    const confirmation = deferred<boolean>()
    const begun = deferred<void>()

    const f = await fixture({
      confirm: vi.fn(async () => {
        begun.resolve()

        return confirmation.promise
      })
    })

    await f.controller.check()
    const applying = f.controller.apply(consent)
    await begun.promise
    f.now(f.time + 7_200_000)
    confirmation.resolve(true)
    expect(await applying).toEqual({ ok: false, error: 'release-time' })
    expect(f.deps.newStageDirectory).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(1)
  })

  it('channel changes after review refuse application rather than substituting another release', async () => {
    const f = await fixture()
    await f.controller.check()
    f.channel('pilot')
    expect(await f.controller.apply(consent)).toEqual({ ok: false, error: 'release-changed' })
    expect(f.deps.confirm).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(1)
  })

  it('serializes apply and prevents check/import from replacing an approved in-flight build', async () => {
    const confirmation = deferred<boolean>()
    const begun = deferred<void>()

    const f = await fixture({
      confirm: vi.fn(async () => {
        begun.resolve()

        return confirmation.promise
      })
    })

    await f.controller.check()
    const applying = f.controller.apply(consent)
    await begun.promise
    expect(await f.controller.apply(consent)).toEqual({ ok: false, error: 'busy' })
    expect(await f.controller.check()).toMatchObject({ error: 'busy' })
    expect(await f.controller.importOffline()).toMatchObject({ error: 'busy' })
    confirmation.resolve(false)
    expect(await applying).toEqual({ ok: false, error: 'cancelled' })
    expect(f.deps.handoff).not.toHaveBeenCalled()
  })

  it('invalidating during transfer aborts admission and prevents handoff without leaving a partial EXE', async () => {
    const downloading = deferred<void>()
    const stalled = deferred<Uint8Array>()

    const f = await fixture({
      testTransport: vi.fn(async url =>
        url.pathname.endsWith('latest.json')
          ? response(envelope())
          : {
              statusCode: 200,
              headers: {},
              body: (async function* () {
                downloading.resolve()
                yield await stalled.promise
              })(),
              close: vi.fn()
            }
      )
    })

    await f.controller.check()
    const applying = f.controller.apply(consent)
    await downloading.promise
    f.controller.invalidate()
    expect(await applying).toEqual({ ok: false, error: 'cancelled' })
    expect(f.deps.handoff).not.toHaveBeenCalled()
    const directories = await fs.readdir(f.root)

    for (const directory of directories.filter(name => name.startsWith('stage-')))
      {expect(await fs.readdir(path.join(f.root, directory))).toEqual([])}

    stalled.resolve(updateBytes)
  })

  it('rechecks policy after completed transfer immediately before effectful handoff', async () => {
    const f = await fixture()
    f.deps.newStageDirectory = vi.fn(async () => {
      f.policy({ enabled: false, automaticChecks: true })

      return fs.mkdtemp(path.join(f.root, 'stage-'))
    })
    await f.controller.check()
    expect(await f.controller.apply(consent)).toEqual({ ok: false, error: 'disabled' })
    expect(f.deps.handoff).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(1)
  })

  it('offline corrupt or missing installer never falls back to online', async () => {
    const f = await fixture()
    await f.controller.importOffline()
    await fs.writeFile(path.join(f.root, 'Youtab-Setup.exe'), Buffer.alloc(updateBytes.length))
    expect(await f.controller.apply(consent)).toEqual({ ok: false, error: 'installer-integrity' })
    expect(f.calls).toEqual([])
    expect(f.deps.handoff).not.toHaveBeenCalled()
  })

  it('rejects symlink/junction descriptor ancestors and oversized metadata before acceptance', async () => {
    const f = await fixture()
    const link = path.join(f.root, 'linked')
    await fs.symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir')
    f.deps.selectOffline = vi.fn(async () => path.join(link, 'release.json'))
    expect(await f.controller.importOffline()).toMatchObject({ error: 'offline-descriptor-reparse' })
    f.deps.selectOffline = vi.fn(async () => path.join(f.root, 'release.json'))
    await fs.writeFile(path.join(f.root, 'release.json'), Buffer.alloc(65_537))
    expect(await f.controller.importOffline()).toMatchObject({ error: 'metadata-limit' })
    expect(f.deps.writeAccepted).not.toHaveBeenCalled()
    expect(f.calls).toEqual([])
  })

  it('only reports already installed with matching sequence, build and actual installed EXE hash', async () => {
    const f = await fixture()
    f.metadata(
      envelope(
        {
          sequence: 1,
          buildId: trust.buildId,
          installer: { fileName: 'Youtab-Setup.exe', sha256: digest(installedBytes), size: installedBytes.length }
        },
        f.time
      )
    )
    expect(await f.controller.check()).toMatchObject({ behind: 0, updateAvailable: false })
    expect(await f.controller.apply({ expectedSourceSha: 'a'.repeat(40), expectedBuildId: trust.buildId })).toEqual({
      ok: false,
      error: 'already-installed'
    })
    expect(f.deps.confirm).not.toHaveBeenCalled()
  })
})
