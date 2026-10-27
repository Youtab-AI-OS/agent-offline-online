/**
 * Tests for electron/update-gate.ts — the update mutual-exclusion gate that
 * parks local backend spawns while an in-app update is running.
 *
 * The regression this guards (#73822): applyUpdates kills its own backend
 * BEFORE the Windows venv-blocker scan but writes the on-disk marker AFTER
 * it. A marker-only gate therefore let the renderer's reconnect spawn a
 * fresh backend inside the update's own critical section, which the scan
 * reported as a blocker — aborting every Desktop update attempt on Windows.
 * The gate must consult the in-process updateInFlight flag as well.
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import { reserveUpdateOperation, updateGateReason, waitForUpdateClearance } from './update-gate'

function deps(marker: boolean, inFlight: boolean) {
  return {
    hasLiveMarker: () => marker,
    isUpdateInFlight: () => inFlight
  }
}

// ---------------------------------------------------------------------------
// updateGateReason
// ---------------------------------------------------------------------------

test('gate open when neither marker nor flag is set', async () => {
  assert.equal(await updateGateReason(deps(false, false)), null)
})

test('marker alone closes the gate', async () => {
  assert.equal(await updateGateReason(deps(true, false)), 'marker')
})

test('updateInFlight alone closes the gate (#73822 — the pre-marker window)', async () => {
  assert.equal(await updateGateReason(deps(false, true)), 'update-in-flight')
})

test('marker wins as the reported reason when both are set', async () => {
  assert.equal(await updateGateReason(deps(true, true)), 'marker')
})

// ---------------------------------------------------------------------------
// waitForUpdateClearance
// ---------------------------------------------------------------------------

test('returns clear immediately without sleeping when the gate is open', async () => {
  let slept = 0

  const outcome = await waitForUpdateClearance(deps(false, false), {
    pollMs: 10,
    sleep: async () => {
      slept += 1
    },
    timeoutMs: 1000
  })

  assert.equal(outcome, 'clear')
  assert.equal(slept, 0)
})

test('parks on the in-flight flag and finishes when it clears', async () => {
  // Simulates the #73822 sequence: the reconnect arrives while updateInFlight
  // is true and no marker exists yet; the flag clears (abort path finally)
  // and the waiter proceeds.
  let inFlight = true
  let ticks = 0

  const outcome = await waitForUpdateClearance(
    { hasLiveMarker: () => false, isUpdateInFlight: () => inFlight },
    {
      onWaitTick: reason => {
        ticks += 1
        assert.equal(reason, 'update-in-flight')

        if (ticks >= 3) {
          inFlight = false
        }
      },
      pollMs: 1,
      sleep: async () => {},
      timeoutMs: 10_000
    }
  )

  assert.equal(outcome, 'finished')
  assert.equal(ticks, 3)
})

test('parks across the flag→marker handoff without a gap', async () => {
  // Success path: the marker is written (main.ts:2936) BEFORE applyUpdates'
  // finally clears the flag, so a waiter that arrived during the scan stays
  // parked through the transition instead of slipping through.
  let inFlight = true
  let marker = false
  let ticks = 0
  const reasons: string[] = []

  const outcome = await waitForUpdateClearance(
    { hasLiveMarker: () => marker, isUpdateInFlight: () => inFlight },
    {
      onWaitTick: reason => {
        ticks += 1
        reasons.push(reason)

        if (ticks === 2) {
          marker = true // updater hand-off: marker written first…
        }

        if (ticks === 3) {
          inFlight = false // …then the flag clears; marker still holds the gate
        }

        if (ticks === 5) {
          marker = false // updater finished
        }
      },
      pollMs: 1,
      sleep: async () => {},
      timeoutMs: 10_000
    }
  )

  assert.equal(outcome, 'finished')
  assert.deepEqual(reasons, ['update-in-flight', 'update-in-flight', 'marker', 'marker', 'marker'])
})

test('returns timeout when the gate never opens', async () => {
  let clock = 0

  const outcome = await waitForUpdateClearance(deps(true, false), {
    now: () => clock,
    pollMs: 10,
    sleep: async ms => {
      clock += ms
    },
    timeoutMs: 50
  })

  assert.equal(outcome, 'timeout')
})


test('async false is open, not a truthy Promise marker', async () => {
  assert.equal(await updateGateReason({ hasLiveMarker: async () => false, isUpdateInFlight: () => false }), null)
})

test('async true and rejected or invalid probes stay closed', async () => {
  assert.equal(await updateGateReason({ hasLiveMarker: async () => true, isUpdateInFlight: () => false }), 'marker')
  assert.equal(await updateGateReason({ hasLiveMarker: async () => { throw new Error('timeout') }, isUpdateInFlight: () => false }), 'probe-unavailable')
  assert.equal(await updateGateReason({ hasLiveMarker: async () => null as unknown as boolean, isUpdateInFlight: () => false }), 'probe-unavailable')
})

test('an update beginning during asynchronous admission prevents startup', async () => {
  let release: (value: boolean) => void
  let inFlight = false
  const probe = new Promise<boolean>(resolve => { release = resolve })
  const outcome = updateGateReason({ hasLiveMarker: () => probe, isUpdateInFlight: () => inFlight })
  inFlight = true
  release!(false)
  assert.equal(await outcome, 'update-in-flight')
})

test('a probe error never becomes clearance after a bounded wait', async () => {
  let clock = 0
  assert.equal(await waitForUpdateClearance({ hasLiveMarker: async () => { throw new Error('oplock') }, isUpdateInFlight: () => false }, {
    timeoutMs: 50, pollMs: 10, now: () => clock, sleep: async ms => { clock += ms }
  }), 'timeout')
})


test('Repair reserves before slow admission: Update and primary/pool starts stay excluded', async () => {
  let inFlight = false
  const state = { isUpdateInFlight: () => inFlight, setUpdateInFlight: (active: boolean) => { inFlight = active } }
  let unblock: () => void
  const admission = new Promise<void>(resolve => { unblock = resolve })
  const effects: string[] = []
  const repair = async () => {
    const release = reserveUpdateOperation(state)
    try { await admission; effects.push('repair-handoff') } finally { release() }
  }
  const running = repair()
  assert.throws(() => reserveUpdateOperation(state), /already in progress/)
  for (const entrypoint of ['primary', 'pool']) {
    assert.equal(await updateGateReason({ hasLiveMarker: async () => false, isUpdateInFlight: state.isUpdateInFlight }), 'update-in-flight', entrypoint)
  }
  assert.deepEqual(effects, [])
  unblock!(); await running
  assert.deepEqual(effects, ['repair-handoff'])
  assert.equal(inFlight, false)
})

test('failed owned reservation releases exactly once without clearing another owner', () => {
  let flag = false
  const state = { isUpdateInFlight: () => flag, setUpdateInFlight: (active: boolean) => { flag = active } }
  const release = reserveUpdateOperation(state)
  release()
  const releaseNext = reserveUpdateOperation(state)
  release()
  assert.equal(flag, true)
  releaseNext()
  assert.equal(flag, false)
})
