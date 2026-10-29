import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import {
  $desktopVersion,
  $updateApply,
  $updateChecking,
  $updatePolicy,
  $updatePolicySaving,
  $updateStatus,
  resetUpdateApplyState
} from '@/store/updates'

import { AboutSettings } from './about-settings'

// Keep this test focused on the real About select and update-store/IPC seam.
// Policy switches and removal confirmations have their own behavior suites.
vi.mock('./inno-update-settings', () => ({ InnoUpdateSettings: () => null }))
vi.mock('./uninstall-section', () => ({ UninstallSection: () => null }))

const originalBridge = Object.getOwnPropertyDescriptor(window, 'youtabDesktop')
const getBranch = vi.fn(), setChannel = vi.fn(), check = vi.fn(), getPolicy = vi.fn()
let savedChannel: 'stable' | 'pilot' = 'stable'

const labels: Array<[Locale, string, string, string]> = [
  ['en', 'Release preference', 'Recommended', 'Early access'],
  ['fa', 'نوع دریافت به‌روزرسانی', 'پیشنهادی', 'دسترسی زودهنگام'],
  ['nl', 'Releasevoorkeur', 'Aanbevolen', 'Vroege toegang'],
  ['zh', '版本偏好', '推荐', '抢先体验'],
  ['zh-hant', '版本偏好', '建議', '搶先體驗'],
  ['ja', 'リリース設定', '推奨', '早期アクセス'],
  ['ar', 'تفضيل الإصدارات', 'موصى به', 'وصول مبكر']
]

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  savedChannel = 'stable'
  getBranch.mockReset().mockImplementation(async () => ({ channel: savedChannel }))
  setChannel.mockReset().mockImplementation(async (value: 'stable' | 'pilot') => {
    savedChannel = value
  })
  check.mockReset().mockResolvedValue({ supported: true, behind: 0 })
  getPolicy.mockReset().mockResolvedValue({ supported: true, enabled: true, automaticChecks: false })
  Object.defineProperty(window, 'youtabDesktop', {
    configurable: true,
    value: { updates: { getBranch, setChannel, check, getPolicy } }
  })
  $desktopVersion.set(null)
  $updateStatus.set(null)
  $updateChecking.set(false)
  $updatePolicy.set(null)
  $updatePolicySaving.set(false)
  resetUpdateApplyState()
})

afterEach(() => {
  cleanup()

  if (originalBridge) {Object.defineProperty(window, 'youtabDesktop', originalBridge)}
  else {Reflect.deleteProperty(window, 'youtabDesktop')}
})

function show(locale: Locale = 'en') {
  return render(<I18nProvider configClient={null} initialLocale={locale}><AboutSettings /></I18nProvider>)
}

function openChoices(name = 'Release preference') {
  fireEvent.keyDown(screen.getByRole('combobox', { name }), { key: 'ArrowDown' })
}

describe('customer release preferences', () => {
  it('shows the bounded native diagnostic code', () => {
    $updateStatus.set({ supported: true, error: 'http-404' })
    show()
    expect(screen.getByText("We couldn't reach the update server. (http-404)")).toBeTruthy()
  })

  it.each(labels)('shows localized choices and the native saved selection in %s', async (locale, name, recommended, earlyAccess) => {
    savedChannel = 'pilot'
    show(locale)
    await waitFor(() => expect(screen.getByRole('combobox', { name }).textContent).toContain(earlyAccess))
    openChoices(name)
    expect(screen.getByRole('option', { name: recommended })).toBeTruthy()
    expect(screen.getByRole('option', { name: earlyAccess }).getAttribute('data-state')).toBe('checked')
    expect(screen.queryByText(/Stable|Pilot|\/ Test/)).toBeNull()
    expect(setChannel).not.toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()
  })

  it('passes the unchanged channel IDs to native storage and restores its selection when reopened', async () => {
    const first = show()
    await waitFor(() => expect(getBranch).toHaveBeenCalledTimes(1))
    openChoices()
    fireEvent.click(screen.getByRole('option', { name: 'Early access' }))
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    expect(setChannel).toHaveBeenCalledWith('pilot')
    expect(check).toHaveBeenCalledWith({ background: false })
    expect(screen.getByRole('combobox', { name: 'Release preference' }).textContent).toContain('Early access')
    first.unmount()
    show()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Release preference' }).textContent).toContain('Early access'))
    openChoices()
    fireEvent.click(screen.getByRole('option', { name: 'Recommended' }))
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
    expect(setChannel).toHaveBeenLastCalledWith('stable')
    expect(savedChannel).toBe('stable')
  })

  it('keeps the confirmed selection and pending update if the native save fails', async () => {
    savedChannel = 'pilot'
    const pending = { supported: true, behind: 1 }
    $updateStatus.set(pending)
    setChannel.mockRejectedValueOnce(new Error('Synthetic native save denied'))
    show()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Release preference' }).textContent).toContain('Early access'))
    openChoices()
    fireEvent.click(screen.getByRole('option', { name: 'Recommended' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('combobox', { name: 'Release preference' }).textContent).toContain('Early access')
    expect(savedChannel).toBe('pilot')
    expect($updateStatus.get()).toBe(pending)
    expect(check).not.toHaveBeenCalled()
  })

  it('keeps channel selection unavailable while an update is applying', async () => {
    $updateApply.set({ ...$updateApply.get(), applying: true, stage: 'prepare' })
    show()
    expect((screen.getByRole('combobox', { name: 'Release preference' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
