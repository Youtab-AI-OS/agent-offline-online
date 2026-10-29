#!/usr/bin/env node
// Producer-only build. Customer Setup installs the already compiled .node.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32') process.exit(0)
if (process.arch !== 'x64') throw new Error('Windows Setup lease requires an x64 producer')
if (process.env.YOUTAB_AGENT_CUSTOMER_BUILD === '1') {
  throw new Error('Customer Setup must use the reviewed prebuilt lease addon, not a local native compiler')
}

const desktop = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const target = desktop.devDependencies?.electron
if (!/^\d+\.\d+\.\d+$/.test(target) || desktop.build?.electronVersion !== target) {
  throw new Error('Electron build target must match the exact desktop dependency')
}
const lock = JSON.parse(readFileSync(path.join(root, '..', '..', 'package-lock.json'), 'utf8'))
const lockedElectron = lock.packages?.['node_modules/electron']?.version
if (lockedElectron !== target) throw new Error('Electron build target differs from the root lockfile')
const repo = path.resolve(root, '..', '..')
const sourcePaths = [
  'apps/desktop/native/setup-lease/binding.gyp',
  'apps/desktop/native/setup-lease/setup_lease.cc',
  'apps/desktop/package.json',
  'package-lock.json'
]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Producer build needs an exact source commit')
const sourceHashes = Object.fromEntries(sourcePaths.map(relative => [
  relative, sha256(readFileSync(path.join(repo, ...relative.split('/'))))
]))

const source = path.join(root, 'native', 'setup-lease')
const output = path.join(root, 'build', 'native', 'setup_lease.node')
const receipt = path.join(root, 'build', 'native', 'setup_lease.provenance.json')
const workRoot = process.env.YOUTAB_NATIVE_BUILD_ROOT
  || (existsSync('D:\\Youtab-test-work') ? 'D:\\Youtab-test-work\\setup-lease-build' : tmpdir())
mkdirSync(workRoot, { recursive: true })
rmSync(output, { force: true })
rmSync(receipt, { force: true })
const work = mkdtempSync(path.join(workRoot, 'youtab-setup-lease-'))
try {
  cpSync(path.join(source, 'binding.gyp'), path.join(work, 'binding.gyp'))
  cpSync(path.join(source, 'setup_lease.cc'), path.join(work, 'setup_lease.cc'))
  const nodeGyp = path.resolve(root, '..', '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  if (!existsSync(nodeGyp)) throw new Error('Pinned node-gyp is unavailable')
  const args = [nodeGyp, 'rebuild', '--directory', work, `--target=${target}`, '--dist-url=https://electronjs.org/headers']
  const result = spawnSync(process.execPath, args, { cwd: work, stdio: 'inherit', timeout: 180_000 })
  if (result.status !== 0) throw new Error(`Setup lease native build failed (${result.status ?? 'timeout'})`)
  const built = path.join(work, 'build', 'Release', 'setup_lease.node')
  if (!existsSync(built)) throw new Error('Setup lease native output is missing')
  const bytes = readFileSync(built)
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('Setup lease is not a Windows PE')
  mkdirSync(path.dirname(output), { recursive: true })
  cpSync(built, output)
  writeFileSync(receipt, JSON.stringify({
    schema: 1,
    source_sha: sourceSha,
    source_files_sha256: sourceHashes,
    electron_target: target,
    build_tool: 'node-gyp',
    build_command: `node-gyp rebuild --target=${target} --dist-url=https://electronjs.org/headers`,
    build_result: 0,
    addon_sha256: sha256(bytes),
    addon_size: bytes.length
  }, null, 2) + '\n')
  console.log('[build-setup-lease] producer x64 PE staged for immutable build stamp')
} finally {
  const relativeScratch = path.relative(path.resolve(workRoot), path.resolve(work))
  if (!relativeScratch.startsWith('youtab-setup-lease-') || relativeScratch.includes('..') || path.isAbsolute(relativeScratch)) {
    throw new Error('Setup lease scratch path escaped its build root')
  }
  rmSync(work, { recursive: true, force: true })
}
