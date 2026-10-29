import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { INNO_UPDATE_TRANSACTION_FUNCTIONS } from './inno-update-transaction'
import { WINDOWS_OWNED_TREE_FUNCTIONS } from './windows-full-uninstall'

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-inno-transaction-'))

  const verify = () => {
    if (!path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(base).startsWith('youtab-inno-transaction-')) {throw new Error('Fixture escaped temporary boundary')}
  }

  verify()

  return { base, dispose() { verify(); fs.rmSync(base, { recursive: true, force: true }) } }
}

const setup = String.raw`
function Assert-FixtureDenied([scriptblock]$Action) {
  $denied=$false
  try {& $Action}catch{$denied=$true}
  if(-not $denied) {throw 'Expected the fixture operation to be refused.'}
}
$install=[IO.Path]::Combine($base,'Owned installation')
New-YoutabPrivateUpdateDirectory $install
$updates=[IO.Path]::Combine($install,'.youtab-updates')
New-YoutabPrivateUpdateDirectory $updates
foreach($name in $YoutabProgramRoots) {
  $root=[IO.Path]::Combine($install,$name)
  [void][IO.Directory]::CreateDirectory($root)
  [IO.File]::WriteAllText(([IO.Path]::Combine($root,'version.txt')),('old:'+ $name))
}
$preserved=@{}
foreach($relative in @('state.db','state.db-wal','sessions\synthetic.json','profiles\work\auth.json','profiles\work\config.yaml')) {
  $file=[IO.Path]::Combine($install,$relative)
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
  [IO.File]::WriteAllText($file,('SYNTHETIC DATA ONLY: '+$relative))
  $preserved[$file]=Get-YoutabUpdateHash $file
}
$neighbor=[IO.Path]::Combine($base,'Other installation')
[void][IO.Directory]::CreateDirectory($neighbor)
$neighborFile=[IO.Path]::Combine($neighbor,'sentinel.txt')
[IO.File]::WriteAllText($neighborFile,'FOREIGN TEST SENTINEL')
$preserved[$neighborFile]=Get-YoutabUpdateHash $neighborFile
$registration=[IO.Path]::Combine($install,'unins000.dat')
[IO.File]::WriteAllText($registration,'old synthetic registration')
$txn=New-YoutabProgramTransaction $install ([IO.Path]::Combine($updates,('transaction-'+[Guid]::NewGuid().ToString('N'))))
foreach($name in $YoutabProgramRoots) {
  $root=[IO.Path]::Combine($txn.Directory,'payload',$name)
  [void][IO.Directory]::CreateDirectory($root)
  [IO.File]::WriteAllText(([IO.Path]::Combine($root,'version.txt')),('new:'+ $name))
}
function Assert-FixturePreserved {
  foreach($file in $preserved.Keys) {if((Get-YoutabUpdateHash $file) -cne $preserved[$file]) {throw 'User data or foreign sentinel changed.'}}
}
function Assert-FixturePrograms([string]$Prefix) {
  foreach($name in $YoutabProgramRoots) {
    if([IO.File]::ReadAllText([IO.Path]::Combine($install,$name,'version.txt')) -cne ($Prefix+':'+$name)) {throw ('Unexpected program root: '+$name)}
  }
}
$script:registerCalls=0
$script:restoreCalls=0
$goodHealth={return $true}
$goodRegister={$script:registerCalls++;return $true}
$restoreRegistration={$script:restoreCalls++;[IO.File]::WriteAllText($registration,'old synthetic registration');return $true}
`

function run(base: string, body: string) {
  const encoded = Buffer.from(base, 'utf8').toString('base64')
  const source = `$ErrorActionPreference='Stop'\n${WINDOWS_OWNED_TREE_FUNCTIONS}\n${INNO_UPDATE_TRANSACTION_FUNCTIONS}\n$base=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))\n${setup}\n${body}\nAssert-FixturePreserved\n'TRANSACTION_FIXTURE_OK'`

  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: `& {\ntry {\n${source}\n} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }\n}\n\n`,
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024
  })

  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stdout, result.stderr).toContain('TRANSACTION_FIXTURE_OK')
}

describe.runIf(process.platform === 'win32')('native Inno transaction fixtures (no Installer or real account)', () => {
  it.each(['false', 'throw'])('retains pending registration and programs when metadata restore returns %s', (mode) => {
    const f = fixture()

    try { run(f.base, String.raw`
$badRegister={[IO.File]::WriteAllText($registration,'partial synthetic registration');return $false}
$badRestore={${mode === 'false' ? 'return $false' : "throw 'Synthetic metadata restore failure'"}}
Assert-FixtureDenied {Invoke-YoutabProgramPromotion $txn $goodHealth $badRegister $badRestore}
if((Read-YoutabUpdateJournal $txn).status -cne 'registering') {throw 'Failed metadata restoration claimed a terminal state.'}
Assert-FixturePrograms 'new'
if([IO.File]::ReadAllText($registration) -cne 'partial synthetic registration') {throw 'Unacknowledged metadata was hidden.'}
if(-not (Recover-YoutabProgramTransaction $txn $restoreRegistration)) {throw 'Later explicit recovery did not succeed.'}
Assert-FixturePrograms 'old'
if((Read-YoutabUpdateJournal $txn).status -cne 'rolled-back') {throw 'Later recovery did not reach terminal rollback.'}
`) } finally { f.dispose() }
  })
  it('reconstructs durable original identities and idempotently recovers a partially moved crash state', () => {
    const f = fixture()

    try { run(f.base, String.raw`
Write-YoutabUpdateJournal $txn 'promoting'
[IO.Directory]::Move(([IO.Path]::Combine($install,'bin')),([IO.Path]::Combine($txn.Directory,'rollback','bin')))
[IO.Directory]::Move(([IO.Path]::Combine($txn.Directory,'payload','bin')),([IO.Path]::Combine($install,'bin')))
[IO.Directory]::Move(([IO.Path]::Combine($install,'git')),([IO.Path]::Combine($txn.Directory,'rollback','git')))
$directory=$txn.Directory;$txn=$null
$opened=Open-YoutabProgramTransaction $install $directory
if((Read-YoutabUpdateJournal $opened).status -cne 'promoting' -or $opened.RegistrationAttempted) {throw 'Durable transaction did not reconstruct.'}
$ack=@(Recover-YoutabProgramTransaction $opened)
if($ack.Count -ne 1 -or $ack[0] -isnot [bool] -or -not $ack[0]) {throw 'Recovery did not explicitly acknowledge.'}
Assert-FixturePrograms 'old'
if(-not (Recover-YoutabProgramTransaction (Open-YoutabProgramTransaction $install $directory))) {throw 'Repeated recovered transaction changed its result.'}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it('retains registration-attempt knowledge across a rolling-back crash and requires exact restoration ACK', () => {
    const f = fixture()

    try { run(f.base, String.raw`
foreach($name in $YoutabProgramRoots) {
 [IO.Directory]::Move(([IO.Path]::Combine($install,$name)),([IO.Path]::Combine($txn.Directory,'rollback',$name)))
 [IO.Directory]::Move(([IO.Path]::Combine($txn.Directory,'payload',$name)),([IO.Path]::Combine($install,$name)))
}
Write-YoutabUpdateJournal $txn 'registering'
[IO.File]::WriteAllText($registration,'partial synthetic registration')
Write-YoutabUpdateJournal $txn 'rolling-back'
$directory=$txn.Directory;$txn=$null
$opened=Open-YoutabProgramTransaction $install $directory
if(-not $opened.RegistrationAttempted) {throw 'Registration attempt was forgotten after crash.'}
Assert-FixtureDenied {Recover-YoutabProgramTransaction $opened}
Assert-FixtureDenied {Recover-YoutabProgramTransaction $opened {return $false}}
Assert-FixturePrograms 'new'
if(-not (Recover-YoutabProgramTransaction $opened $restoreRegistration)) {throw 'Registration recovery failed.'}
Assert-FixturePrograms 'old'
if($script:restoreCalls -ne 1 -or [IO.File]::ReadAllText($registration) -cne 'old synthetic registration') {throw 'Registration was not restored once.'}
[void](Recover-YoutabProgramTransaction (Open-YoutabProgramTransaction $install $directory) {throw 'Idempotent recovery must not call registration again.'})
`) } finally { f.dispose() }
  })

  it('opens a committed journal without downgrading or invoking restoration again', () => {
    const f = fixture()

    try { run(f.base, String.raw`
Invoke-YoutabProgramPromotion $txn $goodHealth $goodRegister $restoreRegistration
$opened=Open-YoutabProgramTransaction $install $txn.Directory
if(-not (Recover-YoutabProgramTransaction $opened {throw 'Committed recovery cannot restore registration.'})) {throw 'Committed recovery did not acknowledge.'}
if((Read-YoutabUpdateJournal $opened).status -cne 'committed' -or $script:restoreCalls) {throw 'Committed state was changed.'}
Assert-FixturePrograms 'new'
`) } finally { f.dispose() }
  })

  it('refuses escaped transaction paths and altered durable original IDs without moving live files', () => {
    const f = fixture()

    try { run(f.base, String.raw`
Assert-FixtureDenied {Open-YoutabProgramTransaction $install $neighbor}
$file=[IO.Path]::Combine($txn.Directory,'journal.json')
$document=[IO.File]::ReadAllText($file)|ConvertFrom-Json
$document.originalRootIds.bin='00000000:0000000000000000'
[IO.File]::WriteAllText($file,($document|ConvertTo-Json -Depth 6 -Compress))
Assert-FixtureDenied {Open-YoutabProgramTransaction $install $txn.Directory}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it('drains uncertain Installer jobs before the first registry or program rollback', () => {
    const f = fixture()

    try { run(f.base, String.raw`
$script:drainCalls=0
function Test-YoutabInstallerJobsDrained {
 $script:drainCalls++
 if($script:restoreCalls -ne 0) {throw 'Registration rollback started before the job drained.'}
 Assert-FixturePrograms 'new'
 if([IO.File]::ReadAllText($registration) -cne 'still-writing synthetic registration') {throw 'Registration files changed before drain.'}
 return ($script:drainCalls -ge 3)
}
$unsafeRegister={[IO.File]::WriteAllText($registration,'still-writing synthetic registration');throw 'YOUTAB_INSTALLER_STILL_RUNNING'}
Assert-FixtureDenied {Invoke-YoutabProgramPromotion $txn $goodHealth $unsafeRegister $restoreRegistration}
if($script:drainCalls -lt 3 -or $script:restoreCalls -ne 1 -or (Read-YoutabUpdateJournal $txn).status -cne 'rolled-back') {throw 'Drain and rollback ordering failed.'}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it('refuses rollback when a still-running job cannot supply a native drain checker', () => {
    const f = fixture()

    try { run(f.base, String.raw`
$unsafeRegister={throw 'YOUTAB_INSTALLER_STILL_RUNNING'}
Assert-FixtureDenied {Invoke-YoutabProgramPromotion $txn $goodHealth $unsafeRegister $restoreRegistration}
if($script:restoreCalls -or (Read-YoutabUpdateJournal $txn).status -cne 'registering') {throw 'Unknown live writer was rolled back.'}
Assert-FixturePrograms 'new'
`) } finally { f.dispose() }
  })

  it('commits all five program roots only after positive health/registration and refuses committed rollback', () => {
    const f = fixture()

    try { run(f.base, String.raw`
Invoke-YoutabProgramPromotion $txn $goodHealth $goodRegister $restoreRegistration
if((Read-YoutabUpdateJournal $txn).status -cne 'committed' -or $script:registerCalls -ne 1 -or $script:restoreCalls) {throw 'Commit contract failed.'}
Assert-FixturePrograms 'new'
Assert-FixtureDenied {Restore-YoutabProgramTransaction $txn}
Assert-FixturePrograms 'new'
`) } finally { f.dispose() }
  })

  it.each(['health', 'registration'])('rolls back all roots on an explicit false %s result, without claiming success', (phase) => {
    const f = fixture()

    try { run(f.base, phase === 'health' ? String.raw`
Assert-FixtureDenied {Invoke-YoutabProgramPromotion $txn {return $false} $goodRegister $restoreRegistration}
if((Read-YoutabUpdateJournal $txn).status -cne 'rolled-back' -or $script:registerCalls -or $script:restoreCalls) {throw 'Health refusal did not restore programs before registration.'}
Assert-FixturePrograms 'old'
` : String.raw`
$badRegister={$script:registerCalls++;[IO.File]::WriteAllText($registration,'partial synthetic registration');return $false}
Assert-FixtureDenied {Invoke-YoutabProgramPromotion $txn $goodHealth $badRegister $restoreRegistration}
if((Read-YoutabUpdateJournal $txn).status -cne 'rolled-back' -or $script:registerCalls -ne 1 -or $script:restoreCalls -ne 1 -or [IO.File]::ReadAllText($registration) -cne 'old synthetic registration') {throw 'Registration failure did not restore metadata.'}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it.each(['old-renamed', 'partially-promoted'])('recovers %s crash state idempotently from native directory identities', (phase) => {
    const f = fixture()

    try { run(f.base, String.raw`
Write-YoutabUpdateJournal $txn 'promoting'
[IO.Directory]::Move(([IO.Path]::Combine($install,'bin')),([IO.Path]::Combine($txn.Directory,'rollback','bin')))
` + (phase === 'partially-promoted' ? String.raw`
[IO.Directory]::Move(([IO.Path]::Combine($txn.Directory,'payload','bin')),([IO.Path]::Combine($install,'bin')))
[IO.Directory]::Move(([IO.Path]::Combine($install,'git')),([IO.Path]::Combine($txn.Directory,'rollback','git')))
` : '') + String.raw`
Restore-YoutabProgramTransaction $txn
Restore-YoutabProgramTransaction $txn
if((Read-YoutabUpdateJournal $txn).status -cne 'rolled-back') {throw 'Crash recovery did not finish.'}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it('refuses to call a new live tree original when its actual rollback root is missing', () => {
    const f = fixture()

    try { run(f.base, String.raw`
Write-YoutabUpdateJournal $txn 'promoting'
[IO.Directory]::Move(([IO.Path]::Combine($install,'bin')),([IO.Path]::Combine($txn.Directory,'rollback','bin')))
[IO.Directory]::Move(([IO.Path]::Combine($txn.Directory,'payload','bin')),([IO.Path]::Combine($install,'bin')))
[IO.Directory]::Move(([IO.Path]::Combine($txn.Directory,'rollback','bin')),([IO.Path]::Combine($txn.Directory,'metadata','retained-original-bin')))
Assert-FixtureDenied {Restore-YoutabProgramTransaction $txn}
if((Read-YoutabUpdateJournal $txn).status -ceq 'rolled-back') {throw 'Incomplete recovery was labeled successful.'}
if([IO.File]::ReadAllText([IO.Path]::Combine($txn.Directory,'metadata','retained-original-bin','version.txt')) -cne 'old:bin') {throw 'Original recovery evidence was lost.'}
`) } finally { f.dispose() }
  })

  it('refuses an invalid journal identity before moving programs', () => {
    const f = fixture()

    try { run(f.base, String.raw`
$file=[IO.Path]::Combine($txn.Directory,'journal.json')
$journal=[IO.File]::ReadAllText($file)|ConvertFrom-Json
$journal.installRoot=$neighbor
[IO.File]::WriteAllText($file,($journal|ConvertTo-Json -Depth 6 -Compress))
Assert-FixtureDenied {Restore-YoutabProgramTransaction $txn}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it('refuses a staged directory junction before changing live roots', () => {
    const f = fixture()

    try { run(f.base, String.raw`
$staged=[IO.Path]::Combine($txn.Directory,'payload','bin')
[IO.Directory]::Move($staged,([IO.Path]::Combine($txn.Directory,'metadata','original-stage-bin')))
New-Item -ItemType Junction -Path $staged -Target $neighbor -ErrorAction Stop|Out-Null
Assert-FixtureDenied {Invoke-YoutabProgramPromotion $txn $goodHealth $goodRegister $restoreRegistration}
if((Read-YoutabUpdateJournal $txn).status -cne 'prepared' -or $script:registerCalls) {throw 'Reparse failure mutated the transaction.'}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it('verifies a complete real-byte manifest and refuses bool sizes, extra files, and tampering', () => {
    const f = fixture()

    try { run(f.base, String.raw`
$payload=[IO.Path]::Combine($txn.Directory,'payload')
$entries=@(foreach($name in $YoutabProgramRoots) {
  $file=[IO.Path]::Combine($payload,$name,'version.txt')
  [pscustomobject]@{path=($name+'/version.txt');sha256=(Get-YoutabUpdateHash $file);size=[long](Get-Item -LiteralPath $file).Length}
})
$contract=$entries[0]
$contractHasher=[Security.Cryptography.SHA256]::Create()
try {$contractDigest=([BitConverter]::ToString($contractHasher.ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes(([string]$contract.path+[char]0+[string]$contract.sha256+[char]10))))).Replace('-','').ToLowerInvariant()}finally{$contractHasher.Dispose()}
$manifest=[pscustomobject]@{schemaVersion=1;dataContractsSha256=$contractDigest;dataContracts=@($contract);roots=$YoutabProgramRoots;files=$entries}
$manifestFile=[IO.Path]::Combine($payload,'.youtab-install-files.json')
[IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6 -Compress))
[void](Assert-YoutabPayloadManifest $payload (Get-YoutabUpdateHash $manifestFile) $contractDigest)
$manifest.dataContracts=@()
[IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6 -Compress))
Assert-FixtureDenied {Assert-YoutabPayloadManifest $payload (Get-YoutabUpdateHash $manifestFile) $contractDigest}
$manifest.dataContracts=@($contract,$contract)
[IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6 -Compress))
Assert-FixtureDenied {Assert-YoutabPayloadManifest $payload (Get-YoutabUpdateHash $manifestFile) $contractDigest}
$manifest.dataContracts=@($contract)
$manifest.dataContractsSha256=('c'*64)
[IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6 -Compress))
Assert-FixtureDenied {Assert-YoutabPayloadManifest $payload (Get-YoutabUpdateHash $manifestFile) ('c'*64)}
$manifest.dataContractsSha256=$contractDigest
$entries[0].size=$false
[IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6 -Compress))
Assert-FixtureDenied {Assert-YoutabPayloadManifest $payload (Get-YoutabUpdateHash $manifestFile) $contractDigest}
$entries[0].size=[long](Get-Item -LiteralPath ([IO.Path]::Combine($payload,'bin','version.txt'))).Length
[IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6 -Compress))
$extra=[IO.Path]::Combine($payload,'bin','extra.txt')
[IO.File]::WriteAllText($extra,'UNLISTED SYNTHETIC FILE')
Assert-FixtureDenied {Assert-YoutabPayloadManifest $payload (Get-YoutabUpdateHash $manifestFile) $contractDigest}
[IO.File]::Delete($extra)
[IO.File]::AppendAllText(([IO.Path]::Combine($payload,'bin','version.txt')),'tampered')
Assert-FixtureDenied {Assert-YoutabPayloadManifest $payload (Get-YoutabUpdateHash $manifestFile) $contractDigest}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it('refuses descendant-delete permission granted to an unrelated principal in a test-owned staging directory', () => {
    const f = fixture()

    try { run(f.base, String.raw`
$payload=[IO.Path]::Combine($txn.Directory,'payload')
$acl=(New-Object IO.DirectoryInfo($payload)).GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
$world=New-Object Security.Principal.SecurityIdentifier 'S-1-1-0'
$rule=New-Object Security.AccessControl.FileSystemAccessRule($world,'DeleteSubdirectoriesAndFiles','ContainerInherit,ObjectInherit','None','Allow')
[void]$acl.AddAccessRule($rule)
(New-Object IO.DirectoryInfo($payload)).SetAccessControl($acl)
Assert-FixtureDenied {Assert-YoutabPrivateUpdateDirectory $payload}
Assert-FixturePrograms 'old'
`) } finally { f.dispose() }
  })

  it('refuses a substituted live root before promotion or registration begins', () => {
    const f = fixture()

    try { run(f.base, String.raw`
$retained=[IO.Path]::Combine($txn.Directory,'metadata','retained-original-bin')
[IO.Directory]::Move(([IO.Path]::Combine($install,'bin')),$retained)
[IO.Directory]::Move(([IO.Path]::Combine($txn.Directory,'payload','bin')),([IO.Path]::Combine($install,'bin')))
Assert-FixtureDenied {Invoke-YoutabProgramPromotion $txn $goodHealth $goodRegister $restoreRegistration}
if((Read-YoutabUpdateJournal $txn).status -cne 'prepared' -or $script:registerCalls -or $script:restoreCalls) {throw 'A substituted root reached mutation or registration.'}
if([IO.File]::ReadAllText([IO.Path]::Combine($retained,'version.txt')) -cne 'old:bin') {throw 'Retained original was altered.'}
foreach($name in @('git','node','python','youtab-agent-runtime')) {
  if([IO.File]::ReadAllText([IO.Path]::Combine($install,$name,'version.txt')) -cne ('old:'+ $name)) {throw 'An unrelated program root was moved.'}
}
`) } finally { f.dispose() }
  })
})
