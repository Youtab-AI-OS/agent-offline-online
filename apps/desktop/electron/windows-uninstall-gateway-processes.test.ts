import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { WINDOWS_OWNED_TREE_FUNCTIONS } from './windows-full-uninstall'
import { WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS } from './windows-uninstall-gateway-processes'

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const run = (body: string) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-gateway-stop-test-'))
  expect(path.dirname(path.resolve(fixture))).toBe(path.resolve(os.tmpdir()))
  expect(path.basename(fixture).startsWith('youtab-gateway-stop-test-')).toBe(true)
  const payload = Buffer.from(JSON.stringify({ fixture }), 'utf8').toString('base64')
  try {
    return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '& { & ([ScriptBlock]::Create([Console]::In.ReadToEnd())) }'], {
      input: `$ErrorActionPreference='Stop'\n${WINDOWS_OWNED_TREE_FUNCTIONS}\n${WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS}\n$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json\n${body}`,
      encoding: 'utf8', windowsHide: true, timeout: 20000
    })
  } finally {
    // Only the checked absolute, test-created fixture is removed.
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

const fixtureSetup = String.raw`
$root=[IO.Path]::Combine($v.fixture,'installation');[void][IO.Directory]::CreateDirectory($root)
$named=[IO.Path]::Combine($root,'profiles','finance');[void][IO.Directory]::CreateDirectory($named)
$handoff=[pscustomobject]@{directory=[IO.Path]::Combine($v.fixture,'handoff');token='synthetic-handoff'}
[void][IO.Directory]::CreateDirectory($handoff.directory)
$plan=[pscustomobject]@{installRoot=$root}
$known=@([pscustomobject]@{Id='default';Home=$root},[pscustomobject]@{Id='finance';Home=$named})
$exe=[IO.Path]::Combine($root,'youtab-agent-runtime\venv\Scripts\python.exe')
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($exe));[IO.File]::WriteAllText($exe,'Synthetic, never executed')
$script:live=@{};$script:stops=New-Object 'System.Collections.Generic.List[int]'
function Get-YoutabGatewayProcessIdentity([int]$TargetPid) { return $script:live[$TargetPid] }
function Stop-YoutabGatewayProcess($Identity) { $script:stops.Add([int]$Identity.Pid);$script:live.Remove([int]$Identity.Pid) }
function Set-SyntheticGateway([int]$TargetPid,[string]$GatewayHome,[string]$ProfileId) {
  $arguments='"'+$exe+'" -m youtab_agent_cli.main '
  if($ProfileId -ne 'default'){$arguments+='--profile '+$ProfileId+' '};$arguments+='gateway run'
  $script:live[$TargetPid]=[pscustomobject]@{Pid=$TargetPid;StartTime=170000000123;Executable=$exe;CommandLine=$arguments}
  $record=[ordered]@{kind='youtab-gateway';pid=$TargetPid;start_time=170000000123;youtab_home=$GatewayHome;argv=@('gateway','run')}
  [IO.File]::WriteAllText([IO.Path]::Combine($GatewayHome,'gateway.pid'),($record|ConvertTo-Json -Compress))
}
function Expect-Refusal([scriptblock]$Action) {
  $refused=$false;try{& $Action|Out-Null}catch{$refused=$true};if(-not $refused){throw 'Expected explicit refusal'}
}
`

describe('scoped Windows gateway drain before confirmed full uninstall', () => {
  it.runIf(process.platform === 'win32')('loads native primitives and queries only the test PowerShell process', () => {
    const output = run(String.raw`
Initialize-YoutabGatewayNative
$identity=Get-YoutabGatewayProcessIdentity $PID
if($identity.Pid -ne $PID -or $identity.StartTime -le 0){throw 'Native identity unavailable'}
$parts=[YoutabUninstallGatewayNative]::Arguments('"C:\Synthetic Folder\python.exe" -m youtab_agent_cli.main --profile "finance" gateway run')
if($parts[0] -cne 'C:\Synthetic Folder\python.exe' -or $parts[4] -cne 'finance'){throw 'Native argv split failed'}
$refused=$false;try{[void][YoutabUninstallGatewayNative]::TerminateIfSame($PID,1,'C:\not-this-process.exe')}catch{$refused=$true}
if(-not $refused){throw 'Native reused identity was not refused'}
$marker=[IO.Path]::Combine($v.fixture,'marker');[IO.File]::WriteAllText($marker,'owned')
if([YoutabUninstallGatewayNative]::RemoveIfSame($marker,'foreign')){throw 'Foreign marker removed'}
if(-not [YoutabUninstallGatewayNative]::RemoveIfSame($marker,'owned') -or (Test-Path -LiteralPath $marker)){throw 'Owned marker not removed'}
$outside=[IO.Path]::Combine($v.fixture,'outside');[void][IO.Directory]::CreateDirectory($outside)
$sentinel=[IO.Path]::Combine($outside,'keep.txt');[IO.File]::WriteAllText($sentinel,'outside must remain')
$link=[IO.Path]::Combine($v.fixture,'marker-junction');[void](New-Item -ItemType Junction -Path $link -Target $outside)
$refused=$false;try{[void][YoutabUninstallGatewayNative]::RemoveIfSame($link,'outside must remain')}catch{$refused=$true}
if(-not $refused -or [IO.File]::ReadAllText($sentinel) -cne 'outside must remain'){throw 'Reparse marker touched its target'}
'NATIVE_OK'
`)
    expect(output).toContain('NATIVE_OK')
  })

  it.runIf(process.platform === 'win32')('accepts exact default/named ownership and leaves stale records untouched', () => {
    const output = run(fixtureSetup + String.raw`
Set-SyntheticGateway 101 $root 'default';Set-SyntheticGateway 102 $named 'finance'
$before=[IO.File]::ReadAllText([IO.Path]::Combine($root,'gateway.pid'))
$snapshots=@(Get-YoutabOwnedGatewayProcesses $plan $known)
if($snapshots.Count -ne 2 -or $snapshots[1].ProfileId -cne 'finance'){throw 'Owned inventory mismatch'}
$script:live.Remove(101);$script:live.Remove(102)
if(@(Get-YoutabOwnedGatewayProcesses $plan $known).Count -ne 0){throw 'Stale PID became live'}
if([IO.File]::ReadAllText([IO.Path]::Combine($root,'gateway.pid')) -cne $before){throw 'Stale record was mutated'}
if($script:stops.Count){throw 'Readonly inventory stopped a process'}
'INVENTORY_OK'
`)
    expect(output).toContain('INVENTORY_OK')
  })

  it.runIf(process.platform === 'win32')('refuses live legacy, malformed, foreign, reused and wrong-profile records without stopping any PID', () => {
    const output = run(fixtureSetup + String.raw`
foreach($case in @('legacy','malformed','kind','home','stringpid','start','reuse','executable','command','profile')) {
  Set-SyntheticGateway 101 $root 'default'
  $pidFile=[IO.Path]::Combine($root,'gateway.pid');$record=[IO.File]::ReadAllText($pidFile)|ConvertFrom-Json
  switch($case) {
    'legacy' {[IO.File]::WriteAllText($pidFile,'101')}
    'malformed' {[IO.File]::WriteAllText($pidFile,'{')}
    'kind' {$record.kind='foreign';[IO.File]::WriteAllText($pidFile,($record|ConvertTo-Json -Compress))}
    'home' {$record.youtab_home=$named;[IO.File]::WriteAllText($pidFile,($record|ConvertTo-Json -Compress))}
    'stringpid' {$record.pid='101';[IO.File]::WriteAllText($pidFile,($record|ConvertTo-Json -Compress))}
    'start' {$record.start_time=$null;[IO.File]::WriteAllText($pidFile,($record|ConvertTo-Json -Compress))}
    'reuse' {$script:live[101].StartTime++}
    'executable' {$script:live[101].Executable='C:\foreign\python.exe'}
    'command' {$script:live[101].CommandLine='"'+$exe+'" -c "print(''gateway run'')"'}
    'profile' {$script:live[101].CommandLine='"'+$exe+'" -m youtab_agent_cli.main --profile finance gateway run'}
  }
  Expect-Refusal { Get-YoutabOwnedGatewayProcesses $plan @($known[0]) }
}
if($script:stops.Count -or (Test-Path -LiteralPath ([IO.Path]::Combine($root,'.gateway-planned-stop.json')))){throw 'Refused inventory caused mutation'}
'REFUSAL_OK'
`)
    expect(output).toContain('REFUSAL_OK')
  })

  it.runIf(process.platform === 'win32')('publishes canonical markers for all gateways before one bounded grace and removes only still-owned markers', () => {
    const output = run(fixtureSetup + String.raw`
Set-SyntheticGateway 101 $root 'default';Set-SyntheticGateway 102 $named 'finance'
$snapshots=@(Get-YoutabOwnedGatewayProcesses $plan $known)
function Stop-YoutabGatewayProcess($Identity) {
  foreach($snapshot in $snapshots){if(-not(Test-Path -LiteralPath $snapshot.MarkerPath)){throw 'Gateways were not drained in parallel'}}
  $snapshot=@($snapshots|Where-Object Pid -eq $Identity.Pid)[0]
  $marker=[IO.File]::ReadAllText($snapshot.MarkerPath)|ConvertFrom-Json
  if(($marker.PSObject.Properties.Name|Sort-Object) -join ',' -cne 'stopper_pid,target_pid,target_start_time,target_youtab_home,written_at'){throw 'Marker schema mismatch'}
  if($marker.target_pid -ne $Identity.Pid -or $marker.target_start_time -ne 170000000123 -or $marker.stopper_pid -ne $PID -or $marker.target_youtab_home -cne $snapshot.Home -or -not $marker.written_at.EndsWith('Z')){throw 'Invalid stop marker'}
  $script:stops.Add([int]$Identity.Pid);$script:live.Remove([int]$Identity.Pid)
}
$clock=[Diagnostics.Stopwatch]::StartNew();Stop-YoutabOwnedGatewayProcesses $snapshots $plan $handoff 1
if($script:stops.Count -ne 2 -or $clock.ElapsedMilliseconds -gt 4000){throw 'Drain was not bounded'}
[IO.File]::WriteAllText($snapshots[1].MarkerPath,'foreign replacement')
Remove-YoutabOwnedGatewayStopMarkers $snapshots $handoff
if(Test-Path -LiteralPath $snapshots[0].MarkerPath){throw 'Owned marker remains'}
if([IO.File]::ReadAllText($snapshots[1].MarkerPath) -cne 'foreign replacement'){throw 'Another stop owner marker was removed'}
'DRAIN_OK'
`)
    expect(output).toContain('DRAIN_OK')
  })

  it.runIf(process.platform === 'win32')('cancels between individual revalidation or grace queries without forced stop and cleans its exact markers', () => {
    const output = run(fixtureSetup + String.raw`
Set-SyntheticGateway 101 $root 'default';Set-SyntheticGateway 102 $named 'finance'
$snapshots=@(Get-YoutabOwnedGatewayProcesses $plan $known)
$cancel=[IO.Path]::Combine($handoff.directory,'cancel');$script:queriesAfterCancel=0
function Get-YoutabGatewayProcessIdentity([int]$TargetPid) {
  if(Test-Path -LiteralPath $cancel){$script:queriesAfterCancel++}
  [IO.File]::WriteAllText($cancel,$handoff.token)
  return $script:live[$TargetPid]
}
Expect-Refusal { Stop-YoutabOwnedGatewayProcesses $snapshots $plan $handoff 1000 }
if($script:queriesAfterCancel -or $script:stops.Count){throw 'Cancellation did not stop initial per-item queries'}
[IO.File]::Delete($cancel)
function Get-YoutabGatewayProcessIdentity([int]$TargetPid) {
  if(Test-Path -LiteralPath $cancel){$script:queriesAfterCancel++}
  if((Test-Path -LiteralPath $snapshots[0].MarkerPath) -and (Test-Path -LiteralPath $snapshots[1].MarkerPath)){
    [IO.File]::WriteAllText($cancel,$handoff.token)
  }
  return $script:live[$TargetPid]
}
Expect-Refusal { Stop-YoutabOwnedGatewayProcesses $snapshots $plan $handoff 1000 }
if($script:queriesAfterCancel -or $script:stops.Count){throw 'Cancellation did not stop per-item grace queries'}
foreach($snapshot in $snapshots){if(Test-Path -LiteralPath $snapshot.MarkerPath){throw 'Cancelled stop left its marker'}}
'CANCEL_OK'
`)
    expect(output).toContain('CANCEL_OK')
  })

  it.runIf(process.platform === 'win32')('revalidates PID reuse and a racing foreign marker before force or cleanup', () => {
    const output = run(fixtureSetup + String.raw`
Set-SyntheticGateway 101 $root 'default';$snapshots=@(Get-YoutabOwnedGatewayProcesses $plan @($known[0]))
function Get-YoutabGatewayProcessIdentity([int]$TargetPid) {
  if(Test-Path -LiteralPath ([IO.Path]::Combine($root,'.gateway-planned-stop.json'))){$script:live[$TargetPid].StartTime=170000000124}
  return $script:live[$TargetPid]
}
Expect-Refusal { Stop-YoutabOwnedGatewayProcesses $snapshots $plan $handoff 1 }
if($script:stops.Count){throw 'A reused PID was stopped'}
function Get-YoutabGatewayProcessIdentity([int]$TargetPid) {return $script:live[$TargetPid]}
Set-SyntheticGateway 101 $root 'default';$snapshots=@(Get-YoutabOwnedGatewayProcesses $plan @($known[0]))
[IO.File]::WriteAllText($snapshots[0].MarkerPath,'another owner')
Expect-Refusal { Stop-YoutabOwnedGatewayProcesses $snapshots $plan $handoff 1 }
if($script:stops.Count -or [IO.File]::ReadAllText($snapshots[0].MarkerPath) -cne 'another owner'){throw 'Foreign marker race was not preserved'}
'RACE_OK'
`)
    expect(output).toContain('RACE_OK')
  })
})
