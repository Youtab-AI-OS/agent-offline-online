import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { YoutabExportMode, YoutabExportResult } from '@/global'
import { useI18n } from '@/i18n'
import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { downloadTextFile } from '@/lib/download-text'
import { Download, FolderOpen, Save } from '@/lib/icons'
import { notifyError } from '@/store/notifications'
import { $connection } from '@/store/session'

export type DownloadOutcome = YoutabExportResult | { status: 'started' }

/** Only native confirmed saves expose a local path and Explorer action. */
export function DownloadActions({
  identity,
  disabled = false,
  save
}: {
  identity: string
  disabled?: boolean
  save: (mode: YoutabExportMode) => Promise<DownloadOutcome>
}) {
  const { locale, t } = useI18n()
  useStore($connection)
  const connectionKey = desktopFsCacheKey()
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const version = useRef(0)
  const pending = useRef(false)
  const mounted = useRef(false)
  const fa = String(locale).startsWith('fa')

  const copy = {
    saveAs: fa ? 'ذخیره با نام…' : 'Save as…',
    saved: fa ? 'ذخیره شد در' : 'Saved to',
    reveal: fa ? 'نمایش در Explorer' : 'Open in Explorer',
    started: fa
      ? 'دانلود درخواست شد؛ مسیر را در پنجرهٔ ذخیره یا مرورگر بررسی کنید.'
      : 'Download requested; confirm its destination in the save dialog or browser.',
    failed: fa ? 'ذخیره فایل انجام نشد.' : 'Could not save the file.'
  }

  // eslint-disable-next-line no-restricted-syntax -- Mount ownership flag, not a mirrored atom value.
  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])
  // eslint-disable-next-line no-restricted-syntax -- Invalidate an operation epoch when the file/profile changes; callbacks read the live connection directly.
  useEffect(() => {
    version.current++
    pending.current = false
    setBusy(false)
    setSaved(null)
    setStarted(false)
    setError(null)
  }, [identity, connectionKey])

  const run = async (mode: YoutabExportMode) => {
    if (pending.current || disabled) {
      return
    }

    const request = version.current
    const key = desktopFsCacheKey()
    pending.current = true
    setBusy(true)
    setError(null)

    try {
      const result = await save(mode)

      if (!mounted.current || version.current !== request || desktopFsCacheKey() !== key) {
        return
      }

      if (result?.status === 'saved' && result.path) {
        setSaved(result.path)
        setStarted(false)
      } else if (result?.status === 'started') {
        setStarted(true)
      }
    } catch (cause) {
      if (mounted.current && version.current === request && desktopFsCacheKey() === key) {
        setError(cause instanceof Error ? cause.message : copy.failed)
        notifyError(cause, copy.failed)
      }
    } finally {
      if (mounted.current && version.current === request) {
        pending.current = false
        setBusy(false)
      }
    }
  }

  const reveal = async () => {
    if (!saved || !window.youtabDesktop?.revealExport) {
      return
    }

    const request = version.current
    const key = desktopFsCacheKey()

    try {
      if (!(await window.youtabDesktop.revealExport(saved))) {
        throw new Error(copy.failed)
      }
    } catch (cause) {
      if (mounted.current && version.current === request && desktopFsCacheKey() === key) {
        setError(cause instanceof Error ? cause.message : copy.failed)
        notifyError(cause, copy.failed)
      }
    }
  }

  return (
    <span className="inline-flex min-w-0 max-w-full flex-col items-end gap-1" data-slot="download-actions">
      <span className="inline-flex flex-wrap items-center justify-end gap-1">
        <Button
          aria-label={t.artifactPreview.download}
          disabled={disabled || busy}
          onClick={() => void run('download')}
          size="icon-xs"
          title={t.artifactPreview.download}
          variant="ghost"
        >
          <Download aria-hidden="true" className="size-3" />
        </Button>
        <Button
          aria-label={copy.saveAs}
          disabled={disabled || busy || (!window.youtabDesktop?.exportContent && !window.youtabDesktop?.exportFile)}
          onClick={() => void run('save-as')}
          size="icon-xs"
          title={copy.saveAs}
          variant="ghost"
        >
          <Save aria-hidden="true" className="size-3" />
        </Button>
        {saved && (
          <Button
            disabled={!window.youtabDesktop?.revealExport}
            onClick={() => void reveal()}
            size="xs"
            variant="ghost"
          >
            <FolderOpen className="size-3" />
            {copy.reveal}
          </Button>
        )}
      </span>
      {saved && (
        <span className="max-w-full break-all text-[0.65rem] text-muted-foreground" role="status">
          {copy.saved}: <bdi title={saved}>{saved}</bdi>
        </span>
      )}
      {started && (
        <span className="text-[0.65rem] text-muted-foreground" role="status">
          {copy.started}
        </span>
      )}
      {error && (
        <span className="max-w-full break-words text-[0.65rem] text-destructive" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

export function TextDownload({
  name,
  content,
  mimeType = 'text/plain',
  disabled = false
}: {
  name: string
  content: string
  mimeType?: string
  disabled?: boolean
}) {
  return (
    <DownloadActions
      disabled={disabled}
      identity={`${name}\0${content}`}
      save={mode => downloadTextFile(name, content, mimeType, mode)}
    />
  )
}

export function MessageDownload({ messageId, getMessageText }: { messageId: string; getMessageText: () => string }) {
  const name = `youtab-response-${messageId.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`

  return (
    <DownloadActions
      identity={messageId}
      save={mode => downloadTextFile(name, getMessageText(), 'text/markdown', mode)}
    />
  )
}
