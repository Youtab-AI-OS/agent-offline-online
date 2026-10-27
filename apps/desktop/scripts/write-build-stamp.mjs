/**
 * Writes apps/desktop/build/install-stamp.json with the git ref the desktop
 * .exe should pin to at first-launch bootstrap time.  This file ships inside
 * the packaged app via electron-builder's extraResources entry and is read
 * by electron/main.ts to drive the install.ps1 stage bootstrap flow.
 *
 * Schema (subject to bump via STAMP_SCHEMA_VERSION):
 *   {
 *     "schemaVersion": 1,
 *     "commit":        "<40-char SHA>",
 *     "branch":        "<branch name>",
 *     "builtAt":       "<ISO 8601 UTC timestamp>",
 *     "dirty":         true|false,
 *     "source":        "ci" | "local" | "fallback"
 *     "releaseBaseUrl": "https://api.youtab.io/pilot-runtime-<hex>/releases" | null,
 *     "setupLease": { "protocol": 1, "format": "pe", "arch": "x64",
 *                     "napi": "youtab.setup-lease/napi-v1", "sha256": "<hex>",
 *                     "size": <bytes> } // required for customer packages
 *   }
 *
 * Source preference order:
 *   1. CI env vars ($GITHUB_SHA / $GITHUB_REF_NAME) -- avoid edge cases with
 *      shallow clones, detached HEADs, etc. in CI.
 *   2. Local `git rev-parse` against the parent repo (../..).
 *   3. Fallback stamp for local/personal builds from non-git source trees
 *      (ZIP extract, interrupted clone with no HEAD, etc.).
 *
 * Dev / out-of-repo builds without git produce an explicit fallback stamp
 * rather than aborting the whole build.  Bootstrap treats the all-zero
 * commit as unpinned and follows the branch instead of fetching a fake SHA.
 */

import { mkdirSync, writeFileSync, readFileSync, lstatSync, copyFileSync, rmSync, openSync, fstatSync, readSync, closeSync, constants } from "fs"
import { createHash } from "crypto"
import { resolve, join, relative, isAbsolute } from "path"
import { execSync } from "child_process"

import { isMain } from "./utils.mjs"

const STAMP_SCHEMA_VERSION = 1

/** All-zero placeholder used when no real commit can be resolved. */
export const FALLBACK_COMMIT = "0000000000000000000000000000000000000000"
export const FALLBACK_BRANCH = "main"

const DESKTOP_ROOT = resolve(import.meta.dirname, "..")
const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..")
const OUT_DIR = join(DESKTOP_ROOT, "build")
const OUT_FILE = join(OUT_DIR, "install-stamp.json")
const SETUP_LEASE_ADDON = join(OUT_DIR, 'native', 'setup_lease.node')
export const SETUP_LEASE_NAPI_MARKER = 'youtab.setup-lease/napi-v1'

function tryExec(cmd, opts) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim()
  } catch {
    return null
  }
}

export function fromCI(env = process.env) {
  const sha = env.GITHUB_SHA
  if (!sha) return null
  const branch = env.GITHUB_REF_NAME || env.GITHUB_HEAD_REF || null
  return {
    commit: sha,
    branch: branch,
    dirty: false, // CI builds from a checkout-of-ref by definition
    source: "ci"
  }
}

export function fromLocalGit(repoRoot = REPO_ROOT, execFn = tryExec) {
  const sha = execFn("git rev-parse HEAD", { cwd: repoRoot })
  if (!sha) return null
  const branch = execFn("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot })
  // `git status --porcelain -uno` is empty iff tracked files match HEAD.
  // We exclude untracked files (-uno) intentionally: a developer who's
  // checked out an installer scratch dir alongside the repo shouldn't
  // poison every local build with a [DIRTY] stamp.  We DO care about
  // tracked-but-modified files because those mean the .exe content
  // differs from the commit being pinned.
  const status = execFn("git status --porcelain -uno", { cwd: repoRoot })
  const dirty = status !== null && status.length > 0
  return {
    commit: sha,
    branch: branch === "HEAD" ? null : branch, // detached HEAD -> null
    dirty: dirty,
    source: "local"
  }
}

export function fromFallback(branch = FALLBACK_BRANCH) {
  // Non-git builds (ZIP download, bootstrap installer without a resolvable
  // HEAD) cannot determine a real commit.  Use a placeholder so local /
  // personal builds can still complete.  The desktop bootstrap treats the
  // all-zero commit as "unknown" and falls back to an unpinned branch
  // bootstrap instead of trying to fetch a non-existent GitHub commit.
  return {
    commit: FALLBACK_COMMIT,
    branch: branch || FALLBACK_BRANCH,
    dirty: false,
    source: "fallback"
  }
}

/**
 * Resolve the install stamp without writing it.  Pure enough for unit tests:
 * inject env / execFn / repoRoot to simulate CI, local git, or no-git trees.
 */
export function resolveStamp({
  env = process.env,
  repoRoot = REPO_ROOT,
  execFn = tryExec,
  fallbackBranch = FALLBACK_BRANCH,
  setupLeasePath = SETUP_LEASE_ADDON
} = {}) {
  // Explicit local coordination never relabels dirty work using an ambient CI SHA.
  const development = env.YOUTAB_AGENT_DEVELOPMENT_COORDINATION === '1'
  const stamp = (development ? null : fromCI(env)) || fromLocalGit(repoRoot, execFn) || fromFallback(fallbackBranch)
  const rawBase = env.YOUTAB_AGENT_RELEASE_BASE_URL
  let releaseBaseUrl = null
  if (rawBase) {
    const url = new URL(rawBase)
    const pathname = url.pathname.replace(/\/$/, '')
    if (
      url.protocol !== 'https:' || url.hostname !== 'api.youtab.io' || url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/pilot-runtime-[0-9a-f]{32,}\/releases$/.test(pathname)
    ) throw new Error('YOUTAB_AGENT_RELEASE_BASE_URL must be an approved api.youtab.io pilot release path')
    releaseBaseUrl = url.origin + pathname
  }
  const result = { ...stamp, releaseBaseUrl }
  const updateCoordination = coordinationStamp(env, result, repoRoot, execFn)
  if (env.YOUTAB_AGENT_CUSTOMER_BUILD === '1') {
    // The customer package must carry the exact native code used to hold the
    // Setup lease. The immutable release manifest pins these bytes; a local
    // substitute cannot be blessed by merely recomputing a new stamp.
    const setupLease = validateSetupLeaseAddon(readVerifiedSetupInput(setupLeasePath))
    const expectedSha = env.YOUTAB_AGENT_SETUP_LEASE_SHA256
    const expectedSize = env.YOUTAB_AGENT_SETUP_LEASE_SIZE
    if (!/^[a-f0-9]{64}$/.test(expectedSha ?? '') ||
        !/^[1-9][0-9]*$/.test(expectedSize ?? '') ||
        Number(expectedSize) !== setupLease.size || expectedSha !== setupLease.sha256) {
      throw new Error('Setup lease addon does not match the immutable release manifest')
    }
    return { ...result, updateCoordination, setupLease }
  }
  return updateCoordination ? { ...result, updateCoordination } : result
}

export const UPDATE_COORDINATION_PE_MARKER = 'youtab.update-coordination/version1'
export const SETUP_HANDOFF_PE_MARKER = 'youtab.setup-handoff/version2'

export function validateSetupLeaseAddon(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > 32 * 1024 * 1024) {
    throw new Error('native Setup lease addon is missing or outside size bounds')
  }
  const pe = bytes.readUInt32LE(60)
  if (bytes.subarray(0, 2).toString('ascii') !== 'MZ' || pe < 64 || pe + 26 > bytes.length ||
      !bytes.subarray(pe, pe + 4).equals(Buffer.from([80, 69, 0, 0])) ||
      bytes.readUInt16LE(pe + 4) !== 0x8664 ||
      (bytes.readUInt16LE(pe + 22) & 0x2002) !== 0x2002 ||
      bytes.readUInt16LE(pe + 24) !== 0x20b) {
    throw new Error('native Setup lease addon must be a Windows x64 PE DLL')
  }
  const count = bytes.readUInt16LE(pe + 6), optional = bytes.readUInt16LE(pe + 20)
  const table = pe + 24 + optional
  let retainedMarker = false
  if (count >= 1 && count <= 96 && optional >= 112 && table + count * 40 <= bytes.length) {
    for (let off = table; off < table + count * 40; off += 40) {
      const size = bytes.readUInt32LE(off + 16), start = bytes.readUInt32LE(off + 20)
      const flags = bytes.readUInt32LE(off + 36)
      if ((flags & 0x40) && (flags & 0x40000000) && !(flags & 0x80000000) &&
          start >= table + count * 40 && size > 0 && start + size <= bytes.length &&
          bytes.subarray(start, start + size).includes(Buffer.from(SETUP_LEASE_NAPI_MARKER))) {
        retainedMarker = true
      }
    }
  }
  if (!retainedMarker) {
    throw new Error('native Setup lease addon lacks retained N-API protocol marker')
  }
  return { protocol: 1, format: 'pe', arch: 'x64', napi: SETUP_LEASE_NAPI_MARKER,
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

export function validateCoordinationSetup(identity, bytes, commit, releaseBaseUrl) {
  const keys = ['protocol', 'sourceSha', 'sha256', 'size']
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      Object.keys(identity).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(identity, key)) ||
      identity.protocol !== 1 ||
      !/^[a-f0-9]{40}$/.test(identity.sourceSha) || identity.sourceSha !== commit ||
      !/^[a-f0-9]{64}$/.test(identity.sha256) || !Number.isSafeInteger(identity.size) ||
      identity.size < 64 || identity.size > 256 * 1024 * 1024 ||
      bytes.length !== identity.size ||
      createHash('sha256').update(bytes).digest('hex') !== identity.sha256) {
    throw new Error('common Setup identity does not match verified artifact source/bytes')
  }
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0
  if (bytes.subarray(0, 2).toString('ascii') !== 'MZ' || pe < 64 || pe + 26 > bytes.length ||
      !bytes.subarray(pe, pe + 4).equals(Buffer.from([80, 69, 0, 0])) ||
      bytes.readUInt16LE(pe + 4) !== 0x8664 || !(bytes.readUInt16LE(pe + 22) & 2) ||
      bytes.readUInt16LE(pe + 24) !== 0x20b) {
    throw new Error('common Setup is not a Windows x64 executable')
  }
  const count = bytes.readUInt16LE(pe + 6), optional = bytes.readUInt16LE(pe + 20)
  const table = pe + 24 + optional
  let capable = false
  let handoffCapable = false
  if (count >= 1 && count <= 96 && optional >= 112 && table + count * 40 <= bytes.length) {
    for (let off = table; off < table + count * 40; off += 40) {
      const size = bytes.readUInt32LE(off + 16), start = bytes.readUInt32LE(off + 20)
      const flags = bytes.readUInt32LE(off + 36)
      if ((flags & 0x40) && (flags & 0x40000000) && !(flags & 0x80000000) &&
          start >= table + count * 40 && size > 0 && start + size <= bytes.length) {
        const section = bytes.subarray(start, start + size)
        if (section.includes(Buffer.from(UPDATE_COORDINATION_PE_MARKER))) {capable = true}
        if (section.includes(Buffer.from(SETUP_HANDOFF_PE_MARKER))) {handoffCapable = true}
      }
    }
  }
  if (!capable || !bytes.includes(Buffer.from(commit)) ||
      typeof releaseBaseUrl !== 'string' || !bytes.includes(Buffer.from(releaseBaseUrl))) {
    throw new Error('common Setup lacks compiled coordination capability/source pin')
  }
  return { protocol: 1, sourceSha: identity.sourceSha, sha256: identity.sha256, size: identity.size,
    ...(handoffCapable ? { handoffProtocol: 2 } : {}) }
}

function readVerifiedSetupInput(file) {
  const before = lstatSync(file, { bigint: true })

  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > 256n * 1024n * 1024n) {
    throw new Error('common Setup must be a bounded single-link regular file')
  }

  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))

  try {
    const opened = fstatSync(fd, { bigint: true })

    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev ||
        opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('common Setup changed before read')
    }

    const bytes = Buffer.alloc(Number(opened.size) + 1)
    let length = 0

    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)

      if (!count) {break}
      length += count
    }

    const after = fstatSync(fd, { bigint: true })
    const named = lstatSync(file, { bigint: true })

    if (BigInt(length) !== opened.size || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1n ||
        after.dev !== opened.dev || after.ino !== opened.ino || named.dev !== opened.dev || named.ino !== opened.ino ||
        after.size !== opened.size || named.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs) {
      throw new Error('common Setup changed during read')
    }

    return bytes.subarray(0, length)
  } finally {
    closeSync(fd)
  }
}

function coordinationStamp(env, stamp, repoRoot, execFn) {
  const customer = env.YOUTAB_AGENT_CUSTOMER_BUILD === '1'
  const development = env.YOUTAB_AGENT_DEVELOPMENT_COORDINATION === '1'
  if (customer && development) throw new Error('customer and development coordination modes are mutually exclusive')
  if (!customer && !development) {
    if (env.YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY || env.YOUTAB_AGENT_COORDINATION_SETUP_PATH) {
      throw new Error('coordination identity requires an explicit customer artifact build or development mode')
    }
    return null
  }
  if (customer) {
    const local = fromLocalGit(repoRoot, execFn)
    if (!/^[a-f0-9]{40}$/.test(stamp.commit) || isFallbackCommit(stamp.commit) || stamp.dirty ||
        !stamp.releaseBaseUrl || local?.dirty || (local && local.commit !== stamp.commit)) {
      throw new Error('customer artifact build requires an exact clean source and release base')
    }
  }
  const path = env.YOUTAB_AGENT_COORDINATION_SETUP_PATH
  if (!path || !isAbsolute(path)) throw new Error('coordination build requires a fixed Setup path')
  const identity = JSON.parse(env.YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY || 'null')
  if (development && isFallbackCommit(identity?.sourceSha)) {
    throw new Error('development helper requires its actual common Setup source pin')
  }
  const source = development ? identity?.sourceSha : stamp.commit
  const verified = validateCoordinationSetup(identity, readVerifiedSetupInput(path), source, stamp.releaseBaseUrl)
  if (customer && verified.handoffProtocol !== 2) {
    throw new Error('customer common Setup requires native handoff protocol v2')
  }
  return development ? { ...verified, developmentOnly: true } : verified
}

export function isFallbackCommit(commit) {
  return typeof commit === "string" && /^0{7,40}$/.test(commit)
}

function main() {
  const resolved = resolveStamp()
  // Windows staging always requires the pinned native lease, including local
  // install-only builds that do not enable the customer update handoff.
  const stamp = process.platform === 'win32' && !resolved.setupLease
    ? { ...resolved, setupLease: validateSetupLeaseAddon(readVerifiedSetupInput(SETUP_LEASE_ADDON)) }
    : resolved

  if (isFallbackCommit(stamp.commit)) {
    console.warn(
      "[write-build-stamp] WARNING: no git commit found (non-git checkout?).\n" +
        "  Using placeholder commit — the packaged app will fall back to the\n" +
        "  default branch for first-launch bootstrap.  For production builds,\n" +
        "  run from a git checkout or set $GITHUB_SHA."
    )
  }

  if (stamp.dirty) {
    console.warn(
      "[write-build-stamp] WARNING: working tree is dirty.\n" +
        "  Pinning to " +
        stamp.commit.slice(0, 12) +
        " but the packaged code may differ from that commit.\n" +
        "  Commit your changes before publishing this build."
    )
  }

  const payload = {
    schemaVersion: STAMP_SCHEMA_VERSION,
    commit: stamp.commit,
    branch: stamp.branch,
    builtAt: new Date().toISOString(),
    dirty: stamp.dirty,
    source: stamp.source,
    releaseBaseUrl: stamp.releaseBaseUrl,
    ...(stamp.updateCoordination ? { updateCoordination: stamp.updateCoordination } : {}),
    ...(stamp.setupLease ? { setupLease: stamp.setupLease } : {})
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const coordinationDir = join(OUT_DIR, 'update-coordination')
  const coordinationResource = join(coordinationDir, 'Youtab-Setup.exe')
  mkdirSync(coordinationDir, { recursive: true })
  if (stamp.updateCoordination) {
    copyFileSync(process.env.YOUTAB_AGENT_COORDINATION_SETUP_PATH, coordinationResource)
    // Recheck the four-field identity already validated by resolveStamp;
    // developmentOnly is the separate output mode label, never trusted input.
    const { protocol, sourceSha, sha256, size } = stamp.updateCoordination
    const copied = validateCoordinationSetup({ protocol, sourceSha, sha256, size }, readFileSync(coordinationResource),
      stamp.updateCoordination.developmentOnly ? sourceSha : stamp.commit, stamp.releaseBaseUrl)
    if (!stamp.updateCoordination.developmentOnly && copied.handoffProtocol !== 2) {
      throw new Error('customer packaged Setup lost native handoff protocol v2')
    }
  } else {
    // Never carry a prior customer helper into an unrelated development pack.
    rmSync(coordinationResource, { force: true })
  }
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8")
  console.log(
    "[write-build-stamp] wrote " +
      relative(REPO_ROOT, OUT_FILE) +
      " -> " +
      stamp.commit.slice(0, 12) +
      (stamp.branch ? " (" + stamp.branch + ")" : "") +
      (stamp.dirty ? " [DIRTY]" : "") +
      (stamp.source === "fallback" ? " [FALLBACK]" : "")
  )
}

if (isMain(import.meta.url)) {
  main()
}
