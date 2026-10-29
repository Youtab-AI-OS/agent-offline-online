import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { test, vi } from 'vitest'

import { launchSetupHandoffV2, parseSetupHandoffResult, setupHandoffTimeoutMs } from './setup-handoff'

const requestId = '12345678-1234-1234-1234-123456789abc'
const bytes = Buffer.alloc(512, 1)
bytes[0] = 0x4d
bytes[1] = 0x5a
bytes.writeUInt32LE(0x80, 0x3c)
bytes.writeUInt32LE(0x4550, 0x80)
bytes.writeUInt16LE(0x8664, 0x84)
bytes.writeUInt16LE(2, 0x96)
bytes.writeUInt16LE(0x20b, 0x98)

const release = {
  sourceSha: 'a'.repeat(40), coordinationProtocol: 1 as const, sequence: 4,
  url: 'https://example.invalid/setup.exe',
  sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length
}

const input = { executable: 'C:\\Youtab\\youtab-setup.exe', lease: { close() {} }, home: 'C:\\Users\\Test\\AppData\\Local\\youtab', channel: 'pilot' as const, release, bytes }

test('large verified Setup gets a bounded local stream deadline', () => {
  assert.equal(setupHandoffTimeoutMs(bytes.length), 120_000)
  assert.ok(setupHandoffTimeoutMs(214_090_448) > 14 * 60_000)
  assert.ok(setupHandoffTimeoutMs(214_090_448) < 20 * 60_000)
  assert.throws(() => setupHandoffTimeoutMs(268_435_457), /SETUP_HANDOFF_INVALID_INPUT/)
})

test('a slow but progressing broker can finish before its bounded deadline', async () => {
  const broker = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.assign(broker, { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() })
  stdin.on('finish', () => {
    setTimeout(() => {
      stdout.write(JSON.stringify({ protocol: 'youtab.setup-handoff', version: 2, status: 'started', reason: 'lease-held', pid: 321, createdAt: '134047872000000000', stageId: requestId }) + '\n')
      broker.emit('close', 0)
    }, 40)
  })
  const result = await launchSetupHandoffV2(input, {
    spawnBroker: vi.fn(() => broker) as unknown as typeof spawn, requestId, timeoutMs: 200
  })
  assert.equal(result.pid, 321)
})

test('native handoff sends only verified Setup bytes and requires child lease ACK before success', async () => {
  const broker = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(broker, { stdin, stdout, stderr, kill: vi.fn() })
  const observed: Buffer[] = []

  stdin.on('data', chunk => observed.push(Buffer.from(chunk)))
  stdin.on('finish', () => {
    stdout.write(JSON.stringify({ protocol: 'youtab.setup-handoff', version: 2, status: 'started', reason: 'lease-held', pid: 321, createdAt: '134047872000000000', stageId: requestId }) + '\n')
    broker.emit('close', 0)
  })
  const spawnMock = vi.fn((_file: string, _args: readonly string[]) => broker)
  const spawnBroker = spawnMock as unknown as typeof spawn
  const result = await launchSetupHandoffV2(input, { spawnBroker, requestId, timeoutMs: 1000 })

  assert.deepEqual(Buffer.concat(observed), bytes)
  assert.equal(result.pid, 321)
  assert.equal(result.stageId, requestId)
  assert.deepEqual(spawnMock.mock.calls[0]?.[1], [
    '--setup-handoff-v2', '--home', input.home, '--sha256', release.sha256,
    '--size', String(bytes.length), '--channel', 'pilot', '--source-sha', release.sourceSha,
    '--request-id', requestId
  ])
})

test('repair handoff sends an explicit bounded mode to the native broker', async () => {
  const broker = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.assign(broker, { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() })
  stdin.on('finish', () => {
    stdout.write(JSON.stringify({ protocol: 'youtab.setup-handoff', version: 2, status: 'started', reason: 'lease-held', pid: 321, createdAt: '134047872000000000', stageId: requestId }) + '\n')
    broker.emit('close', 0)
  })
  const spawnMock = vi.fn((_file: string, _args: readonly string[]) => broker)
  const spawnBroker = spawnMock as unknown as typeof spawn
  await launchSetupHandoffV2({ ...input, mode: 'repair' }, { spawnBroker, requestId, timeoutMs: 1000 })
  assert.deepEqual(spawnMock.mock.calls[0]?.[1]?.slice(-2), ['--mode', 'repair'])
  await assert.rejects(launchSetupHandoffV2({ ...input, mode: 'reinstall' as 'repair' }, { spawnBroker }), /SETUP_HANDOFF_INVALID_INPUT/)
  assert.equal(spawnMock.mock.calls.length, 1)
})

test('unconfirmed, forged and blocked native outcomes never claim a started updater', () => {
  const started = { protocol: 'youtab.setup-handoff', version: 2, status: 'started', reason: 'lease-held', pid: 321, createdAt: '134047872000000000', stageId: requestId }

  assert.throws(() => parseSetupHandoffResult(JSON.stringify(started), 1, requestId), /SETUP_HANDOFF_UNCONFIRMED/)
  assert.throws(() => parseSetupHandoffResult(JSON.stringify({ ...started, stageId: '00000000-0000-0000-0000-000000000000' }), 0, requestId), /SETUP_HANDOFF_UNCONFIRMED/)
  assert.throws(() => parseSetupHandoffResult(JSON.stringify({ ...started, createdAt: 134047872000000000 }), 0, requestId), /SETUP_HANDOFF_UNCONFIRMED/)
  assert.throws(() => parseSetupHandoffResult(JSON.stringify({ ...started, reason: 'launched' }), 0, requestId), /SETUP_HANDOFF_UNCONFIRMED/)
  assert.throws(() => parseSetupHandoffResult(JSON.stringify({ protocol: 'youtab.setup-handoff', version: 2, status: 'blocked', reason: 'cache-full' }), 2, requestId), /SETUP_HANDOFF_BLOCKED:cache-full/)
})

test('damaged Setup is rejected before a native process is launched', async () => {
  const spawnMock = vi.fn((_file: string, _args: readonly string[]) => {throw new Error('must not execute')})
  const spawnBroker = spawnMock as unknown as typeof spawn

  await assert.rejects(launchSetupHandoffV2({ ...input, bytes: Buffer.from('damaged') }, { spawnBroker }), /SETUP_INTEGRITY_FAILURE/)
  assert.equal(spawnMock.mock.calls.length, 0)
})

test('three concurrent Desktop handoffs keep independent request identities and byte streams', async () => {
  const requests = [
    '12345678-1234-1234-1234-123456789ab1',
    '12345678-1234-1234-1234-123456789ab2',
    '12345678-1234-1234-1234-123456789ab3'
  ]

  const brokers: Array<{ child: ChildProcessWithoutNullStreams, stdin: PassThrough, stdout: PassThrough, written: Buffer[] }> = []

  const spawnBroker = vi.fn(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const written: Buffer[] = []
    stdin.on('data', chunk => written.push(Buffer.from(chunk)))
    Object.assign(child, { stdin, stdout, stderr, kill: vi.fn() })
    const index = brokers.length
    stdin.on('finish', () => {
      assert.deepEqual(Buffer.concat(written), bytes)
      stdout.write(JSON.stringify({
        protocol: 'youtab.setup-handoff', version: 2, status: 'started', reason: 'lease-held',
        pid: 400 + index, createdAt: String(134047872000000000n + BigInt(index)), stageId: requests[index]
      }) + '\n')
      child.emit('close', 0)
    })
    brokers.push({ child, stdin, stdout, written })

    return child
  }) as unknown as typeof spawn

  const pending = requests.map(id => launchSetupHandoffV2(input, { spawnBroker, requestId: id, timeoutMs: 1000 }))

  assert.equal(brokers.length, 3)
  const results = await Promise.all(pending)

  assert.deepEqual(results.map(result => result.stageId), requests)
  assert.deepEqual(results.map(result => result.pid), [400, 401, 402])
})

test('broker crash, malformed success and silent timeout never confirm handoff', async () => {
  const outcomes = ['crash', 'malformed', 'timeout'] as const

  for (const outcome of outcomes) {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const kill = vi.fn()
    Object.assign(child, { stdin, stdout, stderr, kill })
    const spawnBroker = vi.fn(() => child) as unknown as typeof spawn
    const pending = launchSetupHandoffV2(input, { spawnBroker, requestId, timeoutMs: 10 })

    await new Promise<void>(resolve => stdin.once('finish', resolve))

    if (outcome === 'crash') {child.emit('close', 1)}

    if (outcome === 'malformed') {stdout.write('{not-json}\n'); child.emit('close', 0)}
    await assert.rejects(pending, /SETUP_HANDOFF_UNCONFIRMED/)

    if (outcome === 'timeout') {assert.equal(kill.mock.calls.length, 1)}
  }
})

test('timeout keeps Setup pinned until the broker actually closes', async () => {
  let releases = 0
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  })
  const pending = launchSetupHandoffV2({ ...input, lease: { close: () => { releases++ } } }, {
    spawnBroker: vi.fn(() => child) as unknown as typeof spawn,
    requestId, timeoutMs: 10
  })
  await assert.rejects(pending, /SETUP_HANDOFF_UNCONFIRMED/)
  assert.equal(releases, 0)
  child.emit('close', null)
  assert.equal(releases, 1)
})
