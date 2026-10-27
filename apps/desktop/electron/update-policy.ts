import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface DesktopUpdatePolicyValue {
  enabled: boolean
  automaticChecks: boolean
}

export const DEFAULT_UPDATE_POLICY: Readonly<DesktopUpdatePolicyValue> = Object.freeze({
  enabled: false,
  automaticChecks: false
})

/** Common Inno has no Setup channel selector; retain the user's valid choice across payload replacements. */
export function selectedInnoUpdateChannel(document: unknown, fallback: 'pilot' | 'stable'): 'pilot' | 'stable' {
  const stored = document && typeof document === 'object' && !Array.isArray(document)
    ? (document as Record<string, unknown>).channel
    : undefined

  return stored === 'pilot' || stored === 'stable' ? stored : fallback
}

const MAX_CONFIG_BYTES = 64 * 1024

export function validateDesktopUpdatePolicy(value: unknown): DesktopUpdatePolicyValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('Invalid update policy.')}
  const record = value as Record<string, unknown>

  if (
    Object.keys(record).length !== 2 ||
    !Object.keys(record).every((key) => key === 'enabled' || key === 'automaticChecks') ||
    typeof record.enabled !== 'boolean' ||
    typeof record.automaticChecks !== 'boolean'
  ) {
    throw new Error('Update policy requires exactly two boolean flags.')
  }

  return { enabled: record.enabled, automaticChecks: record.automaticChecks }
}

function safeConfigPath(configPath: string): string {
  if (!path.isAbsolute(configPath) || path.basename(configPath) !== 'updates.json' || Array.from(configPath).some(character => character.charCodeAt(0) <= 31)) {
    throw new Error('Invalid update preference path.')
  }

  const target = path.resolve(configPath)

  if (path.dirname(target) === path.parse(target).root)
    {throw new Error('Update preferences require a private application directory.')}

  return target
}

function safeDirectory(directory: string, create: boolean): void {
  const parent = path.dirname(directory)

  if (parent !== directory) {safeDirectory(parent, create)}
  let stat: fs.Stats

  try {
    stat = fs.lstatSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error}

    if (!create) {return}
    fs.mkdirSync(directory, { mode: 0o700 })
    stat = fs.lstatSync(directory)
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {throw new Error('Update preference directory is unsafe.')}
}

function readDocument(target: string): { document: Record<string, unknown>; text: string | null } {
  safeDirectory(path.dirname(target), false)
  let stat: fs.Stats

  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return { document: {}, text: null }}
    throw error
  }

  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CONFIG_BYTES)
    {throw new Error('Update preferences are not a bounded regular file.')}

  const bytes = fs.readFileSync(target)

  if (bytes.length > MAX_CONFIG_BYTES) {throw new Error('Update preferences exceed their size limit.')}
  const text = bytes.toString('utf8')
  const parsed: unknown = JSON.parse(text)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    {throw new Error('Invalid update preference document.')}

  return { document: parsed as Record<string, unknown>, text }
}

export function readDesktopUpdatePolicy(configPath: string): DesktopUpdatePolicyValue {
  const { document } = readDocument(safeConfigPath(configPath))

  return document.updatePolicy === undefined
    ? { ...DEFAULT_UPDATE_POLICY }
    : validateDesktopUpdatePolicy(document.updatePolicy)
}

/** Synchronous in Electron's main process: preserves the whole existing document.
 * No cached copy or localStorage mirror owns the update permission.
 */
export function writeDesktopUpdatePolicy(configPath: string, value: unknown): DesktopUpdatePolicyValue {
  const policy = validateDesktopUpdatePolicy(value)
  const target = safeConfigPath(configPath)
  safeDirectory(path.dirname(target), true)
  const before = readDocument(target)
  const content = JSON.stringify({ ...before.document, updatePolicy: policy }, null, 2) + '\n'

  if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) {throw new Error('Update preferences exceed their size limit.')}
  const temporary = `${target}.policy-${randomUUID()}.tmp`
  let descriptor: number | undefined
  let cleanupFailure: unknown

  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    const identity = fs.fstatSync(descriptor)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    safeDirectory(path.dirname(target), false)

    if (readDocument(target).text !== before.text)
      {throw new Error('Update preferences changed while saving. Try again.')}

    const staged = fs.lstatSync(temporary)

    if (
      !staged.isFile() ||
      staged.isSymbolicLink() ||
      staged.dev !== identity.dev ||
      staged.ino !== identity.ino ||
      fs.readFileSync(temporary, 'utf8') !== content
    ) {
      throw new Error('Staged update preferences changed while saving.')
    }

    fs.renameSync(temporary, target)
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch (error) { cleanupFailure = error }
    }

    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {cleanupFailure ??= error}
    }
  }

  if (cleanupFailure !== undefined) {throw cleanupFailure}

  return policy
}
