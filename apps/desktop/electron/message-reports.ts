/** A deliberately narrow transport to the existing authenticated support store.
 * Organization reporting needs its own tenant-scoped server contract. Until
 * that contract is integrated it fails closed and never falls back to Cloud.
 */
import { createHash } from 'node:crypto'

export const PERSONAL_REPORT_ORIGIN = 'https://api.youtab.io'
export const DESKTOP_REPORT_SUBJECT = '[Desktop report]'

function hasUnsafeOrganizationUrlCharacter(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0)

    return character === '\\' || /\s/.test(character) || code <= 31 || code === 127
  })
}

export interface MessageReportInput {
  messageId: string
  reason: string
  excerpt?: string
}

export function normalizeOrganizationAdminUrl(raw: unknown): string {
  if (raw === '') {return ''}
  if (typeof raw !== 'string' || raw.length > 2048 || hasUnsafeOrganizationUrlCharacter(raw)) {
    throw new Error('INVALID_ORGANIZATION_ADMIN_URL')
  }
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('ORGANIZATION_ADMIN_HTTPS_REQUIRED')
  }
  return url.toString()
}

export function validateMessageReport(raw: unknown): MessageReportInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {throw new Error('INVALID_MESSAGE_REPORT')}
  const input = raw as Record<string, unknown>
  if (Object.keys(input).some(key => !['messageId', 'reason', 'excerpt'].includes(key))) {
    throw new Error('INVALID_MESSAGE_REPORT_FIELD')
  }
  if (
    typeof input.messageId !== 'string' ||
    !/^[a-zA-Z0-9_.:-]{1,256}$/.test(input.messageId) ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 4000 ||
    (input.excerpt !== undefined && (typeof input.excerpt !== 'string' || input.excerpt.length > 8000))
  ) {
    throw new Error('INVALID_MESSAGE_REPORT')
  }
  return {
    messageId: input.messageId,
    reason: input.reason.trim(),
    ...(input.excerpt ? { excerpt: input.excerpt as string } : {})
  }
}

export interface ReportContext {
  profile: string
  organization: boolean
  accountId?: string
}

/** Concurrency guard, not a credential or grant of authority. */
export const reportScopeKey = (context: ReportContext) => createHash('sha256').update(JSON.stringify([context.profile, context.accountId || '', context.organization])).digest('hex')

export function createMessageReporter(deps: {
  context: () => Promise<ReportContext>
  token: (profile: string) => Promise<string>
  request: typeof fetch
}) {
  return async (raw: unknown, expectedScope?: string) => {
    const report = validateMessageReport(raw)
    const context = await deps.context()
    if (context.organization) {throw new Error('ORGANIZATION_REPORTING_NOT_INTEGRATED')}
    if (expectedScope !== undefined && expectedScope !== reportScopeKey(context)) {throw new Error('REPORT_SCOPE_CHANGED')}
    const checkScope = async () => {
      const current = await deps.context()
      if (current.organization || reportScopeKey(current) !== reportScopeKey(context)) {throw new Error('REPORT_SCOPE_CHANGED')}
    }
    const token = await deps.token(context.profile)
    if (!token) {throw new Error('REPORT_SIGN_IN_REQUIRED')}
    await checkScope()
    const response = await deps.request(`${PERSONAL_REPORT_ORIGIN}/v1/support/tickets`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: DESKTOP_REPORT_SUBJECT,
        priority: 'normal',
        message: JSON.stringify({
          schema_version: 1,
          source: 'youtab-desktop',
          message_id: report.messageId,
          reason: report.reason,
          ...(report.excerpt ? { excerpt: report.excerpt } : {})
        })
      })
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`REPORT_HTTP_${response.status}`)
    }
    const text = await readLimitedResponse(response)
    const result = JSON.parse(text) as { success?: unknown; ticket_id?: unknown }
    if (
      result?.success !== true ||
      typeof result.ticket_id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(result.ticket_id)
    )
      {throw new Error('REPORT_RECEIPT_INVALID')}
    await checkScope()
    return { reportId: result.ticket_id }
  }
}

async function readLimitedResponse(response: Response) {
  if (!response.body) {throw new Error('REPORT_RECEIPT_EMPTY')}
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {break}
      size += next.value.byteLength
      if (size > 65536) {throw new Error('REPORT_RECEIPT_TOO_LARGE')}
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf8')
}
