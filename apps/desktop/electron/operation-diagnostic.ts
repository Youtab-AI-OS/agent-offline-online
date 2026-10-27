import { randomUUID } from 'node:crypto'

import { redactDiagnostic } from '../src/lib/diagnostic-redaction'

export const OPERATION_ENV = 'YOUTAB_AGENT_DIAGNOSTIC_OPERATION_ID'

/** Diagnostic-only correlation; never a capability, lock or task identity. */
export function validOperationId(value: unknown): string | null {
  return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value : null
}

export function createOperationId(inherited?: unknown): string {
  return validOperationId(inherited) ?? randomUUID()
}

export function updateDiagnostic(operationId: string, stage: string, message: string, environment = process.env) {
  return {
    schema_version: 'youtab.diagnostic.v1' as const,
    code: stage === 'error' ? 'UPDATE_FAILED' : 'UPDATE_PROGRESS',
    component: 'desktop-update',
    stage: /^[a-z0-9-]{1,64}$(?![\s\S])/.test(stage) ? stage : 'unknown',
    retryable: false,
    safe_message: redactDiagnostic(message, environment),
    operation_id: validOperationId(operationId)
  }
}


/** Presentation-only sanitization; opaque machine fields retain their values. */
export function prepareUpdateProgress(payload: Record<string, unknown>, operationId: string, at = Date.now(), environment = process.env): Record<string, unknown> & { diagnostic: ReturnType<typeof updateDiagnostic> } {
  const merged: Record<string, unknown> = { stage: 'idle', message: '', percent: null, error: null, ...payload, at }

  if (typeof merged.message === 'string') { merged.message = redactDiagnostic(merged.message, environment) }

  if (typeof merged.error === 'string') { merged.error = redactDiagnostic(merged.error, environment) }
  const stage = typeof merged.stage === 'string' ? merged.stage : 'unknown'
  const message = typeof merged.message === 'string' && merged.message.length > 0 ? merged.message : typeof merged.error === 'string' ? merged.error : ''

  return { ...merged, diagnostic: updateDiagnostic(operationId, stage, message, environment) }
}
