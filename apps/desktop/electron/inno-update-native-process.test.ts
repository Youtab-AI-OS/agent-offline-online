import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Installation/transaction fixtures are synthetic and never run an Installer.
// The production launcher, native leases, PowerShell, pipes, ACKs and process
// lifetime are real; the fixed-layout Node fixture uses this test's Node binary.
const native = vi.hoisted(() => ({ directory: '', token: '', reject: false }))
vi.mock('./inno-update-transaction', () => ({
  buildInnoUpdateTransactionScript: (plan: { handoff: { directory: string; token: string } }) => {
    native.directory = plan.handoff.directory
    native.token = plan.handoff.token
    const payload = Buffer.from(JSON.stringify(plan.handoff)).toString('base64')

    return `$ErrorActionPreference='Stop'
# ${'SYNTHETIC TRANSPORT PADDING '.repeat(10000)}
$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
${native.reject ? "throw 'SYNTHETIC REJECTION BEFORE READY'" : ''}
foreach($name in @('ready','stopped')) {[IO.File]::WriteAllText([IO.Path]::Combine($h.directory,$name),$h.token)}
$until=[DateTime]::UtcNow.AddSeconds(15)
while(-not (Test-Path -LiteralPath ([IO.Path]::Combine($h.directory,'proceed')))) {
  if([DateTime]::UtcNow -gt $until) {exit 9};Start-Sleep -Milliseconds 20
}
if([IO.File]::ReadAllText([IO.Path]::Combine($h.directory,'proceed')) -cne $h.token) {exit 10}
[IO.File]::WriteAllText([IO.Path]::Combine($h.directory,'armed'),$h.token)
while(-not (Test-Path -LiteralPath ([IO.Path]::Combine($h.directory,'test-finish')))) {
  if([DateTime]::UtcNow -gt $until) {exit 11};Start-Sleep -Milliseconds 20
}
[IO.File]::WriteAllText([IO.Path]::Combine($h.directory,'test-complete'),$h.token)
exit 0
`
  }
}))

import { handoffInnoUpdate, type InnoUpdateHandoffHost } from './inno-update-handoff'
import { INNO_UPDATE_INSTALLER_JOB_FUNCTIONS } from './inno-update-installer-job'
import { type AuthenticatedInnoRelease, INNO_UPDATE_FEED, validateInnoUpdateTrustRoot } from './inno-update-release'
import type { SetupLease } from './setup-native-lease'
import { cancelUninstallHelper } from './windows-full-uninstall'
import { releaseWindowsMaintenanceHelper, spawnWindowsMaintenanceHelper } from './windows-maintenance-helper'

const nativeLeasePath=path.resolve('build/native/setup_lease.node')
function expectProcessExited(pid:number):void {
  let code:string|undefined
  try {process.kill(pid,0)} catch(error) {code=(error as NodeJS.ErrnoException).code}
  // Permission denial does not prove process exit.
  expect(code).toBe('ESRCH')
}
function acquireRuntimeLease(executable:string,sha256:string,size:number):SetupLease {
  const nativeLease=createRequire(import.meta.url)(nativeLeasePath)
  const handle=nativeLease.acquire(executable,sha256,size)
  return {close:()=>nativeLease.release(handle)}
}

const roots: string[] = []
afterEach(() => {
  native.reject = false
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('youtab-native-transport-')) {
      throw new Error('Synthetic fixture escaped its temporary boundary')
    }
    // Windows can release a just-exited image/directory a few ticks after the
    // process handle is signalled. Retry only this verified owned fixture;
    // every lifecycle assertion and the test's time budget stay unchanged.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-native-transport-'))
  roots.push(root)
  const installRoot = path.join(root, 'synthetic-product')
  fs.mkdirSync(path.join(installRoot, 'node'), { recursive: true })
  fs.copyFileSync(process.execPath, path.join(installRoot, 'node', 'node.exe'), fs.constants.COPYFILE_EXCL)
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })
  const keyId = createHash('sha256').update(Buffer.concat([
    Buffer.from('4543533120000000', 'hex'), Buffer.from(publicKey.x!, 'base64url'), Buffer.from(publicKey.y!, 'base64url')
  ])).digest('hex')
  const trust = validateInnoUpdateTrustRoot({ protocol: 1, keyId, publicKey, feedBaseUrl: INNO_UPDATE_FEED, sequence: 1, buildId: 'a'.repeat(64) })
  const releaseReservation = vi.fn()
  const quit = vi.fn(() => fs.writeFileSync(path.join(native.directory, 'test-finish'), native.token))
  const host: InnoUpdateHandoffHost = {
    trust, tempDirectory: root, dataContractsSha256: 'b'.repeat(64),
    acquireRuntimeLease,
    installation: { installRoot, userData: path.join(root, 'never-created-data'),
      uninstaller: path.join(root, 'never-executed.exe'), desktopPid: process.pid, protectedRoots: [], startupDirectory: root, aliasDirectory: root },
    reserve: () => releaseReservation, releaseBackend: vi.fn(async () => ({ unlocked: true })),
    emitProgress: vi.fn(), quit, log: vi.fn()
  }
  const release:AuthenticatedInnoRelease={keyId,payloadSha256:'c'.repeat(64),payload:{
    product:'io.youtab.agent',format:'inno-full/v1',platform:'windows',arch:'x64',sequence:2,buildId:'d'.repeat(64),
    sourceSha:'a'.repeat(40),version:'0.19.2',channel:'stable',createdAt:Date.now(),expiresAt:Date.now()+60000,
    dataSchema:1,installer:{fileName:'Youtab-Setup.exe',sha256:'e'.repeat(64),size:1234},payloadManifestSha256:'f'.repeat(64)
  }}
  const input:Parameters<typeof handoffInnoUpdate>[0] = {
    source: 'offline', installer: { filePath: path.join(root, 'never-executed.exe'),sha256:'e'.repeat(64),size:1234,release },
    envelope: Buffer.from('SYNTHETIC; NEVER ADMITTED'),release
  }

  return { root, host, input, quit, releaseReservation }
}

describe.runIf(process.platform === 'win32')('real Windows native helper transport (no Installer or installation)', () => {
  it('allows the production broker and its real worker to finish after Desktop exits', async () => {
    const f = fixture()
    const {root}=f
    const directory=path.join(root,'synthetic-handoff')
    fs.mkdirSync(directory)
    const modulePath=path.join(root,'production-launcher.cjs')
    await build({ entryPoints: [path.resolve('electron/windows-maintenance-helper.ts')], outfile: modulePath,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const completed = path.join(root, 'child-finished-after-parent.txt')
    const ready = path.join(root, 'child-ready.txt')
    const brokerPidFile=path.join(root,'owned-broker-pid.txt')
    const destination = Buffer.from(completed, 'utf8').toString('base64')
    const readyDestination = Buffer.from(ready, 'utf8').toString('base64')
    const script = `[IO.File]::WriteAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${readyDestination}')),'READY');Start-Sleep -Milliseconds 1500;[IO.File]::WriteAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${destination}')),'SYNTHETIC CHILD SURVIVED');exit 0`
    const parent = `
      const {spawnWindowsMaintenanceHelper,releaseWindowsMaintenanceHelper}=require(${JSON.stringify(modulePath)});
      const nativeLease=require(${JSON.stringify(nativeLeasePath)});
      const acquireLease=(file,sha,size)=>{const handle=nativeLease.acquire(file,sha,size);return {close:()=>nativeLease.release(handle)}};
      const child=spawnWindowsMaintenanceHelper({...${JSON.stringify({installRoot:f.host.installation.installRoot,handoffDirectory:directory,script})},acquireLease});
      require('node:fs').writeFileSync(${JSON.stringify(brokerPidFile)},String(child.pid));
      child.once('error',()=>process.exit(2));
      const timer=setTimeout(()=>process.exit(3),8000);
      const poll=setInterval(async()=>{
        if(require('node:fs').existsSync(${JSON.stringify(ready)})) {
          clearTimeout(timer);clearInterval(poll);await releaseWindowsMaintenanceHelper(child);child.stdout.destroy();child.unref();process.exit(0);
        }
      },20);
    `
    const result = spawnSync(process.execPath, ['-e', parent], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(fs.existsSync(completed)).toBe(false)
    await vi.waitFor(() => expect(fs.readFileSync(completed, 'utf8')).toBe('SYNTHETIC CHILD SURVIVED'), { timeout: 10000 })
    const brokerPid=Number(fs.readFileSync(brokerPidFile,'utf8'))
    await vi.waitFor(()=>expectProcessExited(brokerPid),{timeout:5000})
  }, 20000)

  it('executes a full-size stdin script and requires native ACKs before handing off', async () => {
    const f = fixture()
    expect(await handoffInnoUpdate(f.input, f.host)).toEqual({ ok: true, handedOff: true })
    expect(f.host.releaseBackend).toHaveBeenCalledOnce()
    expect(f.quit).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(f.releaseReservation).toHaveBeenCalledOnce(), { timeout: 10000 })
    expect(fs.readFileSync(path.join(native.directory, 'test-complete'), 'utf8')).toBe(native.token)
    expect(fs.readdirSync(f.host.installation.installRoot)).toEqual(['node'])
    expect(fs.existsSync(f.host.installation.userData)).toBe(false)
  }, 20000)

  it('keeps Desktop and its backend alive if the real helper exits before readiness', async () => {
    const f = fixture()
    native.reject = true
    expect(await handoffInnoUpdate(f.input, f.host)).toMatchObject({ ok: false, error: 'inno-update-handoff' })
    expect(f.quit).not.toHaveBeenCalled()
    expect(f.host.releaseBackend).not.toHaveBeenCalled()
    expect(f.releaseReservation).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(native.directory, 'proceed'))).toBe(false)
    expect(fs.readdirSync(f.host.installation.installRoot)).toEqual(['node'])
  }, 20000)

  it('returns the actual native nonzero exit code and cleans its copied runtime after close', async () => {
    const f=fixture()
    const directory=path.join(f.root,'synthetic-handoff');fs.mkdirSync(directory)
    const child=spawnWindowsMaintenanceHelper({installRoot:f.host.installation.installRoot,handoffDirectory:directory,script:'exit 37',acquireLease:acquireRuntimeLease})
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    expect(code).toBe(37)
    expect(fs.readdirSync(f.root).filter(name=>name.startsWith('youtab-maintenance-runtime-'))).toEqual([])
  },20000)

  it('cancelling the owned broker drains its PowerShell worker before reporting exit or any later synthetic effect', async () => {
    const f=fixture()
    const directory=path.join(f.root,'synthetic-handoff');fs.mkdirSync(directory)
    const ready=path.join(directory,'ready');const completion=path.join(directory,'must-not-exist')
    const data=Buffer.from(JSON.stringify({ready,completion})).toString('base64')
    const script=`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json
[IO.File]::WriteAllText($p.ready,[string]$PID)
Start-Sleep -Seconds 3
[IO.File]::WriteAllText($p.completion,'UNEXPECTED EFFECT')`
    const child=spawnWindowsMaintenanceHelper({installRoot:f.host.installation.installRoot,handoffDirectory:directory,script,acquireLease:acquireRuntimeLease})
    await vi.waitFor(()=>expect(fs.existsSync(ready)).toBe(true),{timeout:10000})
    const pid=Number(fs.readFileSync(ready,'utf8'))
    expect(Number.isSafeInteger(pid)&&pid>0).toBe(true)
    const closed=new Promise<void>(resolve=>child.once('exit',()=>{
      expectProcessExited(pid)
      resolve()
    }))
    expect(child.kill()).toBe(true)
    await closed
    await vi.waitFor(()=>expectProcessExited(pid),{timeout:5000})
    await new Promise(resolve=>setTimeout(resolve,3200))
    expect(fs.existsSync(completion)).toBe(false)
  },20000)

  it('fails closed on control EOF before an acknowledged lifetime release',async()=>{
    const f=fixture();const directory=path.join(f.root,'synthetic-handoff');fs.mkdirSync(directory)
    const completion=path.join(directory,'must-not-exist')
    const data=Buffer.from(completion).toString('base64')
    const child=spawnWindowsMaintenanceHelper({installRoot:f.host.installation.installRoot,handoffDirectory:directory,
      script:`Start-Sleep -Milliseconds 750;[IO.File]::WriteAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')),'UNEXPECTED EFFECT')`,
      acquireLease:acquireRuntimeLease})
    const closed=new Promise<number|null>(resolve=>child.once('close',resolve))
    ;(child.stdio[3] as {destroy():void}).destroy()
    expect(await closed).not.toBe(0)
    await expect(releaseWindowsMaintenanceHelper(child)).rejects.toThrow('unavailable')
    expect(fs.existsSync(completion)).toBe(false)
  },20000)

  it('does not load inherited mixed-case Node startup injection',async()=>{
    const f=fixture();const directory=path.join(f.root,'synthetic-handoff');fs.mkdirSync(directory)
    const marker=path.join(f.root,'injection-must-not-run')
    const injection=path.join(f.root,'injection.cjs')
    fs.writeFileSync(injection,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'UNEXPECTED INJECTION')`)
    const prior=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()==='NODE_OPTIONS'))
    let child:ReturnType<typeof spawnWindowsMaintenanceHelper>
    try {
      process.env.nOdE_oPtIoNs=`--require "${injection}"`
      child=spawnWindowsMaintenanceHelper({installRoot:f.host.installation.installRoot,handoffDirectory:directory,
        script:'exit 17',acquireLease:acquireRuntimeLease})
    } finally {
      for(const key of Object.keys(process.env)){if(key.toUpperCase()==='NODE_OPTIONS'){delete process.env[key]}}
      Object.assign(process.env,prior)
    }
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    expect(code).toBe(17)
    expect(fs.existsSync(marker)).toBe(false)
  },20000)

  it('requires native leases and rejects a helper temp directory inside removal roots',()=>{
    const f=fixture();const directory=path.join(f.root,'synthetic-handoff');fs.mkdirSync(directory)
    expect(()=>spawnWindowsMaintenanceHelper({installRoot:f.host.installation.installRoot,handoffDirectory:directory,
      script:'exit 0',acquireLease:()=>{throw new Error('SYNTHETIC LEASE UNAVAILABLE')}})).toThrow('LEASE UNAVAILABLE')
    const nested=path.join(f.host.installation.installRoot,'temp');fs.mkdirSync(nested)
    expect(()=>spawnWindowsMaintenanceHelper({installRoot:f.host.installation.installRoot,handoffDirectory:nested,
      script:'exit 0',acquireLease:acquireRuntimeLease})).toThrow('outside every program and data removal root')
    expect(fs.readdirSync(f.root).filter(name=>name.startsWith('youtab-maintenance-runtime-'))).toEqual([])
  })

  it('retains a ready helper until its real native job drains an owned child and cancellation rollback completes',async()=>{
    const f=fixture();const directory=path.join(f.root,'synthetic-handoff');fs.mkdirSync(directory)
    const handoff={directory,token:'synthetic-owned-job-cancellation'}
    const pidFile=path.join(directory,'owned-child-pid')
    const rollback=path.join(directory,'rollback-complete')
    const completion=path.join(directory,'must-not-exist')
    const childPayload=Buffer.from(JSON.stringify({pidFile,completion})).toString('base64')
    const childScript=`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${childPayload}'))|ConvertFrom-Json;[IO.File]::WriteAllText($p.pidFile,[string]$PID);Start-Sleep -Seconds 20;[IO.File]::WriteAllText($p.completion,'UNEXPECTED CHILD EFFECT')`
    const encoded=Buffer.from(childScript,'utf16le').toString('base64')
    const payload=Buffer.from(JSON.stringify({handoff,rollback})).toString('base64')
    const script=`$ErrorActionPreference='Stop'
${INNO_UPDATE_INSTALLER_JOB_FUNCTIONS}
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
Initialize-YoutabInstallerJobNative
[IO.File]::WriteAllText([IO.Path]::Combine($p.handoff.directory,'ready'),$p.handoff.token)
try {Invoke-YoutabBoundedInstaller ([IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')) @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') 4000|Out-Null;throw 'Owned child unexpectedly completed'}
catch {if(-not (Test-YoutabInstallerJobsDrained)){throw 'Owned child did not drain'}}
if([IO.File]::ReadAllText([IO.Path]::Combine($p.handoff.directory,'cancel')) -cne $p.handoff.token){throw 'Cancellation token changed'}
[IO.File]::WriteAllText($p.rollback,'OWNED CHILD DRAINED; ROLLBACK COMPLETE')
exit 1`
    const helper=spawnWindowsMaintenanceHelper({installRoot:f.host.installation.installRoot,handoffDirectory:directory,script,acquireLease:acquireRuntimeLease})
    const closed=new Promise<void>(resolve=>helper.once('close',()=>resolve()))
    await vi.waitFor(()=>expect(fs.existsSync(pidFile)).toBe(true),{timeout:10000})
    const pid=Number(fs.readFileSync(pidFile,'utf8'))
    expect(()=>process.kill(pid,0)).not.toThrow()
    const killed=vi.spyOn(helper,'kill')
    helper.once('exit',()=>expectProcessExited(pid))
    expect(await cancelUninstallHelper(helper,handoff,5000)).toBe(true)
    expect(killed).not.toHaveBeenCalled()
    expect(fs.readFileSync(rollback,'utf8')).toBe('OWNED CHILD DRAINED; ROLLBACK COMPLETE')
    expect(fs.existsSync(completion)).toBe(false)
    await closed
  },20000)
})
