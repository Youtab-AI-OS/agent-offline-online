import { describe, expect, it } from 'vitest'

import { modePref } from './context'
import { DEFAULT_TYPOGRAPHY, youtabTheme } from './presets'

// Approved Desktop visual palette; retain the existing font and mode contracts.
describe('approved Runtime visual tokens: default youtab skin', () => {
  it('dark palette uses warm text, sage events and restrained gold', () => {
    const d = youtabTheme.darkColors!
    expect(d.mutedForeground).toBe('#92A89D')
    expect(d.background).toBe('#041C1C') // web --background-base
    expect(d.foreground).toBe('#EEE9DF') // web --midground-base (cream)
    expect(d.primary).toBe('#D9B574') // web --color-primary (= midground)
    expect(d.primaryForeground).toBe('#041C1C') // web --color-primary-foreground
    expect(d.ring).toBe('#D9B574')
    expect(d.midground).toBe('#D9B574')
    expect(d.destructive).toBe('#FB2C36') // web --color-destructive
    // borders/inputs are cream at 15% like the web tokens
    expect(d.border).toContain('#EEE9DF')
    expect(d.input).toContain('#EEE9DF')
  })

  it('uses the Web Platform font stacks and does not network-load a mono face', () => {
    // Web --theme-font-sans / --theme-font-mono lead the stack.
    expect(DEFAULT_TYPOGRAPHY.fontSans.startsWith('system-ui')).toBe(true)
    expect(DEFAULT_TYPOGRAPHY.fontMono.startsWith('ui-monospace')).toBe(true)
    expect(youtabTheme.typography?.fontUrl).toBeUndefined()
  })

  it('defaults to dark mode so a fresh install opens in the teal look', () => {
    // No persisted value → normalizeMode fallback resolves to 'dark'.
    expect(modePref.resolve('__parity_probe_no_such_profile__')).toBe('dark')
  })
})
