import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createProjectWorkingCopy, validateWorkingProjectName } from './project-working-copy'

const git = promisify(execFile)

let temporary: string
let source: string
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'youtab-working-copy-test-'))
  source = path.join(temporary, 'source')
  await fs.mkdir(source)
})
afterEach(async () => {
  vi.unstubAllEnvs()

  if (!path.basename(temporary).startsWith('youtab-working-copy-test-') || path.dirname(temporary) !== os.tmpdir()) {
    throw new Error('Refusing cleanup outside the synthetic test directory')
  }

  await fs.rm(temporary, { recursive: true, force: true })
})

async function absent(file: string) {
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('independent working copy', () => {
  it('copies ordinary files and empty folders, excludes prior copies/Git, and edits only the new files', async () => {
    await fs.mkdir(path.join(source, 'nested', 'empty'), { recursive: true })
    await fs.writeFile(path.join(source, 'notes.md'), 'original synthetic notes')
    const binary = Buffer.from([0, 1, 7, 128, 255])
    await fs.writeFile(path.join(source, 'nested', 'data.bin'), binary)
    await fs.writeFile(path.join(source, '.git'), 'gitdir: ../outside-original-git')
    await fs.mkdir(path.join(source, 'nested', '.git'))
    await fs.writeFile(path.join(source, 'nested', '.git', 'config'), 'synthetic git config')
    await fs.mkdir(path.join(source, 'Youtab', 'old'), { recursive: true })
    await fs.writeFile(path.join(source, 'Youtab', 'old', 'keep.md'), 'prior copy')
    const result = await createProjectWorkingCopy(source, 'Demo فارسی')
    expect(result).toEqual({
      sourcePath: source,
      workingPath: path.join(source, 'Youtab', 'Demo فارسی'),
      copiedFiles: 2,
      copiedBytes: 29
    })
    expect(await fs.readFile(path.join(result.workingPath, 'nested', 'data.bin'))).toEqual(binary)
    expect((await fs.stat(path.join(result.workingPath, 'nested', 'empty'))).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(result.workingPath, '.git'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(result.workingPath, '.git', 'config'), 'utf8')).not.toContain(
      'outside-original-git'
    )
    expect(await fs.readdir(path.join(result.workingPath, '.git'))).not.toContain('hooks')
    await absent(path.join(result.workingPath, 'nested', '.git'))
    await absent(path.join(result.workingPath, 'Youtab'))
    await fs.writeFile(path.join(result.workingPath, 'notes.md'), 'edited copy')
    expect(await fs.readFile(path.join(source, 'notes.md'), 'utf8')).toBe('original synthetic notes')
    expect(await fs.readFile(path.join(source, 'Youtab', 'old', 'keep.md'), 'utf8')).toBe('prior copy')
  })

  it('creates an independent Git root even with inherited original-repository redirects and templates', async () => {
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    )

    cleanEnv.GIT_CONFIG_NOSYSTEM = '1'
    cleanEnv.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    await git('git', ['init', '--quiet', '--template=', '--', source], { env: cleanEnv, windowsHide: true })
    const configBefore = await fs.readFile(path.join(source, '.git', 'config'), 'utf8')
    const headBefore = await fs.readFile(path.join(source, '.git', 'HEAD'), 'utf8')
    await fs.writeFile(path.join(source, 'original.txt'), 'synthetic source')
    const templates = path.join(temporary, 'templates')
    await fs.mkdir(path.join(templates, 'hooks'), { recursive: true })
    await fs.writeFile(path.join(templates, 'hooks', 'pre-commit'), 'synthetic inherited hook')
    vi.stubEnv('GIT_DIR', path.join(source, '.git'))
    vi.stubEnv('GIT_WORK_TREE', source)
    vi.stubEnv('GIT_TEMPLATE_DIR', templates)
    const result = await createProjectWorkingCopy(source, 'Independent')

    const root = await git('git', ['rev-parse', '--show-toplevel'], {
      cwd: result.workingPath,
      env: cleanEnv,
      windowsHide: true
    })

    const gitDir = await git('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: result.workingPath,
      env: cleanEnv,
      windowsHide: true
    })

    expect(path.resolve(root.stdout.trim())).toBe(path.resolve(result.workingPath))
    expect(path.resolve(gitDir.stdout.trim())).toBe(path.join(result.workingPath, '.git'))
    expect(await fs.readFile(path.join(source, '.git', 'config'), 'utf8')).toBe(configBefore)
    expect(await fs.readFile(path.join(source, '.git', 'HEAD'), 'utf8')).toBe(headBefore)
    expect(await fs.readFile(path.join(source, 'original.txt'), 'utf8')).toBe('synthetic source')
    await absent(path.join(result.workingPath, '.git', 'hooks'))
    expect(
      (await git('git', ['remote'], { cwd: result.workingPath, env: cleanEnv, windowsHide: true })).stdout.trim()
    ).toBe('')
  })

  it('never merges with or overwrites an existing target', async () => {
    await fs.writeFile(path.join(source, 'input.txt'), 'original')
    const first = await createProjectWorkingCopy(source, 'Demo')
    await fs.writeFile(path.join(first.workingPath, 'input.txt'), 'existing edited copy')
    await expect(createProjectWorkingCopy(source, 'Demo')).rejects.toThrow('already exists')
    expect(await fs.readFile(path.join(first.workingPath, 'input.txt'), 'utf8')).toBe('existing edited copy')
    expect(await fs.readFile(path.join(source, 'input.txt'), 'utf8')).toBe('original')
  })

  it.each(['', '..', '../escape', 'a/b', 'a\\b', 'file:stream', 'CON', 'NUL.txt', 'LPT1', 'bad.', 'x'.repeat(81)])(
    'rejects invalid or escaping name %j before creating anything',
    async name => {
      expect(() => validateWorkingProjectName(name)).toThrow()
      await expect(createProjectWorkingCopy(source, name)).rejects.toThrow()
      await absent(path.join(source, 'Youtab'))
    }
  )

  it('rejects linked source children before creating a working folder', async () => {
    const outside = path.join(temporary, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'original.txt'), 'outside synthetic data')
    await fs.symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createProjectWorkingCopy(source, 'Demo')).rejects.toThrow('linked')
    await absent(path.join(source, 'Youtab'))
    expect(await fs.readFile(path.join(outside, 'original.txt'), 'utf8')).toBe('outside synthetic data')
  })

  it('rejects a linked source root and linked destination container', async () => {
    const linked = path.join(temporary, 'source-link')
    await fs.symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createProjectWorkingCopy(linked, 'Demo')).rejects.toThrow('Linked')
    const outside = path.join(temporary, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(source, 'Youtab'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createProjectWorkingCopy(source, 'Demo')).rejects.toThrow('Linked')
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('refuses a relative source', async () => {
    await expect(createProjectWorkingCopy('relative/source', 'Demo')).rejects.toThrow('absolute source')
  })
})
