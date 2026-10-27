import { useEffect } from 'react'

import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { replyContext } from '@/lib/message-reply-context'

import { onComposerReplyRequest } from '../focus'
import { useComposerScope } from '../scope'

/** Context is an attachment, never editable text. The existing scoped
 * draft, retry and queue paths carry/remove it together with the user's words. */
export function useComposerReply(sessionKey: string | null, focusInput: () => void) {
  const scope = useComposerScope()
  const visible = usePaneVisible()
  useEffect(
    () =>
      onComposerReplyRequest(detail => {
        if (!visible || !sessionKey || detail.contextKey !== desktopFsCacheKey() || detail.target !== scope.target || detail.sessionKey !== sessionKey) {
          return
        }

        const reply = replyContext(detail.reply)

        // The event can arrive after a tab/profile switch. Only this transcript
        // can supply the referenced assistant message; never borrow foreground data.
        if (!reply || !scope.$messages.get().some(m => m.id === reply.messageId && m.role === 'assistant')) {
          return
        }

        scope.attachments.add({ id: 'message-reply', kind: 'reply', label: reply.quote, replyTo: reply })
        focusInput()
      }),
    [focusInput, scope, sessionKey, visible]
  )
}
