import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, expect, test } from 'vitest'
import { createBackgroundReleaseHandle } from './mock-server'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

test('sentinel is absent until release; release and cleanup remain idempotent', () => {
  const handle = createBackgroundReleaseHandle()
  cleanups.push(handle.cleanup)
  expect(fs.existsSync(handle.path)).toBe(false)
  if (process.platform !== 'win32') expect(fs.statSync(path.dirname(handle.path)).mode & 0o777).toBe(0o700)
  handle.release(); handle.release()
  expect(fs.readFileSync(handle.path, 'utf8')).toBe('release')
  if (process.platform !== 'win32') expect(fs.statSync(handle.path).mode & 0o777).toBe(0o600)
  handle.cleanup(); handle.cleanup()
  expect(fs.existsSync(path.dirname(handle.path))).toBe(false)
})

test('release never truncates a linked victim or removes an unowned leaf', () => {
  const handle = createBackgroundReleaseHandle()
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-victim-'))
  const victim = path.join(fixture, 'victim')
  fs.writeFileSync(victim, 'preserve', { flag: 'wx', mode: 0o600 })
  fs.linkSync(victim, handle.path)
  cleanups.push(() => { fs.unlinkSync(handle.path); handle.cleanup(); fs.rmSync(fixture, { recursive: true }) })
  handle.release(); handle.cleanup()
  expect(fs.readFileSync(victim, 'utf8')).toBe('preserve')
  expect(fs.existsSync(handle.path)).toBe(true)
})

test('cleanup preserves a replacement sentinel file', () => {
  const handle = createBackgroundReleaseHandle()
  handle.release()
  fs.unlinkSync(handle.path)
  const replacement = path.join(path.dirname(handle.path), 'replacement')
  fs.writeFileSync(replacement, 'new-owner', { flag: 'wx', mode: 0o600 })
  fs.renameSync(replacement, handle.path)
  cleanups.push(() => { fs.unlinkSync(handle.path); handle.cleanup() })
  handle.cleanup()
  expect(fs.readFileSync(handle.path, 'utf8')).toBe('new-owner')
})

test('owned native child stays alive until the test releases its sentinel', async () => {
  const handle = createBackgroundReleaseHandle()
  cleanups.push(handle.cleanup)
  const script = `const fs=require('node:fs');console.log('ready');setTimeout(()=>process.exit(2),2000);setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},10)`
  const child = spawn(process.execPath, ['-e', script, handle.path], { stdio: ['ignore', 'pipe', 'pipe'] })
  const finished = once(child, 'exit')
  try {
    await once(child.stdout!, 'data')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(child.exitCode).toBe(null)
    expect(fs.existsSync(handle.path)).toBe(false)
    handle.release()
    expect((await finished)[0]).toBe(0)
  } finally {
    // The owned child has a two-second deadline, including assertion failures.
    await finished
  }
})
