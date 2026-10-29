/** Windows Setup identity proof held until the native child has exited. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire as nodeCreateRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export interface SetupLease { close(): void }
export interface SetupLeasePin {
  protocol: 1
  format: 'pe'
  arch: 'x64'
  napi: 'youtab.setup-lease/napi-v1'
  sha256: string
  size: number
}

type NativeLease = {
  acquire(path: string, sha256: string, size: number): unknown
  release(lease: unknown): void
  protocol(): string
}

export function acquireSetupLease(executable: string, sha256: string, size: number, pin: SetupLeasePin): SetupLease {
  if (process.platform !== 'win32' || process.arch !== 'x64'
    || !pin || pin.protocol !== 1 || pin.format !== 'pe' || pin.arch !== 'x64'
    || pin.napi !== 'youtab.setup-lease/napi-v1'
    || !/^[0-9a-f]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.size) || pin.size < 1024) {
    throw new Error('SETUP_LEASE_UNAVAILABLE')
  }

  const modulePath = fileURLToPath(new URL('./native/setup_lease.node', import.meta.url))
    .replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')

  const bytes = fs.readFileSync(modulePath)

  if (bytes.length !== pin.size || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    throw new Error('SETUP_LEASE_UNAVAILABLE')
  }

  const native = nodeCreateRequire(import.meta.url)(modulePath) as NativeLease

  if (typeof native.acquire !== 'function' || typeof native.release !== 'function'
    || typeof native.protocol !== 'function' || native.protocol() !== pin.napi) {
    throw new Error('SETUP_LEASE_UNAVAILABLE')
  }

  const opaque = native.acquire(executable, sha256, size)
  let closed = false

  return { close() { if (!closed) { closed = true; native.release(opaque) } } }
}
