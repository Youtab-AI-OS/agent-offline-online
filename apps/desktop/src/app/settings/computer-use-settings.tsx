import { IconDeviceDesktop } from '@tabler/icons-react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import { SKILLS_ROUTE } from '../routes'

import { ComputerUsePanel } from './computer-use-panel'
import { SettingsContent } from './primitives'
import { ToolsetConfigPanel } from './toolset-config-panel'

export function ComputerUseSettings() {
  const { t } = useI18n()
  const navigate = useNavigate()

  return (
    <SettingsContent>
      <h1 className="runtime-section-heading">
        <IconDeviceDesktop />
        <span>{t.visual.settingsComputerUse}</span>
      </h1>
      <p className="runtime-added-description">{t.visual.computerUseDescription}</p>
      <div className="grid gap-5">
        <ComputerUsePanel />
        <ToolsetConfigPanel toolset="computer_use" />
        <div className="grid justify-items-start gap-2">
          <p className="text-sm text-muted-foreground">{t.visual.computerUseAvailability}</p>
          <Button onClick={() => navigate(`${SKILLS_ROUTE}?tab=toolsets`)} size="sm" variant="text">
            {t.visual.computerUseTools}
          </Button>
        </div>
      </div>
    </SettingsContent>
  )
}
