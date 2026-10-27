import { describe, expect, it, vi } from 'vitest'

import { installRendererErrorLogging, reportRendererError } from '../src/lib/renderer-errors'

describe('renderer last-chance diagnostics', () => {
  it('logs fixed codes for async and synchronous errors without the raw default console output', () => {
    const target = new EventTarget()
    const log = vi.fn()
    const remove = installRendererErrorLogging(target as unknown as Window, log)

    for (const type of ['error', 'unhandledrejection']) {
      const event = new Event(type, { cancelable: true })
      Object.assign(event, { error: new Error('opaque company secret'), reason: 'opaque rejection secret', message: 'opaque message secret' })
      target.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }

    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls).toEqual([['[renderer] Uncaught error'], ['[renderer] Unhandled rejection']])
    remove()
    target.dispatchEvent(new Event('error'))
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('never reads or serializes rejection payloads', () => {
    const target = new EventTarget()
    const log = vi.fn()
    installRendererErrorLogging(target as unknown as Window, log)
    const event = new Event('unhandledrejection', { cancelable: true })
    const toJSON = vi.fn(() => { throw new Error('opaque secret') })
    Object.assign(event, { reason: { toJSON } })
    target.dispatchEvent(event)
    expect(log).toHaveBeenCalledWith('[renderer] Unhandled rejection')
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('never passes a React error or stack to the console bridge', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      reportRendererError(new Error('opaque React secret'))
      expect(log.mock.calls).toEqual([['[renderer] React error']])
    } finally {
      log.mockRestore()
    }
  })
})
