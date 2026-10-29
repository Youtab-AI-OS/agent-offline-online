import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type * as I18n from '@/i18n'
import { $backdropOpacity, setBackdrop, setBackdropOpacity } from '@/store/backdrop'

import { AppearanceSettings } from './appearance-settings'

const theme = vi.hoisted(() => ({ setMode: vi.fn(), setTheme: vi.fn() }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => <span>Language control</span> }))
vi.mock('@/themes/context', () => ({
  getBaseColors: () => ({ background: '#fff', foreground: '#111', muted: '#eee', border: '#aaa' }),
  useTheme: () => ({
    themeName: 'test-theme', mode: 'dark', resolvedMode: 'dark',
    availableThemes: [{ name: 'test-theme', label: 'Test theme', description: 'Theme test fixture' }],
    setMode: theme.setMode, setTheme: theme.setTheme
  })
}))
vi.mock('@/themes/user-themes', async () => {
  const { atom } = await import('nanostores')

  return { $marketplaceInstalls: atom(new Map()), isUserTheme: () => false, removeUserTheme: vi.fn() }
})
vi.mock('./pet-settings', () => ({
  PetSettings: function PetControls() {
    const [count, setCount] = useState(0)

    return <button onClick={() => setCount(value => value + 1)} type="button">Pet state {count}</button>
  }
}))
vi.mock('@/i18n', async importOriginal => {
  const original = await importOriginal<typeof I18n>()
  const base = original.useI18n

  return {
    ...original,
    useI18n: () => {
      const result = base()

      return {
        ...result,
        t: { ...result.t, settings: { ...result.t.settings, appearance: {
          ...result.t.settings.appearance,
          backdropOpacityTitle: 'Chat background opacity',
          backdropOpacityDesc: 'Adjust only the main Runtime background image.'
        } } }
      }
    }
  }
})

beforeEach(() => {
  setBackdrop(true)
  setBackdropOpacity(10)
  vi.clearAllMocks()
})
afterEach(cleanup)

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AppearanceSettings />
  </QueryClientProvider>)
}

it('keeps every Theme and Pet control mounted inside collapsed native disclosures', () => {
  const { container } = mount()
  const themeDisclosure = container.querySelector<HTMLDetailsElement>('details.group\\/theme')!
  const petDisclosure = container.querySelector<HTMLDetailsElement>('details.group\\/pet')!

  expect(themeDisclosure.open).toBe(false)
  expect(petDisclosure.open).toBe(false)
  fireEvent.click(themeDisclosure.querySelector('summary')!)
  expect(themeDisclosure.open).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Light' }))
  expect(theme.setMode).toHaveBeenCalledWith('light')
  fireEvent.click(screen.getByRole('button', { name: /Test theme/ }))
  expect(theme.setTheme).toHaveBeenCalledWith('test-theme')
  const search = themeDisclosure.querySelector<HTMLInputElement>('input')!

  fireEvent.change(search, { target: { value: 'retained theme filter' } })
  fireEvent.click(themeDisclosure.querySelector('summary')!)
  fireEvent.click(themeDisclosure.querySelector('summary')!)
  expect(search.value).toBe('retained theme filter')
  fireEvent.click(petDisclosure.querySelector('summary')!)
  fireEvent.click(screen.getByRole('button', { name: 'Pet state 0' }))
  fireEvent.click(petDisclosure.querySelector('summary')!)
  fireEvent.click(petDisclosure.querySelector('summary')!)
  expect(screen.getByRole('button', { name: 'Pet state 1' })).toBeTruthy()
})

it('keeps the slider and numeric opacity field synchronized without affecting window translucency', () => {
  mount()
  const range = screen.getByRole('slider', { name: 'Chat background opacity' }) as HTMLInputElement
  const numeric = screen.getByRole('spinbutton', { name: 'Chat background opacity' }) as HTMLInputElement
  const translucency = screen.getByRole('slider', { name: 'Window Translucency' }) as HTMLInputElement
  const originalTranslucency = translucency.value

  fireEvent.change(range, { target: { value: '32' } })
  expect(numeric.value).toBe('32')
  expect($backdropOpacity.get()).toBe(32)
  fireEvent.change(numeric, { target: { value: '74' } })
  expect(range.value).toBe('74')
  expect(translucency.value).toBe(originalTranslucency)
  act(() => setBackdrop(false))
  expect(range.disabled).toBe(true)
  expect(numeric.disabled).toBe(true)
  expect($backdropOpacity.get()).toBe(74)
})
