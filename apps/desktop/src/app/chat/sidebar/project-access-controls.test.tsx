import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import { ProjectAccessControls } from './project-access-controls'

const io = vi.hoisted(() => ({ files: vi.fn() }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en', t: {common: {close: 'Close'}} }) }))
vi.mock('@/store/layout', () => ({ setFileBrowserOpen: (...args: unknown[]) => io.files(...args) }))
vi.mock('../../settings/project-backups-panel', () => ({ ProjectBackupsPanel: () => <p>File recovery seam</p> }))
vi.mock('../../settings/workspace-project-setting', () => ({
  WorkspaceProjectSetting: () => <p>Workspace control seam</p>
}))

function Location() {
  return <output>{useLocation().pathname + useLocation().search}</output>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mount() {
  render(
    <MemoryRouter>
      <ProjectAccessControls />
      <Location />
    </MemoryRouter>
  )
}

it('opens the existing working-copy project controls without triggering the profile-create action', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: '+ PROJECT' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText('Workspace control seam')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Files and folders' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Tools' })).toBeTruthy()
})
it('opens the real file browser and closes only its dialog', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: '+ PROJECT' }))
  fireEvent.click(screen.getByRole('button', { name: 'Files and folders' }))
  expect(io.files).toHaveBeenCalledWith(true)
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('navigates Tools to the existing toolsets destination', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: '+ PROJECT' }))
  fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
  expect(screen.getByRole('status').textContent).toBe('/skills?tab=toolsets')
})
