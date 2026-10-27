import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vitest'

const nativePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build/native/setup_lease.node')
type Addon = { protocol(): string, acquire(file: string, sha: string, size: number): unknown, release(lease: unknown): void }

test.skipIf(process.platform !== 'win32' || !fs.existsSync(nativePath))('native Setup lease holds the named image and its parent directory through concurrent callers', () => {
  const native = createRequire(import.meta.url)(nativePath) as Addon
  assert.equal(native.protocol(), 'youtab.setup-lease/napi-v1')
  assert.equal(typeof native.acquire, 'function')
  assert.equal(typeof native.release, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-lease-'))
  const parent = path.join(root, 'parent')
  fs.mkdirSync(parent)
  const executable = path.join(parent, 'Youtab-Setup.exe')
  const image = Buffer.alloc(512, 0x41)
  fs.writeFileSync(executable, image)
  const digest = createHash('sha256').update(image).digest('hex')

  try {
    assert.throws(() => native.acquire(`${executable}:alternate`, digest, image.length), /SETUP_LEASE_INPUT/)
    assert.throws(() => native.acquire(`\\\\?\\${executable}`, digest, image.length), /SETUP_LEASE_INPUT/)
    assert.throws(() => native.acquire(executable, 'b'.repeat(64), image.length), /SETUP_LEASE_IDENTITY/)
    const writer = fs.openSync(executable, 'r+')

    try { assert.throws(() => native.acquire(executable, digest, image.length), /SETUP_LEASE_IDENTITY/) }
    finally { fs.closeSync(writer) }

    const l1 = native.acquire(executable, digest, image.length)
    const l2 = native.acquire(executable, digest, image.length)

    try {
      assert.throws(() => fs.writeFileSync(executable, Buffer.alloc(512, 0x42)))
      assert.throws(() => fs.renameSync(executable, `${executable}.old`))
      assert.throws(() => fs.renameSync(parent, `${parent}.old`))
      native.release(l1)
      assert.throws(() => fs.writeFileSync(executable, Buffer.alloc(512, 0x42)))
    } finally { native.release(l1); native.release(l2) }

    fs.writeFileSync(executable, Buffer.alloc(512, 0x42))
    assert.throws(() => native.acquire(executable, digest, image.length), /SETUP_LEASE_IDENTITY/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'win32' || !fs.existsSync(nativePath))('native Setup lease rejects multi-link files', context => {
  const native = createRequire(import.meta.url)(nativePath) as Addon
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-lease-link-'))
  const executable = path.join(root, 'Youtab-Setup.exe')
  const linked = path.join(root, 'linked.exe')
  const image = Buffer.alloc(512, 0x41)
  fs.writeFileSync(executable, image)

  try {
    try { fs.linkSync(executable, linked) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip();

 return }

      throw error
    }

    assert.throws(() => native.acquire(executable, createHash('sha256').update(image).digest('hex'), image.length), /SETUP_LEASE_IDENTITY/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'win32' || !fs.existsSync(nativePath))('native Setup lease rejects reparse aliases in file and parent', context => {
  const native = createRequire(import.meta.url)(nativePath) as Addon
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-lease-reparse-'))
  const real = path.join(root, 'real')
  const parentAlias = path.join(root, 'alias')
  fs.mkdirSync(real)
  const executable = path.join(real, 'Youtab-Setup.exe')
  const fileAlias = path.join(real, 'alias.exe')
  const image = Buffer.alloc(512, 0x41)
  fs.writeFileSync(executable, image)
  try {
    try {
      fs.symlinkSync(executable, fileAlias, 'file')
      fs.symlinkSync(real, parentAlias, 'junction')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return }
      throw error
    }
    const digest = createHash('sha256').update(image).digest('hex')

    assert.throws(() => native.acquire(fileAlias, digest, image.length), /SETUP_LEASE_IDENTITY/)
    assert.throws(() => native.acquire(path.join(parentAlias, 'Youtab-Setup.exe'), digest, image.length), /SETUP_LEASE_NAMESPACE/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
