'use strict'

/**
 * update-gate.ts
 *
 * Pure, dependency-injected gate that parks local backend spawns while an
 * in-app update is running (#73822, #50238).
 *
 * Two independent signals mean "an update owns the venv right now":
 *
 *  - the on-disk marker (`YOUTAB_AGENT_HOME/.youtab-agent-runtime-update-in-progress`), written
 *    by the updater — and by the desktop itself just before hand-off — and
 *  - the in-process `updateInFlight` flag, true for the whole
 *    `applyUpdates()` critical section.
 *
 * The marker alone is NOT enough (#73822): `applyUpdates` kills its own
 * backend early (`releaseBackendLock`) but only writes the marker AFTER the
 * Windows venv-blocker scan. Killing the backend drops the renderer's
 * WebSocket, the renderer reconnects within ~1s, and a marker-only gate
 * happily spawns a fresh backend inside the update's own critical section —
 * which `scanVenvBlockers` then reports as a blocker, aborting every update
 * attempt forever. Consulting the flag closes that window. On the success
 * path the marker is written BEFORE the flag clears in `applyUpdates`'
 * `finally`, so there is no instant where both signals are false and a
 * waiter could slip through mid-update.
 */

export type UpdateGateReason = 'marker' | 'update-in-flight' | 'probe-unavailable' | null

export interface UpdateGateDeps {
  /** Reject an unavailable verified helper before entering a polling wait. */
  ensureCoordinationAvailable?: () => void | Promise<void>
  /** True when a live on-disk update marker exists (see update-marker.ts). */
  hasLiveMarker: () => boolean | Promise<boolean>
  /** True while this process is inside applyUpdates()' critical section. */
  isUpdateInFlight: () => boolean
}

/** Why the gate is closed right now, or null when it is open. */
export async function updateGateReason(deps: UpdateGateDeps): Promise<UpdateGateReason> {
  let marker: boolean

  try {
    marker = await deps.hasLiveMarker()
  } catch {
    return 'probe-unavailable'
  }

  if (typeof marker !== 'boolean') {return 'probe-unavailable'}
  if (marker) {
    return 'marker'
  }

  if (deps.isUpdateInFlight()) {
    return 'update-in-flight'
  }

  return null
}

export type UpdateClearanceOutcome = 'clear' | 'finished' | 'timeout'

export interface WaitForUpdateClearanceOptions {
  timeoutMs: number
  pollMs: number
  /** Invoked once per poll while parked (boot progress / logging). */
  onWaitTick?: (reason: Exclude<UpdateGateReason, null>) => void | Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Park until no update signal remains, or the deadline passes.
 *
 * Returns 'clear' when the gate was already open (no wait happened),
 * 'finished' when it opened during the wait, and 'timeout' when the deadline
 * expired with the gate still closed. Callers must defer local startup and
 * surface a recoverable diagnostic; a held or unknown exclusion never permits
 * a competing backend.
 */
export async function waitForUpdateClearance(
  deps: UpdateGateDeps,
  options: WaitForUpdateClearanceOptions
): Promise<UpdateClearanceOutcome> {
  await deps.ensureCoordinationAvailable?.()
  const now = options.now || Date.now
  const sleep = options.sleep || (ms => new Promise<void>(r => setTimeout(r, ms)))

  let reason = await updateGateReason(deps)

  if (!reason) {
    return 'clear'
  }

  const deadline = now() + options.timeoutMs

  while (reason && now() < deadline) {
    if (options.onWaitTick) {
      await options.onWaitTick(reason)
    }

    await sleep(options.pollMs)
    reason = await updateGateReason(deps)
  }

  return reason ? 'timeout' : 'finished'
}


/** Synchronous reservation before the first await shared by Update and Repair.
 * Returns an idempotent release for the owning entry point only. */
export function reserveUpdateOperation(deps: {
  isUpdateInFlight: () => boolean
  setUpdateInFlight: (active: boolean) => void
}): () => void {
  if (deps.isUpdateInFlight()) {throw new Error('An update or repair is already in progress.')}
  deps.setUpdateInFlight(true)
  let released = false
  return () => {
    if (!released) {released = true; deps.setUpdateInFlight(false)}
  }
}
