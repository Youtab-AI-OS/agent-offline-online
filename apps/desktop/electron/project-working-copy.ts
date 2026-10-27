import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { ProjectWorkingCopy } from '../src/types/project-working-copy'

const execFileAsync = promisify(execFile)

const MAX_FILES = 100_000
const MAX_BYTES = 8 * 1024 ** 3
const MAX_DEPTH = 128

export function validateWorkingProjectName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Enter a project name.')
  }

  const name = value.trim()

  if (
    !name ||
    name.length > 80 ||
    /[<>:"/\\|?*]/.test(name) ||
    Array.from(name).some(character => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    name === '.' ||
    name === '..' ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error('Use a project name of 1–80 characters, without path separators or reserved file names.')
  }

  return name
}

// Inspect every ancestor too: resolving a selected junction first would hide it.
async function checkedDirectory(dir: string): Promise<void> {
  const absolute = path.resolve(dir)
  let current = path.parse(absolute).root

  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = await fs.lstat(current)

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Linked or non-directory paths cannot be copied: ${current}`)
    }
  }

  const resolved = await fs.realpath(absolute)

  if (path.relative(absolute, resolved) !== '') {
    throw new Error(`The folder resolves outside its selected path: ${dir}`)
  }
}

interface CopyEntry {
  relative: string
  size: number
  dev: number
  ino: number
  mtimeMs: number
  mode: number
}

/**
 * Read the selected source and create independent files under Youtab/name.
 * Existing targets are never merged or overwritten. Git metadata is deliberately
 * excluded: a worktree .git file can point back at the original repository.
 * This is a copy operation, not an OS sandbox for subsequent agent tools.
 */
export async function createProjectWorkingCopy(
  source: string,
  rawName: unknown,
  gitBinary = 'git'
): Promise<ProjectWorkingCopy> {
  const name = validateWorkingProjectName(rawName)

  if (!path.isAbsolute(source)) {
    throw new Error('Choose an absolute source folder with the native folder picker.')
  }

  const sourcePath = path.resolve(source)
  await checkedDirectory(sourcePath)
  const copyRoot = path.join(sourcePath, 'Youtab')
  const workingPath = path.join(copyRoot, name)
  const entries: CopyEntry[] = []
  const directories: string[] = []
  let bytes = 0
  let entryCount = 0

  async function scan(dir: string, relative: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      throw new Error('The selected folder is too deeply nested to copy safely.')
    }

    await checkedDirectory(dir)

    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === '.git' || (!relative && entry.name.toLowerCase() === 'youtab')) {
        continue
      }

      if (++entryCount > MAX_FILES) {
        throw new Error('Choose a smaller project folder (maximum 100,000 entries).')
      }

      const next = path.join(relative, entry.name)
      const filePath = path.join(sourcePath, next)
      const stat = await fs.lstat(filePath)

      if (stat.isSymbolicLink()) {
        throw new Error(`Remove linked files or folders from the selection before copying: ${filePath}`)
      }

      if (stat.isDirectory()) {
        directories.push(next)
        await scan(filePath, next, depth + 1)
      } else if (stat.isFile()) {
        bytes += stat.size

        if (bytes > MAX_BYTES) {
          throw new Error('Choose a smaller project folder (maximum 8 GiB).')
        }

        entries.push({
          relative: next,
          size: stat.size,
          dev: stat.dev,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          mode: stat.mode
        })
      } else {
        throw new Error(`Only ordinary files and folders can be copied: ${filePath}`)
      }
    }
  }

  // Validate the whole source before creating any working files.
  await scan(sourcePath, '', 0)
  await checkedDirectory(sourcePath)

  try {
    await fs.mkdir(copyRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  await checkedDirectory(copyRoot)

  // Atomic, non-recursive mkdir refuses any existing file/folder with this name.
  try {
    await fs.mkdir(workingPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A working copy already exists. Choose another project name: ${workingPath}`)
    }

    throw error
  }

  let copiedFiles = 0

  try {
    for (const relative of directories) {
      const target = path.join(workingPath, relative)
      await checkedDirectory(path.dirname(target))
      await fs.mkdir(target)
    }

    for (const entry of entries) {
      const original = path.join(sourcePath, entry.relative)
      const target = path.join(workingPath, entry.relative)
      await checkedDirectory(path.dirname(original))
      await checkedDirectory(path.dirname(target))
      const stat = await fs.lstat(original)

      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.dev !== entry.dev ||
        stat.ino !== entry.ino ||
        stat.size !== entry.size ||
        stat.mtimeMs !== entry.mtimeMs
      ) {
        throw new Error(
          `A source file changed during copying. Close other editors and try a new project name: ${original}`
        )
      }

      const input = await fs.open(original, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))

      try {
        const opened = await input.stat()

        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
          throw new Error(`The source file changed during copying: ${original}`)
        }

        const output = await fs.open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          entry.mode & 0o777
        )

        try {
          // Bounded buffers keep large project copies off the renderer and avoid
          // stream auto-close races while the file handles are identity-checked.
          const buffer = Buffer.allocUnsafe(1024 * 1024)
          let position = 0

          while (position < entry.size) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, entry.size - position), position)

            if (!bytesRead) {
              throw new Error(`The source file became shorter while copying: ${original}`)
            }

            let written = 0

            while (written < bytesRead) {
              const result = await output.write(buffer, written, bytesRead - written, position + written)

              if (!result.bytesWritten) {
                throw new Error(`Could not finish writing the copy: ${target}`)
              }

              written += result.bytesWritten
            }

            position += bytesRead
          }

          const final = await input.stat()

          if (final.size !== entry.size || final.mtimeMs !== entry.mtimeMs) {
            throw new Error(`The source file changed during copying: ${original}`)
          }
        } finally {
          await output.close()
        }
      } finally {
        await input.close()
      }

      copiedFiles += 1
    }

    await checkedDirectory(workingPath)

    // Without a fresh .git directory, Git would walk upward into the source
    // repository. Do not inherit gitdir/worktree redirects, templates or hooks.
    const gitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    )

    gitEnv.GIT_CONFIG_NOSYSTEM = '1'
    gitEnv.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    gitEnv.GIT_TERMINAL_PROMPT = '0'
    const options = { cwd: workingPath, env: gitEnv, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }
    await execFileAsync(gitBinary, ['init', '--quiet', '--template=', '--', workingPath], options)
    const gitRoot = await execFileAsync(gitBinary, ['rev-parse', '--show-toplevel'], options)

    if (path.relative(workingPath, path.resolve(gitRoot.stdout.trim())) !== '') {
      throw new Error('Git did not confirm an independent working repository.')
    }

    await checkedDirectory(workingPath)

    return { sourcePath, workingPath, copiedFiles, copiedBytes: bytes }
  } catch (error) {
    // Never recursively delete a folder after an asynchronous filesystem error.
    // Keep the partial copy visible, preserve source files and don't register it.
    throw new Error(
      `Working copy was not completed; no project was opened. The original files were not written. Partial copy: ${workingPath}. ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
