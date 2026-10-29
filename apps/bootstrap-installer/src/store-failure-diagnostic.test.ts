import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.mocked(invoke).mockImplementation(command => {
    const results: Record<string, string> = {
      get_log_path: 'setup.log', get_youtab_home: 'C:\\private',
      get_mode: 'install', get_installation_kind: 'fresh', get_release_channel: 'stable'
    }

    return command in results ? Promise.resolve(results[command]) : Promise.reject('unexpected command')
  })
  vi.mocked(listen).mockResolvedValue(() => {})
})

test('native failure retains only validated support context for the UI', async () => {
  const store = await import('./store')
  await store.initialize()
  const callback = vi.mocked(listen).mock.calls[0][1]
  callback({ payload: {
    type: 'failed', stage: 'dependencies', error: 'Installation step failed.',
    diagnostic: { stage: 'dependencies', operation_id: '123e4567-e89b-42d3-a456-426614174000' }
  } } as never)
  expect(store.$bootstrap.get().failureDiagnostic).toEqual({
    stage: 'dependencies', operationId: '123e4567-e89b-42d3-a456-426614174000'
  })

  callback({ payload: {
    type: 'failed', stage: 'dependencies', error: 'Installation step failed.',
    diagnostic: { stage: 'credential=opaque', operation_id: 'not-a-uuid' }
  } } as never)
  expect(store.$bootstrap.get().failureDiagnostic).toBeUndefined()
})
