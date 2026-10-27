#!/usr/bin/env node
import { logLine } from './log-framing.mjs'
const diagnosticLog = (...args) => console.log(logLine(...args).replace(/[\r\n]/g, ''))
const diagnosticError = (...args) => console.error(logLine(...args).replace(/[\r\n]/g, ''))
// CDP probe: measure render churn on overlay surfaces (cmdk, settings, command-center, skills)
// against the user's live instance on :9222. Read-only — never closes or navigates away.
import WebSocket from 'ws'

let msgId = 1

function send(ws, method, params = {}) {
  const id = msgId++
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) {
        ws.off('message', handler)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function getRendererTarget() {
  const resp = await fetch('http://127.0.0.1:9222/json/list')
  const targets = await resp.json()
  // Find the renderer target (not devtools)
  return targets.find(t => t.url?.startsWith('http://127.0.0.1:5174') || t.url?.includes('5174'))
    ?? targets.find(t => t.type === 'page' && !t.url.startsWith('devtools'))
}

async function evalInPage(ws, expr) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  return result?.result?.value
}

async function main() {
  const target = await getRendererTarget()
  if (!target) {
    diagnosticError('No renderer target found')
    process.exit(1)
  }
  diagnosticLog(`Target: ${target.url}`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })

  await send(ws, 'Runtime.enable')

  // Check if __RENDER_COUNTS__ is available
  const hasCounter = await evalInPage(ws, 'typeof __RENDER_COUNTS__')
  diagnosticLog(`__RENDER_COUNTS__ available: ${hasCounter}`)

  if (hasCounter !== 'object') {
    diagnosticLog('Render counter not loaded — checking perf-live...')
    const hasPerfLive = await evalInPage(ws, 'typeof __PERF_LIVE__')
    diagnosticLog(`__PERF_LIVE__ available: ${hasPerfLive}`)
  }

  // 1. Baseline: open cmdk, type a few chars, measure
  diagnosticLog('\n=== CmdK Palette ===')
  await evalInPage(ws, `
    window.__renderBaseline = {}
    if (typeof __RENDER_COUNTS__ === 'object' && __RENDER_COUNTS__) {
      __RENDER_COUNTS__.reset()
    }
    // Open cmdk via keyboard shortcut
    const evt = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
    document.dispatchEvent(evt)
    true
  `)
  await new Promise(r => setTimeout(r, 500))

  // Type some characters
  for (const ch of ['s', 'e', 't', 't', 'i', 'n', 'g']) {
    await evalInPage(ws, `
      const el = document.querySelector('[cmdk-input]') || document.querySelector('input[placeholder]')
      if (el) {
        el.focus()
        el.value = el.value + '${ch}'
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      true
    `)
    await new Promise(r => setTimeout(r, 80))
  }

  await new Promise(r => setTimeout(r, 300))
  const cmdkCounts = await evalInPage(ws, `
    __RENDER_COUNTS__?.snapshot?.() ?? __RENDER_COUNTS__?.counts ?? 'no counter'
  `)
  diagnosticLog('CmdK render counts after typing "setting":', JSON.stringify(cmdkCounts, null, 2))

  // Close cmdk
  await evalInPage(ws, `new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
  await new Promise(r => setTimeout(r, 300))

  // 2. Command Center — measure renders while on System tab
  diagnosticLog('\n=== Command Center (System tab) ===')
  await evalInPage(ws, `
    if (typeof __RENDER_COUNTS__ === 'object' && __RENDER_COUNTS__) {
      __RENDER_COUNTS__.reset()
    }
    // Navigate to command center system section
    const link = Array.from(document.querySelectorAll('a, button')).find(el => el.textContent?.includes('System') || el.textContent?.includes('Command Center'))
    if (link) link.click()
    true
  `)
  await new Promise(r => setTimeout(r, 1000))

  const ccCounts = await evalInPage(ws, `
    __RENDER_COUNTS__?.snapshot?.() ?? __RENDER_COUNTS__?.counts ?? 'no counter'
  `)
  diagnosticLog('Command Center render counts (after 1s on System tab):', JSON.stringify(ccCounts, null, 2))

  // 3. Settings page — measure renders on nav
  diagnosticLog('\n=== Settings Page ===')
  await evalInPage(ws, `
    if (typeof __RENDER_COUNTS__ === 'object' && __RENDER_COUNTS__) {
      __RENDER_COUNTS__.reset()
    }
    // Navigate to settings
    const link = Array.from(document.querySelectorAll('a, button')).find(el => el.textContent?.includes('Settings'))
    if (link) link.click()
    true
  `)
  await new Promise(r => setTimeout(r, 1000))

  // Click through a few nav items
  for (const label of ['Appearance', 'Gateway', 'Keys', 'About']) {
    await evalInPage(ws, `
      const el = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '${label}')
      if (el) el.click()
      true
    `)
    await new Promise(r => setTimeout(r, 150))
  }

  const settingsCounts = await evalInPage(ws, `
    __RENDER_COUNTS__?.snapshot?.() ?? __RENDER_COUNTS__?.counts ?? 'no counter'
  `)
  diagnosticLog('Settings render counts (after clicking 4 nav items):', JSON.stringify(settingsCounts, null, 2))

  ws.close()
  diagnosticLog('\nDone.')
}

main().catch(err => {
  diagnosticError('Error:', err)
  process.exit(1)
})
