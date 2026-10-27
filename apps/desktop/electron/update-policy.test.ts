import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { channelPreferenceStamp, selectedReleaseChannel } from './release-delivery'
import { readDesktopUpdatePolicy, selectedInnoUpdateChannel, validateDesktopUpdatePolicy, writeDesktopUpdatePolicy } from './update-policy'

const fixtures: string[] = []

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-update-policy-test-'))

  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {throw new Error('Unsafe fixture boundary')}
  fixtures.push(root)

  return { root, config: path.join(root, 'private-app', 'updates.json') }
}

afterEach(() => {
  vi.restoreAllMocks()

  for (const root of fixtures.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}
})

describe('native update policy persistence', () => {
  it('defaults off without creating a preference file', () => {
    const { config } = fixture()
    expect(readDesktopUpdatePolicy(config)).toEqual({ enabled: false, automaticChecks: false })
    expect(fs.existsSync(config)).toBe(false)
  })
  it('persists explicit flags across fresh reads while preserving channel, branch and other fields', () => {
    const { config } = fixture()
    fs.mkdirSync(path.dirname(config))
    const previous = { branch: 'release', channel: 'pilot', channelMarker: 'old-marker', retained: { value: 42 } }
    fs.writeFileSync(config, JSON.stringify(previous))
    writeDesktopUpdatePolicy(config, { enabled: true, automaticChecks: false })
    expect(readDesktopUpdatePolicy(config)).toEqual({ enabled: true, automaticChecks: false })
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({
      ...previous,
      updatePolicy: { enabled: true, automaticChecks: false }
    })
    writeDesktopUpdatePolicy(config, { enabled: false, automaticChecks: true })
    expect(readDesktopUpdatePolicy(config)).toEqual({ enabled: false, automaticChecks: true })
    expect(fs.readdirSync(path.dirname(config))).toEqual(['updates.json'])
  })
  it.each([
    null,
    {},
    [],
    { enabled: 'true', automaticChecks: false },
    { enabled: false, automaticChecks: 1 },
    { enabled: true, automaticChecks: true, extra: true }
  ])('rejects invalid flags %j without coercion', (value) => {
    expect(() => validateDesktopUpdatePolicy(value)).toThrow()
  })
  it('fails visibly on malformed persisted data rather than enabling updates or overwriting it', () => {
    const { config } = fixture()
    fs.mkdirSync(path.dirname(config))
    fs.writeFileSync(config, '{broken')
    expect(() => readDesktopUpdatePolicy(config)).toThrow()
    expect(() => writeDesktopUpdatePolicy(config, { enabled: true, automaticChecks: false })).toThrow()
    expect(fs.readFileSync(config, 'utf8')).toBe('{broken')
    fs.writeFileSync(config, JSON.stringify({ updatePolicy: { enabled: 'false', automaticChecks: false } }))
    expect(() => readDesktopUpdatePolicy(config)).toThrow()
  })
  it('preserves the previous file and cleans its own temporary file after an atomic-rename failure', () => {
    const { config } = fixture()
    writeDesktopUpdatePolicy(config, { enabled: false, automaticChecks: false })
    const before = fs.readFileSync(config, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('Synthetic access denied')
    })
    expect(() => writeDesktopUpdatePolicy(config, { enabled: true, automaticChecks: false })).toThrow(
      'Synthetic access denied'
    )
    expect(fs.readFileSync(config, 'utf8')).toBe(before)
    expect(fs.readdirSync(path.dirname(config))).toEqual(['updates.json'])
  })
  it('refuses a reparse application directory and preserves the outside target', () => {
    const { root, config } = fixture()
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'updates.json'), '{"channel":"stable"}')
    fs.symlinkSync(outside, path.dirname(config), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => readDesktopUpdatePolicy(config)).toThrow('unsafe')
    expect(() => writeDesktopUpdatePolicy(config, { enabled: true, automaticChecks: false })).toThrow('unsafe')
    expect(fs.readFileSync(path.join(outside, 'updates.json'), 'utf8')).toBe('{"channel":"stable"}')
  })

  it('keeps the primary write failure visible when temporary-file cleanup also fails', () => {
    const { config } = fixture()
    writeDesktopUpdatePolicy(config, { enabled: false, automaticChecks: false })
    const before = fs.readFileSync(config, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('Synthetic primary write failure')
    })
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('Synthetic secondary cleanup failure')
    })
    expect(() => writeDesktopUpdatePolicy(config, { enabled: true, automaticChecks: false })).toThrow('Synthetic primary write failure')
    expect(fs.readFileSync(config, 'utf8')).toBe(before)
  })
  it('rejects shared-root, alternate-name and non-directory paths before writing', () => {
    const { root, config } = fixture()
    expect(() =>
      writeDesktopUpdatePolicy(path.join(path.parse(root).root, 'updates.json'), {
        enabled: true,
        automaticChecks: true
      })
    ).toThrow()
    expect(() =>
      writeDesktopUpdatePolicy(path.join(root, 'other.json'), { enabled: true, automaticChecks: true })
    ).toThrow()
    fs.writeFileSync(path.dirname(config), 'not a directory')
    expect(() => writeDesktopUpdatePolicy(config, { enabled: true, automaticChecks: true })).toThrow()
  })
})

describe('common Inno update channel selection', () => {
  it('retains Pilot after a program-only sequence change while preserving the separate Setup selector semantics', () => {
    const previousMarker = { releaseSequence: 1 }
    const updatedMarker = { releaseSequence: 2 }
    const document = { channel: 'pilot', channelMarker: channelPreferenceStamp(previousMarker) }

    expect(selectedReleaseChannel(document, updatedMarker)).toBe('stable')
    expect(selectedInnoUpdateChannel(document, selectedReleaseChannel(null, updatedMarker))).toBe('pilot')
  })

  it('retains an explicit Stable preference when the fallback is Pilot', () => {
    expect(selectedInnoUpdateChannel({ channel: 'stable', channelMarker: 'stale-marker' }, 'pilot')).toBe('stable')
  })

  it('uses the installation fallback only when no valid preference exists', () => {
    for (const document of [null, [], {}, { channel: 'PILOT' }, { channel: true }, { channel: '' }]) {
      expect(selectedInnoUpdateChannel(document, 'stable')).toBe('stable')
      expect(selectedInnoUpdateChannel(document, 'pilot')).toBe('pilot')
    }
  })
})
