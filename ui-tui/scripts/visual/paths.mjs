// One private output namespace per visual run. The launcher passes its path
// to both children; explicit overrides retain their artifacts and are never
// recursively removed. Windows inherited ACL confidentiality is not implied
// by POSIX mode bits; these artifacts contain synthetic visual scenes.
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

let outputDirectory

function identity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.getuid && (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n) !== 0n))) {
    throw new Error('Unsafe visual output directory')
  }
  return stat
}

const same = (a, b) => a.dev === b.dev && a.ino === b.ino

export function visualOutDir() {
  if (outputDirectory) return outputDirectory
  const selected = process.env.YOUTAB_AGENT_TUI_VISUAL_DIR
  if (selected) {
    const requested = resolve(selected)
    fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
    // Explicitly selected aliases are authorized, then frozen to their target.
    const followed = fs.statSync(requested, { bigint: true })
    const canonical = fs.realpathSync(requested)
    if (!same(followed, identity(canonical))) throw new Error('Visual output selection changed')
    outputDirectory = canonical
  } else {
    outputDirectory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'youtab-tui-visual-'))
    identity(outputDirectory)
  }
  return outputDirectory
}

export function writeVisualOutput(directory, name, data) {
  if (basename(name) !== name) throw new Error('Visual output must be a filename')
  const owner = identity(directory)
  const staged = join(directory, `.visual-${randomUUID()}.tmp`)
  let stageIdentity
  let fd
  try {
    fd = fs.openSync(staged, 'wx', 0o600)
    stageIdentity = fs.fstatSync(fd, { bigint: true })
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (!same(owner, identity(directory)) || !same(stageIdentity, fs.lstatSync(staged, { bigint: true }))) {
      throw new Error('Visual output namespace changed')
    }
    // Replace the entry atomically, preserving existing output on failure.
    fs.renameSync(staged, join(directory, name))
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (stageIdentity) {
      try {
        if (same(owner, identity(directory)) && same(stageIdentity, fs.lstatSync(staged, { bigint: true }))) fs.unlinkSync(staged)
      } catch { /* stage already published or namespace no longer ours */ }
    }
  }
}

// Chromium uses Windows KnownFolder paths independently of HOME. Pin its
// screenshot profile to a new owned directory rather than the operator's profile.
export function createVisualProfile(directory) {
  const parent = identity(directory)
  const profile = fs.mkdtempSync(join(directory, '.electron-profile-'))
  const owned = identity(profile)
  return {
    path: profile,
    cleanup() {
      try {
        if (same(parent, identity(directory)) && same(owned, identity(profile))) {
          // Node removes symlink/junction entries without following their targets.
          fs.rmSync(profile, { recursive: true })
        }
      } catch { /* never clean a changed namespace or interrupt the artifact handoff */ }
    }
  }
}

export function checkedVisualProfile(directory, profile) {
  const selected = resolve(profile)
  if (dirname(selected) !== directory || !basename(selected).startsWith('.electron-profile-')) {
    throw new Error('Screenshot profile must belong to the selected output directory')
  }
  identity(selected)
  if (fs.readdirSync(selected).length !== 0) throw new Error('Screenshot profile must be fresh')
  return selected
}
