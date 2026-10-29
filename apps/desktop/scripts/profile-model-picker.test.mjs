import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { writeModelPickerProfile } from './profile-model-picker.mjs'

const owned = []
afterEach(() => { vi.restoreAllMocks(); for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function tempRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-profile-test-')); owned.push(root); return root }

test('profiles use distinct exclusive directories and preserve JSON', () => {
  const root = tempRoot()
  const victim = path.join(root, 'victim')
  const legacy = path.join(root, 'model-picker-open.cpuprofile')
  fs.writeFileSync(victim, 'preserve')
  fs.linkSync(victim, legacy)
  const profile = { nodes: [{ id: 1, callFrame: { functionName: 'quote\"\\line' } }], samples: [1] }
  const first = writeModelPickerProfile(profile, { tempRoot: root })
  const second = writeModelPickerProfile(profile, { tempRoot: root })
  assert.notEqual(first, second)
  assert.equal(path.basename(first), 'model-picker-open.cpuprofile')
  assert.deepEqual(JSON.parse(fs.readFileSync(first, 'utf8')), profile)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserve')
  assert.equal(fs.statSync(first).nlink, 1)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(first)).mode & 0o777, 0o700)
    assert.equal(fs.statSync(first).mode & 0o777, 0o600)
  }
})

test('profile write failure removes only its owned entries', () => {
  const root = tempRoot()
  const sentinel = path.join(root, 'sentinel')
  fs.writeFileSync(sentinel, 'preserve')
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('synthetic flush failure') })
  assert.throws(() => writeModelPickerProfile({ samples: [] }, { tempRoot: root }), /flush failure/)
  assert.deepEqual(fs.readdirSync(root), ['sentinel'])
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve')
})


test('exclusive profile create refuses a planted link without touching victim', () => {
  const root = tempRoot()
  const victim = path.join(root, 'victim')
  fs.writeFileSync(victim, 'preserve')
  const realOpen = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if (String(file).endsWith('model-picker-open.cpuprofile')) fs.linkSync(victim, file)
    return realOpen(file, flags, mode)
  })
  assert.throws(() => writeModelPickerProfile({ samples: [] }, { tempRoot: root }), /EEXIST/)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserve')
})
