// Screenshot the render.tsx output with the workspace's Electron (offscreen).
import { app, BrowserWindow } from 'electron'
import { join } from 'path'

import { checkedVisualProfile, createVisualProfile, visualOutDir, writeVisualOutput } from './paths.mjs'

const outDir = visualOutDir()
const ownedProfile = process.env.YOUTAB_AGENT_TUI_VISUAL_PROFILE ? undefined : createVisualProfile(outDir)
const profileDirectory = ownedProfile?.path ?? checkedVisualProfile(outDir, process.env.YOUTAB_AGENT_TUI_VISUAL_PROFILE)
app.setPath('userData', profileDirectory)
app.setPath('sessionData', profileDirectory)
app.on('quit', () => ownedProfile?.cleanup())
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    height: 2100,
    show: false,
    webPreferences: { offscreen: true },
    width: 1500
  })

  await win.loadFile(join(outDir, 'tui-visual.html'))
  await new Promise(r => setTimeout(r, 700))

  const image = await win.webContents.capturePage()
  const outFile = join(outDir, 'tui-visual.png')

  writeVisualOutput(outDir, 'tui-visual.png', image.toPNG())
  console.log(`wrote ${outFile}`)
  app.quit()
})
