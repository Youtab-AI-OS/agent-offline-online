import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopUpdateStatus } from '@/global'

const storage = new Map<string, string>()

vi.mock('@/lib/storage', () => ({
  persistBoolean: (key: string, value: boolean) => {
    storage.set(key, String(value))
  },
  persistString: (key: string, value: null | string) => {
    if (value === null) {
      storage.delete(key)
    } else {
      storage.set(key, value)
    }
  },
  storedBoolean: (key: string, fallback: boolean) => {
    const value = storage.get(key)

    return value === undefined ? fallback : value === 'true'
  },
  storedString: (key: string) => storage.get(key) ?? null
}))

const notifySpy = vi.fn()
const dismissSpy = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notifySpy(...args),
  dismissNotification: (...args: unknown[]) => dismissSpy(...args)
}))

const checkYoutabUpdateSpy = vi.fn()
const updateYoutabSpy = vi.fn()
const getActionStatusSpy = vi.fn()

vi.mock('@/youtab', () => ({
  checkYoutabUpdate: (...args: unknown[]) => checkYoutabUpdateSpy(...args),
  updateYoutab: (...args: unknown[]) => updateYoutabSpy(...args),
  getActionStatus: (...args: unknown[]) => getActionStatusSpy(...args)
}))

const {
  maybeNotifyUpdateAvailable,
  checkBackendUpdates,
  $backendUpdateStatus,
  applyBackendUpdate,
  $backendUpdateApply,
  reportBackendContract,
  applyUpdates,
  $updateApply,
  $updateOverlayOpen,
  $updateOverlayTarget,
  requestActiveUpdate,
  resetUpdateApplyState,
  startUpdatePoller,
  stopUpdatePoller,
  $updateStatus,
  $updatePolicy,
  $updatePolicyError,
  $updatePolicySaving,
  refreshUpdatePolicy,
  saveUpdatePolicy,
  checkUpdates,
  importOfflineUpdate,
  invalidateUpdateSelection
} = await import('./updates')

const { setConnection } = await import('./session')

const status = (over: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus => ({
  supported: true,
  behind: 3,
  targetSha: 'sha-a',
  fetchedAt: 0,
  ...over
})

const lastToast = () => notifySpy.mock.calls.at(-1)?.[0] as { onDismiss: () => void }

const setRemote = (on: boolean) =>
  setConnection({
    baseUrl: 'http://box:9119',
    isFullscreen: false,
    mode: on ? 'remote' : 'local',
    nativeOverlayWidth: 0,
    token: 't',
    wsUrl: 'ws://box:9119',
    logs: [],
    windowButtonPosition: null
  })

describe('maybeNotifyUpdateAvailable', () => {
  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    vi.useRealTimers()
  })

  it('shows when an update is available and not snoozed', () => {
    maybeNotifyUpdateAvailable(status())
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0]?.[0]).toMatchObject({ icon: 'gift' })
  })

  it('stays quiet for new commits once the toast was closed', () => {
    maybeNotifyUpdateAvailable(status())
    lastToast().onDismiss() // user closes it → cooldown starts
    notifySpy.mockClear()

    // A different commit lands while still within the cooldown window.
    maybeNotifyUpdateAvailable(status({ targetSha: 'sha-b', behind: 9 }))
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('re-shows once the cooldown elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    maybeNotifyUpdateAvailable(status())
    lastToast().onDismiss()
    notifySpy.mockClear()

    vi.setSystemTime(25 * 60 * 60 * 1000) // > 24h cooldown
    maybeNotifyUpdateAvailable(status({ targetSha: 'sha-b' }))
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('does nothing when already up to date', () => {
    maybeNotifyUpdateAvailable(status({ behind: 0 }))
    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('reportBackendContract', () => {
  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    vi.useRealTimers()
  })

  it('dismisses the toast when the backend meets the contract', () => {
    reportBackendContract(5)
    expect(dismissSpy).toHaveBeenCalledWith('backend-contract-skew')
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('warns when the backend is behind (or reports no contract)', () => {
    reportBackendContract(undefined)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    reportBackendContract(1)
    expect(notifySpy).toHaveBeenCalledTimes(2)
  })

  it('stays quiet on later session opens once the user closed it', () => {
    reportBackendContract(1)
    lastToast().onDismiss() // user closes it → cooldown starts
    notifySpy.mockClear()

    // Opening another pre-existing session re-runs the check within cooldown.
    reportBackendContract(1)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('reminds again after the cooldown elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    reportBackendContract(1)
    lastToast().onDismiss()
    notifySpy.mockClear()

    vi.setSystemTime(25 * 60 * 60 * 1000) // > 24h cooldown
    reportBackendContract(1)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('clears the snooze once the backend catches up, so a regression warns again', () => {
    reportBackendContract(1)
    lastToast().onDismiss()
    notifySpy.mockClear()

    reportBackendContract(5) // backend updated → satisfied, snooze cleared
    reportBackendContract(4) // a later regression must warn immediately
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })
})

describe('checkBackendUpdates', () => {
  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    checkYoutabUpdateSpy.mockReset()
    $backendUpdateStatus.set(null)
    vi.useRealTimers()
  })

  it('maps the backend /update/check onto the backend status, including commits', async () => {
    setRemote(true)
    checkYoutabUpdateSpy.mockResolvedValue({
      install_method: 'git',
      current_version: '0.16.0',
      behind: 2,
      update_available: true,
      can_apply: true,
      update_command: 'youtab update',
      message: null,
      commits: [{ sha: 'abc1234', summary: 'feat: x', author: 'a', at: 1 }]
    })

    const result = await checkBackendUpdates()

    expect(checkYoutabUpdateSpy).toHaveBeenCalled()
    expect(result?.behind).toBe(2)
    expect(result?.updateAvailable).toBe(true)
    expect(result?.commits?.[0]?.sha).toBe('abc1234')
    expect(result?.supported).toBe(true)
    expect($backendUpdateStatus.get()?.commits?.[0]?.summary).toBe('feat: x')
  })

  it('preserves backend update_available when the backend cannot count commits', async () => {
    setRemote(true)
    checkYoutabUpdateSpy.mockResolvedValue({
      install_method: 'nixos',
      current_version: '0.16.0',
      behind: -1,
      update_available: true,
      can_apply: false,
      update_command: 'managed outside dashboard',
      message: 'Update available.'
    })

    const result = await checkBackendUpdates()

    expect(result?.behind).toBe(0)
    expect(result?.updateAvailable).toBe(true)
    expect(result?.targetSha).toBe('backend:0.16.0')
  })

  it('honours can_apply=false (docker/nix): not supported, carries message', async () => {
    setRemote(true)
    checkYoutabUpdateSpy.mockResolvedValue({
      install_method: 'docker',
      current_version: '0.16.0',
      behind: null,
      update_available: false,
      can_apply: false,
      update_command: 'docker pull ...',
      message: 'Docker images are immutable.'
    })

    const result = await checkBackendUpdates()

    expect(result?.supported).toBe(false)
    expect(result?.message).toBe('Docker images are immutable.')
  })

  it('is a no-op in local mode (backend check only runs when remote)', async () => {
    setRemote(false)
    await checkBackendUpdates()
    expect(checkYoutabUpdateSpy).not.toHaveBeenCalled()
  })
})

// The ⌘K "Update Youtab" row. It used to call applyBackendUpdate() flat, which
// in local mode aimed at the backend checkout instead of the client and, with
// no overlay open, showed nothing at all.
describe('requestActiveUpdate', () => {
  const applyClientMock = vi.fn()
  const checkClientMock = vi.fn()

  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    applyClientMock.mockReset().mockResolvedValue({ ok: true, handedOff: true })
    checkClientMock.mockReset().mockResolvedValue(status({ behind: 0 }))
    updateYoutabSpy.mockReset().mockResolvedValue({ ok: true, name: 'update' })
    checkYoutabUpdateSpy.mockReset().mockResolvedValue({
      install_method: 'git',
      current_version: '0.4.2',
      behind: 0,
      update_available: false,
      can_apply: true,
      update_command: null,
      message: null
    })
    getActionStatusSpy.mockReset().mockResolvedValue({ lines: [], running: false, exit_code: 0 })
    resetUpdateApplyState()
    $updateStatus.set(null)
    $backendUpdateStatus.set(null)
    $updateOverlayOpen.set(false)
    ;(globalThis as unknown as { window: unknown }).window = {
      youtabDesktop: { updates: { apply: applyClientMock, check: checkClientMock } }
    }
    vi.useRealTimers()
  })

  afterEach(() => {
    setRemote(false)
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('previews the CLIENT update in local mode, never applying the backend', () => {
    setRemote(false)
    $updateStatus.set(status({ behind: 3 }))

    requestActiveUpdate()

    expect(applyClientMock).not.toHaveBeenCalled()
    expect(updateYoutabSpy).not.toHaveBeenCalled()
    expect($updateOverlayTarget.get()).toBe('client')
  })

  it('previews the BACKEND update in remote mode', () => {
    setRemote(true)
    $backendUpdateStatus.set(status({ behind: 3 }))

    requestActiveUpdate()

    expect(updateYoutabSpy).not.toHaveBeenCalled()
    expect(applyClientMock).not.toHaveBeenCalled()
    expect($updateOverlayTarget.get()).toBe('backend')
  })

  it('always opens the overlay, so selecting the row is never a silent no-op', () => {
    setRemote(false)
    $updateStatus.set(status({ behind: 3 }))

    requestActiveUpdate()

    expect($updateOverlayOpen.get()).toBe(true)
  })

  it('opens the overlay to re-check instead of applying when already current', () => {
    setRemote(false)
    $updateStatus.set(status({ behind: 0, updateAvailable: false }))

    requestActiveUpdate()

    expect($updateOverlayOpen.get()).toBe(true)
    expect(applyClientMock).not.toHaveBeenCalled()
    expect(updateYoutabSpy).not.toHaveBeenCalled()
  })

  it('previews a backend update even when it cannot count commits', () => {
    setRemote(true)
    $backendUpdateStatus.set(status({ behind: 0, updateAvailable: true }))

    requestActiveUpdate()
    expect($updateOverlayOpen.get()).toBe(true)
    expect(updateYoutabSpy).not.toHaveBeenCalled()
  })
})

describe('applyUpdates terminal state', () => {
  const applyMock = vi.fn()
  const checkMock = vi.fn()

  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    applyMock.mockReset()
    checkMock.mockReset()
    resetUpdateApplyState()
    $updateOverlayOpen.set(true)
    ;(globalThis as unknown as { window: unknown }).window = {
      youtabDesktop: { updates: { apply: applyMock, check: checkMock } }
    }
    vi.useRealTimers()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('holds the restart view when a relauncher hands off (no close, no toast)', async () => {
    applyMock.mockResolvedValue({ ok: true, handedOff: true })

    const result = await applyUpdates()

    expect(result.handedOff).toBe(true)
    // The detached relauncher will quit + reopen us; keep "applying" until then.
    expect($updateApply.get().applying).toBe(true)
    expect($updateOverlayOpen.get()).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('closes the overlay + toasts when updated but not relaunched in place', async () => {
    // The Linux AppImage / dev-run path: backend + GUI updated, no in-place
    // relaunch. Must not strand the overlay on a closeless spinner.
    applyMock.mockResolvedValue({ ok: true, backendUpdated: true })

    await applyUpdates()

    expect($updateOverlayOpen.get()).toBe(false)
    expect($updateApply.get().applying).toBe(false)
    expect($updateApply.get().stage).toBe('idle')
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'success' })
  })

  it('lands on a closeable error state when the apply resolves not-ok', async () => {
    applyMock.mockResolvedValue({ ok: false, error: 'rebuild-failed', message: 'rebuild failed' })

    await applyUpdates()

    expect($updateApply.get().applying).toBe(false)
    expect($updateApply.get().stage).toBe('error')
    expect($updateApply.get().error).toBe('rebuild-failed')
  })

  it('refreshes release notes after the approved release changes before installing', async () => {
    applyMock.mockResolvedValue({ ok: false, error: 'release-changed', message: 'Review the new release.' })
    checkMock.mockResolvedValue(status({ branch: 'release', targetSha: 'b'.repeat(40), releaseNotes: ['New release'] }))

    await applyUpdates({ expectedSourceSha: 'a'.repeat(40) })

    expect(applyMock).toHaveBeenCalledWith({ expectedSourceSha: 'a'.repeat(40) })
    expect(checkMock).toHaveBeenCalledTimes(1)
    expect($updateStatus.get()?.releaseNotes).toEqual(['New release'])
    expect($updateApply.get().stage).toBe('idle')
    expect($updateOverlayOpen.get()).toBe(true)
    expect(applyMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the manual command state for CLI installs with no staged updater', async () => {
    applyMock.mockResolvedValue({ ok: true, manual: true, command: 'youtab update' })

    await applyUpdates()

    expect($updateApply.get().stage).toBe('manual')
    expect($updateApply.get().command).toBe('youtab update')
    expect($updateOverlayOpen.get()).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('lands on the guiSkew terminal state for a GUI/backend skew (AppImage/.deb/.rpm), without claiming a GUI update', async () => {
    // Linux: backend updated, but the running desktop package was NOT replaced.
    // Must NOT toast "loads next launch" — that's the dishonest message #45205
    // guards against. Lands on a closeable guiSkew view instead.
    applyMock.mockResolvedValue({
      ok: true,
      backendUpdated: true,
      guiUpdated: false,
      guiSkew: true,
      message: 'Backend updated, but the desktop app package was not changed.'
    })

    const result = await applyUpdates()

    expect(result.guiUpdated).toBe(false)
    expect($updateApply.get().stage).toBe('guiSkew')
    expect($updateApply.get().applying).toBe(false)
    expect($updateApply.get().message).toMatch(/desktop app package was not changed/)
    // Overlay stays open on a closeable terminal view; no "all set" toast.
    expect($updateOverlayOpen.get()).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('lands on a closeable manual-restart state when the rebuilt sandbox blocks auto-relaunch', async () => {
    // Under release/*-unpacked but chrome-sandbox isn't launchable: don't quit
    // into a dead app — keep a working window on a closeable manual state.
    applyMock.mockResolvedValue({
      ok: true,
      backendUpdated: true,
      guiUpdated: false,
      manualRestart: true,
      sandboxBlocked: true,
      message: 'Backend updated. Quit and reopen Youtab to finish.'
    })

    const result = await applyUpdates()

    expect(result.manualRestart).toBe(true)
    expect($updateApply.get().stage).toBe('manual')
    expect($updateApply.get().command).toBeNull()
    expect($updateApply.get().message).toMatch(/Quit and reopen/)
    expect($updateOverlayOpen.get()).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('applyBackendUpdate recovery', () => {
  beforeEach(() => {
    storage.clear()
    checkYoutabUpdateSpy.mockReset()
    updateYoutabSpy.mockReset()
    getActionStatusSpy.mockReset()
    $backendUpdateApply.set({
      applying: false,
      stage: 'idle',
      message: '',
      percent: null,
      error: null,
      command: null,
      log: []
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the backend to return after the restart drops the connection, then clears the overlay', async () => {
    updateYoutabSpy.mockResolvedValue({ ok: true, name: 'update', pid: 1 })
    getActionStatusSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    checkYoutabUpdateSpy.mockResolvedValue({
      install_method: 'git',
      current_version: '0.16.0',
      behind: 0,
      update_available: false,
      can_apply: true,
      update_command: 'youtab update',
      message: null
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result.ok).toBe(true)
    expect($backendUpdateApply.get().stage).toBe('idle')
    expect($backendUpdateApply.get().applying).toBe(false)
  })

  it('surfaces backend update action log lines while the action is running', async () => {
    updateYoutabSpy.mockResolvedValue({ ok: true, name: 'update', pid: 1 })
    getActionStatusSpy
      .mockResolvedValueOnce({
        exit_code: null,
        lines: ['Pulling updates...', 'Installing dependencies...'],
        name: 'update',
        pid: 1,
        running: true
      })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    checkYoutabUpdateSpy.mockResolvedValue({
      install_method: 'git',
      current_version: '0.16.0',
      behind: 0,
      update_available: false,
      can_apply: true,
      update_command: 'youtab update',
      message: null
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)

    expect($backendUpdateApply.get().message).toBe('Installing dependencies...')
    expect($backendUpdateApply.get().log.map((entry) => entry.message)).toEqual([
      'Pulling updates...',
      'Installing dependencies...'
    ])

    await vi.advanceTimersByTimeAsync(5000)
    await promise
  })

  it('surfaces an error when the backend never comes back after the restart', async () => {
    updateYoutabSpy.mockResolvedValue({ ok: true, name: 'update', pid: 1 })
    getActionStatusSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    checkYoutabUpdateSpy.mockRejectedValue(new Error('ECONNREFUSED'))

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(70000)
    const result = await promise

    expect(result.ok).toBe(false)
    expect($backendUpdateApply.get().stage).toBe('error')
  })
})

describe('startUpdatePoller', () => {
  const checkMock = vi.fn()
  const onProgressMock = vi.fn()
  const listeners: Record<string, Function> = {}

  beforeEach(() => {
    storage.clear()
    checkMock.mockReset()
    onProgressMock.mockReset()
    Object.keys(listeners).forEach((k) => delete listeners[k])
    checkMock.mockResolvedValue({
      supported: true,
      behind: 5,
      targetSha: 'sha-abc',
      fetchedAt: 0
    })
    $updateStatus.set(null)
    ;(globalThis as unknown as { window: unknown }).window = {
      youtabDesktop: { updates: { check: checkMock, onProgress: onProgressMock } },
      addEventListener: vi.fn((event: string, handler: Function) => {
        listeners[event] = handler
      }),
      removeEventListener: vi.fn()
    }
    vi.useFakeTimers()
    stopUpdatePoller()
  })

  afterEach(() => {
    stopUpdatePoller()
    delete (globalThis as unknown as { window?: unknown }).window
    vi.useRealTimers()
  })

  it('calls checkUpdates() on startup so the version pill populates immediately', async () => {
    startUpdatePoller()

    // checkUpdates() is async — flush microtasks without advancing the 30-min interval.
    await vi.advanceTimersByTimeAsync(0)

    expect(checkMock).toHaveBeenCalled()
    expect($updateStatus.get()?.behind).toBe(5)
  })

  it('calls checkUpdates() on each interval tick', async () => {
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)
    checkMock.mockClear()

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(checkMock).toHaveBeenCalled()
  })

  it('calls checkUpdates() when the window regains focus', async () => {
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)
    checkMock.mockClear()

    // Invoke the registered focus handler directly (the mock window doesn't
    // propagate DOM events, so call the stored listener).
    listeners['focus']?.()

    await vi.advanceTimersByTimeAsync(0)

    expect(checkMock).toHaveBeenCalled()
  })
})

describe('native Inno update permission gates', () => {
  const listeners: Record<string, () => void> = {}

  const getPolicy = vi.fn(),
    setPolicy = vi.fn(),
    check = vi.fn(),
    apply = vi.fn(),
    importOffline = vi.fn()

  const unsubscribe = vi.fn()
  let policy = { supported: true, enabled: false, automaticChecks: false }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    policy = { supported: true, enabled: false, automaticChecks: false }
    getPolicy.mockReset().mockImplementation(async () => ({ ...policy }))
    setPolicy.mockReset().mockImplementation(async (value: { enabled: boolean; automaticChecks: boolean }) => {
      policy = { supported: true, ...value }

      return { ...policy }
    })
    check.mockReset().mockResolvedValue(status({ behind: 0 }))
    apply.mockReset().mockResolvedValue({ ok: true, handedOff: true })
    importOffline.mockReset().mockResolvedValue(null)
    ;(globalThis as unknown as { window: unknown }).window = {
      youtabDesktop: { updates: { getPolicy, setPolicy, check, apply, importOffline, onProgress: () => unsubscribe } },
      addEventListener: (name: string, handler: () => void) => {
        listeners[name] = handler
      },
      removeEventListener: vi.fn()
    }
    stopUpdatePoller()
    setRemote(true)
    $updatePolicy.set(null)
    $updatePolicyError.set(null)
    $updatePolicySaving.set(false)
    $updateStatus.set(null)
    $backendUpdateStatus.set(null)
    $updateOverlayOpen.set(false)
    resetUpdateApplyState()
    checkYoutabUpdateSpy.mockReset().mockResolvedValue({ can_apply: true, current_version: 'test', behind: 0 })
    updateYoutabSpy.mockReset()
  })
  afterEach(() => {
    stopUpdatePoller()
    setRemote(false)
    delete (globalThis as unknown as { window?: unknown }).window
    vi.useRealTimers()
  })

  it('makes no update network or apply call on startup, focus, timer or manual action while Off', async () => {
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    listeners.focus?.()
    await vi.advanceTimersByTimeAsync(0)
    await checkUpdates()
    await checkBackendUpdates()
    expect((await applyUpdates()).ok).toBe(false)
    expect((await applyBackendUpdate()).ok).toBe(false)
    expect(getPolicy).toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()
    expect(checkYoutabUpdateSpy).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(updateYoutabSpy).not.toHaveBeenCalled()
    expect(await importOfflineUpdate()).toBeNull()
    expect(importOffline).not.toHaveBeenCalled()
  })

  it('permits manual checks when enabled without silently enabling automatic online requests', async () => {
    await saveUpdatePolicy({ enabled: true, automaticChecks: false })
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(check).not.toHaveBeenCalled()
    expect(checkYoutabUpdateSpy).not.toHaveBeenCalled()
    await checkUpdates()
    await checkBackendUpdates()
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith({ background: false })
    expect(checkYoutabUpdateSpy).toHaveBeenCalledTimes(1)
    stopUpdatePoller()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('fails closed and exposes native policy read errors without a remote fallback', async () => {
    getPolicy.mockRejectedValue(new Error('Synthetic policy read failure'))
    await checkUpdates()
    await checkBackendUpdates()
    expect($updatePolicyError.get()).toContain('Synthetic policy read failure')
    expect(check).not.toHaveBeenCalled()
    expect(checkYoutabUpdateSpy).not.toHaveBeenCalled()
  })

  it('does not start background requests after the poller stops while policy is loading', async () => {
    let finish: (value: typeof policy) => void = () => {}

    const pending = new Promise<typeof policy>((resolve) => {
      finish = resolve
    })

    getPolicy.mockImplementation(() => pending)
    startUpdatePoller()
    stopUpdatePoller()
    finish({ supported: true, enabled: true, automaticChecks: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(check).not.toHaveBeenCalled()
    expect(checkYoutabUpdateSpy).not.toHaveBeenCalled()
  })

  it('runs automatic checks only when both flags permit them and stops future requests after disabling', async () => {
    policy = { supported: true, enabled: true, automaticChecks: true }
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith({ background: true })
    expect(checkYoutabUpdateSpy).toHaveBeenCalledTimes(1)
    await saveUpdatePolicy({ enabled: false, automaticChecks: true })
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    listeners.focus?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(1)
    expect(checkYoutabUpdateSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the confirmed state on a save failure and ignores a stale read after turning Off', async () => {
    policy.enabled = true
    await refreshUpdatePolicy()
    setPolicy.mockRejectedValueOnce(new Error('Synthetic write denied'))
    await expect(saveUpdatePolicy({ enabled: false, automaticChecks: false })).rejects.toThrow('Synthetic write denied')
    expect($updatePolicy.get()?.enabled).toBe(true)

    let finish: (value: typeof policy) => void = () => {}
    getPolicy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const stale = refreshUpdatePolicy()
    await saveUpdatePolicy({ enabled: false, automaticChecks: false })
    finish({ supported: true, enabled: true, automaticChecks: true })
    await stale
    expect($updatePolicy.get()?.enabled).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('does not republish a late online check after permission was disabled', async () => {
    policy.enabled = true

    let finish: (value: DesktopUpdateStatus) => void = () => {}
    check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = checkUpdates()
    await vi.advanceTimersByTimeAsync(0)
    await saveUpdatePolicy({ enabled: false, automaticChecks: false })
    finish(status({ behind: 1 }))
    await pending
    expect($updateStatus.get()).toBeNull()
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('keeps cancellation/failure unchanged and previews a verified offline selection without an online check', async () => {
    policy.enabled = true
    const previous = status({ behind: 0 })
    $updateStatus.set(previous)
    expect(await importOfflineUpdate()).toBeNull()
    expect($updateStatus.get()).toBe(previous)
    importOffline.mockRejectedValueOnce(new Error('Synthetic invalid bundle'))
    await expect(importOfflineUpdate()).rejects.toThrow('Synthetic invalid bundle')
    expect($updateStatus.get()).toBe(previous)
    importOffline.mockResolvedValueOnce({ supported: true, error: 'signature-mismatch', reason: 'signature-mismatch' })
    await expect(importOfflineUpdate()).rejects.toThrow('could not be verified')
    expect($updateStatus.get()).toBe(previous)
    expect($updateOverlayOpen.get()).toBe(false)

    const source = 'a'.repeat(40),
      build = 'b'.repeat(64)

    importOffline.mockResolvedValueOnce(
      status({
        branch: 'release',
        targetSha: source,
        targetBuildId: build,
        releaseNotes: ['Synthetic signed release note']
      })
    )
    await importOfflineUpdate()
    expect($updateStatus.get()?.source).toBe('offline')
    expect($updateOverlayOpen.get()).toBe(true)
    await checkUpdates()
    expect(check).not.toHaveBeenCalled()
    await applyUpdates({ expectedSourceSha: source, expectedBuildId: build })
    expect(apply).toHaveBeenCalledWith({ expectedSourceSha: source, expectedBuildId: build })
    expect(checkYoutabUpdateSpy).not.toHaveBeenCalled()
  })

  it('does not replace offline preview with an online fetch when the selected release changes', async () => {
    policy.enabled = true
    importOffline.mockResolvedValueOnce(
      status({ branch: 'release', targetSha: 'a'.repeat(40), targetBuildId: 'b'.repeat(64) })
    )
    await importOfflineUpdate()
    apply.mockResolvedValueOnce({ ok: false, error: 'release-changed' })
    await applyUpdates({ expectedSourceSha: 'a'.repeat(40), expectedBuildId: 'b'.repeat(64) })
    expect(check).not.toHaveBeenCalled()
    expect($updateApply.get().stage).toBe('error')
  })

  it('permits a fresh online preview after a successful explicit channel selection cancels old offline consent', async () => {
    policy.enabled = true
    importOffline.mockResolvedValueOnce(
      status({ branch: 'release', targetSha: 'a'.repeat(40), targetBuildId: 'b'.repeat(64) })
    )
    await importOfflineUpdate()
    invalidateUpdateSelection()
    expect($updateStatus.get()).toBeNull()
    await checkUpdates()
    expect(check).toHaveBeenCalledOnce()
    expect($updateStatus.get()?.source).toBeUndefined()
  })

  it.each(['success', 'failure'] as const)(
    'keeps a newly imported offline selection when an earlier online check ends with %s',
    async (outcome) => {
      policy.enabled = true

      let finish: (value: DesktopUpdateStatus) => void = () => {}

      let fail: (error: Error) => void = () => {}
      check.mockImplementationOnce(
        () =>
          new Promise<DesktopUpdateStatus>((resolve, reject) => {
            finish = resolve
            fail = reject
          })
      )
      const pending = checkUpdates()
      await vi.advanceTimersByTimeAsync(0)
      expect(check).toHaveBeenCalledTimes(1)

      const offline = status({
        branch: 'release',
        targetSha: 'a'.repeat(40),
        targetBuildId: 'b'.repeat(64),
        releaseNotes: ['Synthetic verified offline release']
      })

      importOffline.mockResolvedValueOnce(offline)
      await importOfflineUpdate()

      if (outcome === 'success') {finish(status({ targetBuildId: 'c'.repeat(64) }))}
      else {fail(new Error('Synthetic old online failure'))}

      await pending
      expect($updateStatus.get()).toEqual({ ...offline, source: 'offline' })
      expect($updateOverlayOpen.get()).toBe(true)
      expect(notifySpy).not.toHaveBeenCalled()
    }
  )
})
