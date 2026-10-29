import { invoke } from '@tauri-apps/api/core'
import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

test('markerless existing Runtime shows a safe failure without retrying or throwing', async () => {
  vi.mocked(invoke).mockImplementation(command => {
    if (command === 'get_log_path') {return Promise.resolve('setup.log')}
    if (command === 'get_youtab_home') {return Promise.resolve('C:\\private')}
    if (command === 'get_mode') {return Promise.resolve('install')}
    if (command === 'get_installation_kind') {return Promise.reject('Installation needs review before replacement')}
    if (command === 'report_frontend_failure') {return Promise.resolve(null)}

    return Promise.reject('unexpected native command')
  })

  const store = await import('./store')
  await store.initialize()

  expect(store.$route.get()).toBe('failure')
  expect(store.$bootstrap.get().errorCode).toBe('startup-blocked')
  expect(store.$bootstrap.get().error).toContain('preserved its files')
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).not.toContain('start_bootstrap')
})
