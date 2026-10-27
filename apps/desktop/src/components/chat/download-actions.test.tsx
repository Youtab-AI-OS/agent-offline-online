import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { DownloadActions, MessageDownload, TextDownload } from './download-actions'
import { FileDownloadButton } from './file-download-button'

vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en', t: { artifactPreview: { download: 'Download' } } }) }))
vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))
vi.mock('@/lib/local-preview', () => ({
  normalizeOrLocalPreviewTarget: async (path: string) => ({ kind: 'file', path, label: 'report.pdf' })
}))

afterEach(() => {
  cleanup()
  $connection.set(null)
  delete (window as unknown as { youtabDesktop?: unknown }).youtabDesktop
  vi.restoreAllMocks()
})

function bridge(value: unknown) {
  Object.defineProperty(window, 'youtabDesktop', { configurable: true, writable: true, value })
}

it('shows real saved location and reveals it only after explicit Explorer click', async () => {
  const file = 'C:\\Users\\Tester\\Downloads\\گزارش.html'

  const exportContent = vi.fn(async (_request: { name: string; data: Uint8Array; mode: string }) => ({
    status: 'saved',
    path: file
  }))

  const revealExport = vi.fn(async () => true)
  bridge({ exportContent, revealExport })
  render(<TextDownload content="<h1>سلام</h1>" name="گزارش.html" />)
  expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save as…' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  await screen.findByText(file)
  expect(exportContent).toHaveBeenCalledWith({
    name: 'گزارش.html',
    data: new TextEncoder().encode('<h1>سلام</h1>'),
    mode: 'download'
  })
  expect(revealExport).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open in Explorer' }))
  await waitFor(() => expect(revealExport).toHaveBeenCalledWith(file))
})
it('Save as cancellation produces no saved location or Explorer action', async () => {
  const exportContent = vi.fn(async (_request: { name: string; data: Uint8Array; mode: string }) => ({
    status: 'cancelled'
  }))

  bridge({ exportContent })
  render(<TextDownload content="const value=1" name="code.ts" />)
  fireEvent.click(screen.getByRole('button', { name: 'Save as…' }))
  await waitFor(() => expect(exportContent).toHaveBeenCalled())
  expect(exportContent.mock.calls[0][0].mode).toBe('save-as')
  expect(screen.queryByText('Open in Explorer')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})
it('exports the actual message on demand and surfaces write failure without claiming success', async () => {
  const exportContent = vi.fn(async () => {
    throw new Error('SYNTHETIC DISK FAILURE')
  })

  bridge({ exportContent })
  render(<MessageDownload getMessageText={() => '# متن واقعی'} messageId="session/message" />)
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect((await screen.findByRole('alert')).textContent).toContain('SYNTHETIC DISK FAILURE')
  expect(exportContent).toHaveBeenCalledWith({
    name: 'youtab-response-session-message.md',
    data: new TextEncoder().encode('# متن واقعی'),
    mode: 'download'
  })
  expect(screen.queryByText('Open in Explorer')).toBeNull()
})
it('does not publish a saved path after the active profile changes', async () => {
  let finish!: (value: { status: 'saved'; path: string }) => void

  const pending = new Promise<{ status: 'saved'; path: string }>(resolve => {
    finish = resolve
  })

  bridge({ exportContent: vi.fn(), revealExport: vi.fn() })
  render(<DownloadActions identity="message-1" save={() => pending} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  await act(async () => {
    $connection.set({ mode: 'remote', profile: 'another', baseUrl: 'https://synthetic.invalid' } as never)
  })
  await act(async () => {
    finish({ status: 'saved', path: 'C:\\old-profile-file.md' })
    await pending
  })
  expect(screen.queryByText('C:\\old-profile-file.md')).toBeNull()
  expect(screen.queryByText('Open in Explorer')).toBeNull()
})
it('downloads remote bytes through the authenticated profile API and reveals only the local result', async () => {
  const path = '/srv/report.pdf'
  const pdf = '%PDF-1.7\nSYNTHETIC'
  $connection.set({ mode: 'remote', profile: 'qa-profile', baseUrl: 'https://synthetic.invalid' } as never)
  const api = vi.fn(async () => ({ dataUrl: `data:application/pdf;base64,${btoa(pdf)}` }))
  const local = 'C:\\Users\\Tester\\Downloads\\report.pdf'

  const exportContent = vi.fn(async (_request: { name: string; data: Uint8Array; mode: string }) => ({
    status: 'saved',
    path: local
  }))

  const exportFile = vi.fn()
  const revealExport = vi.fn(async () => true)
  bridge({ api, exportContent, exportFile, revealExport })
  render(<FileDownloadButton path={path} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  await screen.findByText(local)
  expect(api).toHaveBeenCalledWith({ path: '/api/fs/read-data-url?path=%2Fsrv%2Freport.pdf', profile: 'qa-profile' })
  expect(exportFile).not.toHaveBeenCalled()
  expect(new TextDecoder().decode(exportContent.mock.calls[0][0].data)).toBe(pdf)
  fireEvent.click(screen.getByRole('button', { name: 'Open in Explorer' }))
  await waitFor(() => expect(revealExport).toHaveBeenCalledWith(local))
  expect(revealExport).not.toHaveBeenCalledWith(path)
})
