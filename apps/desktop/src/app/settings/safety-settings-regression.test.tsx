import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { YoutabConfigRecord } from '@/types/youtab'

import { ConfigSettings } from './config-settings'

const io = vi.hoisted(() => ({
  getConfig: vi.fn(), save: vi.fn(), schema: vi.fn(), error: vi.fn()
}))
vi.mock('@/youtab', () => ({
  getYoutabConfigRecord: () => io.getConfig(),
  getYoutabConfigSchema: () => io.schema(),
  saveYoutabConfig: (value: unknown) => io.save(value),
  getElevenLabsVoices: async () => ({ voices: [] }),
  setApiRequestProfile: () => {}
}))
vi.mock('@/store/notifications', () => ({notify: vi.fn(), notifyError: (...args: unknown[]) => io.error(...args)}))
vi.mock('@/store/projects', () => ({
  repoDiscoveryPolicyFromConfig: () => ({}),
  repoDiscoveryPolicySignature: () => '',
  scanAndRecordRepos: vi.fn()
}))

let stored: YoutabConfigRecord
beforeEach(() => {
  stored = { security: { redact_secrets: false, allow_private_urls: false }, approvals: { mode: 'manual', mcp_reload_confirm: true }, model: 'synthetic-model', custom_endpoint: 'synthetic-endpoint' }
  io.getConfig.mockImplementation(async () => structuredClone(stored))
  io.schema.mockResolvedValue({ fields: { 'security.redact_secrets': { type: 'boolean' }, 'approvals.mcp_reload_confirm': { type: 'boolean' } } })
  io.save.mockImplementation(async value => { stored = structuredClone(value); return {ok: true} })
})
afterEach(() => {cleanup(); vi.clearAllMocks()})
function mount() {
  return render(<MemoryRouter><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
    <ConfigSettings activeSectionId="safety" importInputRef={createRef<HTMLInputElement>()}/>
  </QueryClientProvider></MemoryRouter>)
}
async function redactionSwitch() {
  await screen.findByRole('heading', {name: 'Safety'})
  const row = document.getElementById('setting-field-security.redact_secrets')
  expect(row).toBeTruthy()
  return within(row!).getByRole('switch')
}
it('saves a Safety toggle through the existing config contract and preserves model and approval fields after reopening', async () => {
  const view = mount()
  fireEvent.click(await redactionSwitch())
  await waitFor(() => expect(io.save).toHaveBeenCalledTimes(1))
  expect(stored.security).toEqual({redact_secrets:true,allow_private_urls:false})
  expect(stored.approvals).toEqual({mode:'manual',mcp_reload_confirm:true})
  expect(stored.model).toBe('synthetic-model')
  expect(stored.custom_endpoint).toBe('synthetic-endpoint')
  view.unmount()
  mount()
  expect((await redactionSwitch()).getAttribute('aria-checked')).toBe('true')
})
it('reports a rejected Safety save instead of treating it as persisted', async () => {
  io.save.mockResolvedValue({ok:false})
  mount()
  fireEvent.click(await redactionSwitch())
  await waitFor(() => expect(io.error).toHaveBeenCalledTimes(1))
  expect(stored.security).toEqual({redact_secrets:false,allow_private_urls:false})
})

