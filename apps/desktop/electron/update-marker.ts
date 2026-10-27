/**
 * In-app update mutual-exclusion marker (#50238).
 *
 * The Tauri updater writes YOUTAB_AGENT_HOME/.youtab-agent-runtime-update-in-progress for the whole
 * duration of an `--update` run (see apps/bootstrap-installer/src-tauri/src/
 * update.rs `UpdateMarkerGuard`). The marker body is two lines: the updater's
 * pid and the unix-seconds it started.
 *
 * Why: if the user relaunches the desktop mid-update — the window vanished with
 * no progress and looks crashed — a fresh instance must NOT spawn its own local
 * backend. That backend re-locks the venv shim, the updater's straggler cleanup
 * (`force_kill_other_youtab`, taskkill /IM youtab.exe) kills it, the launch
 * fails with the 45s "backend didn't come up" timeout, and the user relaunches
 * into the same trap — an infinite respawn/kill loop. The desktop gates local
 * backend startup on this marker and parks until the update finishes.
 *
 * This module holds the PURE, side-effect-light logic (path, pid liveness,
 * parse + staleness) so it is unit-testable without booting Electron. The
 * polling/boot-progress wrapper lives in main.ts where the boot-progress and
 * log sinks are.
 */

import fs from 'fs'
import { randomUUID } from 'node:crypto'
import path from 'path'

import type { UpdateGateDeps } from './update-gate'
import { coordinateWindowsUpdate, type CoordinationDeps } from './windows-update-coordination'

// Even with a live-looking PID, never treat a marker older than this as a live
// update. A full update (git pull + pip + desktop rebuild) is minutes, not tens
// of minutes; past this the marker is almost certainly stale (e.g. the OS
// recycled the pid onto an unrelated process), so the gate self-heals.
export const UPDATE_MARKER_MAX_AGE_MS = 20 * 60 * 1000

export function markerPath(youtabHome) {
  return path.join(youtabHome, '.youtab-agent-runtime-update-in-progress')
}

// These files coordinate an update; they contain only PID/start time. On
// POSIX require an owner-controlled home. Native Windows has no getuid/mode
// ACL equivalent here: exclusive handles and rename prevent victim truncation,
// but these checks do not establish Windows directory confidentiality.
function trustedHome(home) {
  // Explicit caller-selected aliases are supported. Freeze and validate the
  // physical directory once; marker leaf links remain untrusted.
  const selected = fs.statSync(home, { bigint: true })
  const resolved = fs.realpathSync(home)
  const canonical = fs.lstatSync(resolved, { bigint: true })

  if (!canonical.isDirectory() || canonical.isSymbolicLink() || !sameFile(selected, canonical)) {
    throw new Error('Update marker home changed or is unsafe')
  }

  if (typeof process.getuid === 'function' &&
      (canonical.uid !== BigInt(process.getuid()) || (canonical.mode & 0o022n) !== 0n)) {
    throw new Error('Update marker home is not owner-controlled')
  }

  return { directory: resolved, identity: canonical }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino
}

function regularOwnedFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()))
}

function unlinkUnchanged(file, identity) {
  try {
    const current = fs.lstatSync(file, { bigint: true })

    if (regularOwnedFile(current) && sameFile(current, identity)) {fs.unlinkSync(file)}
  } catch {
    void 0
  }
}

// True only if a host process with this pid is currently alive. Signal 0 does
// not deliver a signal — it just probes existence/permission. ESRCH => dead;
// EPERM => alive but owned by another user (still "alive" for our purposes).
// Injectable `kill` keeps it unit-testable.
export function isPidAlive(pid, kill: typeof process.kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    kill(pid, 0)

    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

/**
 * Read + interpret the marker.
 *
 * Returns `{ pid, ageMs }` only when an update is GENUINELY still running
 * (parseable pid that is alive, within the age ceiling). Returns `null` for
 * every "no live update" case. Production startup uses readUpdateExclusion,
 * which distinguishes uncertain time for a live PID and stays closed.
 * Readers never delete a shared marker; its owner or atomic writer handles it.
 *
 * Pure-ish: file I/O against the given path, plus an injectable pid probe and
 * clock for tests.
 */
function readMarkerExclusion(
  youtabHome,
  {
    kill,
    now = Date.now,
    maxAgeMs = UPDATE_MARKER_MAX_AGE_MS
  }: {
    now?: () => number
    maxAgeMs?: number
    kill?: typeof process.kill
  } = {}
): UpdateExclusion | null {
  let file
  let raw
  let identity
  let fd

  try {
    file = markerPath(trustedHome(youtabHome).directory)
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0), 0o600)
    identity = fs.fstatSync(fd, { bigint: true })
    const before = fs.lstatSync(file, { bigint: true })

    if (!regularOwnedFile(before) || !regularOwnedFile(identity) || !sameFile(before, identity) || identity.size > 4096n) {return null}
    // A regular inode can grow after stat. Read one extra byte to detect the
    // limit without synchronously reading an unbounded file in Electron.
    const bytes = Buffer.alloc(4097)
    let total = 0

    while (total < bytes.length) {
      const count = fs.readSync(fd, bytes, total, bytes.length - total, null)

      if (!count) {break}
      total += count
    }

    if (total > 4096) {return null}
    const after = fs.fstatSync(fd, { bigint: true })
    const named = fs.lstatSync(file, { bigint: true })

    if (!regularOwnedFile(after) || !regularOwnedFile(named) ||
        !sameFile(identity, after) || !sameFile(identity, named) ||
        after.size !== BigInt(total) || named.size !== after.size ||
        identity.mtimeNs !== after.mtimeNs || identity.ctimeNs !== after.ctimeNs ||
        named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs) {return null}

    raw = bytes.subarray(0, total).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) {fs.closeSync(fd)}
  }

  const lines = String(raw).split('\n').map(line => line.trim())
  const pidText = lines[0] || ''
  const pid = /^[0-9]+$/.test(pidText) ? Number(pidText) : NaN

  if (!Number.isSafeInteger(pid) || pid <= 0 || !isPidAlive(pid, kill)) {return null}
  const startedText = lines[1] || ''
  const startedAt = /^[0-9]+$/.test(startedText) ? Number(startedText) : NaN
  const clock = now()
  const startedMs = startedAt * 1000
  const ageMs = clock - startedMs

  if (!Number.isSafeInteger(startedAt) || startedAt <= 0 ||
      !Number.isSafeInteger(startedMs) || !Number.isSafeInteger(clock) ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
      lines.slice(2).some(line => line !== '') || ageMs < 0) {
    // A clock rollback or damaged hint must not start a competing backend.
    // Keep the hint intact; the bounded startup gate defers until owner exit,
    // marker replacement/removal, or a verifiable clock reading.
    return { kind: 'marker-unverifiable', pid, error: 'Update marker time cannot be verified' }
  }

  if (ageMs > maxAgeMs) {return null}

  return { kind: 'marker', owner: { pid, ageMs } }
}

export function readLiveUpdateMarker(
  youtabHome,
  options: Parameters<typeof readMarkerExclusion>[1] = {}
) {
  const exclusion = readMarkerExclusion(youtabHome, options)

  return exclusion?.kind === 'marker' ? exclusion.owner : null
}

export type UpdateExclusion =
  | { kind: 'marker', owner: { pid: number, ageMs: number } }
  | { kind: 'install-lock-unavailable', error: string }
  | { kind: 'coordination-prerequisite', reason: string, error: string }
  | { kind: 'unsafe-home', error: string }
  | { kind: 'marker-unverifiable', pid: number, error: string }

// The Rust Setup holds this stable file with Windows share_mode(0). Opening it
// for reading therefore fails while any Setup owns the install mutation lock.
// POSIX Node has no flock API; its existing PID hint behavior remains unchanged.
function windowsInstallExclusion(directory: string): UpdateExclusion | null {
  if (process.platform !== 'win32') {return null}
  const file = path.join(directory, '.youtab-agent-runtime-update-in-progress.install-lock')
  let fd

  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0), 0o600)
    const opened = fs.fstatSync(fd, { bigint: true })
    const before = fs.lstatSync(file, { bigint: true })

    if (!regularOwnedFile(before) || !regularOwnedFile(opened) || !sameFile(before, opened)) {throw new Error('Install lock changed')}

    return null
  } catch (error) {
    if (error?.code === 'ENOENT') {return null}

    // Contention and insufficient access are both closed, without inventing a PID
    // or claiming that an arbitrary I/O error proves an active Setup.
    return { kind: 'install-lock-unavailable', error: String(error?.message || error) }
  } finally {
    if (fd !== undefined) {fs.closeSync(fd)}
  }
}

/** The bundled Inno image installs a complete Runtime but has no update handoff.
 * Only startup may use the local lock/marker reader for this exact image.
 * About/update actions retain their native admission path. */
export function isInnoInstallOnlyMarker(marker: unknown, commit: unknown): boolean {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {return false}
  const value = marker as Record<string, unknown>
  return value.schemaVersion === 1
    && value.installKind === 'inno-local-native'
    && value.updateSupported === false
    && value.pinnedCommit === commit
    && value.artifactHashKind === 'file-tree-sha256'
    && typeof value.artifactTreeSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.artifactTreeSha256)
}
export function readUpdateExclusion(
  youtabHome,
  options: Parameters<typeof readLiveUpdateMarker>[1] = {}
): UpdateExclusion | null {
  let home

  try {
    home = trustedHome(youtabHome)
  } catch (error) {
    if (error?.code === 'ENOENT') {return null}

    return { kind: 'unsafe-home', error: String(error?.message || error) }
  }

  // Probe BEFORE interpreting or pruning the PID hint. A losing/older Desktop
  // may have overwritten it with a now-dead PID while the winning Setup works.
  const exclusion = windowsInstallExclusion(home.directory)

  if (exclusion) {return exclusion}
  return readMarkerExclusion(home.directory, options)
}

/**
 * Write the update-in-progress marker *from the desktop* before handing off
 * to the detached updater.
 *
 * The Tauri-based youtab-setup.exe takes several seconds to initialise its
 * window and reach the Rust `run_update` entry point where it writes the
 * marker itself. During that gap the desktop's `app.quit()` teardown kills
 * the backend child, the renderer's WebSocket drops, and the renderer
 * immediately calls `ensureBackend()` → `waitForUpdateToFinish()`. Because
 * the updater hasn't written the marker yet, the gate sees no live update
 * and spawns a *new* backend — which re-locks `.pyd` files in the venv.
 * When the updater finally reaches the venv-rebuild stage it finds those
 * files locked and the update bricks.
 *
 * Fix: the desktop writes the marker itself, using the spawned updater's
 * PID, immediately after `spawn()`. The updater's `UpdateMarkerGuard` will
 * later overwrite it with its own PID — that's fine, the marker body is
 * the same format and `readLiveUpdateMarker` only cares that *some* live
 * pid owns it. When the updater finishes it deletes the marker as before.
 * If the updater never starts (spawn failure) the marker still contains a
 * real PID, so `readUpdateExclusion` clears logically once that PID exits.
 */
export function writeUpdateMarker(youtabHome, pid, { now = Date.now } = {}) {
  const startedAt = Math.floor(now() / 1000)
  let staged
  let identity
  let fd

  try {
    const home = trustedHome(youtabHome)
    const file = markerPath(home.directory)

    if (readUpdateExclusion(home.directory, { now })) {return}
    staged = path.join(home.directory, `.youtab-update-${randomUUID()}.tmp`)
    fd = fs.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
    identity = fs.fstatSync(fd, { bigint: true })

    if (!regularOwnedFile(identity)) {throw new Error('Unsafe marker stage')}
    fs.writeFileSync(fd, `${pid}\n${startedAt}\n`, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined

    if (!sameFile(home.identity, fs.lstatSync(home.directory, { bigint: true })) ||
        !sameFile(identity, fs.lstatSync(staged, { bigint: true }))) {throw new Error('Marker namespace changed')}

    // Recheck after staging: another Setup may have claimed during fsync.
    if (readUpdateExclusion(home.directory, { now })) {return}
    // This hint is not a mutex. OS sidecar-aware readers stay closed even if a
    // legacy writer races this last check and replaces the winning PID hint.
    // Replace the directory entry atomically; never open/truncate its target.
    fs.renameSync(staged, file)
    staged = undefined
  } catch {
    // Best-effort: the detached updater will write its own marker.
  } finally {
    if (fd !== undefined) {fs.closeSync(fd)}

    if (staged && identity) {unlinkUnchanged(staged, identity)}
  }
}


/** Production Windows admissions always cross the bounded native boundary.
 * The synchronous implementation remains solely the POSIX implementation. */
export async function readUpdateExclusionAsync(
  home: string,
  deps: CoordinationDeps,
  platform: NodeJS.Platform = process.platform
): Promise<UpdateExclusion | null> {
  if (platform !== 'win32') {return readUpdateExclusion(home)}
  const result = await coordinateWindowsUpdate(home, 'inspect', deps)
  if (result.status === 'clear') {return null}
  const error = `Windows update admission unavailable (${result.reason}); retry or migrate using the current common Setup.`
  if (['compatible-setup-unavailable', 'unsafe-namespace', 'unsafe-home', 'unsupported-platform'].includes(result.reason)) {
    return { kind: 'coordination-prerequisite', reason: result.reason, error }
  }
  return { kind: 'install-lock-unavailable', error }
}

export async function writeUpdateMarkerAsync(
  home: string,
  pid: number,
  deps: CoordinationDeps,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'win32') {writeUpdateMarker(home, pid); return}
  const result = await coordinateWindowsUpdate(home, 'publish', deps, pid)
  if (result.status !== 'published') {
    throw new Error(`Windows update handoff could not be published (${result.reason}).`)
  }
}


/** The real primary/pool gate shares this prerequisite seam. Missing developer
 * provisioning is actionable immediately, never an opaque polling timeout. */
export function createCoordinationUpdateGateDeps(
  readExclusion: () => Promise<UpdateExclusion | null>,
  isUpdateInFlight: () => boolean,
  prerequisiteMessage: string | ((exclusion: Extract<UpdateExclusion, { kind: 'coordination-prerequisite' }>) => string)
): UpdateGateDeps {
  return {
    ensureCoordinationAvailable: async () => {
      const exclusion = await readExclusion()
      if (exclusion?.kind === 'coordination-prerequisite') {
        throw new Error(typeof prerequisiteMessage === 'function' ? prerequisiteMessage(exclusion) : prerequisiteMessage)
      }
    },
    hasLiveMarker: async () => Boolean(await readExclusion()),
    isUpdateInFlight
  }
}
