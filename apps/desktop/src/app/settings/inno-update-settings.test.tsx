import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import {
  $offlineUpdateImporting,
  $updateApply,
  $updateOverlayOpen,
  $updatePolicy,
  $updatePolicyError,
  $updatePolicySaving,
  $updateStatus,
  resetUpdateApplyState
} from '@/store/updates'

import { InnoUpdateSettings } from './inno-update-settings'

const original = Object.getOwnPropertyDescriptor(window, 'youtabDesktop')

const getPolicy = vi.fn(),
  setPolicy = vi.fn(),
  importOffline = vi.fn(),
  check = vi.fn()

let policy = { supported: true, enabled: false, automaticChecks: false }

beforeEach(() => {
  policy = { supported: true, enabled: false, automaticChecks: false }
  getPolicy.mockReset().mockImplementation(async () => ({ ...policy }))
  setPolicy.mockReset().mockImplementation(async (value: { enabled: boolean; automaticChecks: boolean }) => {
    policy = { supported: true, ...value }

    return { ...policy }
  })
  importOffline.mockReset().mockResolvedValue(null)
  check.mockReset()
  Object.defineProperty(window, 'youtabDesktop', {
    configurable: true,
    value: { updates: { getPolicy, setPolicy, importOffline, check } }
  })
  $updatePolicy.set(null)
  $updatePolicyError.set(null)
  $updatePolicySaving.set(false)
  $offlineUpdateImporting.set(false)
  $updateStatus.set(null)
  $updateOverlayOpen.set(false)
  resetUpdateApplyState()
})
afterEach(() => {
  cleanup()

  if (original) {Object.defineProperty(window, 'youtabDesktop', original)}
  else {Reflect.deleteProperty(window, 'youtabDesktop')}
})

function show(locale: 'en' | 'fa' = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <InnoUpdateSettings />
    </I18nProvider>
  )
}

describe('common Setup update preferences', () => {
  it('renders authoritative default Off, disables automatic/import and does not check online on open', async () => {
    show()
    expect((await screen.findByRole('switch', { name: 'Enable updates' })).getAttribute('aria-checked')).toBe('false')
    expect((screen.getByRole('switch', { name: 'Check online automatically' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect((screen.getByRole('button', { name: 'Import offline update' }) as HTMLButtonElement).disabled).toBe(true)
    expect(check).not.toHaveBeenCalled()
    expect(importOffline).not.toHaveBeenCalled()
  })

  it('saves explicit master/automatic choices through native policy without starting a check', async () => {
    show()
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable updates' }))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Enable updates' }).getAttribute('aria-checked')).toBe('true')
    )
    expect(setPolicy).toHaveBeenCalledWith({ enabled: true, automaticChecks: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Check online automatically' }))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Check online automatically' }).getAttribute('aria-checked')).toBe(
        'true'
      )
    )
    expect(setPolicy).toHaveBeenCalledWith({ enabled: true, automaticChecks: true })
    expect(check).not.toHaveBeenCalled()
  })

  it('keeps the previous confirmed switch and shows a visible save failure', async () => {
    policy.enabled = true
    setPolicy.mockRejectedValueOnce(new Error('Synthetic save denied'))
    show()
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable updates' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('switch', { name: 'Enable updates' }).getAttribute('aria-checked')).toBe('true')
    expect($updatePolicyError.get()).toContain('Synthetic save denied')
    expect(check).not.toHaveBeenCalled()
  })

  it('shows a read failure and permits a retry without claiming policy is enabled', async () => {
    getPolicy.mockRejectedValueOnce(new Error('Synthetic corrupt policy'))
    show()
    await screen.findByRole('alert')
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect((await screen.findByRole('switch', { name: 'Enable updates' })).getAttribute('aria-checked')).toBe('false')
    expect(check).not.toHaveBeenCalled()
  })

  it('keeps cancellation unchanged and shows import failure without claiming success', async () => {
    policy.enabled = true
    const previous = { supported: true, behind: 0 }
    $updateStatus.set(previous)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Import offline update' }))
    await waitFor(() => expect(importOffline).toHaveBeenCalledTimes(1))
    await waitFor(() => expect($offlineUpdateImporting.get()).toBe(false))
    expect($updateStatus.get()).toBe(previous)
    expect(screen.queryByRole('alert')).toBeNull()
    importOffline.mockRejectedValueOnce(new Error('Synthetic bundle signature mismatch'))
    fireEvent.click(screen.getByRole('button', { name: 'Import offline update' }))
    await screen.findByRole('alert')
    expect($updateStatus.get()).toBe(previous)
    expect($updateOverlayOpen.get()).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('supports Persian RTL and opens real native-import metadata for review without installing', async () => {
    policy.enabled = true
    importOffline.mockResolvedValueOnce({
      supported: true,
      branch: 'release',
      targetSha: 'a'.repeat(40),
      targetBuildId: 'b'.repeat(64),
      releaseNotes: ['Synthetic verified fixture note']
    })
    show('fa')
    const button = await screen.findByRole('button', { name: 'انتخاب بستهٔ به‌روزرسانی آفلاین' })
    expect(screen.getByRole('region', { name: 'تنظیمات به‌روزرسانی' }).getAttribute('dir')).toBe('rtl')
    fireEvent.click(button)
    await waitFor(() => expect($updateOverlayOpen.get()).toBe(true))
    expect($updateStatus.get()?.releaseNotes).toEqual(['Synthetic verified fixture note'])
    expect($updateStatus.get()?.source).toBe('offline')
    expect($updateApply.get().applying).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('hides the Inno-only controls on unsupported Git/other installations', async () => {
    policy.supported = false
    show()
    await waitFor(() => expect($updatePolicy.get()?.supported).toBe(false))
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Import offline update' })).toBeNull()
  })
})
