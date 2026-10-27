/** Sanitize diagnostics before they enter a log or a renderer error message. */
export function redactDiagnostic(text: unknown, environment: Record<string, string | undefined> = {}): string {
  let out = String(text ?? '')

  // A structured credential can contain commas, nesting and arbitrary names.
  // Keep it out as one record rather than partially masking its first member.
  if (/[\w-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)[\w-]*["']?\s*[:=]\s*[[{]/i.test(out)) {
    return '[redacted structured credential diagnostic]'
  }

  // A sensitive field name can be separated from its delimiter by newlines
  // (including pretty JSON). Do not guess the end of that credential record.
  if (/\b(?:Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?[^\S\r\n]*[\r\n]\s*[:=]/i.test(out)) {
    return '[redacted unbounded credential header diagnostic]'
  }

  // An empty header or an unterminated quoted header may continue without
  // indentation. Its end is untrustworthy, so omit the complete diagnostic.
  if (/\b(?:Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?\s*[:=][ \t]*["']?[ \t]*\r?\n/i.test(out)) {
    return '[redacted unbounded credential header diagnostic]'
  }

  for (const line of out.split(/\r?\n/)) {
    const quotedHeader = /\b(?:Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?\s*[:=][ \t]*(["'])(.*)$/i.exec(line)
    const value = quotedHeader?.[2] ?? ''
    const quote = quotedHeader?.[1]
    let hasClosingQuote = false

    for (let index = 0; quote && index < value.length; index++) {
      if (value[index] === quote && (index === 0 || value[index - 1] !== '\\')) {
        hasClosingQuote = true

        break
      }
    }

    if (quotedHeader && !hasClosingQuote) {
      return '[redacted unbounded credential header diagnostic]'
    }
  }

  for (const [name, value] of Object.entries(environment)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name) && value && value.length >= 4) {
      out = out.split(value).join('<redacted>')
    }
  }

  return out
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<redacted private key>')
    .replace(/(https?:\/\/|wss?:\/\/)([^\s/@]+@)/gi, '$1<redacted>@')
    // Header schemes and cookie attributes are all credential-bearing. Folded
    // continuation lines have no independently trustworthy secret boundary.
    .replace(/(\b(?:Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?\s*[:=][ \t]*["']?)([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/gi, (_match, prefix: string, value: string) => {
      const scheme = /^(Bearer|Basic)[ \t]+/i.exec(value)

      return `${prefix}${scheme ? `${scheme[1]} ` : ''}<redacted>`
    })
    .replace(/([?&](?:token|ticket|access_token|refresh_token|api_key|key|password|secret|signature|sig)=)[^\s&"']+/gi, '$1<redacted>')
    .replace(/((?:[\w-]*(?:token|ticket|secret|password|passwd|api[_-]?key|private[_-]?key|credential)[\w-]*)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\]}&]+)/gi, '$1<redacted>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '<redacted>')
    // Keep stack newlines, but make terminal controls and bidi overrides visible.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
