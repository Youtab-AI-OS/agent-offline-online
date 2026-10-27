import { IconCornerUpLeft } from '@tabler/icons-react'
import { type MouseEvent, useRef } from 'react'

import { requestComposerReply } from '@/app/chat/composer/focus'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { useI18n } from '@/i18n'
import { replyContext } from '@/lib/message-reply-context'

/** A selection only belongs to this message when BOTH endpoints are inside it. */
export function replyTextFromSelection(root: Element | null, selection: Selection | null, fallback: string): string {
  if (
    root &&
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    selection.focusNode &&
    root.contains(selection.anchorNode) &&
    root.contains(selection.focusNode)
  ) {
    const selected = selection.toString().trim()

    if (selected) {
      return selected
    }
  }

  return fallback.trim()
}

export function MessageReplyButton({ messageId, getMessageText }: { messageId: string; getMessageText: () => string }) {
  const { t } = useI18n()
  const captured = useRef<string | null>(null)

  const readText = (button: HTMLElement) =>
    replyTextFromSelection(
      button
        .closest('[data-slot="aui_assistant-message-root"]')
        ?.querySelector('[data-slot="aui_assistant-message-content"]') || null,
      window.getSelection(),
      getMessageText()
    )

  const reply = (event: MouseEvent<HTMLButtonElement>) => {
    const text = captured.current ?? readText(event.currentTarget)
    captured.current = null

    if (!text) {
      return
    }

    const surface = event.currentTarget.closest<HTMLElement>('[data-composer-target]')
    const target = surface?.dataset.composerTarget
    const sessionKey = surface?.dataset.composerSessionKey
    const context = replyContext({ messageId, quote: text })

    if (!target || !sessionKey || !context) {
      return
    }

    requestComposerReply({ reply: context, sessionKey, target })
  }

  return (
    <TooltipIconButton
      onClick={reply}
      onPointerDown={event => {
        captured.current = readText(event.currentTarget)
        event.preventDefault()
      }}
      tooltip={t.messageActions.reply}
    >
      <IconCornerUpLeft className="size-3.5" />
    </TooltipIconButton>
  )
}
