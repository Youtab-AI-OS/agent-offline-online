import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { test } from 'vitest'

import { waitForUpdateClearance } from './update-gate'
import { createCoordinationUpdateGateDeps, readUpdateExclusionAsync, writeUpdateMarkerAsync } from './update-marker'
import { canAttemptNativeCustomerHandoff, coordinateWindowsUpdate, type CoordinationDeps, developmentCoordinationExecutable, packagedCoordinationExecutable, parseCoordinationOutput, verifyCoordinationSetup as verifyWithNativeLease } from './windows-update-coordination'

const setup = { executable: 'D:\\owned\\Youtab-Setup.exe', sourceSha: 'a'.repeat(40), sha256: 'b'.repeat(64), size: 4096, protocol: 1 as const, lease: { close() {} } }
const addonPin = { protocol: 1 as const, format: 'pe' as const, arch: 'x64' as const,
  napi: 'youtab.setup-lease/napi-v1' as const, sha256: 'c'.repeat(64), size: 4096 }
const fakeAcquire = (file: string, sha: string, size: number) => {
  const bytes = fsSync.readFileSync(file)
  if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha) {throw new Error('identity')}
  return { close() {} }
}
const verifyCoordinationSetup = (file: string, metadata: unknown, source: unknown, developmentOnly = false, storedFile = file) =>
  verifyWithNativeLease(file, metadata, source, developmentOnly, addonPin,
    (admittedFile, sha, size) => {
      assert.equal(admittedFile, file)
      return fakeAcquire(storedFile, sha, size)
    })
const home = 'D:\\owned\\private-home'
const output = (status: string, reason = status === 'clear' ? 'no-active-update' : status === 'published' ? 'handoff-published' : 'coordination-unavailable') => JSON.stringify({ protocol: 'youtab.update-coordination', version: 1, status, reason })
function deps(stdout = output('clear')): CoordinationDeps {
  return { resolveSetup: async () => setup, execute: (async () => ({ stdout, stderr: '' })) as CoordinationDeps['execute'] }
}

test('customer About update admits only native handoff v2; legacy and malformed stamps require preserving migration', () => {
  assert.equal(canAttemptNativeCustomerHandoff({ protocol: 1, handoffProtocol: 2 }), true)

  for (const stamp of [null, undefined, 2, [], {}, { protocol: 1 }, { protocol: 1, handoffProtocol: 1 }, { protocol: 1, handoffProtocol: '2' }]) {
    assert.equal(canAttemptNativeCustomerHandoff(stamp), false)
  }
})

test('only exact versioned schemas and operation ACKs are accepted', () => {
  assert.equal(parseCoordinationOutput(output('clear'), 'inspect').status, 'clear')
  assert.equal(parseCoordinationOutput(output('published'), 'publish').status, 'published')
  for (const value of ['null', '[]', '{}', output('published'), JSON.stringify({ protocol: 'youtab.update-coordination', version: 2, status: 'clear', reason: 'none' }), output('clear').replace('"reason":"no-active-update"', '"reason":"no-active-update","pid":4'), 'x'.repeat(65537)]) {
    assert.throws(() => parseCoordinationOutput(value, 'inspect'))
  }
})

test('missing or legacy metadata excludes without invoking unknown GUI flags', async () => {
  let calls = 0
  for (const identity of [null, { ...setup, protocol: 0 }, { ...setup, sourceSha: 'legacy' }, { ...setup, sha256: 'missing' }]) {
    const result = await coordinateWindowsUpdate(home, 'inspect', { resolveSetup: async () => identity as typeof setup, execute: (async () => { calls++; return { stdout: output('clear'), stderr: '' } }) as CoordinationDeps['execute'] })
    assert.equal(result.status, 'blocked')
  }
  assert.equal(calls, 0)
})

test('namespace aliases and alternate streams are excluded before launch', async () => {
  let calls = 0
  const input = { ...deps(), execute: (async () => { calls++; return { stdout: output('clear'), stderr: '' } }) as CoordinationDeps['execute'] }
  for (const candidate of ['relative', '\\\\server\\share', '\\\\?\\D:\\home', 'D:\\home:stream', 'D:\\home\\..\\victim', 'D:\\home.']) {
    assert.equal((await coordinateWindowsUpdate(candidate, 'inspect', input)).status, 'blocked')
  }
  assert.equal(calls, 0)
})

test('literal bounded hidden subprocess arguments preserve selected home', async () => {
  let captured: unknown[]
  const result = await coordinateWindowsUpdate('D:\\owned\\home & $(x)', 'publish', {
    resolveSetup: async () => setup, now: () => 1_700_000_000_000,
    execute: (async (...args: unknown[]) => { captured = args; return { stdout: output('published'), stderr: '' } }) as CoordinationDeps['execute']
  }, 1234)
  assert.equal(result.status, 'published')
  const [executable, argv, options] = captured! as [string, string[], Record<string, unknown>]
  assert.equal(executable, setup.executable)
  assert.deepEqual(argv.slice(0, 8), ['--update-coordination-v1', 'publish', '--home', 'D:\\owned\\home & $(x)', '--pid', '1234', '--created-at', '1700000000000'])
  assert.equal(argv[8], '--instance')
  assert.match(argv[9], /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true)
  assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 65536)
})

test('slow native admission yields the event loop and rejects errors or bad output', async () => {
  let ticks = 0
  const heartbeat = setInterval(() => { ticks++ }, 1)
  try {
    assert.equal((await coordinateWindowsUpdate(home, 'inspect', { ...deps(), execute: (async () => { await new Promise(resolve => setTimeout(resolve, 25)); throw new Error('timeout') }) as CoordinationDeps['execute'] })).status, 'blocked')
    assert.ok(ticks > 0)
  } finally { clearInterval(heartbeat) }
  for (const raw of ['{}', 'x'.repeat(65537)]) {
    assert.equal((await coordinateWindowsUpdate(home, 'inspect', deps(raw))).status, 'blocked')
  }
  assert.equal((await coordinateWindowsUpdate(home, 'inspect', { ...deps(), execute: (async () => ({ stdout: output('clear'), stderr: 'unexpected' })) as CoordinationDeps['execute'] })).status, 'blocked')
})

test('Windows marker paths stay closed for missing helper and failed publication', async () => {
  const missing = { resolveSetup: async () => null }
  assert.equal((await readUpdateExclusionAsync(home, missing, 'win32'))?.kind, 'coordination-prerequisite')
  await assert.rejects(writeUpdateMarkerAsync(home, 1234, missing, 'win32'))
  assert.equal(await readUpdateExclusionAsync(home, deps(), 'win32'), null)
  await writeUpdateMarkerAsync(home, 1234, deps(output('published')), 'win32')
})

test('PID and timestamp boundaries fail without spawning', async () => {
  let calls = 0
  const input = { ...deps(output('published')), execute: (async () => { calls++; return { stdout: output('published'), stderr: '' } }) as CoordinationDeps['execute'] }
  for (const pid of [0, -1, 0x1_0000_0000, 1.5, NaN]) {
    assert.equal((await coordinateWindowsUpdate(home, 'publish', input, pid)).status, 'blocked')
  }
  assert.equal((await coordinateWindowsUpdate(home, 'publish', { ...input, now: () => Infinity }, 1234)).status, 'blocked')
  assert.equal(calls, 0)
})


test('embedded immutable identity verifies exact stored bytes without invoking Setup', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.coordination-identity-'))
  try {
    const storedFile = path.join(directory, 'youtab-setup.exe')
    const executable = process.platform === 'win32' ? storedFile : `D:\\unit-test\\${path.basename(directory)}\\youtab-setup.exe`
    const image = Buffer.alloc(256, 0x42)
    await fs.writeFile(storedFile, image)
    const identity = { protocol: 1, sourceSha: setup.sourceSha, sha256: createHash('sha256').update(image).digest('hex'), size: image.length }
    assert.equal((await verifyCoordinationSetup(executable, identity, setup.sourceSha, false, storedFile))?.sha256, identity.sha256)
    assert.equal((await verifyCoordinationSetup(executable, { ...identity, handoffProtocol: 2 }, setup.sourceSha, false, storedFile))?.handoffProtocol, 2)
    for (const candidate of [null, { ...identity, protocol: 0 }, { ...identity, sourceSha: 'c'.repeat(40) }, { ...identity, sha256: 'c'.repeat(64) }, { ...identity, size: image.length + 1 }, { ...identity, extra: true }]) {
      assert.equal(await verifyCoordinationSetup(executable, candidate, setup.sourceSha, false, storedFile), null)
    }
    await fs.writeFile(storedFile, Buffer.alloc(256, 0x43))
    assert.equal(await verifyCoordinationSetup(executable, identity, setup.sourceSha, false, storedFile), null)
    assert.equal(await verifyCoordinationSetup(path.join(directory, 'missing.exe'), identity, setup.sourceSha), null)
  } finally {
    assert.equal(path.dirname(directory), process.cwd())
    await fs.rm(directory, { recursive: true })
  }
})


test('the headless helper is exclusively in packaged resources, never mutable HOME', () => {
  assert.equal(packagedCoordinationExecutable('D:\\private-code\\resources', true), 'D:\\private-code\\resources\\update-coordination\\Youtab-Setup.exe')
  for (const resources of [undefined, null, 'relative', '\\\\?\\D:\\resources', 'D:\\resources:stream']) {
    assert.equal(packagedCoordinationExecutable(resources, true), null)
  }
  assert.equal(packagedCoordinationExecutable('D:\\private-code\\resources', false), null)
})


test('strict deliberate native exit2 preserves only blocked outcomes and never grants clearance', async () => {
  const blocked = { code: 2, killed: false, signal: null, stdout: output('blocked', 'unsafe-home'), stderr: '' }
  const executeFailure = (error: unknown) => ({ ...deps(), execute: (async () => {throw error}) as CoordinationDeps['execute'] })
  assert.deepEqual(await coordinateWindowsUpdate(home, 'inspect', executeFailure(blocked)), { status: 'blocked', reason: 'unsafe-home' })
  for (const failure of [
    { ...blocked, code: 3 }, { ...blocked, killed: true }, { ...blocked, signal: 'SIGTERM' },
    { ...blocked, stderr: '\n' }, { ...blocked, stdout: output('clear') },
    { ...blocked, stdout: output('blocked', 'unknown-reason') }, { ...blocked, stdout: 'x'.repeat(65537) }
  ]) {
    assert.deepEqual(await coordinateWindowsUpdate(home, 'inspect', executeFailure(failure)), { status: 'blocked', reason: 'probe-failure' })
  }
})

test('actual owned Node exit2 is parsed as native exclusion, without generic reason loss', async () => {
  const run = promisify(execFile)
  const outcome = await coordinateWindowsUpdate(home, 'inspect', { ...deps(), execute: async (_file, _args, options) => {
    return run(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(output('blocked', 'unsafe-home'))}); process.exitCode=2`], { ...options, cwd: process.cwd() })
  } })
  assert.deepEqual(outcome, { status: 'blocked', reason: 'unsafe-home' })
})

test('developer route is explicit fixed build resource and cannot enter customer mode', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.developer-identity-'))
  try {
    const storedFile = path.join(directory, 'Youtab-Setup.exe')
    const executable = process.platform === 'win32' ? storedFile : `D:\\unit-test\\${path.basename(directory)}\\Youtab-Setup.exe`
    const bytes = Buffer.alloc(256, 0x41)
    await fs.writeFile(storedFile, bytes)
    const qualifiedSource = 'c'.repeat(40)
    const identity = { protocol: 1, sourceSha: qualifiedSource, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, developmentOnly: true }
    assert.equal(developmentCoordinationExecutable('D:\\private-development', identity), 'D:\\private-development\\build\\update-coordination\\Youtab-Setup.exe')
    assert.equal(developmentCoordinationExecutable('D:\\private-development', { ...identity, developmentOnly: false }), null)
    assert.equal(developmentCoordinationExecutable('D:\\private-development', { ...identity, developmentOnly: undefined }), null)
    assert.equal(developmentCoordinationExecutable('D:\\private-development', null), null)
    assert.equal(await verifyCoordinationSetup(executable, identity, qualifiedSource), null, 'customer rejects dev metadata')
    assert.ok(await verifyCoordinationSetup(executable, identity, qualifiedSource, true, storedFile))
    assert.equal(await verifyCoordinationSetup(executable, identity, '0'.repeat(40), true, storedFile), null, 'dirty/fallback Desktop SHA cannot impersonate helper pin')
    assert.equal(await verifyCoordinationSetup(executable, { ...identity, extra: true }, qualifiedSource, true, storedFile), null)
  } finally {
    assert.equal(path.dirname(directory), process.cwd())
    await fs.rm(directory, { recursive: true })
  }
})

test('real production gate seam rejects unconfigured developer prerequisites before polling', async () => {
  let sleeps = 0
  const read = () => readUpdateExclusionAsync(home, { resolveSetup: async () => null }, 'win32')
  const gate = createCoordinationUpdateGateDeps(read, () => false, 'Build the qualified common Setup in a private development resource.')
  await assert.rejects(waitForUpdateClearance(gate, { timeoutMs: 500, pollMs: 1, sleep: async () => {sleeps++} }), /qualified common Setup/)
  assert.equal(sleeps, 0)
})

test('configured native-clear gate seam starts immediately while deliberate native exclusion stays closed', async () => {
  const gate = createCoordinationUpdateGateDeps(() => readUpdateExclusionAsync(home, deps(), 'win32'), () => false, 'prerequisite')
  assert.equal(await waitForUpdateClearance(gate, { timeoutMs: 50, pollMs: 1 }), 'clear')
  let clock = 0
  const blocked = createCoordinationUpdateGateDeps(() => readUpdateExclusionAsync(home, deps(output('blocked','update-active')), 'win32'), () => false, 'prerequisite')
  assert.equal(await waitForUpdateClearance(blocked, { timeoutMs: 20, pollMs: 10, now: () => clock, sleep: async ms => {clock+=ms} }), 'timeout')
})


test('unsafe home migration prerequisite is immediate and never displayed as an active update wait', async () => {
  let slept = 0
  const gate = createCoordinationUpdateGateDeps(() => readUpdateExclusionAsync(home, deps(output('blocked','unsafe-home')), 'win32'), () => false,
    exclusion => `Preserving migration is required (${exclusion.reason}).`)
  await assert.rejects(waitForUpdateClearance(gate, { timeoutMs: 500, pollMs: 1, sleep: async () => {slept++} }), /migration.*unsafe-home/)
  assert.equal(slept, 0)
})
