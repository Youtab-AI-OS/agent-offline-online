import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

vi.mock('@/store/updates', async () => {
  const { atom } = await import('nanostores')

  const idle = () => ({
    applying: false,
    stage: 'idle',
    message: '',
    percent: null,
    error: null,
    command: null,
    log: []
  })

  return {
    $backendUpdateApply: atom(idle()),
    $backendUpdateChecking: atom(false),
    $backendUpdateStatus: atom(null),
    $updateApply: atom(idle()),
    $updateChecking: atom(false),
    $updateOverlayOpen: atom(true),
    $updateOverlayTarget: atom('client'),
    $updateStatus: atom(null),
    applyBackendUpdate: vi.fn(),
    applyUpdates: vi.fn(),
    checkBackendUpdates: vi.fn(),
    checkUpdates: vi.fn(),
    resetUpdateApplyState: vi.fn(),
    setUpdateOverlayOpen: vi.fn()
  }
})

import {
  $backendUpdateStatus,
  $updateOverlayOpen,
  $updateOverlayTarget,
  $updateStatus,
  applyBackendUpdate,
  applyUpdates,
  checkUpdates
} from '@/store/updates'

import { UpdatesOverlay } from './updates-overlay'

beforeEach(() => {
  vi.clearAllMocks()
  $updateOverlayOpen.set(true)
  $updateOverlayTarget.set('client')
  $updateStatus.set({
    supported: true,
    branch: 'release',
    source: 'offline',
    updateAvailable: true,
    targetSha: 'a'.repeat(40),
    targetBuildId: 'b'.repeat(64),
    releaseSequence: 9,
    releaseNotes: ['Synthetic verified metadata for the displayed build']
  })
})
afterEach(cleanup)

describe('reviewed update overlay consent', () => {
  it('passes the displayed exact source and build IDs from the real install button without another online check', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <UpdatesOverlay />
      </I18nProvider>
    )
    expect(screen.getByText('Synthetic verified metadata for the displayed build')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    expect(applyUpdates).toHaveBeenCalledWith({ expectedSourceSha: 'a'.repeat(40), expectedBuildId: 'b'.repeat(64) })
    expect(checkUpdates).not.toHaveBeenCalled()
  })

  it('keeps the remote backend action distinct from local signed-build consent', () => {
    $updateOverlayTarget.set('backend')
    $backendUpdateStatus.set({ supported: true, updateAvailable: true, releaseNotes: ['Synthetic backend note'] })
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <UpdatesOverlay />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    expect(applyBackendUpdate).toHaveBeenCalledTimes(1)
    expect(applyUpdates).not.toHaveBeenCalled()
  })
})
