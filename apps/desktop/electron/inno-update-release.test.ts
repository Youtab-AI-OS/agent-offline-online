import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  admitOfflineInnoInstaller,
  downloadInnoInstaller,
  fetchInnoRelease,
  INNO_INSTALLER_LIMIT,
  INNO_METADATA_LIMIT,
  INNO_UPDATE_FEED,
  type InnoHttpsResponse,
  type InnoHttpsTransport,
  innoInstallerUrl,
  type InnoReleasePayload,
  innoUpdateIndexUrl,
  type InnoUpdateTrustRoot,
  validateInnoReleasePayloadForProducer,
  validateInnoUpdateTrustRoot,
  verifyInnoReleaseEnvelope
} from './inno-update-release'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const jwk = pair.publicKey.export({ format: 'jwk' })
const publicKey = { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! }

const keyId = digest(
  Buffer.concat([
    Buffer.from('4543533120000000', 'hex'),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url')
  ])
)

const trust: InnoUpdateTrustRoot = {
  protocol: 1,
  keyId,
  publicKey,
  feedBaseUrl: INNO_UPDATE_FEED,
  sequence: 1,
  buildId: 'a'.repeat(64)
}

const installer = Buffer.from('MZ synthetic installer bytes, never executed')
const fixtures: string[] = []

function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-signed-update-test-'))
  expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()))
  expect(path.basename(directory).startsWith('youtab-signed-update-test-')).toBe(true)
  fixtures.push(directory)

  return directory
}

function payload(overrides: Partial<InnoReleasePayload> = {}): InnoReleasePayload {
  return {
    product: 'io.youtab.agent',
    format: 'inno-full/v1',
    platform: 'windows',
    arch: 'x64',
    sequence: 2,
    buildId: 'b'.repeat(64),
    sourceSha: 'c'.repeat(40),
    version: '0.19.3',
    channel: 'stable',
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
    dataSchema: 1,
    installer: { fileName: 'Youtab-Setup.exe', sha256: digest(installer), size: installer.length },
    payloadManifestSha256: 'd'.repeat(64),
    ...overrides
  }
}

function envelope(value: unknown = payload(), payloadText?: string) {
  const bytes = Buffer.from(payloadText ?? JSON.stringify(value))

  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      keyId,
      payload: bytes.toString('base64url'),
      signature: sign('sha256', bytes, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    })
  )
}

const verified = (value = payload()) => verifyInnoReleaseEnvelope(envelope(value), trust, { channel: 'stable' })

function response(
  body: Uint8Array[] | AsyncIterable<Uint8Array>,
  changes: Partial<InnoHttpsResponse> = {}
): InnoHttpsResponse {
  return {
    statusCode: 200,
    headers: {},
    body:
      Symbol.asyncIterator in body
        ? (body as AsyncIterable<Uint8Array>)
        : (async function* () {
            yield* body as Uint8Array[]
          })(),
    close: vi.fn(),
    ...changes
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()

  for (const directory of fixtures.splice(0)) {fs.rmSync(directory, { recursive: true, force: true })}
})

describe('signed common-Inno release admission', () => {
  it('validates producer JSON before key access without granting authenticated release authority', () => {
    const value = payload()
    const admitted = validateInnoReleasePayloadForProducer(Buffer.from(JSON.stringify(value)), 'stable')
    expect(admitted).toEqual(value)
    expect(() => innoInstallerUrl(trust, { keyId, payloadSha256: 'a'.repeat(64), payload: admitted })).toThrow(
      'unauthenticated-release'
    )
  })

  it('refuses producer duplicate keys, wrong product, expired payload and excessive bytes', () => {
    const value = payload()
    expect(() =>
      validateInnoReleasePayloadForProducer(
        Buffer.from(JSON.stringify(value).replace('"product":', '"product":"io.youtab.agent","product":')),
        'stable'
      )
    ).toThrow('duplicate-key')
    expect(() =>
      validateInnoReleasePayloadForProducer(
        Buffer.from(JSON.stringify({ ...value, product: 'other-product' })),
        'stable'
      )
    ).toThrow('payload-value')
    expect(() =>
      validateInnoReleasePayloadForProducer(
        Buffer.from(JSON.stringify({ ...value, expiresAt: Date.now() - 1 })),
        'stable'
      )
    ).toThrow('release-time')
    expect(() => validateInnoReleasePayloadForProducer(Buffer.alloc(INNO_METADATA_LIMIT + 1), 'stable')).toThrow(
      'metadata-limit'
    )
  })

  it('verifies P-256 IEEE-P1363 signatures and the standard CNG ECS1 root fingerprint', () => {
    const release = verified()
    expect(release.payload.installer.sha256).toBe(digest(installer))
    expect(release.keyId).toBe(keyId)
    expect(Object.isFrozen(release.payload.installer)).toBe(true)
    expect(innoUpdateIndexUrl(trust, 'stable').href).toBe(`${INNO_UPDATE_FEED}/channels/stable/latest.json`)
    expect(innoInstallerUrl(trust, release).href).toBe(`${INNO_UPDATE_FEED}/2/Youtab-Setup.exe`)
    expect(() => innoInstallerUrl(trust, JSON.parse(JSON.stringify(release)))).toThrow(/unauthenticated/)
  })

  it('refuses tampered bytes, another key, DER signatures and unsigned algorithm or URL fields', () => {
    const valid = JSON.parse(envelope().toString())

    const changed = {
      ...valid,
      payload: Buffer.from(JSON.stringify(payload({ version: 'tampered' }))).toString('base64url')
    }

    expect(() => verifyInnoReleaseEnvelope(Buffer.from(JSON.stringify(changed)), trust, { channel: 'stable' })).toThrow(
      /signature/
    )
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const bytes = Buffer.from(valid.payload, 'base64url')

    for (const signature of [
      sign('sha256', bytes, { key: other.privateKey, dsaEncoding: 'ieee-p1363' }),
      sign('sha256', bytes, pair.privateKey)
    ]) {
      expect(() =>
        verifyInnoReleaseEnvelope(
          Buffer.from(JSON.stringify({ ...valid, signature: signature.toString('base64url') })),
          trust,
          { channel: 'stable' }
        )
      ).toThrow()
    }

    for (const extra of [{ alg: 'none' }, { url: 'https://attacker.invalid/update.exe' }]) {
      expect(() =>
        verifyInnoReleaseEnvelope(Buffer.from(JSON.stringify({ ...valid, ...extra })), trust, { channel: 'stable' })
      ).toThrow(/schema/)
    }
  })

  it.each([
    { protocol: 2 },
    { keyId: '0'.repeat(64) },
    { publicKey: { ...publicKey, d: 'private' } },
    { publicKey: { ...publicKey, crv: 'P-384' } },
    { publicKey: { ...publicKey, x: jwk.x! + '=' } },
    { publicKey: { ...publicKey, x: 'A'.repeat(43), y: 'A'.repeat(43) } },
    { feedBaseUrl: INNO_UPDATE_FEED + '?token=private' },
    { feedBaseUrl: INNO_UPDATE_FEED.replace('https:', 'http:') },
    { feedBaseUrl: INNO_UPDATE_FEED.replace('api.youtab.io', 'api.youtab.io:443') },
    { feedBaseUrl: INNO_UPDATE_FEED.replace('api.youtab.io', 'api.youtab.io.attacker.invalid') },
    { sequence: 0 },
    { sequence: '1' },
    { privateKey: 'must never be a public root' }
  ])('rejects an altered trust root %j', change => {
    expect(() => validateInnoUpdateTrustRoot({ ...trust, ...change })).toThrow()
  })

  it.each([
    { product: 'other' },
    { format: 'tauri/v1' },
    { platform: 'linux' },
    { arch: 'arm64' },
    { dataSchema: 2 },
    { channel: 'pilot' },
    { sequence: '2' },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { buildId: 'bad' },
    { sourceSha: 'bad' },
    { payloadManifestSha256: 'bad' },
    { version: '../escape' },
    { installer: { fileName: '../Youtab-Setup.exe', sha256: digest(installer), size: installer.length } },
    { installer: { fileName: 'Youtab-Setup.exe', sha256: 'bad', size: installer.length } },
    { installer: { fileName: 'Youtab-Setup.exe', sha256: digest(installer), size: 0 } },
    { installer: { fileName: 'Youtab-Setup.exe', sha256: digest(installer), size: INNO_INSTALLER_LIMIT + 1 } },
    { createdAt: 'today' },
    { createdAt: Date.now() + 3600_000 },
    { expiresAt: Date.now() - 1 },
    { artifactUrl: 'https://attacker.invalid/payload' }
  ])('refuses even a valid signature over invalid release fields %j', change => {
    expect(() =>
      verifyInnoReleaseEnvelope(envelope({ ...payload(), ...change }), trust, { channel: 'stable' })
    ).toThrow()
  })

  it('rejects duplicate JSON keys, malformed UTF-8, noncanonical base64 and oversized envelopes', () => {
    const value = payload()
    expect(() =>
      verifyInnoReleaseEnvelope(
        envelope(value, JSON.stringify(value).replace('"sequence":2', '"sequence":1,"sequence":2')),
        trust,
        { channel: 'stable' }
      )
    ).toThrow(/duplicate/)
    expect(() => verifyInnoReleaseEnvelope(Buffer.from([0xff]), trust, { channel: 'stable' })).toThrow(/utf8/)
    const encoded = JSON.parse(envelope(value).toString())
    encoded.payload += '='
    expect(() => verifyInnoReleaseEnvelope(Buffer.from(JSON.stringify(encoded)), trust, { channel: 'stable' })).toThrow(
      /base64/
    )
    expect(() =>
      verifyInnoReleaseEnvelope(Buffer.alloc(INNO_METADATA_LIMIT + 1), trust, { channel: 'stable' })
    ).toThrow(/limit/)
  })

  it('never lowers the embedded floor and requires exact identity for an equal sequence', () => {
    const current = payload({ sequence: 1, buildId: trust.buildId })
    const bytes = envelope(current)
    expect(() => verifyInnoReleaseEnvelope(bytes, trust, { channel: 'stable' })).toThrow(/sequence-proof/)
    const floor = { sequence: 1, buildId: trust.buildId, installerSha256: digest(installer) }
    const accepted = verifyInnoReleaseEnvelope(bytes, trust, { channel: 'stable', floor })
    const pinned = { ...floor, payloadSha256: accepted.payloadSha256 }
    expect(verifyInnoReleaseEnvelope(bytes, trust, { channel: 'stable', floor: pinned }).payloadSha256).toBe(
      accepted.payloadSha256
    )
    const reissued = envelope({ ...current, expiresAt: current.expiresAt + 1000 })
    expect(verifyInnoReleaseEnvelope(reissued, trust, { channel: 'stable', floor }).payloadSha256).not.toBe(
      accepted.payloadSha256
    )
    expect(() => verifyInnoReleaseEnvelope(reissued, trust, { channel: 'stable', floor: pinned })).toThrow(
      /sequence-content/
    )
    expect(() =>
      verifyInnoReleaseEnvelope(envelope({ ...current, buildId: 'f'.repeat(64) }), trust, { channel: 'stable', floor })
    ).toThrow(/sequence-identity/)
    expect(() =>
      verifyInnoReleaseEnvelope(bytes, trust, { channel: 'stable', floor: { sequence: 2, buildId: 'b'.repeat(64) } })
    ).toThrow(/rollback/)
    expect(() =>
      verifyInnoReleaseEnvelope(bytes, trust, { channel: 'stable', floor: { sequence: 0, buildId: trust.buildId } })
    ).toThrow(/floor/)
    expect(() =>
      verifyInnoReleaseEnvelope(bytes, trust, {
        channel: 'stable',
        floor: { ...floor, installerSha256: 'f'.repeat(64) }
      })
    ).toThrow(/sequence-proof/)
  })
})

describe('bounded online and offline installer transfer', () => {
  it('fetches only the pinned channel URL and streams exact signed bytes into an exclusive file', async () => {
    const data = envelope()
    const seen: string[] = []

    const fake: InnoHttpsTransport = async url => {
      seen.push(url.href)

      return response([url.pathname.endsWith('.json') ? data : installer], {
        headers: { 'content-length': String(url.pathname.endsWith('.json') ? data.length : installer.length) }
      })
    }

    const release = await fetchInnoRelease(trust, { channel: 'stable', testTransport: fake })
    const directory = temporary()
    const admitted = await downloadInnoInstaller(release, trust, directory, { testTransport: fake })
    expect(fs.readFileSync(admitted.filePath)).toEqual(installer)
    expect(admitted.sha256).toBe(digest(installer))
    expect(seen).toEqual([`${INNO_UPDATE_FEED}/channels/stable/latest.json`, `${INNO_UPDATE_FEED}/2/Youtab-Setup.exe`])
    await expect(downloadInnoInstaller(release, trust, directory, { testTransport: fake })).rejects.toThrow(/EEXIST/)
    expect(fs.readFileSync(admitted.filePath)).toEqual(installer)
  })

  it('rejects redirects, invalid status/encoding/content-length and metadata maximum limits', async () => {
    for (const bad of [
      response([], { statusCode: 302, headers: { location: 'https://attacker.invalid' } }),
      response([], { statusCode: 500 }),
      response([], { headers: { 'content-encoding': 'gzip' } }),
      response([], { headers: { 'content-length': String(INNO_METADATA_LIMIT + 1) } }),
      response([Buffer.from('{}')], { headers: { 'content-length': '20' } }),
      response([Buffer.alloc(INNO_METADATA_LIMIT), Buffer.from('x')])
    ]) {
      await expect(fetchInnoRelease(trust, { channel: 'stable', testTransport: async () => bad })).rejects.toThrow()
      expect(bad.close).toHaveBeenCalled()
    }
  })

  it('rejects partial, oversized and tampered installers and removes only its partial file', async () => {
    const release = verified()

    for (const body of [[installer.subarray(0, 5)], [installer, Buffer.from('x')], [Buffer.alloc(installer.length)]]) {
      const directory = temporary()
      await expect(
        downloadInnoInstaller(release, trust, directory, { testTransport: async () => response(body) })
      ).rejects.toThrow(/installer/)
      expect(fs.existsSync(path.join(directory, 'Youtab-Setup.exe'))).toBe(false)
    }

    await expect(
      downloadInnoInstaller(release, trust, temporary(), {
        testTransport: async () =>
          response([installer], { headers: { 'content-length': String(installer.length + 1) } })
      })
    ).rejects.toThrow(/content-length/)
  })

  it('interrupts blocked streaming on cancellation and timeout without a complete EXE buffer', async () => {
    const release = verified()
    const controller = new AbortController()
    const directory = temporary()
    const never = new Promise<IteratorResult<Uint8Array>>(() => undefined)
    const stalled = () => response({ [Symbol.asyncIterator]: () => ({ next: () => never }) })

    const cancel = downloadInnoInstaller(release, trust, directory, {
      signal: controller.signal,
      testTransport: async () => stalled()
    })

    setTimeout(() => controller.abort(), 30)
    await expect(cancel).rejects.toThrow(/cancelled/)
    expect(fs.existsSync(path.join(directory, 'Youtab-Setup.exe'))).toBe(false)
    await expect(
      downloadInnoInstaller(release, trust, temporary(), { timeoutMs: 30, testTransport: async () => stalled() })
    ).rejects.toThrow(/timeout/)
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      admitOfflineInnoInstaller('file:///untrusted.exe', release, temporary(), { signal: aborted.signal })
    ).rejects.toThrow(/cancelled/)
  })

  it('uses the same signed digest for offline admission and refuses URLs, traversal, renamed files and link ancestors', async () => {
    const release = verified()
    const sourceDirectory = temporary()
    const destination = temporary()
    const source = path.join(sourceDirectory, 'Youtab-Setup.exe')
    fs.writeFileSync(source, installer)
    const result = await admitOfflineInnoInstaller(source, release, destination)
    expect(fs.readFileSync(result.filePath)).toEqual(installer)
    expect(fs.readFileSync(source)).toEqual(installer)

    for (const input of [
      'https://attacker.invalid/Youtab-Setup.exe',
      'file:///Youtab-Setup.exe',
      path.join(sourceDirectory, 'other.exe'),
      sourceDirectory + '/../Youtab-Setup.exe'
    ]) {
      await expect(admitOfflineInnoInstaller(input, release, temporary())).rejects.toThrow()
    }

    const linkedRoot = temporary()
    const link = path.join(linkedRoot, 'linked')
    fs.symlinkSync(sourceDirectory, link, 'junction')
    await expect(admitOfflineInnoInstaller(path.join(link, 'Youtab-Setup.exe'), release, temporary())).rejects.toThrow(
      /reparse/
    )
    await expect(
      downloadInnoInstaller(release, trust, link, { testTransport: async () => response([installer]) })
    ).rejects.toThrow(/reparse/)
    await expect(
      downloadInnoInstaller(release, trust, destination + '/../escape', {
        testTransport: async () => response([installer])
      })
    ).rejects.toThrow(/local-path/)
  })

  it('does not admit a test transport in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await expect(
      fetchInnoRelease(trust, { channel: 'stable', testTransport: async () => response([]) })
    ).rejects.toThrow(/test-transport/)
  })

  it('keeps certificate verification enabled and refuses an actual untrusted loopback TLS server', async () => {
    const server = https.createServer({ key: TLS_TEST_KEY, cert: TLS_TEST_CERT }, (_request, reply) =>
      reply.end(envelope())
    )

    server.on('tlsClientError', () => undefined)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()

    if (!address || typeof address === 'string') {throw new Error('TLS test listener unavailable')}
    const get = https.get.bind(https)

    const spy = vi.spyOn(https, 'get').mockImplementation(((
      url: URL,
      options: https.RequestOptions,
      callback: (reply: IncomingMessage) => void
    ) => {
      expect(url.href).toBe(`${INNO_UPDATE_FEED}/channels/stable/latest.json`)
      expect(options.rejectUnauthorized).toBe(true)
      expect(options.agent).toBe(false)
      expect(options.minVersion).toBe('TLSv1.2')
      expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-session-token')

      return get(`https://127.0.0.1:${address.port}`, { ...options, servername: 'api.youtab.io' }, callback)
    }) as typeof https.get)

    try {
      await expect(fetchInnoRelease(trust, { channel: 'stable', timeoutMs: 2000, bearerToken: 'test-session-token' })).rejects.toThrow(
        /certificate|self.signed/i
      )
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// Public, synthetic TLS fixture only. Never a signing key or product credential.
const TLS_TEST_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgt7zhlHziGlUyXdMR\n4eeDKeJJQiradhGQ3pkgxp4MCbihRANCAATdpDObdcCjkCiVOno1dTHi80Ne2xMs\n6xmraHQq8/Rpz5BxTK5OiJK+i2J5iuUKkulMWPTY7Drf4XrcQPZTTZm6\n-----END PRIVATE KEY-----\n'

const TLS_TEST_CERT =
  '-----BEGIN CERTIFICATE-----\nMIIBhDCCASugAwIBAgIUPp1FW2iw+v0pWjOqtZrZLnPNTwMwCgYIKoZIzj0EAwIw\nGDEWMBQGA1UEAwwNYXBpLnlvdXRhYi5pbzAeFw0yNjEwMjAxMjI1MDdaFw0yNjEw\nMjExMjI1MDdaMBgxFjAUBgNVBAMMDWFwaS55b3V0YWIuaW8wWTATBgcqhkjOPQIB\nBggqhkjOPQMBBwNCAATdpDObdcCjkCiVOno1dTHi80Ne2xMs6xmraHQq8/Rpz5Bx\nTK5OiJK+i2J5iuUKkulMWPTY7Drf4XrcQPZTTZm6o1MwUTAdBgNVHQ4EFgQUEzo8\nA3W7ZyOj3Gmc68/d8NYzjuYwHwYDVR0jBBgwFoAUEzo8A3W7ZyOj3Gmc68/d8NYz\njuYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiB3NSaQPRU5iRjE\nrsh00mc8PrLYPBZlmJUM0yU1GTq11AIgMepGzCxE1HbOZjHcSyF/Z4D/ooQxqWoV\n+MR+j4/5cB4=\n-----END CERTIFICATE-----\n'
