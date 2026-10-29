import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageReplyButton, replyTextFromSelection } from './message-reply'
const bus = vi.hoisted(() => ({ reply: vi.fn() }))
vi.mock('@/app/chat/composer/focus', () => ({ requestComposerReply: bus.reply }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: { messageActions: { reply: 'Reply to this part' } } }) }))
vi.mock('@/components/assistant-ui/tooltip-icon-button', () => ({
  TooltipIconButton: ({ tooltip, children, ...props }: any) => (
    <button aria-label={tooltip} {...props}>
      {children}
    </button>
  )
}))

beforeEach(() => {
  vi.clearAllMocks()
  window.getSelection()?.removeAllRanges()
})
describe('reply to a response or selected passage', () => {
  it('only accepts a selection from within this response', () => {
    const inside = document.createElement('p')
    inside.textContent = 'selected passage'
    document.body.appendChild(inside)
    const outside = document.createElement('p')
    outside.textContent = 'unrelated'
    document.body.appendChild(outside)
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(outside)
    selection.addRange(range)
    expect(replyTextFromSelection(inside, selection, 'Full response')).toBe('Full response')
    selection.removeAllRanges()
    range.selectNodeContents(inside)
    selection.addRange(range)
    expect(replyTextFromSelection(inside, selection, 'Full response')).toBe('selected passage')
    inside.remove()
    outside.remove()
  })
  it('tags the selected passage in the originating tile without inserting editable text', () => {
    render(
      <div data-composer-session-key="session-test" data-composer-target="tile:test">
        <div data-slot="aui_assistant-message-root">
          <p data-slot="aui_assistant-message-content">Selected section</p>
          <MessageReplyButton getMessageText={() => 'Complete answer'} messageId="answer-1" />
        </div>
      </div>
    )
    const passage = screen.getByText('Selected section')
    const range = document.createRange()
    range.selectNodeContents(passage)
    window.getSelection()!.addRange(range)
    const button = screen.getByRole('button', { name: 'Reply to this part' })
    fireEvent.pointerDown(button)
    fireEvent.click(button)
    expect(bus.reply).toHaveBeenCalledWith({
      reply: { messageId: 'answer-1', quote: 'Selected section' },
      sessionKey: 'session-test',
      target: 'tile:test'
    })
  })
  it('tags the complete response for keyboard activation with no selection', () => {
    render(
      <div data-composer-session-key="s1" data-composer-target="main">
        <MessageReplyButton getMessageText={() => 'Whole answer'} messageId="a1" />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reply to this part' }))
    expect(bus.reply).toHaveBeenCalledWith({
      reply: { messageId: 'a1', quote: 'Whole answer' },
      sessionKey: 's1',
      target: 'main'
    })
  })
  it('does not retarget a reply when the originating chat is absent', () => {
    render(<MessageReplyButton getMessageText={() => 'Whole answer'} messageId="a1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reply to this part' }))
    expect(bus.reply).not.toHaveBeenCalled()
  })
})
