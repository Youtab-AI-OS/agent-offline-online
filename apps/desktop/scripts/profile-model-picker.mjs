// CPU-profile one model-picker open.
//   node scripts/profile-model-picker.mjs [--port 9222]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { CDP } from './perf/lib/cdp.mjs'
import { cpuProfileTopSelf } from './perf/lib/stats.mjs'

export function writeModelPickerProfile(profile, { tempRoot = os.tmpdir() } = {}) {
  const payload = JSON.stringify(profile)
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(tempRoot), 'youtab-model-picker-'))
  const out = path.join(directory, 'model-picker-open.cpuprofile')
  let fd
  let identity
  try {
    fd = fs.openSync(out, 'wx', 0o600)
    identity = fs.fstatSync(fd, { bigint: true })
    fs.writeFileSync(fd, payload, 'utf8')
    fs.fsyncSync(fd)
    return out
  } catch (error) {
    // Delete only entries created by this invocation; never recurse a temp root.
    if (fd !== undefined) { fs.closeSync(fd); fd = undefined }
    try {
      const current = fs.lstatSync(out, { bigint: true })
      if (identity && current.isFile() && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(out)
    } catch { /* only remove the file created through our exclusive handle */ }
    try { fs.rmdirSync(directory) } catch { /* preserve unexpected entries */ }
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export async function profileModelPicker() {
const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9222)
const cdp = await CDP.connect({ port })
await cdp.send('Runtime.enable')
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 100 })

const OPEN = `
  (async () => {
    // Reset: close any open menu first.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise(r => setTimeout(r, 250))

    const btns = [...document.querySelectorAll('button[aria-label]')]
    const pill = btns.find(b => /model/i.test(b.getAttribute('aria-label') || ''))
    if (!pill) return -1
    const t0 = performance.now()
    pill.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    pill.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    pill.click()
    const found = await new Promise(resolve => {
      const deadline = performance.now() + 8000
      const check = () => {
        const menu = document.querySelector('[role="menu"]')
        if (menu && menu.childElementCount > 0) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))
          return
        }
        if (performance.now() > deadline) { resolve(-1); return }
        requestAnimationFrame(check)
      }
      check()
    })
    return found < 0 ? -1 : found - t0
  })()
`

await cdp.send('Profiler.start')
const openMs = await cdp.eval(OPEN)
const { profile } = await cdp.send('Profiler.stop')

console.log('openMs:', Math.round(openMs))
const out = writeModelPickerProfile(profile)
console.log('wrote', out)
console.log('top self-time (ms):')

for (const r of cpuProfileTopSelf(profile, 20)) {
  console.log(`  ${r.ms.toFixed(1).padStart(7)}  ${r.name.padEnd(44)}  ${r.url.split('/').slice(-2).join('/')}:${r.line}`)
}

// Close the menu again.
await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
cdp.close()

}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await profileModelPicker()
}
