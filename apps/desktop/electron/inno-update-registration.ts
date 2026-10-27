/** Current-user Inno registration metadata only; no HOME, PATH, icons or DB changes. */
export const INNO_UPDATE_REGISTRATION_FUNCTIONS = String.raw`
$YoutabUpdateUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{78558650-B4B0-4B5D-854C-371DCBCE6B32}_is1'
$YoutabInnoOwnedValueNames = @('DisplayName','DisplayVersion','Publisher','URLInfoAbout','URLUpdateInfo','HelpLink','InstallLocation','DisplayIcon','UninstallString','QuietUninstallString','NoModify','NoRepair','InstallDate','EstimatedSize','Language','Inno Setup: Setup Version','Inno Setup: App Path','Inno Setup: Icon Group','Inno Setup: User','Inno Setup: Selected Tasks','Inno Setup: Deselected Tasks','Inno Setup: Language')
function Open-YoutabUpdateRegistrationKey([string]$View,[bool]$Writable,[bool]$Create=$false) {
  if ($View -notin @('Registry64','Registry32') -or ($Create -and -not $Writable)) {throw 'Invalid fixed registration access.'}
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::$View)
  try {
    if ($Create) {return $base.CreateSubKey($YoutabUpdateUninstallKey,$true)}
    return $base.OpenSubKey($YoutabUpdateUninstallKey,$Writable)
  } finally {$base.Dispose()}
}
function Assert-YoutabUpdateRegistrationTransaction($Transaction) {
  if ($Transaction.Id -cnotmatch '^transaction-[0-9a-f]{32}$') {throw 'Invalid registration transaction identity.'}
  $root=[IO.Path]::GetFullPath([string]$Transaction.InstallRoot)
  $directory=[IO.Path]::GetFullPath([string]$Transaction.Directory)
  $expected=[IO.Path]::Combine($root,'.youtab-updates',[string]$Transaction.Id)
  if (-not $directory.Equals($expected,[StringComparison]::OrdinalIgnoreCase)) {throw 'Registration metadata escaped its installation.'}
  Assert-YoutabPrivateUpdateDirectory $root
  Assert-YoutabPrivateUpdateDirectory $directory
  Assert-YoutabPrivateUpdateDirectory ([IO.Path]::Combine($directory,'metadata'))
}
function Get-YoutabRegistrationRegularFile([string]$Path,[long]$Limit) {
  Assert-NoReparseAncestors $Path
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Length -gt $Limit -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {throw 'Registration metadata is not a bounded regular file.'}
  return [pscustomobject]@{Name=$item.Name;Size=[long]$item.Length;Sha256=Get-YoutabUpdateHash $Path}
}
function Get-YoutabRegistrationRootFiles([string]$Root) {
  Assert-NoReparseAncestors $Root
  $result=@();[long]$total=0
  $names=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach($item in @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction Stop)) {
    if ($item.Name -notmatch '^unins[0-9]{3}\.(exe|dat|msg)$') {continue}
    if (-not $names.Add($item.Name)) {throw 'Ambiguous uninstaller metadata names.'}
    $entry=Get-YoutabRegistrationRegularFile $item.FullName 128MB
    $total+=$entry.Size
    $result+=@($entry)
    if ($result.Count -gt 32 -or $total -gt 128MB) {throw 'Uninstaller metadata exceeds its snapshot budget.'}
  }
  return $result
}
function Assert-YoutabRegistrationKeyBinding($Key,[string]$Root,[bool]$AllowMissing=$false) {
  $options=[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  $location=$Key.GetValue('InstallLocation',$null,$options)
  $appPath=$Key.GetValue('Inno Setup: App Path',$null,$options)
  if (-not $location -and -not $appPath -and -not $AllowMissing) {throw 'Existing uninstall registration has no installation binding.'}
  foreach($value in @($location,$appPath)) {
    if ($null -eq $value -or $value -ceq '') {continue}
    if ($value -isnot [string] -or -not [IO.Path]::IsPathRooted($value) -or -not ([IO.Path]::GetFullPath($value).TrimEnd([char]92).Equals($Root.TrimEnd([char]92),[StringComparison]::OrdinalIgnoreCase))) {throw 'Uninstall registration belongs to another installation.'}
  }
  foreach($name in @('UninstallString','QuietUninstallString')) {
    $command=$Key.GetValue($name,$null,$options)
    if ($null -eq $command) {continue}
    if ($command -isnot [string] -or $command -notmatch '^"([^"\r\n]+\\unins[0-9]{3}\.exe)"(?: /SILENT)?$') {throw 'Uninstall command is not the owned Inno executable.'}
    if (-not ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Matches[1])).Equals($Root,[StringComparison]::OrdinalIgnoreCase))) {throw 'Uninstall executable escaped its installation.'}
  }
}
function ConvertTo-YoutabRegistrationValue([string]$Name,[string]$Kind,$Value) {
  if ($Name.Length -gt 1024 -or $Name -match '[\x00-\x1f]' -or $Kind -notin @('String','ExpandString','MultiString','Binary','None','DWord','QWord')) {throw 'Unsupported registration value.'}
  switch ($Kind) {
    {$_ -in @('Binary','None')} {$encoded=[Convert]::ToBase64String([byte[]]$Value);break}
    'DWord' {$encoded=([int]$Value).ToString([Globalization.CultureInfo]::InvariantCulture);break}
    'QWord' {$encoded=([long]$Value).ToString([Globalization.CultureInfo]::InvariantCulture);break}
    'MultiString' {$encoded=@([string[]]$Value);break}
    default {$encoded=[string]$Value}
  }
  return [pscustomobject]@{Name=$Name;Kind=$Kind;Value=$encoded}
}
function ConvertFrom-YoutabRegistrationValue($Entry) {
  switch ([string]$Entry.Kind) {
    {$_ -in @('Binary','None')} {return ,([Convert]::FromBase64String([string]$Entry.Value))}
    'DWord' {return [int]::Parse([string]$Entry.Value,[Globalization.CultureInfo]::InvariantCulture)}
    'QWord' {return [long]::Parse([string]$Entry.Value,[Globalization.CultureInfo]::InvariantCulture)}
    'MultiString' {return ,([string[]]@($Entry.Value))}
    {$_ -in @('String','ExpandString')} {return [string]$Entry.Value}
    default {throw 'Unsupported saved registration value kind.'}
  }
}
function Get-YoutabRegistrationValues($Key) {
  $names=@($Key.GetValueNames())
  if ($names.Count -gt 128) {throw 'Uninstall registration exceeds its value budget.'}
  $result=@()
  foreach($name in $names) {
    $kind=$Key.GetValueKind($name).ToString()
    $value=$Key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $result+=@(ConvertTo-YoutabRegistrationValue $name $kind $value)
  }
  if ((New-Object Text.UTF8Encoding($false)).GetByteCount(($result|ConvertTo-Json -Depth 5 -Compress)) -gt 1MB) {throw 'Uninstall registration exceeds its byte budget.'}
  return $result
}
function Copy-YoutabRegistrationFile([string]$Source,[string]$Destination,$Expected) {
  $actual=Get-YoutabRegistrationRegularFile $Source 128MB
  if ($actual.Size -ne [long]$Expected.Size -or $actual.Sha256 -cne $Expected.Sha256) {throw 'Registration snapshot source changed.'}
  Assert-NoReparseAncestors $Destination
  if (Test-Path -LiteralPath $Destination) {throw 'Registration copy destination already exists.'}
  $sourceStream=[IO.File]::Open($Source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    $destinationStream=New-Object IO.FileStream($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$sourceStream.CopyTo($destinationStream,1048576);$destinationStream.Flush($true)}finally{$destinationStream.Dispose()}
  } finally {$sourceStream.Dispose()}
  $copied=Get-YoutabRegistrationRegularFile $Destination 128MB
  if ($copied.Size -ne [long]$Expected.Size -or $copied.Sha256 -cne $Expected.Sha256) {throw 'Registration snapshot copy failed its hash check.'}
}
function Write-YoutabRegistrationSnapshotFile([string]$Path,[string]$Text) {
  Assert-NoReparseAncestors $Path
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($Text)
  $stream=New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Read-YoutabUpdateRegistration($Transaction) {
  Assert-YoutabUpdateRegistrationTransaction $Transaction
  $metadata=[IO.Path]::Combine($Transaction.Directory,'metadata')
  $file=[IO.Path]::Combine($metadata,'registration.json')
  [void](Get-YoutabRegistrationRegularFile $file 1MB)
  $hashFile=[IO.Path]::Combine($metadata,'registration.sha256')
  [void](Get-YoutabRegistrationRegularFile $hashFile 64)
  $hash=[IO.File]::ReadAllText($hashFile)
  if ($hash -cnotmatch '^[0-9a-f]{64}$' -or (Get-YoutabUpdateHash $file) -cne $hash) {throw 'Registration snapshot receipt is invalid.'}
  $snapshot=[IO.File]::ReadAllText($file)|ConvertFrom-Json
  if ($snapshot.SchemaVersion -ne 1 -or $snapshot.Id -cne $Transaction.Id -or $snapshot.InstallRoot -cne $Transaction.InstallRoot -or $snapshot.Registry.View -notin @('Registry64','Registry32') -or @($snapshot.Registry.Values).Count -gt 128 -or @($snapshot.Files).Count -gt 32 -or $snapshot.Manifest.Exists -isnot [bool]) {throw 'Registration snapshot identity is invalid.'}
  $names=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach($entry in @($snapshot.Registry.Values)) {
    if (-not $names.Add([string]$entry.Name)) {throw 'Duplicate saved registry value.'}
    $value=ConvertFrom-YoutabRegistrationValue $entry
    [void](ConvertTo-YoutabRegistrationValue ([string]$entry.Name) ([string]$entry.Kind) $value)
  }
  [long]$total=0
  $names=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach($entry in @($snapshot.Files)) {
    if ($entry.Name -notmatch '^unins[0-9]{3}\.(exe|dat|msg)$' -or -not $names.Add([string]$entry.Name) -or $entry.Sha256 -cnotmatch '^[0-9a-f]{64}$' -or [long]$entry.Size -lt 0) {throw 'Invalid saved uninstaller file.'}
    $total+=[long]$entry.Size
    if ($total -gt 128MB) {throw 'Saved uninstaller files exceed their budget.'}
    $source=[IO.Path]::Combine($metadata,'registration-files',[string]$entry.Name)
    $actual=Get-YoutabRegistrationRegularFile $source 128MB
    if ($actual.Size -ne [long]$entry.Size -or $actual.Sha256 -cne $entry.Sha256) {throw 'Saved uninstaller bytes changed.'}
  }
  if ($snapshot.Manifest.Exists) {
    $entry=$snapshot.Manifest
    if ($entry.Sha256 -cnotmatch '^[0-9a-f]{64}$' -or [long]$entry.Size -lt 0 -or [long]$entry.Size -gt 64MB) {throw 'Invalid saved program manifest.'}
    $actual=Get-YoutabRegistrationRegularFile ([IO.Path]::Combine($metadata,'registration-files','.youtab-install-files.json')) 64MB
    if ($actual.Size -ne [long]$entry.Size -or $actual.Sha256 -cne $entry.Sha256) {throw 'Saved program manifest changed.'}
  }
  return $snapshot
}
function Save-YoutabUpdateRegistration($Transaction) {
  Assert-YoutabUpdateRegistrationTransaction $Transaction
  $registry=$null
  foreach($view in @('Registry64','Registry32')) {
    $key=Open-YoutabUpdateRegistrationKey $view $false
    if ($null -eq $key) {continue}
    try {
      Assert-YoutabRegistrationKeyBinding $key $Transaction.InstallRoot
      $registry=[pscustomobject]@{View=$view;Values=@(Get-YoutabRegistrationValues $key)}
    }finally{$key.Dispose()}
    break
  }
  if ($null -eq $registry) {throw 'The current-user Inno uninstall registration is missing.'}
  $files=@(Get-YoutabRegistrationRootFiles $Transaction.InstallRoot)
  $manifestPath=[IO.Path]::Combine($Transaction.InstallRoot,'.youtab-install-files.json')
  $manifest=[pscustomobject]@{Exists=$false;Size=0;Sha256=$null}
  if (Test-Path -LiteralPath $manifestPath) {
    $info=Get-YoutabRegistrationRegularFile $manifestPath 64MB
    $manifest=[pscustomobject]@{Exists=$true;Size=$info.Size;Sha256=$info.Sha256}
  }
  $metadata=[IO.Path]::Combine($Transaction.Directory,'metadata')
  $copies=[IO.Path]::Combine($metadata,'registration-files')
  if (Test-Path -LiteralPath $copies) {throw 'Registration snapshot already exists; recover before retrying.'}
  [void][IO.Directory]::CreateDirectory($copies)
  Assert-YoutabPrivateUpdateDirectory $copies
  foreach($entry in $files) {Copy-YoutabRegistrationFile ([IO.Path]::Combine($Transaction.InstallRoot,$entry.Name)) ([IO.Path]::Combine($copies,$entry.Name)) $entry}
  if ($manifest.Exists) {Copy-YoutabRegistrationFile $manifestPath ([IO.Path]::Combine($copies,'.youtab-install-files.json')) $manifest}
  $snapshot=[ordered]@{SchemaVersion=1;Id=$Transaction.Id;InstallRoot=$Transaction.InstallRoot;Registry=$registry;Files=$files;Manifest=$manifest}
  $document=$snapshot|ConvertTo-Json -Depth 7 -Compress
  if ((New-Object Text.UTF8Encoding($false)).GetByteCount($document) -gt 1MB) {throw 'Registration snapshot document exceeds its budget.'}
  $file=[IO.Path]::Combine($metadata,'registration.json')
  Write-YoutabRegistrationSnapshotFile $file $document
  Write-YoutabRegistrationSnapshotFile ([IO.Path]::Combine($metadata,'registration.sha256')) (Get-YoutabUpdateHash $file)
  [void](Read-YoutabUpdateRegistration $Transaction)
  return $true
}
function Restore-YoutabRegistrationFile($Transaction,[string]$Name,$Old,$Current,[string]$FailedDirectory) {
  if ($Name -cne '.youtab-install-files.json' -and $Name -notmatch '^unins[0-9]{3}\.(exe|dat|msg)$') {throw 'Invalid registration restore target.'}
  $target=[IO.Path]::Combine($Transaction.InstallRoot,$Name)
  Assert-NoReparseAncestors $target
  if ($null -ne $Current) {
    $now=Get-YoutabRegistrationRegularFile $target 128MB
    if ($now.Size -ne [long]$Current.Size -or $now.Sha256 -cne $Current.Sha256) {throw 'Live registration metadata changed during recovery.'}
  }elseif(Test-Path -LiteralPath $target) {throw 'A registration restore destination appeared during recovery.'}
  if ($null -eq $Old) {
    if ($null -ne $Current) {[IO.File]::Move($target,[IO.Path]::Combine($FailedDirectory,$Name))}
    return
  }
  if ($null -ne $Current -and $Old.Sha256 -ceq $Current.Sha256 -and [long]$Old.Size -eq [long]$Current.Size) {return}
  $temporary=[IO.Path]::Combine($Transaction.InstallRoot,('.youtab-registration-restore-'+[Guid]::NewGuid().ToString('N')+'.tmp'))
  Copy-YoutabRegistrationFile ([IO.Path]::Combine($Transaction.Directory,'metadata','registration-files',$Name)) $temporary $Old
  if ($null -eq $Current) {[IO.File]::Move($temporary,$target)}
  else {[IO.File]::Replace($temporary,$target,[IO.Path]::Combine($FailedDirectory,$Name))}
}
function Restore-YoutabUpdateRegistration($Transaction) {
  $snapshot=Read-YoutabUpdateRegistration $Transaction
  $current=@(Get-YoutabRegistrationRootFiles $Transaction.InstallRoot)
  $manifestPath=[IO.Path]::Combine($Transaction.InstallRoot,'.youtab-install-files.json')
  $currentManifest=$null
  if (Test-Path -LiteralPath $manifestPath) {$currentManifest=Get-YoutabRegistrationRegularFile $manifestPath 64MB}
  $key=Open-YoutabUpdateRegistrationKey $snapshot.Registry.View $true
  if ($null -ne $key) {
    try {Assert-YoutabRegistrationKeyBinding $key $Transaction.InstallRoot $true}finally{$key.Dispose()}
  }
  $failedParent=[IO.Path]::Combine($Transaction.Directory,'failed')
  Assert-YoutabPrivateUpdateDirectory $failedParent
  $failed=[IO.Path]::Combine($failedParent,('registration-'+[Guid]::NewGuid().ToString('N')))
  [void][IO.Directory]::CreateDirectory($failed)
  Assert-YoutabPrivateUpdateDirectory $failed
  foreach($entry in $current) {
    $old=@($snapshot.Files|Where-Object {$_.Name -ieq $entry.Name})
    if ($old.Count -gt 1) {throw 'Ambiguous registration restore name.'}
    $original=$null;if($old.Count){$original=$old[0]}
    Restore-YoutabRegistrationFile $Transaction $entry.Name $original $entry $failed
  }
  foreach($entry in @($snapshot.Files)) {
    if (@($current|Where-Object {$_.Name -ieq $entry.Name}).Count -eq 0) {Restore-YoutabRegistrationFile $Transaction $entry.Name $entry $null $failed}
  }
  $oldManifest=$null;if($snapshot.Manifest.Exists){$oldManifest=$snapshot.Manifest}
  Restore-YoutabRegistrationFile $Transaction '.youtab-install-files.json' $oldManifest $currentManifest $failed
  $key=Open-YoutabUpdateRegistrationKey $snapshot.Registry.View $true $true
  if ($null -eq $key) {throw 'Cannot restore the fixed uninstall registration.'}
  try {
    Assert-YoutabRegistrationKeyBinding $key $Transaction.InstallRoot $true
    $savedNames=@($snapshot.Registry.Values|ForEach-Object {$_.Name})
    foreach($name in @($key.GetValueNames())) {
      if ($name -in $YoutabInnoOwnedValueNames -and $name -notin $savedNames) {$key.DeleteValue($name,$false)}
    }
    foreach($entry in @($snapshot.Registry.Values)) {
      $value=ConvertFrom-YoutabRegistrationValue $entry
      $kind=[Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$entry.Kind)
      $key.SetValue([string]$entry.Name,$value,$kind)
    }
  }finally{$key.Dispose()}
  return $true
}
function Register-YoutabUpdatedPayload($Transaction,[string]$Installer,[string]$ExpectedManifestHash,[long]$ExpectedSequence,[string]$ExpectedBuildId) {
  Assert-YoutabUpdateRegistrationTransaction $Transaction
  $snapshot=Read-YoutabUpdateRegistration $Transaction
  if ($ExpectedManifestHash -cnotmatch '^[0-9a-f]{64}$' -or $ExpectedBuildId -cnotmatch '^[0-9a-f]{64}$' -or $ExpectedSequence -lt 1 -or $ExpectedSequence -gt 9007199254740991) {throw 'Invalid expected registration release identity.'}
  Assert-NoReparseAncestors $Installer
  $installerInfo=Get-Item -LiteralPath $Installer -Force -ErrorAction Stop
  if ($installerInfo.PSIsContainer -or (($installerInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or $Installer -match '["\x00-\x1f]' -or $Transaction.InstallRoot -match '["\x00-\x1f]') {throw 'Unsafe registration installer or root.'}
  $installerHash=Get-YoutabUpdateHash $Installer
  $beforeKey=Open-YoutabUpdateRegistrationKey $snapshot.Registry.View $false
  if ($null -eq $beforeKey) {throw 'Existing uninstall registration disappeared before registration.'}
  try {Assert-YoutabRegistrationKeyBinding $beforeKey $Transaction.InstallRoot}finally{$beforeKey.Dispose()}
  $log=[IO.Path]::Combine($Transaction.Directory,'register.log')
  Assert-NoReparseAncestors $log
  if (Test-Path -LiteralPath $log) {throw 'Registration log already exists; recover before retrying.'}
  $arguments=@('/YOUTABREGISTERONLY','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR='+$Transaction.InstallRoot),('/LOG='+$log))
  $exit=@(Invoke-YoutabBoundedInstaller $Installer $arguments 600000)
  if ($exit.Count -ne 1 -or $exit[0] -isnot [int] -or $exit[0] -ne 0) {throw 'Inno registration did not exit successfully.'}
  $manifest=Get-YoutabRegistrationRegularFile ([IO.Path]::Combine($Transaction.InstallRoot,'.youtab-install-files.json')) 64MB
  if ($manifest.Sha256 -cne $ExpectedManifestHash) {throw 'Registered program manifest does not match the signed release.'}
  $markerPath=[IO.Path]::Combine($Transaction.InstallRoot,'youtab-agent-runtime','.youtab-agent-runtime-bootstrap-complete')
  [void](Get-YoutabRegistrationRegularFile $markerPath 1MB)
  $marker=[IO.File]::ReadAllText($markerPath)|ConvertFrom-Json
  if ($marker.buildId -isnot [string] -or $marker.buildId -cne $ExpectedBuildId -or ($marker.releaseSequence -isnot [int] -and $marker.releaseSequence -isnot [long]) -or $marker.releaseSequence -ne $ExpectedSequence -or $marker.installedSetupSha256 -isnot [string] -or $marker.installedSetupSha256 -cne $installerHash) {throw 'Registered bootstrap marker does not match the signed build and Installer.'}
  $key=Open-YoutabUpdateRegistrationKey $snapshot.Registry.View $false
  if ($null -eq $key) {throw 'Updated uninstall registration is missing.'}
  try {
    Assert-YoutabRegistrationKeyBinding $key $Transaction.InstallRoot
    $command=$key.GetValue('UninstallString',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($command -isnot [string] -or $command -notmatch '^"([^"\r\n]+\\unins[0-9]{3}\.exe)"$') {throw 'Updated uninstaller command is missing.'}
    $uninstaller=$Matches[1]
    [void](Get-YoutabRegistrationRegularFile $uninstaller 128MB)
    [void](Get-YoutabRegistrationRegularFile ([IO.Path]::ChangeExtension($uninstaller,'.dat')) 128MB)
    [void](Get-YoutabRegistrationRootFiles $Transaction.InstallRoot)
  }finally{$key.Dispose()}
  return $true
}
`
