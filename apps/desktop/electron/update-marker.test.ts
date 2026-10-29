/**
 * Tests for electron/update-marker.ts — the in-app update mutual-exclusion
 * marker that prevents a desktop relaunched mid-update from spawning a backend
 * the updater then kills in a loop (#50238).
 *
 * Run with: node --test electron/update-marker.test.ts
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * Why this matters: the gate must (a) report a live update only when the
 * updater pid is alive AND the marker is fresh, (b) treat absent/malformed/
 * dead-pid/expired markers as "no live update" so a crashed updater can't
 * strand future launches, and (c) clear stale hints logically without deleting another writer's marker.
 */

import fs from 'fs'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'

import { afterEach, test, vi } from 'vitest'

import {
  isInnoInstallOnlyMarker,
  isPidAlive,
  markerPath,
  readLiveUpdateMarker,
  readUpdateExclusion,
  UPDATE_MARKER_MAX_AGE_MS,
  writeUpdateMarker
} from './update-marker'

const ownedHomes = []
afterEach(() => {
  vi.restoreAllMocks()

  for (const home of ownedHomes.splice(0)) {fs.rmSync(home, { recursive: true, force: true })}
})

function tmpHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `youtab-marker-${tag}-`))

  ownedHomes.push(dir)

  return dir
}

function writeMarker(home, pid, startedAtSec) {
  fs.writeFileSync(markerPath(home), `${pid}\n${startedAtSec}`)
}

const ALIVE: typeof process.kill = () => true // injected kill that "succeeds" => pid alive

const DEAD: typeof process.kill = () => {
  const err = new Error('no such process')

  ;(err as any).code = 'ESRCH'
  throw err
}

test('marker growth after descriptor stat is bounded and never pruned', () => {
  const home = tmpHome('growth-after-stat')
  const file = markerPath(home)
  writeMarker(home, 999999, Math.floor(Date.now() / 1000))
  const stat = fs.fstatSync.bind(fs)
  const read = fs.readSync.bind(fs)
  const readFile = fs.readFileSync.bind(fs)
  let grew = false
  let bytesRead = 0

  vi.spyOn(fs, 'fstatSync').mockImplementation((...args: any[]) => {
    const result = (stat as any)(...args)

    if (!grew) {
      grew = true
      fs.appendFileSync(file, Buffer.alloc(1024 * 1024, 0x61))
    }

    return result
  })
  vi.spyOn(fs, 'readSync').mockImplementation((...args: any[]) => {
    const count = (read as any)(...args)

    bytesRead += count

    return count
  })
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args: any[]) => {
    const content = (readFile as any)(...args)

    if (typeof args[0] === 'number') {bytesRead += Buffer.byteLength(content)}

    return content
  })
  assert.equal(readLiveUpdateMarker(home, { kill: DEAD }), null)
  assert.equal(bytesRead, 4097, 'descriptor reads stop at the byte cap plus one')
  assert.ok(fs.existsSync(file), 'a concurrently changed marker is not stale-pruned')
})

test('a same-inode marker mutation after reading is refused without pruning', () => {
  const home = tmpHome('mutation-after-read')
  const file = markerPath(home)
  writeMarker(home, 999999, Math.floor(Date.now() / 1000))
  const read = fs.readSync.bind(fs)
  const readFile = fs.readFileSync.bind(fs)
  let changed = false

  const mutate = () => {
    if (!changed) {
      changed = true
      fs.appendFileSync(file, 'changed')
    }
  }

  vi.spyOn(fs, 'readSync').mockImplementation((...args: any[]) => {
    const count = (read as any)(...args)

    if (!count) {mutate()}

    return count
  })
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args: any[]) => {
    const content = (readFile as any)(...args)

    if (typeof args[0] === 'number') {mutate()}

    return content
  })
  assert.equal(readLiveUpdateMarker(home, { kill: DEAD }), null)
  assert.ok(changed, 'test mutates the actual file between read and validation')
  assert.ok(fs.existsSync(file), 'changed file survives stale-marker handling')
})

test('absent marker => no live update', () => {
  const home = tmpHome('absent')
  assert.equal(readLiveUpdateMarker(home, { kill: ALIVE }), null)
})

test('live pid within age ceiling => live update reported', () => {
  const home = tmpHome('live')
  const now = 1_000_000_000_000
  writeMarker(home, 4242, Math.floor(now / 1000) - 5) // 5s old
  const res = readLiveUpdateMarker(home, { kill: ALIVE, now: () => now })
  assert.ok(res, 'a fresh, alive marker is a live update')
  assert.equal(res.pid, 4242)
  assert.ok(res.ageMs >= 0 && res.ageMs < 10_000)
  assert.ok(fs.existsSync(markerPath(home)), 'a live marker is NOT deleted')
})

test('dead pid => no live update and shared marker remains', () => {
  const home = tmpHome('dead')
  writeMarker(home, 999999, Math.floor(Date.now() / 1000))
  assert.equal(readLiveUpdateMarker(home, { kill: DEAD }), null)
  assert.ok(fs.existsSync(markerPath(home)), 'reader does not delete a shared hint')
})

test('expired marker (past age ceiling) => clear without shared-file deletion', () => {
  const home = tmpHome('expired')
  const now = 1_000_000_000_000
  writeMarker(home, 4242, Math.floor((now - UPDATE_MARKER_MAX_AGE_MS - 60_000) / 1000))
  // Even though the pid is "alive", the marker is too old to trust.
  assert.equal(readLiveUpdateMarker(home, { kill: ALIVE, now: () => now }), null)
  assert.ok(fs.existsSync(markerPath(home)), 'reader leaves stale hint for atomic writer')
})

test('malformed PID => no live update and shared marker remains', () => {
  const home = tmpHome('malformed')
  fs.writeFileSync(markerPath(home), 'not-a-pid\nnonsense')
  assert.equal(readLiveUpdateMarker(home, { kill: ALIVE }), null)
  assert.ok(fs.existsSync(markerPath(home)))
})

test('isPidAlive: own pid is alive, impossible pid is dead', () => {
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(-1), false)
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive(NaN), false)
})

test('isPidAlive: EPERM counts as alive (process owned by another user)', () => {
  const eperm = () => {
    const err = new Error('operation not permitted')

    ;(err as any).code = 'EPERM'
    throw err
  }

  assert.equal(isPidAlive(4242, eperm), true)
})

test('writeUpdateMarker writes a marker that readLiveUpdateMarker accepts', () => {
  const home = tmpHome('write')
  const now = 1_000_000_000_000
  writeUpdateMarker(home, 4242, { now: () => now })
  // The marker should be readable and report the same pid.
  const res = readLiveUpdateMarker(home, { kill: ALIVE, now: () => now })
  assert.ok(res, 'marker written by writeUpdateMarker should be detected as live')
  assert.equal(res.pid, 4242)
  assert.ok(fs.existsSync(markerPath(home)), 'marker file should exist after write')
})

test('writeUpdateMarker is best-effort (no throw on bad path)', () => {
  // A non-existent directory should not throw.
  const badHome = path.join(os.tmpdir(), 'youtab-marker-nonexistent-' + Date.now())
  assert.doesNotThrow(() => writeUpdateMarker(badHome, 4242))
})

test('writeUpdateMarker + dead pid => self-heals on read', () => {
  const home = tmpHome('write-dead')
  writeUpdateMarker(home, 999999, { now: () => Date.now() })
  // PID 999999 is almost certainly not alive.
  const res = readLiveUpdateMarker(home, { kill: DEAD })
  assert.equal(res, null, 'a dead-pid marker from writeUpdateMarker self-heals')
  assert.ok(fs.existsSync(markerPath(home)), 'a dead hint is logically clear and preserved')
})


test('atomic marker replacement cannot truncate a linked victim', () => {
  const home = tmpHome('linked-write')
  const victim = path.join(home, 'owned-victim')
  fs.writeFileSync(victim, 'preserve-victim')
  // Hard links are genuine linked files on NTFS without symlink privileges.
  fs.linkSync(victim, markerPath(home))
  writeUpdateMarker(home, 4242)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserve-victim')
  assert.equal(fs.readFileSync(markerPath(home), 'utf8').split('\n')[0], '4242')
  assert.equal(fs.statSync(markerPath(home)).nlink, 1)
  assert.deepEqual(fs.readdirSync(home).sort(), [path.basename(markerPath(home)), 'owned-victim'].sort())
})

test('linked marker is neither trusted nor pruned', () => {
  const home = tmpHome('linked-read')
  const victim = path.join(home, 'owned-victim')
  const body = `4242\n${Math.floor(Date.now() / 1000)}\n`
  fs.writeFileSync(victim, body)
  fs.linkSync(victim, markerPath(home))
  assert.equal(readLiveUpdateMarker(home, { kill: ALIVE }), null)
  assert.equal(fs.readFileSync(victim, 'utf8'), body)
  assert.ok(fs.existsSync(markerPath(home)))
})

test('selected home alias preserves a live update in its canonical directory', () => {
  const parent = tmpHome('linked-home')
  const target = path.join(parent, 'target')
  const alias = path.join(parent, 'alias')
  fs.mkdirSync(target)
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.doesNotThrow(() => writeUpdateMarker(alias, 4242))
  assert.equal(readLiveUpdateMarker(alias, { kill: ALIVE })?.pid, 4242)
  assert.equal(readLiveUpdateMarker(target, { kill: ALIVE })?.pid, 4242)
  assert.deepEqual(fs.readdirSync(target), [path.basename(markerPath(target))])
})

test('marker failure leaves previous marker intact and no stage', () => {
  const home = tmpHome('rename-failure')
  writeMarker(home, 111, 1000)
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic rename denial') })
  assert.doesNotThrow(() => writeUpdateMarker(home, 4242))
  assert.equal(fs.readFileSync(markerPath(home), 'utf8'), '111\n1000')
  assert.deepEqual(fs.readdirSync(home), [path.basename(markerPath(home))])
})

test('pruning leaves a concurrently replaced marker intact', () => {
  const home = tmpHome('prune-identity')
  writeMarker(home, 111, 1000)
  const replacement = path.join(home, 'replacement')
  fs.writeFileSync(replacement, '222\n1001')

  const kill = () => { fs.renameSync(replacement, markerPath(home)); throw Object.assign(new Error('dead'), { code: 'ESRCH' }) }
  assert.equal(readLiveUpdateMarker(home, { kill }), null)
  assert.equal(fs.readFileSync(markerPath(home), 'utf8'), '222\n1001')
})

test('POSIX owner policy and symlink leaf protection; native junction policy above', () => {
  const home = tmpHome('permissions')
  writeUpdateMarker(home, 4242)

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(markerPath(home)).mode & 0o777, 0o600)
    const victim = path.join(home, 'victim')
    fs.writeFileSync(victim, 'preserve')
    fs.unlinkSync(markerPath(home))
    fs.symlinkSync(victim, markerPath(home))
    assert.equal(readLiveUpdateMarker(home, { kill: ALIVE }), null)
    writeUpdateMarker(home, 4242)
    assert.equal(fs.readFileSync(victim, 'utf8'), 'preserve')
    fs.chmodSync(home, 0o777)
    assert.equal(readLiveUpdateMarker(home, { kill: ALIVE }), null)
    writeUpdateMarker(home, 9999)
    assert.equal(fs.readFileSync(markerPath(home), 'utf8').split('\n')[0], '4242')
  } else {
    assert.equal(readLiveUpdateMarker(home, { kill: ALIVE })?.pid, 4242)
  }
})


test('namespace replacement before publication preserves both existing markers', () => {
  const parent = tmpHome('home-replaced')
  const home = path.join(parent, 'home')
  const moved = path.join(parent, 'moved')
  fs.mkdirSync(home)
  writeMarker(home, 111, 1000)
  const close = fs.closeSync
  let replaced = false
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
    close(fd)

    if (replaced) {return}
    replaced = true
    fs.renameSync(home, moved)
    fs.mkdirSync(home)
    writeMarker(home, 222, 1001)
  })
  assert.doesNotThrow(() => writeUpdateMarker(home, 4242))
  assert.equal(fs.readFileSync(markerPath(home), 'utf8'), '222\n1001')
  assert.equal(fs.readFileSync(markerPath(moved), 'utf8'), '111\n1000')
})

test('alias retarget during canonical selection fails without modifying either target', () => {
  const parent = tmpHome('alias-retarget')
  const first = path.join(parent, 'first')
  const second = path.join(parent, 'second')
  const alias = path.join(parent, 'alias')
  fs.mkdirSync(first); fs.mkdirSync(second)
  writeMarker(first, 111, 1000); writeMarker(second, 222, 1001)
  fs.symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const realpath = fs.realpathSync
  vi.spyOn(fs, 'realpathSync').mockImplementation(home => {
    if (String(home) === alias) {
      fs.unlinkSync(alias)
      fs.symlinkSync(second, alias, process.platform === 'win32' ? 'junction' : 'dir')
    }

    return realpath(home)
  })
  assert.doesNotThrow(() => writeUpdateMarker(alias, 4242))
  assert.equal(fs.readFileSync(markerPath(first), 'utf8'), '111\n1000')
  assert.equal(fs.readFileSync(markerPath(second), 'utf8'), '222\n1001')
})

test('alias retarget after selection cannot redirect publication', () => {
  const parent = tmpHome('alias-frozen')
  const first = path.join(parent, 'first')
  const second = path.join(parent, 'second')
  const alias = path.join(parent, 'alias')
  fs.mkdirSync(first); fs.mkdirSync(second)
  writeMarker(first, 111, 1000); writeMarker(second, 222, 1001)
  fs.symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const flush = fs.fsyncSync
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    flush(fd)
    fs.unlinkSync(alias)
    fs.symlinkSync(second, alias, process.platform === 'win32' ? 'junction' : 'dir')
  })
  writeUpdateMarker(alias, 4242)
  assert.equal(fs.readFileSync(markerPath(first), 'utf8').split('\n')[0], '4242')
  assert.equal(fs.readFileSync(markerPath(second), 'utf8'), '222\n1001')
})

test('Desktop preserves a confirmed live foreign handoff hint', () => {
  const home = tmpHome('foreign-handoff')
  writeMarker(home, process.pid, Math.floor(Date.now() / 1000))
  const original = fs.readFileSync(markerPath(home), 'utf8')
  writeUpdateMarker(home, 999999)
  assert.equal(fs.readFileSync(markerPath(home), 'utf8'), original)
  assert.equal(readUpdateExclusion(home)?.kind, 'marker')
})

test('a live hint appearing during staging is preserved', () => {
  const home = tmpHome('late-handoff')
  const flush = fs.fsyncSync
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    flush(fd)
    writeMarker(home, process.pid, Math.floor(Date.now() / 1000))
  })
  writeUpdateMarker(home, 999999)
  assert.equal(readLiveUpdateMarker(home)?.pid, process.pid)
  assert.deepEqual(fs.readdirSync(home), [path.basename(markerPath(home))])
})

test('native Windows unavailable sidecar defers the gate without inventing a PID', () => {
  if (process.platform !== 'win32') {return} // Native sidecar probe is Windows-only.
  const home = tmpHome('unavailable-sidecar')
  const sidecar = markerPath(home) + '.install-lock'
  fs.writeFileSync(sidecar, '')
  writeMarker(home, 999999, 0)
  const body = fs.readFileSync(markerPath(home), 'utf8')
  const open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if (String(file) === sidecar) {throw Object.assign(new Error('synthetic sharing/access denial'), { code: 'EACCES' })}

    return open(file, flags, mode)
  })
  const state = readUpdateExclusion(home)
  assert.equal(state?.kind, 'install-lock-unavailable')
  assert.equal('pid' in state, false)
  assert.equal(fs.readFileSync(markerPath(home), 'utf8'), body, 'do not prune losing PID while OS exclusion cannot be inspected')
  writeUpdateMarker(home, process.pid)
  assert.equal(fs.readFileSync(markerPath(home), 'utf8'), body)
})


test('a reader never reaches the shared unlink boundary that can delete a replacement', () => {
  const home = tmpHome('no-shared-unlink')
  writeMarker(home, 111, 1000)
  const body = fs.readFileSync(markerPath(home), 'utf8')
  const unlink = vi.spyOn(fs, 'unlinkSync')
  assert.equal(readUpdateExclusion(home, { kill: DEAD }), null)
  assert.equal(unlink.mock.calls.length, 0, 'no check-then-unlink of shared hint')
  assert.equal(fs.readFileSync(markerPath(home), 'utf8'), body)
  vi.restoreAllMocks()
  writeUpdateMarker(home, process.pid)
  assert.equal(readUpdateExclusion(home)?.kind, 'marker', 'existing atomic writer replaces dead hint')
})

test('complete decimal values retain CRLF and trailing newline compatibility', () => {
  const home = tmpHome('decimal-crlf')
  const now = 1_000_000_000_000
  fs.writeFileSync(markerPath(home), '4242\r\n999999995\r\n')
  assert.deepEqual(readUpdateExclusion(home, { kill: ALIVE, now: () => now }),
    { kind: 'marker', owner: { pid: 4242, ageMs: 5000 } })
})

for (const value of ['123junk', '1e9', '1.5', '-1', '+1', '9007199254740992', '9007199254741', '', '0']) {
  test(`live PID plus unverifiable timestamp ${JSON.stringify(value)} defers startup`, () => {
    const home = tmpHome('invalid-time')
    const body = `4242\n${value}\n`
    fs.writeFileSync(markerPath(home), body)
    assert.equal(readUpdateExclusion(home, { kill: ALIVE })?.kind, 'marker-unverifiable')
    assert.equal(fs.readFileSync(markerPath(home), 'utf8'), body)
    assert.equal(readUpdateExclusion(home, { kill: DEAD }), null, 'owner exit clears uncertainty')
  })
}

for (const value of ['4242junk', '4e3', '4.5', '-4242', '+4242', '9007199254740992']) {
  test(`PID ${JSON.stringify(value)} is not accepted as a numeric prefix`, () => {
    const home = tmpHome('invalid-pid')
    writeMarker(home, value, Math.floor(Date.now() / 1000))
    const kill = vi.fn(ALIVE)
    assert.equal(readUpdateExclusion(home, { kill }), null)
    assert.equal(kill.mock.calls.length, 0, 'no guessed or unsafe process identifier')
    assert.ok(fs.existsSync(markerPath(home)))
  })
}

test('future marker after clock rollback defers, then clears on removal', () => {
  const home = tmpHome('clock-rollback')
  const now = 1_000_000_000_000
  writeMarker(home, 4242, now / 1000 + 3600)
  assert.equal(readUpdateExclusion(home, { kill: ALIVE, now: () => now })?.kind, 'marker-unverifiable')
  fs.unlinkSync(markerPath(home)) // owner completion, not reader pruning
  assert.equal(readUpdateExclusion(home, { kill: ALIVE, now: () => now }), null)
})

test('nonfinite clock and extra content do not authorize backend startup', () => {
  const home = tmpHome('unverifiable-clock')
  writeMarker(home, 4242, 1000)
  for (const clock of [NaN, Infinity, -Infinity]) {
    assert.equal(readUpdateExclusion(home, { kill: ALIVE, now: () => clock })?.kind, 'marker-unverifiable')
  }
  fs.writeFileSync(markerPath(home), '4242\n1000\nextra')
  assert.equal(readUpdateExclusion(home, { kill: ALIVE, now: () => 1_000_000 })?.kind, 'marker-unverifiable')
})

test('age ceiling is inclusive and EPERM preserves ambiguous live time', () => {
  const home = tmpHome('age-ceiling')
  writeMarker(home, 4242, 1000)
  assert.equal(readUpdateExclusion(home, { kill: ALIVE, now: () => 1_000_000 + UPDATE_MARKER_MAX_AGE_MS })?.kind, 'marker')
  assert.equal(readUpdateExclusion(home, { kill: ALIVE, now: () => 1_000_001 + UPDATE_MARKER_MAX_AGE_MS }), null)
  const denied = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) }
  assert.equal(readUpdateExclusion(home, { kill: denied, now: () => 1 })?.kind, 'marker-unverifiable')
})

test('install-only Inno startup requires an exact marker and never accepts an update-capable image', () => {
  const commit = 'a'.repeat(40)
  const marker = {
    schemaVersion: 1,
    installKind: 'inno-local-native',
    updateSupported: false,
    pinnedCommit: commit,
    artifactHashKind: 'file-tree-sha256',
    artifactTreeSha256: 'b'.repeat(64)
  }
  assert.equal(isInnoInstallOnlyMarker(marker, commit), true)
  assert.equal(isInnoInstallOnlyMarker({ ...marker, updateSupported: true }, commit), false)
  assert.equal(isInnoInstallOnlyMarker({ ...marker, installKind: 'legacy' }, commit), false)
  assert.equal(isInnoInstallOnlyMarker(marker, 'c'.repeat(40)), false)
  assert.equal(isInnoInstallOnlyMarker({ ...marker, artifactTreeSha256: 'invalid' }, commit), false)
})