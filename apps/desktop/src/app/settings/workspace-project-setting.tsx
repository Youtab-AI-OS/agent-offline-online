import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { desktopFsCacheKey, isDesktopFsRemoteMode } from '@/lib/desktop-fs'
import { FolderOpen } from '@/lib/icons'
import { $activeGatewayProfile } from '@/store/profile'
import { captureProjectCreationContext, createProject, enterProject } from '@/store/projects'
import { $connection } from '@/store/session'
import type { ProjectWorkingCopy } from '@/types/project-working-copy'

import { SectionHeading } from './primitives'
import { workspaceProjectCopy } from './workspace-project-copy'

/** The native picker owns source selection; the gateway remains project authority. */
export function WorkspaceProjectSetting({ heading = true }: { heading?: boolean }) {
  const { locale } = useI18n()
  const c = workspaceProjectCopy(locale)
  const connection = useStore($connection)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [copy, setCopy] = useState<ProjectWorkingCopy | null>(null)
  const [error, setError] = useState('')
  const remote = connection?.mode === 'remote'
  const available = Boolean(window.youtabDesktop?.settings?.prepareProjectWorkingCopy) && !remote

  const create = async () => {
    const prepare = window.youtabDesktop?.settings?.prepareProjectWorkingCopy

    if (!prepare || busy || isDesktopFsRemoteMode()) {
      return
    }

    const expectedContext = captureProjectCreationContext()
    const context = expectedContext.filesystemKey
    const profile = expectedContext.profile
    let prepared: ProjectWorkingCopy | null = null
    setBusy(true)
    setError('')
    setCopy(null)

    try {
      prepared = await prepare({ name: name.trim(), profile })

      if (!prepared) {
        return
      }

      if (
        desktopFsCacheKey() !== context ||
        ($activeGatewayProfile.get() || 'default') !== profile ||
        isDesktopFsRemoteMode()
      ) {
        throw new Error(c.contextChanged)
      }

      const project = await createProject(
        {
          name: name.trim(),
          workingCopy: { sourcePath: prepared.sourcePath, workingPath: prepared.workingPath },
          folders: [prepared.workingPath],
          primaryPath: prepared.workingPath,
          use: true
        },
        expectedContext
      )

      if (!project) {
        throw new Error(c.projectNotCreated)
      }

      if (desktopFsCacheKey() !== context || ($activeGatewayProfile.get() || 'default') !== profile) {
        throw new Error(c.contextChanged)
      }

      enterProject(project.id)
      setCopy(prepared)
    } catch (failure) {
      setError(
        `${c.failed}${prepared ? ` ${c.copyKept}: ${prepared.workingPath}.` : ''} ${failure instanceof Error ? failure.message : String(failure)}`
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-6 grid gap-3">
      {heading && <SectionHeading icon={FolderOpen} title={c.title} />}
      <p className="text-sm text-(--ui-text-secondary)">{c.description}</p>
      <label className="grid gap-2 text-sm">
        <span>{c.name}</span>
        <Input
          disabled={!available || busy}
          maxLength={80}
          onChange={event => setName(event.target.value)}
          value={name}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!available || busy || !name.trim()} onClick={() => void create()} size="sm" type="button">
          <FolderOpen />
          {c.choose}
        </Button>
        {busy && (
          <span aria-live="polite" className="flex items-center gap-2 text-sm">
            <Loader label={c.preparing} />
            {c.preparing}
          </span>
        )}
      </div>
      {!available && <p className="text-sm text-(--ui-text-secondary)">{remote ? c.localOnly : c.nativeRequired}</p>}
      <p className="text-xs text-(--ui-text-tertiary)">{c.exclusions}</p>
      <p className="text-xs text-(--ui-text-tertiary)">{c.boundary}</p>
      {error && (
        <p className="break-words text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {copy && (
        <div aria-live="polite" className="grid gap-1 text-sm">
          <span>{c.ready}</span>
          <span className="break-all" dir="ltr">
            {copy.workingPath}
          </span>
          <span className="text-(--ui-text-secondary)">
            {c.files}: {copy.copiedFiles}
          </span>
        </div>
      )}
    </div>
  )
}
