import { atom } from 'nanostores'

import { persistBoolean, persistString, storedBoolean, storedString } from '@/lib/storage'

const KEY = 'youtab.desktop.backdrop.v1'
const OPACITY_KEY = 'youtab.desktop.backdrop-opacity.global.v1'
export const DEFAULT_BACKDROP_OPACITY = 10

function normalizeOpacity(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : DEFAULT_BACKDROP_OPACITY
}

function readOpacity(): number {
  const stored = storedString(OPACITY_KEY)

  return stored === null || stored.trim() === '' ? DEFAULT_BACKDROP_OPACITY : normalizeOpacity(Number(stored))
}

/** Whether the faint statue image renders behind the chat transcript. */
export const $backdrop = atom(storedBoolean(KEY, true))

/** Device-wide presentation preference; independent of profile theme and window translucency. */
export const $backdropOpacity = atom(readOpacity())

$backdrop.subscribe(on => persistBoolean(KEY, on))
$backdropOpacity.subscribe(percent => persistString(OPACITY_KEY, String(percent)))

export function setBackdrop(on: boolean) {
  $backdrop.set(on)
}

export function setBackdropOpacity(percent: number) {
  $backdropOpacity.set(normalizeOpacity(percent))
}
