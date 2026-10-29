import { act, cleanup, renderHook } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PaneVisibleContext } from '@/components/pane-shell/pane-visibility'
import { type ChatMessage, textPart } from '@/lib/chat-messages'
import { createComposerAttachmentScope, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { enqueueQueuedPrompt, getQueuedPrompts, removeQueuedPrompt } from '@/store/composer-queue'

import { requestComposerReply } from '../focus'
import { type ComposerScope, ComposerScopeProvider } from '../scope'

import { useComposerReply } from './use-composer-reply'

const fsContext = vi.hoisted(() => ({ key: 'reply-profile-a' }))
vi.mock('@/lib/desktop-fs', () => ({ desktopFsCacheKey: () => fsContext.key }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  fsContext.key = 'reply-profile-a'
})

describe('scoped reply draft', () => {
  const makeScope = (): ComposerScope => ({
    target: 'tile:a',
    attachments: createComposerAttachmentScope(),
    $messages: atom<ChatMessage[]>([{ id: 'answer-a', role: 'assistant', parts: [textPart('فارسی Answer A')] }]),
    $awaitingInput: atom(false)
  })

  it('keeps a single replaceable reply tag, without modifying text or other attachments', () => {
    vi.useFakeTimers()
    const scope = makeScope()
    const focus = vi.fn()
    scope.attachments.add({ id: 'doc', kind: 'file', label: 'doc.txt' })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ComposerScopeProvider value={scope}>{children}</ComposerScopeProvider>
    )

    renderHook(() => useComposerReply('reply-session-a', focus), { wrapper })
    act(() => {
      requestComposerReply({
        target: 'tile:a',
        sessionKey: 'reply-session-a',
        reply: { messageId: 'answer-a', quote: 'فارسی' }
      })
      vi.runAllTimers()
    })
    act(() => {
      requestComposerReply({
        target: 'tile:a',
        sessionKey: 'reply-session-a',
        reply: { messageId: 'answer-a', quote: 'Answer A' }
      })
      vi.runAllTimers()
    })
    expect(scope.attachments.$attachments.get().map(a => a.kind)).toEqual(['file', 'reply'])
    expect(scope.attachments.$attachments.get()[1]?.replyTo?.quote).toBe('Answer A')
    expect(scope.attachments.$attachments.get()[1]?.refText).toBeUndefined()
    expect(focus).toHaveBeenCalledTimes(2)
    scope.attachments.remove('message-reply')
    expect(scope.attachments.$attachments.get().map(a => a.kind)).toEqual(['file'])
  })
  it('rejects a deferred request after a session switch and unknown source messages', () => {
    vi.useFakeTimers()
    const scope = makeScope()
    const focus = vi.fn()

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ComposerScopeProvider value={scope}>{children}</ComposerScopeProvider>
    )

    const hook = renderHook(({ sid }) => useComposerReply(sid, focus), { wrapper, initialProps: { sid: 'a' } })
    act(() =>
      requestComposerReply({ target: 'tile:a', sessionKey: 'a', reply: { messageId: 'answer-a', quote: 'private a' } })
    )
    hook.rerender({ sid: 'b' })
    act(() => vi.runAllTimers())
    act(() => {
      requestComposerReply({ target: 'tile:a', sessionKey: 'b', reply: { messageId: 'missing', quote: 'private b' } })
      vi.runAllTimers()
    })
    expect(scope.attachments.$attachments.get()).toEqual([])
    expect(focus).not.toHaveBeenCalled()
  })
  it('survives session draft swaps and queue storage without embedding the quote in typed text', () => {
    const scope = makeScope()

    const reply = {
      id: 'message-reply',
      kind: 'reply' as const,
      label: 'Answer A',
      replyTo: { messageId: 'answer-a', quote: 'Answer A' }
    }

    stashSessionDraft('reply-a', 'My question', [reply])
    expect(takeSessionDraft('reply-b').attachments).toEqual([])
    expect(takeSessionDraft('reply-a')).toEqual({ text: 'My question', attachments: [reply] })
    const queued = enqueueQueuedPrompt('reply-queue-a', { text: 'My question', attachments: [reply] })!
    expect(getQueuedPrompts('reply-queue-a')[0]?.attachments[0]?.replyTo).toEqual(reply.replyTo)
    expect(getQueuedPrompts('reply-queue-a')[0]?.text).toBe('My question')
    removeQueuedPrompt('reply-queue-a', queued.id)
    scope.attachments.clear()
  })

  it('rejects an old connection/profile event even if a copied session has identical ids', () => {
    vi.useFakeTimers()
    const scope = makeScope()
    const focus = vi.fn()
    const wrapper = ({ children }: { children: ReactNode }) => <ComposerScopeProvider value={scope}>{children}</ComposerScopeProvider>
    renderHook(() => useComposerReply('cloned-session', focus), { wrapper })
    act(() => requestComposerReply({ target: 'tile:a', sessionKey: 'cloned-session', reply: { messageId: 'answer-a', quote: 'Private A' } }))
    fsContext.key = 'reply-profile-b'
    act(() => vi.runAllTimers())
    expect(scope.attachments.$attachments.get()).toEqual([])
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not attach context or focus a kept-alive hidden pane', () => {
    vi.useFakeTimers()
    const scope = makeScope()
    const focus = vi.fn()
    const wrapper = ({ children }: { children: ReactNode }) => <PaneVisibleContext value={false}><ComposerScopeProvider value={scope}>{children}</ComposerScopeProvider></PaneVisibleContext>
    renderHook(() => useComposerReply('hidden-session', focus), { wrapper })
    act(() => { requestComposerReply({ target: 'tile:a', sessionKey: 'hidden-session', reply: { messageId: 'answer-a', quote: 'Answer A' } }); vi.runAllTimers() })
    expect(scope.attachments.$attachments.get()).toEqual([])
    expect(focus).not.toHaveBeenCalled()
  })
})
