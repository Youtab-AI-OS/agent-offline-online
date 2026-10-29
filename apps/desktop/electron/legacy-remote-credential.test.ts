import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { runInNewContext } from 'node:vm'

import { requireGatewayTransport } from '@youtab/agent-shared/gateway-transport'
import { test, vi } from 'vitest'

import * as connectionHelpers from './connection-config'
import { probeGatewayWebSocket } from './gateway-ws-probe'
import { DEFAULT_FETCH_TIMEOUT_MS, resolveTimeoutMs } from './hardening'
import { nativeHttpResponseError } from './native-oauth'

// Execute the actual main-process config/Test/IPC implementations without Electron
// or the operator's disk. HTTP and WebSocket canaries use only owned loopback servers.
function mainConnectionHarness(existing) {
  const require = createRequire(import.meta.url)
  const ts = require('../node_modules/typescript')
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['buildRemoteBlock', 'buildSshBlock', 'coerceDesktopConnectionConfig', 'testDesktopConnectionConfig', 'fetchJson']
  const declarations: string[] = []
  const callbacks: Record<string, string> = {}
  const routes = ['save', 'apply', 'test']

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
      declarations.push(node.getText(ast))
    }

    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle') {
      const route = routes.find(value => node.arguments[0]?.text === `youtab:connection-config:${value}`)

      if (route) { callbacks[route] = node.arguments[1].getText(ast) }
    }

    ts.forEachChild(node, visit)
  }

  visit(ast)
  assert.equal(declarations.length, names.length)
  assert.equal(Object.keys(callbacks).length, routes.length)
  let stored = structuredClone(existing)
  const wsProbe = vi.fn((url, options) => probeGatewayWebSocket(url, options))
  const write = vi.fn(config => { stored = structuredClone(config) })

  const context: any = {
    ...connectionHelpers, requireGatewayTransport,
    URL, Buffer, Promise, Error, http, https,
    WebSocket: globalThis.WebSocket,
    DEFAULT_FETCH_TIMEOUT_MS, resolveTimeoutMs, nativeHttpResponseError,
    readDesktopConnectionConfig: () => stored,
    writeDesktopConnectionConfig: write,
    encryptDesktopSecret: value => ({ encoding: 'synthetic', value }),
    decryptDesktopSecret: secret => secret?.value || '',
    sanitizeDesktopConnectionConfig: async config => config,
    probeGatewayWebSocket: wsProbe,
    mintGatewayWsTicket: vi.fn(async () => 'synthetic-oauth-ticket'),
    resolveRemoteBackend: vi.fn(async () => null),
    startYoutab: vi.fn(),
    applyConnectionChange: vi.fn(async () => {}),
    sshBootstrapCoordinator: { cancelAndWait: vi.fn() },
    primaryProfileKey: () => 'work',
    sendConnectionApplied: vi.fn(), stopPoolBackend: vi.fn(), teardownSshConnection: vi.fn(),
  }

  const code = `${declarations.join('\n')}\nglobalThis.functions = { ${names.join(',')} };
    globalThis.routes = { ${routes.map(route => `${route}: ${callbacks[route]}`).join(',')} };`

  runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context)

  return { context, fn: context.functions, routes: context.routes, write, wsProbe, snapshot: () => structuredClone(stored) }
}

async function canaryGateway() {
  const requests: { url: string; token: string | string[] | undefined }[] = []
  const upgrades: string[] = []
  const sockets = new Set<Socket>()

  const server = http.createServer((req, res) => {
    requests.push({ url: req.url || '', token: req.headers['x-youtab-session-token'] })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"version":"synthetic"}')
  })

  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket) => {
    upgrades.push(req.url || '')
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const message = Buffer.from('{"type":"gateway.ready"}')
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]))
    socket.on('data', () => socket.end())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  return {
    url: `http://127.0.0.1:${address.port}/gateway`, requests, upgrades,
    close: async () => {
      for (const socket of sockets) { socket.destroy() }
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}

function savedConfig(url: string) {
  return {
    mode: 'remote',
    remote: { url, authMode: 'token', token: { encoding: 'synthetic', value: 'synthetic-global-credential' } },
    profiles: {
      work: { mode: 'remote', url, authMode: 'token', token: { encoding: 'synthetic', value: 'synthetic-profile-credential' } },
      other: { mode: 'remote', url: 'https://other.invalid/gateway', authMode: 'token', token: { value: 'synthetic-other-credential' } }
    }
  }
}

function gatewaySettingsPayload(mode: string, remoteUrl: string, profile?: string) {
  const require = createRequire(import.meta.url)
  const ts = require('../node_modules/typescript')
  const source = readFileSync(new URL('../src/app/settings/gateway-settings.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('gateway-settings.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let payload

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'payload' && ts.isArrowFunction(node.initializer)) {
      payload = node.initializer.getText(ast)
    }

    ts.forEachChild(node, visit)
  }

  visit(ast)
  assert.ok(payload)

  const context: any = {
    scope: profile, authMode: 'token', remoteToken: '', trimmedUrl: remoteUrl,
    state: { mode, sshHost: 'synthetic-ssh.invalid', sshUser: 'synthetic-user', sshPort: 22,
      sshKeyPath: '', sshRemoteYoutabPath: '/synthetic-runtime' }
  }

  runInNewContext(ts.transpileModule(`globalThis.result = (${payload})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context)

  return context.result
}

for (const profile of [undefined, 'work']) {
  for (const mode of ['local', 'ssh']) {
    for (const operation of ['save', 'apply']) {
      test.each(['https://edited.invalid/gateway', '', 'not a remote URL'])(
        `actual Settings inactive remote draft cannot block ${mode} ${operation}: ${profile || 'global'} %j`, async remoteUrl => {
          const existing = savedConfig('https://old.invalid/gateway')
          const h = mainConnectionHarness(existing)
          await h.routes[operation]({}, gatewaySettingsPayload(mode, remoteUrl, profile))
          const saved = h.snapshot()
          assert.equal(h.write.mock.calls.length, 1)
          assert.deepEqual(saved.profiles.other, existing.profiles.other)

          if (profile) {
            assert.deepEqual(saved.remote, existing.remote)

            if (mode === 'local') { assert.equal(saved.profiles.work, undefined) }
            else {
              assert.equal(saved.profiles.work.host, 'synthetic-ssh.invalid')
              assert.equal(saved.profiles.work.token, undefined)
            }
          } else {
            assert.equal(saved.mode, mode)
            assert.deepEqual(saved.profiles, existing.profiles)

            if (mode === 'local') { assert.deepEqual(saved.remote, existing.remote) }
            else {
              assert.equal(saved.remote.host, 'synthetic-ssh.invalid')
              assert.equal(saved.remote.token, undefined)
            }
          }

          assert.throws(() => h.fn.coerceDesktopConnectionConfig({
            mode: 'remote', profile, remoteUrl: 'https://edited.invalid/gateway'
          }), /session token.*required|URL changed/i)
          assert.deepEqual(h.snapshot(), saved)
          assert.deepEqual(existing, savedConfig('https://old.invalid/gateway'))
        }
      )
    }
  }
}

test('actual Settings local Test ignores edited inactive endpoint and uses resolved local credentials', async () => {
  const localGateway = await canaryGateway()
  const editedGateway = await canaryGateway()

  try {
    const existing = savedConfig('https://old.invalid/gateway')
    const h = mainConnectionHarness(existing)
    h.context.startYoutab.mockResolvedValue({ baseUrl: localGateway.url, token: 'synthetic-local-credential', authMode: 'token' })
    await h.routes.test({}, gatewaySettingsPayload('local', editedGateway.url))
    assert.equal(localGateway.requests[0].token, 'synthetic-local-credential')
    assert.equal(new URL(localGateway.upgrades[0], localGateway.url).searchParams.get('token'), 'synthetic-local-credential')
    assert.equal(editedGateway.requests.length, 0)
    assert.equal(editedGateway.upgrades.length, 0)
    assert.deepEqual(h.snapshot(), existing)
  } finally {
    await localGateway.close()
    await editedGateway.close()
  }
})

test.each([undefined, 'work'])('SSH ignores invalid inactive URL while retaining its same-host adopted token: %s', async profile => {
  const ssh = { mode: 'ssh', host: 'synthetic-ssh.invalid', user: 'synthetic-user', token: { value: 'synthetic-adopted-ssh' } }
  const existing = { mode: 'ssh', remote: ssh, profiles: { work: ssh } }
  const h = mainConnectionHarness(existing)
  await h.routes.save({}, gatewaySettingsPayload('ssh', 'not a remote URL', profile))
  const saved = h.snapshot()
  assert.equal((profile ? saved.profiles.work : saved.remote).token.value, 'synthetic-adopted-ssh')
})

for (const profile of [undefined, 'work']) {
  test(`changed endpoint refuses inherited credential before actual HTTP/WS: ${profile || 'global'}`, async () => {
    const oldGateway = await canaryGateway()
    const newGateway = await canaryGateway()

    try {
      const existing = savedConfig(oldGateway.url)
      const h = mainConnectionHarness(existing)

      const attempt = await h.routes.test({}, { mode: 'remote', profile, remoteUrl: newGateway.url })
        .then(() => ({ error: null }), error => ({ error }))

      assert.equal(newGateway.requests.length, 0, JSON.stringify({ http: newGateway.requests, ws: newGateway.upgrades }))
      assert.match(attempt.error?.message || '', /session token.*required|URL changed/i)
      assert.equal(newGateway.upgrades.length, 0)
      assert.equal(h.wsProbe.mock.calls.length, 0)
      assert.equal(h.write.mock.calls.length, 0)
      assert.deepEqual(h.snapshot(), existing)
    } finally {
      await oldGateway.close()
      await newGateway.close()
    }
  })

  test(`same endpoint accepts inherited credential over actual HTTP/WS: ${profile || 'global'}`, async () => {
    const gateway = await canaryGateway()

    try {
      const existing = savedConfig(gateway.url)
      const h = mainConnectionHarness(existing)
      const result = await h.routes.test({}, { mode: 'remote', profile, remoteUrl: `${gateway.url}/?ignored=yes#fragment` })
      const token = profile ? 'synthetic-profile-credential' : 'synthetic-global-credential'
      assert.equal(result.ok, true)
      assert.deepEqual(gateway.requests, [{ url: '/gateway/api/status', token }])
      assert.equal(new URL(gateway.upgrades[0], gateway.url).searchParams.get('token'), token)
      assert.deepEqual(h.snapshot(), existing)
    } finally { await gateway.close() }
  })

  for (const operation of ['save', 'apply']) {
    test(`changed endpoint ${operation} preserves original credential and unrelated profiles: ${profile || 'global'}`, async () => {
      const existing = savedConfig('https://old.invalid/gateway')
      const h = mainConnectionHarness(existing)
      await assert.rejects(h.routes[operation]({}, { mode: 'remote', profile, remoteUrl: 'https://new.invalid/gateway' }), /session token.*required|URL changed/i)
      assert.equal(h.write.mock.calls.length, 0)
      assert.equal(h.context.applyConnectionChange.mock.calls.length, 0)
      assert.deepEqual(h.snapshot(), existing)
    })

    test(`explicit credential ${operation} updates only the selected scope: ${profile || 'global'}`, async () => {
      const existing = savedConfig('https://old.invalid/gateway')
      const h = mainConnectionHarness(existing)
      await h.routes[operation]({}, {
        mode: 'remote', profile, remoteUrl: 'https://new.invalid/gateway', remoteToken: 'synthetic-fresh-credential'
      })
      const saved = h.snapshot()
      const selected = profile ? saved.profiles[profile] : saved.remote
      assert.equal(selected.url, 'https://new.invalid/gateway')
      assert.equal(selected.token.encoding, 'synthetic')
      assert.equal(selected.token.value, 'synthetic-fresh-credential')
      assert.deepEqual(saved.profiles.other, existing.profiles.other)
      assert.deepEqual(profile ? saved.remote : saved.profiles.work, profile ? existing.remote : existing.profiles.work)
      assert.deepEqual(existing, savedConfig('https://old.invalid/gateway'))
    })
  }

  test(`explicit fresh credential reaches only selected new endpoint: ${profile || 'global'}`, async () => {
    const gateway = await canaryGateway()

    try {
      const existing = savedConfig('https://old.invalid/gateway')
      const h = mainConnectionHarness(existing)
      await h.routes.test({}, { mode: 'remote', profile, remoteUrl: gateway.url, remoteToken: 'synthetic-fresh-credential' })
      assert.equal(gateway.requests[0].token, 'synthetic-fresh-credential')
      assert.equal(new URL(gateway.upgrades[0], gateway.url).searchParams.get('token'), 'synthetic-fresh-credential')
      assert.deepEqual(h.snapshot(), existing)
    } finally { await gateway.close() }
  })
}

test.each([
  'https://other.invalid/gateway', 'http://old.invalid/gateway',
  'https://old.invalid:8443/gateway', 'https://old.invalid/other-tenant'
])('implicit credential is bound to normalized scheme/host/port/path: %s', changedUrl => {
  const existing = savedConfig('https://old.invalid/gateway')
  const h = mainConnectionHarness(existing)
  assert.throws(() => h.fn.coerceDesktopConnectionConfig({ mode: 'remote', remoteUrl: changedUrl }), changedUrl.startsWith('http:') ? /require https/i : /session token.*required|URL changed/i)
  assert.deepEqual(h.snapshot(), existing)
})

test('canonical equivalent endpoint and local toggle preserve saved legacy credentials', () => {
  const existing = savedConfig('https://old.invalid/gateway')
  const h = mainConnectionHarness(existing)
  const equivalent = h.fn.coerceDesktopConnectionConfig({ mode: 'remote', remoteUrl: 'HTTPS://OLD.INVALID:443/gateway///?ignored=true#fragment' })
  assert.equal(equivalent.remote.url, existing.remote.url)
  assert.equal(equivalent.remote.token, h.context.readDesktopConnectionConfig().remote.token)
  const local = h.fn.coerceDesktopConnectionConfig({ mode: 'local' })
  assert.equal(local.mode, 'local')
  assert.equal(local.remote.token.value, 'synthetic-global-credential')
  assert.deepEqual(JSON.parse(JSON.stringify(local.profiles)), existing.profiles)
  assert.deepEqual(h.snapshot(), existing)
})

test('local connection Test uses only the resolved local gateway credential', async () => {
  const gateway = await canaryGateway()

  try {
    const existing = savedConfig('https://old.invalid/gateway')
    const h = mainConnectionHarness(existing)
    h.context.startYoutab.mockResolvedValue({ baseUrl: gateway.url, token: 'synthetic-local-credential', authMode: 'token' })
    await h.routes.test({}, { mode: 'local' })
    assert.equal(gateway.requests[0].token, 'synthetic-local-credential')
    assert.equal(new URL(gateway.upgrades[0], gateway.url).searchParams.get('token'), 'synthetic-local-credential')
    assert.deepEqual(h.snapshot(), existing)
  } finally { await gateway.close() }
})

test('changing to an OAuth endpoint carries no implicit legacy credential', () => {
  const existing = savedConfig('https://old.invalid/gateway')
  const h = mainConnectionHarness(existing)
  const next = h.fn.coerceDesktopConnectionConfig({ mode: 'remote', remoteUrl: 'https://oauth.invalid/gateway', remoteAuthMode: 'oauth' })
  assert.equal(next.remote.authMode, 'oauth')
  assert.equal(next.remote.token, undefined)
  assert.deepEqual(h.snapshot(), existing)
})

test.each(['', '   '])('blank incoming credential cannot rebind a saved token: %j', remoteToken => {
  const existing = savedConfig('https://old.invalid/gateway')
  const h = mainConnectionHarness(existing)
  assert.throws(() => h.fn.coerceDesktopConnectionConfig({
    mode: 'remote', remoteUrl: 'https://new.invalid/gateway', remoteToken
  }), /URL changed/)
  assert.deepEqual(h.snapshot(), existing)
})

for (const url of ['http://gateway.invalid/base', 'http://192.168.1.2', 'http://localhost.evil.invalid', 'http://[::2]']) {
  test(`direct plaintext credentials fail before HTTP/WS: ${url}`, async () => {
    const h = mainConnectionHarness(savedConfig(url))
    const request = vi.spyOn(http, 'request')
    try {
      await assert.rejects(h.fn.fetchJson(url, 'synthetic-token'), /require https/)
      await assert.rejects(h.fn.fetchJson(url, null, { bearer: 'synthetic-bearer' }), /require https/)
      await assert.rejects(h.fn.testDesktopConnectionConfig(savedConfig(url)), /require https/)
      assert.equal(request.mock.calls.length, 0)
      assert.equal(h.wsProbe.mock.calls.length, 0)
    } finally { request.mockRestore() }
  })
}
