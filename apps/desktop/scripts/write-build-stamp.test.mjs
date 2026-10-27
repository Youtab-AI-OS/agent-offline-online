import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync, linkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  FALLBACK_BRANCH,
  FALLBACK_COMMIT,
  fromCI,
  fromFallback,
  fromLocalGit,
  isFallbackCommit,
  resolveStamp,
  validateCoordinationSetup,
  validateSetupLeaseAddon,
  UPDATE_COORDINATION_PE_MARKER,
  SETUP_HANDOFF_PE_MARKER,
  SETUP_LEASE_NAPI_MARKER
} from './write-build-stamp.mjs'

test('fromCI reads GITHUB_SHA / GITHUB_REF_NAME', () => {
  assert.deepEqual(
    fromCI({ GITHUB_SHA: 'a'.repeat(40), GITHUB_REF_NAME: 'release' }),
    { commit: 'a'.repeat(40), branch: 'release', dirty: false, source: 'ci' }
  )
  assert.equal(fromCI({}), null)
})

test('fromLocalGit returns null when git rev-parse fails', () => {
  const stamp = fromLocalGit('/tmp/not-a-repo', () => null)
  assert.equal(stamp, null)
})

test('fromLocalGit reads HEAD + branch + dirty status', () => {
  const calls = []
  const execFn = (cmd) => {
    calls.push(cmd)
    if (cmd === 'git rev-parse HEAD') return 'b'.repeat(40)
    if (cmd === 'git rev-parse --abbrev-ref HEAD') return 'main'
    if (cmd === 'git status --porcelain -uno') return ' M apps/desktop/package.json'
    return null
  }
  assert.deepEqual(fromLocalGit('/repo', execFn), {
    commit: 'b'.repeat(40),
    branch: 'main',
    dirty: true,
    source: 'local'
  })
  assert.ok(calls.includes('git rev-parse HEAD'))
})

test('fromFallback uses the all-zero placeholder commit', () => {
  assert.deepEqual(fromFallback(), {
    commit: FALLBACK_COMMIT,
    branch: FALLBACK_BRANCH,
    dirty: false,
    source: 'fallback'
  })
  assert.equal(isFallbackCommit(FALLBACK_COMMIT), true)
  assert.equal(isFallbackCommit('a'.repeat(40)), false)
})

test('resolveStamp prefers CI over local git over fallback', () => {
  const ci = resolveStamp({
    env: { GITHUB_SHA: 'c'.repeat(40), GITHUB_REF_NAME: 'main' },
    execFn: () => 'should-not-run'
  })
  assert.equal(ci.source, 'ci')
  assert.equal(ci.commit, 'c'.repeat(40))

  const local = resolveStamp({
    env: {},
    execFn: (cmd) => {
      if (cmd === 'git rev-parse HEAD') return 'd'.repeat(40)
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return 'main'
      if (cmd === 'git status --porcelain -uno') return ''
      return null
    }
  })
  assert.equal(local.source, 'local')
  assert.equal(local.commit, 'd'.repeat(40))
  assert.equal(local.dirty, false)
})

test('resolveStamp falls back when neither CI nor git is available', () => {
  const stamp = resolveStamp({ env: {}, execFn: () => null })
  assert.deepEqual(stamp, {
    commit: FALLBACK_COMMIT,
    branch: FALLBACK_BRANCH,
    dirty: false,
    source: 'fallback',
    releaseBaseUrl: null
  })
})

test('resolveStamp embeds only the configured fixed pilot release origin', () => {
  const base = `https://api.youtab.io/pilot-runtime-${'a'.repeat(32)}/releases`
  const stamp = resolveStamp({ env: { YOUTAB_AGENT_RELEASE_BASE_URL: base }, execFn: () => null })
  assert.equal(stamp.releaseBaseUrl, base)
  for (const invalid of [
    `https://evil.example/pilot-runtime-${'a'.repeat(32)}/releases`,
    'https://api.youtab.io/runtime/releases',
    `${base}/../../other`,
    `${base}?redirect=evil`
  ]) {
    assert.throws(
      () => resolveStamp({ env: { YOUTAB_AGENT_RELEASE_BASE_URL: invalid }, execFn: () => null }),
      /approved api.youtab.io pilot release path/
    )
  }
})

function coordinationFixture(handoff = false) {
  const commit = 'e'.repeat(40)
  const base = `https://api.youtab.io/pilot-runtime-${'a'.repeat(32)}/releases`
  const image = Buffer.alloc(1024)
  image.write('MZ'); image.writeUInt32LE(64, 60); image.set([80, 69, 0, 0], 64)
  image.writeUInt16LE(0x8664, 68); image.writeUInt16LE(1, 70)
  image.writeUInt16LE(240, 84); image.writeUInt16LE(2, 86); image.writeUInt16LE(0x20b, 88)
  const payload = Buffer.from(commit + base + UPDATE_COORDINATION_PE_MARKER + (handoff ? SETUP_HANDOFF_PE_MARKER : ''))
  image.writeUInt32LE(payload.length, 344); image.writeUInt32LE(512, 348)
  image.writeUInt32LE(0x40000040, 364); image.set(payload, 512)
  const identity = { protocol: 1, sourceSha: commit, sha256: createHash('sha256').update(image).digest('hex'), size: image.length }
  return { commit, base, image, identity }
}

function leaseAddonFixture() {
  const image = Buffer.alloc(1024)
  image.write('MZ'); image.writeUInt32LE(64, 60); image.set([80, 69, 0, 0], 64)
  image.writeUInt16LE(0x8664, 68); image.writeUInt16LE(1, 70)
  image.writeUInt16LE(240, 84); image.writeUInt16LE(0x2002, 86); image.writeUInt16LE(0x20b, 88)
  image.writeUInt32LE(SETUP_LEASE_NAPI_MARKER.length, 344); image.writeUInt32LE(512, 348)
  image.writeUInt32LE(0x40000040, 364); image.write(SETUP_LEASE_NAPI_MARKER, 512)
  return image
}

test('customer native Setup lease addon must be a bounded PE x64 DLL with retained N-API marker', () => {
  const image = leaseAddonFixture()
  assert.deepEqual(validateSetupLeaseAddon(image), {
    protocol: 1, format: 'pe', arch: 'x64', napi: SETUP_LEASE_NAPI_MARKER,
    sha256: createHash('sha256').update(image).digest('hex'), size: image.length
  })
  for (const mutate of [
    bytes => { bytes.writeUInt16LE(0xaa64, 68); return bytes }, // ARM64
    bytes => { bytes.writeUInt16LE(2, 86); return bytes }, // EXE, not a DLL
    bytes => { bytes.writeUInt16LE(0x10b, 88); return bytes }, // PE32
    bytes => { bytes.writeUInt32LE(0xc0000040, 364); return bytes }, // Writable marker
    bytes => { bytes.fill(0, 512, 512 + SETUP_LEASE_NAPI_MARKER.length); return bytes },
    bytes => { bytes.fill(0, 512, 512 + SETUP_LEASE_NAPI_MARKER.length); return Buffer.concat([bytes, Buffer.from(SETUP_LEASE_NAPI_MARKER)]) }
  ]) {
    assert.throws(() => validateSetupLeaseAddon(mutate(Buffer.from(image))), /native Setup lease addon/)
  }
  assert.throws(() => validateSetupLeaseAddon(Buffer.from('MZ')), /native Setup lease addon/)
})

test('ordinary customer pack never invokes the native compiler', () => {
  const desktop = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(desktop.scripts.prebuild, 'npm run clean')
  assert.equal(desktop.scripts['build:setup-lease:producer'], 'node scripts/build-setup-lease.mjs')
  assert.ok(!desktop.scripts.pack.includes('build:setup-lease:producer'))
  if (process.platform !== 'win32') return
  const producer = spawnSync(process.execPath, [fileURLToPath(new URL('./build-setup-lease.mjs', import.meta.url))], {
    env: { ...process.env, YOUTAB_AGENT_CUSTOMER_BUILD: '1' }, encoding: 'utf8', timeout: 10_000
  })
  assert.notEqual(producer.status, 0)
  assert.match(producer.stderr, /must use the reviewed prebuilt lease addon/)
})

test('only a retained read-only Setup capability enables v2 handoff in the build stamp', () => {
  const { commit, base, image, identity } = coordinationFixture(true)
  assert.deepEqual(validateCoordinationSetup(identity, image, commit, base), { ...identity, handoffProtocol: 2 })
  const overlaid = Buffer.from(image)
  const markerAt = overlaid.indexOf(SETUP_HANDOFF_PE_MARKER)
  overlaid.fill(0, markerAt, markerAt + SETUP_HANDOFF_PE_MARKER.length)
  const outside = Buffer.concat([overlaid, Buffer.from(SETUP_HANDOFF_PE_MARKER)])
  const outsideIdentity = { ...identity, sha256: createHash('sha256').update(outside).digest('hex'), size: outside.length }
  assert.deepEqual(validateCoordinationSetup(outsideIdentity, outside, commit, base), outsideIdentity)
})

test('customer packaged stamp embeds only verified common Setup source, hash, size and capability', () => {
  const { commit, base, image, identity } = coordinationFixture(true)
  const dir = mkdtempSync(join(tmpdir(), 'youtab-stamp-'))
  try {
    const path = join(dir, 'youtab-setup.exe'); writeFileSync(path, image)
    const addonPath = join(dir, 'setup_lease.node'); writeFileSync(addonPath, leaseAddonFixture())
    const addonPin = validateSetupLeaseAddon(leaseAddonFixture())
    const env = { GITHUB_SHA: commit, YOUTAB_AGENT_RELEASE_BASE_URL: base,
      YOUTAB_AGENT_CUSTOMER_BUILD: '1', YOUTAB_AGENT_COORDINATION_SETUP_PATH: path,
      YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY: JSON.stringify(identity),
      YOUTAB_AGENT_SETUP_LEASE_SHA256: addonPin.sha256,
      YOUTAB_AGENT_SETUP_LEASE_SIZE: String(addonPin.size) }
    const stamped = resolveStamp({ env, execFn: () => null, setupLeasePath: addonPath })
    assert.deepEqual(stamped.updateCoordination, { ...identity, handoffProtocol: 2 })
    assert.deepEqual(stamped.setupLease, validateSetupLeaseAddon(leaseAddonFixture()))
    assert.throws(() => resolveStamp({ env: { ...env, YOUTAB_AGENT_SETUP_LEASE_SHA256: '0'.repeat(64) },
      execFn: () => null, setupLeasePath: addonPath }), /immutable release manifest/)
    assert.throws(() => resolveStamp({ env: { ...env, YOUTAB_AGENT_SETUP_LEASE_SIZE: '1025' },
      execFn: () => null, setupLeasePath: addonPath }), /immutable release manifest/)
    assert.throws(() => resolveStamp({ env: { ...env, YOUTAB_AGENT_SETUP_LEASE_SHA256: undefined },
      execFn: () => null, setupLeasePath: addonPath }), /immutable release manifest/)
    assert.throws(() => resolveStamp({ env, execFn: () => null, setupLeasePath: join(dir, 'missing.node') }), /ENOENT/)
    writeFileSync(addonPath, Buffer.from('malicious addon'))
    assert.throws(() => resolveStamp({ env, execFn: () => null, setupLeasePath: addonPath }), /native Setup lease addon/)
    writeFileSync(addonPath, leaseAddonFixture())
    const old = coordinationFixture()
    writeFileSync(path, old.image)
    assert.throws(() => resolveStamp({ env: { ...env,
      YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY: JSON.stringify(old.identity) }, execFn: () => null, setupLeasePath: addonPath }), /handoff protocol v2/)
    writeFileSync(path, image)
    assert.throws(() => resolveStamp({ env: { ...env, GITHUB_SHA: FALLBACK_COMMIT }, execFn: () => null, setupLeasePath: addonPath }), /exact clean source/)
    assert.throws(() => resolveStamp({ env: { ...env, GITHUB_SHA: 'unknown' }, execFn: () => null, setupLeasePath: addonPath }), /exact clean source/)
    assert.throws(() => resolveStamp({ env, execFn: cmd => cmd === 'git rev-parse HEAD' ? commit : ' M file', setupLeasePath: addonPath }), /exact clean source/)
    assert.throws(() => resolveStamp({ env: { ...env, YOUTAB_AGENT_CUSTOMER_BUILD: undefined }, execFn: () => null }), /explicit customer/)
    assert.throws(() => resolveStamp({ env: { ...env, YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY: '{}' }, execFn: () => null, setupLeasePath: addonPath }), /identity/)
    writeFileSync(path, Buffer.from('tampered'))
    assert.throws(() => resolveStamp({ env, execFn: () => null, setupLeasePath: addonPath }), /identity/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('customer stamp cannot bless old binary, writable marker, overlay marker or fabricated source pin', () => {
  const { commit, base, image, identity } = coordinationFixture()
  for (const mutate of [
    data => { data.fill(0, data.indexOf(UPDATE_COORDINATION_PE_MARKER), data.indexOf(UPDATE_COORDINATION_PE_MARKER) + UPDATE_COORDINATION_PE_MARKER.length); return data },
    data => { data.writeUInt32LE(0xc0000040, 364); return data },
    data => { data.fill(0, data.indexOf(UPDATE_COORDINATION_PE_MARKER), data.indexOf(UPDATE_COORDINATION_PE_MARKER) + UPDATE_COORDINATION_PE_MARKER.length); return Buffer.concat([data, Buffer.from(UPDATE_COORDINATION_PE_MARKER)]) },
    data => { data.fill(0, 512, 552); return data }
  ]) {
    const bytes = mutate(Buffer.from(image))
    const bound = { ...identity, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    assert.throws(() => validateCoordinationSetup(bound, bytes, commit, base), /compiled coordination/)
  }
  for (const patch of [{ protocol: 2 }, { sourceSha: 'f'.repeat(40) }, { size: -1 }, { sha256: '0'.repeat(64) }]) {
    assert.throws(() => validateCoordinationSetup({ ...identity, ...patch }, image, commit, base), /identity/)
  }
})

test('pack entry point copies the same validated Setup resource and clears it for noncustomer builds', () => {
  const { commit, base, image, identity } = coordinationFixture(true)
  const dir = mkdtempSync(join(tmpdir(), 'youtab-stamp-pack-'))
  const desktop = join(dir, 'apps/desktop')
  mkdirSync(join(desktop, 'scripts'), { recursive: true })
  const entry = join(desktop, 'scripts/write-build-stamp.mjs')
  copyFileSync(fileURLToPath(new URL('./write-build-stamp.mjs', import.meta.url)), entry)
  copyFileSync(fileURLToPath(new URL('./utils.mjs', import.meta.url)), join(desktop, 'scripts/utils.mjs'))
  const resource = join(desktop, 'build/update-coordination/Youtab-Setup.exe')
  const addonResource = join(desktop, 'build/native/setup_lease.node')
  const stampFile = join(desktop, 'build/install-stamp.json')
  const cleanEnv = { ...process.env }
  for (const key of ['GITHUB_SHA', 'GITHUB_REF_NAME', 'GITHUB_HEAD_REF',
    'YOUTAB_AGENT_RELEASE_BASE_URL', 'YOUTAB_AGENT_CUSTOMER_BUILD', 'YOUTAB_AGENT_DEVELOPMENT_COORDINATION',
    'YOUTAB_AGENT_COORDINATION_SETUP_PATH', 'YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY',
    'YOUTAB_AGENT_SETUP_LEASE_SHA256', 'YOUTAB_AGENT_SETUP_LEASE_SIZE']) delete cleanEnv[key]
  try {
    const path = join(dir, 'youtab-setup.exe'); writeFileSync(path, image)
    const addon = leaseAddonFixture()
    mkdirSync(join(desktop, 'build/native'), { recursive: true })
    writeFileSync(addonResource, addon)
    const env = { ...cleanEnv, GITHUB_SHA: commit, YOUTAB_AGENT_RELEASE_BASE_URL: base,
      YOUTAB_AGENT_CUSTOMER_BUILD: '1', YOUTAB_AGENT_COORDINATION_SETUP_PATH: path,
      YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY: JSON.stringify(identity),
      YOUTAB_AGENT_SETUP_LEASE_SHA256: createHash('sha256').update(addon).digest('hex'),
      YOUTAB_AGENT_SETUP_LEASE_SIZE: String(addon.length) }
    const customer = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(customer.status, 0, customer.stderr)
    assert.deepEqual(readFileSync(resource), image)
    assert.deepEqual(JSON.parse(readFileSync(stampFile, 'utf8')).updateCoordination, { ...identity, handoffProtocol: 2 })
    assert.deepEqual(JSON.parse(readFileSync(stampFile, 'utf8')).setupLease, validateSetupLeaseAddon(addon))
    rmSync(addonResource)
    const missingAddon = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 10000 })
    assert.notEqual(missingAddon.status, 0)
    writeFileSync(addonResource, addon)
    const local = spawnSync(process.execPath, [entry], { env: cleanEnv, encoding: 'utf8', timeout: 10000 })
    assert.equal(local.status, 0, local.stderr)
    assert.equal(existsSync(resource), false)
    assert.equal(JSON.parse(readFileSync(stampFile, 'utf8')).updateCoordination, undefined)
    assert.equal(JSON.parse(readFileSync(stampFile, 'utf8')).setupLease, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('explicit development route verifies common Setup without pretending dirty or fallback Desktop is its source', () => {
  const { commit, base, image, identity } = coordinationFixture()
  const dir = mkdtempSync(join(tmpdir(), 'youtab-dev-stamp-'))
  try {
    const path = join(dir, 'common-setup.exe'); writeFileSync(path, image)
    const env = { GITHUB_SHA: commit, YOUTAB_AGENT_DEVELOPMENT_COORDINATION: '1',
      YOUTAB_AGENT_RELEASE_BASE_URL: base, YOUTAB_AGENT_COORDINATION_SETUP_PATH: path,
      YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY: JSON.stringify(identity) }
    const fallback = resolveStamp({ env, execFn: () => null })
    assert.equal(fallback.commit, FALLBACK_COMMIT)
    assert.equal(fallback.source, 'fallback')
    assert.deepEqual(fallback.updateCoordination, { ...identity, developmentOnly: true })
    const dirty = resolveStamp({ env, execFn: cmd => {
      if (cmd === 'git rev-parse HEAD') return 'f'.repeat(40)
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return 'dev'
      return ' M current-work'
    } })
    assert.equal(dirty.commit, 'f'.repeat(40)); assert.equal(dirty.dirty, true)
    assert.equal(dirty.updateCoordination.sourceSha, commit)
    assert.equal(dirty.updateCoordination.developmentOnly, true)
    assert.throws(() => resolveStamp({ env: { ...env, YOUTAB_AGENT_CUSTOMER_BUILD: '1' }, execFn: () => null }), /mutually exclusive/)
    assert.throws(() => resolveStamp({ env: { ...env, YOUTAB_AGENT_DEVELOPMENT_COORDINATION: undefined }, execFn: () => null }), /explicit customer/)
    assert.throws(() => resolveStamp({ env: { ...env, YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY: JSON.stringify({ ...identity, sourceSha: FALLBACK_COMMIT }) }, execFn: () => null }), /actual common Setup source pin/)
    const linked = join(dir, 'second-link.exe'); linkSync(path, linked)
    assert.throws(() => resolveStamp({ env, execFn: () => null }), /single-link/)
    unlinkSync(linked)
    writeFileSync(path, Buffer.from('tampered'))
    assert.throws(() => resolveStamp({ env, execFn: () => null }), /identity/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('explicit development stamp entry creates the same verified resource with developmentOnly identity', () => {
  const { base, image, identity } = coordinationFixture()
  const dir = mkdtempSync(join(tmpdir(), 'youtab-dev-entry-'))
  try {
    const desktop = join(dir, 'apps/desktop'); mkdirSync(join(desktop, 'scripts'), { recursive: true })
    const entry = join(desktop, 'scripts/write-build-stamp.mjs')
    copyFileSync(fileURLToPath(new URL('./write-build-stamp.mjs', import.meta.url)), entry)
    copyFileSync(fileURLToPath(new URL('./utils.mjs', import.meta.url)), join(desktop, 'scripts/utils.mjs'))
    const path = join(dir, 'same-common-setup.exe'); writeFileSync(path, image)
    const env = { ...process.env }
    for (const key of ['GITHUB_SHA', 'GITHUB_REF_NAME', 'GITHUB_HEAD_REF', 'YOUTAB_AGENT_CUSTOMER_BUILD']) delete env[key]
    Object.assign(env, { YOUTAB_AGENT_DEVELOPMENT_COORDINATION: '1', YOUTAB_AGENT_RELEASE_BASE_URL: base,
      YOUTAB_AGENT_COORDINATION_SETUP_PATH: path, YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY: JSON.stringify(identity) })
    const child = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 0, child.stderr)
    const stamp = JSON.parse(readFileSync(join(desktop, 'build/install-stamp.json'), 'utf8'))
    assert.equal(stamp.source, 'fallback'); assert.equal(stamp.commit, FALLBACK_COMMIT)
    assert.deepEqual(stamp.updateCoordination, { ...identity, developmentOnly: true })
    assert.deepEqual(readFileSync(join(desktop, 'build/update-coordination/Youtab-Setup.exe')), image)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('common Setup input rejects extra fields and development output labels', () => {
  const { commit, base, image, identity } = coordinationFixture()
  for (const extra of [{ developmentOnly: true }, { developmentOnly: false }, { unexpected: 1 }]) {
    assert.throws(() => validateCoordinationSetup({ ...identity, ...extra }, image, commit, base), /identity/)
  }
  const inherited = Object.create({ protocol: identity.protocol })
  Object.assign(inherited, { sourceSha: identity.sourceSha, sha256: identity.sha256, size: identity.size, filler: true })
  assert.throws(() => validateCoordinationSetup(inherited, image, commit, base), /identity/)
  assert.deepEqual(validateCoordinationSetup(identity, image, commit, base), identity)
})
