/**
 * Tests for OAuth-session Electron net.request helpers.
 *
 * Run with: node --test electron/oauth-net-request.test.ts
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test, vi } from 'vitest'

import { requestJsonWithOAuthSession, requireOAuthRequestTarget, serializeJsonBody, setJsonRequestHeaders } from './oauth-net-request'

function transport() {
  const request = new EventEmitter() as any
  request.setHeader = vi.fn()
  request.write = vi.fn()
  request.end = vi.fn()
  request.abort = vi.fn(() => request.emit('abort'))
  request.followRedirect = vi.fn()
  const session = { partition: 'synthetic-cookie-partition' }
  const factory = vi.fn((_options: any) => request)
  const options = { authorityBaseUrl: 'https://gateway.invalid/base', session, requestFactory: factory, timeoutMs: 10_000 }
  return { request, factory, options, session }
}

test('cross-origin redirect aborts before follow while cookie partition and exact JSON framing remain', async () => {
  const { request, factory, options, session } = transport()
  const promise = requestJsonWithOAuthSession('https://gateway.invalid/base/api', { ...options, method: 'POST', body: { synthetic: 'payload' } })
  request.emit('redirect', 307, 'POST', 'https://other.invalid/base/api', {})
  await assert.rejects(promise, /selected gateway authority/)
  assert.equal(factory.mock.calls[0][0].redirect, 'manual')
  assert.equal(factory.mock.calls[0][0].session, session)
  assert.equal(factory.mock.calls[0][0].useSessionCookies, true)
  assert.equal(request.followRedirect.mock.calls.length, 0)
  assert.equal(request.abort.mock.calls.length, 1)
  assert.equal(request.write.mock.calls[0][0].toString(), '{"synthetic":"payload"}')
})

test('same-authority prefixed redirect returns JSON without changing body or partition', async () => {
  const { request, options } = transport()
  const promise = requestJsonWithOAuthSession('https://gateway.invalid/base/api', { ...options, method: 'POST', body: { a: 1 } })
  request.emit('redirect', 308, 'POST', 'https://gateway.invalid/base/final?profile=synthetic', {})
  const response = new EventEmitter() as any
  response.statusCode = 200; response.headers = { 'content-type': 'application/json' }
  request.emit('response', response)
  response.emit('data', '{"ok":true}'); response.emit('end')
  assert.deepEqual(await promise, { ok: true })
  assert.equal(request.followRedirect.mock.calls.length, 1)
  assert.equal(request.abort.mock.calls.length, 0)
})

test.each(['http://gateway.invalid/base/api', 'https://user:secret@gateway.invalid/base/api',
  'https://gateway.invalid/base-other/api', 'https://gateway.invalid/base/%2e%2e/outside',
  'https://gateway.invalid/base/a%2f..%2f..%2foutside'])('rejects redirect outside canonical selected authority: %s', url => {
  assert.throws(() => requireOAuthRequestTarget('https://gateway.invalid/base', url))
})

test.each([
  ['https://gateway.invalid/tenant%3Fone', 'https://gateway.invalid/tenant/api'],
  ['https://gateway.invalid/tenant%23one', 'https://gateway.invalid/tenant/api'],
  ['https://gateway.invalid/base', 'https://gateway.invalid/base%3F%2f..%2foutside'],
  ['https://gateway.invalid/base', 'https://gateway.invalid/ba%09se/api'],
  ['https://gateway.invalid/base', 'https://gateway.invalid/base/%23fragment'],
  ['https://gateway.invalid/base', 'https://gateway.invalid/base/%5c..%5coutside'],
  ['https://gateway.invalid/base', 'https://gateway.invalid/base/%00hidden'],
  ['https://gateway.invalid/base', 'https://gateway.invalid/base/%7fhidden'],
  ['https://gateway.invalid/base', 'https://gateway.invalid/ba\tse/api'],
])('rejects ambiguous decoded URL path without creating transport: %s -> %s', async (authorityBaseUrl, url) => {
  assert.throws(() => requireOAuthRequestTarget(authorityBaseUrl, url), /ambiguous/)
  const { factory, options } = transport()
  await assert.rejects(requestJsonWithOAuthSession(url, { ...options, authorityBaseUrl }))
  assert.equal(factory.mock.calls.length, 0)
})

test('keeps ordinary reverse proxy prefixes and valid encoded spaces', () => {
  for (const base of ['https://gateway.invalid/base', 'https://gateway.invalid/tenant%20one']) {
    const target = `${base}/api?profile=synthetic`
    assert.equal(requireOAuthRequestTarget(base, target), target)
  }
  assert.throws(() => requireOAuthRequestTarget('https://gateway.invalid/tenant%20one', 'https://gateway.invalid/tenant/api'))
})

test.each([
  ['https://gateway.invalid/tenant%20', 'https://gateway.invalid/tenant/api'],
  ['https://gateway.invalid/base', 'https://gateway.invalid/base%20'],
  ['https://gateway.invalid/a%2fb', 'https://gateway.invalid/a/b/api'],
  ['https://gateway.invalid/a/b', 'https://gateway.invalid/a%2fb/api'],
])('preserves spaces and rejects encoded component separator ambiguity: %s -> %s', async (authorityBaseUrl, url) => {
  assert.throws(() => requireOAuthRequestTarget(authorityBaseUrl, url))
  const { factory, options } = transport()
  await assert.rejects(requestJsonWithOAuthSession(url, { ...options, authorityBaseUrl }))
  assert.equal(factory.mock.calls.length, 0)
})

test('preserves trailing spaces in selected path components and valid children', () => {
  const base = 'https://gateway.invalid/tenant%20'
  assert.equal(requireOAuthRequestTarget(base, `${base}/api`), `${base}/api`)
  assert.equal(requireOAuthRequestTarget(`${base}/`, `${base}/api`), `${base}/api`)
  assert.equal(requireOAuthRequestTarget(base, base), base)
  assert.equal(requireOAuthRequestTarget('https://gateway.invalid/base', 'https://gateway.invalid/base/child%20'), 'https://gateway.invalid/base/child%20')
})

test('redirect loop and abort/error races settle once and clear the timer', async () => {
  vi.useFakeTimers()
  try {
    const { request, options } = transport()
    const rejected = vi.fn()
    const promise = requestJsonWithOAuthSession('https://gateway.invalid/base/api', options).catch(rejected)
    for (let i = 0; i < 6; i++) { request.emit('redirect', 307, 'POST', 'https://gateway.invalid/base/api', {}) }
    request.emit('error', new Error('late error'))
    await promise
    assert.equal(rejected.mock.calls.length, 1)
    assert.equal(request.abort.mock.calls.length, 1)
    assert.equal(vi.getTimerCount(), 0)
  } finally { vi.useRealTimers() }
})

test('timeout aborts once without allowing a later redirect', async () => {
  vi.useFakeTimers()
  try {
    const { request, options } = transport()
    const rejection = assert.rejects(requestJsonWithOAuthSession('https://gateway.invalid/base/api', options), /Timed out/)
    await vi.advanceTimersByTimeAsync(10_000)
    request.emit('redirect', 307, 'POST', 'https://gateway.invalid/base/final', {})
    await rejection
    assert.equal(request.abort.mock.calls.length, 1)
    assert.equal(request.followRedirect.mock.calls.length, 0)
    assert.equal(vi.getTimerCount(), 0)
  } finally { vi.useRealTimers() }
})

test('serializeJsonBody returns undefined for absent bodies', () => {
  assert.equal(serializeJsonBody(undefined), undefined)
})

test('serializeJsonBody JSON-encodes request bodies', () => {
  const body = serializeJsonBody({ archived: true })
  assert.ok(Buffer.isBuffer(body))
  assert.equal(body.toString('utf8'), '{"archived":true}')
})

test('setJsonRequestHeaders does not set Electron-restricted Content-Length', () => {
  const headers = []

  const request = {
    setHeader(name, value) {
      headers.push([name, value])
    }
  }

  setJsonRequestHeaders(request)

  assert.deepEqual(headers, [['Content-Type', 'application/json']])
  assert.equal(
    headers.some(([name]) => name.toLowerCase() === 'content-length'),
    false
  )
})
