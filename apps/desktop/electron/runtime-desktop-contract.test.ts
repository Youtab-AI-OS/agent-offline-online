import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { verifyYoutabCli } from './backend-probes'
import { hasManagedRuntimeEvidence, managedRuntimeLaunch, parseRuntimeDesktopContract, routeManagedRuntimeFailure } from './runtime-desktop-contract'

const sourceSha = 'a'.repeat(40)
const contract = {
  schemaVersion: 1,
  sourceSha,
  version: '0.19.2',
  entrypoint: 'venv/Scripts/youtab.exe',
  capabilities: ['serve']
}

function fixture(value: object = contract) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n', 'utf8')
  const marker = {
    pinnedCommit: sourceSha,
    version: '0.19.2',
    artifactSha256: 'b'.repeat(64),
    runtimeContractSha256: crypto.createHash('sha256').update(bytes).digest('hex')
  }
  return { bytes, marker }
}

test('verified binary runtime contract selects the console entrypoint without the Python module prefix', () => {
  const { bytes, marker } = fixture()
  const parsed = parseRuntimeDesktopContract(bytes, marker)
  assert.deepEqual(parsed, { version: '0.19.2', sourceSha, supportsServe: true })
  assert.deepEqual(managedRuntimeLaunch(parsed, true, false, ['serve', '--port', '0']), {
    kind: 'command', args: ['serve', '--port', '0']
  })
})

test('contract cannot be inferred from source text or unbound/tampered metadata', () => {
  const { bytes, marker } = fixture()
  assert.equal(parseRuntimeDesktopContract(bytes, null), null)
  assert.equal(parseRuntimeDesktopContract(bytes, { ...marker, runtimeContractSha256: '0'.repeat(64) }), null)
  assert.equal(parseRuntimeDesktopContract(bytes, { ...marker, artifactSha256: undefined }), null)
  assert.equal(parseRuntimeDesktopContract(bytes, { ...marker, pinnedCommit: 'c'.repeat(40) }), null)
  assert.equal(parseRuntimeDesktopContract(bytes, { ...marker, version: '0.19.1' }), null)
  assert.equal(managedRuntimeLaunch(null, true, false, ['serve']), null)
  assert.equal(managedRuntimeLaunch(parseRuntimeDesktopContract(bytes, marker), false, false, ['serve']), null)
})

test('a contract invalidated after backend selection restores Python module arguments atomically', () => {
  const { bytes, marker } = fixture()
  const selected = managedRuntimeLaunch(parseRuntimeDesktopContract(bytes, marker), true, true, ['serve', '--port', '0'])
  assert.deepEqual(selected, { kind: 'command', args: ['serve', '--port', '0'] })
  assert.deepEqual(managedRuntimeLaunch(null, false, true, selected!.args), {
    kind: 'python', args: ['-m', 'youtab_agent_cli.main', 'serve', '--port', '0']
  })
  assert.equal(managedRuntimeLaunch(null, false, false, selected!.args), null)
})

test('a stale native CLI cannot be selected and four-part release versions remain compatible', () => {
  const fourPart = fixture({ ...contract, version: '0.19.2.1' })
  const parsed = parseRuntimeDesktopContract(fourPart.bytes, { ...fourPart.marker, version: '0.19.2.1' })
  assert.equal(parsed?.version, '0.19.2.1')
  assert.equal(managedRuntimeLaunch(parsed, false, false, ['serve']), null)
  assert.deepEqual(managedRuntimeLaunch(parsed, false, true, ['serve']), {
    kind: 'python', args: ['-m', 'youtab_agent_cli.main', 'serve']
  })
})

test('packaged customer repairs a corrupt managed CLI without probing an external PATH candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-managed-cli-'))
  try {
    const cli = path.join(root, 'youtab.exe')
    fs.writeFileSync(cli, 'corrupt executable')
    assert.equal(verifyYoutabCli(cli), false)
    assert.equal(verifyYoutabCli(process.execPath), true, 'an unrelated PATH executable is independently runnable')
    const evidence = hasManagedRuntimeEvidence({ artifactSha256: 'corrupt digest' }, false)
    let externalDiscovered = false
    const backend = routeManagedRuntimeFailure(
      true, evidence, false,
      () => ({ kind: 'bootstrap-needed', command: null }),
      () => {
        externalDiscovered = true
        return { kind: 'command', command: process.execPath }
      }
    )
    assert.deepEqual(backend, { kind: 'bootstrap-needed', command: null })
    assert.equal(externalDiscovered, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('legacy or development installs retain external discovery without managed customer evidence', () => {
  const external = () => 'external Youtab CLI'
  const repair = () => 'Setup repair'
  assert.equal(routeManagedRuntimeFailure(false, true, false, repair, external), 'external Youtab CLI')
  assert.equal(routeManagedRuntimeFailure(true, false, false, repair, external), 'external Youtab CLI')
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-legacy-root-'))
  try {
    assert.equal(fs.statSync(legacyRoot).isDirectory(), true)
    const legacyEvidence = hasManagedRuntimeEvidence({ pinnedCommit: 'a'.repeat(40) }, false)
    assert.equal(legacyEvidence, false)
    assert.equal(routeManagedRuntimeFailure(true, legacyEvidence, false, repair, external), 'external Youtab CLI')
  } finally {
    fs.rmSync(legacyRoot, { recursive: true, force: true })
  }
  assert.equal(hasManagedRuntimeEvidence({ runtimeContractSha256: 'b'.repeat(64) }, false), true)
  assert.equal(hasManagedRuntimeEvidence(null, true), true)
})

test('contract rejects unexpected entrypoints and capabilities', () => {
  for (const value of [
    { ...contract, entrypoint: '../../outside.exe' },
    { ...contract, capabilities: ['dashboard'] },
    { ...contract, capabilities: ['serve', 'untrusted'] },
    { ...contract, schemaVersion: 2 },
    { ...contract, extra: true }
  ]) {
    const { bytes, marker } = fixture(value)
    assert.equal(parseRuntimeDesktopContract(bytes, marker), null)
  }
})
