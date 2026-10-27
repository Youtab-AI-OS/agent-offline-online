import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, vi } from 'vitest'

import { channelIndex, channelPreferenceStamp, downloadSetup, selectedReleaseChannel, stageSetup, verifiedSetupRelease, verifySetupBytes } from './release-delivery'

const base = `https://api.youtab.io/pilot-runtime-${'b'.repeat(32)}/releases`
const sha = 'a'.repeat(40)
const bytes = Buffer.alloc(512, 1)
bytes[0] = 0x4d
bytes[1] = 0x5a
bytes.writeUInt32LE(0x80, 0x3c)
bytes.writeUInt32LE(0x4550, 0x80)
bytes.writeUInt16LE(0x8664, 0x84)
bytes.writeUInt16LE(2, 0x96)
bytes.writeUInt16LE(0x20b, 0x98)
const manifest = { source_sha: sha, release_sequence: 4, platform: 'windows', architecture: 'x64', format: 'zip', setup_source_sha: sha, updater_protocol: 1, update_coordination_protocol: 1, setup_url: `${base}/${sha}/Youtab-Setup-${sha}.exe`, setup_sha256: createHash('sha256').update(bytes).digest('hex'), setup_size: bytes.length }
const latest = { ...manifest, manifest_url: `${base}/${sha}/manifest.json` }

test('staging rejects pathname replacement while verifying the original descriptor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtab-setup-test-'))
  const originalOpen = fs.open.bind(fs)
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await originalOpen(file, flags, mode)

    if (flags === 'wx+') {
      await fs.rename(file, `${file}.original`)
      await fs.writeFile(file, 'replacement')
    }

    return handle
  })

  try {
    await assert.rejects(stageSetup(verifiedSetupRelease(base, latest, manifest, 3), root, async () => bytes), /STAGED_SETUP_INTEGRITY_FAILURE/)
    const names = await fs.readdir(root)
    const replacement = names.find(name => name.endsWith('.exe'))!
    assert.equal(await fs.readFile(path.join(root, replacement), 'utf8'), 'replacement')
    assert.deepEqual(await fs.readFile(path.join(root, replacement + '.original')), bytes)
    assert.equal(names.length, 2)
  } finally {
    spy.mockRestore()
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('youtab-setup-test-'))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Pilot and Stable discover separate pointers for the same immutable Setup', () => {
  assert.notEqual(channelIndex(base, 'pilot'), channelIndex(base, 'stable'))
  assert.equal(verifiedSetupRelease(base, latest, manifest, 3).sha256, manifest.setup_sha256)
})

test('downloaded Setup bytes can be checked before backend shutdown', () => {
  const release = verifiedSetupRelease(base, latest, manifest, 3)

  assert.doesNotThrow(() => verifySetupBytes(release, bytes))
  const padded = new Uint8Array(bytes.length + 7)
  padded.set(bytes, 3)
  const offsetView = padded.subarray(3, 3 + bytes.length)
  assert.doesNotThrow(() => verifySetupBytes(release, offsetView))
  offsetView[0] = 0
  assert.throws(() => verifySetupBytes({ ...release, sha256: createHash('sha256').update(offsetView).digest('hex') }, offsetView), /SETUP_EXECUTABLE_INVALID/)
  assert.throws(() => verifySetupBytes(release, Buffer.from('damaged')), /SETUP_INTEGRITY_FAILURE/)
  const nonExecutable = Buffer.from(bytes)

  nonExecutable[0] = 0
  assert.throws(() => verifySetupBytes({ ...release, sha256: createHash('sha256').update(nonExecutable).digest('hex') }, nonExecutable), /SETUP_EXECUTABLE_INVALID/)
})

test('256 MiB standalone Setup metadata is accepted and larger metadata is rejected', () => {
  const size = 256 * 1024 * 1024
  const accepted = { ...manifest, setup_size: size }
  assert.equal(verifiedSetupRelease(base, { ...accepted, manifest_url: latest.manifest_url }, accepted, 3).size, size)
  const oversized = { ...accepted, setup_size: size + 1 }
  assert.throws(() => verifiedSetupRelease(base, { ...oversized, manifest_url: latest.manifest_url }, oversized, 3), /INVALID_SETUP_SIZE/)
})

test('invalid stage sizes are refused before download or cache creation', async () => {
  const download = vi.fn(async () => bytes)
  const release = verifiedSetupRelease(base, latest, manifest, 3)

  for (const size of [0, -1, 1.5, Number.NaN, 256 * 1024 * 1024 + 1]) {
    await assert.rejects(stageSetup({ ...release, size }, '', download), /INVALID_SETUP_SIZE/)
  }

  assert.equal(download.mock.calls.length, 0)
})

for (const point of ['write', 'sync', 'read'] as const) {
  test(`failed ${point} preserves its bounded stage and closes the descriptor`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtab-setup-test-'))
    const originalOpen = fs.open.bind(fs)
    const failure = new Error('synthetic stage failure')
    let closed = false
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode)
      const close = handle.close.bind(handle)

      handle.close = async () => { closed = true; await close() }

      if (point === 'write') {
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async () => { await write(bytes.subarray(0, 64)); throw failure }
      } else if (point === 'sync') {
        handle.sync = async () => { throw failure }
      } else {
        handle.read = async () => { throw failure }
      }

      return handle
    })

    try {
      await assert.rejects(
        stageSetup(verifiedSetupRelease(base, latest, manifest, 3), root, async () => bytes),
        error => error === failure,
      )
      assert.equal(closed, true)
      const names = await fs.readdir(root)
      assert.equal(names.length, 1)
      assert.deepEqual(await fs.readFile(path.join(root, names[0])), point === 'write' ? bytes.subarray(0, 64) : bytes)
    } finally {
      spy.mockRestore()
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
      assert.ok(path.basename(root).startsWith('youtab-setup-test-'))
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}
test('a later explicit Setup channel selection supersedes the saved About choice', () => {
  const installed = { pinnedCommit: sha, releaseSequence: 4, releaseChannel: 'pilot', channelSelectedAt: 'initial' }
  const config = { channel: 'pilot', channelMarker: channelPreferenceStamp(installed) }
  assert.equal(selectedReleaseChannel(config, installed), 'pilot')
  const switched = { ...installed, releaseChannel: 'stable', channelSelectedAt: 'next-choice' }
  assert.equal(selectedReleaseChannel(config, switched), 'stable')
  const aboutChoice = { channel: 'pilot', channelMarker: channelPreferenceStamp(switched) }
  assert.equal(selectedReleaseChannel(aboutChoice, switched), 'pilot')
  assert.equal(selectedReleaseChannel(aboutChoice, { ...switched, channelSelectedAt: 'choose-stable-again' }), 'stable')
})

for (const change of [
  { setup_source_sha: 'c'.repeat(40) }, { updater_protocol: 9 }, { update_coordination_protocol: 0 },
  { setup_url: 'https://evil.example/setup.exe' }, { setup_size: 0 },
  { setup_sha256: 'bad' }, { release_sequence: 2 }, { architecture: 'arm64' },
]) {
  test(`metadata fails closed: ${Object.keys(change)[0]}`, () => {
    const changed = { ...manifest, ...change }
    assert.throws(() => verifiedSetupRelease(base, { ...changed, manifest_url: latest.manifest_url }, changed, 3))
  })
}

test('mutable and immutable metadata must agree', () => {
  assert.throws(() => verifiedSetupRelease(base, { ...latest, setup_sha256: 'c'.repeat(64) }, manifest, 3))
})

test('verified sibling staging preserves an existing Setup; tampering leaves no file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtab-setup-test-'))

  try {
    const old = path.join(root, 'youtab-setup.exe')
    await fs.writeFile(old, 'old helper')
    const release = verifiedSetupRelease(base, latest, manifest, 3)
    const staged = await stageSetup(release, root, async () => bytes)
    assert.deepEqual(await fs.readFile(staged), bytes)
    assert.equal(await fs.readFile(old, 'utf8'), 'old helper')
    const count = (await fs.readdir(root)).length
    await assert.rejects(stageSetup(release, root, async () => Buffer.alloc(100)), /INTEGRITY/)
    await assert.rejects(stageSetup(release, root, async () => bytes.subarray(0, 50)), /INTEGRITY/)
    assert.equal((await fs.readdir(root)).length, count)
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('youtab-setup-test-'))
    await fs.rm(root, { recursive: true, force: true })
  }
})


test('independently parsed nested dependency descriptors agree by exact content', () => {
  const dependencies = { ffmpeg: { version: '9.0.2', files: { 'bin/ffmpeg.exe': { size: 105423872, sha256: 'd'.repeat(64) } } } }
  const immutable = JSON.parse(JSON.stringify({ ...manifest, managed_dependencies: dependencies }))
  const pointer = JSON.parse(JSON.stringify({ ...immutable, manifest_url: latest.manifest_url }))
  assert.notEqual(pointer.managed_dependencies, immutable.managed_dependencies)
  assert.equal(verifiedSetupRelease(base, pointer, immutable, 3).sha256, manifest.setup_sha256)
})

test('nested dependency tampering and extra or missing keys remain rejected', () => {
  const immutable = JSON.parse(JSON.stringify({ ...manifest, managed_dependencies: { ffmpeg: { version: '9.0.2', files: { binary: { sha256: 'd'.repeat(64), size: 105423872 } } } } }))
  type Pointer = typeof manifest & { manifest_url: string; extra?: boolean; managed_dependencies: { ffmpeg: { version?: string; extra?: boolean; files: { binary: { sha256: string; size: number } } } } }
  for (const mutate of [
    (pointer: Pointer) => { pointer.managed_dependencies.ffmpeg.files.binary.sha256 = 'e'.repeat(64) },
    (pointer: Pointer) => { delete pointer.managed_dependencies.ffmpeg.version },
    (pointer: Pointer) => { pointer.managed_dependencies.ffmpeg.extra = true },
    (pointer: Pointer) => { pointer.extra = true },
  ]) {
    const pointer = JSON.parse(JSON.stringify({ ...immutable, manifest_url: latest.manifest_url }))
    mutate(pointer)
    assert.throws(() => verifiedSetupRelease(base, pointer, immutable, 3), /LATEST_IMMUTABLE_MISMATCH/)
  }
})

test('release comparison requires own top-level metadata keys', () => {
  const pointer = { ...latest } as Record<string, unknown>
  delete pointer.setup_sha256
  pointer.unexpected = true
  Object.setPrototypeOf(pointer, { setup_sha256: manifest.setup_sha256 })
  assert.throws(() => verifiedSetupRelease(base, pointer, manifest, 3), /LATEST_IMMUTABLE_MISMATCH/)
})


test('missing, wrong or mismatched native coordination capability cannot stage legacy Setup', () => {
  const old = { ...manifest } as Record<string, unknown>
  delete old.update_coordination_protocol
  assert.throws(() => verifiedSetupRelease(base, { ...old, manifest_url: latest.manifest_url }, old, 3), /INCOMPATIBLE_SETUP/)
  assert.throws(() => verifiedSetupRelease(base, { ...latest, update_coordination_protocol: 2 }, manifest, 3), /LATEST_IMMUTABLE_MISMATCH/)
  const inherited = { ...old }
  Object.setPrototypeOf(inherited, { update_coordination_protocol: 1 })
  assert.throws(() => verifiedSetupRelease(base, { ...inherited, manifest_url: latest.manifest_url }, inherited, 3), /INCOMPATIBLE_SETUP/)
  assert.equal(verifiedSetupRelease(base, latest, manifest, 3).coordinationProtocol, 1)
})


test('Setup download supports an active transfer beyond two minutes and keeps the 15-second idle bound', async () => {
  vi.useFakeTimers()
  const response = new EventEmitter() as EventEmitter & { statusCode: number, resume: () => void }
  response.statusCode = 200
  response.resume = () => {}
  const request = new EventEmitter() as EventEmitter & { destroy: (error: Error) => void }
  let destroyed = false
  request.destroy = (error: Error) => { destroyed = true; request.emit('error', error); request.emit('close') }
  const get = vi.spyOn(https, 'get').mockImplementation(((...args: unknown[]) => {
    assert.equal((args[1] as { timeout: number }).timeout, 15000)
    const callback = args[2] as (message: typeof response) => void
    queueMicrotask(() => callback(response))
    return request
  }) as typeof https.get)

  try {
    const pending = downloadSetup(`${base}/${sha}/Youtab-Setup-${sha}.exe`, 15)
    await Promise.resolve()
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
      response.emit('data', Buffer.from('x'))
    }
    response.emit('end')
    request.emit('close')
    assert.equal((await pending).byteLength, 15)
    assert.equal(destroyed, false)
  } finally {
    get.mockRestore()
    vi.useRealTimers()
  }
})

test('Setup download reports a controlled error when the bounded buffer cannot be allocated', async () => {
  const response = new EventEmitter() as EventEmitter & { statusCode: number, resume: () => void }
  response.statusCode = 200
  response.resume = () => {}
  const request = new EventEmitter() as EventEmitter & { destroy: (error: Error) => void }
  let destroyed = false
  request.destroy = (error: Error) => { destroyed = true; request.emit('error', error); request.emit('close') }
  const get = vi.spyOn(https, 'get').mockImplementation(((...args: unknown[]) => {
    const callback = args[2] as (message: typeof response) => void
    queueMicrotask(() => callback(response))
    return request
  }) as typeof https.get)
  const allocate = vi.spyOn(Buffer, 'allocUnsafe').mockImplementationOnce(() => { throw new Error('synthetic allocation failure') })

  try {
    await assert.rejects(downloadSetup(`${base}/${sha}/Youtab-Setup-${sha}.exe`, 3), /SETUP_MEMORY_UNAVAILABLE/)
    assert.equal(destroyed, true)
  } finally {
    allocate.mockRestore()
    get.mockRestore()
  }
})

test('Setup download accepts exact bytes and rejects truncated or oversized bodies', async () => {
  let response: (EventEmitter & { statusCode: number, resume: () => void }) | undefined
  const get = vi.spyOn(https, 'get').mockImplementation(((...args: unknown[]) => {
    const message = new EventEmitter() as EventEmitter & { statusCode: number, resume: () => void }
    message.statusCode = 200
    message.resume = () => {}
    response = message
    const request = new EventEmitter() as EventEmitter & { destroy: (error: Error) => void }
    request.destroy = (error: Error) => { request.emit('error', error); request.emit('close') }
    const callback = args[2] as (value: typeof message) => void
    queueMicrotask(() => callback(message))
    return request
  }) as typeof https.get)

  try {
    const url = `${base}/${sha}/Youtab-Setup-${sha}.exe`
    const exact = downloadSetup(url, 3)
    await Promise.resolve()
    assert.ok(response)
    response.emit('data', Buffer.from('ab'))
    response.emit('data', Buffer.from('c'))
    response.emit('end')
    assert.equal(Buffer.from(await exact).toString(), 'abc')

    const short = downloadSetup(url, 3)
    await Promise.resolve()
    assert.ok(response)
    response.emit('data', Buffer.from('ab'))
    response.emit('end')
    await assert.rejects(short, /SETUP_SIZE_MISMATCH/)

    const long = downloadSetup(url, 3)
    const rejection = assert.rejects(long, /SETUP_SIZE_EXCEEDED/)
    await Promise.resolve()
    assert.ok(response)
    response.emit('data', Buffer.from('abcd'))
    await rejection
  } finally {
    get.mockRestore()
  }
})

test('Setup download still fails closed at the 15-minute total deadline', async () => {
  vi.useFakeTimers()
  const response = new EventEmitter() as EventEmitter & { statusCode: number, resume: () => void }
  response.statusCode = 200
  response.resume = () => {}
  const request = new EventEmitter() as EventEmitter & { destroy: (error: Error) => void }
  request.destroy = (error: Error) => { request.emit('error', error); request.emit('close') }
  const get = vi.spyOn(https, 'get').mockImplementation(((...args: unknown[]) => {
    const callback = args[2] as (message: typeof response) => void
    queueMicrotask(() => callback(response))
    return request
  }) as typeof https.get)

  try {
    const pending = downloadSetup(`${base}/${sha}/Youtab-Setup-${sha}.exe`, 15)
    const rejection = assert.rejects(pending, /SETUP_DOWNLOAD_TIMED_OUT/)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    await rejection
  } finally {
    get.mockRestore()
    vi.useRealTimers()
  }
})
