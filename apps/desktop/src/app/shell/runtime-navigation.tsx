import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'

export function RuntimeNavigation() {
  const { t } = useI18n()
  const [notice, setNotice] = useState<'chat' | 'work' | null>(null)

  return (
    <>
      <span className="runtime-wordmark" dir="ltr">
        {t.visual.runtimeTitle}
      </span>
      <nav aria-label={t.visual.applications} className="runtime-navigation">
        <Button aria-pressed={notice === null} onClick={() => setNotice(null)} size="xs" variant="ghost">
          {t.visual.runtimeTab}
        </Button>
        <Button
          aria-haspopup="dialog"
          aria-pressed={notice === 'work'}
          onClick={() => setNotice('work')}
          size="xs"
          variant="ghost"
        >
          {t.visual.workTab}
        </Button>
        <Button
          aria-haspopup="dialog"
          aria-pressed={notice === 'chat'}
          onClick={() => setNotice('chat')}
          size="xs"
          variant="ghost"
        >
          {t.visual.chatTab}
        </Button>
      </nav>
      <Dialog
        onOpenChange={open => {
          if (!open) setNotice(null)
        }}
        open={notice !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{notice === 'chat' ? t.visual.chatTab : t.visual.workTab}</DialogTitle>
            <DialogDescription>{t.visual.comingSoon}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  )
}
