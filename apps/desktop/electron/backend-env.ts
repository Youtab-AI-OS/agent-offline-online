import path from 'node:path'

// Match the POSIX fallback surface used by the Python terminal environment.
// macOS apps launched from Finder/Dock often inherit only /usr/bin:/bin:/usr/sbin:/sbin,
// which misses Apple Silicon Homebrew and user-installed CLI tools such as codex.
const POSIX_SANE_PATH_ENTRIES = Object.freeze([
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin'
])

function delimiterForPlatform(platform = process.platform) {
  return platform === 'win32' ? ';' : ':'
}

function pathModuleForPlatform(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function pathEnvKey(env = process.env, platform = process.platform) {
  if (platform !== 'win32') {
    return 'PATH'
  }

  return Object.keys(env || {}).find(key => key.toUpperCase() === 'PATH') || 'PATH'
}

function currentPathValue(env = process.env, platform = process.platform) {
  const key = pathEnvKey(env, platform)

  return env?.[key] || ''
}

function appendUniquePathEntries(entries, { delimiter = path.delimiter } = {}) {
  const seen = new Set()
  const ordered = []

  for (const entry of entries) {
    if (!entry) {
      continue
    }

    const parts = Array.isArray(entry) ? entry : String(entry).split(delimiter)

    for (const part of parts) {
      if (!part || seen.has(part)) {
        continue
      }

      seen.add(part)
      ordered.push(part)
    }
  }

  return ordered.join(delimiter)
}

function buildDesktopBackendPath({
  youtabHome,
  venvRoot,
  currentPath = '',
  platform = process.platform,
  pathModule = pathModuleForPlatform(platform)
}: any = {}) {
  const delimiter = delimiterForPlatform(platform)
  const youtabNodeBin = youtabHome ? pathModule.join(youtabHome, 'node', 'bin') : null
  const venvBin = venvRoot ? pathModule.join(venvRoot, platform === 'win32' ? 'Scripts' : 'bin') : null
  const saneEntries = platform === 'win32' ? [] : POSIX_SANE_PATH_ENTRIES

  return appendUniquePathEntries([youtabNodeBin, venvBin, currentPath, saneEntries], { delimiter })
}

function normalizeYoutabHomeRoot(youtabHome, { pathModule = pathModuleForPlatform(process.platform) }: any = {}) {
  if (!youtabHome) {
    return youtabHome
  }

  const resolved = pathModule.resolve(String(youtabHome))
  const parent = pathModule.dirname(resolved)

  if (pathModule.basename(parent).toLowerCase() === 'profiles') {
    return pathModule.dirname(parent)
  }

  return resolved
}

// Only the validated packaged-runtime caller supplies this descriptor.
// Profile HOME remains independent of the program/dependency location.
function commonRuntimeTuiEnv(admittedCommonRuntime, platform, pathModule) {
  if (!admittedCommonRuntime) {return {}}

  if (platform !== 'win32' || typeof admittedCommonRuntime.fileExists !== 'function') {
    throw new Error('Invalid admitted common Runtime context.')
  }

  const runtimeRoot = pathModule.resolve(admittedCommonRuntime.root)
  const node = pathModule.join(pathModule.dirname(runtimeRoot), 'node', 'node.exe')
  const tui = pathModule.join(runtimeRoot, 'ui-tui')

  if (!admittedCommonRuntime.fileExists(node)
    || !admittedCommonRuntime.fileExists(pathModule.join(tui, 'dist', 'entry.js'))) {
    throw new Error('Bundled Node or terminal UI is missing. Use Repair install to restore Youtab.')
  }

  return {
    YOUTAB_AGENT_NODE: node,
    YOUTAB_AGENT_TUI_DIR: tui,
    YOUTAB_AGENT_SKIP_NODE_BOOTSTRAP: '1'
  }
}

function buildDesktopBackendEnv({
  youtabHome,
  pythonPathEntries = [],
  venvRoot,
  currentEnv = process.env,
  admittedCommonRuntime = null,
  platform = process.platform,
  pathModule = pathModuleForPlatform(platform)
}: any = {}) {
  const delimiter = delimiterForPlatform(platform)
  const currentPythonPath = currentEnv?.PYTHONPATH || ''
  const key = pathEnvKey(currentEnv, platform)
  const tuiEnv = commonRuntimeTuiEnv(admittedCommonRuntime, platform, pathModule)

  return {
    ...tuiEnv,
    PYTHONPATH: appendUniquePathEntries([...pythonPathEntries, currentPythonPath], { delimiter }),
    // Force PEP 540 UTF-8 mode in the spawned Python backend so its stdio and
    // subprocess defaults are UTF-8 even on non-UTF-8 Windows locales (GBK,
    // cp1252, ...). youtab_bootstrap sets this inside the child too, but only
    // after import — anything emitted earlier (interpreter startup errors,
    // pre-bootstrap tracebacks) still decodes with the locale default without
    // this. User's explicit setting wins. Re-port of PR #56499 (echoriver89).
    PYTHONUTF8: currentEnv?.PYTHONUTF8 ?? '1',
    [key]: appendUniquePathEntries([
      tuiEnv.YOUTAB_AGENT_NODE ? pathModule.dirname(tuiEnv.YOUTAB_AGENT_NODE) : null,
      buildDesktopBackendPath({
        youtabHome,
        venvRoot,
        currentPath: currentPathValue(currentEnv, platform),
        platform,
        pathModule
      })
    ], { delimiter })
  }
}

export {
  appendUniquePathEntries,
  buildDesktopBackendEnv,
  buildDesktopBackendPath,
  delimiterForPlatform,
  normalizeYoutabHomeRoot,
  pathEnvKey,
  POSIX_SANE_PATH_ENTRIES
}
