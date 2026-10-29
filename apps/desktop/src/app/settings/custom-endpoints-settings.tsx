import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { controlVariants } from '@/components/ui/control'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Check, Globe, Loader2, Plus, Save, Trash2, Zap } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import type { CustomEndpoint, CustomEndpointUpdate } from '@/types/youtab'
import {
  activateCustomEndpoint,
  deleteCustomEndpoint,
  getCustomEndpoints,
  saveCustomEndpoint,
  validateCustomEndpoint
} from '@/youtab'

import { endpointCopy } from './endpoint-copy'
import { EmptyState, Pill, SectionHeading, SettingsContent, SettingsSkeleton } from './primitives'

interface CustomEndpointsSettingsProps {
  onConfigSaved?: () => void
  onMainModelChanged?: (provider: string, model: string) => void
}

interface EndpointForm {
  apiKey: string
  baseUrl: string
  contextLength: string
  discoverModels: boolean
  id: string
  makeDefault: boolean
  model: string
  name: string
}

const EMPTY_FORM: EndpointForm = {
  apiKey: '',
  baseUrl: '',
  contextLength: '',
  discoverModels: true,
  id: '',
  makeDefault: true,
  model: '',
  name: ''
}

function formFromEndpoint(endpoint: CustomEndpoint): EndpointForm {
  return {
    apiKey: '',
    baseUrl: endpoint.base_url,
    contextLength: endpoint.context_length ? String(endpoint.context_length) : '',
    discoverModels: endpoint.discover_models,
    id: endpoint.id,
    makeDefault: Boolean(endpoint.is_current),
    model: endpoint.model,
    name: endpoint.name
  }
}

function toPayload(form: EndpointForm, models?: string[], withoutKey = false): CustomEndpointUpdate {
  const contextLength = Number.parseInt(form.contextLength, 10)

  return {
    id: form.id.trim() || undefined,
    name: form.name.trim() || form.model.trim(),
    base_url: form.baseUrl.trim(),
    model: form.model.trim(),
    api_key: withoutKey ? '' : form.apiKey.trim() || undefined,
    context_length: Number.isFinite(contextLength) && contextLength > 0 ? contextLength : undefined,
    discover_models: form.discoverModels,
    make_default: form.makeDefault,
    models: models?.length ? models : undefined
  }
}

function newEndpointId(form: EndpointForm, endpoints: CustomEndpoint[]): string {
  // Names/models are not unique across servers. A quick connection must not
  // silently replace another endpoint that happens to serve the same model.
  let host = ''

  try {
    const url = new URL(form.baseUrl)
    host = `${url.hostname}-${url.port || url.protocol.replace(':', '')}`
  } catch {
    // The server still owns URL validation and returns its normal error.
  }

  const stem = `${host}-${form.name || form.model}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'local'
  const occupied = new Set(endpoints.map(endpoint => endpoint.id))
  let candidate = stem
  let suffix = 2

  while (occupied.has(candidate)) {
    candidate = `${stem}-${suffix++}`
  }

  return candidate
}

export function CustomEndpointsSettings({ onConfigSaved, onMainModelChanged }: CustomEndpointsSettingsProps) {
  const { locale } = useI18n()
  const c = endpointCopy(locale)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [activating, setActivating] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [endpoints, setEndpoints] = useState<CustomEndpoint[]>([])
  const [form, setForm] = useState<EndpointForm>(EMPTY_FORM)
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])
  const [manualModel, setManualModel] = useState(false)
  const [withoutKey, setWithoutKey] = useState(false)
  const probeGeneration = useRef(0)
  const lifetime = useRef({ mounted: false }).current
  const { current: loadFailedCopy } = useRef(c.loadFailed)

  function invalidateProbe() {
    probeGeneration.current++
    setTesting(false)
    setDiscoveredModels([])
  }

  async function refresh() {
    const data = await getCustomEndpoints()
    setEndpoints(data.endpoints)
  }

  useEffect(() => {
    let cancelled = false
    lifetime.mounted = true

    async function load() {
      try {
        const data = await getCustomEndpoints()

        if (cancelled) {
          return
        }

        setEndpoints(data.endpoints)
        const current = data.endpoints.find(endpoint => endpoint.is_current) ?? data.endpoints[0]

        if (current) {
          setForm(formFromEndpoint(current))
          setDiscoveredModels(current.models)
          setManualModel(!current.discover_models || !current.models.includes(current.model))
        }
      } catch (err) {
        if (!cancelled) {notifyError(err, loadFailedCopy)}
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
      lifetime.mounted = false
    }
  }, [lifetime, loadFailedCopy])

  async function handleSave() {
    try {
      setSaving(true)
      const payload = toPayload(form, discoveredModels, withoutKey)

      if (!payload.id) {
        payload.id = newEndpointId(form, endpoints)
      }

      const response = await saveCustomEndpoint(payload)
      setEndpoints(response.endpoints)
      const saved = response.endpoints.find(endpoint => endpoint.id === response.id)

      if (saved) {
        setForm(formFromEndpoint(saved))
        setWithoutKey(false)
        setDiscoveredModels(saved.models)
      }

      if (saved && saved.is_current) {
        onMainModelChanged?.(saved.id, saved.model)
      }

      triggerHaptic('success')
      onConfigSaved?.()
      notify({ kind: 'success', message: c.saved })
    } catch (err) {
      notifyError(err, c.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  async function handleValidate() {
    const request = ++probeGeneration.current

    try {
      setTesting(true)
      const response = await validateCustomEndpoint(toPayload(form, undefined, withoutKey))

      if (!lifetime.mounted || request !== probeGeneration.current) {return}

      setDiscoveredModels(response.ok ? response.models : [])

      if (response.ok && response.models.length > 0) {
        setForm(current => {
          if (current.baseUrl !== form.baseUrl || current.apiKey !== form.apiKey) {return current}

          return {
            ...current,
            baseUrl: response.base_url || current.baseUrl,
            model:
              manualModel && current.model
                ? current.model
                : response.models.includes(current.model)
                  ? current.model
                  : response.models[0] || ''
          }
        })

        notify({
          kind: 'success',
          message: c.found
        })
      } else {
        notify({
          kind: response.reachable ? 'warning' : 'error',
          message: response.message || c.noModels
        })
      }
    } catch (err) {
      if (lifetime.mounted && request === probeGeneration.current) {notifyError(err, c.validationFailed)}
    } finally {
      if (lifetime.mounted && request === probeGeneration.current) {setTesting(false)}
    }
  }

  async function handleActivate(endpoint: CustomEndpoint) {
    try {
      setActivating(endpoint.id)
      const response = await activateCustomEndpoint(endpoint.id)
      await refresh()
      onConfigSaved?.()
      onMainModelChanged?.(response.provider, response.model)
      triggerHaptic('success')
    } catch (err) {
      notifyError(err, c.activationFailed)
    } finally {
      setActivating(null)
    }
  }

  async function handleDelete(endpoint: CustomEndpoint) {
    if (!window.confirm(`${c.deleteQuestion} ${endpoint.name}`)) {
      return
    }

    try {
      setDeleting(endpoint.id)
      const response = await deleteCustomEndpoint(endpoint.id)
      setEndpoints(response.endpoints)

      if (form.id === endpoint.id) {
        setForm(EMPTY_FORM)
        setWithoutKey(false)
        setDiscoveredModels([])
      }

      onConfigSaved?.()
      triggerHaptic('success')
    } catch (err) {
      notifyError(err, c.deleteFailed)
    } finally {
      setDeleting(null)
    }
  }

  if (loading) {
    return <SettingsSkeleton sections={[{ heading: true, rows: 3 }]} />
  }

  const canSave = Boolean(
    form.baseUrl.trim() && form.model.trim() && (manualModel || discoveredModels.includes(form.model))
  )

  const savedEndpoint = endpoints.find(endpoint => endpoint.id === form.id)

  const savedAddressChanged = Boolean(
    savedEndpoint?.has_api_key && savedEndpoint.base_url.replace(/\/+$/, '') !== form.baseUrl.trim().replace(/\/+$/, '')
  )

  return (
    <SettingsContent>
      <div className="space-y-6">
        <section>
          <SectionHeading icon={Globe} meta={`${endpoints.length}`} title={c.title} />
          <div className="divide-y divide-border/40 rounded-md border border-border/50">
            {endpoints.length ? (
              endpoints.map(endpoint => (
                <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={endpoint.id}>
                  <button
                    className="min-w-0 text-left"
                    onClick={() => {
                      invalidateProbe()
                      setForm(formFromEndpoint(endpoint))
                      setWithoutKey(false)
                      setDiscoveredModels(endpoint.models)
                      setManualModel(!endpoint.discover_models || !endpoint.models.includes(endpoint.model))
                    }}
                    type="button"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{endpoint.name}</span>
                      {endpoint.is_current && (
                        <Pill tone="primary">
                          <Check className="size-3" />
                          {c.active}
                        </Pill>
                      )}
                      {endpoint.source === 'direct-config' && <Pill>config.yaml</Pill>}
                    </div>
                    <div className="mt-1 truncate font-mono text-[0.7rem] text-muted-foreground">
                      {endpoint.base_url}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{endpoint.model}</span>
                      {endpoint.has_api_key && <span>{endpoint.api_key_preview ?? 'API key set'}</span>}
                    </div>
                  </button>
                  <div className="flex items-center gap-2 sm:justify-end">
                    <Button
                      disabled={endpoint.is_current || activating === endpoint.id}
                      onClick={() => void handleActivate(endpoint)}
                      size="sm"
                      variant="outline"
                    >
                      {activating === endpoint.id ? <Loader2 className="animate-spin" /> : <Zap />}
                      {c.use}
                    </Button>
                    {endpoint.source !== 'direct-config' && (
                      <Button
                        aria-label={c.remove}
                        className="hover:text-destructive"
                        disabled={deleting === endpoint.id}
                        onClick={() => void handleDelete(endpoint)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        {deleting === endpoint.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      </Button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState description={c.emptyHelp} title={c.empty} />
            )}
          </div>
        </section>

        <section>
          <SectionHeading icon={Plus} title={form.id ? c.edit : c.add} />
          <div className="grid gap-3 rounded-md border border-border/50 p-3">
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              {c.address}
              <Input
                aria-describedby="custom-endpoint-address-help"
                autoComplete="url"
                dir="ltr"
                onChange={event => {
                  invalidateProbe()
                  setWithoutKey(false)
                  setForm(current => ({ ...current, baseUrl: event.target.value, model: '' }))
                }}
                placeholder={c.placeholder}
                value={form.baseUrl}
              />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground" id="custom-endpoint-address-help">
              {c.help}
            </p>
            {savedAddressChanged && (
              <p className="text-xs text-(--ui-text-secondary)" role="status">
                {c.addressChanged}
              </p>
            )}
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              {c.key}
              <Input
                autoComplete="off"
                disabled={withoutKey}
                onChange={event => {
                  invalidateProbe()
                  setWithoutKey(false)
                  setForm(current => ({ ...current, apiKey: event.target.value }))
                }}
                placeholder={savedEndpoint?.has_api_key && !savedAddressChanged ? c.retained : c.optional}
                type="password"
                value={form.apiKey}
              />
            </label>
            {savedEndpoint?.has_api_key && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={withoutKey} onCheckedChange={checked => {
                  invalidateProbe()
                  setWithoutKey(checked === true)

                  if (checked === true) {setForm(current => ({ ...current, apiKey: '' }))}
                }} />
                {c.withoutKey}
              </label>
            )}
            <Button disabled={testing || !form.baseUrl.trim()} onClick={() => void handleValidate()} variant="outline">
              {testing ? <Loader2 className="animate-spin" /> : <Zap />}
              {c.discover}
            </Button>
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              {c.model}
              {manualModel ? (
                <Input
                  aria-label={c.model}
                  dir="ltr"
                  onChange={event => setForm(current => ({ ...current, model: event.target.value }))}
                  value={form.model}
                />
              ) : (
                <select
                  aria-label={c.model}
                  className={controlVariants()}
                  data-slot="select-trigger"
                  dir="ltr"
                  onChange={event => setForm(current => ({ ...current, model: event.target.value }))}
                  value={form.model}
                >
                  <option value="">{c.select}</option>
                  {discoveredModels.map(model => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={manualModel}
                onCheckedChange={checked => {
                  probeGeneration.current++
                  setTesting(false)
                  setManualModel(checked === true)

                  if (checked !== true && !discoveredModels.includes(form.model))
                    {setForm(current => ({ ...current, model: '' }))}
                }}
              />
              {c.manual}
            </label>
            {manualModel && <p className="text-xs text-muted-foreground">{c.manualHelp}</p>}
            <details className="runtime-endpoint-advanced">
              <summary>{c.advanced}</summary>
              <div className="grid gap-3 pt-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs text-muted-foreground">
                  {c.name}
                  <Input
                    onChange={event => setForm(current => ({ ...current, name: event.target.value }))}
                    value={form.name}
                  />
                </label>
                <label className="grid gap-1.5 text-xs text-muted-foreground">
                  {c.id}
                  <Input
                    dir="ltr"
                    onChange={event => {
                      invalidateProbe()
                      setWithoutKey(false)
                      setForm(current => ({ ...current, id: event.target.value }))
                    }}
                    value={form.id}
                  />
                </label>
                <label className="grid gap-1.5 text-xs text-muted-foreground">
                  {c.context}
                  <Input
                    inputMode="numeric"
                    onChange={event => setForm(current => ({ ...current, contextLength: event.target.value }))}
                    placeholder={c.auto}
                    value={form.contextLength}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground sm:col-span-2">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={form.makeDefault}
                      onCheckedChange={checked => setForm(current => ({ ...current, makeDefault: checked === true }))}
                    />
                    {c.newChats}
                  </label>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={form.discoverModels}
                      onCheckedChange={checked =>
                        setForm(current => ({ ...current, discoverModels: checked === true }))
                      }
                    />
                    {c.autoDiscovery}
                  </label>
                </div>
              </div>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button disabled={saving || testing || !canSave} onClick={() => void handleSave()}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />}
                {c.save}
              </Button>
              <Button
                className={cn(!form.id && 'hidden')}
                onClick={() => {
                  invalidateProbe()
                  setForm(EMPTY_FORM)
                  setWithoutKey(false)
                  setDiscoveredModels([])
                  setManualModel(false)
                }}
                type="button"
                variant="ghost"
              >
                {c.add}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </SettingsContent>
  )
}
