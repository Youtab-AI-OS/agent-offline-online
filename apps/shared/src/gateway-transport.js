/** Require encryption for direct gateway connections; SSH forwards terminate on loopback. */
export function requireGatewayTransport(rawUrl, transport) {
  const url = new URL(rawUrl)
  const secure = transport === 'http' ? 'https:' : 'wss:'
  const local = transport === 'http' ? 'http:' : 'ws:'
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (url.username || url.password || (url.protocol !== secure && !(url.protocol === local && loopback))) {
    throw new Error(`Direct remote gateway connections require ${secure}//; unencrypted ${local}// is allowed only on loopback.`)
  }
  return url
}
