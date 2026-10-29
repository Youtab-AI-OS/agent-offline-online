import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeProjectId,
  $projects,
  listProjectBackups,
  previewProjectRestore,
  projectBackupFiles,
  restoreProjectFiles
} from '@/store/projects'
import type { ProjectBackupPage, ProjectBackupPreview, ProjectBackupSummary } from '@/types/project-backups'

const labels = {
  en: [
    'Project file backups',
    'Project',
    'Load verified backups',
    'Choose a backup',
    'No verified backups yet.',
    'Load files',
    'More files',
    'Preview selected files',
    'Confirm file restore',
    'Chats are preserved. Only selected files are replaced. New files are not deleted. A verified pre-restore backup is saved.',
    'Files restored.',
    'Recovery incomplete. Pre-restore backup:',
    'No project folder selected.',
    'Select files to preview their current and backup hashes.'
  ],
  fa: [
    'پشتیبان فایل‌های پروژه',
    'پروژه',
    'دریافت پشتیبان‌های تأییدشده',
    'انتخاب پشتیبان',
    'هنوز پشتیبان تأییدشده‌ای وجود ندارد.',
    'دریافت فایل‌ها',
    'فایل‌های بیشتر',
    'پیش‌نمایش فایل‌های انتخابی',
    'تأیید بازیابی فایل‌ها',
    'چت‌ها حفظ می‌شوند. فقط فایل‌های انتخابی جایگزین می‌شوند؛ فایل جدید حذف نمی‌شود. پیش از بازیابی پشتیبان تأییدشده ذخیره می‌شود.',
    'فایل‌ها بازیابی شدند.',
    'بازیابی کامل نشد. پشتیبان پیش از بازیابی:',
    'پوشهٔ پروژه انتخاب نشده است.',
    'فایل‌ها را برای بررسی هش فعلی و پشتیبان انتخاب کنید.'
  ],
  nl: [
    'Projectbestandsback-ups',
    'Project',
    'Geverifieerde back-ups laden',
    'Kies back-up',
    'Nog geen geverifieerde back-ups.',
    'Bestanden laden',
    'Meer bestanden',
    'Geselecteerde bestanden bekijken',
    'Bestandsherstel bevestigen',
    'Chats blijven behouden. Alleen geselecteerde bestanden worden vervangen. Nieuwe bestanden blijven staan. Eerst wordt een geverifieerde herstelback-up opgeslagen.',
    'Bestanden hersteld.',
    'Herstel onvolledig. Back-up vooraf:',
    'Geen projectmap geselecteerd.',
    'Selecteer bestanden om de huidige en back-uphashes te bekijken.'
  ],
  zh: [
    '项目文件备份',
    '项目',
    '加载已验证备份',
    '选择备份',
    '尚无已验证备份。',
    '加载文件',
    '更多文件',
    '预览所选文件',
    '确认恢复文件',
    '聊天记录保留。仅替换所选文件，不删除新文件。恢复前会保存已验证备份。',
    '文件已恢复。',
    '恢复未完成。恢复前备份：',
    '尚未选择项目文件夹。',
    '选择文件以查看当前与备份哈希。'
  ],
  'zh-hant': [
    '專案檔案備份',
    '專案',
    '載入已驗證備份',
    '選擇備份',
    '尚無已驗證備份。',
    '載入檔案',
    '更多檔案',
    '預覽所選檔案',
    '確認還原檔案',
    '聊天記錄保留。僅替換所選檔案，不刪除新檔案。還原前會儲存已驗證備份。',
    '檔案已還原。',
    '還原未完成。還原前備份：',
    '尚未選擇專案資料夾。',
    '選擇檔案以檢視目前與備份雜湊。'
  ],
  ja: [
    'プロジェクトのファイルバックアップ',
    'プロジェクト',
    '検証済みバックアップを読み込む',
    'バックアップを選択',
    '検証済みバックアップはまだありません。',
    'ファイルを読み込む',
    'さらに表示',
    '選択したファイルを確認',
    'ファイル復元を確認',
    'チャットは保持されます。選択ファイルだけを置換し、新規ファイルは削除しません。復元前に検証済みバックアップを保存します。',
    'ファイルを復元しました。',
    '復元が未完了です。復元前バックアップ：',
    'プロジェクトフォルダーが未選択です。',
    '現在とバックアップのハッシュを確認するファイルを選択してください。'
  ],
  ar: [
    'نسخ ملفات المشروع الاحتياطية',
    'المشروع',
    'تحميل النسخ المتحققة',
    'اختر نسخة',
    'لا توجد نسخ متحققة بعد.',
    'تحميل الملفات',
    'ملفات إضافية',
    'معاينة الملفات المحددة',
    'تأكيد استعادة الملفات',
    'تُحفظ المحادثات. تُستبدل الملفات المحددة فقط ولا تُحذف الملفات الجديدة. تُحفظ نسخة متحققة قبل الاستعادة.',
    'تمت استعادة الملفات.',
    'الاستعادة غير مكتملة. النسخة السابقة:',
    'لم يُحدد مجلد المشروع.',
    'حدد الملفات لمراجعة بصماتها الحالية والاحتياطية.'
  ]
} as const

/** Files-only recovery; deliberately separate from conversation rewind. */
export function ProjectBackupsPanel() {
  const { locale } = useI18n()
  const c = labels[locale] ?? labels.en
  const projects = useStore($projects)
  const active = useStore($activeProjectId)
  const profile = useStore($activeGatewayProfile)
  const [project, setProject] = useState(active ?? '')
  const [backups, setBackups] = useState<ProjectBackupSummary[] | null>(null)
  const [snapshot, setSnapshot] = useState('')
  const [page, setPage] = useState<ProjectBackupPage | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<ProjectBackupPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setProject(active ?? '')
    setBackups(null)
    setPage(null)
    setPreview(null)
    setSelected([])
    setSnapshot('')
    setMessage('')
    setBusy(false)
  }, [active, profile])
  useEffect(
    () => () => {
      generation.current++
    },
    []
  )

  const run = async (action: () => Promise<void>) => {
    if (busy) {return}
    setBusy(true)
    setMessage('')
    const current = generation.current

    try {
      await action()
    } catch (error) {
      if (generation.current === current) {setMessage(error instanceof Error ? error.message : String(error))}
    } finally {
      if (generation.current === current) {setBusy(false)}
    }
  }

  const guard = (current: number) => generation.current === current

  const load = () => {
    const current = generation.current

    return run(async () => {
      const result = await listProjectBackups(project)

      if (guard(current)) {
        setBackups(result.backups)
        setSnapshot('')
        setPage(null)
        setPreview(null)
        setSelected([])
      }
    })
  }

  const files = (offset = 0) => {
    const current = generation.current

    return run(async () => {
      const result = await projectBackupFiles(project, snapshot, offset)

      if (guard(current))
        {setPage(previous => (offset ? { ...result, files: [...(previous?.files ?? []), ...result.files] } : result))}
    })
  }

  return (
    <section className="grid gap-3 border-t border-border/50 pt-4">
      <h3 className="font-medium">{c[0]}</h3>
      <p className="text-xs text-(--ui-text-secondary)">{c[9]}</p>
      <label className="grid gap-1 text-sm">
        {c[1]}
        <select
          className="rounded-lg border border-border bg-background p-2"
          disabled={busy}
          onChange={event => {
            generation.current++
            setProject(event.target.value)
            setBackups(null)
            setSnapshot('')
            setPage(null)
            setPreview(null)
            setSelected([])
            setMessage('')
          }}
          value={project}
        >
          <option value="">{c[12]}</option>
          {projects
            .filter(item => item.primary_path)
            .map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      <Button disabled={busy || !project} onClick={() => void load()} size="sm" variant="secondary">
        {c[2]}
      </Button>
      {backups?.length === 0 && <p role="status">{c[4]}</p>}
      {Boolean(backups?.length) && (
        <>
          <label className="grid gap-1 text-sm">
            {c[3]}
            <select
              className="rounded-lg border border-border bg-background p-2"
              disabled={busy}
              onChange={event => {
                setSnapshot(event.target.value)
                setPage(null)
                setSelected([])
                setPreview(null)
                setMessage('')
              }}
              value={snapshot}
            >
              <option value="">{c[3]}</option>
              {backups!.map(item => (
                <option key={item.id} value={item.id}>
                  {new Date(item.created_at * 1000).toLocaleString()} · {item.files} · {item.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy || !snapshot} onClick={() => void files()} size="sm" variant="secondary">
            {c[5]}
          </Button>
        </>
      )}
      {snapshot && (
        <p className="break-all text-xs text-(--ui-text-secondary)" dir="ltr">
          {backups?.find(item => item.id === snapshot)?.retained_directory}
        </p>
      )}
      {page && (
        <>
          <div className="max-h-44 overflow-y-auto rounded-lg border border-border p-2">
            {page.files.map(file => (
              <label className="flex items-center gap-2 break-all py-1 text-sm" key={file.path}>
                <input
                  checked={selected.includes(file.path)}
                  disabled={busy}
                  onChange={event => {
                    setPreview(null)
                    setSelected(previous =>
                      event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path)
                    )
                  }}
                  type="checkbox"
                />
                <span dir="auto">{file.path}</span>
              </label>
            ))}
          </div>
          {page.next_offset !== null && (
            <Button disabled={busy} onClick={() => void files(page.next_offset!)} size="sm" variant="ghost">
              {c[6]}
            </Button>
          )}
          <p className="text-xs text-(--ui-text-secondary)">{c[13]}</p>
          <Button
            disabled={busy || !selected.length}
            onClick={() => {
              const current = generation.current
              void run(async () => {
                const result = await previewProjectRestore(project, snapshot, selected)

                if (guard(current)) {setPreview(result)}
              })
            }}
            size="sm"
            variant="secondary"
          >
            {c[7]}
          </Button>
        </>
      )}
      {preview && (
        <div className="grid gap-2 rounded-lg border border-border p-3">
          <div className="max-h-44 overflow-auto text-xs" dir="ltr">
            {preview.files.map(file => (
              <div className="mb-2 break-all" key={file.path}>
                <strong>{file.path}</strong>
                <pre className="whitespace-pre-wrap">
                  {file.current_sha256 ?? '∅'}
                  {' → '}
                  {file.backup_sha256}
                </pre>
              </div>
            ))}
          </div>
          <Button
            disabled={busy}
            onClick={() => {
              const current = generation.current
              const token = preview.token
              setPreview(null)
              void run(async () => {
                const result = await restoreProjectFiles(project, snapshot, token)

                if (guard(current)) {
                  setMessage(
                    result.status === 'RESTORED' ? c[10] : `${c[11]} ${result.undo_receipt.id}. ${result.error ?? ''}`
                  )
                  setPage(null)
                  setSelected([])
                  setBackups(null)
                }
              })
            }}
            size="sm"
          >
            {c[8]}
          </Button>
        </div>
      )}
      {message && (
        <p className="break-words text-sm" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
