import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { exportFileCopyResult, type FileExportResult } from './file-export'
import { resolveReadableFileForIpc, resolveRequestedPathForIpc } from './hardening'

export const GENERATED_EXPORT_MAX_BYTES = 16 * 1024 * 1024
export type ExportMode = 'download' | 'save-as'
interface DownloadHost {
  downloadsDirectory: string
  chooseDestination: (defaultPath: string) => Promise<string | null>
  maxBytes?: number
}

function standardFilePath(value: string): string {
  if (!path.isAbsolute(value) && !/^file:/i.test(value)) {
    throw new Error('An absolute file path is required.')
  }

  const resolved = resolveRequestedPathForIpc(value, { purpose: 'File download' })

  if (process.platform === 'win32' && resolved.slice(2).includes(':')) {
    throw new Error('Alternate data streams are not supported.')
  }

  return resolved
}

export function safeDownloadName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 240 ||
    [...value].some(character => character.charCodeAt(0) < 32) ||
    /[<>:"/\\|?*]/.test(value) ||
    value === '.' ||
    value === '..' ||
    /[. ]$/.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  ) {
    throw new Error('Choose a plain file name without a path or reserved characters.')
  }

  return value
}

function modeOf(value: unknown): ExportMode {
  if (value !== 'download' && value !== 'save-as') {
    throw new Error('Invalid download action.')
  }

  return value
}

async function directoryForDownload(host: DownloadHost, create = true): Promise<string> {
  if (!path.isAbsolute(host.downloadsDirectory)) {
    throw new Error('Downloads folder is unavailable.')
  }

  const directory = resolveRequestedPathForIpc(host.downloadsDirectory, { purpose: 'Download destination' })

  if (!create) {
    return directory
  }

  await fs.mkdir(directory, { recursive: true })
  const metadata = await fs.lstat(directory)

  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Downloads folder must be a regular directory.')
  }

  return directory
}

async function destinationFor(
  name: string,
  mode: ExportMode,
  host: DownloadHost,
  save: (destination: string, exclusive: boolean) => Promise<FileExportResult>
): Promise<FileExportResult> {
  safeDownloadName(name)
  const directory = await directoryForDownload(host, mode === 'download')

  if (mode === 'save-as') {
    const target = await host.chooseDestination(path.join(directory, name))

    if (!target) {
      return { status: 'cancelled' }
    }

    if (!path.isAbsolute(target)) {
      throw new Error('Save destination must be an absolute local path.')
    }

    const destination = standardFilePath(target)
    const metadata = await fs.lstat(path.dirname(destination))

    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Save destination has an unsupported linked parent.')
    }

    return save(destination, false)
  }

  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length)

  for (let index = 0; index < 100; index++) {
    const target = path.join(directory, index ? `${stem} (${index})${extension}` : name)

    try {
      return await save(target, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }

  throw new Error('Too many downloads have this name. Choose Save as.')
}

export async function downloadExistingFile(request: unknown, host: DownloadHost): Promise<FileExportResult> {
  const value = request as { path?: unknown; mode?: unknown }

  if (!value || typeof value.path !== 'string') {
    throw new Error('A source file is required.')
  }

  const mode = modeOf(value.mode)
  const sourcePath = standardFilePath(value.path)
  // Validate before any chooser or destination effect. The export itself
  // repeats admission around the chooser and holds the opened file identity.
  const source = await resolveReadableFileForIpc(sourcePath, { purpose: 'File download' })
  const name = safeDownloadName(path.basename(source.realPath))

  return destinationFor(name, mode, host, async (destination, exclusive) => {
    const current = await resolveReadableFileForIpc(sourcePath, { purpose: 'File download' })

    if (
      current.realPath !== source.realPath ||
      current.stat.ino !== source.stat.ino ||
      current.stat.dev !== source.stat.dev ||
      current.stat.size !== source.stat.size ||
      current.stat.mtimeMs !== source.stat.mtimeMs
    ) {
      throw new Error('File changed while choosing a download destination.')
    }

    return exportFileCopyResult(sourcePath, async () => destination, exclusive)
  })
}

export async function downloadGeneratedContent(request: unknown, host: DownloadHost): Promise<FileExportResult> {
  const value = request as { name?: unknown; data?: unknown; mode?: unknown }

  if (!value) {
    throw new Error('Generated content is required.')
  }

  const name = safeDownloadName(value.name)
  const mode = modeOf(value.mode)
  const data = value.data
  const maximum = host.maxBytes ?? GENERATED_EXPORT_MAX_BYTES

  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096 * 1024 * 1024) {
    throw new Error('Download size limit is unavailable.')
  }

  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > maximum) {
    throw new Error(`Generated downloads must contain between 1 byte and ${maximum / 1024 / 1024} MiB.`)
  }

  // Snapshot the bounded IPC bytes; never fetch a renderer-supplied URL.
  const bytes = Buffer.from(data)

  if (/\.pdf$/i.test(name) && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('PDF downloads require real PDF bytes. Save HTML or Markdown in its original format.')
  }

  return destinationFor(name, mode, host, async (destination, exclusive) => {
    const staged = path.join(path.dirname(destination), `.youtab-download-${randomUUID()}.tmp`)
    let created = false

    try {
      const handle = await fs.open(staged, 'wx', 0o600)
      created = true

      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }

      if (exclusive) {
        await fs.link(staged, destination)
      } else {
        await fs.rename(staged, destination)
      }

      return { status: 'saved', path: destination }
    } finally {
      if (created) {
        await fs.rm(staged, { force: true })
      }
    }
  })
}

/** Reveal only an existing admitted file; never execute it via openPath. */
export async function revealDownloadedFile(target: unknown, reveal: (file: string) => void): Promise<boolean> {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw new Error('A saved absolute file path is required.')
  }

  const file = await resolveReadableFileForIpc(standardFilePath(target), { purpose: 'Reveal saved download' })
  reveal(file.realPath)

  return true
}
