/** Retain the newest diagnostics after an append failure without unbounded RAM. */
export function recoverDesktopLog(failed: string, pending: string, limit: number): string {
  const message = '[youtab] [logging] Previous log append failed; older records may be truncated.\n'
  const combined = failed + pending

  const retained = Math.max(0, limit - message.length)

  return (message + combined.slice(combined.length - retained)).slice(0, limit)
}

/** Take the buffer only when this batch reaches the serialized writer. */
export async function flushDesktopLogBatch(
  take: () => string,
  append: (chunk: string) => Promise<void>,
  restore: (chunk: string) => void
): Promise<void> {
  const chunk = take()

  if (!chunk) { return }

  try {
    await append(chunk)
  } catch {
    restore(chunk)
  }
}
