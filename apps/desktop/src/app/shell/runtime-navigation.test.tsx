import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeNavigation } from './runtime-navigation'

afterEach(cleanup)

describe('Runtime navigation', () => {
  it('opens Work and Chat notices without replacing the mounted Runtime', () => {
    render(
      <>
        <RuntimeNavigation />
        <input aria-label="Runtime draft" defaultValue="متن draft" />
      </>
    )
    const draft = screen.getByLabelText('Runtime draft')
    const runtime = screen.getByRole('button', { name: 'Runtime' })
    expect(runtime.getAttribute('aria-pressed')).toBe('true')
    for (const name of ['Work', 'Chat']) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(screen.getByText('Coming soon...')).toBeTruthy()
      expect(screen.getByRole('heading', { name })).toBeTruthy()
      expect(screen.getByLabelText('Runtime draft')).toBe(draft)
      expect((draft as HTMLInputElement).value).toBe('متن draft')
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
      expect(runtime.getAttribute('aria-pressed')).toBe('true')
    }
  })
})
