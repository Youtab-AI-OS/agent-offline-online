import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { $capture, endCapture, resetAllBindings, setBinding, $bindings } from '@/store/keybinds'

import { KeybindSettings } from './keybind-settings'

afterEach(() => {
  cleanup()
  endCapture()
  resetAllBindings()
})

it('starts every shortcut category collapsed and exposes its original controls on demand', () => {
  render(<KeybindSettings />)
  const categories = screen.getAllByRole('button', { expanded: false })

  expect(categories.length).toBeGreaterThan(0)
  for (const category of categories) {
    const content = document.getElementById(category.getAttribute('aria-controls') ?? '')

    expect(content).not.toBeNull()
    expect(content?.hidden).toBe(true)
    fireEvent.click(category)
    expect(category.getAttribute('aria-expanded')).toBe('true')
    expect(content?.hidden).toBe(false)
    fireEvent.click(category)
    expect(content?.hidden).toBe(true)
  }
})

it('searches inside collapsed categories and preserves capture and reset actions', () => {
  setBinding('session.new', ['mod+alt+n'])
  render(<KeybindSettings />)
  fireEvent.change(screen.getByRole('textbox', { name: en.keybinds.search }), {
    target: { value: en.keybinds.actions['session.new'] }
  })
  const row = screen.getByText(en.keybinds.actions['session.new'], { exact: true }).parentElement!

  fireEvent.click(within(row).getByRole('button', { name: en.keybinds.rebind }))
  expect($capture.get()).toBe('session.new')
  fireEvent.click(within(row).getByRole('button', { name: en.keybinds.reset }))
  expect($bindings.get()['session.new']).not.toEqual(['mod+alt+n'])
  fireEvent.change(screen.getByRole('textbox', { name: en.keybinds.search }), { target: { value: '' } })
  expect(screen.getAllByRole('button', { expanded: false }).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: en.keybinds.resetAll }))
  expect($bindings.get()['session.new']).toContain('mod+n')
})
