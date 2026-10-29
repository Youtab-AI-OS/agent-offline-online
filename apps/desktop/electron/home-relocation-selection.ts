import fs from 'node:fs'
import path from 'node:path'

/** Read a bounded relocation journal from one verified file handle. */
export function readRelocationJournal(file: string): unknown | null {
  let fd: number | undefined

  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
    const opened = fs.fstatSync(fd, { bigint: true })

    if (!opened.isFile() || opened.nlink !== 1n || opened.size > 16n * 1024n * 1024n) { return null }

    const bytes = Buffer.alloc(Number(opened.size) + 1)
    let length = 0

    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null)

      if (!count) { break }
      length += count
    }

    const after = fs.fstatSync(fd, { bigint: true })
    const named = fs.lstatSync(file, { bigint: true })

    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n ||
        named.dev !== opened.dev || named.ino !== opened.ino ||
        after.dev !== opened.dev || after.ino !== opened.ino ||
        BigInt(length) !== opened.size || after.size !== opened.size || named.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs) { return null }

    return JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* A failed close cannot authorize a relocation. */ }
    }
  }
}

function key(value: string): string {
  return path.win32.normalize(value.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase()
}

/** Retarget only an inherited env value naming the recorded OLD home.
 * Unrelated explicit overrides retain priority; an incomplete publication has
 * no authority to redirect a process.
 */
export function relocatedProcessHome(processHome: string, registryHome: string, journal: any): string | null {
  if (!processHome || !registryHome || journal?.schema !== 1 ||
      journal.phase !== 'product-validated' || journal.publication?.phase !== 'published' ||
      typeof journal.source !== 'string' || typeof journal.target !== 'string' ||
      key(registryHome) !== key(journal.target)) {
    return null
  }

  const old = key(journal.source)
  const current = key(processHome)

  if (current === old) {
    return registryHome
  }

  const profilePrefix = old + '\\profiles\\'

  if (current.startsWith(profilePrefix)) {
    const profile = current.slice(profilePrefix.length)

    if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) {
      return path.win32.join(registryHome, 'profiles', profile)
    }
  }

  return null
}

/** Customer Desktop must not silently use an inherited home different from
 * the home registered by a completed common Setup transaction. */
export function boundProcessHome(processHome: string, registryHome: string, journal: unknown, customer: boolean): string {
  const relocated = relocatedProcessHome(processHome, registryHome, journal)
  if (relocated) { return relocated }
  if (customer && key(processHome) !== key(registryHome)) {
    throw new Error('YOUTAB_HOME_BINDING_CONFLICT: inherited home differs from the registered install home')
  }
  return processHome
}
