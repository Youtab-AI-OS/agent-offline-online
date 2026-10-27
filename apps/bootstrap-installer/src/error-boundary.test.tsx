// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ErrorBoundary, { rootErrorHandlers } from './error-boundary'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))

describe('Setup last-chance interface failures', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host, rootErrorHandlers)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('catches a render failure without disclosing its payload or starting work again', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    function Broken(): never { throw new Error('synthetic private credential') }

    await act(async () => root.render(<ErrorBoundary><Broken /></ErrorBoundary>))
    expect(host.textContent).toContain('Setup interface failed')
    expect(host.textContent).not.toContain('synthetic private credential')
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('synthetic private credential')
    expect(invoke).toHaveBeenCalledWith('report_frontend_failure', { kind: 'render' })
    expect(host.querySelectorAll('button')).toHaveLength(1)
  })

  it('handles async rejection with safe diagnostics and exposes a failed log action', async () => {
    await act(async () => root.render(<ErrorBoundary><p>Working</p></ErrorBoundary>))
    const event = new Event('unhandledrejection', { cancelable: true })
    Object.defineProperty(event, 'reason', { value: new Error('synthetic private credential') })
    await act(async () => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(host.textContent).toContain('may still be running')
    expect(invoke).toHaveBeenCalledWith('report_frontend_failure', { kind: 'async' })
    vi.mocked(invoke).mockRejectedValueOnce(new Error('synthetic log access credential'))
    await act(async () => { host.querySelector('button')!.click() })
    expect(host.textContent).toContain('log folder could not be opened')
    expect(host.textContent).not.toContain('synthetic log access credential')
  })
})
