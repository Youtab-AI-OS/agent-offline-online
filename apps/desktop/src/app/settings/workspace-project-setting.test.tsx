import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ prepare: vi.fn(), create: vi.fn(), enter: vi.fn(), context: 'local:default' }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }))
vi.mock('@/store/projects', () => ({
  captureProjectCreationContext: () => ({ profile: 'default', filesystemKey: io.context, gateway: null }),
  createProject: (...args: unknown[]) => io.create(...args),
  enterProject: (...args: unknown[]) => io.enter(...args)
}))
vi.mock('@/store/profile', () => ({ $activeGatewayProfile: atom('default') }))
vi.mock('@/store/session', () => ({ $connection: atom<{ mode: string } | null>({ mode: 'local' }) }))
vi.mock('@/lib/desktop-fs', () => ({
  desktopFsCacheKey: () => io.context,
  isDesktopFsRemoteMode: () => io.context.startsWith('remote:')
}))

import { $connection } from '@/store/session'

import { WorkspaceProjectSetting } from './workspace-project-setting'

const copy = {
  sourcePath: 'C:\\Synthetic',
  workingPath: 'C:\\Synthetic\\Youtab\\Demo',
  copiedFiles: 2,
  copiedBytes: 10
}

const oldDesktop = window.youtabDesktop
beforeEach(() => {
  vi.clearAllMocks()
  io.context = 'local:default'
  $connection.set({ mode: 'local' } as typeof $connection extends { get(): infer T } ? T : never)
  window.youtabDesktop = {
    settings: { prepareProjectWorkingCopy: io.prepare }
  } as unknown as typeof window.youtabDesktop
  io.prepare.mockResolvedValue(copy)
  io.create.mockResolvedValue({ id: 'p_synthetic', primary_path: copy.workingPath })
})
afterEach(() => {
  cleanup()
  window.youtabDesktop = oldDesktop
})

function start() {
  render(<WorkspaceProjectSetting />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: 'Demo' } })
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder and create project' }))
}

describe('Workspace project creation', () => {
  it('creates the real project using only the native-returned working path, then selects it', async () => {
    start()
    await screen.findByText('Project created. New project chats use this working folder:')
    expect(io.prepare).toHaveBeenCalledWith({ name: 'Demo', profile: 'default' })
    expect(io.create).toHaveBeenCalledWith(
      {
        name: 'Demo',
        workingCopy: { sourcePath: copy.sourcePath, workingPath: copy.workingPath },
        folders: [copy.workingPath],
        primaryPath: copy.workingPath,
        use: true
      },
      { profile: 'default', filesystemKey: 'local:default', gateway: null }
    )
    expect(io.enter).toHaveBeenCalledWith('p_synthetic')
    expect(io.create.mock.calls[0][0].folders).not.toContain(copy.sourcePath)
  })

  it('does not create or select any project when the native picker is canceled', async () => {
    io.prepare.mockResolvedValue(null)
    start()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose folder and create project' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    expect(io.create).not.toHaveBeenCalled()
    expect(io.enter).not.toHaveBeenCalled()
  })

  it('preserves the completed copy and reports failed gateway registration without selecting a fake project', async () => {
    io.create.mockRejectedValue(new Error('Synthetic gateway refusal'))
    start()
    expect((await screen.findByRole('alert')).textContent).toContain(copy.workingPath)
    expect(screen.getByRole('alert').textContent).toContain('Synthetic gateway refusal')
    expect(io.enter).not.toHaveBeenCalled()
  })

  it('does not pass a local filesystem path into a newly selected remote gateway', async () => {
    let finish!: (value: typeof copy) => void
    io.prepare.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    start()
    io.context = 'remote:other'
    finish(copy)
    expect((await screen.findByRole('alert')).textContent).toContain('active profile or gateway changed')
    expect(io.create).not.toHaveBeenCalled()
    expect(io.enter).not.toHaveBeenCalled()
  })

  it('keeps remote project paths on their existing flow and disables this local-only operation', () => {
    $connection.set({ mode: 'remote' } as typeof $connection extends { get(): infer T } ? T : never)
    io.context = 'remote:other'
    render(<WorkspaceProjectSetting />)
    expect(screen.getByRole('button', { name: 'Choose folder and create project' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/Remote projects keep their current folder workflow/)).toBeTruthy()
    expect(io.prepare).not.toHaveBeenCalled()
  })
})
