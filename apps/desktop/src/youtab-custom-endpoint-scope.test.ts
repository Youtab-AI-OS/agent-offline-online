import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activateCustomEndpoint,
  deleteCustomEndpoint,
  getCustomEndpoints,
  saveCustomEndpoint,
  setApiRequestProfile,
  validateCustomEndpoint
} from './youtab'

describe('custom endpoint requests target the selected gateway profile', () => {
  const api = vi.fn(async (_request: { path: string; profile?: string }) => ({}) as never)
  const endpoint = { name: 'Local test', base_url: 'http://127.0.0.1:16471/v1', model: 'test-local' }

  beforeEach(() => {
    ;(window as { youtabDesktop?: unknown }).youtabDesktop = { api }
    api.mockClear()
  })

  afterEach(() => {
    setApiRequestProfile(null)
    delete (window as { youtabDesktop?: unknown }).youtabDesktop
  })

  it('keeps single-profile calls on the existing primary backend', async () => {
    await getCustomEndpoints()
    expect(api.mock.calls[0][0]).not.toHaveProperty('profile')
  })

  it('scopes listing, validation, save, activation and removal to the active profile', async () => {
    setApiRequestProfile('synthetic-local-profile')
    await getCustomEndpoints()
    await validateCustomEndpoint(endpoint)
    await saveCustomEndpoint(endpoint)
    await activateCustomEndpoint('local/test')
    await deleteCustomEndpoint('local/test')

    expect(api.mock.calls).toHaveLength(5)
    expect(api.mock.calls.map(([request]) => request.path)).toEqual([
      '/api/providers/custom-endpoints',
      '/api/providers/custom-endpoints/validate',
      '/api/providers/custom-endpoints',
      '/api/providers/custom-endpoints/local%2Ftest/activate',
      '/api/providers/custom-endpoints/local%2Ftest'
    ])
    for (const [request] of api.mock.calls) {expect(request.profile).toBe('synthetic-local-profile')}
  })
})
