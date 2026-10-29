import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertInnoBackendsIdle } from './inno-update-idle'

class Socket {
  events = new EventEmitter()
  closed = false
  request: { id: string; method: string; params: unknown } | undefined
  send(data: string) {
    this.request = JSON.parse(data)
  }
  close() {
    this.closed = true
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.events.on(type, listener)
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.events.off(type, listener)
  }
  open() {
    this.events.emit('open')
  }
  respond(sessions: unknown) {
    this.events.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: this.request?.id, result: { sessions } })
    })
  }
}
const local = 'ws://127.0.0.1:9119/api/ws?token=synthetic-test-only'
afterEach(() => vi.useRealTimers())

describe('existing local live-session admission RPC', () => {
  it('uses only active_list and closes the probe after an idle detached-session response', async () => {
    const socket = new Socket()
    const pending = assertInnoBackendsIdle([local], { createSocket: () => socket })
    socket.open()
    expect(socket.request).toMatchObject({ method: 'session.active_list', params: {} })
    socket.respond([{ id: 'synthetic-detached', status: 'idle' }])
    await pending
    expect(socket.closed).toBe(true)
    expect(socket.events.eventNames()).toHaveLength(0)
  })
  it.each(['working', 'waiting', 'starting', 'unknown'])(
    'refuses a %s session even if no renderer reports it',
    async (status) => {
      const socket = new Socket()
      const pending = assertInnoBackendsIdle([local], { createSocket: () => socket })
      socket.open()
      socket.respond([{ id: 'synthetic-background', status }])
      await expect(pending).rejects.toThrow('Finish it before updating')
      expect(socket.closed).toBe(true)
    }
  )
  it.each([null, {}, [{ id: 'synthetic', status: null }]])(
    'refuses malformed live-session data %j',
    async (sessions) => {
      const socket = new Socket()
      const pending = assertInnoBackendsIdle([local], { createSocket: () => socket })
      socket.open()
      socket.respond(sessions)
      await expect(pending).rejects.toThrow()
    }
  )
  it('ignores unrelated gateway frames and refuses a missing answer at the bounded deadline', async () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const pending = assertInnoBackendsIdle([local], { createSocket: () => socket, timeoutMs: 100 })
    const refused = expect(pending).rejects.toThrow('timed out')
    socket.open()
    socket.events.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'gateway.ready' }) })
    await vi.advanceTimersByTimeAsync(101)
    await refused
    expect(socket.closed).toBe(true)
  })
  it.each([
    'ws://192.168.2.4:9119/api/ws?token=test',
    'wss://api.youtab.io/api/ws?token=test',
    'ws://127.0.0.1:9119/else?token=test'
  ])('refuses non-owned URL %s before opening a socket', async (value) => {
    const createSocket = vi.fn()
    await expect(assertInnoBackendsIdle([value], { createSocket })).rejects.toThrow('loopback')
    expect(createSocket).not.toHaveBeenCalled()
  })
})
