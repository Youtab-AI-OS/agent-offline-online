import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ launch: vi.fn(), build: vi.fn(), release: vi.fn(async()=>{}) }))
vi.mock('./windows-maintenance-helper', () => ({ spawnWindowsMaintenanceHelper: mocks.launch, releaseWindowsMaintenanceHelper: mocks.release }))
vi.mock('./inno-update-transaction', () => ({ buildInnoUpdateTransactionScript: mocks.build }))

import { handoffInnoUpdate, type InnoUpdateHandoffHost } from './inno-update-handoff'
import { INNO_UPDATE_FEED, type InnoUpdateTrustRoot, verifyInnoReleaseEnvelope } from './inno-update-release'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const publicKey = pair.publicKey.export({ format: 'jwk' })

const trust: InnoUpdateTrustRoot = {
  protocol: 1,
  keyId: digest(
    Buffer.concat([
      Buffer.from('4543533120000000', 'hex'),
      Buffer.from(publicKey.x!, 'base64url'),
      Buffer.from(publicKey.y!, 'base64url')
    ])
  ),
  publicKey: { kty: 'EC', crv: 'P-256', x: publicKey.x!, y: publicKey.y! },
  feedBaseUrl: INNO_UPDATE_FEED,
  sequence: 1,
  buildId: '1'.repeat(64)
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

const roots: string[] = []
const children: FakeChild[] = []

class FakeChild extends EventEmitter {
  pid = 123456789 // No real process exists; kill is a local mock only.
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  unref = vi.fn()
  timer?: ReturnType<typeof setInterval>
  kill = vi.fn(() => {
    this.exit(1)

    return true
  })
  exit(code = 0) {
    if (this.exitCode !== null) {return}
    this.exitCode = code

    if (this.timer) {clearInterval(this.timer)}
    this.emit('exit', code, null)
  }
  dispose() {
    if (this.timer) {clearInterval(this.timer)}
    this.stdin.destroy()
    this.stdout.destroy()
    this.removeAllListeners()
  }
}
afterEach(() => {
  vi.useRealTimers()
  children.splice(0).forEach(child => child.dispose())

  for (const root of roots.splice(0)) {
    if (
      !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(root).startsWith('youtab-handoff-test-')
    )
      {throw new Error('Fixture escaped temporary boundary')}

    fs.rmSync(root, { recursive: true, force: true })
  }

  vi.restoreAllMocks()
  mocks.launch.mockReset()
  mocks.release.mockReset();mocks.release.mockResolvedValue(undefined)
  mocks.build.mockReset()
})

function fixture(acknowledge = true, honorCancel = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-handoff-test-'))
  roots.push(root)
  const bytes = Buffer.from('SYNTHETIC EXE; NEVER EXECUTED')

  const payload = Buffer.from(
    JSON.stringify({
      product: 'io.youtab.agent',
      format: 'inno-full/v1',
      platform: 'windows',
      arch: 'x64',
      sequence: 2,
      buildId: '2'.repeat(64),
      sourceSha: 'a'.repeat(40),
      version: '0.19.3',
      channel: 'stable',
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() + 60000,
      dataSchema: 1,
      installer: { fileName: 'Youtab-Setup.exe', sha256: digest(bytes), size: bytes.length },
      payloadManifestSha256: 'b'.repeat(64)
    })
  )

  const envelope = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      keyId: trust.keyId,
      payload: payload.toString('base64url'),
      signature: sign('sha256', payload, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    })
  )

  const release = verifyInnoReleaseEnvelope(envelope, trust, { channel: 'stable' })

  const input = {
    release,
    envelope,
    installer: { filePath: path.join(root, 'Youtab-Setup.exe'), sha256: digest(bytes), size: bytes.length, release },
    source: 'offline' as const
  }

  fs.writeFileSync(input.installer.filePath, bytes)
  const child = new FakeChild()
  children.push(child)
  let nativePlan: { handoff: { directory: string; token: string } }
  mocks.build.mockImplementation(plan => {
    nativePlan = plan

    return 'SYNTHETIC NATIVE SCRIPT; NOT EXECUTED'
  })
  mocks.launch.mockImplementation(({script}) => {
    queueMicrotask(() => child.stdin.end(script))
    return child
  })
  const released = vi.fn()

  const host: InnoUpdateHandoffHost = {
    trust,
    tempDirectory: root,
    dataContractsSha256: 'c'.repeat(64),
    acquireRuntimeLease: vi.fn(),
    installation: {
      installRoot: path.join(root, 'Owned installation'),
      userData: path.join(root, 'Owned installation', 'desktop'),
      uninstaller: path.join(root, 'Owned installation', 'unins000.exe'),
      desktopPid: 123456788,
      protectedRoots: [],
      startupDirectory: path.join(root, 'startup'),
      aliasDirectory: path.join(root, 'aliases')
    },
    reserve: vi.fn(() => released),
    releaseBackend: vi.fn(async () => ({ unlocked: true })),
    emitProgress: vi.fn(),
    quit: vi.fn(),
    log: vi.fn()
  }

  child.stdin.once('finish', () => {
    const { directory, token } = nativePlan.handoff

    if (acknowledge) {for (const marker of ['ready', 'stopped']) {fs.writeFileSync(path.join(directory, marker), token)}}
    child.timer = setInterval(() => {
      if (honorCancel&&fs.existsSync(path.join(directory, 'cancel'))) {
        child.exit(1)

        return
      }

      const proceed = path.join(directory, 'proceed')

      if (
        fs.existsSync(proceed) &&
        fs.readFileSync(proceed, 'utf8') === token &&
        !fs.existsSync(path.join(directory, 'armed'))
      )
        {fs.writeFileSync(path.join(directory, 'armed'), token)}
    }, 5)
  })

  return {
    root,
    child,
    input,
    host,
    released,
    get handoff() {
      return nativePlan!.handoff
    }
  }
}

describe.runIf(process.platform === 'win32')(
  'Inno main-process handoff orchestration (mock child, real token files)',
  () => {
    it('does not quit or claim handoff when helper exits during a deferred backend release', async () => {
      const f = fixture()
      const backend = deferred<{ unlocked: boolean }>()
      const begun = deferred<void>()
      f.host.releaseBackend = vi.fn(async () => {
        begun.resolve()

        return backend.promise
      })
      const operation = handoffInnoUpdate(f.input, f.host)
      await begun.promise
      f.child.exit(1)
      backend.resolve({ unlocked: true })
      expect(await operation).toMatchObject({ ok: false, error: 'inno-update-handoff' })
      expect(f.host.quit).not.toHaveBeenCalled()
      expect(f.child.unref).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(f.handoff.directory, 'proceed'))).toBe(false)
      expect(f.released).toHaveBeenCalledOnce()
    })

    it.each(['ready', 'stopped'] as const)('rejects changed %s acknowledgement after backend release', async marker => {
      const f = fixture()
      const backend = deferred<{ unlocked: boolean }>()
      const begun = deferred<void>()
      f.host.releaseBackend = vi.fn(async () => {
        begun.resolve()

        return backend.promise
      })
      const operation = handoffInnoUpdate(f.input, f.host)
      await begun.promise
      fs.writeFileSync(path.join(f.handoff.directory, marker), 'foreign-token')
      backend.resolve({ unlocked: true })
      expect(await operation).toMatchObject({ ok: false, error: 'inno-update-handoff' })
      expect(f.host.quit).not.toHaveBeenCalled()
      expect(f.released).toHaveBeenCalledOnce()
      expect(fs.existsSync(path.join(f.handoff.directory, 'proceed'))).toBe(false)
    })

    it('refuses a native failure log after backend release despite earlier valid tokens', async () => {
      const f = fixture()
      const backend = deferred<{ unlocked: boolean }>()
      const begun = deferred<void>()
      f.host.releaseBackend = vi.fn(async () => {
        begun.resolve()

        return backend.promise
      })
      const operation = handoffInnoUpdate(f.input, f.host)
      await begun.promise
      fs.writeFileSync(path.join(f.handoff.directory, 'failure.log'), 'SYNTHETIC RECOVERY FAILURE')
      backend.resolve({ unlocked: true })
      expect(await operation).toMatchObject({ ok: false, error: 'inno-update-handoff' })
      expect(f.host.quit).not.toHaveBeenCalled()
      expect(f.released).toHaveBeenCalledOnce()
    })

    it('keeps Desktop open and cancels the owned helper when backend files do not unlock', async () => {
      const f = fixture()
      f.host.releaseBackend = vi.fn(async () => ({ unlocked: false }))
      expect(await handoffInnoUpdate(f.input, f.host)).toMatchObject({ ok: false, error: 'inno-update-handoff' })
      expect(f.host.quit).not.toHaveBeenCalled()
      expect(f.released).toHaveBeenCalledOnce()
      expect(fs.readFileSync(path.join(f.handoff.directory, 'cancel'), 'utf8')).toBe(f.handoff.token)
    })

    it('requires ready/stopped/proceed/armed tokens before quit and releases reservation once after native exit', async () => {
      const f = fixture()
      expect(await handoffInnoUpdate(f.input, f.host)).toEqual({ ok: true, handedOff: true })

      for (const marker of ['ready', 'stopped', 'proceed', 'armed'])
        {expect(fs.readFileSync(path.join(f.handoff.directory, marker), 'utf8')).toBe(f.handoff.token)}

      expect(f.host.quit).toHaveBeenCalledOnce()
      expect(f.child.unref).toHaveBeenCalledOnce()
      expect(f.released).not.toHaveBeenCalled()
      f.child.exit(0)
      f.child.emit('error', new Error('Synthetic late close error'))
      expect(f.released).toHaveBeenCalledOnce()
      expect(mocks.launch).toHaveBeenCalledWith({ installRoot: f.host.installation.installRoot,
        handoffDirectory: f.handoff.directory, script: 'SYNTHETIC NATIVE SCRIPT; NOT EXECUTED',
        acquireLease: f.host.acquireRuntimeLease, removalRoots: [f.host.installation.userData] })
    })

    it('does not treat informational stdout as native readiness or release backend', async () => {
      const f = fixture(false)
      const operation = handoffInnoUpdate(f.input, f.host)
      await new Promise(resolve => setTimeout(resolve, 10))
      f.child.stdout.write('YOUTAB_INNO_UPDATE:{"stage":"handoff","message":"SYNTHETIC INFORMATION ONLY"}\n')
      expect(f.host.releaseBackend).not.toHaveBeenCalled()
      f.child.exit(1)
      expect(await operation).toMatchObject({ ok: false, error: 'inno-update-handoff' })
      expect(f.host.quit).not.toHaveBeenCalled()
      expect(f.released).toHaveBeenCalledOnce()
    })

    it('keeps Desktop open when the explicit native lifetime release is rejected',async()=>{
      const f=fixture()
      mocks.release.mockRejectedValueOnce(new Error('SYNTHETIC LIFETIME RELEASE REJECTION'))
      expect(await handoffInnoUpdate(f.input,f.host)).toMatchObject({ok:false,error:'inno-update-handoff'})
      expect(f.host.quit).not.toHaveBeenCalled()
      expect(f.child.unref).not.toHaveBeenCalled()
      expect(f.released).toHaveBeenCalledOnce()
      expect(fs.readFileSync(path.join(f.handoff.directory,'cancel'),'utf8')).toBe(f.handoff.token)
    })

    it('retains ownership while a ready rollback is live and its lifetime acknowledgement fails',async()=>{
      vi.useFakeTimers()
      const f=fixture(true,false)
      mocks.release.mockRejectedValue(new Error('SYNTHETIC CONTROL FAILURE DURING ROLLBACK'))
      const operation=handoffInnoUpdate(f.input,f.host)
      await vi.advanceTimersByTimeAsync(20000)
      expect(await operation).toMatchObject({ok:false,error:'inno-update-handoff'})
      expect(f.host.quit).not.toHaveBeenCalled()
      expect(f.child.kill).not.toHaveBeenCalled()
      expect(f.child.unref).not.toHaveBeenCalled()
      expect(f.released).not.toHaveBeenCalled()
      expect(fs.readFileSync(path.join(f.handoff.directory,'cancel'),'utf8')).toBe(f.handoff.token)
      f.child.exit(1)
      expect(f.released).toHaveBeenCalledOnce()
    })
  }
)
