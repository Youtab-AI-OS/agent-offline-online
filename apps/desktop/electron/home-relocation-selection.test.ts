import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { boundProcessHome, readRelocationJournal, relocatedProcessHome } from './home-relocation-selection'

test('relocation requires an unchanged single-link journal', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-relocation-journal-'))
  const file = path.join(directory, 'journal.json')
  const linked = path.join(directory, 'other.json')
  const oldHome = 'C:\\old-youtab'
  const newHome = 'C:\\new-youtab'

  const journal = {
    schema: 1,
    phase: 'product-validated',
    publication: { phase: 'published' },
    source: oldHome,
    target: newHome
  }

  try {
    fs.writeFileSync(file, JSON.stringify(journal))
    expect(relocatedProcessHome(oldHome, newHome, readRelocationJournal(file))).toBe(newHome)

    fs.linkSync(file, linked)
    expect(readRelocationJournal(file)).toBeNull()
    fs.unlinkSync(linked)

    fs.truncateSync(file, 16 * 1024 * 1024 + 1)
    expect(readRelocationJournal(file)).toBeNull()
  } finally {
    if (fs.existsSync(linked)) { fs.unlinkSync(linked) }

    if (fs.existsSync(file)) { fs.unlinkSync(file) }
    fs.rmdirSync(directory)
  }
})

test('packaged Desktop refuses a stale inherited home without a completed relocation', () => {
  const oldHome = 'C:\\Users\\Alice\\AppData\\Local\\youtab'
  const registeredHome = 'C:\\Users\\Alice\\Youtab'
  expect(boundProcessHome(registeredHome.toLowerCase(), registeredHome, null, true)).toBe(registeredHome.toLowerCase())
  expect(() => boundProcessHome(oldHome, registeredHome, null, true)).toThrow('YOUTAB_HOME_BINDING_CONFLICT')
  expect(boundProcessHome(oldHome, registeredHome, null, false)).toBe(oldHome)
  expect(boundProcessHome(oldHome, registeredHome, {
    schema: 1, phase: 'product-validated', publication: { phase: 'published' },
    source: oldHome, target: registeredHome
  }, true)).toBe(registeredHome)
})
