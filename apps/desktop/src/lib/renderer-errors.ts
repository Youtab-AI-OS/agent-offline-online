/** Error payloads may contain arbitrary user data, including unlabelled secrets. */
export function reportRendererError(_reason: unknown): void {
  console.error('[renderer] React error')
}

export const rendererRootErrorHandlers = {
  onCaughtError: reportRendererError,
  onUncaughtError: reportRendererError,
  onRecoverableError: reportRendererError
}

/** Async errors escape React boundaries; report only fixed codes to the console-log bridge. */
export function installRendererErrorLogging(target: Window, log = console.error): () => void {
  const onError = (event: ErrorEvent) => {
    log('[renderer] Uncaught error')
    event.preventDefault()
  }

  const onRejection = (event: PromiseRejectionEvent) => {
    log('[renderer] Unhandled rejection')
    event.preventDefault()
  }

  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)

  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
