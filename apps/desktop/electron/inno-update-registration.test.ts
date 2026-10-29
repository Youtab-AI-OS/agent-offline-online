import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { INNO_UPDATE_REGISTRATION_FUNCTIONS } from './inno-update-registration'
import { INNO_UPDATE_TRANSACTION_FUNCTIONS } from './inno-update-transaction'
import { WINDOWS_OWNED_TREE_FUNCTIONS } from './windows-full-uninstall'

const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-inno-registration-'))

  const verify = () => {
    if (
      !path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(base).startsWith('youtab-inno-registration-')
    )
      {throw new Error('Fixture escaped temporary boundary')}
  }

  verify()

  return {
    base,
    dispose() {
      verify()
      fs.rmSync(base, { recursive: true, force: true })
    }
  }
}

const setup = String.raw`
function Assert-FixtureDenied([scriptblock]$Action) {
  $denied=$false
  try {& $Action}catch{$denied=$true}
  if (-not $denied) {throw 'Expected operation to be refused.'}
}
$install=[IO.Path]::Combine($base,'Owned نصب installation')
New-YoutabPrivateUpdateDirectory $install
$updates=[IO.Path]::Combine($install,'.youtab-updates')
New-YoutabPrivateUpdateDirectory $updates
$id='transaction-'+[Guid]::NewGuid().ToString('N')
$directory=[IO.Path]::Combine($updates,$id)
New-YoutabPrivateUpdateDirectory $directory
foreach($name in @('metadata','failed')) {New-YoutabPrivateUpdateDirectory ([IO.Path]::Combine($directory,$name))}
$txn=[pscustomobject]@{Id=$id;InstallRoot=$install;Directory=$directory}
$script:registryWrites=0
$script:openedViews=New-Object 'Collections.Generic.List[string]'
function New-FixtureRegistry($Values) {
  $key=[pscustomobject]@{Values=$Values}
  $key|Add-Member ScriptMethod GetValueNames {return [string[]]@($this.Values.Keys)}
  $key|Add-Member ScriptMethod GetValue {param($name,$fallback,$options) if($options -ne [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames){throw 'Registry strings would expand.'};if($this.Values.Contains($name)){return $this.Values[$name].Value};return $fallback}
  $key|Add-Member ScriptMethod GetValueKind {param($name) return [Enum]::Parse([Microsoft.Win32.RegistryValueKind],$this.Values[$name].Kind)}
  $key|Add-Member ScriptMethod SetValue {param($name,$value,$kind) $script:registryWrites++;$this.Values[$name]=@{Kind=$kind.ToString();Value=$value}}
  $key|Add-Member ScriptMethod DeleteValue {param($name,$throws) $script:registryWrites++;$this.Values.Remove($name)}
  $key|Add-Member ScriptMethod Dispose {}
  return $key
}
$oldValues=@{
  InstallLocation=@{Kind='String';Value=$install}
  'Inno Setup: App Path'=@{Kind='String';Value=$install}
  UninstallString=@{Kind='String';Value=('"'+[IO.Path]::Combine($install,'unins000.exe')+'"')}
  QuietUninstallString=@{Kind='String';Value=('"'+[IO.Path]::Combine($install,'unins000.exe')+'" /SILENT')}
  DisplayVersion=@{Kind='String';Value='old-fixture-version'}
  RawExpand=@{Kind='ExpandString';Value='%TEMP%\literal-unexpanded'}
  Multi=@{Kind='MultiString';Value=@('first','دوم')}
  Blob=@{Kind='Binary';Value=[byte[]]@(0,128,255)}
  Nothing=@{Kind='None';Value=[byte[]]@(4,0,8)}
  Number32=@{Kind='DWord';Value=[int]-1}
  Number64=@{Kind='QWord';Value=[long]9007199254740990}
}
$script:fakeViews=@{Registry64=(New-FixtureRegistry $oldValues);Registry32=$null}
# Override the sole fixed-key registry access helper. No actual registry calls occur.
function Open-YoutabUpdateRegistrationKey([string]$View,[bool]$Writable,[bool]$Create=$false) {
  $script:openedViews.Add($View)
  if ($Create -and $null -eq $script:fakeViews[$View]) {$script:fakeViews[$View]=New-FixtureRegistry @{}}
  return $script:fakeViews[$View]
}
$preserved=@{}
foreach($relative in @('state.db','sessions\synthetic.json','profiles\work\auth.json','unins-user-document.txt')) {
  $file=[IO.Path]::Combine($install,$relative)
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
  [IO.File]::WriteAllText($file,('SYNTHETIC ONLY: '+$relative))
  $preserved[$file]=Get-YoutabUpdateHash $file
}
$neighbor=[IO.Path]::Combine($base,'Other installation')
[void][IO.Directory]::CreateDirectory($neighbor)
$neighborFile=[IO.Path]::Combine($neighbor,'unins000.exe')
[IO.File]::WriteAllText($neighborFile,'FOREIGN FIXTURE ONLY')
$preserved[$neighborFile]=Get-YoutabUpdateHash $neighborFile
$oldFiles=@{}
foreach($name in @('unins000.exe','unins000.dat','unins000.msg','.youtab-install-files.json')) {
  $file=[IO.Path]::Combine($install,$name)
  [IO.File]::WriteAllText($file,('OLD SYNTHETIC BYTES: '+$name))
  $oldFiles[$name]=Get-YoutabUpdateHash $file
}
function Assert-FixturePreserved {
  foreach($file in $preserved.Keys) {if((Get-YoutabUpdateHash $file) -cne $preserved[$file]){throw 'User data or foreign sentinel changed.'}}
}
function Assert-FixtureOriginalMetadata {
  foreach($name in $oldFiles.Keys) {if((Get-YoutabUpdateHash ([IO.Path]::Combine($install,$name))) -cne $oldFiles[$name]){throw ('Original registration metadata not restored: '+$name)}}
}
`

function run(base: string, body: string) {
  const encoded = Buffer.from(base, 'utf8').toString('base64')
  const source = `$ErrorActionPreference='Stop'\n${WINDOWS_OWNED_TREE_FUNCTIONS}\n${INNO_UPDATE_TRANSACTION_FUNCTIONS}\n${INNO_UPDATE_REGISTRATION_FUNCTIONS}\n$base=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))\n${setup}\n${body}\nAssert-FixturePreserved\n'REGISTRATION_FIXTURE_OK'`

  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: `& {\ntry {\n${source}\n} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }\n}\n\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024
  })

  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stdout, result.stderr).toContain('REGISTRATION_FIXTURE_OK')
}

describe.runIf(process.platform === 'win32')('native current-user Inno registration metadata fixtures', () => {
  it('durably snapshots exact bounded files and all registry types without expanding strings', () => {
    const f = fixture()

    try {
      run(
        f.base,
        String.raw`
$result=@(Save-YoutabUpdateRegistration $txn)
if($result.Count -ne 1 -or $result[0] -isnot [bool] -or -not $result[0]){throw 'Save requires an explicit boolean ACK.'}
$snapshot=Read-YoutabUpdateRegistration $txn
if($snapshot.Registry.View -cne 'Registry64' -or @($snapshot.Files).Count -ne 3 -or -not $snapshot.Manifest.Exists){throw 'Snapshot shape is incomplete.'}
if(($snapshot.Registry.Values|Where-Object {$_.Name -ceq 'RawExpand'}).Value -cne '%TEMP%\literal-unexpanded'){throw 'ExpandString was expanded.'}
if($script:registryWrites -ne 0){throw 'Save mutated registry.'}
Assert-FixtureOriginalMetadata
`
      )
    } finally {
      f.dispose()
    }
  })

  it('restores changed/missing metadata and typed values, preserves newly added foreign registry data and failed bytes', () => {
    const f = fixture()

    try {
      run(
        f.base,
        String.raw`
[void](Save-YoutabUpdateRegistration $txn)
[IO.File]::WriteAllText([IO.Path]::Combine($install,'unins000.exe'),'NEW SYNTHETIC UNINSTALLER')
[IO.File]::Delete([IO.Path]::Combine($install,'unins000.dat'))
[IO.File]::WriteAllText([IO.Path]::Combine($install,'unins001.exe'),'NEW INTRODUCED SYNTHETIC FILE')
[IO.File]::WriteAllText([IO.Path]::Combine($install,'.youtab-install-files.json'),'NEW SYNTHETIC MANIFEST')
$oldValues.RawExpand.Value='changed';$oldValues.Number32.Value=[int]4
$oldValues.DisplayIcon=@{Kind='String';Value='new standard Inno value'}
$oldValues['Foreign IT note']=@{Kind='String';Value='retain added foreign value'}
$result=@(Restore-YoutabUpdateRegistration $txn)
if($result.Count -ne 1 -or $result[0] -isnot [bool] -or -not $result[0]){throw 'Restore requires an explicit boolean ACK.'}
Assert-FixtureOriginalMetadata
if(Test-Path -LiteralPath ([IO.Path]::Combine($install,'unins001.exe'))){throw 'Introduced Inno file remains live.'}
if($oldValues.Contains('DisplayIcon') -or $oldValues['Foreign IT note'].Value -cne 'retain added foreign value'){throw 'Registry ownership boundary failed.'}
if($oldValues.RawExpand.Kind -cne 'ExpandString' -or $oldValues.RawExpand.Value -cne '%TEMP%\literal-unexpanded' -or $oldValues.Number32.Value -ne -1 -or $oldValues.Number64.Value -ne 9007199254740990 -or ($oldValues.Blob.Value -join ',') -cne '0,128,255' -or ($oldValues.Nothing.Value -join ',') -cne '4,0,8' -or ($oldValues.Multi.Value -join '|') -cne 'first|دوم'){throw 'Typed registry restoration failed.'}
$failed=@(Get-ChildItem -LiteralPath ([IO.Path]::Combine($directory,'failed')) -Directory)
if($failed.Count -ne 1 -or [IO.File]::ReadAllText([IO.Path]::Combine($failed[0].FullName,'unins001.exe')) -cne 'NEW INTRODUCED SYNTHETIC FILE' -or [IO.File]::ReadAllText([IO.Path]::Combine($failed[0].FullName,'unins000.exe')) -cne 'NEW SYNTHETIC UNINSTALLER' -or [IO.File]::ReadAllText([IO.Path]::Combine($failed[0].FullName,'.youtab-install-files.json')) -cne 'NEW SYNTHETIC MANIFEST'){throw 'Failed metadata evidence was lost.'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it('restores absence of an old manifest by preserving only the new owned manifest in failed metadata', () => {
    const f = fixture()

    try {
      run(
        f.base,
        String.raw`
[IO.File]::Delete([IO.Path]::Combine($install,'.youtab-install-files.json'));$oldFiles.Remove('.youtab-install-files.json')
[void](Save-YoutabUpdateRegistration $txn)
[IO.File]::WriteAllText([IO.Path]::Combine($install,'.youtab-install-files.json'),'introduced manifest')
[void](Restore-YoutabUpdateRegistration $txn)
if(Test-Path -LiteralPath ([IO.Path]::Combine($install,'.youtab-install-files.json'))){throw 'Original manifest absence was not restored.'}
Assert-FixtureOriginalMetadata
`
      )
    } finally {
      f.dispose()
    }
  })

  it('refuses corrupted snapshot bytes before any live metadata or registry restoration', () => {
    const f = fixture()

    try {
      run(
        f.base,
        String.raw`
[void](Save-YoutabUpdateRegistration $txn)
[IO.File]::WriteAllText([IO.Path]::Combine($directory,'metadata','registration-files','unins000.exe'),'corrupted snapshot')
[IO.File]::WriteAllText([IO.Path]::Combine($install,'unins000.exe'),'new remains intact')
Assert-FixtureDenied {Restore-YoutabUpdateRegistration $txn}
if([IO.File]::ReadAllText([IO.Path]::Combine($install,'unins000.exe')) -cne 'new remains intact' -or $script:registryWrites -ne 0){throw 'Mutation occurred before snapshot validation.'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it('refuses a reparse uninstaller and an oversized manifest before saving metadata', () => {
    const f = fixture()

    try {
      run(
        f.base,
        String.raw`
[IO.File]::Delete([IO.Path]::Combine($install,'unins000.exe'))
New-Item -ItemType Junction -Path ([IO.Path]::Combine($install,'unins000.exe')) -Target $neighbor -ErrorAction Stop|Out-Null
Assert-FixtureDenied {Save-YoutabUpdateRegistration $txn}
[IO.Directory]::Delete([IO.Path]::Combine($install,'unins000.exe'))
[IO.File]::WriteAllText([IO.Path]::Combine($install,'unins000.exe'),'old fixture')
$stream=[IO.File]::OpenWrite([IO.Path]::Combine($install,'.youtab-install-files.json'));try{$stream.SetLength(64MB+1)}finally{$stream.Dispose()}
Assert-FixtureDenied {Save-YoutabUpdateRegistration $txn}
if($script:registryWrites -ne 0){throw 'Invalid source changed registry.'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it('enforces the 32 uninstaller-file bound and does not include neighboring names', () => {
    const f = fixture()

    try {
      run(
        f.base,
        String.raw`
foreach($index in 1..30){[IO.File]::WriteAllText([IO.Path]::Combine($install,('unins{0:000}.dat' -f $index)),'synthetic')}
Assert-FixtureDenied {Save-YoutabUpdateRegistration $txn}
if(Test-Path -LiteralPath ([IO.Path]::Combine($directory,'metadata','registration.json'))){throw 'Oversized snapshot was committed.'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it('records Registry32 only when Registry64 is absent and never follows a foreign Registry64 binding', () => {
    const f = fixture()

    try {
      run(
        f.base,
        String.raw`
$oldValues.InstallLocation.Value=$neighbor
Assert-FixtureDenied {Save-YoutabUpdateRegistration $txn}
if($script:openedViews.Contains('Registry32')){throw 'Foreign preferred view was bypassed.'}
$oldValues.InstallLocation.Value=$install
$script:fakeViews.Registry32=$script:fakeViews.Registry64;$script:fakeViews.Registry64=$null
[void](Save-YoutabUpdateRegistration $txn)
if((Read-YoutabUpdateRegistration $txn).Registry.View -cne 'Registry32'){throw 'Actual registry view was not captured.'}
[void](Restore-YoutabUpdateRegistration $txn)
Assert-FixtureOriginalMetadata
`
      )
    } finally {
      f.dispose()
    }
  })

  it('refuses restoration if the fixed uninstall key was rebound to another installation', () => {
    const f = fixture()

    try {
      run(
        f.base,
        String.raw`
[void](Save-YoutabUpdateRegistration $txn)
[IO.File]::WriteAllText([IO.Path]::Combine($install,'unins000.exe'),'new bytes must remain')
$oldValues.InstallLocation.Value=$neighbor
Assert-FixtureDenied {Restore-YoutabUpdateRegistration $txn}
if([IO.File]::ReadAllText([IO.Path]::Combine($install,'unins000.exe')) -cne 'new bytes must remain' -or $script:registryWrites -ne 0){throw 'Foreign registration changed before recovery was refused.'}
`
      )
    } finally {
      f.dispose()
    }
  })

  it.each(['exit', 'manifest', 'build', 'sequence', 'setupHash', 'registry', 'uninstallPair'] as const)(
    'refuses registration success when %s is invalid',
    (failure) => {
      const f = fixture()

      try {
        run(
          f.base,
          registrationFixture(failure) +
            String.raw`
Assert-FixtureDenied {Register-YoutabUpdatedPayload $txn $installer $expectedManifest 9 $expectedBuild}
if($script:runnerCalls -ne 1){throw 'Registration runner count changed.'}
`
        )
      } finally {
        f.dispose()
      }
    }
  )

  it('acknowledges only exit0 plus exact manifest/build/sequence/Installer hash using raw logical arguments', () => {
    const f = fixture()

    try {
      run(
        f.base,
        registrationFixture('valid') +
          String.raw`
$result=@(Register-YoutabUpdatedPayload $txn $installer $expectedManifest 9 $expectedBuild)
if($result.Count -ne 1 -or $result[0] -isnot [bool] -or -not $result[0]){throw 'No explicit registration success ACK.'}
if($script:runnerExe -cne $installer -or $script:runnerTimeout -ne 600000 -or ($script:runnerArguments[0..3] -join '|') -cne '/YOUTABREGISTERONLY|/VERYSILENT|/SUPPRESSMSGBOXES|/NORESTART' -or $script:runnerArguments[4] -cne ('/DIR='+$install) -or $script:runnerArguments[5] -cne ('/LOG='+[IO.Path]::Combine($directory,'register.log'))){throw 'Native registration argv changed.'}
`
      )
    } finally {
      f.dispose()
    }
  })
})

function registrationFixture(
  failure: 'exit' | 'manifest' | 'build' | 'sequence' | 'setupHash' | 'registry' | 'uninstallPair' | 'valid'
) {
  return String.raw`
[void](Save-YoutabUpdateRegistration $txn)
$installer=[IO.Path]::Combine($directory,'Synthetic Installer.exe')
[IO.File]::WriteAllText($installer,'SYNTHETIC NONEXECUTABLE INSTALLER')
$expectedBuild='b'*64
$expectedManifest=Get-YoutabUpdateHash ([IO.Path]::Combine($install,'.youtab-install-files.json'))
$script:runnerCalls=0
function Invoke-YoutabBoundedInstaller([string]$Exe,[string[]]$Arguments,[int]$TimeoutMilliseconds) {
  $script:runnerCalls++;$script:runnerExe=$Exe;$script:runnerArguments=$Arguments;$script:runnerTimeout=$TimeoutMilliseconds
  $runtime=[IO.Path]::Combine($install,'youtab-agent-runtime');[void][IO.Directory]::CreateDirectory($runtime)
  $marker=@{buildId=$expectedBuild;releaseSequence=9;installedSetupSha256=(Get-YoutabUpdateHash $Exe)}
  ${failure === 'build' ? "$marker.buildId='c'*64" : ''}
  ${failure === 'sequence' ? '$marker.releaseSequence=8' : ''}
  ${failure === 'setupHash' ? "$marker.installedSetupSha256='d'*64" : ''}
  [IO.File]::WriteAllText([IO.Path]::Combine($runtime,'.youtab-agent-runtime-bootstrap-complete'),($marker|ConvertTo-Json -Compress))
  ${failure === 'manifest' ? "[IO.File]::WriteAllText([IO.Path]::Combine($install,'.youtab-install-files.json'),'wrong new manifest')" : ''}
  ${failure === 'registry' ? '$script:fakeViews.Registry64=$null' : ''}
  ${failure === 'uninstallPair' ? "[IO.File]::Delete([IO.Path]::Combine($install,'unins000.dat'))" : ''}
  return ${failure === 'exit' ? '2' : '0'}
}
`
}
