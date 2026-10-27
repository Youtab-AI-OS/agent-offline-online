import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { beforeEach, expect, test, vi } from 'vitest'

import { $bootstrap, $route, initialize } from './store'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  $route.set('welcome')
  $bootstrap.set({ status: 'idle', protocolVersion: null, stages: {}, stageOrder: [],
    currentStage: null, installRoot: null, error: null, logs: [] })
})

test('registered home conflict shows preserving migration guidance without retrying an install', async () => {
  vi.mocked(invoke).mockImplementation(command => {
    if (command === 'get_log_path') { return Promise.resolve(null) }

    if (command === 'get_youtab_home') { return Promise.resolve('C:\\stale') }

    if (command === 'get_mode') { return Promise.resolve('install') }

    if (command === 'get_installation_kind') { return Promise.reject('customer home selection refused: home-binding-conflict') }

    return Promise.reject('unexpected native command')
  })

  await initialize()

  expect($route.get()).toBe('failure')
  expect($bootstrap.get().status).toBe('failed')
  expect($bootstrap.get().errorCode).toBe('home-binding-conflict')
  expect($bootstrap.get().error).toContain('preserving migration')
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    'get_log_path', 'get_youtab_home', 'get_mode', 'get_installation_kind'
  ])
})

test('native repair handoff starts preserving bootstrap instead of update', async () => {
  vi.mocked(listen).mockResolvedValue(() => {})
  vi.mocked(invoke).mockImplementation(command => {
    if (command === 'get_log_path') {return Promise.resolve('setup.log')}

    if (command === 'get_youtab_home') {return Promise.resolve('C:\\private')}

    if (command === 'get_mode') {return Promise.resolve('repair')}

    if (command === 'get_release_channel') {return Promise.resolve('pilot')}

    if (command === 'start_bootstrap') {return Promise.resolve(null)}

    return Promise.reject(`unexpected native command: ${command}`)
  })

  await initialize()

  expect($route.get()).toBe('progress')
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    'get_log_path', 'get_youtab_home', 'get_mode', 'get_release_channel', 'start_bootstrap'
  ])
  expect(vi.mocked(invoke).mock.calls.at(-1)?.[1]).toMatchObject({
    args: { include_desktop: true, migrate_legacy: false, release_channel: 'pilot' }
  })
})
