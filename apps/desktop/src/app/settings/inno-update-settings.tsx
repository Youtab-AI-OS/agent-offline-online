import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { Download } from '@/lib/icons'
import {
  $offlineUpdateImporting,
  $updateApply,
  $updatePolicy,
  $updatePolicyError,
  $updatePolicySaving,
  importOfflineUpdate,
  refreshUpdatePolicy,
  saveUpdatePolicy
} from '@/store/updates'

import { ListRow, ToggleRow } from './primitives'
import { updatePolicyCopy } from './update-policy-copy'

export function InnoUpdateSettings() {
  const { locale } = useI18n()
  const copy = updatePolicyCopy(locale)
  const policy = useStore($updatePolicy)
  const error = useStore($updatePolicyError)
  const saving = useStore($updatePolicySaving)
  const importing = useStore($offlineUpdateImporting)
  const apply = useStore($updateApply)
  const [importError, setImportError] = useState(false)

  useEffect(() => {
    void refreshUpdatePolicy().catch(() => undefined)
  }, [])

  if (policy?.supported === false) {return null}

  if (!policy && !error) {return <Loader label={copy.loading} />}
  const pending = saving || importing || apply.applying || apply.stage === 'restart'

  return (
    <section aria-label={copy.title} dir={locale === 'fa' ? 'rtl' : undefined}>
      {policy?.supported ? (
        <>
          <ToggleRow
            checked={policy.enabled}
            description={copy.description}
            disabled={pending}
            label={copy.enable}
            onChange={(enabled) => {
              void saveUpdatePolicy({ enabled, automaticChecks: policy.automaticChecks }).catch(() => undefined)
            }}
          />
          <ToggleRow
            checked={policy.automaticChecks}
            description={copy.automaticDescription}
            disabled={pending || !policy.enabled}
            label={copy.automatic}
            onChange={(automaticChecks) => {
              void saveUpdatePolicy({ enabled: policy.enabled, automaticChecks }).catch(() => undefined)
            }}
          />
          {!policy.enabled ? <p className="text-sm text-muted-foreground">{copy.disabled}</p> : null}
          <ListRow
            action={
              <Button
                disabled={pending || !policy.enabled}
                onClick={() => {
                  setImportError(false)
                  void importOfflineUpdate().catch(() => setImportError(true))
                }}
                size="sm"
                variant="outline"
              >
                {importing ? <Loader label={copy.importing} /> : <Download aria-hidden="true" />}
                {copy.offline}
              </Button>
            }
            description={copy.offlineDescription}
            title={copy.offline}
          />
        </>
      ) : null}
      {error ? (
        <div role="alert">
          <p>{copy.error}</p>
          <Button
            disabled={pending}
            onClick={() => {
              void refreshUpdatePolicy().catch(() => undefined)
            }}
            size="sm"
            variant="text"
          >
            {copy.retry}
          </Button>
        </div>
      ) : null}
      {importError ? <p role="alert">{copy.importError}</p> : null}
    </section>
  )
}
