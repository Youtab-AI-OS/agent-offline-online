// @vitest-environment jsdom
import { atom } from 'nanostores'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { type BootstrapStateModel, openLogDir, startInstall } from '../store'

import Failure from './failure'

vi.mock('../store', () => ({
  $logPath: atom('C:\\Users\\Test\\AppData\\Local\\youtab\\logs\\bootstrap-installer.log'),
  $mode: atom('install'),
  openLogDir: vi.fn(),
  startInstall: vi.fn(),
  startUpdate: vi.fn()
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

test('failed installation shows the safe stage and support operation ID', async () => {
  const state: BootstrapStateModel = {
    status: 'failed', protocolVersion: 1, stages: {}, stageOrder: [],
    currentStage: null, installRoot: null, error: 'Installation step failed.', logs: [],
    failureDiagnostic: { stage: 'dependencies', operationId: '123e4567-e89b-42d3-a456-426614174000' }
  }

  await act(async () => root.render(<Failure bootstrap={state} />))
  expect(host.textContent).toContain('Stage: dependencies')
  expect(host.textContent).toContain('Operation ID: 123e4567-e89b-42d3-a456-426614174000')
  expect(host.textContent).toContain('Open logs')

  const buttons = [...host.querySelectorAll('button')]
  await act(async () => buttons.find(button => button.textContent?.includes('Retry install'))!.click())
  await act(async () => buttons.find(button => button.textContent?.includes('Open logs'))!.click())
  expect(startInstall).toHaveBeenCalledOnce()
  expect(openLogDir).toHaveBeenCalledOnce()
})
