import { type BigIntStats, chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { execFileNoThrow } from './execFileNoThrow.js'

// These tests shell out to /bin/sh, use executable shell fixtures, and rely on
// POSIX job control. They will not work on Windows.
const onWindows = process.platform === 'win32'

// We simulate `wl-copy`'s daemonization behavior with a tiny shell script:
//   1. Fork a short-lived background sleeper that inherits stdio (so the
//      parent process's pipes can never close).
//   2. Record an owned handshake so afterEach can release it without PID signals.
//   3. Exit immediately with status 0.
//
// Without resolveOnExit, the await on `'close'` hangs until SIGTERM at
// timeout — exactly the production wl-copy bug. With resolveOnExit, the
// promise settles on `'exit'` regardless of the inherited pipes.

let scriptDir: string
let daemonScript: string
let sleeperFiles: string[]
let sleeperScript: string
let scriptIdentity: BigIntStats

/** Track the unique owned child handshake, never signal a PID from file contents. */
function trackSleeperPid(pidFile: string): void {
  sleeperFiles.push(pidFile)
}

const quoteShell = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

function daemonBody(code: number) {
  return `#!/bin/sh\n${quoteShell(process.execPath)} ${quoteShell(sleeperScript)} "$1" &\nwhile [ ! -f "$1" ]; do sleep 0.01; done\nexit ${code}\n`
}

beforeEach(() => {
  sleeperFiles = []
  scriptDir = mkdtempSync(join(tmpdir(), 'youtab-execfile-test-'))
  scriptIdentity = lstatSync(scriptDir, { bigint: true })
  daemonScript = join(scriptDir, 'fake-daemonizer.sh')
  sleeperScript = join(scriptDir, 'owned-sleeper.mjs')
  // This real background child inherits the shell's stdio and has the same
  // three-second lifetime as the original sleep fixture. An owned release
  // handshake lets afterEach close it without signaling a recycled PID.
  writeFileSync(sleeperScript, `
import fs from 'node:fs'
const marker = process.argv[2]
fs.writeFileSync(marker, String(process.pid), { flag: 'wx', mode: 0o600 })
const finish = () => {
  fs.writeFileSync(marker + '.done', 'done', { flag: 'wx', mode: 0o600 })
  process.exit(0)
}
setTimeout(finish, 3000)
setInterval(() => { if (fs.existsSync(marker + '.release')) finish() }, 20)
`, { flag: 'wx', mode: 0o600 })
  writeFileSync(daemonScript, daemonBody(0), { flag: 'wx', mode: 0o700 })
  chmodSync(daemonScript, 0o700)
})

/** Bound the owned handshake and reject callback errors without leaking timers. */
function waitForOwnedSleeper(marker: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: unknown) => {
      clearInterval(poll)
      clearTimeout(deadline)

      if (error !== undefined) {
        reject(error)
      } else {
        resolve()
      }
    }

    const poll = setInterval(() => {
      try {
        if (!existsSync(marker + '.done')) {
          return
        }

        const pidText = readFileSync(marker, 'utf8')
        const pid = Number(pidText)

        if (!/^[1-9][0-9]*$/.test(pidText) || !Number.isSafeInteger(pid)) {
          throw new Error('Owned child PID handshake is invalid')
        }

        if (process.platform === 'linux') {
          try {
            if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(sleeperScript)) {
              return
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error
            }
          }
        }

        settle()
      } catch (error) {
        settle(error)
      }
    }, 20)

    const deadline = setTimeout(() => settle(new Error('Owned child completion handshake timed out; fixture preserved')), timeoutMs)
  })
}

afterEach(async () => {
  const current = lstatSync(scriptDir, { bigint: true })

  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== scriptIdentity.dev || current.ino !== scriptIdentity.ino) {
    throw new Error('Owned fixture directory changed')
  }

  for (const marker of sleeperFiles) {
    writeFileSync(marker + '.release', 'release', { flag: 'wx', mode: 0o600 })
  }

  // A failure preserves the fixture: termination has not been established.
  await Promise.all(sleeperFiles.map(marker => waitForOwnedSleeper(marker)))
  rmSync(scriptDir, { recursive: true, force: true })
}, 7000)

it('bounds a missing child completion handshake without an uncaught timer error', async () => {
  const marker = join(scriptDir, 'missing-handshake.pid')
  await expect(waitForOwnedSleeper(marker, 30)).rejects.toThrow('timed out')
})

it('rejects malformed completed child handshakes through the promise', async () => {
  const marker = join(scriptDir, 'invalid-handshake.pid')
  writeFileSync(marker, 'not-a-pid', { flag: 'wx', mode: 0o600 })
  writeFileSync(marker + '.done', 'done', { flag: 'wx', mode: 0o600 })
  await expect(waitForOwnedSleeper(marker, 1000)).rejects.toThrow('PID handshake is invalid')
})
it('uses an exclusive owned temporary fixture directory', () => {
  expect(existsSync(daemonScript)).toBe(true)

  if (!onWindows) {
    expect(statSync(scriptDir).mode & 0o777).toBe(0o700)
    expect(statSync(daemonScript).mode & 0o777).toBe(0o700)
    expect(statSync(sleeperScript).mode & 0o777).toBe(0o600)
  }
})

describe.skipIf(onWindows)('execFileNoThrow with daemon-style children', () => {
  // Skipped because the bug it documents is a forever-hang. Without
  // resolveOnExit, the 'close' event doesn't fire when the immediate
  // child has exited but a forked daemon still holds stdio open. Even
  // SIGTERM at the timeout doesn't help — the daemon survives it. To
  // verify by hand: remove `it.skip` and watch the test timeout. This
  // test is here so a reviewer reading the resolveOnExit option knows
  // *why* every clipboard-tool spawn in osc.ts wires it on.
  it.skip('(documented hang) without resolveOnExit, await never resolves when daemon inherits stdio', async () => {
    const pidFile = join(scriptDir, 'sleeper-skip.pid')
    const result = await execFileNoThrow(daemonScript, [pidFile], { timeout: 300 })
    trackSleeperPid(pidFile)

    expect(result.code).toBe(124)
  })

  it("settles immediately on 'exit' when resolveOnExit is true, regardless of daemon stdio", async () => {
    const pidFile = join(scriptDir, 'sleeper-exit.pid')
    const start = Date.now()

    const result = await execFileNoThrow(daemonScript, [pidFile], {
      timeout: 2000,
      resolveOnExit: true
    })

    trackSleeperPid(pidFile)

    const elapsed = Date.now() - start

    // The shell exits in a few ms. resolveOnExit lets us return on exit
    // (code 0) instead of waiting for the orphaned sleeper to release
    // stdio. Should be well under 200ms even on slow CI.
    expect(result.code).toBe(0)
    expect(elapsed).toBeLessThan(500)
  })

  it("still surfaces the right code when resolveOnExit'd child exits non-zero", async () => {
    const pidFile = join(scriptDir, 'sleeper-fail.pid')
    const failScript = join(scriptDir, 'fail.sh')
    writeFileSync(failScript, daemonBody(7), { flag: 'wx', mode: 0o700 })
    chmodSync(failScript, 0o700)

    const result = await execFileNoThrow(failScript, [pidFile], {
      timeout: 2000,
      resolveOnExit: true
    })

    trackSleeperPid(pidFile)

    expect(result.code).toBe(7)
  })

  it('settles on timeout=124 when the child itself never exits, even with resolveOnExit', async () => {
    const slowScript = join(scriptDir, 'slow.sh')
    writeFileSync(slowScript, '#!/bin/sh\nexec sleep 30\n', { flag: 'wx', mode: 0o700 })
    chmodSync(slowScript, 0o700)

    const result = await execFileNoThrow(slowScript, [], {
      timeout: 200,
      resolveOnExit: true
    })

    // Child process never exits on its own → timer fires → SIGTERM →
    // child exits → 'exit' fires with non-null signal. The settle()
    // call from the timer registers code=124 first. Either way: 124.
    expect(result.code).toBe(124)
  })

  it('does not double-resolve when both timer and exit fire', async () => {
    const pidFile = join(scriptDir, 'sleeper-race.pid')

    // Race: child happens to exit right around the timeout. The settled
    // guard ensures only the first resolution wins.
    const result = await execFileNoThrow(daemonScript, [pidFile], {
      timeout: 50, // very tight
      resolveOnExit: true
    })

    trackSleeperPid(pidFile)

    // Either code=0 (exit beat timer) or code=124 (timer beat exit).
    // Both are valid outcomes; the contract is that the promise settles
    // exactly once and doesn't throw.
    expect([0, 124]).toContain(result.code)
  })
})
