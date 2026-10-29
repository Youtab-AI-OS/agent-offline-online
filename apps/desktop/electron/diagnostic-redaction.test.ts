import { describe, expect, it } from 'vitest'

import { redactDiagnostic } from '../src/lib/diagnostic-redaction'

describe('diagnostic redaction', () => {
  it('does not leak members of structured credential values', () => {
    const safe = redactDiagnostic('{"password":{"a":"first-secret","b":["second-secret"]}}')
    expect(safe).not.toContain('first-secret')
    expect(safe).not.toContain('second-secret')
  })
  it('preserves diagnostic context while removing credential assignments and headers', () => {
    const message = 'Error EAUTH stage=download\npassword="secret with spaces" api_key=key-value\nAuthorization: Bearer bearer-value\nX-Youtab-Session-Token: session-value\n    at main.ts:42'
    const safe = redactDiagnostic(message)

    for (const secret of ['secret with spaces', 'key-value', 'bearer-value', 'session-value']) {
      expect(safe).not.toContain(secret)
    }

    expect(safe).toContain('Error EAUTH stage=download')
    expect(safe).toContain('at main.ts:42')
  })

  it('removes URL credentials, query credentials and JSON OAuth tokens', () => {
    const safe = redactDiagnostic('https://alice:uri-secret@example.com/a?access_token=query-secret&x=1 {"refresh_token":"json-secret"}')
    expect(safe).not.toContain('uri-secret')
    expect(safe).not.toContain('query-secret')
    expect(safe).not.toContain('json-secret')
    expect(safe).toContain('example.com/a')
    expect(safe).toContain('&x=1')
  })

  it('removes configured credentials appearing without a field name', () => {
    expect(redactDiagnostic('failed: opaque-secret', { PROVIDER_API_KEY: 'opaque-secret' })).toBe('failed: <redacted>')
    expect(redactDiagnostic('stage=download', { BUILD_STAGE: 'download' })).toBe('stage=download')
  })

  it('removes private keys and escapes terminal and bidi controls', () => {
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
    const safe = redactDiagnostic(`${header}\nkey-material\n-----END PRIVATE KEY-----\nError\u001b[31m\u202e at main`)
    expect(safe).not.toContain('key-material')
    expect(safe).toContain('\\u001b')
    expect(safe).toContain('\\u202e')
    expect(safe).toContain('\nError')
  })
})


describe('credential header coverage', () => {
  it.each(['Cookie', 'Set-Cookie', 'Authorization', 'Proxy-Authorization'])('redacts complete %s header values and folded lines', header => {
    const text = `Error EAUTH\n${header}: Digest SYNTHETIC_HEADER; id=SYNTHETIC_ATTRIBUTE\n\tSYNTHETIC_FOLDED\nError HTTP503\n    at main.ts:42`
    const safe = redactDiagnostic(text)

    for (const value of ['SYNTHETIC_HEADER', 'SYNTHETIC_ATTRIBUTE', 'SYNTHETIC_FOLDED']) { expect(safe).not.toContain(value) }
    expect(safe).toContain('Error EAUTH')
    expect(safe).toContain('Error HTTP503\n    at main.ts:42')
  })
  it('redacts signed query URLs while preserving noncredential parameters', () => {
    expect(redactDiagnostic('https://example.invalid/?sig=SYNTHETIC_SIGNATURE&stage=download')).toBe('https://example.invalid/?sig=<redacted>&stage=download')
  })
})


it('omits direct unbounded header records instead of leaking a later line', () => {
  for (const text of ['Authorization:\nSYNTHETIC_HEADER_TAIL', 'Cookie: "SYNTHETIC_FIRST\nSYNTHETIC_LAST"']) {
    expect(redactDiagnostic(text)).not.toMatch(/SYNTHETIC_/)
  }
})

it('keeps a quoted header boundary explicit without constructing a pattern from diagnostics', () => {
  expect(redactDiagnostic('Cookie: "SYNTHETIC_SECRET\\"\nSYNTHETIC_TAIL'))
    .toBe('[redacted unbounded credential header diagnostic]')
  expect(redactDiagnostic('Cookie: "SYNTHETIC_SECRET"\nError EAUTH'))
    .toContain('Error EAUTH')
})


it.each(['{"Cookie"\n: "SYNTHETIC_SPLIT_HEADER"}', 'Authorization\n: Digest SYNTHETIC_SPLIT_HEADER', 'Proxy-Authorization\r\n\t= Custom SYNTHETIC_SPLIT_HEADER'])('omits headers with multiline whitespace before their delimiter: %s', text => {
  expect(redactDiagnostic(text)).not.toContain('SYNTHETIC_SPLIT_HEADER')
})
