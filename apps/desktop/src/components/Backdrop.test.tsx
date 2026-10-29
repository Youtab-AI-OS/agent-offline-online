import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { $backdropOpacity, setBackdrop, setBackdropOpacity } from '@/store/backdrop'

import { Backdrop } from './Backdrop'

beforeEach(() => {
  setBackdrop(true)
  setBackdropOpacity(10)
})
afterEach(cleanup)

it('renders the original background at the selected opacity and restores it after toggling', () => {
  const { container } = render(<Backdrop />)
  const imageSource = container.querySelector('img')?.getAttribute('src')

  expect(imageSource).toContain('ds-assets/youtab-bull-bg.jpg')
  expect(container.querySelector<HTMLElement>('.youtab-backdrop')?.style.opacity).toBe('0.1')
  act(() => setBackdropOpacity(63))
  expect(container.querySelector<HTMLElement>('.youtab-backdrop')?.style.opacity).toBe('0.63')
  act(() => setBackdrop(false))
  expect(container.querySelector('img')).toBeNull()
  expect($backdropOpacity.get()).toBe(63)
  act(() => setBackdrop(true))
  expect(container.querySelector('img')?.getAttribute('src')).toBe(imageSource)
  expect(container.querySelector<HTMLElement>('.youtab-backdrop')?.style.opacity).toBe('0.63')
})
