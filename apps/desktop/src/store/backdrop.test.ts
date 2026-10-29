import { beforeEach, describe, expect, it, vi } from 'vitest'

const OPACITY_KEY = 'youtab.desktop.backdrop-opacity.global.v1'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('Runtime background opacity preference', () => {
  it('starts at the approved ten percent without changing the existing background switch', async () => {
    const { $backdrop, $backdropOpacity } = await import('./backdrop')

    expect($backdrop.get()).toBe(true)
    expect($backdropOpacity.get()).toBe(10)
  })

  it('persists a manual value through a fresh module load and keeps it while the image is hidden', async () => {
    const preference = await import('./backdrop')

    preference.setBackdropOpacity(37)
    preference.setBackdrop(false)
    expect(localStorage.getItem(OPACITY_KEY)).toBe('37')
    vi.resetModules()

    const restored = await import('./backdrop')

    expect(restored.$backdrop.get()).toBe(false)
    expect(restored.$backdropOpacity.get()).toBe(37)
    restored.setBackdrop(true)
    expect(restored.$backdropOpacity.get()).toBe(37)
  })

  it('bounds and rounds manual values and recovers from malformed persisted values', async () => {
    const preference = await import('./backdrop')

    preference.setBackdropOpacity(110)
    expect(preference.$backdropOpacity.get()).toBe(100)
    preference.setBackdropOpacity(-8)
    expect(preference.$backdropOpacity.get()).toBe(0)
    preference.setBackdropOpacity(26.8)
    expect(preference.$backdropOpacity.get()).toBe(27)
    preference.setBackdropOpacity(Number.NaN)
    expect(preference.$backdropOpacity.get()).toBe(10)
    localStorage.setItem(OPACITY_KEY, 'invalid')
    vi.resetModules()
    expect((await import('./backdrop')).$backdropOpacity.get()).toBe(10)
  })
})
