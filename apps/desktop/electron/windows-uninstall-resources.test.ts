import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { WINDOWS_OWNED_TREE_FUNCTIONS } from './windows-full-uninstall'
import { WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS } from './windows-uninstall-resources'

// PRODUCER_FIXTURES_START
const producerFixtures = {
  schemaVersion: 1,
  producerSourceSha256: {
    'youtab_agent_cli/gateway_windows.py': '6fc214a60d4c08c4140852bf74f86dcbe596e6c2977b8f0e614cea814a118e0a',
    'youtab_agent_cli/profiles.py': '770e24fcdf8d6e724bd03314c97184011d5b509d44cccdf87b6bd97018c692fd'
  },
  root: 'C:\\Synthetic YoutabFixtureRoot',
  gatewayDefaultVbs:
    '\' Youtab Agent Runtime Gateway - Messaging Platform Integration\r\nOption Explicit\r\nDim sh, env, existing_pp\r\nSet sh = CreateObject("WScript.Shell")\r\nSet env = sh.Environment("PROCESS")\r\nenv.Item("YOUTAB_AGENT_HOME") = "C:\\Synthetic YoutabFixtureRoot"\r\nenv.Item("PYTHONIOENCODING") = "utf-8"\r\nenv.Item("YOUTAB_AGENT_GATEWAY_DETACHED") = "1"\r\nenv.Item("VIRTUAL_ENV") = "C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime\\venv"\r\nexisting_pp = env.Item("PYTHONPATH")\r\nIf Len(existing_pp) > 0 Then\r\n  env.Item("PYTHONPATH") = "C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime;" & existing_pp\r\nElse\r\n  env.Item("PYTHONPATH") = "C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime"\r\nEnd If\r\nsh.CurrentDirectory = "C:\\Synthetic YoutabFixtureRoot"\r\nsh.Run """C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime\\venv\\Scripts\\youtab.exe"" gateway run", 0, False\r\n',
  gatewayNamedCmd:
    '@echo off\r\nrem Youtab Agent Runtime Gateway - Messaging Platform Integration\r\ncd /d "C:\\Synthetic YoutabFixtureRoot\\profiles\\work"\r\nset "YOUTAB_AGENT_HOME=C:\\Synthetic YoutabFixtureRoot\\profiles\\work"\r\nset "PYTHONIOENCODING=utf-8"\r\nset "YOUTAB_AGENT_GATEWAY_DETACHED=1"\r\nset "VIRTUAL_ENV=C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime\\venv"\r\nset "PYTHONPATH=C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime;%PYTHONPATH%"\r\n"C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime\\venv\\Scripts\\youtab.exe" --profile work gateway run\r\nexit /b 0\r\n',
  startupDefaultVbs:
    '\' Youtab Agent Runtime Gateway - Messaging Platform Integration\r\nOption Explicit\r\nDim fso, sh, target\r\ntarget = "C:\\Synthetic YoutabFixtureRoot\\gateway-service\\Youtab_Gateway.vbs"\r\nSet fso = CreateObject("Scripting.FileSystemObject")\r\nIf Not fso.FileExists(target) Then WScript.Quit 0\r\nSet sh = CreateObject("WScript.Shell")\r\nsh.Run "wscript.exe ""C:\\Synthetic YoutabFixtureRoot\\gateway-service\\Youtab_Gateway.vbs""", 0, False\r\n',
  startupForeignVbs:
    '\' Youtab Agent Runtime Gateway - Messaging Platform Integration\r\nOption Explicit\r\nDim fso, sh, target\r\ntarget = "C:\\Synthetic YoutabFixtureRoot-neighbor\\gateway-service\\Youtab_Gateway_foreign.vbs"\r\nSet fso = CreateObject("Scripting.FileSystemObject")\r\nIf Not fso.FileExists(target) Then WScript.Quit 0\r\nSet sh = CreateObject("WScript.Shell")\r\nsh.Run "wscript.exe ""C:\\Synthetic YoutabFixtureRoot-neighbor\\gateway-service\\Youtab_Gateway_foreign.vbs""", 0, False\r\n',
  gatewayNamedLegacyVbs:
    '\' Youtab Agent Runtime Gateway - Messaging Platform Integration\r\nOption Explicit\r\nDim sh, env, existing_pp\r\nSet sh = CreateObject("WScript.Shell")\r\nSet env = sh.Environment("PROCESS")\r\nenv.Item("YOUTAB_AGENT_HOME") = "C:\\Synthetic YoutabFixtureRoot\\profiles\\work"\r\nenv.Item("PYTHONIOENCODING") = "utf-8"\r\nenv.Item("YOUTAB_AGENT_GATEWAY_DETACHED") = "1"\r\nenv.Item("VIRTUAL_ENV") = "C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime\\venv"\r\nexisting_pp = env.Item("PYTHONPATH")\r\nIf Len(existing_pp) > 0 Then\r\n  env.Item("PYTHONPATH") = "C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime;" & existing_pp\r\nElse\r\n  env.Item("PYTHONPATH") = "C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime"\r\nEnd If\r\nsh.CurrentDirectory = "C:\\Synthetic YoutabFixtureRoot\\profiles\\work"\r\nsh.Run """C:\\Synthetic YoutabFixtureRoot\\youtab-agent-runtime\\venv\\Scripts\\python.exe"" -m youtab_agent_cli.main --profile work gateway run", 0, False\r\n',
  defaultAction: {
    Path: 'wscript.exe',
    Arguments: '//B //Nologo "C:\\Synthetic YoutabFixtureRoot\\gateway-service\\Youtab_Gateway.vbs"'
  },
  namedAction: {
    Path: 'wscript.exe',
    Arguments:
      '//B //Nologo "C:\\Synthetic YoutabFixtureRoot\\profiles\\work\\gateway-service\\Youtab_Gateway_work.vbs"'
  },
  aliasDefault: '@echo off\r\r\nyoutab -p default %*\r\r\n',
  aliasNamed: '@echo off\r\r\nyoutab -p work %*\r\r\n'
}
// PRODUCER_FIXTURES_END

const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
// Static fixture strings above were generated from AST-selected product producers.
// Their pinned SHA values and generation evidence live in WINDOWS_RESOURCE_PRODUCER_FIXTURES.json.
const materialize = (text: string, root: string) => text.split(producerFixtures.root).join(root)
const lines = (values: string[]) => values.join('\r\n') + '\r\n'

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-resources-synthetic-'))
  const resolved = path.resolve(base)
  if (
    !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(base).startsWith('youtab-resources-synthetic-')
  ) {
    throw new Error('Fixture escaped its temporary boundary')
  }
  const root = path.join(base, 'Owned نصب')
  const named = path.join(root, 'profiles', 'work')
  const foreign = root + '-neighbor'
  const startupDirectory = path.join(base, 'Startup')
  const aliasDirectory = path.join(base, 'user', '.local', 'bin')
  const scripts = path.join(root, 'youtab-agent-runtime', 'venv', 'Scripts')
  for (const directory of [
    path.join(root, 'gateway-service'),
    path.join(named, 'gateway-service'),
    path.join(foreign, 'gateway-service'),
    startupDirectory,
    aliasDirectory,
    scripts
  ])
    {fs.mkdirSync(directory, { recursive: true })}
  const defaultLauncher = path.join(root, 'gateway-service', 'Youtab_Gateway.vbs')
  const namedLauncher = path.join(named, 'gateway-service', 'Youtab_Gateway_work.vbs')
  const foreignLauncher = path.join(foreign, 'gateway-service', 'Youtab_Gateway_foreign.vbs')
  fs.writeFileSync(defaultLauncher, materialize(producerFixtures.gatewayDefaultVbs, root))
  fs.writeFileSync(namedLauncher, materialize(producerFixtures.gatewayNamedLegacyVbs, root))
  fs.writeFileSync(foreignLauncher, 'foreign synthetic launcher')
  fs.writeFileSync(path.join(scripts, 'youtab.exe'), 'synthetic non-executable fixture')
  fs.writeFileSync(
    path.join(startupDirectory, 'Youtab_Gateway.vbs'),
    materialize(producerFixtures.startupDefaultVbs, root)
  )
  fs.writeFileSync(
    path.join(startupDirectory, 'Youtab_Gateway_work.cmd'),
    materialize(producerFixtures.gatewayNamedCmd, root)
  )
  fs.writeFileSync(
    path.join(startupDirectory, 'Youtab_Gateway_foreign.vbs'),
    materialize(producerFixtures.startupForeignVbs, root)
  )
  for (const [alias, id] of [
    ['mine', 'default'],
    ['custom-one', 'work'],
    ['custom-two', 'work']
  ]) {
    fs.writeFileSync(
      path.join(aliasDirectory, alias + '.bat'),
      id === 'default' ? producerFixtures.aliasDefault : producerFixtures.aliasNamed
    )
  }
  fs.writeFileSync(path.join(aliasDirectory, 'foreign.bat'), lines(['@echo off', 'youtab -p external %*']))
  fs.writeFileSync(path.join(aliasDirectory, 'other-vendor.bat'), lines(['@echo off', 'other-vendor.exe %*']))
  fs.writeFileSync(path.join(aliasDirectory, 'legacy-crlf.bat'), lines(['@echo off', 'youtab -p work %*']))
  const data = {
    defaultAction: {
      Path: producerFixtures.defaultAction.Path,
      Arguments: materialize(producerFixtures.defaultAction.Arguments, root)
    },
    namedAction: {
      Path: producerFixtures.namedAction.Path,
      Arguments: materialize(producerFixtures.namedAction.Arguments, root)
    },
    root,
    named,
    foreign,
    startupDirectory,
    aliasDirectory,
    scripts,
    defaultLauncher,
    namedLauncher,
    foreignLauncher
  }
  return { base, data, dispose: () => fs.rmSync(base, { recursive: true, force: true }) }
}

const fakeScheduler = String.raw`
function Get-YoutabCurrentTaskIdentity {return [pscustomobject]@{Sid='S-1-5-21-111-222-333-1001';Name='SYNTHETIC\tester'}}
function New-SyntheticTask([string]$Name,[string]$Target,[bool]$Enabled,[int]$State=3) {
  $action=[pscustomobject]@{Type=0;Path='wscript.exe';Arguments=('//B //Nologo "'+$Target+'"');WorkingDirectory=''}
  $principal=[pscustomobject]@{UserId='S-1-5-21-111-222-333-1001';LogonType=3;RunLevel=0}
  $task=[pscustomobject]@{Name=$Name;Path=('\'+$Name);Definition=[pscustomobject]@{Actions=@($action);Principal=$principal};Enabled=$Enabled;State=$State;Stops=0}
  $task | Add-Member ScriptMethod Stop {param($Flags) $this.Stops++;$this.State=3}
  return $task
}
$folder=[pscustomobject]@{Tasks=[Collections.ArrayList]::new();Deleted=[Collections.Generic.List[string]]::new();Denied=$false}
$folder | Add-Member ScriptMethod GetTasks {param($Flags) return $this.Tasks.ToArray()}
$folder | Add-Member ScriptMethod DeleteTask {param($Name,$Flags)
  if($this.Denied) {throw 'Synthetic DeleteTask access denied'}
  foreach($task in @($this.Tasks | Where-Object {$_.Name -ceq $Name})) {[void]$this.Tasks.Remove($task)}
  $this.Deleted.Add($Name)
}
$scheduler=[pscustomobject]@{Folder=$folder}
$scheduler | Add-Member ScriptMethod GetFolder {param($Path) if($Path -cne '\'){throw 'Wrong scheduler scope'};return $this.Folder}
$defaultTask=New-SyntheticTask 'Youtab_Gateway' $v.defaultLauncher $true 4
$defaultTask.Definition.Actions[0].Path=$v.defaultAction.Path
$defaultTask.Definition.Actions[0].Arguments=$v.defaultAction.Arguments
$namedTask=New-SyntheticTask 'Youtab_Gateway_work' $v.namedLauncher $false
$namedTask.Definition.Actions[0].Path=$v.namedAction.Path
$namedTask.Definition.Actions[0].Arguments=$v.namedAction.Arguments
$foreignTask=New-SyntheticTask 'Youtab_Gateway_foreign' $v.foreignLauncher $true
[void]$folder.Tasks.Add($defaultTask);[void]$folder.Tasks.Add($namedTask);[void]$folder.Tasks.Add($foreignTask)
$plan=[pscustomobject]@{installRoot=$v.root;startupDirectory=$v.startupDirectory;aliasDirectory=$v.aliasDirectory}
function Assert-SyntheticDenied([scriptblock]$Action) {
  $denied=$false
  try {& $Action}catch{$denied=$true}
  if(-not $denied) {throw 'Expected operation to be denied'}
}
`

function run(data: ReturnType<typeof fixture>['data'], body: string) {
  const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64')
  const source =
    `$ErrorActionPreference='Stop'\n${WINDOWS_OWNED_TREE_FUNCTIONS}\n${WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS}\n` +
    `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json\n${fakeScheduler}\n${body}\n'RESOURCES_OK'`
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: `& {\ntry {\n${source}\n} catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }\n}\n\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 1024
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stdout, result.stderr).toContain('RESOURCES_OK')
}

describe.runIf(process.platform === 'win32')('native current-user uninstall resource fixtures (not VM E2E)', () => {
  it('inventories default/named launchers, removes every custom alias and preserves foreign neighbors', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$resources=Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts
if($resources.KnownHomes.Count -ne 2 -or $resources.Tasks.Count -ne 2 -or $resources.Files.Count -ne 6) {throw 'Incomplete inventory'}
Suspend-YoutabOwnedUninstallTasks $resources $scheduler
if($defaultTask.Enabled -or $namedTask.Enabled -or $defaultTask.Stops -ne 0 -or -not $foreignTask.Enabled) {throw 'Suspension escaped its scope'}
Restore-YoutabOwnedUninstallTasks $resources $scheduler
if(-not $defaultTask.Enabled -or $namedTask.Enabled) {throw 'Original enabled states not restored'}
Suspend-YoutabOwnedUninstallTasks $resources $scheduler
Remove-YoutabOwnedUninstallResources $resources $scheduler
if($folder.Deleted.Count -ne 2 -or $folder.Tasks.Count -ne 1 -or $defaultTask.Stops -ne 1 -or $namedTask.Stops -ne 0) {throw 'Wrong task lifecycle'}
`
      )
      for (const alias of ['mine', 'custom-one', 'custom-two', 'legacy-crlf'])
        {expect(fs.existsSync(path.join(f.data.aliasDirectory, alias + '.bat'))).toBe(false)}
      for (const alias of ['foreign', 'other-vendor'])
        {expect(fs.existsSync(path.join(f.data.aliasDirectory, alias + '.bat'))).toBe(true)}
      expect(fs.existsSync(path.join(f.data.startupDirectory, 'Youtab_Gateway_foreign.vbs'))).toBe(true)
      expect(fs.existsSync(f.data.defaultLauncher)).toBe(true)
      expect(fs.existsSync(f.data.foreignLauncher)).toBe(true)
    } finally {
      f.dispose()
    }
  })

  it.each(['home', 'path'])('refuses ambiguous registry %s binding without modifying resources', (which) => {
    const f = fixture()
    try {
      run(
        f.data,
        which === 'home'
          ? String.raw`
Assert-SyntheticDenied {Get-YoutabOwnedUninstallResources $plan $scheduler $v.foreign $v.scripts}
if(-not $defaultTask.Enabled -or $folder.Deleted.Count) {throw 'Inventory changed task state'}
`
          : String.raw`
Assert-SyntheticDenied {Get-YoutabOwnedUninstallResources $plan $scheduler $v.root ($v.foreign+'\youtab-agent-runtime\venv\Scripts')}
if(-not $defaultTask.Enabled -or $folder.Deleted.Count) {throw 'Inventory changed task state'}
`
      )
      expect(fs.existsSync(path.join(f.data.aliasDirectory, 'mine.bat'))).toBe(true)
    } finally {
      f.dispose()
    }
  })

  it('accepts the trusted system script host and exact cached current-user name while preserving COM-handler tasks', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$defaultTask.Definition.Actions[0].Path=[IO.Path]::Combine([Environment]::SystemDirectory,'wscript.exe')
$defaultTask.Definition.Principal.UserId='SYNTHETIC\tester'
[void]$folder.Tasks.Add([pscustomobject]@{Name='OtherVendorComHandler';Path='\OtherVendorComHandler';Definition=[pscustomobject]@{Actions=@([pscustomobject]@{Type=5})};Enabled=$true})
$resources=Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts
if($resources.Tasks.Count -ne 2) {throw 'Canonical current-user task was not recognized'}
Suspend-YoutabOwnedUninstallTasks $resources $scheduler
Restore-YoutabOwnedUninstallTasks $resources $scheduler
if(-not $defaultTask.Enabled -or $folder.Tasks.Count -ne 4 -or $folder.Deleted.Count) {throw 'Unrelated COM-handler task was changed'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it('revalidates changed file hashes before any task suspension or deletion', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$resources=Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts
[IO.File]::AppendAllText(([IO.Path]::Combine($v.aliasDirectory,'mine.bat')),'rem modified')
Assert-SyntheticDenied {Suspend-YoutabOwnedUninstallTasks $resources $scheduler}
Assert-SyntheticDenied {Remove-YoutabOwnedUninstallResources $resources $scheduler}
if(-not $defaultTask.Enabled -or $folder.Deleted.Count) {throw 'Snapshot failure mutated a task'}
`
      )
      expect(fs.existsSync(path.join(f.data.aliasDirectory, 'custom-one.bat'))).toBe(true)
    } finally {
      f.dispose()
    }
  })

  it('rejects an owned action with a second action before claiming the task', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$defaultTask.Definition.Actions += [pscustomobject]@{Type=0;Path='other.exe';Arguments='';WorkingDirectory=''}
Assert-SyntheticDenied {Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts}
if(-not $defaultTask.Enabled -or $folder.Deleted.Count) {throw 'Ambiguous task was changed'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it('rejects changed task actions and does not restore a repointed task', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$resources=Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts
Suspend-YoutabOwnedUninstallTasks $resources $scheduler
$defaultTask.Definition.Actions[0].Arguments='//B //Nologo "'+$v.foreignLauncher+'"'
Assert-SyntheticDenied {Restore-YoutabOwnedUninstallTasks $resources $scheduler}
Assert-SyntheticDenied {Remove-YoutabOwnedUninstallResources $resources $scheduler}
if($defaultTask.Enabled -or -not $foreignTask.Enabled -or $folder.Deleted.Count) {throw 'Repointed/foreign task changed'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it('refuses a foreign or elevated task principal without changing its state', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$defaultTask.Definition.Principal.UserId='S-1-5-18'
Assert-SyntheticDenied {Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts}
$defaultTask.Definition.Principal.UserId='S-1-5-21-111-222-333-1001'
$defaultTask.Definition.Principal.RunLevel=1
Assert-SyntheticDenied {Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts}
if(-not $defaultTask.Enabled -or $folder.Deleted.Count) {throw 'Foreign/elevated principal was changed'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it.each(['profile', 'launcher'])('rejects a reparse %s without following its target', (kind) => {
    const f = fixture()
    try {
      if (kind === 'profile') {
        fs.symlinkSync(f.data.foreign, path.join(f.data.root, 'profiles', 'pivot'), 'junction')
      } else {
        fs.renameSync(path.dirname(f.data.defaultLauncher), path.join(f.data.root, 'launcher-backup'))
        fs.symlinkSync(path.dirname(f.data.foreignLauncher), path.dirname(f.data.defaultLauncher), 'junction')
      }
      run(
        f.data,
        String.raw`
Assert-SyntheticDenied {Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts}
if(-not $defaultTask.Enabled -or $folder.Deleted.Count) {throw 'Reparse failure mutated a task'}
`
      )
      expect(fs.readFileSync(f.data.foreignLauncher, 'utf8')).toBe('foreign synthetic launcher')
    } finally {
      f.dispose()
    }
  })

  it('reports DeleteTask denial and preserves external files instead of claiming cleanup succeeded', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$resources=Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts
$folder.Denied=$true
Assert-SyntheticDenied {Remove-YoutabOwnedUninstallResources $resources $scheduler}
if($folder.Deleted.Count -or $folder.Tasks.Count -ne 3 -or -not $foreignTask.Enabled) {throw 'Denied deletion changed unrelated tasks'}
`
      )
      expect(fs.existsSync(path.join(f.data.aliasDirectory, 'mine.bat'))).toBe(true)
      expect(fs.existsSync(path.join(f.data.startupDirectory, 'Youtab_Gateway.vbs'))).toBe(true)
    } finally {
      f.dispose()
    }
  })

  it('refuses fresh registry changes and modified Startup scripts before mutation', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$resources=Get-YoutabOwnedUninstallResources $plan $scheduler $v.root $v.scripts
Assert-SyntheticDenied {Assert-YoutabOwnedUninstallResources $resources $scheduler $v.foreign $v.scripts}
[IO.File]::AppendAllText(([IO.Path]::Combine($v.startupDirectory,'Youtab_Gateway.vbs')),'rem modified')
Assert-SyntheticDenied {Suspend-YoutabOwnedUninstallTasks $resources $scheduler}
if(-not $defaultTask.Enabled -or $folder.Deleted.Count) {throw 'Changed ownership mutated a task'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it('expands a synthetic PATH variable and refuses an earlier foreign Machine PATH CLI before deleting aliases', () => {
    const f = fixture()
    try {
      run(
        f.data,
        String.raw`
$env:YOUTAB_SYNTHETIC_RESOURCE_PATH=$v.scripts
$resources=Get-YoutabOwnedUninstallResources $plan $scheduler $v.root '%YOUTAB_SYNTHETIC_RESOURCE_PATH%'
if($resources.Files.Count -ne 6) {throw 'Expanded own CLI binding was not accepted'}
$foreignScripts=[IO.Path]::Combine($v.foreign,'venv','Scripts')
[void][IO.Directory]::CreateDirectory($foreignScripts)
[IO.File]::WriteAllText(([IO.Path]::Combine($foreignScripts,'youtab.exe')),'synthetic foreign CLI')
Assert-SyntheticDenied {Get-YoutabOwnedUninstallResources $plan $scheduler $v.root ($foreignScripts+';'+$v.scripts)}
if(-not $defaultTask.Enabled -or $folder.Deleted.Count) {throw 'Foreign Machine PATH CLI caused a mutation'}
`
      )
      expect(fs.existsSync(path.join(f.data.aliasDirectory, 'mine.bat'))).toBe(true)
    } finally {
      f.dispose()
    }
  })
})
