export interface ProjectBackupSummary {
  id: string
  created_at: number
  manifest_sha256: string
  retained_directory: string
  roots: number
  files: number
}
export interface ProjectBackupPage {
  files: Array<{ path: string; size: number }>
  total: number
  offset: number
  next_offset: number | null
}
export interface ProjectBackupPreview {
  token: string
  expires_in_seconds: number
  files: Array<{ path: string; changed: boolean; current_sha256: string | null; backup_sha256: string }>
  chats_changed: false
}
export interface ProjectBackupRestoreResult {
  status: 'RESTORED' | 'PARTIAL' | 'FAILED'
  error?: string
  files: string[]
  chats_changed: false
  undo_receipt: { id: string; workspace: string; manifest_sha256: string }
}
