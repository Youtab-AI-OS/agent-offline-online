import type { YoutabExportMode } from '@/global'
import { desktopFsCacheKey, isDesktopFsRemoteMode, readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'

import { DownloadActions, type DownloadOutcome } from './download-actions'

export function FileDownloadButton({ path, cwd }: { path: string; cwd?: string | null }) {
  const save = async (mode: YoutabExportMode): Promise<DownloadOutcome> => {
    const connectionKey = desktopFsCacheKey()
    const target = await normalizeOrLocalPreviewTarget(path, cwd)

    if (!target || target.kind !== 'file' || !target.path) {
      throw new Error('The file is unavailable.')
    }

    if (desktopFsCacheKey() !== connectionKey) {
      return { status: 'cancelled' }
    }

    const bridge = window.youtabDesktop

    if (!isDesktopFsRemoteMode()) {
      if (bridge?.exportFile) {
        return bridge.exportFile({ path: target.path, mode })
      }

      if (bridge?.saveFileCopy) {
        return (await bridge.saveFileCopy(target.path)) ? { status: 'started' } : { status: 'cancelled' }
      }
    }

    const dataUrl = await readDesktopFileDataUrl(target.path)

    if (desktopFsCacheKey() !== connectionKey) {
      return { status: 'cancelled' }
    }

    if (!dataUrl.startsWith('data:')) {
      throw new Error('The file is unavailable.')
    }

    if (bridge?.exportContent) {
      const response = await fetch(dataUrl)
      const bytes = new Uint8Array(await response.arrayBuffer())

      if (desktopFsCacheKey() !== connectionKey) {
        return { status: 'cancelled' }
      }

      return bridge.exportContent({ name: target.label, data: bytes, mode })
    }

    if (mode === 'save-as') {
      throw new Error('Save as requires the current Youtab Desktop application.')
    }

    const link = document.createElement('a')
    link.href = dataUrl
    link.download = target.label
    link.rel = 'noopener noreferrer'
    document.body.appendChild(link)
    link.click()
    link.remove()

    return { status: 'started' }
  }

  return <DownloadActions identity={`${cwd || ''}\0${path}`} save={save} />
}
