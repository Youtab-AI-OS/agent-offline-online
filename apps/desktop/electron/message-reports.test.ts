import { describe, expect, it, vi } from 'vitest'

import {
  createMessageReporter,
  normalizeOrganizationAdminUrl,
  PERSONAL_REPORT_ORIGIN,
  validateMessageReport
} from './message-reports'

const input = { messageId: 'message-123', reason: 'The answer is incorrect' }
function reporter(overrides: Partial<Parameters<typeof createMessageReporter>[0]> = {}) {
  const deps = {
    context: vi.fn(async () => ({ profile: 'default', organization: false })),
    token: vi.fn(async () => 'synthetic-account-token'),
    request: vi.fn(
      async () => new Response(JSON.stringify({ success: true, ticket_id: 'ticket-123' }), { status: 200 })
    ),
    ...overrides
  }
  return { deps, submit: createMessageReporter(deps as Parameters<typeof createMessageReporter>[0]) }
}
describe('message report delivery boundary', () => {
  it('posts only the explicit report to the existing authenticated ticket route and returns its stored receipt', async () => {
    const { deps, submit } = reporter()
    expect(await submit(input)).toEqual({ reportId: 'ticket-123' })
    const [url, options] = vi.mocked(deps.request).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${PERSONAL_REPORT_ORIGIN}/v1/support/tickets`)
    expect(options.method).toBe('POST')
    expect(options.redirect).toBe('error')
    expect(options.headers).toEqual({
      Authorization: 'Bearer synthetic-account-token',
      'Content-Type': 'application/json'
    })
    const ticket = JSON.parse(String(options.body))
    expect(ticket.user_id).toBeUndefined()
    expect(JSON.parse(ticket.message)).toEqual({
      schema_version: 1,
      source: 'youtab-desktop',
      message_id: 'message-123',
      reason: input.reason
    })
  })
  it('includes only an explicitly supplied excerpt', async () => {
    const { deps, submit } = reporter()
    await submit({ ...input, excerpt: 'انتخاب کاربر' })
    const [, options] = vi.mocked(deps.request).mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(JSON.parse(String(options.body)).message).excerpt).toBe('انتخاب کاربر')
  })
  it('never reads Cloud credentials or sends to Cloud in organization mode', async () => {
    const { deps, submit } = reporter({ context: async () => ({ profile: 'employee', organization: true }) })
    await expect(submit(input)).rejects.toThrow('ORGANIZATION_REPORTING_NOT_INTEGRATED')
    expect(deps.token).not.toHaveBeenCalled()
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('rejects a profile switch during credential refresh before posting', async () => {
    let profile = 'first'
    const { deps, submit } = reporter({
      context: async () => ({ profile, organization: false }),
      token: async () => {
        profile = 'second'
        return 'synthetic'
      }
    })
    await expect(submit(input)).rejects.toThrow('REPORT_SCOPE_CHANGED')
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('rejects an account switch inside the same profile before posting', async () => {
    let accountId = 'first-account'
    const { deps, submit } = reporter({
      context: async () => ({profile:'default',organization:false,accountId}),
      token: async () => { accountId = 'second-account'; return 'synthetic' }
    })
    await expect(submit(input)).rejects.toThrow('REPORT_SCOPE_CHANGED')
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('rejects stale consent scope from an already opened dialog', async () => {
    const { deps, submit } = reporter()
    await expect(submit(input, 'old-scope')).rejects.toThrow('REPORT_SCOPE_CHANGED')
    expect(deps.token).not.toHaveBeenCalled()
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('does not invent success on a missing credential, HTTP denial or invalid receipt', async () => {
    await expect(reporter({ token: async () => '' }).submit(input)).rejects.toThrow('REPORT_SIGN_IN_REQUIRED')
    for (const response of [new Response('', { status: 403 }), new Response('{}'), new Response('{"success":true}')]) {
      await expect(reporter({ request: vi.fn(async () => response) }).submit(input)).rejects.toThrow()
    }
  })
  it('rejects client-supplied identity, target URLs and oversized content', () => {
    for (const bad of [
      { ...input, user_id: 'owner' },
      { ...input, target: 'https://elsewhere.invalid' },
      { ...input, reason: '' },
      { ...input, excerpt: 'x'.repeat(8001) }
    ]) {
      expect(() => validateMessageReport(bad)).toThrow()
    }
  })
})
describe('Organization Admin navigation address', () => {
  it('accepts an internal HTTPS panel without granting or carrying credentials', () => {
    expect(normalizeOrganizationAdminUrl('https://admin.organization.invalid/admin/')).toBe(
      'https://admin.organization.invalid/admin/'
    )
    expect(normalizeOrganizationAdminUrl('')).toBe('')
  })
  it('rejects insecure schemes, credentials, query tokens, fragments and URL ambiguity', () => {
    for (const url of [
      'http://intranet/admin',
      'file:///C:/admin.html',
      'javascript:alert(1)',
      'https://user:secret@org.invalid/',
      'https://org.invalid/?token=x',
      'https://org.invalid/#token',
      'https://org.invalid/\nadmin',
      'https://org.invalid\\other'
    ])
      {expect(() => normalizeOrganizationAdminUrl(url)).toThrow()}
  })
})
