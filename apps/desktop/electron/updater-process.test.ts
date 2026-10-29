import assert from 'node:assert/strict'
import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { reserveUpdateOperation } from './update-gate'
import { retainUpdateReservationUntilExit, spawnUpdaterProcess, spawnUpdaterProcessConfirmed } from './updater-process'

test('spawnUpdaterProcess hides the updater console and detaches the child on Windows', () => {
  const calls: Array<{ args: string[]; command: string; options: SpawnOptions }> = []
  let unrefCalls = 0

  const child = {
    pid: 4242,
    unref: () => {
      unrefCalls += 1
    }
  }

  const result = spawnUpdaterProcess(
    'youtab-setup.exe',
    ['--update', '--branch', 'main'],
    { cwd: 'C:\\Youtab', detached: true, stdio: 'ignore' },
    {
      isWindows: true,
      spawnProcess: (command, args, options) => {
        calls.push({ args, command, options })

        return child
      }
    }
  )

  assert.equal(result, child)
  assert.equal(unrefCalls, 1)
  assert.deepEqual(calls, [
    {
      args: ['--update', '--branch', 'main'],
      command: 'youtab-setup.exe',
      options: { cwd: 'C:\\Youtab', detached: true, stdio: 'ignore', windowsHide: true }
    }
  ])
})

test('spawnUpdaterProcess preserves updater options off Windows', () => {
  let capturedOptions: SpawnOptions | undefined

  spawnUpdaterProcess(
    'youtab-setup',
    ['--update'],
    { detached: true, stdio: 'ignore' },
    {
      isWindows: false,
      spawnProcess: (_command, _args, options) => {
        capturedOptions = options

        return { unref: () => {} }
      }
    }
  )

  assert.deepEqual(capturedOptions, { detached: true, stdio: 'ignore' })
})


class OwnedUpdater extends EventEmitter {
  pid?: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  unrefCalls = 0
  killCalls = 0
  constructor(pid?: number) {super(); this.pid = pid}
  unref() {this.unrefCalls++}
  kill() {this.killCalls++; return true}
  finish() {this.exitCode = 0; this.emit('exit', 0)}
}

test('a returned PID never grants handoff until actual spawn event', async () => {
  const child = new OwnedUpdater(1234)
  let completed = false
  const pending = spawnUpdaterProcessConfirmed('owned.exe', ['--update'], {}, { spawnProcess: () => child }).then(value => { completed = true; return value })
  await Promise.resolve()
  assert.equal(completed, false)
  child.emit('spawn')
  const result = await pending
  assert.equal(result.kind, 'started')
  if (result.kind === 'started') {assert.equal(result.pid, 1234); assert.equal(result.child, child)}
  child.finish()
})

test('undefined PID and observed spawn error never create a handoff latch', async () => {
  const child = new OwnedUpdater()
  const result = await spawnUpdaterProcessConfirmed('missing.exe', [], {}, { spawnProcess: () => { queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child } })
  assert.equal(result.kind, 'failed')
  assert.equal(child.killCalls, 0)
  child.finish()
})

test('an owned child exiting before ACK is failed, never started', async () => {
  const child = new OwnedUpdater(1234)
  const result = await spawnUpdaterProcessConfirmed('owned.exe', [], {}, { spawnProcess: () => { queueMicrotask(() => child.finish()); return child } })
  assert.equal(result.kind, 'failed')
})

test('a bounded uncertain child keeps reservation until its owned exit, without blind kill', async () => {
  let active = false
  const release = reserveUpdateOperation({ isUpdateInFlight: () => active, setUpdateInFlight: value => { active = value } })
  const child = new OwnedUpdater(1234)
  const result = await spawnUpdaterProcessConfirmed('owned.exe', [], {}, { spawnProcess: () => child, ackTimeoutMs: 1 })
  assert.equal(result.kind, 'unconfirmed')
  if (result.kind === 'unconfirmed') {retainUpdateReservationUntilExit(result.child, release)}
  assert.equal(active, true)
  assert.equal(child.killCalls, 0)
  child.finish()
  assert.equal(active, false)
})

test('error with a potentially live owned PID is unconfirmed, not killed or successful', async () => {
  const child = new OwnedUpdater(1234)
  const result = await spawnUpdaterProcessConfirmed('owned.exe', [], {}, { spawnProcess: () => { queueMicrotask(() => child.emit('error', new Error('failure'))); return child } })
  assert.equal(result.kind, 'unconfirmed')
  assert.equal(child.killCalls, 0)
  child.finish()
})

test('failed create-process reservation releases without publishing or quitting', async () => {
  let active = false
  let hints = 0
  let quits = 0
  const release = reserveUpdateOperation({ isUpdateInFlight: () => active, setUpdateInFlight: value => { active = value } })
  try {
    const child = new OwnedUpdater()
    const result = await spawnUpdaterProcessConfirmed('missing.exe', [], {}, { spawnProcess: () => child })
    if (result.kind === 'started') { hints++; quits++ }
    assert.equal(result.kind, 'failed')
    child.finish()
  } finally {release()}
  assert.equal(active, false)
  assert.equal(hints, 0)
  assert.equal(quits, 0)
})

test('actual Windows/Node spawn failure is observed without uncaught error', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'youtab-updater-spawn-'))
  try {
    const result = await spawnUpdaterProcessConfirmed(join(fixture, 'missing-updater.exe'), [], { shell: false, stdio: 'ignore' })
    assert.equal(result.kind, 'failed')
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    // Refuse recursive cleanup: unexpected fixture contents are preserved.
    await rmdir(fixture)
  }
})
test('actual owned Node child proves creation before successful ACK and exits cleanly', async () => {
  const result = await spawnUpdaterProcessConfirmed(process.execPath, ['-e', 'process.exit(0)'], { shell: false, stdio: 'ignore' })
  assert.equal(result.kind, 'started')
  if (result.kind === 'started') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owned child did not exit')), 5000)
      retainUpdateReservationUntilExit(result.child, () => {clearTimeout(timer); resolve()})
    })
    assert.equal(result.child.exitCode, 0)
  }
})
