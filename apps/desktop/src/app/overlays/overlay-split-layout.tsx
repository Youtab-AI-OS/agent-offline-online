import {
  IconArchive,
  IconBell,
  IconBolt,
  IconBrain,
  IconChartBar,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconCube,
  IconDeviceDesktop,
  IconGitPullRequest,
  IconInfoCircle,
  IconKey,
  IconKeyboard,
  IconLayoutGrid,
  IconLink,
  IconLock,
  IconMessageCircle,
  IconMicrophone,
  IconPalette,
  IconServer2,
  IconSettings,
  IconTool,
  IconTools,
  IconUserCircle
} from '@tabler/icons-react'
import { Fragment, memo, type ReactNode } from 'react'

import { TabDropdown } from '@/components/ui/tab-dropdown'
import { useI18n } from '@/i18n'
import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { PAGE_MAX_W } from '../layout-constants'

import { OVERLAY_TOP_CLEARANCE } from './overlay-view'

// The wide rail and the narrow dropdown swap at exactly the width where
// OverlaySplitLayout drops to a single column, so the rail never stacks.
const RAIL_HIDDEN = 'max-[47.5rem]:hidden'
const BAR_HIDDEN = 'hidden max-[47.5rem]:flex'

interface OverlaySplitLayoutProps {
  children: ReactNode
  className?: string
}

interface OverlaySidebarProps {
  children: ReactNode
  className?: string
}

interface OverlayMainProps {
  children: ReactNode
  className?: string
}

interface OverlayNavItemProps {
  active: boolean
  icon: IconComponent
  label: string
  // Renders as an indented child of another nav item: smaller icon and a
  // lighter active state so it never competes with the boxed parent item.
  nested?: boolean
  onClick: () => void
  trailing?: ReactNode
}

export function OverlaySplitLayout({ children, className }: OverlaySplitLayoutProps) {
  return (
    <div
      className={cn(
        // Narrow: one column, and pin rows to [nav-bar auto | main 1fr] — without
        // an explicit template the grid's default align-content:stretch splits the
        // height evenly across the two rows, shoving the content to mid-screen.
        'grid h-full min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)] overflow-hidden bg-transparent max-[47.5rem]:grid-cols-1 max-[47.5rem]:grid-rows-[auto_minmax(0,1fr)]',
        className
      )}
      data-slot="overlay-split"
    >
      {children}
    </div>
  )
}

export function OverlaySidebar({ children, className }: OverlaySidebarProps) {
  return (
    <aside
      className={cn(
        // The left links sit beside (not under) the floating close button, so
        // they ride up via the shorter shared OVERLAY_TOP_CLEARANCE (same line
        // as a Panel header) instead of main's taller X-clearance. The bg still
        // fills from the card's top edge, so there's no gap above the sidebar.
        'flex min-h-0 flex-col gap-0.5 overflow-y-auto bg-(--ui-sidebar-surface-background) px-2.5 pb-3',
        OVERLAY_TOP_CLEARANCE,
        className
      )}
      data-slot="overlay-sidebar"
    >
      {children}
    </aside>
  )
}

export function OverlayMain({ children, className }: OverlayMainProps) {
  return (
    <main
      className={cn(
        // Main sits UNDER the floating close button (top-right), so it keeps the
        // taller top pad to clear the X — unlike the sidebar / Panel header,
        // which sit to its left and ride up via OVERLAY_TOP_CLEARANCE. All four
        // paddings are 1/3 tighter than the raw values (×2/3): the wide/narrow
        // top clearance, the bottom gutter, and the horizontal clamp gutter
        // (inlined from PAGE_INSET_X so only overlay panes tighten, not the
        // shared page gutter). Narrow top drops toward the OverlayNav bar.
        'mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent pb-2 pt-[calc((var(--titlebar-height)/2+1rem)*2/3)] max-[47.5rem]:pt-[calc(0.5rem*2/3)] px-[clamp(0.8333rem,2.6667vw,2.6667rem)]',
        PAGE_MAX_W,
        className
      )}
      data-slot="overlay-main"
    >
      {children}
    </main>
  )
}

export const OverlayNavItem = memo(function OverlayNavItem({
  active,
  icon: Icon,
  label,
  nested,
  onClick,
  trailing
}: OverlayNavItemProps) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7 w-full items-center justify-start gap-2 rounded-md border px-2 text-left text-[length:var(--conversation-text-font-size)] font-normal transition-colors',
        nested
          ? active
            ? 'border-transparent bg-(--chrome-action-hover) font-medium text-foreground'
            : 'border-transparent bg-transparent text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          : active
            ? 'border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) text-foreground'
            : 'border-transparent bg-transparent text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      )}
      data-slot="overlay-nav-item"
      onClick={onClick}
      type="button"
    >
      <Icon
        className={cn(
          'shrink-0',
          nested ? 'size-3.5' : 'size-4',
          active ? 'text-foreground/80' : 'text-muted-foreground/80'
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
})

export interface OverlayNavLink {
  active: boolean
  icon: IconComponent
  id: string
  label: string
  onSelect: () => void
}

export interface OverlayNavGroup extends OverlayNavLink {
  /** Sub-links: expanded under the active group on the rail, always listed
   *  (flattened + indented) in the narrow dropdown. */
  children?: OverlayNavLink[]
  /** Visual break before this group — a spacer on the rail, a separator in
   *  the dropdown. */
  gapBefore?: boolean
}

// Data-driven pane nav: one model renders a persistent left rail on wide
// viewports and a single dropdown bar on narrow ones (matching the tab
// dropdown in PageSearchShell), so every OverlaySplitLayout pane degrades the
// same way instead of stacking its whole sidebar. Drop it in as the first
// child of an OverlaySplitLayout, before OverlayMain.
export function OverlayNav({ footer, groups }: { footer?: ReactNode; groups: OverlayNavGroup[] }) {
  const { t } = useI18n()
  return (
    <>
      <OverlaySidebar className={RAIL_HIDDEN}>
        {(() => {
          const isSettings = groups.some(group => group.id === 'config:model')
          const renderGroup = (group: OverlayNavGroup) => {
            const childrenVisible = group.id === 'providers' || group.active
            const GroupIcon = (isSettings ? RUNTIME_NAV_ICONS[group.id] : null) ?? group.icon
            return (
              <Fragment key={group.id}>
                <OverlayNavItem
                  active={group.active}
                  icon={GroupIcon}
                  label={group.label}
                  onClick={group.onSelect}
                  trailing={
                    group.children ? (
                      childrenVisible ? (
                        <IconChevronUp className="runtime-nav-chevron" />
                      ) : (
                        <IconChevronDown className="runtime-nav-chevron" />
                      )
                    ) : undefined
                  }
                />
                {group.children && childrenVisible && (
                  <div className="runtime-nav-children">
                    {group.children.map(child => (
                      <OverlayNavItem
                        active={child.active}
                        icon={(isSettings ? RUNTIME_NAV_ICONS[child.id] : null) ?? child.icon}
                        key={child.id}
                        label={child.label}
                        nested
                        onClick={child.onSelect}
                      />
                    ))}
                  </div>
                )}
              </Fragment>
            )
          }
          if (!isSettings) {return groups.map(renderGroup)}
          const providers = groups.findIndex(group => group.id === 'providers')
          const application = groups.findIndex(group => group.id === 'developer')
          const enterprise = groups.findIndex(group => group.id === 'organization-admin')
          const sections = [
            { label: t.visual.settingsGeneral, items: groups.slice(0, providers) },
            { label: t.visual.settingsConnections, items: groups.slice(providers, application) },
            {
              label: t.visual.settingsApplication,
              items: groups.slice(application, enterprise < 0 ? undefined : enterprise)
            },
            ...(enterprise < 0 ? [] : [{ label: t.messageActions.enterprise, items: groups.slice(enterprise) }])
          ]
          return sections.map(section => (
            <details className="runtime-nav-category" key={section.label} open>
              <summary>
                <span>{section.label}</span>
                <IconChevronDown />
              </summary>
              <div className="runtime-nav-items">{section.items.map(renderGroup)}</div>
            </details>
          ))
        })()}
        {footer && <div className="runtime-nav-footer">{footer}</div>}
      </OverlaySidebar>

      {/* Narrow: ride the OverlayView titlebar strip so the dropdown shares the
          close button's row instead of taking its own. The bar is
          pointer-events-none (children opt back in) so the floating X underneath
          stays clickable; pr clears it, no-drag beats the strip's drag region,
          and the height matches the strip so the trigger lines up with the X. */}
      <div
        className={cn(
          'pointer-events-none relative z-20 h-[calc(var(--titlebar-height)+0.1875rem)] items-center justify-between gap-2 pl-3 pr-12',
          BAR_HIDDEN
        )}
      >
        <div className="pointer-events-auto min-w-0 [-webkit-app-region:no-drag]">
          <TabDropdown
            align="start"
            items={groups.flatMap(group => [
              {
                active: group.active && !group.children?.some(child => child.active),
                icon: group.icon,
                id: group.id,
                label: group.label,
                onSelect: group.onSelect,
                separatorBefore: group.gapBefore
              },
              ...(group.children ?? []).map(child => ({
                active: child.active,
                icon: child.icon,
                id: child.id,
                indent: true,
                label: child.label,
                onSelect: child.onSelect
              }))
            ])}
          />
        </div>
        {footer && (
          <div className="pointer-events-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
            {footer}
          </div>
        )}
      </div>
    </>
  )
}

const RUNTIME_NAV_ICONS: Record<string, IconComponent> = {
  'config:model': IconCube,
  'config:chat': IconMessageCircle,
  'config:appearance': IconPalette,
  'config:workspace': IconDeviceDesktop,
  'config:safety': IconLock,
  'config:memory': IconBrain,
  'config:voice': IconMicrophone,
  'config:advanced': IconTool,
  notifications: IconBell,
  billing: IconChartBar,
  providers: IconBolt,
  'pview:accounts': IconUserCircle,
  'pview:keys': IconKey,
  'pview:custom-endpoints': IconLink,
  gateway: IconServer2,
  keybinds: IconKeyboard,
  keys: IconTools,
  'kview:tools': IconTool,
  'kview:settings': IconSettings,
  plugins: IconCube,
  sessions: IconArchive,
  about: IconInfoCircle,
  usage: IconChartBar,
  developer: IconCode,
  'code-review': IconGitPullRequest,
  skills: IconLayoutGrid,
  'computer-use': IconDeviceDesktop
}
