import { once } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { redactDiagnostic } from '../src/lib/diagnostic-redaction'

import { attachDiagnosticStream } from './diagnostic-stream'

const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')

describe('diagnostic child streams', () => {
  it('omits a structured credential whose value starts after a newline', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)))
    const complete = once(stream, 'end')
    stream.end('{"password":\n {"a":"nested-secret"}\n}\n')
    await complete
    expect(logs.join('\n')).not.toContain('nested-secret')
  })
  it('fails closed on a multiline credential object without leaking unnamed members', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)))
    const complete = once(stream, 'end')
    stream.end('{"password": {\n"a":"nested-first",\n"b":"nested-second"\n}}\n')
    await complete
    expect(logs.join('\n')).not.toContain('nested-first')
    expect(logs.join('\n')).not.toContain('nested-second')
    expect(logs.every(line => line === '[unbounded structured credential diagnostic omitted]')).toBe(true)
  })
  it('omits the pipe after a multiline credential rather than guess closing/new opener boundaries', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)))
    const complete = once(stream, 'end')
    stream.end('password="first-secret\nends" password="second-secret\nremaining-secret"\nsafe\n')
    await complete
    expect(logs.join('\n')).not.toContain('first-secret')
    expect(logs.join('\n')).not.toContain('second-secret')
    expect(logs.join('\n')).not.toContain('remaining-secret')
    expect(logs.every(line => line === '[unbounded structured credential diagnostic omitted]')).toBe(true)
  })
  it('redacts credentials and PEM material split across transport chunks', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)))
    const complete = once(stream, 'end')
    const message = `password=split-secret\n${privateKeyHeader}\nprivate-material\n-----END PRIVATE KEY-----\nsafe فارسی\n`
    for (const byte of Buffer.from(message)) { stream.write(Buffer.from([byte])) }
    stream.end()
    await complete
    expect(logs.join('\n')).not.toContain('split-secret')
    expect(logs.join('\n')).not.toContain('private-material')
    expect(logs).toContain('safe فارسی')
  })

  it('fails closed after overflow, including late multiline openers in discarded chunks', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)), 32)
    const complete = once(stream, 'end')
    stream.write('x'.repeat(100))
    stream.end(` password="first-secret\nsecond-secret"\n${privateKeyHeader}\nprivate-material\n`)
    await complete
    expect(logs).toEqual(['[oversized diagnostic record; remaining pipe diagnostics omitted]'])
  })

  it('flushes a final unterminated record through redaction', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)))
    const complete = once(stream, 'end')
    stream.end('password=last-secret')
    await complete
    expect(logs).toEqual(['password=<redacted>'])
  })
})


describe('framed credential headers', () => {
  it.each(['Cookie', 'Set-Cookie', 'Authorization', 'Proxy-Authorization'])('omits folded %s values across arbitrary byte boundaries', async header => {
    const stream = new PassThrough()
    const logs: string[] = []
    attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)))
    const ended = once(stream, 'end')
    for (const byte of Buffer.from(`${header}: Custom SYNTHETIC_HEADER\r\n\tSYNTHETIC_CONTINUATION\r\nError HTTP503\n    at main.ts:42\n`)) { stream.write(Buffer.from([byte])) }
    stream.end()
    await ended
    expect(logs.join('\n')).not.toContain('SYNTHETIC_HEADER')
    expect(logs.join('\n')).not.toContain('SYNTHETIC_CONTINUATION')
    expect(logs).toContain('Error HTTP503')
    expect(logs).toContain('    at main.ts:42')
  })
  it('fails closed when a credential header value starts on the next line', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)))
    const ended = once(stream, 'end')
    stream.end('Authorization:\nSYNTHETIC_NEXT_LINE\n')
    await ended
    expect(logs.join('\n')).not.toContain('SYNTHETIC_NEXT_LINE')
  })
})


it.each(['{"Cookie"\n: "SYNTHETIC_SPLIT_HEADER"}', 'Authorization\n: Digest SYNTHETIC_SPLIT_HEADER', 'Proxy-Authorization\r\n\t= Custom SYNTHETIC_SPLIT_HEADER'])('keeps unresolved credential keys fail-closed across framed records: %s', async text => {
  const stream = new PassThrough()
  const logs: string[] = []
  attachDiagnosticStream(stream, line => logs.push(redactDiagnostic(line)))
  const ended = once(stream, 'end')
  for (const byte of Buffer.from(text)) { stream.write(Buffer.from([byte])) }
  stream.end()
  await ended
  expect(logs.join('\n')).not.toContain('SYNTHETIC_SPLIT_HEADER')
  expect(logs).toContain('[unbounded structured credential diagnostic omitted]')
})
