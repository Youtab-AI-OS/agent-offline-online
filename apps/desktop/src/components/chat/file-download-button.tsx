import { downloadDesktopFile } from '@/lib/download-file'

import { DownloadActions } from './download-actions'

export function FileDownloadButton({ path, cwd }: { path: string; cwd?: string | null }) {
  return <DownloadActions identity={`${cwd || ''}\0${path}`} save={mode => downloadDesktopFile(path, cwd, mode)} />
}
