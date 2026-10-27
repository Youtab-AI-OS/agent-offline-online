import { useState } from 'react'
import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'
import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { IconGitPullRequest, IconLayoutList, IconGitCommit } from '@tabler/icons-react'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { getUsageAnalytics } from '@/youtab'
import { $reviewTreeMode, $reviewCommitDefault } from '@/store/review'
import { UsagePanel } from '@/app/command-center'
import { SettingsContent, SettingsSection, ListRow } from '@/app/settings/primitives'

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
          value={String(period)}
          onChange={id => setPeriod(Number(id) as 7 | 30 | 90)}
          options={[7, 30, 90].map(n => ({ id: String(n), label: t.commandCenter.days(n) }))}
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
          title={c.reviewFileLayout}
          action={
            <Select value={mode} onValueChange={v => $reviewTreeMode.set(v as 'tree' | 'list')}>
              <SelectTrigger aria-label="Changed-file layout">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tree">{c.reviewTree}</SelectItem>
                <SelectItem value="list">{c.reviewList}</SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsSection>
      <SettingsSection icon={IconGitCommit} title={c.reviewDefaultAction}>
        <ListRow
          title={c.reviewDefaultActionDescription}
          action={
            <Select value={action} onValueChange={v => $reviewCommitDefault.set(v as 'commit' | 'commitPush')}>
              <SelectTrigger aria-label="Review button default">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="commit">Commit</SelectItem>
                <SelectItem value="commitPush">Commit &amp; Push</SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsSection>
      <p className="runtime-added-description">{c.reviewContextDescription}</p>
    </SettingsContent>
  )
}
