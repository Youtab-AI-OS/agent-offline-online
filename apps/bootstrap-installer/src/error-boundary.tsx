import { invoke } from '@tauri-apps/api/core'
import { Component, type ReactNode } from 'react'

interface State { failed: boolean; logsUnavailable: boolean }

// Never include the thrown object in console/IPC: it can contain credentials.
export function reportInterfaceFailure(kind: 'render' | 'async' | 'initialize'): void {
  void invoke('report_frontend_failure', { kind }).catch(() => {
    console.error('Setup diagnostic logging is unavailable.')
  })
}

// React 19 otherwise prints the raw thrown object even when a boundary catches
// it. Use static diagnostics for all root-level error callbacks as well.
export const rootErrorHandlers = {
  onCaughtError: () => reportInterfaceFailure('render'),
  onUncaughtError: () => reportInterfaceFailure('render'),
  onRecoverableError: () => reportInterfaceFailure('render')
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, logsUnavailable: false }

  static getDerivedStateFromError(): Partial<State> { return { failed: true } }

  private onAsyncFailure = (event: Event): void => {
    event.preventDefault()
    reportInterfaceFailure('async')
    this.setState({ failed: true })
  }

  componentDidMount(): void {
    window.addEventListener('error', this.onAsyncFailure)
    window.addEventListener('unhandledrejection', this.onAsyncFailure)
  }

  componentWillUnmount(): void {
    window.removeEventListener('error', this.onAsyncFailure)
    window.removeEventListener('unhandledrejection', this.onAsyncFailure)
  }

  private openLogs = (): void => {
    void invoke('open_log_dir').catch(() => this.setState({ logsUnavailable: true }))
  }

  render(): ReactNode {
    if (!this.state.failed) { return this.props.children }

    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center" role="alert">
        <h1>Setup interface failed</h1>
        <p>Installation or update may still be running. Keep this window open and check the logs before restarting Setup.</p>
        <button onClick={this.openLogs} type="button">Open logs</button>
        {this.state.logsUnavailable && <p>The log folder could not be opened.</p>}
      </main>
    )
  }
}
