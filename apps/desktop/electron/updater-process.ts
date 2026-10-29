import { spawn, type SpawnOptions } from 'node:child_process'

import { hiddenWindowsChildOptions } from './windows-child-options'

export interface UpdaterChild {
  pid?: number
  unref: () => void
}

export interface SpawnUpdaterProcessDeps {
  isWindows?: boolean
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => UpdaterChild
}

/**
 * Spawn the detached installer used for update and bootstrap-recovery handoffs.
 * The helper owns both hidden-console selection and unref semantics so every
 * updater handoff follows the same behavior and can be tested without Electron.
 */
export function spawnUpdaterProcess(
  updater: string,
  updaterArgs: string[],
  options: SpawnOptions,
  deps: SpawnUpdaterProcessDeps = {}
): UpdaterChild {
  const isWindows = deps.isWindows ?? process.platform === 'win32'
  const spawnOptions = hiddenWindowsChildOptions(options, isWindows) as SpawnOptions

  const child = deps.spawnProcess
    ? deps.spawnProcess(updater, updaterArgs, spawnOptions)
    : spawn(updater, updaterArgs, spawnOptions)

  child.unref()

  return child
}


export interface ObservedUpdaterChild extends UpdaterChild {
  on: (event: string, listener: (...args: unknown[]) => void) => ObservedUpdaterChild
  once: (event: string, listener: (...args: unknown[]) => void) => ObservedUpdaterChild
  removeListener: (event: string, listener: (...args: unknown[]) => void) => ObservedUpdaterChild
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}
export type UpdaterSpawnOutcome =
  | { kind: 'started', child: ObservedUpdaterChild, pid: number }
  | { kind: 'failed', reason: string }
  | { kind: 'unconfirmed', child: ObservedUpdaterChild, reason: string }

/** A PID alone is not a spawn ACK. Observe creation/error before claiming a
 * handoff. Unknown creation never grants success or kills a possibly active
 * installer; the caller must retain admission until the owned child exits. */
export function spawnUpdaterProcessConfirmed(
  updater: string,
  updaterArgs: string[],
  options: SpawnOptions,
  deps: SpawnUpdaterProcessDeps & { ackTimeoutMs?: number } = {}
): Promise<UpdaterSpawnOutcome> {
  const timeout = deps.ackTimeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5000) {
    return Promise.resolve({ kind: 'failed', reason: 'invalid-spawn-bound' })
  }
  let child: ObservedUpdaterChild
  try { child = spawnUpdaterProcess(updater, updaterArgs, options, deps) as ObservedUpdaterChild }
  catch { return Promise.resolve({ kind: 'failed', reason: 'spawn-error' }) }
  if (typeof child?.on !== 'function' || typeof child?.once !== 'function' || typeof child?.removeListener !== 'function') {
    return Promise.resolve({ kind: 'failed', reason: 'unobservable-child' })
  }
  return new Promise(resolve => {
    let completed = false
    let timer: NodeJS.Timeout
    const validPid = () => Number.isInteger(child.pid) && child.pid! > 0 && child.pid! <= 0xffffffff
    const finish = (result: UpdaterSpawnOutcome) => {
      if (completed) {return}
      completed = true
      clearTimeout(timer)
      child.removeListener('spawn', onSpawn)
      resolve(result)
    }
    const onSpawn = () => finish(validPid()
      ? { kind: 'started', child, pid: child.pid! }
      : { kind: 'failed', reason: 'invalid-updater-pid' })
    const onError = () => finish(validPid() && child.exitCode === null && child.signalCode === null
      ? { kind: 'unconfirmed', child, reason: 'spawn-error' }
      : { kind: 'failed', reason: 'spawn-error' })
    const onExit = () => {
      finish({ kind: 'failed', reason: 'exited-before-spawn-ack' })
      child.removeListener('error', onError)
    }
    child.on('error', onError)
    child.once('exit', onExit)
    child.once('spawn', onSpawn)
    timer = setTimeout(() => finish(validPid()
      ? { kind: 'unconfirmed', child, reason: 'spawn-ack-timeout' }
      : { kind: 'failed', reason: 'spawn-ack-timeout' }), timeout)
    // Actual failed CreateProcess reports no PID. Observe its queued error but
    // never latch a handoff or wait the full timeout for a nonexistent child.
    if (!validPid()) {finish({ kind: 'failed', reason: 'invalid-updater-pid' })}
  })
}

/** Attach release to this owned ChildProcess, never a reused numeric PID. */
export function retainUpdateReservationUntilExit(child: ObservedUpdaterChild, release: () => void): void {
  if (child.exitCode !== null || child.signalCode !== null) {release(); return}
  child.once('exit', release)
}
