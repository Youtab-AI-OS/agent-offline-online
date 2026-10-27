import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  downloadExistingFile,
  downloadGeneratedContent,
  GENERATED_EXPORT_MAX_BYTES,
  revealDownloadedFile,
  safeDownloadName
} from './native-download'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtab-native-download-'))
})
afterEach(async () => {
  if (
    !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(root).startsWith('youtab-native-download-')
  ) {
    throw new Error('Fixture escaped its temporary boundary')
  }

  await fs.rm(root, { recursive: true, force: true })
})

const host = () => ({
  downloadsDirectory: path.join(root, 'Downloads'),
  chooseDestination: vi.fn(async () => path.join(root, 'chosen.txt'))
})

it('downloads real PDF and UTF-8 Persian bytes to known unique paths without changing source files', async () => {
  const h = host()
  const source = path.join(root, 'report.pdf')
  const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC PDF EXPORT BYTES\n%%EOF')
  await fs.writeFile(source, pdf)
  const first = await downloadExistingFile({ path: source, mode: 'download' }, h)
  const second = await downloadExistingFile({ path: source, mode: 'download' }, h)
  expect(first).toEqual({ status: 'saved', path: path.join(h.downloadsDirectory, 'report.pdf') })
  expect(second).toEqual({ status: 'saved', path: path.join(h.downloadsDirectory, 'report (1).pdf') })
  expect(h.chooseDestination).not.toHaveBeenCalled()
  expect(await fs.readFile(source)).toEqual(pdf)

  if (first.status === 'saved') {
    expect(await fs.readFile(first.path)).toEqual(pdf)
  }

  if (first.status === 'saved') {
    expect(await downloadExistingFile({ path: first.path, mode: 'download' }, h)).toEqual({
      status: 'saved',
      path: path.join(h.downloadsDirectory, 'report (2).pdf')
    })
  }

  const text = 'سلام\n<h1>گزارش</h1>'

  const generated = await downloadGeneratedContent(
    { name: 'گزارش.html', mode: 'download', data: new TextEncoder().encode(text) },
    h
  )

  expect(generated.status).toBe('saved')

  if (generated.status === 'saved') {
    expect(await fs.readFile(generated.path, 'utf8')).toBe(text)
  }
})
it('Save as returns the actual chosen path and cancellation writes no final file', async () => {
  const h = host()
  const destination = path.join(root, 'گزارش انتخاب شده.md')
  await fs.writeFile(destination, 'PREVIOUS SYNTHETIC FILE')
  h.chooseDestination.mockResolvedValue(destination)

  const result = await downloadGeneratedContent(
    { name: 'report.md', mode: 'save-as', data: new TextEncoder().encode('# سلام') },
    h
  )

  expect(result).toEqual({ status: 'saved', path: destination })
  expect(await fs.readFile(destination, 'utf8')).toBe('# سلام')
  expect(h.chooseDestination).toHaveBeenCalledWith(path.join(h.downloadsDirectory, 'report.md'))
  h.chooseDestination.mockResolvedValue(null)
  expect(
    await downloadGeneratedContent({ name: 'cancelled.md', mode: 'save-as', data: new Uint8Array([1]) }, h)
  ).toEqual({ status: 'cancelled' })
  await expect(fs.stat(path.join(h.downloadsDirectory, 'cancelled.md'))).rejects.toThrow()
})
it.each(['../secret.txt', 'C:\\output.txt', 'bad/name.txt', 'CON.txt', 'nul', 'bad\0name.txt', 'bad?.txt', '..'])(
  'rejects unsafe or reserved suggested filename %s',
  name => {
    expect(() => safeDownloadName(name)).toThrow()
  }
)
it('rejects missing and sensitive sources before invoking a chooser', async () => {
  const h = host()
  const secret = path.join(root, '.env')
  await fs.writeFile(secret, 'SYNTHETIC')
  await expect(downloadExistingFile({ path: secret, mode: 'save-as' }, h)).rejects.toThrow()
  await expect(downloadExistingFile({ path: path.join(root, 'missing.pdf'), mode: 'save-as' }, h)).rejects.toThrow()
  expect(h.chooseDestination).not.toHaveBeenCalled()
})
it('rejects replacement during Save as and leaves an existing destination untouched', async () => {
  const h = host()
  const source = path.join(root, 'source.csv')
  const destination = path.join(root, 'existing.csv')
  await fs.writeFile(source, 'original')
  await fs.writeFile(destination, 'KEEP')
  h.chooseDestination.mockImplementation(async () => {
    await fs.rename(source, path.join(root, 'old.csv'))
    await fs.writeFile(source, 'replacement')

    return destination
  })
  await expect(downloadExistingFile({ path: source, mode: 'save-as' }, h)).rejects.toThrow('File changed')
  expect(await fs.readFile(destination, 'utf8')).toBe('KEEP')
})
it('retains an existing target and cleans owned staging when save promotion fails', async () => {
  const h = host()
  const destination = path.join(root, 'existing')
  await fs.mkdir(destination)
  await fs.writeFile(path.join(destination, 'keep'), 'KEEP')
  h.chooseDestination.mockResolvedValue(destination)
  await expect(
    downloadGeneratedContent({ name: 'report.md', mode: 'save-as', data: new Uint8Array([1, 2]) }, h)
  ).rejects.toThrow()
  expect(await fs.readFile(path.join(destination, 'keep'), 'utf8')).toBe('KEEP')
  expect((await fs.readdir(root)).some(name => name.startsWith('.youtab-download-'))).toBe(false)
})
it('rejects generated content above its bound and HTML disguised as PDF', async () => {
  const h = host()
  await expect(
    downloadGeneratedContent(
      { name: 'report.md', mode: 'download', data: new Uint8Array(GENERATED_EXPORT_MAX_BYTES + 1) },
      h
    )
  ).rejects.toThrow('16 MiB')
  await expect(
    downloadGeneratedContent(
      { name: 'report.pdf', mode: 'download', data: new TextEncoder().encode('<html>not a PDF</html>') },
      h
    )
  ).rejects.toThrow('real PDF bytes')
  expect(h.chooseDestination).not.toHaveBeenCalled()
})
it('honours the native configured byte cap without accepting a renderer cap override', async () => {
  const h = { ...host(), maxBytes: 2 }
  await expect(
    downloadGeneratedContent({ name: 'report.md', mode: 'download', data: new Uint8Array(3), maxBytes: 100 }, h)
  ).rejects.toThrow()
  expect(
    (
      await downloadGeneratedContent(
        { name: 'report.md', mode: 'download', data: new Uint8Array(3) },
        { ...h, maxBytes: 3 }
      )
    ).status
  ).toBe('saved')
})
it('blocks sensitive targets reached through a directory junction before any destination effect', async () => {
  const secret = path.join(root, '.ssh')
  await fs.mkdir(secret)
  await fs.writeFile(path.join(secret, 'report.txt'), 'SYNTHETIC SECRET')
  const alias = path.join(root, 'alias')
  await fs.symlink(secret, alias, 'junction')
  const h = host()
  await expect(downloadExistingFile({ path: path.join(alias, 'report.txt'), mode: 'save-as' }, h)).rejects.toThrow()
  expect(h.chooseDestination).not.toHaveBeenCalled()
})
it('does not follow a linked download destination and reveals only an existing admitted file', async () => {
  const real = path.join(root, 'real')
  await fs.mkdir(real)
  const linked = path.join(root, 'linked')
  await fs.symlink(real, linked, 'junction')
  await expect(
    downloadGeneratedContent(
      { name: 'report.md', mode: 'download', data: new Uint8Array([1]) },
      { ...host(), downloadsDirectory: linked }
    )
  ).rejects.toThrow('regular directory')
  const file = path.join(root, 'report.md')
  await fs.writeFile(file, 'SYNTHETIC')
  const reveal = vi.fn()
  expect(await revealDownloadedFile(file, reveal)).toBe(true)
  expect(reveal).toHaveBeenCalledWith(await fs.realpath(file))
  await expect(revealDownloadedFile('https://example.com/report', reveal)).rejects.toThrow()
  expect(reveal).toHaveBeenCalledOnce()
})
