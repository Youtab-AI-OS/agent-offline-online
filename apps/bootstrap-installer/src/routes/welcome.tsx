import { useStore } from '@nanostores/react'
import { open } from '@tauri-apps/plugin-dialog'
import { type CSSProperties, useState } from 'react'

import { HackeryButton } from '../components/hackery-button'
import { $installationKind, $releaseChannel, $youtabHome, changeInstallLocation, openLogDir, startInstall, startUpdate } from '../store'

/* Common Setup welcome screen. A selected alternate location is handled by
 * the journaled native relocation flow, including on machines with old data. */
export default function Welcome() {
  const kind = useStore($installationKind)
  const channel = useStore($releaseChannel)
  const home = useStore($youtabHome)
  const [locationBusy, setLocationBusy] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const showLocation = /Windows/i.test(navigator.userAgent)

  async function chooseLocation() {
    if (locationBusy) {return}
    setLocationError(null)

    try {
      const selected = await open({ directory: true, multiple: false, title: 'Choose a private folder for Youtab' })

      if (typeof selected !== 'string') {return}
      setLocationBusy(true)
      const result = await changeInstallLocation(selected)

      if (result === 'unchanged') {setLocationBusy(false)}
      // On success the verified new Setup window opens and this one exits.
    } catch (error) {
      setLocationBusy(false)
      setLocationError(typeof error === 'string' ? error : 'The selected location could not be opened. Your current installation is unchanged.')
    }
  }

  return (
    <div className="youtab-fade-in flex h-full flex-col items-center justify-center gap-10 px-12 py-10">
      {/* Hero — same recipe the desktop's chat/intro.tsx uses */}
      <div className="w-full max-w-2xl min-w-0 text-center">
        <p
          className="fit-text youtab-display-title mx-auto mb-4 w-full uppercase leading-[0.9] tracking-[0.08em] text-midground mix-blend-plus-lighter dark:text-foreground/90"
          style={
            {
              '--fit-text-line-height': '0.9',
              '--fit-text-max': '6rem',
              '--fit-text-min': '2.5rem'
            } as CSSProperties
          }
        >
          <span>
            <span>YOUTAB AGENT</span>
          </span>
          <span aria-hidden="true">YOUTAB AGENT</span>
        </p>

        <p className="m-0 text-center text-base leading-normal tracking-tight text-muted-foreground">
          {kind === 'relocation' ? 'Continue installation at the selected location. Your previous chats, settings and credentials are preserved.'
            : kind === 'legacy' ? 'Upgrade your existing Youtab installation to the common updater. Your chats, settings and credentials are preserved.'
            : kind === 'unknown' ? 'Checking your installation. If this does not finish, open the logs before continuing.'
            : 'The agent that grows with you. Setup takes a few minutes.'}
        </p>
      </div>

      {kind !== 'unknown' && showLocation && <div className="flex w-full max-w-xl flex-col items-center gap-2 text-center text-sm">
        <div className="text-muted-foreground">Install location</div>
        <div className="max-w-full break-all text-foreground" title={home ?? undefined}>{home ?? 'Checking location...'}</div>
        {kind !== 'relocation' && <button className="rounded-md border border-foreground/40 px-4 py-2 text-foreground hover:bg-foreground/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50" disabled={locationBusy} onClick={() => void chooseLocation()} type="button">
          {locationBusy ? 'Opening selected location...' : 'Choose location'}
        </button>}
        {locationError && <p className="m-0 text-destructive" role="alert">{locationError}</p>}
        {kind !== 'relocation' && <p className="m-0 text-xs text-muted-foreground">Choose the parent folder. Setup creates a Youtab folder there and preserves existing chats, skills and settings.</p>}
      </div>}
      {kind !== 'unknown' && <label className="flex items-center gap-3 text-sm">Update channel
        <select aria-label="Update channel" className="youtab-channel-select" disabled={locationBusy || kind === 'relocation'} onChange={event => $releaseChannel.set(event.target.value === 'pilot' ? 'pilot' : 'stable')} value={channel}>
          <option value="stable">Stable</option><option value="pilot">Pilot / Test</option>
        </select>
      </label>}
      {kind !== 'unknown' && <HackeryButton disabled={locationBusy} label={kind === 'relocation' ? 'Continue install' : kind === 'fresh' ? 'Install' : 'Upgrade'} onClick={() => {
        if (kind === 'artifact') {void startUpdate()} else {void startInstall({ migrateLegacy: kind === 'legacy' })}
      }} />}
      {kind === 'unknown' && <HackeryButton label="Open logs" onClick={() => void openLogDir()} />}
    </div>
  )
}
