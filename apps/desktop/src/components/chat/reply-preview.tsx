import { IconCornerUpLeft, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type { MessageReplyContext } from '@/lib/message-reply-context'

export function ReplyPreview({ reply, onRemove }: { reply: MessageReplyContext; onRemove?: () => void }) {
  const { t } = useI18n()

  return (
    <div
      className="flex w-full min-w-0 items-start gap-2 rounded-xl border border-border/60 border-s-2 border-s-primary/65 bg-accent/35 px-3 py-2 text-start"
      data-slot="reply-preview"
    >
      <IconCornerUpLeft aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-primary">{t.messageActions.reply}</span>
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground" dir="auto">
          {reply.quote}
        </p>
      </div>
      {onRemove && (
        <Button
          aria-label={t.composer.removeAttachment(t.messageActions.reply)}
          onClick={onRemove}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <IconX aria-hidden className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
