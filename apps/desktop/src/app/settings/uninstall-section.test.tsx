import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UninstallSection } from './uninstall-section'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'youtabDesktop')
})

describe('Uninstall disclosure', () => {
  it.each(['denied', 'rejected'] as const)('keeps the start failure visible after %s and requires confirmation before retry', async failure => {
    const message = failure === 'denied' ? 'Registered uninstall location does not match this installation.' : 'Uninstall helper could not start.'
    const run = vi.fn()
    if (failure === 'denied') run.mockResolvedValue({ ok: false, error: 'full-uninstall-not-started', message })
    else run.mockRejectedValue(new Error(message))
    Object.assign(window, {
      youtabDesktop: {
        uninstall: {
          summary: vi.fn().mockResolvedValue({ agent_installed: true }),
          run
        }
      }
    })
    render(<UninstallSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall options' }))
    fireEvent.click(await screen.findByRole('button', { name: /Uninstall everything/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, uninstall' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    expect(screen.queryByText('Confirm uninstall')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Uninstalling…' })).toBeNull()
    for (const name of [/Uninstall Chat GUI only/, /Uninstall GUI \+ agent, keep my data/, /Uninstall everything/]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(run).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /Uninstall everything/ }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Confirm uninstall')).toBeTruthy()
    expect(run).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps every mode and requires the existing separate confirmation', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true })
    const home = 'C:\\Users\\SyntheticTester\\Youtab'
    const userData = 'C:\\Users\\SyntheticTester\\AppData\\Roaming\\Youtab'
    Object.assign(window, {
      youtabDesktop: {
        uninstall: {
          summary: vi.fn().mockResolvedValue({ agent_installed: true, youtab_home: home, userdata_dir: userData }),
          run
        }
      }
    })
    render(<UninstallSection />)
    const toggle = screen.getByRole('button', { name: 'Uninstall options' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /Uninstall Chat GUI only/ })).toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByRole('button', { name: /Uninstall everything/ })).toBeTruthy())
    expect(run).not.toHaveBeenCalled()
    for (const name of [/Uninstall Chat GUI only/, /Uninstall GUI \+ agent, keep my data/, /Uninstall everything/]) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(screen.getByText('Confirm uninstall')).toBeTruthy()
      expect(run).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    }
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('Uninstall options')
    expect(run).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: /Uninstall everything/ }))
    expect(screen.getByText(home)).toBeTruthy()
    expect(screen.getByText(userData)).toBeTruthy()
    expect(screen.getByText('Runtime and data home to remove:')).toBeTruthy()
    expect(screen.getByText('Desktop data directory to remove:')).toBeTruthy()
    expect(run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, uninstall' }))
    await waitFor(() => expect(run).toHaveBeenCalledWith('full'))
  })
})
