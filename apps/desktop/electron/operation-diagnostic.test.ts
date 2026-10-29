import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'

import { test } from 'vitest'

import { createOperationId, OPERATION_ENV, prepareUpdateProgress, updateDiagnostic, validOperationId } from './operation-diagnostic'
import { spawnUpdaterProcessConfirmed } from './updater-process'

const id = '123e4567-e89b-42d3-a456-426614174000'

test('canonical operation metadata accepts UUIDv4 only and preserves inherited correlation', () => {
  assert.equal(validOperationId(id), id)
  assert.equal(createOperationId(id), id)

  for (const bad of ['', id.toUpperCase(), id + '\n', id.replace('-42d3-', '-12d3-'), 'password=synthetic', '00000000-0000-0000-0000-000000000000']) {
    assert.equal(validOperationId(bad), null)
    assert.ok(validOperationId(createOperationId(bad)))
  }

  assert.notEqual(createOperationId(), createOperationId())
})

test('diagnostic errors never imply automatic retry or echo synthetic credentials', () => {
  for (const text of ['Authorization: Bearer SYNTHETIC_OPERATION_CREDENTIAL', 'https://user:SYNTHETIC_OPERATION_CREDENTIAL@example.invalid/', '{"id_token":{"values":["SYNTHETIC_OPERATION_CREDENTIAL"]}}']) {
    const metadata = updateDiagnostic(id, 'error', text)
    assert.equal(metadata.schema_version, 'youtab.diagnostic.v1')
    assert.equal(metadata.code, 'UPDATE_FAILED')
    assert.equal(metadata.component, 'desktop-update')
    assert.equal(metadata.operation_id, id)
    assert.equal(metadata.retryable, false)
    assert.ok(!JSON.stringify(metadata).includes('SYNTHETIC_OPERATION_CREDENTIAL'))
  }

  assert.equal(updateDiagnostic(id, 'password=synthetic', 'benign').stage, 'unknown')
})

test('real updater process seam forwards diagnostic correlation without changing command authority', async () => {
  const outcome = await spawnUpdaterProcessConfirmed(process.execPath,
    ['-e', `process.stdout.write(JSON.stringify({operation_id:process.env.${OPERATION_ENV},handoff:process.env.YOUTAB_AGENT_UPDATE_HANDOFF_PID}))`],
    { detached: false, stdio: ['ignore', 'pipe', 'pipe'], env: {
      [OPERATION_ENV]: id, YOUTAB_AGENT_UPDATE_HANDOFF_PID: 'synthetic-handoff', SYSTEMROOT: process.env.SYSTEMROOT
    } })

  assert.equal(outcome.kind, 'started')

  if (outcome.kind !== 'started') {return}
  const child = outcome.child as ChildProcess
  let stdout = ''
  child.stdout?.on('data', chunk => { stdout += chunk.toString() })
  const timer = setTimeout(() => { child.kill() }, 5000)

  try {
    const [code] = await once(child, 'close')
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), { operation_id: id, handoff: 'synthetic-handoff' })
  } finally { clearTimeout(timer) }
})


test('actual IPC progress preparation sanitizes both strings, including configured opaque secrets', () => {
  const opaque = 'SYNTHETIC_OPAQUE_DIAGNOSTIC_CREDENTIAL'
  const machine = { path: 'original/path', sha256: 'machine-value' }

  const metadata = prepareUpdateProgress({ stage: 'error', message: opaque, error: 'failure: ' + opaque,
    percent: null, marker: machine, code: 73 }, id, 123, { PRIVATE_CREDENTIAL: opaque })

  assert.ok(!JSON.stringify(metadata).includes(opaque))
  assert.equal(metadata.marker, machine)
  assert.equal(metadata.code, 73)
  assert.equal(metadata.percent, null)
  assert.equal(metadata.at, 123)
  assert.equal(metadata.diagnostic.retryable, false)
  const nullable = prepareUpdateProgress({ message: null, error: machine }, id, 123)
  assert.equal(nullable.message, null)
  assert.equal(nullable.error, machine)
  assert.equal(updateDiagnostic(id, 'error\n', 'benign').stage, 'unknown')
  assert.ok(!updateDiagnostic(id, 'error', opaque, { PRIVATE_CREDENTIAL: opaque }).safe_message.includes(opaque))
})


test('error-only and empty-message progress retain safe useful diagnostics', () => {
  for (const payload of [{ stage: 'error', error: 'useful failure' }, { stage: 'error', message: '', error: 'useful failure' }]) {
    const prepared = prepareUpdateProgress(payload, id, 123)
    assert.equal(prepared.diagnostic.safe_message, 'useful failure')
    assert.equal(prepared.error, 'useful failure')
    assert.equal(prepared.message, '')
  }

  assert.equal(prepareUpdateProgress({ stage: 'error', message: 'primary', error: 'fallback' }, id).diagnostic.safe_message, 'primary')
})
