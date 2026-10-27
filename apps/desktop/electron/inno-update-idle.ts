import { randomUUID } from 'node:crypto'

interface IdleSocket {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}
interface IdleOptions {
  createSocket?: (url: string) => IdleSocket
  timeoutMs?: number
}

function localGateway(value: string): string {
  const url = new URL(value)

  if (
    url.protocol !== 'ws:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/api/ws' ||
    [...url.searchParams.keys()].some((key) => key !== 'token') ||
    url.searchParams.getAll('token').length !== 1 ||
    !url.searchParams.get('token')
  )
    {throw new Error('Update idle checks require an owned loopback gateway.')}

  return url.href
}

/** Queries the existing authenticated live-session RPC; never resumes/changes a session. */
export async function assertInnoBackendsIdle(connections: readonly string[], options: IdleOptions = {}): Promise<void> {
  if (connections.length > 64) {throw new Error('Too many local backends to safely admit this update.')}
  const urls = [...new Set(connections.map(localGateway))]
  const timeoutMs = options.timeoutMs ?? 10000

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    {throw new Error('Invalid update idle timeout.')}

  const createSocket = options.createSocket ?? ((url) => new globalThis.WebSocket(url))
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve, reject) => {
          let socket: IdleSocket
          let settled = false
          const id = `update-idle-${randomUUID()}`

          const finish = (error?: Error) => {
            if (settled) {return}
            settled = true
            clearTimeout(timer)
            socket?.removeEventListener('open', open)
            socket?.removeEventListener('message', message)
            socket?.removeEventListener('error', failed)
            socket?.removeEventListener('close', failed)

            try {
              socket?.close()
            } catch {
              /* The admission already failed; only this probe socket is closed. */
            }

            if (error) {reject(error)}
            else {resolve()}
          }

          const open = () => {
            try {
              socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'session.active_list', params: {} }))
            } catch {
              finish(new Error('The local live-session check could not be sent.'))
            }
          }

          const message = (event: unknown) => {
            try {
              const data = event && typeof event === 'object' ? (event as { data?: unknown }).data : null

              if (typeof data !== 'string' || data.length > 2 * 1024 * 1024) {throw new Error()}
              const response: unknown = JSON.parse(data)

              if (!response || typeof response !== 'object' || Array.isArray(response)) {throw new Error()}
              const frame = response as Record<string, unknown>

              if (frame.id !== id) {return} // Existing gateway notifications do not acknowledge this RPC.

              if (
                frame.jsonrpc !== '2.0' ||
                frame.error ||
                !frame.result ||
                typeof frame.result !== 'object' ||
                Array.isArray(frame.result)
              )
                {throw new Error()}

              const sessions = (frame.result as { sessions?: unknown }).sessions

              if (!Array.isArray(sessions) || sessions.length > 10000) {throw new Error()}

              if (
                sessions.some(
                  (session) =>
                    !session ||
                    typeof session !== 'object' ||
                    Array.isArray(session) ||
                    typeof session.id !== 'string' ||
                    session.status !== 'idle'
                )
              ) {
                finish(
                  new Error(
                    'A local session is running, waiting, starting, or cannot be verified. Finish it before updating.'
                  )
                )

                return
              }

              finish()
            } catch {
              finish(new Error('The local live-session response could not prove that this backend is idle.'))
            }
          }

          const failed = () => finish(new Error('The owned local backend could not confirm an idle session state.'))

          const timer = setTimeout(
            () => finish(new Error('The local live-session check timed out. Update was not admitted.')),
            timeoutMs
          )

          try {
            socket = createSocket(url)
            socket.addEventListener('open', open)
            socket.addEventListener('message', message)
            socket.addEventListener('error', failed)
            socket.addEventListener('close', failed)
          } catch {
            failed()
          }
        })
    )
  )
}
