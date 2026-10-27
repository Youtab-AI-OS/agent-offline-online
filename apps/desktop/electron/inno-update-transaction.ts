import { INNO_UPDATE_INSTALLER_JOB_FUNCTIONS } from './inno-update-installer-job'
import { INNO_UPDATE_REGISTRATION_FUNCTIONS } from './inno-update-registration'
/** Fixed-root program transaction. No customer HOME/profile/database deletion. */
import type { CommonWindowsUninstallPlan, UninstallHandoff } from './windows-full-uninstall'
import { WINDOWS_OWNED_TREE_FUNCTIONS } from './windows-full-uninstall'
import { WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS } from './windows-uninstall-gateway-processes'
import { WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS } from './windows-uninstall-resources'

export interface InnoUpdateTransactionPlan {
  installation: CommonWindowsUninstallPlan
  handoff: UninstallHandoff
  installer: string
  envelope: string
  publicKeyBlob: string
  keyId: string
  payloadSha256: string
  dataContractsSha256: string
  expectedSequence: number
  expectedBuildId: string
}

export const INNO_UPDATE_TRANSACTION_FUNCTIONS = String.raw`
$env:PSModulePath = [IO.Path]::Combine($PSHOME,'Modules')
$YoutabProgramRoots = @('bin','git','node','python','youtab-agent-runtime')
function Initialize-YoutabUpdateFileNative {
  if ('YoutabUpdateFileNative' -as [type]) {return}
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class YoutabUpdateFileNative {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct Information { public uint Attributes; public FileTime Creation,Access,Write; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Information information);
  public static string DirectoryIdentity(string path) {
    using(var handle=CreateFile(path,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception();
      Information info;
      if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception();
      if((info.Attributes & 0x400)!=0 || (info.Attributes & 0x10)==0) throw new InvalidOperationException("Program root is not a regular directory.");
      return info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8");
    }
  }
}
'@ -ErrorAction Stop
}
function Get-YoutabUpdateDirectoryId([string]$Path) {
  Assert-NoReparseAncestors $Path
  Initialize-YoutabUpdateFileNative
  return [YoutabUpdateFileNative]::DirectoryIdentity($Path)
}
function Get-YoutabUpdateHash([string]$Path) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $hash=[Security.Cryptography.SHA256]::Create()
  try {return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
  finally {$hash.Dispose();$stream.Dispose()}
}
function Assert-YoutabPrivateUpdateDirectory([string]$Directory) {
  Assert-NoReparseAncestors $Directory
  $item=Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {throw 'Update directory is not a regular directory.'}
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl=Get-Acl -LiteralPath $Directory
  $owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $sid) {throw 'Update directory is not owned by the current user.'}
  $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach($rule in $acl.Access) {
    $principal=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $write) -ne 0 -and $principal -notin @($sid,'S-1-5-18','S-1-5-32-544')) {throw 'Update directory permits another principal to modify staged programs.'}
  }
}
function New-YoutabPrivateUpdateDirectory([string]$Directory) {
  if (Test-Path -LiteralPath $Directory) {throw 'Update destination already exists.'}
  Assert-NoReparseAncestors ([IO.Path]::GetDirectoryName($Directory))
  [void][IO.Directory]::CreateDirectory($Directory)
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
  foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))) {
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Directory -AclObject $acl
  Assert-YoutabPrivateUpdateDirectory $Directory
}
function Write-YoutabUpdateJournal($Transaction,[string]$Status) {
  if ($Status -notin @('prepared','promoting','registering','committed','rolling-back','rolled-back')) {throw 'Invalid update journal state.'}
  Assert-YoutabPrivateUpdateDirectory $Transaction.Directory
  if ($Status -eq 'registering') {$Transaction.RegistrationAttempted=$true}
  $document=[ordered]@{schemaVersion=1;id=$Transaction.Id;installRoot=$Transaction.InstallRoot;status=$Status;registrationAttempted=[bool]$Transaction.RegistrationAttempted;roots=$YoutabProgramRoots;originalRootIds=$Transaction.OriginalRootIds;time=[DateTime]::UtcNow.ToString('o')}
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($document|ConvertTo-Json -Depth 5 -Compress))
  $journal=[IO.Path]::Combine($Transaction.Directory,'journal.json')
  $temporary=[IO.Path]::Combine($Transaction.Directory,('journal-write-'+[Guid]::NewGuid().ToString('N')))
  $stream=New-Object IO.FileStream($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
  if (Test-Path -LiteralPath $journal) {
    if (((Get-Item -LiteralPath $journal -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Update journal is a reparse object.'}
    [IO.File]::Replace($temporary,$journal,[Management.Automation.Language.NullString]::Value)
  } else {[IO.File]::Move($temporary,$journal)}
}
function Read-YoutabUpdateJournal($Transaction) {
  Assert-YoutabPrivateUpdateDirectory $Transaction.Directory
  $file=[IO.Path]::Combine($Transaction.Directory,'journal.json')
  $info=Get-Item -LiteralPath $file -Force -ErrorAction Stop
  if ($info.PSIsContainer -or $info.Length -gt 65536 -or (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {throw 'Unsafe update journal.'}
  $value=[IO.File]::ReadAllText($file)|ConvertFrom-Json
  if ($value.schemaVersion -ne 1 -or $value.id -cne $Transaction.Id -or $value.installRoot -cne $Transaction.InstallRoot -or $value.registrationAttempted -isnot [bool] -or (@($value.roots)-join '|') -cne ($YoutabProgramRoots-join '|') -or $value.status -notin @('prepared','promoting','registering','committed','rolling-back','rolled-back')) {throw 'Update journal identity is invalid.'}
  $actualNames=(@($value.originalRootIds.PSObject.Properties.Name)|Sort-Object)-join '|'
  $expectedNames=(@($YoutabProgramRoots)|Sort-Object)-join '|'
  if ($actualNames -cne $expectedNames) {throw 'Missing original program identity.'}
  foreach($name in $YoutabProgramRoots) {
    if ($value.originalRootIds.$name -cnotmatch '^[0-9a-f]{8}:[0-9a-f]{16}$' -or $value.originalRootIds.$name -cne $Transaction.OriginalRootIds.$name) {throw 'Original program identity changed.'}
  }
  return $value
}
function New-YoutabProgramTransaction([string]$InstallRoot,[string]$Directory) {
  Assert-YoutabPrivateUpdateDirectory $InstallRoot
  $id=[IO.Path]::GetFileName($Directory)
  if ($id -notmatch '^transaction-[0-9a-f]{32}$') {throw 'Invalid update transaction name.'}
  $parent=[IO.Path]::GetDirectoryName($Directory)
  if (-not ([IO.Path]::GetFullPath($parent).Equals([IO.Path]::Combine([IO.Path]::GetFullPath($InstallRoot),'.youtab-updates'),[StringComparison]::OrdinalIgnoreCase))) {throw 'Update transaction escaped its installation.'}
  Assert-YoutabPrivateUpdateDirectory $parent
  New-YoutabPrivateUpdateDirectory $Directory
  foreach($name in @('payload','rollback','failed','metadata')) {New-YoutabPrivateUpdateDirectory ([IO.Path]::Combine($Directory,$name))}
  $identities=[ordered]@{}
  foreach($name in $YoutabProgramRoots) {$identities[$name]=Get-YoutabUpdateDirectoryId ([IO.Path]::Combine($InstallRoot,$name))}
  $transaction=[pscustomobject]@{Id=$id;InstallRoot=[IO.Path]::GetFullPath($InstallRoot);Directory=[IO.Path]::GetFullPath($Directory);OriginalRootIds=$identities;RegistrationAttempted=$false}
  Write-YoutabUpdateJournal $transaction 'prepared'
  return $transaction
}
function Open-YoutabProgramTransaction([string]$InstallRoot,[string]$Directory) {
  $root=[IO.Path]::GetFullPath($InstallRoot)
  $directory=[IO.Path]::GetFullPath($Directory)
  $id=[IO.Path]::GetFileName($directory)
  if ($id -cnotmatch '^transaction-[0-9a-f]{32}$' -or -not $directory.Equals([IO.Path]::Combine($root,'.youtab-updates',$id),[StringComparison]::OrdinalIgnoreCase)) {throw 'Recovery transaction escaped its installation.'}
  Assert-YoutabPrivateUpdateDirectory $root
  Assert-YoutabPrivateUpdateDirectory ([IO.Path]::Combine($root,'.youtab-updates'))
  Assert-YoutabPrivateUpdateDirectory $directory
  foreach($name in @('payload','rollback','failed','metadata')) {Assert-YoutabPrivateUpdateDirectory ([IO.Path]::Combine($directory,$name))}
  $file=[IO.Path]::Combine($directory,'journal.json')
  Assert-NoReparseAncestors $file
  $info=Get-Item -LiteralPath $file -Force -ErrorAction Stop
  if ($info.PSIsContainer -or $info.Length -gt 65536 -or (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {throw 'Unsafe recovery journal.'}
  $value=[IO.File]::ReadAllText($file)|ConvertFrom-Json
  $identities=[ordered]@{}
  foreach($name in $YoutabProgramRoots) {$identities[$name]=[string]$value.originalRootIds.$name}
  $transaction=[pscustomobject]@{Id=$id;InstallRoot=$root;Directory=$directory;OriginalRootIds=$identities;RegistrationAttempted=$value.registrationAttempted}
  $journal=Read-YoutabUpdateJournal $transaction
  foreach($name in $YoutabProgramRoots) {
    $retained=[IO.Path]::Combine($directory,'rollback',$name)
    $live=[IO.Path]::Combine($root,$name)
    Assert-NoReparseAncestors $retained;Assert-NoReparseAncestors $live
    if (Test-Path -LiteralPath $retained) {$original=$retained} else {$original=$live}
    if (-not (Test-Path -LiteralPath $original -PathType Container) -or (Get-YoutabUpdateDirectoryId $original) -cne $identities[$name]) {throw 'Recovery cannot prove an original program root identity.'}
  }
  return $transaction
}
function Wait-YoutabProgramInstallerDrain([string]$Failure='') {
  $checker=Get-Command 'Test-YoutabInstallerJobsDrained' -CommandType Function -ErrorAction SilentlyContinue
  if (-not $checker) {
    if ($Failure.Contains('YOUTAB_INSTALLER_STILL_RUNNING')) {throw 'YOUTAB_INSTALLER_STILL_RUNNING: native job drain is unavailable; rollback is refused.'}
    return
  }
  while ($true) {
    try {$drained=@(Test-YoutabInstallerJobsDrained)} catch {throw ('YOUTAB_INSTALLER_STILL_RUNNING: job drain could not be proved: '+$_.Exception.Message)}
    if ($drained.Count -ne 1 -or $drained[0] -isnot [bool]) {throw 'YOUTAB_INSTALLER_STILL_RUNNING: native job drain did not explicitly acknowledge.'}
    if ($drained[0]) {return}
    Start-Sleep -Milliseconds 500
  }
}
function Recover-YoutabProgramTransaction($Transaction,[scriptblock]$RestoreRegistration) {
  [void](Read-YoutabUpdateJournal $Transaction)
  $opened=Open-YoutabProgramTransaction $Transaction.InstallRoot $Transaction.Directory
  $journal=Read-YoutabUpdateJournal $opened
  if ($journal.status -in @('committed','rolled-back')) {return $true}
  # Caller must first hold the exclusive installation lease and admit that no prior writer is live.
  Wait-YoutabProgramInstallerDrain
  if ($journal.registrationAttempted) {
    if (-not $RestoreRegistration) {throw 'Recovery requires explicit registration restoration.'}
    $ack=@(& $RestoreRegistration $opened)
    if ($ack.Count -ne 1 -or $ack[0] -isnot [bool] -or -not $ack[0]) {throw 'Recovery registration restoration did not explicitly pass.'}
  }
  Restore-YoutabProgramTransaction $opened
  if ((Read-YoutabUpdateJournal $opened).status -cne 'rolled-back') {throw 'Recovery did not reach its acknowledged rollback state.'}
  return $true
}
function Assert-YoutabPayloadManifest([string]$PayloadRoot,[string]$ManifestSha256,[string]$DataContractsSha256) {
  Assert-YoutabPrivateUpdateDirectory $PayloadRoot
  $file=[IO.Path]::Combine($PayloadRoot,'.youtab-install-files.json')
  $info=Get-Item -LiteralPath $file -Force -ErrorAction Stop
  if ($info.Length -gt 64MB -or $info.PSIsContainer -or (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or (Get-YoutabUpdateHash $file) -cne $ManifestSha256) {throw 'Signed program manifest does not match the staged payload.'}
  $manifest=[IO.File]::ReadAllText($file)|ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.dataContractsSha256 -cne $DataContractsSha256 -or (@($manifest.roots)-join '|') -cne ($YoutabProgramRoots-join '|') -or @($manifest.files).Count -lt 5 -or @($manifest.files).Count -gt 100000) {throw 'Incompatible data contract or program manifest.'}
  $expected=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $fileEntries=New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
  [long]$total=0
  foreach($entry in @($manifest.files)) {
    $relative=[string]$entry.path
    if (-not $relative -or $relative.Contains('\') -or $relative.Contains(':') -or $relative.StartsWith('/') -or $relative -match '[\x00-\x1f]' -or $relative.Split('/')[0] -notin $YoutabProgramRoots -or $relative.Split('/').Count -lt 2 -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or ($entry.size -isnot [int] -and $entry.size -isnot [long]) -or [long]$entry.size -lt 0 -or [long]$entry.size -gt 8GB) {throw 'Unsafe program manifest entry.'}
    foreach($part in $relative.Split('/')) {if ($part -in @('','.', '..') -or $part -match '[. ]$|^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {throw 'Aliased program manifest path.'}}
    if (-not $expected.Add($relative)) {throw 'Duplicate program manifest destination.'}
    $fileEntries.Add($relative,$entry)
    $target=[IO.Path]::Combine($PayloadRoot,$relative.Replace('/',[IO.Path]::DirectorySeparatorChar))
    Assert-NoReparseAncestors $target
    $actual=Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if ($actual.PSIsContainer -or $actual.Length -ne [long]$entry.size -or (Get-YoutabUpdateHash $target) -cne $entry.sha256) {throw 'Staged program file failed its signed hash/size check.'}
    $total+=[long]$entry.size
    if ($total -gt 32GB) {throw 'Unpacked update exceeds its program-size budget.'}
  }
  $contracts=@($manifest.dataContracts)
  if ($contracts.Count -lt 1 -or $contracts.Count -gt 256) {throw 'Explicit data-contract files are missing or exceed their budget.'}
  $contractPaths=[string[]]@($contracts|ForEach-Object {[string]$_.path})
  $orderedPaths=[string[]]$contractPaths.Clone()
  [Array]::Sort($orderedPaths,[StringComparer]::OrdinalIgnoreCase)
  $contractNames=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $contractText=New-Object Text.StringBuilder
  for($index=0;$index -lt $contracts.Count;$index++) {
    $contract=$contracts[$index]
    $relative=[string]$contract.path
    if ((@($contract.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'path|sha256|size' -or $relative -cne $orderedPaths[$index] -or -not $contractNames.Add($relative) -or -not $fileEntries.ContainsKey($relative) -or $contract.sha256 -cnotmatch '^[0-9a-f]{64}$' -or ($contract.size -isnot [int] -and $contract.size -isnot [long])) {throw 'Unsafe or noncanonical explicit data-contract list.'}
    $record=$fileEntries[$relative]
    if ($relative -cne $record.path -or $contract.sha256 -cne $record.sha256 -or [long]$contract.size -ne [long]$record.size) {throw 'Data-contract file does not exactly match the verified program manifest.'}
    $target=[IO.Path]::Combine($PayloadRoot,$relative.Replace('/',[IO.Path]::DirectorySeparatorChar))
    Assert-NoReparseAncestors $target
    if ((Get-YoutabUpdateHash $target) -cne $contract.sha256) {throw 'An explicit data-contract file changed after program validation.'}
    [void]$contractText.Append($relative);[void]$contractText.Append([char]0);[void]$contractText.Append([string]$contract.sha256);[void]$contractText.Append([char]10)
  }
  $contractHasher=[Security.Cryptography.SHA256]::Create()
  try {$contractDigest=([BitConverter]::ToString($contractHasher.ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes($contractText.ToString())))).Replace('-','').ToLowerInvariant()}
  finally {$contractHasher.Dispose()}
  if ($contractDigest -cne $manifest.dataContractsSha256 -or $contractDigest -cne $DataContractsSha256) {throw 'Explicit state/auth/config contract digest does not match the installed baseline.'}
  foreach($name in $YoutabProgramRoots) {
    $root=[IO.Path]::Combine($PayloadRoot,$name)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {throw 'A complete program root is missing.'}
    $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($root)
    while($pending.Count) {
      foreach($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Staged payload contains a reparse object.'}
        if ($item.PSIsContainer) {$pending.Push($item.FullName)} else {
          $relative=$item.FullName.Substring($PayloadRoot.TrimEnd([char[]]@([char]92,[char]47)).Length+1).Replace('\','/')
          if (-not $expected.Contains($relative)) {throw 'Unlisted program file in staged update.'}
        }
      }
    }
  }
  return $manifest
}
function Restore-YoutabProgramTransaction($Transaction) {
  $journal=Read-YoutabUpdateJournal $Transaction
  if ($journal.status -eq 'committed') {throw 'A committed update cannot be silently downgraded.'}
  if ($journal.status -eq 'rolled-back') {return}
  Write-YoutabUpdateJournal $Transaction 'rolling-back'
  foreach($name in $YoutabProgramRoots) {
    $old=[IO.Path]::Combine($Transaction.Directory,'rollback',$name)
    $live=[IO.Path]::Combine($Transaction.InstallRoot,$name)
    Assert-NoReparseAncestors $old;Assert-NoReparseAncestors $live
    if (Test-Path -LiteralPath $old) {
      if ((Get-YoutabUpdateDirectoryId $old) -cne $Transaction.OriginalRootIds.$name) {throw 'Rollback program root identity is invalid.'}
      if (Test-Path -LiteralPath $live) {
        $failed=[IO.Path]::Combine($Transaction.Directory,'failed',($name+'-'+[Guid]::NewGuid().ToString('N')))
        [IO.Directory]::Move($live,$failed)
      }
      [IO.Directory]::Move($old,$live)
    } elseif (-not (Test-Path -LiteralPath $live -PathType Container) -or (Get-YoutabUpdateDirectoryId $live) -cne $Transaction.OriginalRootIds.$name) {throw 'Recovery cannot prove an original program root; manual recovery is required.'}
  }
  Write-YoutabUpdateJournal $Transaction 'rolled-back'
}
function Invoke-YoutabProgramPromotion($Transaction,[scriptblock]$Health,[scriptblock]$Register,[scriptblock]$RestoreRegistration) {
  if (-not $Health -or -not $Register -or -not $RestoreRegistration) {throw 'Explicit health, registration and restoration operations are required.'}
  $journal=Read-YoutabUpdateJournal $Transaction
  if ($journal.status -ne 'prepared') {throw 'Update transaction already started; recover before retrying.'}
  Assert-YoutabPrivateUpdateDirectory $Transaction.InstallRoot
  foreach($name in $YoutabProgramRoots) {
    foreach($target in @([IO.Path]::Combine($Transaction.InstallRoot,$name),[IO.Path]::Combine($Transaction.Directory,'payload',$name))) {
      Assert-NoReparseAncestors $target
      if (-not (Test-Path -LiteralPath $target -PathType Container)) {throw 'Complete old and new program roots are required before promotion.'}
    }
    if ((Get-YoutabUpdateDirectoryId ([IO.Path]::Combine($Transaction.InstallRoot,$name))) -cne $Transaction.OriginalRootIds.$name) {throw 'An original program root changed before update promotion.'}
  }
  Write-YoutabUpdateJournal $Transaction 'promoting'
  $registrationStarted=$false
  try {
    foreach($name in $YoutabProgramRoots) {
      $live=[IO.Path]::Combine($Transaction.InstallRoot,$name)
      $old=[IO.Path]::Combine($Transaction.Directory,'rollback',$name)
      $staged=[IO.Path]::Combine($Transaction.Directory,'payload',$name)
      if ((Get-YoutabUpdateDirectoryId $live) -cne $Transaction.OriginalRootIds.$name) {throw 'An original program root changed during update promotion.'}
      [IO.Directory]::Move($live,$old)
      [IO.Directory]::Move($staged,$live)
    }
    $healthResult=@(& $Health $Transaction)
    if ($healthResult.Count -ne 1 -or $healthResult[0] -isnot [bool] -or -not $healthResult[0]) {throw 'Program health did not explicitly pass.'}
    Write-YoutabUpdateJournal $Transaction 'registering'
    $registrationStarted=$true
    $registrationResult=@(& $Register $Transaction)
    if ($registrationResult.Count -ne 1 -or $registrationResult[0] -isnot [bool] -or -not $registrationResult[0]) {throw 'Installer registration did not explicitly pass.'}
    Write-YoutabUpdateJournal $Transaction 'committed'
  } catch {
    $failure=$_.Exception.ToString()
    # A live registration/health job may still write. Never restore files before it drains.
    Wait-YoutabProgramInstallerDrain $failure
    $recoveryFailures=@()
    if ($registrationStarted) {
      try {$restored=@(& $RestoreRegistration $Transaction);if ($restored.Count -ne 1 -or $restored[0] -isnot [bool] -or -not $restored[0]) {throw 'Registration restoration did not explicitly pass.'}}
      catch {$recoveryFailures+=$_.Exception.Message}
    }
    if ($recoveryFailures.Count) {throw ('Update failed: '+$failure+'; registration recovery incomplete: '+($recoveryFailures-join '; '))}
    try {Restore-YoutabProgramTransaction $Transaction} catch {$recoveryFailures+=$_.Exception.Message}
    if ($recoveryFailures.Count) {throw ('Update failed: '+$failure+'; recovery incomplete: '+($recoveryFailures-join '; '))}
    throw ('Update failed; prior programs restored: '+$failure)
  }
}
`

/** Core health never opens the installed user's configuration or DB. */
export const INNO_UPDATE_PYTHON_HEALTH = `import os, socket, sys\nfrom pathlib import Path\nruntime=Path(sys.argv[1]).resolve(); home=Path(sys.argv[2]).resolve()\nos.environ['YOUTAB_AGENT_HOME']=str(home); os.environ['HOME']=str(home); os.environ['USERPROFILE']=str(home)\ndef denied(*args,**kwargs): raise PermissionError('Update health forbids Python socket/DNS')\nsocket.socket.connect=denied; socket.create_connection=denied; socket.getaddrinfo=denied\nsys.path.insert(0,str(runtime))\nimport youtab_agent_cli.main, youtab_agent_cli.web_server, tui_gateway.server, youtab_runtime, tools.registry\nfrom youtab_state import SessionDB\ndb=SessionDB(db_path=home/'state.db'); db.close()\nprint('YOUTAB_UPDATE_HEALTH_OK',flush=True)\n`

export const INNO_UPDATE_LIFECYCLE_FUNCTIONS = String.raw`
function ConvertFrom-YoutabUpdateBase64Url([string]$Value) {
  if ($Value -cnotmatch '^[A-Za-z0-9_-]+$') {throw 'Invalid signed metadata encoding.'}
  $text=$Value.Replace('-','+').Replace('_','/')
  if (($text.Length % 4) -eq 1) {throw 'Invalid signed metadata length.'}
  while (($text.Length % 4) -ne 0) {$text+='='}
  return ,([Convert]::FromBase64String($text))
}
function Assert-YoutabNativeUpdateDescriptor($Plan) {
  $bytes=[Convert]::FromBase64String($Plan.envelope)
  if ($bytes.Length -lt 1 -or $bytes.Length -gt 65536) {throw 'Signed metadata is outside its bound.'}
  $utf8=New-Object Text.UTF8Encoding($false,$true)
  $envelope=$utf8.GetString($bytes)|ConvertFrom-Json
  if ($envelope.schemaVersion -ne 1 -or $envelope.keyId -cne $Plan.keyId) {throw 'Publisher key identity does not match.'}
  $payloadBytes=ConvertFrom-YoutabUpdateBase64Url $envelope.payload
  $signature=ConvertFrom-YoutabUpdateBase64Url $envelope.signature
  $blob=[Convert]::FromBase64String($Plan.publicKeyBlob)
  if ($blob.Length -ne 72 -or [BitConverter]::ToUInt32($blob,0) -ne 0x31534345 -or [BitConverter]::ToUInt32($blob,4) -ne 32 -or $signature.Length -ne 64) {throw 'Publisher public key or signature format is invalid.'}
  $hasher=[Security.Cryptography.SHA256]::Create()
  try {
    $keyId=([BitConverter]::ToString($hasher.ComputeHash($blob))).Replace('-','').ToLowerInvariant()
    $payloadId=([BitConverter]::ToString($hasher.ComputeHash($payloadBytes))).Replace('-','').ToLowerInvariant()
  } finally {$hasher.Dispose()}
  if ($keyId -cne $Plan.keyId -or $payloadId -cne $Plan.payloadSha256) {throw 'Signed update changed after approval.'}
  $key=[Security.Cryptography.CngKey]::Import($blob,[Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
  $verifier=New-Object Security.Cryptography.ECDsaCng($key)
  try {$verifier.HashAlgorithm=[Security.Cryptography.CngAlgorithm]::Sha256;if (-not $verifier.VerifyData($payloadBytes,$signature)) {throw 'Publisher signature verification failed.'}}
  finally {$verifier.Dispose();$key.Dispose()}
  $release=$utf8.GetString($payloadBytes)|ConvertFrom-Json
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($release.product -cne 'io.youtab.agent' -or $release.format -cne 'inno-full/v1' -or $release.platform -cne 'windows' -or $release.arch -cne 'x64' -or $release.dataSchema -ne 1 -or $release.installer.fileName -cne 'Youtab-Setup.exe' -or $release.sequence -ne $Plan.expectedSequence -or $release.buildId -cne $Plan.expectedBuildId -or $release.createdAt -gt $now -or $release.expiresAt -le $now -or $release.installer.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $release.payloadManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or $release.installer.size -lt 1 -or $release.installer.size -gt 8GB) {throw 'Signed release is incompatible, expired, or no longer the approved build.'}
  return $release
}
function Assert-YoutabRetainedInstaller($Stream,$Release) {
  if ($Stream.Length -ne [long]$Release.installer.size) {throw 'Retained Installer size changed.'}
  $Stream.Position=0;$hash=[Security.Cryptography.SHA256]::Create()
  try {$digest=([BitConverter]::ToString($hash.ComputeHash($Stream))).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose()}
  if ($digest -cne $Release.installer.sha256) {throw 'Retained Installer SHA-256 does not match the publisher signature.'}
  $Stream.Position=0
  $header=New-Object byte[] 64
  if ($Stream.Read($header,0,64) -ne 64 -or $header[0] -ne 77 -or $header[1] -ne 90) {throw 'Signed Installer is not a PE executable.'}
  $offset=[BitConverter]::ToUInt32($header,60)
  if ($offset -lt 64 -or $offset -gt 1048576 -or $offset+26 -gt $Stream.Length) {throw 'Invalid signed Installer PE bounds.'}
  $Stream.Position=$offset;$image=New-Object byte[] 26
  if ($Stream.Read($image,0,26) -ne 26 -or [BitConverter]::ToUInt32($image,0) -ne 0x4550 -or [BitConverter]::ToUInt16($image,4) -notin @(0x14c,0x8664) -or ([BitConverter]::ToUInt16($image,22) -band 2) -eq 0 -or ([BitConverter]::ToUInt16($image,22) -band 0x2000) -ne 0) {throw 'Invalid signed Installer executable header.'}
  $Stream.Position=0
}
function Invoke-YoutabPrivateProgramHealth($Transaction,[string]$HealthSource,[string]$Token) {
  $health=[IO.Path]::Combine($Transaction.Directory,'health-home')
  New-YoutabPrivateUpdateDirectory $health
  foreach($name in @('AppData','LocalAppData','Temp')) {New-YoutabPrivateUpdateDirectory ([IO.Path]::Combine($health,$name))}
  $script=[IO.Path]::Combine($Transaction.Directory,'metadata','health.py')
  $healthCode=$HealthSource+[Environment]::NewLine+"(home/'health-complete').write_text(sys.argv[3],encoding='utf-8')"+[Environment]::NewLine
  [IO.File]::WriteAllText($script,$healthCode,(New-Object Text.UTF8Encoding($false)))
  $runtime=[IO.Path]::Combine($Transaction.InstallRoot,'youtab-agent-runtime')
  $basePython=[IO.Path]::Combine($Transaction.InstallRoot,'python','cpython-3.11-windows-x86_64-none')
  $configuration=(@(('home = '+$basePython),'implementation = CPython','version_info = 3.11','include-system-site-packages = false','')-join [Environment]::NewLine)
  [IO.File]::WriteAllText([IO.Path]::Combine($runtime,'venv','pyvenv.cfg'),$configuration,(New-Object Text.UTF8Encoding($false)))
  $windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  $environment=[ordered]@{SystemRoot=$windows;WINDIR=$windows;COMSPEC=[IO.Path]::Combine($windows,'System32','cmd.exe');PATHEXT='.COM;.EXE;.BAT;.CMD';HOME=$health;USERPROFILE=$health;APPDATA=[IO.Path]::Combine($health,'AppData');LOCALAPPDATA=[IO.Path]::Combine($health,'LocalAppData');TEMP=[IO.Path]::Combine($health,'Temp');TMP=[IO.Path]::Combine($health,'Temp');YOUTAB_AGENT_HOME=$health;PYTHONIOENCODING='utf-8';PYTHONDONTWRITEBYTECODE='1';PATH=([IO.Path]::Combine($runtime,'venv','Scripts')+';'+[IO.Path]::Combine($Transaction.InstallRoot,'node')+';'+[IO.Path]::Combine($Transaction.InstallRoot,'git','cmd')+';'+[IO.Path]::Combine($Transaction.InstallRoot,'git','bin')+';'+[IO.Path]::Combine($windows,'System32'))}
  $previous=[Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process)
  try {
    foreach($name in @($previous.Keys)) {[Environment]::SetEnvironmentVariable([string]$name,$null,[EnvironmentVariableTarget]::Process)}
    foreach($name in $environment.Keys) {[Environment]::SetEnvironmentVariable([string]$name,[string]$environment[$name],[EnvironmentVariableTarget]::Process)}
    $code=Invoke-YoutabBoundedInstaller ([IO.Path]::Combine($runtime,'venv','Scripts','python.exe')) @('-I','-B',$script,$runtime,$health,$Token) 120000
    if ($code -ne 0 -or -not (Test-Path -LiteralPath ([IO.Path]::Combine($health,'health-complete'))) -or [IO.File]::ReadAllText([IO.Path]::Combine($health,'health-complete')) -cne $Token) {throw 'Bundled Runtime health failed in its isolated temporary profile.'}
  } finally {
    foreach($name in @([Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys)) {[Environment]::SetEnvironmentVariable([string]$name,$null,[EnvironmentVariableTarget]::Process)}
    foreach($name in $previous.Keys) {[Environment]::SetEnvironmentVariable([string]$name,[string]$previous[$name],[EnvironmentVariableTarget]::Process)}
  }
  return $true
}
function Write-YoutabUpdateSignal([string]$Directory,[string]$Name,[string]$Token) {
  Assert-YoutabPrivateUpdateDirectory $Directory
  $file=[IO.Path]::Combine($Directory,$Name)
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($Token)
  $stream=New-Object IO.FileStream($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
}
function Write-YoutabUpdateProgress([string]$Stage,[string]$Message) {
  # Desktop closes its progress pipe after native ACK. This cannot fail a transaction.
  try {[Console]::Out.WriteLine(('YOUTAB_INNO_UPDATE:'+(@{stage=$Stage;message=$Message}|ConvertTo-Json -Compress)));[Console]::Out.Flush()} catch {}
}
function Get-YoutabUpdateBootIdentity {
  if (-not ('YoutabUpdateBootIdentity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YoutabUpdateBootIdentity {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr buffer, int length, out int returned);
  public static string Read() {
    IntPtr p=Marshal.AllocHGlobal(64);
    try {int size;int status=NtQuerySystemInformation(90,p,64,out size);if(status!=0 || size<16) throw new InvalidOperationException("Kernel boot identity is unavailable.");byte[] id=new byte[16];Marshal.Copy(p,id,0,16);Guid value=new Guid(id);if(value==Guid.Empty) throw new InvalidOperationException("Empty kernel boot identity.");return value.ToString("D");}
    finally {Marshal.FreeHGlobal(p);}
  }
}
'@ -ErrorAction Stop
  }
  return [YoutabUpdateBootIdentity]::Read()
}
function Write-YoutabDurableUpdateFile([string]$File,[string]$Text) {
  Assert-YoutabPrivateUpdateDirectory ([IO.Path]::GetDirectoryName($File))
  Assert-NoReparseAncestors $File
  $temporary=$File+'.write-'+[Guid]::NewGuid().ToString('N')
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($Text)
  $stream=New-Object IO.FileStream($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
  if (Test-Path -LiteralPath $File) {[IO.File]::Replace($temporary,$File,[Management.Automation.Language.NullString]::Value)} else {[IO.File]::Move($temporary,$File)}
}
function Assert-YoutabNoUpdateProgramWriters($Plan,[int]$WaitMilliseconds=0) {
  $prefixes=@($YoutabProgramRoots|ForEach-Object {[IO.Path]::Combine($Plan.installRoot,$_)+[IO.Path]::DirectorySeparatorChar})
  $clock=[Diagnostics.Stopwatch]::StartNew()
  do {
    $live=$false
    foreach($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
      if ($process.ProcessId -eq $PID) {continue}
      foreach($prefix in $prefixes) {
        if (($process.ExecutablePath -and ([string]$process.ExecutablePath).StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) -or ($process.CommandLine -and ([string]$process.CommandLine).IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0)) {$live=$true;break}
      }
      if ($live) {break}
    }
    if (-not $live) {return}
    if ($clock.ElapsedMilliseconds -ge $WaitMilliseconds) {throw 'An installed Youtab program or task is still running. Programs were preserved; close that workload before updating or recovering.'}
    Start-Sleep -Milliseconds 250
  } while ($true)
}
`

function nativeHeader(): string {
  return `$ErrorActionPreference='Stop'\n${WINDOWS_OWNED_TREE_FUNCTIONS}\n${INNO_UPDATE_TRANSACTION_FUNCTIONS}\n${INNO_UPDATE_INSTALLER_JOB_FUNCTIONS}\n${WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS}\n${WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS}\n${INNO_UPDATE_REGISTRATION_FUNCTIONS}\n${INNO_UPDATE_LIFECYCLE_FUNCTIONS}\n`
}

/** An interrupted helper cannot prove its vanished kernel job drained. Recovery
 * therefore requires a different kernel boot and the same exclusive install lock.
 */
export function buildInnoUpdateRecoveryScript(plan: CommonWindowsUninstallPlan): string {
  const encoded = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')

  return nativeHeader()+String.raw`
$plan=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
$lock=$null;$scheduler=$null
try {
  Assert-YoutabPrivateUpdateDirectory $plan.installRoot
  $updates=[IO.Path]::Combine($plan.installRoot,'.youtab-updates')
  Assert-YoutabPrivateUpdateDirectory $updates
  $active=[IO.Path]::Combine($updates,'active.json');Assert-NoReparseAncestors $active
  $info=Get-Item -LiteralPath $active -Force -ErrorAction Stop
  if ($info.PSIsContainer -or $info.Length -gt 128) {throw 'Invalid pending transaction marker.'}
  $id=[IO.File]::ReadAllText($active)
  if ($id -cnotmatch '^transaction-[0-9a-f]{32}$') {throw 'Invalid pending transaction identity.'}
  $transaction=Open-YoutabProgramTransaction $plan.installRoot ([IO.Path]::Combine($updates,$id))
  $saved=[IO.Path]::Combine($transaction.Directory,'metadata','recovery.json');Assert-NoReparseAncestors $saved
  $info=Get-Item -LiteralPath $saved -Force
  if ($info.PSIsContainer -or $info.Length -gt 1MB) {throw 'Invalid recovery metadata.'}
  $recovery=[IO.File]::ReadAllText($saved)|ConvertFrom-Json
  if ($recovery.transaction -cne $id -or $recovery.boot -cnotmatch '^[0-9a-f-]{36}$' -or $recovery.boot -ceq (Get-YoutabUpdateBootIdentity)) {throw 'Restart Windows before recovering an interrupted update; prior native writers cannot be admitted on the same boot.'}
  $lockFile=[IO.Path]::Combine($plan.installRoot,'.youtab-agent-runtime-update-in-progress.install-lock');Assert-NoReparseAncestors $lockFile
  $lock=New-Object IO.FileStream($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  # Read actual bound program writers; a stale pre-reboot PID marker is never a kill target.
  Assert-YoutabNoUpdateProgramWriters $plan
  $restore={param($value) Restore-YoutabUpdateRegistration $value}
  [void](Recover-YoutabProgramTransaction $transaction $restore)
  if ($recovery.resources) {
    $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect()
    $binding=Get-YoutabUninstallEnvironment
    Assert-YoutabOwnedUninstallResources $recovery.resources $scheduler $binding.Home $binding.Path
    Restore-YoutabOwnedUninstallTasks $recovery.resources $scheduler
  }
  if ($recovery.gateways) {Remove-YoutabOwnedGatewayStopMarkers @($recovery.gateways) $recovery.handoff}
  Initialize-YoutabGatewayNative
  if (-not [YoutabUninstallGatewayNative]::RemoveIfSame($active,$id)) {throw 'Recovery marker changed; it was preserved.'}
  [Console]::Out.WriteLine('Youtab recovery completed. Your retained chats and profiles were not removed.')
} catch {[Console]::Error.WriteLine($_.Exception.Message);exit 1}
finally {if($scheduler){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($scheduler)};if($lock){$lock.Dispose()}}
exit 0
`
}

export function buildInnoUpdateTransactionScript(plan: InnoUpdateTransactionPlan): string {
  const payload = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')
  const health = Buffer.from(INNO_UPDATE_PYTHON_HEALTH, 'utf8').toString('base64')
  const recoveryScript = Buffer.from(buildInnoUpdateRecoveryScript(plan.installation), 'utf8').toString('base64')

  return nativeHeader()+String.raw`
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
$plan=$request.installation;$handoff=$request.handoff
$healthSource=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${health}'))
$installerLease=$null;$installLock=$null;$scheduler=$null;$resources=$null;$gateways=@();$transaction=$null;$activeContent=$null;$activeFile=$null;$committed=$false
$diagnostic=[IO.Path]::Combine($handoff.directory,'failure.log')
try {
  Set-Location -LiteralPath ([IO.Path]::GetDirectoryName($handoff.directory))
  Assert-YoutabPrivateUpdateDirectory $handoff.directory
  Assert-YoutabPrivateUpdateDirectory $plan.installRoot
  foreach($protected in @($plan.protectedRoots)) {if ([IO.Path]::GetFullPath($plan.installRoot).TrimEnd($separators).Equals([IO.Path]::GetFullPath($protected).TrimEnd($separators),[StringComparison]::OrdinalIgnoreCase)) {throw 'Protected update root.'}}
  $release=Assert-YoutabNativeUpdateDescriptor $request
  Assert-NoReparseAncestors $request.installer
  $installerLease=New-Object IO.FileStream($request.installer,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  Assert-YoutabRetainedInstaller $installerLease $release
  $lockFile=[IO.Path]::Combine($plan.installRoot,'.youtab-agent-runtime-update-in-progress.install-lock')
  Assert-NoReparseAncestors $lockFile
  $installLock=New-Object IO.FileStream($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $updates=[IO.Path]::Combine($plan.installRoot,'.youtab-updates')
  if (-not (Test-Path -LiteralPath $updates)) {New-YoutabPrivateUpdateDirectory $updates}
  Assert-YoutabPrivateUpdateDirectory $updates
  $activeFile=[IO.Path]::Combine($updates,'active.json')
  if (Test-Path -LiteralPath $activeFile) {throw 'A previous update requires recovery before another update.'}
  $transaction=New-YoutabProgramTransaction $plan.installRoot ([IO.Path]::Combine($updates,('transaction-'+[Guid]::NewGuid().ToString('N'))))
  $recovery=[ordered]@{schemaVersion=1;transaction=$transaction.Id;boot=(Get-YoutabUpdateBootIdentity);resources=$null;gateways=@();handoff=$handoff}
  Write-YoutabDurableUpdateFile ([IO.Path]::Combine($transaction.Directory,'metadata','recovery.json')) ($recovery|ConvertTo-Json -Depth 16 -Compress)
  Write-YoutabDurableUpdateFile ([IO.Path]::Combine($transaction.Directory,'Recover.ps1')) ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${recoveryScript}')))
  $activeContent=$transaction.Id
  Write-YoutabUpdateSignal $updates 'active.json' $activeContent
  Write-YoutabUpdateProgress 'prepare' 'Verifying and extracting the signed full Installer into a separate program stage.'
  $stage=[IO.Path]::Combine($transaction.Directory,'payload')
  $extract=Invoke-YoutabBoundedInstaller $request.installer @('/YOUTABPAYLOADONLY','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',('/DIR='+$stage),('/LOG='+[IO.Path]::Combine($transaction.Directory,'extract.log'))) 600000
  if ($extract -ne 0) {throw 'The signed Installer could not stage its complete offline payload.'}
  [void](Assert-YoutabPayloadManifest $stage $release.payloadManifestSha256 $request.dataContractsSha256)
  [void](Save-YoutabUpdateRegistration $transaction)
  $registration=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\{78558650-B4B0-4B5D-854C-371DCBCE6B32}_is1')
  if (-not $registration) {throw 'Current Setup registration is unavailable.'}
  try {Assert-YoutabUninstallRegistration $plan.installRoot $plan.uninstaller ([string]$registration.GetValue('InstallLocation')) ([string]$registration.GetValue('UninstallString'))} finally {$registration.Dispose()}
  $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect()
  $binding=Get-YoutabUninstallEnvironment
  $resources=Get-YoutabOwnedUninstallResources $plan $scheduler $binding.Home $binding.Path
  $gateways=@(Get-YoutabOwnedGatewayProcesses $plan $resources.KnownHomes)
  if ($gateways.Count) {throw 'A separate Youtab Gateway is running. Finish and stop its workloads before updating; Update will not interrupt headless tasks.'}
  Assert-YoutabUninstallNotCancelled $handoff
  Write-YoutabUpdateSignal $handoff.directory 'ready' $handoff.token
  $savedResources=($resources|ConvertTo-Json -Depth 12 -Compress)|ConvertFrom-Json
  foreach($task in $savedResources.Tasks) {if ($task.OriginalEnabled) {$task.SuspendedByUninstall=$true}}
  $recovery.resources=$savedResources;$recovery.gateways=$gateways
  Write-YoutabDurableUpdateFile ([IO.Path]::Combine($transaction.Directory,'metadata','recovery.json')) ($recovery|ConvertTo-Json -Depth 16 -Compress)
  Suspend-YoutabOwnedUninstallTasks $resources $scheduler
  Assert-YoutabUninstallNotCancelled $handoff
  Write-YoutabUpdateSignal $handoff.directory 'stopped' $handoff.token
  Write-YoutabUpdateProgress 'handoff' 'The complete update is admitted. Waiting for Desktop to release its backend.'
  $proceed=[IO.Path]::Combine($handoff.directory,'proceed')
  for($attempt=0;$attempt -lt 360;$attempt++) {
    Assert-YoutabUninstallNotCancelled $handoff
    if ((Test-Path -LiteralPath $proceed) -and [IO.File]::ReadAllText($proceed) -ceq $handoff.token) {break}
    if (-not (Get-Process -Id $plan.desktopPid -ErrorAction SilentlyContinue)) {throw 'Desktop exited without completing the update handoff; programs were preserved.'}
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $proceed) -or [IO.File]::ReadAllText($proceed) -cne $handoff.token) {throw 'Desktop did not finish its backend handoff; programs were preserved.'}
  Write-YoutabUpdateSignal $handoff.directory 'armed' $handoff.token
  for($attempt=0;$attempt -lt 120;$attempt++) {Assert-YoutabUninstallNotCancelled $handoff;if (-not (Get-Process -Id $plan.desktopPid -ErrorAction SilentlyContinue)) {break};Start-Sleep -Milliseconds 500}
  if (Get-Process -Id $plan.desktopPid -ErrorAction SilentlyContinue) {throw 'Desktop did not exit; installed programs were not replaced.'}
  Assert-YoutabNoUpdateProgramWriters $plan 30000
  $binding=Get-YoutabUninstallEnvironment
  Assert-YoutabOwnedUninstallResources $resources $scheduler $binding.Home $binding.Path
  $null=Assert-YoutabNativeUpdateDescriptor $request
  Assert-YoutabRetainedInstaller $installerLease $release
  Write-YoutabUpdateProgress 'update' 'Promoting the verified program roots; chats, credentials and profiles remain in their current home.'
  $healthOperation={param($value) Invoke-YoutabPrivateProgramHealth $value $healthSource $handoff.token}
  $registerOperation={param($value) Register-YoutabUpdatedPayload $value $request.installer $release.payloadManifestSha256 $release.sequence $release.buildId}
  $restoreOperation={param($value) Restore-YoutabUpdateRegistration $value}
  Invoke-YoutabProgramPromotion $transaction $healthOperation $registerOperation $restoreOperation
  $committed=$true
  Remove-YoutabOwnedGatewayStopMarkers $gateways $handoff
  Restore-YoutabOwnedUninstallTasks $resources $scheduler
  Initialize-YoutabGatewayNative
  if (-not [YoutabUninstallGatewayNative]::RemoveIfSame($activeFile,$activeContent)) {throw 'Committed update could not clear its exact transaction marker.'}
  Write-YoutabUpdateSignal $handoff.directory 'complete' $handoff.token
  Write-YoutabUpdateProgress 'restart' 'Program update completed; reopening Youtab.'
} catch {
  $failure=$_.Exception.ToString()
  if ($failure.Contains('YOUTAB_INSTALLER_STILL_RUNNING')) {
    [IO.File]::WriteAllText($diagnostic,'The owned Installer has not drained. No rollback may run while it can still write. Waiting with the installation lock held.')
    while (-not (Test-YoutabInstallerJobsDrained)) {Start-Sleep -Milliseconds 500}
  }
  if ($transaction -and -not $committed) {
    try {
      $restore={param($value) Restore-YoutabUpdateRegistration $value}
      $recovered=@(Recover-YoutabProgramTransaction $transaction $restore)
      if ($recovered.Count -ne 1 -or $recovered[0] -isnot [bool] -or -not $recovered[0]) {throw 'Native recovery did not explicitly acknowledge completion.'}
    } catch {$failure+='; rollback: '+$_.Exception.Message}
  }
  try {Remove-YoutabOwnedGatewayStopMarkers $gateways $handoff} catch {$failure+='; stop markers: '+$_.Exception.Message}
  if ($resources -and $scheduler) {try {Restore-YoutabOwnedUninstallTasks $resources $scheduler} catch {$failure+='; service restoration: '+$_.Exception.Message}}
  if ($transaction -and $activeContent -and -not $committed) {
    try {if ((Read-YoutabUpdateJournal $transaction).status -eq 'rolled-back') {Initialize-YoutabGatewayNative;[void][YoutabUninstallGatewayNative]::RemoveIfSame($activeFile,$activeContent)}} catch {$failure+='; recovery marker: '+$_.Exception.Message}
  }
  [IO.File]::WriteAllText($diagnostic,('Youtab update did not complete: '+$failure))
  Write-YoutabUpdateProgress 'error' 'Update did not complete. Read the preserved update recovery log before retrying.'
  if (Get-Process -Id $plan.desktopPid -ErrorAction SilentlyContinue) {exit 1}
} finally {
  if ($scheduler) {[void][Runtime.InteropServices.Marshal]::ReleaseComObject($scheduler)}
  if ($installLock) {$installLock.Dispose()}
  if ($installerLease) {$installerLease.Dispose()}
}
if (-not (Get-Process -Id $plan.desktopPid -ErrorAction SilentlyContinue)) {
  $desktop=[IO.Path]::Combine($plan.installRoot,'youtab-agent-runtime','apps','desktop','release','win-unpacked','Youtab.exe')
  if (Test-Path -LiteralPath $desktop) {Start-Process -FilePath $desktop -WorkingDirectory ([IO.Path]::Combine($plan.installRoot,'youtab-agent-runtime')) -WindowStyle Normal|Out-Null}
}
if ($committed) {exit 0}else {exit 1}
`
}
