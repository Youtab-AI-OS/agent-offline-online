// @vitest-environment jsdom
import { open } from '@tauri-apps/plugin-dialog'
import { atom } from 'nanostores'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { $installationKind, $releaseChannel, changeInstallLocation, startInstall } from '../store'

import Welcome from './welcome'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('../store', () => ({
  $installationKind: atom('fresh'),
  $releaseChannel: atom('stable'),
  $youtabHome: atom('C:\\Users\\Test\\AppData\\Local\\youtab'),
  changeInstallLocation: vi.fn(),
  openLogDir: vi.fn(),
  startInstall: vi.fn(),
  startUpdate: vi.fn()
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' })
  $installationKind.set('fresh')
  $releaseChannel.set('stable')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

test('fresh Windows Setup exposes location and channel before one-click install', async () => {
  vi.mocked(open).mockResolvedValue('D:\\Youtab Parent')
  vi.mocked(changeInstallLocation).mockResolvedValue('unchanged')
  await act(async () => root.render(<Welcome />))

  expect(host.textContent).toContain('Install location')
  expect(host.textContent).toContain('Choose location')
  expect(host.textContent).toContain('C:\\Users\\Test\\AppData\\Local\\youtab')
  const channel = host.querySelector<HTMLSelectElement>('select[aria-label="Update channel"]')!
  expect(channel.value).toBe('stable')
  expect(channel.options[1].textContent).toBe('Pilot / Test')
  await act(async () => {
    channel.value = 'pilot'
    channel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect($releaseChannel.get()).toBe('pilot')

  await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click() })
  expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: 'Choose a private folder for Youtab' })
  expect(changeInstallLocation).toHaveBeenCalledWith('D:\\Youtab Parent')

  const install = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Install'))!
  await act(async () => install.click())
  expect(startInstall).toHaveBeenCalledWith({ migrateLegacy: false })
})
