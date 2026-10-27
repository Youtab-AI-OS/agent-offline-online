import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

import { test, vi } from 'vitest'

import { normalizeRemoteBaseUrl, requireNativePortalAuthority } from './connection-config'
import { bindNativeTokens, createNativeCredentialTransport, requireStoredNativeAuthority, selectNativeGatewayAuthority } from './native-credential-authority'
import { clearGatewaySessionCredentials, createNativeRefreshCoordinator, createNativeSessionLifecycle, parseTokenResponse, resolveLoginStrategy } from './native-oauth'

test('native refresh and logout send exact credentials only to configured Portal', async () => {
  const send = vi.fn().mockResolvedValue({ ok: true })
  const transport = createNativeCredentialTransport(send)
  await transport.refresh('https://api.youtab.io', { refreshToken: 'synthetic-refresh', provider: 'portal' })
  await transport.revoke('https://api.youtab.io', 'synthetic-refresh')
  assert.deepEqual(send.mock.calls, [
    ['https://api.youtab.io/auth/native/refresh', { refresh_token: 'synthetic-refresh', provider: 'portal' }, { timeoutMs: 10_000 }],
    ['https://api.youtab.io/v1/auth/logout', { refresh_token: 'synthetic-refresh' }, { timeoutMs: 10_000 }],
  ])
})

test('copied native record is rejected before transport with no token in error', async () => {
  const send = vi.fn()
  const transport = createNativeCredentialTransport(send)
  const tokens = { refreshToken: 'DO-NOT-LOG-SYNTHETIC-REFRESH', provider: 'portal' }
  for (const call of [() => transport.refresh('https://copied.invalid', tokens), () => transport.revoke('https://copied.invalid', tokens.refreshToken)]) {
    await assert.rejects(call, error => {
      assert.equal(String(error).includes(tokens.refreshToken), false)
      assert.equal((error as any).noCookieFallback, true)
      return true
    })
  }
  assert.equal(send.mock.calls.length, 0)
  assert.equal(tokens.refreshToken, 'DO-NOT-LOG-SYNTHETIC-REFRESH')
})

test('unsupported stored-native denial preserves coordinator record and profiles', async () => {
  const record = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', provider: 'portal', expiresAt: 1 }
  const snapshot = structuredClone(record)
  const send = vi.fn()
  const transport = createNativeCredentialTransport(send)
  const clear = vi.fn(), commit = vi.fn(), writeProfile = vi.fn()
  const coordinator = createNativeRefreshCoordinator({ load: () => record as any, exchange: (base, tokens) => transport.refresh(base, tokens) as any,
    clear, commit, writeProfile, now: () => 100 })
  await assert.rejects(() => coordinator.ensure('https://copied.invalid'), /configured gateway authority/)
  assert.deepEqual(record, snapshot)
  assert.equal(clear.mock.calls.length, 0)
  assert.equal(commit.mock.calls.length, 0)
  assert.equal(writeProfile.mock.calls.length, 0)
  assert.equal(send.mock.calls.length, 0)
})

test('fresh native records must be authorized, while remote cookie mode without native record remains valid', () => {
  assert.throws(() => requireStoredNativeAuthority('https://copied.invalid', true), /configured gateway authority/)
  assert.doesNotThrow(() => requireStoredNativeAuthority('https://custom-remote.invalid/gateway', false))
  assert.doesNotThrow(() => requireStoredNativeAuthority('https://api.youtab.io', true))
})

// Run the production IPC callback/store/load/ensure functions with synthetic machine seams.
// AST extraction executes the real implementation; assertions describe effects, not source text.
function mainNativeHarness() {
  const require = createRequire(import.meta.url)
  const ts = require('../node_modules/typescript')
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['_readNativeTokenStore', '_persistNativeTokens', '_loadNativeTokens', '_storeNativeTokens', '_clearNativeTokens', 'ensureNativeAccessToken']
  const declarations: string[] = []
  let callback, logoutCallback
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) { declarations.push(node.getText(ast)) }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' && node.arguments[0]?.text === 'youtab:connection-config:oauth-login') { callback = node.arguments[1].getText(ast) }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' && node.arguments[0]?.text === 'youtab:connection-config:oauth-logout') { logoutCallback = node.arguments[1].getText(ast) }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(declarations.length, names.length)
  assert.ok(callback)
  const files = new Map<string, string>()
  const cache = new Map()
  const sends = vi.fn(async (_url: string, _body: unknown, _options: unknown) => ({ access_token: 'rotated-synthetic', inference_access_token: `synthetic.${Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url')}.signature`, refresh_token: 'rotated-refresh', expires_at: 9999999999, user_id: 'synthetic-user', authority: { kind: 'remote_gateway', baseUrl: 'https://server-chosen.invalid' } }))
  const transport = createNativeCredentialTransport(sends)
  let coordinator
  const context: any = {
    JSON, Object, Error, Map, Promise, Buffer,
    _nativeTokens: cache,
    _nativeTokenStorePath: () => '/synthetic/native-store.json',
    fs: { readFileSync: filename => { if (!files.has(filename)) { throw new Error('absent') }; return files.get(filename) }, mkdirSync() {}, writeFileSync: (filename, data) => files.set(filename, data), renameSync: (from, to) => { files.set(to, files.get(from)!); files.delete(from) } },
    path: { dirname: () => '/synthetic' },
    encryptDesktopSecret: value => ({ encoding: 'synthetic', value: Buffer.from(value).toString('base64') }),
    decryptDesktopSecret: secret => Buffer.from(secret.value, 'base64').toString(),
    parseTokenResponse, bindNativeTokens, selectNativeGatewayAuthority, requireStoredNativeAuthority,
    normalizeRemoteBaseUrl, requireNativePortalAuthority, resolveLoginStrategy, clearGatewaySessionCredentials,
    clearOauthSession: vi.fn(async () => {}), hasLiveOauthSession: async () => false, hasNativeSession: base => Boolean(context.functions._loadNativeTokens(base)),
    _scheduleNativeRefresh() {}, _nativeRefreshTimers: new Map(), _nativeRefreshRetries: { reset() {} },
    stopAccountSync() {}, clearTimeout() {},
    nativeRefresh: { ensure: (...args) => coordinator.ensure(...args), discard() {} },
    fetchPublicJson: vi.fn(async () => ({ auth_flows: ['native_pkce'] })),
    runNativeLogin: vi.fn(async () => parseTokenResponse({ access_token: 'fresh-synthetic', refresh_token: 'synthetic-refresh', inference_access_token: `synthetic.${Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url')}.signature`, expires_at: 9999999999, user_id: 'synthetic-user', authority: { kind: 'remote_gateway', baseUrl: 'https://server-chosen.invalid' } })),
    resolveLiveNativeProviderProfile: () => 'work',
    shell: { openExternal() {} }, postJsonNoAuth() {}, rememberLog() {}, releasePowerResumeAfterAuthChange() {}, remoteReauthFailure: null,
  }
  const code = `${declarations.join('\n')}\nglobalThis.functions = { ${names.join(',')} }; globalThis.login = ${callback}; globalThis.logout = ${logoutCallback};`
  runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  const fn = context.functions
  coordinator = createNativeRefreshCoordinator({ load: fn._loadNativeTokens, exchange: async (base, tokens) => parseTokenResponse(await transport.refresh(base, tokens)), commit: fn._storeNativeTokens, clear: fn._clearNativeTokens, writeProfile: async () => {}, now: () => 100 })
  context.nativeSessionLifecycle = createNativeSessionLifecycle({ load: fn._loadNativeTokens, store: fn._storeNativeTokens, clear: fn._clearNativeTokens, writeProfile: async () => {}, pauseRefresh() {}, waitForRefresh: async () => {}, discardPending() {}, scheduleRefresh() {}, revoke: (base, token, captured) => transport.revoke(base, token, captured), logRevocationFailure() {} })
  return { context, fn, files, cache, sends, coordinator, snapshot: () => files.get('/synthetic/native-store.json')! }
}

test.each([
  ['https://remote-gateway.invalid:8443/tenant%20', undefined, 'remote_gateway'],
  ['https://api.youtab.io', { nativeCapability: true }, 'portal_provider'],
])('production login, durable reload, refresh and logout retain selected authority: %s', async (base, options, kind) => {
  const h = mainNativeHarness()
  const result = await h.context.login({}, base, options)
  assert.equal(result.ok, true)
  assert.equal(await h.fn.ensureNativeAccessToken(base), 'fresh-synthetic')
  assert.equal(h.fn._loadNativeTokens(base).authority.baseUrl, base)
  assert.equal(h.fn._loadNativeTokens(base).authority.kind, kind)
  h.cache.clear() // restart: use the actual encrypted-store and stored parser path.
  assert.equal(await h.fn.ensureNativeAccessToken(base), 'fresh-synthetic')
  assert.equal(await h.fn.ensureNativeAccessToken(base, true), 'rotated-synthetic')
  assert.equal(h.fn._loadNativeTokens(base).authority.baseUrl, base)
  assert.equal(h.fn._loadNativeTokens(base).authority.kind, kind)
  assert.equal(h.sends.mock.calls[0][0], `${base}/auth/native/refresh`)
  const loggedOut = await h.context.logout({}, base, options)
  assert.equal(loggedOut.connected, false)
  assert.equal(h.fn._loadNativeTokens(base), null)
  assert.equal(h.sends.mock.calls[1][0], `${base}/v1/auth/logout`)
  assert.equal((h.sends.mock.calls[1][1] as any).refresh_token, 'rotated-refresh')
})

test.each(['https://api.youtab.io', 'http://remote-gateway.invalid:8443/gateway', 'https://remote-gateway.invalid:8443/gateway%20', 'https://other.invalid/gateway', 'https://remote-gateway.invalid:8444/gateway', 'https://remote-gateway.invalid:8443/changed'])('production moved record denies fresh use without effects or deletion: %s', async changed => {
  const h = mainNativeHarness(), base = 'https://remote-gateway.invalid:8443/gateway'
  await h.context.login({}, base)
  const store = JSON.parse(h.snapshot())
  store[changed] = store[base]
  h.files.set('/synthetic/native-store.json', JSON.stringify(store)); h.cache.clear()
  const before = h.snapshot()
  await assert.rejects(h.fn.ensureNativeAccessToken(changed), error => (error as any).noCookieFallback === true && (error as any).needsOauthLogin === true)
  await assert.rejects(
    h.context.logout({}, changed, changed === 'https://api.youtab.io' ? { nativeCapability: true } : undefined),
    changed.startsWith('http://')
      ? /Direct remote gateway connections require https:\/\//
      : error => (error as any).noCookieFallback === true
  )
  assert.equal(h.context.clearOauthSession.mock.calls.length, 0)
  assert.equal(h.snapshot(), before)
  assert.equal(h.sends.mock.calls.length, 0)
})

test('production legacy remote record requires explicit reauthentication without deletion', async () => {
  const h = mainNativeHarness(), base = 'https://remote-gateway.invalid/gateway'
  h.fn._storeNativeTokens(base, parseTokenResponse({ access_token: 'legacy-synthetic', refresh_token: 'legacy-refresh', expires_at: 9999999999 }))
  h.cache.clear()
  const before = h.snapshot()
  await assert.rejects(h.fn.ensureNativeAccessToken(base), /Sign in again/)
  assert.equal(h.snapshot(), before)
  assert.equal(h.sends.mock.calls.length, 0)
})
