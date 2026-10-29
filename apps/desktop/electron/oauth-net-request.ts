/**
 * Helpers for Electron net.request calls that ride the OAuth session partition.
 *
 * Electron's ClientRequest forbids app-set restricted headers such as
 * Content-Length. Let Chromium frame the body itself; only set the JSON content
 * type here.
 */

import { requireGatewayTransport } from '@youtab/agent-shared/gateway-transport'

function serializeJsonBody(body) {
  return body === undefined ? undefined : Buffer.from(JSON.stringify(body))
}

function setJsonRequestHeaders(request) {
  request.setHeader('Content-Type', 'application/json')
}

function containsUrlControls(value: string) {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function canonicalPath(pathname: string) {
  const components = pathname.split('/').map(component => decodeURIComponent(component))
  for (const component of components) {
    // Keep path data separate from URL syntax and preserve component boundaries.
    if (/[/?#\\]/.test(component) || containsUrlControls(component)) {
      throw new Error('OAuth request path contains ambiguous URL delimiters or controls.')
    }
  }
  return components.join('/').replace(/\/+$/, '')
}

function requireOAuthRequestTarget(baseUrl: string, targetUrl: string) {
  if (baseUrl.includes('\\') || targetUrl.includes('\\') || containsUrlControls(baseUrl) || containsUrlControls(targetUrl)) {
    throw new Error('OAuth request path contains ambiguous URL delimiters or controls.')
  }
  const base = requireGatewayTransport(baseUrl, 'http')
  const target = requireGatewayTransport(targetUrl, 'http')
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
      || target.username || target.password || target.hash || target.origin !== base.origin) {
    throw new Error('OAuth request target is outside the selected gateway authority.')
  }
  const prefix = canonicalPath(base.pathname)
  const targetPath = canonicalPath(target.pathname)
  if (prefix && targetPath !== prefix && !targetPath.startsWith(`${prefix}/`)) {
    throw new Error('OAuth request target is outside the selected gateway base path.')
  }
  return target.toString()
}

type OAuthRequest = {
  on: (event: string, handler: (...args: any[]) => void) => unknown
  setHeader: (name: string, value: string) => void
  write: (body: Buffer) => unknown
  end: () => unknown
  abort: () => unknown
  followRedirect: () => unknown
}

function requestJsonWithOAuthSession(url: string, options: {
  authorityBaseUrl: string
  session: unknown
  requestFactory: (options: any) => OAuthRequest
  method?: string
  body?: unknown
  timeoutMs: number
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let request: OAuthRequest
    try {
      url = requireOAuthRequestTarget(options.authorityBaseUrl, url)
      request = options.requestFactory({ method: options.method || 'GET', url, session: options.session,
        useSessionCookies: true, redirect: 'manual' })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    let redirects = 0
    let timer: ReturnType<typeof setTimeout>
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) { return }
      settled = true
      clearTimeout(timer)
      if (error) { reject(error) } else { resolve(value) }
    }
    const abort = (error: unknown) => {
      finish(error)
      try { request.abort() } catch { /* Already closed. */ }
    }
    timer = setTimeout(() => abort(new Error(`Timed out connecting to Youtab backend after ${options.timeoutMs}ms`)), options.timeoutMs)
    // Install before write/end: redirects cannot replay a body before policy.
    request.on('redirect', (_status, _method, redirectUrl) => {
      if (settled) { return }
      try {
        if (++redirects > 5) { throw new Error('OAuth request redirect limit exceeded.') }
        requireOAuthRequestTarget(options.authorityBaseUrl, redirectUrl)
        request.followRedirect()
      } catch (error) { abort(error) }
    })
    request.on('error', error => finish(error))
    request.on('abort', () => finish(new Error('OAuth request was aborted.')))
    request.on('response', response => {
      if (settled) { return }
      const chunks: Buffer[] = []
      response.on('data', chunk => { if (!settled) { chunks.push(Buffer.from(chunk)) } })
      response.on('error', error => finish(error))
      response.on('end', () => {
        if (settled) { return }
        const text = Buffer.concat(chunks).toString('utf8')
        const statusCode = response.statusCode || 500
        if (statusCode >= 400) {
          finish(Object.assign(new Error(`${statusCode}: ${text}`), { statusCode }))
          return
        }
        if (!text) { finish(undefined, null); return }
        const contentType = String(response.headers['content-type'] || response.headers['Content-Type'] || '')
        if (/^\s*<(?:!doctype|html)/i.test(text) || contentType.includes('text/html')) {
          finish(new Error(`Expected JSON from ${url} but got HTML (status ${statusCode}).`))
          return
        }
        try { finish(undefined, JSON.parse(text)) }
        catch { finish(new Error(`Invalid JSON from ${url} (status ${statusCode}): ${text.slice(0, 200)}`)) }
      })
    })
    try {
      setJsonRequestHeaders(request)
      const body = serializeJsonBody(options.body)
      if (body) { request.write(body) }
      request.end()
    } catch (error) { abort(error) }
  })
}

export { requestJsonWithOAuthSession, requireOAuthRequestTarget, serializeJsonBody, setJsonRequestHeaders }
