import { normalizeRemoteBaseUrl, requireNativePortalAuthority } from './connection-config'
import { nativeRefreshUrl, type NativeTokenSet } from './native-oauth'
import { requireOAuthRequestTarget } from './oauth-net-request'

export function selectNativeGatewayAuthority(baseUrl: string) {
  return normalizeRemoteBaseUrl(requireOAuthRequestTarget(baseUrl, baseUrl))
}

export function bindNativeTokens(baseUrl: string, tokens: NativeTokenSet, kind: 'portal_provider' | 'remote_gateway'): NativeTokenSet {
  const selected = selectNativeGatewayAuthority(baseUrl)
  if (kind === 'portal_provider') { requireNativePortalAuthority(selected) }
  // The app selects this binding and encrypts it with the credentials.
  return { ...tokens, authority: { kind, baseUrl: selected } }
}

export function requireStoredNativeAuthority(baseUrl: string, record: boolean | Pick<NativeTokenSet, 'authority'> | null) {
  if (!record) { return }
  try {
    const selected = selectNativeGatewayAuthority(baseUrl)
    const binding = typeof record === 'object' ? record.authority : undefined
    if (binding) {
      if (binding.baseUrl !== selected || !['remote_gateway', 'portal_provider'].includes(binding.kind)) {
        throw new Error('Native session authority changed')
      }
      if (binding.kind === 'portal_provider') { requireNativePortalAuthority(selected) }
      return selected
    }
    // Legacy Portal sessions retain identity; unbound remote sessions need reauthentication.
    return requireNativePortalAuthority(selected)
  } catch {
    throw Object.assign(new Error('Stored native login does not belong to the configured gateway authority. Sign in again in Settings / Gateway.'), { needsOauthLogin: true, noCookieFallback: true })
  }
}

export function createNativeCredentialTransport(send: (url: string, body: unknown, options: unknown) => Promise<unknown>) {
  return {
    async refresh(baseUrl: string, tokens: { refreshToken: string, provider?: string, authority?: NativeTokenSet['authority'] }) {
      const authority = requireStoredNativeAuthority(baseUrl, tokens)!
      return send(nativeRefreshUrl(authority), { refresh_token: tokens.refreshToken, provider: tokens.provider }, { timeoutMs: 10_000 })
    },
    async revoke(baseUrl: string, refreshToken: string, tokens?: Pick<NativeTokenSet, 'authority'>): Promise<void> {
      const authority = requireStoredNativeAuthority(baseUrl, tokens || true)!
      await send(`${authority}/v1/auth/logout`, { refresh_token: refreshToken }, { timeoutMs: 10_000 })
    },
  }
}