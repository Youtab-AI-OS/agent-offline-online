import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $desktopOnboarding, type DesktopOnboardingState, type OnboardingContext } from '@/store/onboarding'
import type { OAuthProvider } from '@/types/youtab'

import { FlowPanel } from './flow'

import { DesktopOnboardingOverlay, Picker } from '.'

const originalDesktopBridge = Object.getOwnPropertyDescriptor(window, 'youtabDesktop')

function provider(id: string, name = id): OAuthProvider {
  return {
    cli_command: `youtab login ${id}`,
    docs_url: `https://example.com/${id}`,
    flow: 'pkce',
    id,
    name,
    status: { logged_in: false }
  }
}

function setProviders(providers: OAuthProvider[]) {
  $desktopOnboarding.set({
    configured: false,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  } satisfies DesktopOnboardingState)
}

const ctx: OnboardingContext = { requestGateway: async () => undefined as never }

afterEach(() => {
  cleanup()

  if (originalDesktopBridge) {
    Object.defineProperty(window, 'youtabDesktop', originalDesktopBridge)
  } else {
    Reflect.deleteProperty(window, 'youtabDesktop')
  }

  try {
    window.localStorage.clear()
  } catch {
    // jsdom localStorage should always be present; ignore if not.
  }

  $desktopOnboarding.set({
    configured: null,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  })
})

describe('onboarding Picker', () => {
  it('features Youtab Portal and hides other providers behind a disclosure', () => {
    setProviders([provider('anthropic', 'Anthropic Claude'), provider('youtab', 'Youtab Portal')])
    render(<Picker ctx={ctx} />)

    expect(screen.getByText('Youtab Portal')).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    // Fireworks is the always-visible #2 slot (after Youtab), even while OAuth
    // alternatives stay collapsed behind the disclosure.
    expect(screen.getByText('Fireworks AI')).toBeTruthy()
    expect(screen.queryByText('Anthropic API Key')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Other providers' }))

    expect(screen.getByText('Anthropic API Key')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeTruthy()
  })

  it('shows Fireworks in slot #2 ahead of other OAuth providers', () => {
    setProviders([
      provider('openai-codex', 'OpenAI Codex / ChatGPT'),
      provider('minimax-oauth', 'MiniMax'),
      provider('youtab', 'Youtab Portal')
    ])
    render(<Picker ctx={ctx} />)
    fireEvent.click(screen.getByRole('button', { name: 'Other providers' }))

    const labels = screen
      .getAllByRole('button')
      .map(el => el.textContent ?? '')
      .filter(text => /Youtab Portal|Fireworks AI|OpenAI OAuth|MiniMax|OpenRouter/.test(text))

    const indexOf = (needle: string) => labels.findIndex(text => text.includes(needle))
    expect(indexOf('Youtab Portal')).toBeGreaterThanOrEqual(0)
    expect(indexOf('Fireworks AI')).toBeGreaterThan(indexOf('Youtab Portal'))
    expect(indexOf('OpenAI OAuth')).toBeGreaterThan(indexOf('Fireworks AI'))
    expect(indexOf('MiniMax')).toBeGreaterThan(indexOf('OpenAI OAuth'))
  })

  it('shows every provider directly when Youtab Portal is absent', () => {
    setProviders([provider('anthropic', 'Anthropic Claude'), provider('openai-codex', 'OpenAI Codex / ChatGPT')])
    render(<Picker ctx={ctx} />)

    expect(screen.getByText('Fireworks AI')).toBeTruthy()
    expect(screen.getByText('Anthropic API Key')).toBeTruthy()
    expect(screen.getByText('OpenAI OAuth (ChatGPT)')).toBeTruthy()
    expect(screen.queryByText('Other sign-in options')).toBeNull()
    expect(screen.queryByText('Recommended')).toBeNull()
  })

  it('offers "choose later" on first run and persists the skip', () => {
    setProviders([provider('youtab', 'Youtab Portal')])
    render(<Picker ctx={ctx} />)

    const skip = screen.getByRole('button', { name: "I'll choose a provider later" })

    fireEvent.click(skip)

    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect(window.localStorage.getItem('youtab-onboarding-skipped-v1')).toBe('1')
  })

  it('hides "choose later" in manual (add-provider) mode', () => {
    setProviders([provider('youtab', 'Youtab Portal')])
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), manual: true })
    render(<Picker ctx={ctx} />)

    expect(screen.queryByRole('button', { name: "I'll choose a provider later" })).toBeNull()
  })

  it('opens the local URL form directly alongside Portal and saves with an empty optional key without OAuth', async () => {
    const nativeLogin = vi.fn()

    const api = vi.fn().mockImplementation(async (request: { path: string }) => {
      if (request.path.startsWith('/api/model/options')) {
        return { providers: [] }
      }

      if (request.path === '/api/providers/validate') {
        return { ok: true, reachable: true, models: ['eco-test'], base_url: 'http://127.0.0.1:63017/v1' }
      }

      if (request.path === '/api/model/set') {
        return { ok: true }
      }

      throw new Error('Unexpected account or network operation')
    })

    Object.defineProperty(window, 'youtabDesktop', {
      configurable: true,
      value: { api, oauthLoginConnectionConfig: nativeLogin }
    })

    const requestGateway = vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === 'setup.status' ? { provider_configured: true } : { ok: true }
      )

    setProviders([
      { ...provider('youtab', 'Youtab Portal'), flow: 'native_pkce', native_base_url: 'https://api.youtab.io' }
    ])
    render(<Picker ctx={{ requestGateway }} />)

    expect(screen.getByText('Youtab Portal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Local \/ custom endpoint/ }))
    const address = screen.getByLabelText('Model server address')
    const optionalKey = screen.getByPlaceholderText('API key (optional — only if your endpoint requires one)')
    expect((optionalKey as HTMLInputElement).value).toBe('')
    fireEvent.change(address, { target: { value: 'http://127.0.0.1:63017/v1' } })
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect($desktopOnboarding.get().configured).toBe(true))
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/providers/validate',
        body: { key: 'OPENAI_BASE_URL', value: 'http://127.0.0.1:63017/v1', api_key: '' }
      })
    )
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/model/set',
        body: {
          scope: 'main',
          provider: 'custom',
          model: 'eco-test',
          base_url: 'http://127.0.0.1:63017/v1',
          api_key: ''
        }
      })
    )
    expect(nativeLogin).not.toHaveBeenCalled()
    expect(api.mock.calls.some(([request]) => request.path.includes('/oauth/'))).toBe(false)
  })
})

describe('first-run provider discovery failure', () => {
  it('keeps catalog retry, local configuration and a persistent choose-later escape when discovery is unavailable', async () => {
    const nativeLogin = vi.fn()
    const api = vi.fn().mockRejectedValue(new Error('Local provider catalog unavailable'))
    Object.defineProperty(window, 'youtabDesktop', {
      configurable: true,
      value: { api, oauthLoginConnectionConfig: nativeLogin }
    })

    const requestGateway = vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === 'setup.status' ? { provider_configured: false } : { ok: false, error: 'No provider configured' }
      )

    setProviders([])
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: null, providers: null })

    const { unmount } = render(
      <DesktopOnboardingOverlay enabled={true} profile="synthetic-offline" requestGateway={requestGateway} />
    )

    await screen.findByText('Could not load sign-in providers from the local Gateway. Check the connection and retry.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByLabelText('Model server address')).toBeTruthy()
    expect(screen.getByPlaceholderText('API key (optional — only if your endpoint requires one)')).toBeTruthy()
    expect($desktopOnboarding.get().configured).toBe(false)
    expect(nativeLogin).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: "I'll choose a provider later" }))
    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect(window.localStorage.getItem('youtab-onboarding-skipped-v1')).toBe('1')
    expect(screen.queryByLabelText('Model server address')).toBeNull()

    unmount()
    render(<DesktopOnboardingOverlay enabled={true} profile="synthetic-offline" requestGateway={requestGateway} />)
    expect(screen.queryByRole('button', { name: "I'll choose a provider later" })).toBeNull()
    expect(nativeLogin).not.toHaveBeenCalled()
  })

  it('keeps a selected online provider error in its real flow instead of silently switching to local', async () => {
    const nativeLogin = vi.fn()
    Object.defineProperty(window, 'youtabDesktop', {
      configurable: true,
      value: { api: vi.fn().mockResolvedValue({ providers: [] }), oauthLoginConnectionConfig: nativeLogin }
    })

    const portal: OAuthProvider = {
      ...provider('youtab', 'Youtab Portal'),
      flow: 'native_pkce',
      native_base_url: 'https://api.youtab.io'
    }

    setProviders([portal])
    $desktopOnboarding.set({
      ...$desktopOnboarding.get(),
      flow: { status: 'error', provider: portal, message: 'Synthetic online sign-in failure' }
    })
    const requestGateway = vi.fn().mockResolvedValue({ ok: false, provider_configured: false })
    render(<DesktopOnboardingOverlay enabled={true} profile="synthetic-online" requestGateway={requestGateway} />)

    expect(screen.getByText('Synthetic online sign-in failure')).toBeTruthy()
    expect(screen.queryByLabelText('Model server address')).toBeNull()
    expect(screen.queryByRole('button', { name: "I'll choose a provider later" })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pick a different provider' }))
    expect(screen.getByRole('button', { name: /Local \/ custom endpoint/ })).toBeTruthy()
    expect(nativeLogin).not.toHaveBeenCalled()
  })
})

it('retries a failed provider catalog load without invoking a legacy sign-in flow', async () => {
  const api = vi.fn().mockResolvedValue({ providers: [provider('youtab', 'Youtab Portal')] })

  Object.defineProperty(window, 'youtabDesktop', { configurable: true, value: { api } })
  setProviders([])
  $desktopOnboarding.set({
    ...$desktopOnboarding.get(),
    flow: { status: 'error', message: 'Could not load sign-in providers. Retry.' }
  })

  render(<FlowPanel ctx={ctx} flow={$desktopOnboarding.get().flow} leaving={false} onBegin={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

  await waitFor(() => expect($desktopOnboarding.get().providers?.[0]?.id).toBe('youtab'))
  expect($desktopOnboarding.get().flow.status).toBe('idle')
  expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/providers/oauth' }))
  expect(api).toHaveBeenCalledTimes(1)
})
