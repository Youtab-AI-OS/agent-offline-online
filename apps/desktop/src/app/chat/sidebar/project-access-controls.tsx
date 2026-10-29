import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { FolderOpen, Wrench } from '@/lib/icons'
import { setFileBrowserOpen } from '@/store/layout'

import { SKILLS_ROUTE } from '../../routes'
import { ProjectBackupsPanel } from '../../settings/project-backups-panel'
import { workspaceProjectCopy } from '../../settings/workspace-project-copy'
import { WorkspaceProjectSetting } from '../../settings/workspace-project-setting'

/** Separate from the existing +profile action; both remain reachable. */
export function ProjectAccessControls() {
  const { locale } = useI18n()
  const copy = workspaceProjectCopy(locale)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button aria-label={copy.navProject} onClick={() => setOpen(true)} size="xs" type="button" variant="ghost">
        <FolderOpen />
        <span>{copy.navProject}</span>
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
          </DialogHeader>
          <WorkspaceProjectSetting heading={false} />
          <ProjectBackupsPanel />
          <DialogFooter>
            <Button
              onClick={() => {
                setFileBrowserOpen(true)
                setOpen(false)
              }}
              size="sm"
              variant="secondary"
            >
              <FolderOpen />
              {copy.navFiles}
            </Button>
            <Button
              onClick={() => {
                navigate(`${SKILLS_ROUTE}?tab=toolsets`)
                setOpen(false)
              }}
              size="sm"
              variant="secondary"
            >
              <Wrench />
              {copy.navTools}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
