import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** Frame each child pipe before redaction: transport chunks are not log records. */
export function attachDiagnosticStream(stream: Readable, log: (line: string) => void, limit = 64 * 1024): void {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let blocked = false
  let privateKey = false
  let structuredCredential = false
  let credentialHeader = false

  const emit = () => {
    const line = pending.replace(/\r$/, '')
    // An unresolved sensitive key may receive its delimiter/value in a later
    // record. Reuse the unbounded credential state rather than guessing its end.
    if (/\b(?:Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?\s*$/i.test(line)) { structuredCredential = true }
    const foldedHeader = credentialHeader && /^[ \t]/.test(line)
    credentialHeader = foldedHeader || /\b(?:Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?[ \t]*[:=]/i.test(line)
    const startsKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)
    const endsKey = /-----END [A-Z ]*PRIVATE KEY-----/.test(line)

    if (/(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|cookie)[\w-]*["']?\s*[:=]\s*$/i.test(line)) { structuredCredential = true }

    if (/[\w-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|cookie)[\w-]*["']?\s*[:=]\s*[[{]/i.test(line)) {
      try { JSON.parse(line) } catch {
        // A partial/invalid secret-bearing structure has no trustworthy end.
        // Omit the remainder of this pipe rather than leak unnamed members.
        structuredCredential = true
      }
    }

    const opening = /[\w-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|cookie)[\w-]*["']?\s*[:=]\s*(["'])(.*)$/i.exec(line)

    if (opening && !new RegExp(`(?<!\\\\)${opening[1]}`).test(opening[2])) {
      structuredCredential = true
    }

    if (startsKey) { privateKey = true }

    if (structuredCredential) {
      log('[unbounded structured credential diagnostic omitted]')
    } else if (foldedHeader) {
      log('[redacted credential header continuation]')
    } else if (privateKey) {
      if (startsKey) { log('[redacted private key]') }
    } else {
      log(line)
    }

    if (endsKey) { privateKey = false }
    pending = ''
  }

  const consume = (text: string) => {
    if (blocked) { return }

    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const complete = part.endsWith('\n')
      const content = complete ? part.slice(0, -1) : part

      if (pending.length + content.length > limit) {
        // A discarded tail may contain an opener for a multiline secret.
        // Its boundary cannot be proven; omit this pipe until it closes.
        pending = ''
        blocked = true
        log('[oversized diagnostic record; remaining pipe diagnostics omitted]')

        return
      }

      pending += content

      if (complete) { emit() }
    }
  }

  stream.on('data', chunk => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)))
  stream.on('end', () => {
    consume(decoder.end())

    if (pending && !blocked) { emit() }
  })
}
