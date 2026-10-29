import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const directories = []
const prior = process.env.YOUTAB_AGENT_TUI_VISUAL_DIR
beforeEach(() => { delete process.env.YOUTAB_AGENT_TUI_VISUAL_DIR; vi.resetModules() })
afterEach(() => {
  vi.restoreAllMocks()
  if (prior === undefined) delete process.env.YOUTAB_AGENT_TUI_VISUAL_DIR
  else process.env.YOUTAB_AGENT_TUI_VISUAL_DIR = prior
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

test('default output is a unique owned directory with retained HTML and PNG artifacts', async () => {
  const first = await import('./paths.mjs')
  const directory = first.visualOutDir(); directories.push(directory)
  expect(first.visualOutDir()).toBe(directory)
  first.writeVisualOutput(directory, 'tui-visual.html', '<p>scene</p>')
  first.writeVisualOutput(directory, 'tui-visual.png', Buffer.from([137, 80, 78, 71]))
  expect(fs.readFileSync(path.join(directory, 'tui-visual.html'), 'utf8')).toBe('<p>scene</p>')
  expect([...fs.readFileSync(path.join(directory, 'tui-visual.png'))]).toEqual([137, 80, 78, 71])
  expect(fs.readdirSync(directory).sort()).toEqual(['tui-visual.html', 'tui-visual.png'])
  if (process.platform !== 'win32') {
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(directory, 'tui-visual.html')).mode & 0o777).toBe(0o600)
  }
  vi.resetModules()
  const second = await import('./paths.mjs')
  const other = second.visualOutDir(); directories.push(other)
  expect(other).not.toBe(directory)
})

test('explicit output override keeps existing unrelated files and permits atomic rerender', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-override-')); directories.push(directory)
  process.env.YOUTAB_AGENT_TUI_VISUAL_DIR = directory
  fs.writeFileSync(path.join(directory, 'keep'), 'retain', { flag: 'wx', mode: 0o600 })
  const { visualOutDir, writeVisualOutput } = await import('./paths.mjs')
  expect(visualOutDir()).toBe(fs.realpathSync(directory))
  writeVisualOutput(visualOutDir(), 'tui-visual.html', 'first')
  writeVisualOutput(visualOutDir(), 'tui-visual.html', 'second')
  expect(fs.readFileSync(path.join(directory, 'keep'), 'utf8')).toBe('retain')
  expect(fs.readFileSync(path.join(directory, 'tui-visual.html'), 'utf8')).toBe('second')
})

test('atomic output never truncates linked victims and preserves old output on publication failure', async () => {
  const { visualOutDir, writeVisualOutput } = await import('./paths.mjs')
  const directory = visualOutDir(); directories.push(directory)
  const victim = path.join(directory, 'victim')
  fs.writeFileSync(victim, 'preserve', { flag: 'wx', mode: 0o600 })
  fs.linkSync(victim, path.join(directory, 'tui-visual.html'))
  writeVisualOutput(directory, 'tui-visual.html', 'scene')
  expect(fs.readFileSync(victim, 'utf8')).toBe('preserve')
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('publication denied') })
  expect(() => writeVisualOutput(directory, 'tui-visual.html', 'failed')).toThrow('publication denied')
  expect(fs.readFileSync(path.join(directory, 'tui-visual.html'), 'utf8')).toBe('scene')
  expect(fs.readdirSync(directory).sort()).toEqual(['tui-visual.html', 'victim'])
  expect(() => writeVisualOutput(directory, '../escape', 'invalid')).toThrow()
})

test('selected output alias resolves once and writes retained artifacts to its target', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-alias-')); directories.push(parent)
  const target = path.join(parent, 'target'); fs.mkdirSync(target, { mode: 0o700 })
  const alias = path.join(parent, 'alias')
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  process.env.YOUTAB_AGENT_TUI_VISUAL_DIR = alias
  const { visualOutDir, writeVisualOutput } = await import('./paths.mjs')
  expect(visualOutDir()).toBe(fs.realpathSync(target))
  writeVisualOutput(visualOutDir(), 'tui-visual.html', 'scene')
  expect(fs.readFileSync(path.join(target, 'tui-visual.html'), 'utf8')).toBe('scene')
})

const launches = vi.hoisted(() => [])
vi.mock('child_process', () => ({ spawnSync: (...args) => { launches.push(args); return { status: 0 } } }))

test('launcher passes exactly one selected directory through render and screenshot stages', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-handoff-')); directories.push(directory)
  process.env.YOUTAB_AGENT_TUI_VISUAL_DIR = directory
  const electron = process.env.ELECTRON_BIN
  process.env.ELECTRON_BIN = process.execPath
  try {
    launches.length = 0
    await import('./run.mjs')
    expect(launches.length).toBe(2)
    expect(launches[0][1].at(-1)).toContain('render.tsx')
    expect(launches[1][1].at(-1)).toContain('shot.mjs')
    expect(launches[0][2].env.YOUTAB_AGENT_TUI_VISUAL_DIR).toBe(fs.realpathSync(directory))
    expect(launches[1][2].env.YOUTAB_AGENT_TUI_VISUAL_DIR).toBe(fs.realpathSync(directory))
  } finally {
    if (electron === undefined) delete process.env.ELECTRON_BIN
    else process.env.ELECTRON_BIN = electron
  }
})

test('screenshot profile cleanup owns only its namespace and does not follow junction targets', async () => {
  const { visualOutDir, createVisualProfile, checkedVisualProfile } = await import('./paths.mjs')
  const directory = visualOutDir(); directories.push(directory)
  const profile = createVisualProfile(directory)
  expect(checkedVisualProfile(directory, profile.path)).toBe(profile.path)
  const victimDirectory = path.join(directory, 'retained'); fs.mkdirSync(victimDirectory, { mode: 0o700 })
  const victim = path.join(victimDirectory, 'victim')
  fs.writeFileSync(victim, 'preserve', { flag: 'wx', mode: 0o600 })
  fs.symlinkSync(victimDirectory, path.join(profile.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  profile.cleanup(); profile.cleanup()
  expect(fs.existsSync(profile.path)).toBe(false)
  expect(fs.readFileSync(victim, 'utf8')).toBe('preserve')
  expect(() => checkedVisualProfile(directory, victimDirectory)).toThrow()
})

test('screenshot profile cleanup refuses a replaced directory', async () => {
  const { visualOutDir, createVisualProfile } = await import('./paths.mjs')
  const directory = visualOutDir(); directories.push(directory)
  const profile = createVisualProfile(directory)
  fs.renameSync(profile.path, path.join(directory, 'moved-profile'))
  fs.mkdirSync(profile.path, { mode: 0o700 })
  fs.writeFileSync(path.join(profile.path, 'replacement'), 'preserve', { flag: 'wx', mode: 0o600 })
  profile.cleanup()
  expect(fs.readFileSync(path.join(profile.path, 'replacement'), 'utf8')).toBe('preserve')
})
