import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveReadableFileForIpc } from './hardening'

/** User-requested, byte-preserving export. Never executes the file or loads
 * large binaries into renderer memory. Existing sensitive-path rules apply. */
export async function exportFileCopy(
  sourcePath: string,
  chooseDestination: (name: string) => Promise<string | null>
): Promise<boolean> {
  return (await exportFileCopyResult(sourcePath, chooseDestination)).status === 'saved'
}

export type FileExportResult = { status: 'saved'; path: string } | { status: 'cancelled' }

export async function exportFileCopyResult(
  sourcePath: string,
  chooseDestination: (name: string) => Promise<string | null>,
  exclusive = false
): Promise<FileExportResult> {
  const source = await resolveReadableFileForIpc(sourcePath, { purpose: 'File download' })
  const destination = await chooseDestination(path.basename(source.realPath))

  if (!destination) {
    return { status: 'cancelled' }
  }

  const verified = await resolveReadableFileForIpc(sourcePath, { purpose: 'File download' })

  if (verified.realPath !== source.realPath || verified.stat.ino !== source.stat.ino) {
    throw new Error('File changed while choosing a download destination')
  }

  const handle = await fs.promises.open(verified.realPath, 'r')

  try {
    const opened = await handle.stat()

    if (!opened.isFile() || opened.ino !== verified.stat.ino || opened.dev !== verified.stat.dev) {
      throw new Error('File changed before download')
    }

    const existing = await fs.promises.stat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }

      return null
    })

    if (existing && existing.ino === opened.ino && existing.dev === opened.dev) {
      if (exclusive) {
        throw Object.assign(new Error('Download name is already in use'), { code: 'EEXIST' })
      }

      return { status: 'cancelled' }
    }

    const staged = path.join(path.dirname(destination), `.youtab-download-${randomUUID()}.tmp`)
    let created = false

    try {
      const output = await fs.promises.open(staged, 'wx', 0o600)
      created = true

      try {
        const block = Buffer.allocUnsafe(64 * 1024)
        let position = 0

        while (position < opened.size) {
          const { bytesRead } = await handle.read(block, 0, Math.min(block.length, opened.size - position), position)

          if (!bytesRead) {
            throw new Error('File became shorter during download')
          }

          let written = 0

          while (written < bytesRead) {
            const { bytesWritten } = await output.write(block, written, bytesRead - written, position + written)

            if (!bytesWritten) {
              throw new Error('Download stopped before completion')
            }

            written += bytesWritten
          }

          position += bytesRead
        }

        await output.sync()
      } finally {
        await output.close()
      }

      const after = await handle.stat()

      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new Error('File changed during download')
      }

      if (exclusive) {
        await fs.promises.link(staged, destination)
      } else {
        await fs.promises.rename(staged, destination)
      }
    } finally {
      if (created) {
        await fs.promises.rm(staged, { force: true })
      }
    }

    return { status: 'saved', path: destination }
  } finally {
    await handle.close()
  }
}
