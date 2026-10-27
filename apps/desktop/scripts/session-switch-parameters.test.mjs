import { describe, expect, it, vi } from 'vitest'
vi.mock('./perf/lib/cdp.mjs', () => ({ SELECTORS: { assistantMessage: '.assistant' }, sleep: async () => {} }))
const { default: scenario } = await import('./perf/scenarios/session-switch.mjs')
function client() {
  let sid
  let time = 10
  return {
    send: vi.fn(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'synthetic-global' } }
      if (method === 'Runtime.callFunctionOn') { sid = params.arguments[0].value; return { result: { value: time } } }
      return {}
    }),
    eval: vi.fn(async () => ({ route: '#/' + sid, msgs: 1, t: ++time }))
  }
}
describe('session switch CDP data arguments', () => {
  it.each(['session-42', `quote'"\\backslash`, 'سلام-雪', '\u2028line\u2029paragraph', `'); globalThis.injected = true; //`])('passes %j only as data and retains metrics', async sid => {
    const cdp = client()
    const result = await scenario.run(cdp, { a: sid, b: 'second-id', rounds: 1 })
    const calls = cdp.send.mock.calls.filter(([method]) => method === 'Runtime.callFunctionOn')
    expect(calls.map(([, params]) => params.arguments)).toEqual([[{ value: sid }], [{ value: 'second-id' }]])
    expect(new Set(calls.map(([, params]) => params.functionDeclaration)).size).toBe(1)
    expect(calls[0][1].functionDeclaration).toBe('function (sessionId) { location.hash = "#/" + sessionId; return performance.now() }')
    expect(calls.every(([, params]) => params.objectId === 'synthetic-global' && params.returnByValue)).toBe(true)
    expect(cdp.send.mock.calls.filter(([method]) => method === 'Runtime.releaseObject')).toHaveLength(2)
    expect(cdp.eval.mock.calls.every(([expression]) => !expression.includes(sid))).toBe(true)
    expect(result.detail.firstPaint.n).toBe(2)
    expect(result.detail.settled.n).toBe(2)
  })
  it.each(['protocol rejection', 'renderer exception'])('releases the context on %s', async failure => {
    const cdp = client()
    cdp.send.mockImplementation(async method => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'synthetic-global' } }
      if (method === 'Runtime.callFunctionOn') {
        if (failure === 'protocol rejection') throw new Error(failure)
        return { exceptionDetails: { text: failure } }
      }
      return {}
    })
    await expect(scenario.run(cdp, { a: 'a', b: 'b', rounds: 1 })).rejects.toThrow(failure)
    expect(cdp.send).toHaveBeenLastCalledWith('Runtime.releaseObject', { objectId: 'synthetic-global' })
    expect(cdp.eval).not.toHaveBeenCalled()
  })
  it('rejects missing context before navigation', async () => {
    const cdp = client()
    cdp.send.mockResolvedValue({ exceptionDetails: { text: 'context gone' } })
    await expect(scenario.run(cdp, { a: 'a', b: 'b' })).rejects.toThrow('Unable to select')
    expect(cdp.send.mock.calls.map(([method]) => method)).toEqual(['Runtime.enable', 'Runtime.evaluate'])
  })
  it('surfaces release failure without continuing', async () => {
    const cdp = client()
    cdp.send.mockImplementation(async method => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'synthetic-global' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: 10 } }
      if (method === 'Runtime.releaseObject') throw new Error('release failed')
      return {}
    })
    await expect(scenario.run(cdp, { a: 'a', b: 'b' })).rejects.toThrow('release failed')
    expect(cdp.eval).not.toHaveBeenCalled()
  })
})