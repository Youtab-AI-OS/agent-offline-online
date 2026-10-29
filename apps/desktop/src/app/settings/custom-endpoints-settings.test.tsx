import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestProfile } from '@/youtab'

import { CustomEndpointsSettings } from './custom-endpoints-settings'

const notify = vi.hoisted(() => vi.fn())
const notifyError = vi.hoisted(() => vi.fn())
vi.mock('@/store/notifications', () => ({ notify, notifyError }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))

interface Request {
  path: string
  method?: string
  body?: Record<string, unknown>
  profile?: string
}
const api = vi.fn<(request: Request) => Promise<unknown>>()
const url = 'http://127.0.0.1:16471'

const discovered = {
  ok: true,
  reachable: true,
  base_url: `${url}/v1`,
  models: ['test-local-a', 'test-local-b'],
  message: ''
}

beforeEach(() => {
  setApiRequestProfile('endpoint-test')
  ;(window as { youtabDesktop?: unknown }).youtabDesktop = { api }
  api.mockReset()
  api.mockImplementation(async request => {
    if (request.method === 'POST') {
      if (request.path.endsWith('/validate')) {return discovered}

      return {
        ok: true,
        id: 'local-test',
        endpoints: [
          { ...request.body, models: request.body?.models ?? [request.body?.model], id: 'local-test', is_current: true }
        ]
      }
    }

    return { endpoints: [] }
  })
  notify.mockClear()
  notifyError.mockClear()
})

afterEach(() => {
  cleanup()
  setApiRequestProfile(null)
  delete (window as { youtabDesktop?: unknown }).youtabDesktop
})

async function form() {
  const changed = vi.fn()
  const saved = vi.fn()
  render(<CustomEndpointsSettings onConfigSaved={saved} onMainModelChanged={changed} />)
  await screen.findByLabelText('Model server address')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local test' } })
  fireEvent.change(screen.getByLabelText('Model server address'), { target: { value: url } })

  return { changed, saved }
}

describe('custom endpoint discovery and persistence', () => {
  it('keeps fresh local connections keyless without requiring advanced metadata', async () => {
    render(<CustomEndpointsSettings />)
    const address = await screen.findByLabelText('Model server address')
    fireEvent.change(address, { target: { value: '127.0.0.1:16471' } })
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('test-local-a'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.mock.calls.some(([request]) => request.method === 'POST' && !request.path.endsWith('/validate'))).toBe(true))
    const requests = api.mock.calls.filter(([request]) => request.method === 'POST').map(([request]) => request)
    expect(requests[0].body?.base_url).toBe('127.0.0.1:16471')
    expect(requests.every(request => request.body?.api_key === undefined)).toBe(true)
    expect(requests.at(-1)?.body?.name).toBe('test-local-a')
    expect(screen.queryByRole('checkbox', { name: 'Use without an API key' })).toBeNull()
  })

  it('sends explicit key removal for a saved keyed endpoint changed to an anonymous server', async () => {
    const endpoint = { id: 'saved-local', name: 'Saved local', base_url: `${url}/v1`, model: 'test-local-a', models: ['test-local-a'], discover_models: true, has_api_key: true, is_current: true }
    api.mockImplementation(async request => {
      if (request.path.endsWith('/validate')) {return discovered}

      if (request.method === 'POST') {return { ok: true, id: endpoint.id, endpoints: [{ ...endpoint, ...request.body, has_api_key: false }] }}

      return { endpoints: [endpoint] }
    })
    render(<CustomEndpointsSettings />)
    await screen.findByLabelText('Model server address')
    fireEvent.change(screen.getByLabelText('Model server address'), { target: { value: '127.0.0.1:16472/v1' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use without an API key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('test-local-a'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.mock.calls.some(([request]) => request.method === 'POST' && !request.path.endsWith('/validate'))).toBe(true))
    const posts = api.mock.calls.filter(([request]) => request.method === 'POST').map(([request]) => request)
    expect(posts.every(request => request.body?.api_key === '')).toBe(true)
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('')
  })

  it('invalidates a pending saved-key probe when the user selects no key', async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const endpoint = { id: 'saved-local', name: 'Saved local', base_url: `${url}/v1`, model: 'test-local-a', models: ['test-local-a'], discover_models: true, has_api_key: true, is_current: true }
    api.mockImplementation(async request => request.path.endsWith('/validate') ? pending : { endpoints: [endpoint] })
    render(<CustomEndpointsSettings />)
    await screen.findByLabelText('Model server address')
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use without an API key' }))
    await act(async () => { finish(discovered); await pending })
    expect(notify).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })
  it('starts with no configured address and uses address guidance rather than a conflicting localhost example', async () => {
    render(<CustomEndpointsSettings />)
    const address = (await screen.findByLabelText('Model server address')) as HTMLInputElement
    expect(address.value).toBe('')
    expect(address.placeholder).toBe('Paste the address shown by your model server')
    expect(screen.getByText(/machine running the selected Gateway/)).toBeTruthy()
    expect(screen.getByText('Advanced settings').closest('details')?.open).toBe(false)
  })

  it('drops the old model when endpoint A changes to B and chooses a model B actually advertises', async () => {
    await form()
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('test-local-a'))
    fireEvent.change(screen.getByLabelText('Model server address'), { target: { value: `${url}/server-b/v1` } })
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    api.mockResolvedValueOnce({ ok: true, reachable: true, models: ['server-b-model'], message: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('server-b-model'))
    expect(screen.queryByRole('option', { name: 'test-local-a' })).toBeNull()
  })

  it('tests a saved endpoint by ID without exposing its stored key to the renderer', async () => {
    const endpoint = {
      id: 'saved-local',
      name: 'Saved local',
      base_url: `${url}/v1`,
      model: 'test-local-a',
      models: ['test-local-a'],
      discover_models: true,
      has_api_key: true,
      is_current: true
    }

    api.mockImplementation(async request =>
      request.path.endsWith('/validate') ? discovered : { endpoints: [endpoint] }
    )
    render(<CustomEndpointsSettings />)
    await screen.findByLabelText('Model server address')
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    await waitFor(() => expect(api.mock.calls.some(([request]) => request.path.endsWith('/validate'))).toBe(true))
    const request = api.mock.calls.find(([value]) => value.path.endsWith('/validate'))![0]
    expect(request.body).toMatchObject({ id: 'saved-local', base_url: `${url}/v1` })
    expect(request.body?.api_key).toBeUndefined()
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('')
  })
  it('persists the working discovered URL and model catalogue through the actual API helper', async () => {
    const { changed, saved } = await form()
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('test-local-a'))
    expect((screen.getByLabelText('Model server address') as HTMLInputElement).value).toBe(`${url}/v1`)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saved).toHaveBeenCalledOnce())
    const request = api.mock.calls.find(([value]) => value.method === 'POST' && !value.path.endsWith('/validate'))![0]
    expect(request).toMatchObject({
      profile: 'endpoint-test',
      body: {
        name: 'Local test',
        base_url: `${url}/v1`,
        model: 'test-local-a',
        models: ['test-local-a', 'test-local-b']
      }
    })
    expect(changed).toHaveBeenCalledWith('local-test', 'test-local-a')
  })

  it.each(['Model server address', 'API Key'])('ignores an in-flight probe after %s changes', async field => {
    let finish!: (value: unknown) => void

    const pending = new Promise(resolve => {
      finish = resolve
    })

    api.mockImplementation(async request => (request.path.endsWith('/validate') ? pending : { endpoints: [] }))
    await form()
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    fireEvent.change(screen.getByLabelText(field), {
      target: { value: field === 'API Key' ? 'synthetic-key' : `${url}/other` }
    })
    await act(async () => {
      finish(discovered)
      await pending
    })

    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('option', { name: 'test-local-a' })).toBeNull()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not report a successful connection for an endpoint with no models', async () => {
    api.mockImplementation(async request =>
      request.path.endsWith('/validate')
        ? { ok: false, reachable: true, models: [], message: 'No models loaded.' }
        : { endpoints: [] }
    )
    await form()
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith({ kind: 'warning', message: 'No models loaded.' }))
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('invalidates a discovered catalogue when the target URL changes before save', async () => {
    await form()
    fireEvent.click(screen.getByRole('button', { name: 'Find models' }))
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('test-local-a'))
    fireEvent.change(screen.getByLabelText('Model server address'), { target: { value: `${url}/different/v1` } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enter a model ID manually' }))
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'manually-chosen-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.mock.calls.some(([request]) => request.method === 'POST' && !request.path.endsWith('/validate'))).toBe(
        true
      )
    )
    const request = api.mock.calls.find(([value]) => value.method === 'POST' && !value.path.endsWith('/validate'))![0]
    expect(request.body).toMatchObject({ base_url: `${url}/different/v1`, model: 'manually-chosen-model' })
    expect(request.body?.models).toBeUndefined()
  })

  it('surfaces persistence failure without claiming the model was changed', async () => {
    const { changed, saved } = await form()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enter a model ID manually' }))
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'manual-local' } })
    api.mockRejectedValueOnce(new Error('Synthetic save failure'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'Save failed'))
    expect(changed).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})
