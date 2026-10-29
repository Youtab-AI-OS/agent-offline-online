import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { releaseWindowsMaintenanceHelper } from './windows-maintenance-helper'
import { WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS } from './windows-uninstall-gateway-processes'
import { WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS } from './windows-uninstall-resources'
export { powershellInlineInput } from './windows-powershell-input'

export interface CommonWindowsUninstallInput {
  packaged: boolean
  managedContract: boolean
  agentRoot: string
  youtabHome: string
  executable: string
  userData: string
  appData: string
  userProfile: string
  windowsDirectory: string
  desktopPid: number
}

export interface CommonWindowsUninstallPlan {
  installRoot: string
  userData: string
  uninstaller: string
  desktopPid: number
  protectedRoots: string[]
  startupDirectory: string
  aliasDirectory: string
}

export interface UninstallHandoff {
  directory: string
  token: string
}

/** A spawned process is not evidence that PowerShell accepted its preflight. */
export async function waitForUninstallReady(child: ChildProcess, handoff: UninstallHandoff, timeoutMs = 10000, marker = 'ready'): Promise<void> {
  let startupError: Error | undefined
  const onError = (error: Error) => { startupError = error }
  child.on('error', onError)
  try {
    const reason = (fallback: string) => {
      try { return fs.readFileSync(path.join(handoff.directory, 'failure.log'), 'utf8').slice(0, 1000) || fallback }
      catch { return fallback }
    }
    const until = Date.now() + timeoutMs
    do {
      if (startupError) {throw startupError}
      if (child.exitCode !== null) {throw new Error(reason('Uninstall helper exited before it was ready.'))}
      try {
        const ready = fs.readFileSync(path.join(handoff.directory, marker), 'utf8')
        if (ready === handoff.token) {return}
      } catch { /* The helper has not completed preflight yet. */ }
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < until)
    throw new Error(reason('Uninstall helper could not complete preflight. This installation was not removed.'))
  } finally {
    child.removeListener('error', onError)
  }
}

export async function cancelUninstallHelper(child: ChildProcess, handoff: UninstallHandoff, timeoutMs = 10000): Promise<boolean> {
  if (!child.pid || child.exitCode !== null) {return true}
  try { fs.writeFileSync(path.join(handoff.directory, 'cancel'), handoff.token, {encoding:'utf8'}) }
  catch { /* A failed preflight may already have closed its handoff. */ }
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); child.removeListener('error', done); resolve() }
    const timer = setTimeout(done, timeoutMs)
    child.once('exit', done)
    child.once('error', done)
    if (child.exitCode !== null) {done()}
  })
  if (child.exitCode !== null) {return true}
  let preflightCompleted = false
  try { preflightCompleted = fs.readFileSync(path.join(handoff.directory, 'ready'), 'utf8') === handoff.token } catch { /* No native effects started. */ }
  // A ready helper may be restoring suspended service state. Never terminate
  // it midway through that rollback; cancellation prevents the removal phase.
  if (preflightCompleted) {
    try {await releaseWindowsMaintenanceHelper(child)} catch {return false}
    child.unref()
  }
  else {child.kill()}
  return false
}

const windows = path.win32
const normalized = (value: string) => windows.resolve(value).replace(/[\\/]+$/, '').toLowerCase()

function hasUnsafeWindowsPathCharacter(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) <= 31 || character === '"' || character === ';')
}

function localAbsolute(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) && !hasUnsafeWindowsPathCharacter(value) && !value.slice(2).includes(':')
}

/** Only the known common-Setup layout can select this destructive path. */
export function commonWindowsUninstallPlan(input: CommonWindowsUninstallInput): CommonWindowsUninstallPlan {
  if (!input.packaged || !input.managedContract) {throw new Error('A verified common Setup installation is required.')}
  const values = [input.agentRoot, input.youtabHome, input.executable, input.userData, input.appData, input.userProfile, input.windowsDirectory]
  if (!values.every(localAbsolute)) {throw new Error('Uninstall paths must be absolute local Windows paths.')}
  if (!Number.isSafeInteger(input.desktopPid) || input.desktopPid <= 0) {throw new Error('Invalid Desktop process identity.')}
  const installRoot = windows.dirname(windows.resolve(input.agentRoot))
  if (normalized(input.agentRoot) !== normalized(windows.join(installRoot, 'youtab-agent-runtime')) || normalized(input.youtabHome) !== normalized(installRoot)) {
    throw new Error('Runtime and data home do not belong to the same Setup installation.')
  }
  const expectedExe = windows.join(input.agentRoot, 'apps', 'desktop', 'release', 'win-unpacked', 'Youtab.exe')
  if (normalized(input.executable) !== normalized(expectedExe)) {throw new Error('Desktop executable is outside the common Setup layout.')}
  const protectedRoots = [windows.parse(installRoot).root, input.userProfile, input.appData, input.windowsDirectory,
    windows.join(windows.parse(installRoot).root, 'Users'), windows.join(windows.parse(installRoot).root, 'Program Files'),
    windows.join(windows.parse(installRoot).root, 'Program Files (x86)'), windows.join(windows.parse(installRoot).root, 'ProgramData'),
    windows.join(input.windowsDirectory, 'System32'), windows.join(input.userProfile, 'Desktop'),
    windows.join(input.userProfile, 'Documents'), windows.join(input.userProfile, 'Downloads'),
    windows.join(input.userProfile, 'AppData'), windows.join(input.userProfile, 'AppData', 'Local')]
  if (protectedRoots.some(root => normalized(root) === normalized(installRoot) ||
    normalized(root).startsWith(normalized(installRoot) + '\\')) ||
    normalized(installRoot).startsWith(normalized(input.windowsDirectory) + '\\')) {
    throw new Error('Refusing to remove a shared or system directory.')
  }
  const userData = windows.resolve(input.userData)
  const relative = windows.relative(installRoot, userData)
  const internalUserData = relative !== '' && !relative.startsWith('..') && !windows.isAbsolute(relative)
  const standardUserData = normalized(userData) === normalized(windows.join(input.appData, 'Youtab'))
  if (!internalUserData && !standardUserData) {throw new Error('Custom Desktop data is outside the verified Youtab removal scope.')}
  return {installRoot, userData, uninstaller: windows.join(installRoot, 'unins000.exe'), desktopPid: input.desktopPid, protectedRoots,
    startupDirectory: windows.join(input.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    aliasDirectory: windows.join(input.userProfile, '.local', 'bin')}
}

// Use native PowerShell/.NET after the app and registered uninstaller exit.
// No system Python, package installation, wildcard PATH deletion or cmd.exe
// recursive deletion is involved. Reparse entries are unlinked, never followed.
export const WINDOWS_OWNED_TREE_FUNCTIONS = String.raw`
$separators = [char[]]@([char]92, [char]47)
function Assert-YoutabUninstallNotCancelled($handoff) {
  $cancel = [IO.Path]::Combine($handoff.directory, 'cancel')
  if ((Test-Path -LiteralPath $cancel) -and ([IO.File]::ReadAllText($cancel) -eq $handoff.token)) {
    throw 'Uninstall handoff cancelled; no installation data was removed.'
  }
}
function Get-YoutabUninstallEnvironment {
  $environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
  $registryHome = ''; $userPath = ''; $machinePath = ''
  try {
    if ($environment) {
      $registryHome = [string]$environment.GetValue('YOUTAB_AGENT_HOME', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $userPath = [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
    if ($machine) { $machinePath = [string]$machine.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    return @{ Home=$registryHome; Path=($machinePath + ';' + $userPath) }
  } finally {
    if ($environment) { $environment.Dispose() }
    if ($machine) { $machine.Dispose() }
  }
}
function Assert-YoutabUninstallRegistration([string]$InstallRoot, [string]$Uninstaller, [string]$RegisteredLocation, [string]$RegisteredCommand) {
  if (-not $RegisteredLocation -or -not $RegisteredCommand) { throw 'The current Setup uninstall registration is missing.' }
  if (-not ([IO.Path]::GetFullPath($RegisteredLocation).TrimEnd($separators).Equals(
    [IO.Path]::GetFullPath($InstallRoot).TrimEnd($separators), [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Registered uninstall location does not match this installation.'
  }
  $command = $RegisteredCommand.Trim()
  if (-not ($command.Equals($Uninstaller, [StringComparison]::OrdinalIgnoreCase) -or
    $command.Equals(('"' + $Uninstaller + '"'), [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Registered uninstall command does not match this installation.'
  }
}
function Assert-NoReparseAncestors([string]$Target) {
  $current = [System.IO.Path]::GetFullPath($Target)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Uninstall root has a reparse ancestor.' }
    }
    $parent = [IO.Directory]::GetParent($current)
    if ($parent) { $parent = $parent.FullName }
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
}
function Remove-YoutabOwnedTree([string]$Target, [string]$Boundary) {
  $full = [IO.Path]::GetFullPath($Target).TrimEnd($separators)
  $root = [IO.Path]::GetFullPath($Boundary).TrimEnd($separators)
  if (-not ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Removal escaped its verified boundary.'
  }
  $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing a reparse uninstall root.' }
    if ($item.PSIsContainer) { [IO.Directory]::Delete($full, $false) } else { [IO.File]::Delete($full) }
    return
  }
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $full -Force -ErrorAction Stop)) {
      Remove-YoutabOwnedTree -Target $child.FullName -Boundary $root
    }
    [IO.Directory]::Delete($full, $false)
  } else {
    if (($item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { $item.IsReadOnly = $false }
    [IO.File]::Delete($full)
  }
}
`

export function buildCommonWindowsFullUninstallScript(plan: CommonWindowsUninstallPlan, handoff: UninstallHandoff): string {
  const payload = Buffer.from(JSON.stringify({...plan, handoff}), 'utf8').toString('base64')
  return String.raw`$ErrorActionPreference = 'Stop'
${WINDOWS_OWNED_TREE_FUNCTIONS}
${WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS}
${WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS}
$plan = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$diagnostic = [IO.Path]::Combine($plan.handoff.directory, 'failure.log')
$readyFile = [IO.Path]::Combine($plan.handoff.directory, 'ready')
$stoppedFile = [IO.Path]::Combine($plan.handoff.directory, 'stopped')
$resources = $null
$scheduler = $null
$gateways = @()
try {
  Set-Location -LiteralPath ([IO.Path]::GetDirectoryName($plan.handoff.directory))
  foreach ($target in @($plan.installRoot, $plan.userData)) {
    $full = [IO.Path]::GetFullPath($target).TrimEnd($separators)
    foreach ($protected in $plan.protectedRoots) {
      if ($full.Equals(([IO.Path]::GetFullPath($protected).TrimEnd($separators)), [StringComparison]::OrdinalIgnoreCase)) { throw 'Protected removal target.' }
    }
    Assert-NoReparseAncestors $target
  }
  if (-not ([IO.Path]::GetFullPath($plan.uninstaller).Equals(([IO.Path]::Combine($plan.installRoot, 'unins000.exe')), [StringComparison]::OrdinalIgnoreCase))) { throw 'Uninstaller scope mismatch.' }
  $uninstaller = Get-Item -LiteralPath $plan.uninstaller -Force -ErrorAction Stop
  if ($uninstaller.PSIsContainer -or (($uninstaller.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Invalid registered uninstaller.' }
  $registration = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\{78558650-B4B0-4B5D-854C-371DCBCE6B32}_is1')
  if (-not $registration) { throw 'The current Setup uninstall registration is missing.' }
  try {
    Assert-YoutabUninstallRegistration $plan.installRoot $plan.uninstaller ([string]$registration.GetValue('InstallLocation')) ([string]$registration.GetValue('UninstallString'))
  } finally { $registration.Dispose() }
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $binding = Get-YoutabUninstallEnvironment
  $resources = Get-YoutabOwnedUninstallResources $plan $scheduler $binding.Home $binding.Path
  $gateways = @(Get-YoutabOwnedGatewayProcesses $plan $resources.KnownHomes)
  Assert-YoutabUninstallNotCancelled $plan.handoff
  [IO.File]::WriteAllText($readyFile, [string]$plan.handoff.token)
  $binding = Get-YoutabUninstallEnvironment
  Assert-YoutabOwnedUninstallResources $resources $scheduler $binding.Home $binding.Path
  Suspend-YoutabOwnedUninstallTasks $resources $scheduler
  Stop-YoutabOwnedGatewayProcesses $gateways $plan $plan.handoff
  Assert-YoutabUninstallNotCancelled $plan.handoff
  [IO.File]::WriteAllText($stoppedFile, [string]$plan.handoff.token)
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Assert-YoutabUninstallNotCancelled $plan.handoff
    if (-not (Get-Process -Id $plan.desktopPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $plan.desktopPid -ErrorAction SilentlyContinue) { throw 'Desktop did not exit; no removal started.' }
  Assert-YoutabUninstallNotCancelled $plan.handoff
  $binding = Get-YoutabUninstallEnvironment
  Assert-YoutabOwnedUninstallResources $resources $scheduler $binding.Home $binding.Path
  Remove-YoutabOwnedGatewayStopMarkers $gateways $plan.handoff
  Remove-YoutabOwnedUninstallResources $resources $scheduler
  $removed = Start-Process -FilePath $plan.uninstaller -ArgumentList @('/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES') -WindowStyle Hidden -Wait -PassThru
  if ($removed.ExitCode -notin @(0, 3010)) { throw ('Registered uninstall failed: ' + $removed.ExitCode) }
  foreach ($target in @($plan.installRoot, $plan.userData) | Select-Object -Unique) {
    Assert-NoReparseAncestors $target
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      try { Remove-YoutabOwnedTree -Target $target -Boundary $target; break }
      catch { if ($attempt -eq 9) { throw }; Start-Sleep -Milliseconds 500 }
    }
    if (Test-Path -LiteralPath $target) { throw 'Owned data remains after uninstall.' }
  }
  $environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if ($environment) {
    try {
      $owned = @{YOUTAB_AGENT_HOME=$plan.installRoot; YOUTAB_AGENT_GIT_BASH_PATH=([IO.Path]::Combine($plan.installRoot, 'git\bin\bash.exe'))}
      foreach ($name in $owned.Keys) {
        $value = [string]$environment.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($value.TrimEnd($separators).Equals(([string]$owned[$name]).TrimEnd($separators), [StringComparison]::OrdinalIgnoreCase)) { $environment.DeleteValue($name, $false) }
      }
    } finally { $environment.Dispose() }
  }
  if (Test-Path -LiteralPath $diagnostic) { [IO.File]::Delete($diagnostic) }
  [IO.File]::Delete($readyFile)
  [IO.File]::Delete($stoppedFile)
  [IO.File]::Delete([IO.Path]::Combine($plan.handoff.directory, 'cancel'))
  [IO.Directory]::Delete($plan.handoff.directory, $false)
  exit 0
} catch {
  $failure = $_.Exception.Message
  try { Remove-YoutabOwnedGatewayStopMarkers $gateways $plan.handoff } catch { $failure += '; marker cleanup: ' + $_.Exception.Message }
  if ($resources -and $scheduler) {
    try { Restore-YoutabOwnedUninstallTasks $resources $scheduler } catch { $failure += '; task restoration: ' + $_.Exception.Message }
  }
  [IO.File]::WriteAllText($diagnostic, ('Youtab full uninstall did not complete: ' + $failure))
  exit 1
} finally {
  if ($scheduler) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($scheduler) }
}
`
}
