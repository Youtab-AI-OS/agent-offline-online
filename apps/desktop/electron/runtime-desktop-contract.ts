import crypto from 'node:crypto'

const SHA40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
// Keep this identical to the release producer's accepted artifact version.
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const RUNTIME_DESKTOP_CONTRACT = 'runtime-desktop.json'

export function hasManagedRuntimeEvidence(marker: unknown, contractPresent: boolean): boolean {
  if (contractPresent) return true
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false
  return Object.hasOwn(marker, 'artifactSha256') || Object.hasOwn(marker, 'runtimeContractSha256')
}

export function routeManagedRuntimeFailure<T>(
  packagedWindowsCustomer: boolean,
  managedEvidence: boolean,
  activeUsable: boolean,
  repair: () => T,
  discoverExternal: () => T
): T {
  return packagedWindowsCustomer && managedEvidence && !activeUsable ? repair() : discoverExternal()
}

export function managedRuntimeLaunch(
  contract: ReturnType<typeof parseRuntimeDesktopContract>,
  cliUsable: boolean,
  sourceExists: boolean,
  args: string[]
): { kind: 'command' | 'python'; args: string[] } | null {
  const backendArgs = args[0] === '-m' && args[1] === 'youtab_agent_cli.main' ? args.slice(2) : args.slice()
  if (contract && cliUsable) return { kind: 'command', args: backendArgs }
  if (sourceExists) return { kind: 'python', args: ['-m', 'youtab_agent_cli.main', ...backendArgs] }
  return null
}

export function parseRuntimeDesktopContract(
  bytes: Buffer,
  marker: unknown
): { version: string; sourceSha: string; supportsServe: boolean } | null {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 4096) return null
  if (!marker || typeof marker !== 'object') return null
  const receipt = marker as Record<string, unknown>
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  if (!SHA256.test(String(receipt.artifactSha256 || '')) || receipt.runtimeContractSha256 !== hash) return null

  let contract: Record<string, unknown>
  try {
    contract = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null
  if (Object.keys(contract).sort().join(',') !== 'capabilities,entrypoint,schemaVersion,sourceSha,version') return null
  if (contract.schemaVersion !== 1 || contract.entrypoint !== 'venv/Scripts/youtab.exe') return null
  if (typeof contract.sourceSha !== 'string' || !SHA40.test(contract.sourceSha)) return null
  if (contract.sourceSha !== receipt.pinnedCommit) return null
  if (typeof contract.version !== 'string' || !VERSION.test(contract.version) || contract.version !== receipt.version) return null
  if (!Array.isArray(contract.capabilities) || contract.capabilities.length !== 1 || contract.capabilities[0] !== 'serve') return null
  return { version: contract.version, sourceSha: contract.sourceSha, supportsServe: true }
}
