import { IconBuildingCommunity } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { SettingsContent } from './primitives'

export function OrganizationAdminSettings() {
  const { t } = useI18n()
  const copy = t.messageActions
  const [url, setUrl] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let live = true
    void window.youtabDesktop?.organizationAdmin
      ?.get()
      .then(state => {
        if (live) {
          setUrl(state.url)
          setSaved(state.url)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (live) setError(true)
      })
    return () => {
      live = false
    }
  }, [])
  return (
    <SettingsContent>
      <h1 className="runtime-section-heading">
        <IconBuildingCommunity />
        <span>{copy.organizationAdmin}</span>
      </h1>
      <p className="runtime-added-description">{copy.organizationDescription}</p>
      <div className="grid gap-4">
        <label className="grid gap-2">
          <span>{copy.serverUrl}</span>
          <Input
            dir="ltr"
            type="url"
            value={url}
            autoComplete="off"
            disabled={!loaded || busy}
            onChange={event => setUrl(event.target.value)}
          />
        </label>
        <p className="text-sm text-muted-foreground">{copy.linkOnly}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!loaded || busy}
            onClick={async () => {
              setBusy(true)
              setError(false)
              try {
                const result = await window.youtabDesktop!.organizationAdmin!.save(url.trim())
                setUrl(result.url)
                setSaved(result.url)
              } catch {
                setError(true)
              } finally {
                setBusy(false)
              }
            }}
          >
            {t.common.save}
          </Button>
          <Button
            variant="outline"
            disabled={!saved || busy || url.trim() !== saved}
            onClick={async () => {
              setBusy(true)
              setError(false)
              try {
                await window.youtabDesktop!.organizationAdmin!.open()
              } catch {
                setError(true)
              } finally {
                setBusy(false)
              }
            }}
          >
            {copy.openAdmin}
          </Button>
        </div>
        <p role="status">{copy.integrationPending}</p>
        {error && <p role="alert">{copy.organizationFailed}</p>}
      </div>
    </SettingsContent>
  )
}
