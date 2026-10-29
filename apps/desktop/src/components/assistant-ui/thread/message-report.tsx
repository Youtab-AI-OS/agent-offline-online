import { IconFlag } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'

export function MessageReportButton({
  messageId,
  getMessageText
}: {
  messageId: string
  getMessageText: () => string
}) {
  const { t } = useI18n()
  const copy = t.messageActions
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [excerpt, setExcerpt] = useState('')
  const [includeExcerpt, setIncludeExcerpt] = useState(false)
  const [destination, setDestination] = useState<{ scope: string; organization: boolean; available: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [receipt, setReceipt] = useState('')
  const inFlight = useRef(false)
  useEffect(() => {
    if (!open) {return}
    let live = true
    setDestination(null)
    void window.youtabDesktop?.messageReports
      ?.status()
      .then(state => {
        if (live) {setDestination(state)}
      })
      .catch(() => {
        if (live) {setError(true)}
      })
    return () => {
      live = false
    }
  }, [open])
  const submit = async () => {
    if (inFlight.current || !reason.trim() || !destination?.available) {return}
    inFlight.current = true
    setBusy(true)
    setError(false)
    try {
      const bridge = window.youtabDesktop?.messageReports
      if (!bridge) {throw new Error('REPORT_UNAVAILABLE')}
      const result = await bridge.submit({ messageId, reason, ...(includeExcerpt ? { excerpt } : {}) }, destination.scope)
      setReceipt(result.reportId)
    } catch {
      setError(true)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <TooltipIconButton
        onClick={() => {
          setReason('')
          setReceipt('')
          setError(false)
          setIncludeExcerpt(false)
          setExcerpt(getMessageText().slice(0, 8000))
          setOpen(true)
        }}
        tooltip={copy.report}
      >
        <IconFlag className="size-3.5" />
      </TooltipIconButton>
      <Dialog
        onOpenChange={value => {
          if (!inFlight.current) {setOpen(value)}
        }}
        open={open}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle icon={IconFlag}>{copy.reportTitle}</DialogTitle>
            <DialogDescription>{copy.disclosure}</DialogDescription>
          </DialogHeader>
          {receipt ? (
            <p role="status">
              {copy.saved}: <span dir="ltr">{receipt}</span>
            </p>
          ) : (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">
                {destination?.organization ? copy.organizationDestination : copy.personalDestination}
              </p>
              {!destination?.available && (
                <p role="status">{destination?.organization ? copy.integrationPending : copy.signInRequired}</p>
              )}
              <label className="grid gap-2">
                <span>{copy.reason}</span>
                <Textarea
                  disabled={busy}
                  maxLength={4000}
                  onChange={event => setReason(event.target.value)}
                  value={reason}
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  checked={includeExcerpt}
                  disabled={busy}
                  onChange={event => setIncludeExcerpt(event.target.checked)}
                  type="checkbox"
                />
                {copy.includeExcerpt}
              </label>
              {includeExcerpt && (
                <label className="grid gap-2">
                  <span>{copy.excerptLimit}</span>
                  <Textarea
                    disabled={busy}
                    maxLength={8000}
                    onChange={event => setExcerpt(event.target.value)}
                    value={excerpt}
                  />
                </label>
              )}
              {error && <p role="alert">{copy.failed}</p>}
            </div>
          )}
          <DialogFooter>
            <Button disabled={busy} onClick={() => setOpen(false)} variant="ghost">
              {t.common.close}
            </Button>
            {!receipt && (
              <Button disabled={busy || !reason.trim() || !destination?.available} onClick={() => void submit()}>
                {copy.submit}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
