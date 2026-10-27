import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ list: vi.fn(), files: vi.fn(), preview: vi.fn(), restore: vi.fn() }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }))
vi.mock('@/store/profile', () => ({ $activeGatewayProfile: atom('default') }))
vi.mock('@/store/projects', () => ({
  $activeProjectId: atom('p_synthetic'),
  $projects: atom([{ id: 'p_synthetic', name: 'Synthetic', primary_path: 'C:/Synthetic' }]),
  listProjectBackups: (...args: unknown[]) => io.list(...args),
  projectBackupFiles: (...args: unknown[]) => io.files(...args),
  previewProjectRestore: (...args: unknown[]) => io.preview(...args),
  restoreProjectFiles: (...args: unknown[]) => io.restore(...args)
}))
import { $activeGatewayProfile } from '@/store/profile'

import { ProjectBackupsPanel } from './project-backups-panel'
beforeEach(() => {
  vi.clearAllMocks()
  $activeGatewayProfile.set('default')
  io.list.mockResolvedValue({
    backups: [
      {
        id: 'snapshot',
        created_at: 1,
        files: 1,
        roots: 1,
        manifest_sha256: 'h',
        retained_directory: 'C:/Synthetic/Youtab/retained/snapshot'
      }
    ]
  })
  io.files.mockResolvedValue({ files: [{ path: 'document.md', size: 4 }], total: 1, offset: 0, next_offset: null })
  io.preview.mockResolvedValue({
    token: 'preview',
    files: [{ path: 'document.md', changed: true, current_sha256: 'new', backup_sha256: 'old' }],
    chats_changed: false,
    expires_in_seconds: 300
  })
  io.restore.mockResolvedValue({
    status: 'RESTORED',
    files: ['document.md'],
    chats_changed: false,
    undo_receipt: { id: 'undo' }
  })
})
afterEach(cleanup)

async function preview() {
  render(<ProjectBackupsPanel />)
  fireEvent.click(screen.getByRole('button', { name: 'Load verified backups' }))
  await screen.findByRole('combobox', { name: 'Choose a backup' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Choose a backup' }), { target: { value: 'snapshot' } })
  expect(screen.getByText('C:/Synthetic/Youtab/retained/snapshot')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Load files' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'document.md' }))
  fireEvent.click(screen.getByRole('button', { name: 'Preview selected files' }))
  await screen.findByRole('button', { name: 'Confirm file restore' })
}

it('requires current preview and separate explicit confirmation, preserving chats', async () => {
  await preview()
  expect(io.restore).not.toHaveBeenCalled()
  expect(io.preview).toHaveBeenCalledWith('p_synthetic', 'snapshot', ['document.md'])
  fireEvent.click(screen.getByRole('button', { name: 'Confirm file restore' }))
  await screen.findByText('Files restored.')
  expect(io.restore).toHaveBeenCalledWith('p_synthetic', 'snapshot', 'preview')
})
it('shows partial recovery with actual undo backup instead of success', async () => {
  io.restore.mockResolvedValue({
    status: 'PARTIAL',
    files: [],
    error: 'synthetic disk error',
    chats_changed: false,
    undo_receipt: { id: 'undo-snapshot' }
  })
  await preview()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm file restore' }))
  await screen.findByText(/Recovery incomplete.*undo-snapshot.*synthetic disk error/)
  expect(screen.queryByText('Files restored.')).toBeNull()
})
it('invalidates a pending preview when the profile changes', async () => {
  await preview()
  $activeGatewayProfile.set('other')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm file restore' })).toBeNull())
  expect(io.restore).not.toHaveBeenCalled()
})
