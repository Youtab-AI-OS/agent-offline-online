import { Loader as RuntimeSimorghLoader } from '@/components/ui/loader'
import { SimorghOrb as RuntimeSimorghMark } from '@/components/ui/simorgh-orb'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ModelMenuCloseContext } from '@/app/shell/model-menu-panel'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { formatModelStatusLabel } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'
import { $currentModelSource, $defaultReasoningEffort, setModelPickerOpen } from '@/store/session'

import { onComposerModelMenuRequest } from './focus'
import { useComposerScope } from './scope'
import type { ChatBarState } from './types'

const PILL = cn(
  'runtime-composer-model-icon',
  'size-(--composer-control-size) shrink-0 justify-center gap-0 rounded-full p-0',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

/**
 * Composer model selector — the relocated status-bar pill. Reuses the live
 * `model.options` dropdown (`modelMenuContent`) verbatim; falls back to the
 * full picker when the gateway is closed and no live menu exists.
 *
 * Display follows THIS surface's SessionView (primary or tile) — never the
 * primary-only globals — so side-by-side panes each show their own model.
 */
export function ModelPill({
  compact = false,
  disabled,
  model
}: {
  compact?: boolean
  disabled: boolean
  model: ChatBarState['model']
}) {
  const copy = useI18n().t.shell.statusbar
  const view = useSessionView()
  // Prefer the chat-bar snapshot (already view-scoped by ChatView); fall back
  // to the live SessionView atoms so a mid-flight session.info still paints.
  const viewModel = useStore(view.$model)
  const viewProvider = useStore(view.$provider)
  const currentModel = model.model || viewModel
  const currentProvider = model.provider || viewProvider
  const fastMode = useStore(view.$fast)
  const reasoningEffort = useStore(view.$reasoningEffort)
  const modelSource = useStore($currentModelSource)
  const defaultEffort = useStore($defaultReasoningEffort)
  const runtimeId = useStore(view.$runtimeId)
  const [open, setOpen] = useState(false)
  const scope = useComposerScope()
  const hasLiveMenu = Boolean(model.modelMenuContent)

  // The `composer.modelPicker` hotkey, routed to exactly one surface (the pane
  // under the pointer, else the active composer — see requestModelMenuToggle).
  // Toggles the live dropdown; with no live menu (gateway closed) it opens the
  // full picker dialog, same as clicking the pill.
  useEffect(
    () =>
      onComposerModelMenuRequest((target) => {
        if (target !== scope.target || disabled) {
          return
        }

        if (hasLiveMenu) {
          setOpen((prev) => !prev)
        } else {
          setModelPickerOpen(true)
        }
      }),
    [scope.target, disabled, hasLiveMenu]
  )

  // The composer pick is sticky: a manual selection is pinned and every NEW
  // chat uses it instead of the Settings → Model default — silently, which has
  // cost users real money on a forgotten paid-model pick (#62055). Surface the
  // pin whenever a draft (no live session) is running on a manual override. A
  // live session's footer reflects that session's model, so no badge there.
  // Tiles always have a runtime — pin badge is primary-draft only.
  const pinnedOverride =
    view.kind === 'primary' && !runtimeId && modelSource === 'manual' && Boolean(currentModel.trim())

  // Icon-only in both composer sizes. Keep the current selection, effort and
  // manual override discoverable through the accessible name and tooltip.
  // The existing loader reflects the unresolved model; no timer or fake state.
  const label = (
    <span aria-hidden="true" className="inline-flex items-center justify-center">
      {currentModel.trim() ? (
        <RuntimeSimorghMark className="runtime-model-orb" />
      ) : (
        <RuntimeSimorghLoader className="runtime-model-orb" />
      )}
    </span>
  )

  // Floating and docked composers both use a snug icon-sized target. Do not
  // inherit the old text pill's minimum width or padding.
  const pillClass = compact
    ? cn(
        'size-(--composer-control-size) shrink-0 justify-center gap-0 rounded-md p-0',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      )
    : PILL

  const modelLabel = currentModel.trim()
    ? formatModelStatusLabel(currentModel, { defaultEffort, fastMode, reasoningEffort })
    : copy.modelNone
  const baseTitle = currentProvider
    ? copy.modelTitle(currentProvider, modelLabel)
    : currentModel.trim()
      ? `${copy.switchModel} — ${modelLabel}`
      : copy.switchModel

  const title = pinnedOverride ? `${baseTitle} — ${copy.modelPinned}` : baseTitle

  if (!model.modelMenuContent) {
    return (
      <Tip label={`${copy.openModelPicker} — ${title}`} side="top">
        <Button
          aria-label={`${copy.openModelPicker} — ${title}`}
          className={pillClass}
          disabled={disabled}
          onClick={() => setModelPickerOpen(true)}
          type="button"
          variant="ghost"
        >
          {label}
        </Button>
      </Tip>
    )
  }

  // Closing the menu ends its claim on the keyboard: Radix restores focus to
  // this pill (a toolbar button), so without the release the Enter that
  // committed a model also swallows whatever you type next.
  const setMenuOpen = (next: boolean) => {
    setOpen(next)

    if (!next) {
      releaseTypingFocus()
    }
  }

  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={open}>
      <Tip label={title} side="top">
        <DropdownMenuTrigger asChild>
          <Button aria-label={title} className={pillClass} disabled={disabled} type="button" variant="ghost">
            {label}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent data-model-selector="" align="end" className="w-64 p-0" side="top" sideOffset={8}>
        <ModelMenuCloseContext.Provider value={() => setMenuOpen(false)}>
          {model.modelMenuContent}
        </ModelMenuCloseContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
