import { useStore } from '@nanostores/react'
import { IconGitCommit, IconGitPullRequest, IconLayoutList } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { UsagePanel } from '@/app/command-center'
import { ListRow, SettingsContent, SettingsSection } from '@/app/settings/primitives'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { $activeGatewayProfile } from '@/store/profile'
import { $reviewCommitDefault, $reviewTreeMode } from '@/store/review'
import { $connection } from '@/store/session'
import { getUsageAnalytics } from '@/youtab'

export function UsageSettings() {
  const { t } = useI18n()
  const [period, setPeriod] = useState<7 | 30 | 90>(30)
  const profile = useStore($activeGatewayProfile)
  const connection = useStore($connection)
  const scope = [profile, connection?.mode, desktopFsCacheKey()]
  const query = useQuery({
    queryKey: ['settings-usage', ...scope, period],
    queryFn: () => getUsageAnalytics(period),
    retry: false
  })
  return (
    <div className="runtime-added-content">
      <header>
        <h1 className="runtime-section-heading">{t.commandCenter.sections.usage}</h1>
        <p>{t.commandCenter.sectionDescriptions.usage}</p>
        <SegmentedControl
          onChange={id => setPeriod(Number(id) as 7 | 30 | 90)}
          options={[7, 30, 90].map(n => ({ id: String(n), label: t.commandCenter.days(n) }))}
          value={String(period)}
        />
      </header>
      <UsagePanel
        error={query.error?.message ?? ''}
        loading={query.isLoading}
        onRefresh={() => void query.refetch()}
        period={period}
        usage={query.data ?? null}
      />
    </div>
  )
}
export function CodeReviewSettings() {
  const { t } = useI18n()
  const c = t.visual
  const mode = useStore($reviewTreeMode)
  const action = useStore($reviewCommitDefault)
  return (
    <SettingsContent>
      <h1 className="runtime-section-heading">
        <IconGitPullRequest />
        <span>{c.settingsCodeReview}</span>
      </h1>
      <p className="runtime-added-description">{c.reviewPreferencesDescription}</p>
      <SettingsSection icon={IconLayoutList} title={c.reviewFiles}>
        <ListRow
          action={
            <Select onValueChange={v => $reviewTreeMode.set(v as 'tree' | 'list')} value={mode}>
              <SelectTrigger aria-label="Changed-file layout">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tree">{c.reviewTree}</SelectItem>
                <SelectItem value="list">{c.reviewList}</SelectItem>
              </SelectContent>
            </Select>
          }
          title={c.reviewFileLayout}
        />
      </SettingsSection>
      <SettingsSection icon={IconGitCommit} title={c.reviewDefaultAction}>
        <ListRow
          action={
            <Select onValueChange={v => $reviewCommitDefault.set(v as 'commit' | 'commitPush')} value={action}>
              <SelectTrigger aria-label="Review button default">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="commit">Commit</SelectItem>
                <SelectItem value="commitPush">Commit &amp; Push</SelectItem>
              </SelectContent>
            </Select>
          }
          title={c.reviewDefaultActionDescription}
        />
      </SettingsSection>
      <p className="runtime-added-description">{c.reviewContextDescription}</p>
    </SettingsContent>
  )
}
