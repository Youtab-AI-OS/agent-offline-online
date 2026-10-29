/**
 * Tests for electron/backend-probes.ts.
 *
 * Run with: node --test electron/backend-probes.test.ts
 * (Wired into npm test:desktop:platforms in package.json.)
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import {
  canImportYoutabCli,
  DEFAULT_PROBE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  resolveProbeTimeoutMs,
  shouldTrustYoutabOverride,
  verifyYoutabCli,
  youtabRuntimeImportProbe
} from './backend-probes'

// Resolve the host's own Node binary -- guaranteed to be on disk and
// runnable. We use it as both a stand-in for "a python that doesn't
// have youtab_agent_cli" (since `node -c "import youtab_agent_cli"` will exit
// non-zero) and as a way to script verifyYoutabCli's success path
// (a tiny script we write to disk that exits 0 on --version).
const NODE_BIN = process.execPath

test('canImportYoutabCli returns false when path is falsy', () => {
  assert.equal(canImportYoutabCli(''), false)
  assert.equal(canImportYoutabCli(null), false)
  assert.equal(canImportYoutabCli(undefined), false)
})

test('canImportYoutabCli returns false when interpreter cannot run -c', () => {
  // node IS an interpreter, but `node -c "import youtab_agent_cli"` is a
  // SyntaxError -- different exit reason from a real Python's
  // ModuleNotFoundError, but the predicate is "exit 0 or not" and
  // both land on "not", which is exactly what we want for the
  // resolver fall-through.
  assert.equal(canImportYoutabCli(NODE_BIN), false)
})

test('canImportYoutabCli returns false when binary does not exist', () => {
  const ghost = path.join(os.tmpdir(), 'youtab-probes-ghost-' + Date.now() + '.exe')
  assert.equal(canImportYoutabCli(ghost), false)
})

test('youtab runtime import probe checks config dependencies', () => {
  const probe = youtabRuntimeImportProbe()
  assert.match(probe, /\bimport yaml\b/)
  // dotenv is the first third-party import on the CLI boot path
  // (youtab_agent_cli/env_loader.py); a mid-update venv missing python-dotenv
  // passed the old probe and produced an unrecoverable boot loop.
  assert.match(probe, /\bimport dotenv\b/)
  assert.match(probe, /\bimport youtab_agent_cli\.config\b/)
})

test('explicit Youtab override is authoritative', () => {
  assert.equal(shouldTrustYoutabOverride('/nix/store/abc/bin/youtab'), true)
})

test('empty Youtab override is not authoritative', () => {
  assert.equal(shouldTrustYoutabOverride(''), false)
  assert.equal(shouldTrustYoutabOverride(undefined), false)
})

test('verifyYoutabCli returns false when command is falsy', () => {
  assert.equal(verifyYoutabCli(''), false)
  assert.equal(verifyYoutabCli(null), false)
  assert.equal(verifyYoutabCli(undefined), false)
})

test('verifyYoutabCli returns false when binary does not exist', () => {
  const ghost = path.join(os.tmpdir(), 'youtab-probes-ghost-' + Date.now() + '.exe')
  assert.equal(verifyYoutabCli(ghost), false)
})

test('verifyYoutabCli rejects a present but corrupt CLI executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-corrupt-cli-'))
  try {
    const cli = path.join(root, 'youtab.exe')
    fs.writeFileSync(cli, 'not a Windows executable')
    assert.equal(verifyYoutabCli(cli), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('verifyYoutabCli returns true when --version exits 0', () => {
  // The real Node executable supports --version and exits successfully.
  // No script fixture is invoked by verifyYoutabCli's fixed --version probe.
  assert.equal(verifyYoutabCli(NODE_BIN), true)
})

test('verifyYoutabCli swallows timeouts (does not throw)', () => {
  // We can't easily provoke a real hang in CI without slowing the
  // suite, but we CAN confirm that an invocation that DOES throw
  // (because the binary is missing) returns false rather than
  // propagating. Same code path the timeout case takes.
  assert.equal(verifyYoutabCli('/definitely/not/a/real/binary/anywhere'), false)
})

test('default probe timeout is 15s (not the old 5s death-loop value)', () => {
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 15_000)
  // Module constant uses process.env at load time; with no override it
  // matches the default (tests run without YOUTAB_AGENT_PROBE_TIMEOUT_MS).
  assert.equal(PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS)
})

test('resolveProbeTimeoutMs honours YOUTAB_AGENT_PROBE_TIMEOUT_MS', () => {
  assert.equal(resolveProbeTimeoutMs({}), DEFAULT_PROBE_TIMEOUT_MS)
  assert.equal(resolveProbeTimeoutMs({ YOUTAB_AGENT_PROBE_TIMEOUT_MS: '30000' }), 30_000)
  assert.equal(resolveProbeTimeoutMs({ YOUTAB_AGENT_PROBE_TIMEOUT_MS: '0' }), DEFAULT_PROBE_TIMEOUT_MS)
  assert.equal(resolveProbeTimeoutMs({ YOUTAB_AGENT_PROBE_TIMEOUT_MS: 'nope' }), DEFAULT_PROBE_TIMEOUT_MS)
  // Cap runaway values
  assert.equal(resolveProbeTimeoutMs({ YOUTAB_AGENT_PROBE_TIMEOUT_MS: '999999' }), 120_000)
})
