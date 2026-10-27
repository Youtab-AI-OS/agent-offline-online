import assert from 'node:assert/strict'

import { requireGatewayTransport } from '@youtab/agent-shared/gateway-transport'
import { test, vi } from 'vitest'

import { buildGatewayWsUrl, buildGatewayWsUrlWithTicket, normalizeRemoteBaseUrl, resolveTestWsUrl } from './connection-config'
import { probeGatewayWebSocket } from './gateway-ws-probe'
import { requestJsonWithOAuthSession } from './oauth-net-request'

for (const host of ['gateway.invalid', '192.168.1.2', '10.0.0.1', 'localhost.evil.invalid', 'evil-localhost', '[::2]']) {
  test(`reject plaintext gateway before all credential transports: ${host}`, async () => {
    const httpUrl = `http://${host}/prefix`
    const wsUrl = `ws://${host}/prefix/api/ws?token=synthetic-secret`
    assert.throws(() => normalizeRemoteBaseUrl(httpUrl), /require https/)
    assert.throws(() => buildGatewayWsUrl(httpUrl, 'synthetic-secret'), /require https/)
    assert.throws(() => buildGatewayWsUrlWithTicket(httpUrl, 'synthetic-ticket'), /require https/)
    const mintTicket = vi.fn()
    await assert.rejects(resolveTestWsUrl(httpUrl, 'oauth', null, { mintTicket }), /require https/)
    assert.equal(mintTicket.mock.calls.length, 0)
    const requestFactory = vi.fn()
    await assert.rejects(requestJsonWithOAuthSession(`${httpUrl}/api`, {
      authorityBaseUrl: httpUrl, session: {}, requestFactory, timeoutMs: 100
    }), /require https/)
    assert.equal(requestFactory.mock.calls.length, 0)
    const socketFactory = vi.fn()
    const result = await probeGatewayWebSocket(wsUrl, { WebSocketImpl: socketFactory })
    assert.equal(result.ok, false)
    assert.equal(socketFactory.mock.calls.length, 0)
  })
}

for (const host of ['localhost', '127.0.0.1', '127.2.3.4', '[::1]']) {
  test(`loopback and SSH forward keep plaintext capability: ${host}`, () => {
    const base = `http://${host}:1234/prefix`
    assert.equal(normalizeRemoteBaseUrl(base), base)
    assert.equal(buildGatewayWsUrl(base, 'token'), `ws://${host}:1234/prefix/api/ws?token=token`)
    assert.equal(requireGatewayTransport(`ws://${host}:1234/api/ws`, 'ws').hostname, host)
  })
}

test('direct HTTPS preserves path prefix and encodes token/ticket with WSS', () => {
  assert.equal(normalizeRemoteBaseUrl('https://gateway.invalid/prefix/'), 'https://gateway.invalid/prefix')
  assert.equal(buildGatewayWsUrl('https://gateway.invalid/prefix', 'a&b'), 'wss://gateway.invalid/prefix/api/ws?token=a%26b')
  assert.equal(buildGatewayWsUrlWithTicket('https://gateway.invalid/prefix', 'a&b'), 'wss://gateway.invalid/prefix/api/ws?ticket=a%26b')
})
