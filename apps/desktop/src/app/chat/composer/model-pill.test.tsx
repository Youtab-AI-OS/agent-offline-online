import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatBarState } from '@/app/chat/composer/types'
import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { ModelMenuCloseContext } from '@/app/shell/model-menu-panel'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  $activeSessionId,
  $currentModel,
  $modelPickerOpen,
  setCurrentModel,
  setCurrentModelSource,
  setModelPickerOpen
} from '@/store/session'

import { markActiveComposer, requestModelMenuToggle } from './focus'
import { ModelPill } from './model-pill'

const modelState = (over: Partial<ChatBarState['model']> = {}): ChatBarState['model'] => ({
  canSwitch: true,
  model: 'gpt-6',
  provider: 'openai',
  ...over
})

afterEach(() => {
  cleanup()
  $activeSessionId.set(null)
  setCurrentModel('')
  setCurrentModelSource('')
  setModelPickerOpen(false)
  markActiveComposer('main')
})

// #62055: a manual composer pick is sticky and silently overrides the
// Settings → Model default for every NEW chat. The pill must say so.
describe('ModelPill accessible pinned override', () => {
  it('announces the manual pick without an extra visible badge', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set(null)

    render(<ModelPill disabled={false} model={modelState({ model: 'deepseek/deepseek-v4-flash' })} />)

    expect(screen.getByRole('button', { name: /pinned by you/ })).toBeTruthy()
    expect(screen.queryByTestId('model-pinned-dot')).toBeNull()
  })

  it('stays quiet when the composer reflects the profile default', () => {
    setCurrentModel('google/gemma-4-26b-a4b-it:free')
    setCurrentModelSource('default')
    $activeSessionId.set(null)

    render(<ModelPill disabled={false} model={modelState()} />)

    expect(screen.queryByTestId('model-pinned-dot')).toBeNull()
    expect(screen.queryByRole('button', { name: /pinned by you/ })).toBeNull()
  })

  it('stays quiet on a live session (footer shows that session, not the pin)', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set('live-1')

    render(<ModelPill disabled={false} model={modelState()} />)

    expect(screen.queryByTestId('model-pinned-dot')).toBeNull()
    expect(screen.queryByRole('button', { name: /pinned by you/ })).toBeNull()
  })

  it('is exercised in both render paths', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set(null)

    // Fallback (no live menu) path.
    const { unmount } = render(
      <ModelPill disabled={false} model={modelState({ model: 'deepseek/deepseek-v4-flash' })} />
    )

    expect(screen.getByRole('button', { name: /pinned by you/ })).toBeTruthy()
    unmount()

    // Live-menu (dropdown) path.
    render(
      <ModelPill
        disabled={false}
        model={modelState({ model: 'deepseek/deepseek-v4-flash', modelMenuContent: <div /> })}
      />
    )
    expect(screen.getByRole('button', { name: /pinned by you/ })).toBeTruthy()
    expect($currentModel.get()).toBe('deepseek/deepseek-v4-flash')
  })
})

describe('ModelPill per-surface accessible model label', () => {
  it('announces the chat-bar model and effort even when the primary global differs', () => {
    setCurrentModel('primary/model')
    $activeSessionId.set('primary-runtime')

    const tileView: SessionView = {
      kind: 'tile',
      $awaitingResponse: atom(false),
      $busy: atom(false),
      $cwd: atom(''),
      $fast: atom(false),
      $lastVisibleIsUser: atom(false),
      $messages: atom([]),
      $messagesEmpty: atom(true),
      $model: atom('tile/claude-sonnet'),
      $provider: atom('anthropic'),
      $reasoningEffort: atom('high'),
      $runtimeId: atom('tile-runtime'),
      $storedId: atom('stored-tile')
    }

    render(
      <SessionViewProvider value={tileView}>
        <ModelPill
          disabled={false}
          model={modelState({ model: 'tile/claude-sonnet', provider: 'anthropic', modelMenuContent: <div /> })}
        />
      </SessionViewProvider>
    )

    expect(screen.getByRole('button', { name: 'Model · anthropic: Sonnet · High' })).toBeTruthy()
    expect(screen.queryByText('Sonnet · High')).toBeNull()
    expect(screen.queryByText(/primary/i)).toBeNull()
  })
})

function SelectionMenu({ onSelect }: { onSelect: () => void }) {
  const close = useContext(ModelMenuCloseContext)

  return (
    <DropdownMenuItem
      onSelect={() => {
        setCurrentModel('local/eco')
        onSelect()
        close()
      }}
    >
      ECO local model
    </DropdownMenuItem>
  )
}

describe('icon-only ModelPill interactions', () => {
  it.each([false, true])('uses only Simorgh at compact=%s and keeps the fallback picker working', (compact) => {
    render(<ModelPill compact={compact} disabled={false} model={modelState()} />)
    const button = screen.getByRole('button', { name: /Open model picker.*openai.*GPT-6/ })

    expect(button.querySelectorAll('svg')).toHaveLength(1)
    expect(screen.queryByText(/GPT-6/)).toBeNull()
    expect(button.querySelector('.truncate')).toBeNull()
    fireEvent.click(button)
    expect($modelPickerOpen.get()).toBe(true)
  })

  it('retains the live keyboard menu and invokes the actual supplied selection handler in RTL', async () => {
    const onSelect = vi.fn()
    setCurrentModel('gpt-6')
    render(
      <div dir="rtl">
        <ModelPill
          disabled={false}
          model={modelState({ model: '', provider: 'custom', modelMenuContent: <SelectionMenu onSelect={onSelect} /> })}
        />
      </div>
    )
    const button = screen.getByRole('button', { name: /custom.*GPT-6/ })
    button.focus()
    fireEvent.keyDown(button, { key: 'Enter' })
    const choice = await screen.findByRole('menuitem', { name: 'ECO local model' })
    choice.focus()
    fireEvent.keyDown(choice, { key: 'Enter' })

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1))
    expect($currentModel.get()).toBe('local/eco')
    expect(screen.getByRole('button', { name: /custom.*Eco/ })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('routes the existing composer hotkey to the live menu', async () => {
    render(
      <div data-composer-target="main">
        <ModelPill disabled={false} model={modelState({ modelMenuContent: <SelectionMenu onSelect={vi.fn()} /> })} />
      </div>
    )

    act(() => {
      expect(requestModelMenuToggle()).toBe(true)
    })
    expect(await screen.findByRole('menuitem', { name: 'ECO local model' })).toBeTruthy()
  })

  it('does not open either picker when disabled', async () => {
    render(
      <div data-composer-target="main">
        <ModelPill disabled={true} model={modelState()} />
      </div>
    )
    fireEvent.click(screen.getByRole('button'))
    act(() => {
      requestModelMenuToggle()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect($modelPickerOpen.get()).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
