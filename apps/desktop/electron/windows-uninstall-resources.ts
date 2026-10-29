/** Native current-user persistence cleanup, composed with the parent's path guards.
 * Inventory never executes a launcher or registers/modifies a Scheduled Task.
 */
export const WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS = String.raw`
function Get-YoutabResourcePath([string]$Value) {
  if (-not $Value -or $Value -notmatch '^[a-zA-Z]:[\\/]' -or $Value -match '[\x00-\x1f";|<>%!]' -or $Value.Substring(2).Contains(':')) { throw 'Invalid local persistence path.' }
  return [IO.Path]::GetFullPath($Value).TrimEnd([char[]]@([char]92,[char]47))
}
function Test-YoutabResourcePathEqual([string]$Left,[string]$Right) {
  return (Get-YoutabResourcePath $Left).Equals((Get-YoutabResourcePath $Right),[StringComparison]::OrdinalIgnoreCase)
}
function Test-YoutabResourceTextInside([string]$Text,[string]$Root) {
  return [regex]::IsMatch($Text,([regex]::Escape($Root)+'(?:[\\/]|["\r\n]|$)'),[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Get-YoutabResourceFile([string]$Path,[int]$Limit=65536) {
  Assert-NoReparseAncestors $Path
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Length -gt $Limit) { throw 'Persistence file is not a bounded regular file.' }
  $bytes=[IO.File]::ReadAllBytes($item.FullName)
  if($bytes.Length -gt $Limit) {throw 'Persistence file grew beyond its bound.'}
  $text=([Text.UTF8Encoding]::new($false,$true)).GetString($bytes)
  if ($text.Contains([string][char]0)) { throw 'Persistence file contains binary data.' }
  $sha=[Security.Cryptography.SHA256]::Create()
  try {$hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','')}finally{$sha.Dispose()}
  return [pscustomobject]@{Path=$item.FullName;Text=$text;Hash=$hash}
}
function Get-YoutabKnownUninstallHomes([string]$InstallRoot) {
  $root=Get-YoutabResourcePath $InstallRoot
  Assert-NoReparseAncestors $root
  $homes=@([pscustomobject]@{Id='default';Home=$root;TaskName='Youtab_Gateway';Launcher=[IO.Path]::Combine($root,'gateway-service','Youtab_Gateway.vbs')})
  $profiles=[IO.Path]::Combine($root,'profiles')
  Assert-NoReparseAncestors $profiles
  if (Test-Path -LiteralPath $profiles) {
    $entries=@(Get-ChildItem -LiteralPath $profiles -Force -ErrorAction Stop)
    if ($entries.Count -gt 256) { throw 'Too many profile entries for bounded uninstall inventory.' }
    foreach ($entry in $entries) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Profile persistence cannot be a reparse point.' }
      if ($entry.PSIsContainer -and $entry.Name -cmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {
        $task='Youtab_Gateway_'+$entry.Name
        $homes += [pscustomobject]@{Id=$entry.Name;Home=$entry.FullName;TaskName=$task;Launcher=[IO.Path]::Combine($entry.FullName,'gateway-service',$task+'.vbs')}
      }
    }
  }
  return @($homes | Sort-Object Home)
}
function ConvertTo-YoutabNativeArgument([string]$Value) {
  if ($Value -match '[\s"]') { return '"'+$Value.Replace('"','""')+'"' }
  return $Value
}
function ConvertTo-YoutabVbsLiteral([string]$Value) { return '"'+$Value.Replace('"','""')+'"' }
function Get-YoutabExpectedGatewayScripts($profileEntry,[string]$InstallRoot,[string]$Kind) {
  $runtime=[IO.Path]::Combine($InstallRoot,'youtab-agent-runtime')
  $venv=[IO.Path]::Combine($runtime,'venv')
  $suffix=if($profileEntry.Id -eq 'default'){''}else{' --profile '+$profileEntry.Id}
  $programs=@(
    [pscustomobject]@{Path=[IO.Path]::Combine($venv,'Scripts','youtab.exe');Arguments=$suffix+' gateway run'},
    [pscustomobject]@{Path=[IO.Path]::Combine($venv,'Scripts','python.exe');Arguments=' -m youtab_agent_cli.main'+$suffix+' gateway run'},
    [pscustomobject]@{Path=[IO.Path]::Combine($venv,'Scripts','pythonw.exe');Arguments=' -m youtab_agent_cli.main'+$suffix+' gateway run'}
  )
  $crlf=[string][char]13+[char]10
  foreach($program in $programs) {
    $command=(ConvertTo-YoutabNativeArgument $program.Path)+$program.Arguments
    if($Kind -eq 'vbs') {
      $lines=@(
        "' Youtab Agent Runtime Gateway - Messaging Platform Integration",'Option Explicit','Dim sh, env, existing_pp',
        'Set sh = CreateObject("WScript.Shell")','Set env = sh.Environment("PROCESS")',
        ('env.Item("YOUTAB_AGENT_HOME") = '+(ConvertTo-YoutabVbsLiteral $profileEntry.Home)),
        'env.Item("PYTHONIOENCODING") = "utf-8"','env.Item("YOUTAB_AGENT_GATEWAY_DETACHED") = "1"',
        ('env.Item("VIRTUAL_ENV") = '+(ConvertTo-YoutabVbsLiteral $venv)),
        'existing_pp = env.Item("PYTHONPATH")','If Len(existing_pp) > 0 Then',
        ('  env.Item("PYTHONPATH") = '+(ConvertTo-YoutabVbsLiteral ($runtime+';'))+' & existing_pp'),
        'Else',('  env.Item("PYTHONPATH") = '+(ConvertTo-YoutabVbsLiteral $runtime)),'End If',
        ('sh.CurrentDirectory = '+(ConvertTo-YoutabVbsLiteral $profileEntry.Home)),
        ('sh.Run '+(ConvertTo-YoutabVbsLiteral $command)+', 0, False')
      )
    } elseif($Kind -eq 'cmd') {
      $lines=@('@echo off','rem Youtab Agent Runtime Gateway - Messaging Platform Integration',
        ('cd /d '+(ConvertTo-YoutabNativeArgument $profileEntry.Home)),('set "YOUTAB_AGENT_HOME='+$profileEntry.Home+'"'),
        'set "PYTHONIOENCODING=utf-8"','set "YOUTAB_AGENT_GATEWAY_DETACHED=1"',
        ('set "VIRTUAL_ENV='+$venv+'"'),('set "PYTHONPATH='+$runtime+';%PYTHONPATH%"'),$command,'exit /b 0')
    } else { throw 'Unsupported gateway launcher form.' }
    ($lines -join $crlf)+$crlf
  }
}
function Assert-YoutabOwnedGatewayLauncher($profileEntry,[string]$InstallRoot) {
  $file=Get-YoutabResourceFile $profileEntry.Launcher
  $matches=@(Get-YoutabExpectedGatewayScripts $profileEntry $InstallRoot 'vbs' | Where-Object {$file.Text.Equals($_,[StringComparison]::OrdinalIgnoreCase)})
  if($matches.Count -ne 1) { throw 'Gateway launcher is modified or does not bind this home and private Runtime.' }
  return $file
}
function Get-YoutabExpectedStartupVbs($profileEntry) {
  $command='wscript.exe '+(ConvertTo-YoutabNativeArgument $profileEntry.Launcher)
  $lines=@("' Youtab Agent Runtime Gateway - Messaging Platform Integration",'Option Explicit','Dim fso, sh, target',
    ('target = '+(ConvertTo-YoutabVbsLiteral $profileEntry.Launcher)),'Set fso = CreateObject("Scripting.FileSystemObject")',
    'If Not fso.FileExists(target) Then WScript.Quit 0','Set sh = CreateObject("WScript.Shell")',
    ('sh.Run '+(ConvertTo-YoutabVbsLiteral $command)+', 0, False'))
  return ($lines -join ([string][char]13+[char]10))+[char]13+[char]10
}
function Get-YoutabRootTasks($Scheduler) {
  $folder=$Scheduler.GetFolder([string][char]92)
  $tasks=@($folder.GetTasks(1) | ForEach-Object {$_})
  if($tasks.Count -gt 4096) { throw 'Too many root tasks for bounded uninstall inventory.' }
  return $tasks
}
function Get-YoutabCurrentTaskIdentity {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try {return [pscustomobject]@{Sid=$identity.User.Value;Name=$identity.Name}}finally{$identity.Dispose()}
}
function Get-YoutabTaskFingerprint($Task) {
  $principal=$Task.Definition.Principal
  $account=[string]$principal.UserId
  if(-not $account -or [int]$principal.LogonType -ne 3 -or [int]$principal.RunLevel -ne 0) {throw 'Task principal is not a least-privilege interactive user.'}
  $current=Get-YoutabCurrentTaskIdentity
  if(-not ($account.Equals([string]$current.Sid,[StringComparison]::OrdinalIgnoreCase) -or $account.Equals([string]$current.Name,[StringComparison]::OrdinalIgnoreCase))) {throw 'Task belongs to a different Windows user.'}
  $sid=[string]$current.Sid
  $actions=@($Task.Definition.Actions | ForEach-Object {$_})
  $records=@($actions | ForEach-Object {[ordered]@{Type=[int]$_.Type;Path=[string]$_.Path;Arguments=[string]$_.Arguments;WorkingDirectory=[string]$_.WorkingDirectory}})
  return ([ordered]@{Name=[string]$Task.Name;Path=[string]$Task.Path;Principal=[ordered]@{UserId=$account;Sid=$sid;LogonType=[int]$principal.LogonType;RunLevel=[int]$principal.RunLevel};Actions=$records} | ConvertTo-Json -Depth 6 -Compress)
}
function Assert-YoutabAliasRegistryBinding($Plan,[string]$RegistryHome,[string]$RegistryPath) {
  if(-not $RegistryHome -or -not (Test-YoutabResourcePathEqual $RegistryHome $Plan.installRoot)) { throw 'Generic aliases are not bound to this installation HOME.' }
  $scripts=[IO.Path]::Combine($Plan.installRoot,'youtab-agent-runtime','venv','Scripts')
  $bound=$false
  foreach($entry in @($RegistryPath.Split(';'))) {
    $entry=[Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
    if($entry.Contains('%') -or $entry.StartsWith('\\')) {throw 'CLI PATH has an unresolved or network ownership entry.'}
    if(-not $entry -or $entry -notmatch '^[a-zA-Z]:[\\/]') {continue}
    $directory=Get-YoutabResourcePath $entry
    if(Test-YoutabResourcePathEqual $directory $scripts) {$bound=$true;break}
    foreach($name in @('youtab.com','youtab.exe','youtab.cmd','youtab.bat')) {
      if(Test-Path -LiteralPath ([IO.Path]::Combine($directory,$name))) { throw 'Another CLI precedes this installation in the user PATH.' }
    }
  }
  if(-not $bound) { throw 'Generic aliases are not bound to this installation CLI PATH.' }
  Assert-NoReparseAncestors ([IO.Path]::Combine($scripts,'youtab.exe'))
  if(-not (Test-Path -LiteralPath ([IO.Path]::Combine($scripts,'youtab.exe')) -PathType Leaf)) { throw 'The bound private CLI is missing.' }
}
function Get-YoutabUninstallResourceIdentity($Resources) {
  return ([ordered]@{
    KnownHomes=@($Resources.KnownHomes | Select-Object Id,Home,TaskName,Launcher)
    Tasks=@($Resources.Tasks | Select-Object Name,Path,Fingerprint,LauncherPath,LauncherHash)
    Files=@($Resources.Files | Select-Object Path,Hash,Kind,LauncherPath,LauncherHash)
  } | ConvertTo-Json -Depth 8 -Compress)
}
function Get-YoutabOwnedUninstallResources($Plan,$Scheduler,[string]$RegistryHome,[string]$RegistryPath) {
  $root=Get-YoutabResourcePath $Plan.installRoot
  $homes=@(Get-YoutabKnownUninstallHomes $root)
  $tasks=@();$files=@()
  foreach($task in @(Get-YoutabRootTasks $Scheduler)) {
    $actions=@($task.Definition.Actions | ForEach-Object {$_})
    foreach($action in $actions) {
      if([int]$action.Type -ne 0) {continue}
      $arguments=[string]$action.Arguments
      if($arguments -notmatch '^//B //Nologo "([^"]+)"$') {
        if(Test-YoutabResourceTextInside $arguments $root) {throw 'An ambiguous task refers to this installation.'}
        continue
      }
      $target=Get-YoutabResourcePath $Matches[1]
      $matching=@($homes | Where-Object {Test-YoutabResourcePathEqual $_.Launcher $target})
      if($matching.Count -eq 0) {
        if(Test-YoutabResourceTextInside $target $root) {throw 'A task refers to an unknown home inside this installation.'}
        continue
      }
      $profileEntry=$matching[0]
      if($actions.Count -ne 1 -or [int]$action.Type -ne 0 -or [string]$task.Name -cne $profileEntry.TaskName -or [string]$task.Path -cne ('\'+$profileEntry.TaskName)) {throw 'Task identity or action count is ambiguous.'}
      $command=[string]$action.Path
      $systemWscript=[IO.Path]::Combine([Environment]::SystemDirectory,'wscript.exe')
      if(-not ($command.Equals('wscript.exe',[StringComparison]::OrdinalIgnoreCase) -or $command.Equals($systemWscript,[StringComparison]::OrdinalIgnoreCase))) {throw 'Task executable is not the expected Windows script host.'}
      if($action.WorkingDirectory -and -not (Test-YoutabResourcePathEqual ([string]$action.WorkingDirectory) $profileEntry.Home)) {throw 'Task working directory does not match its home.'}
      $launcher=Assert-YoutabOwnedGatewayLauncher $profileEntry $root
      $tasks += [pscustomobject]@{Name=[string]$task.Name;Path=[string]$task.Path;Fingerprint=(Get-YoutabTaskFingerprint $task);LauncherPath=$launcher.Path;LauncherHash=$launcher.Hash;OriginalEnabled=[bool]$task.Enabled;SuspendedByUninstall=$false}
    }
  }
  $startup=Get-YoutabResourcePath $Plan.startupDirectory
  Assert-NoReparseAncestors $startup
  if(Test-Path -LiteralPath $startup) {
    $entries=@(Get-ChildItem -LiteralPath $startup -Force -ErrorAction Stop)
    if($entries.Count -gt 1024) {throw 'Too many Startup entries for bounded uninstall inventory.'}
    foreach($entry in $entries) {
      if($entry.Name -notmatch '^Youtab_Gateway(?:_[a-zA-Z0-9_-]+)?[.](vbs|cmd)$') {continue}
      $kind=$Matches[1].ToLowerInvariant()
      $file=Get-YoutabResourceFile $entry.FullName
      $matching=@($homes | Where-Object {$entry.Name -ceq ($_.TaskName+'.'+$kind)})
      $owned=$false
      if($matching.Count -eq 1) {
        $profileEntry=$matching[0]
        $expected=if($kind -eq 'vbs') {@(Get-YoutabExpectedStartupVbs $profileEntry)}else{@(Get-YoutabExpectedGatewayScripts $profileEntry $root 'cmd')}
        $owned=@($expected | Where-Object {$file.Text.Equals($_,[StringComparison]::OrdinalIgnoreCase)}).Count -eq 1
        if($owned) {
          $launcher=Assert-YoutabOwnedGatewayLauncher $profileEntry $root
          $files += [pscustomobject]@{Path=$file.Path;Hash=$file.Hash;Kind='startup';LauncherPath=$launcher.Path;LauncherHash=$launcher.Hash}
        }
      }
      if(-not $owned -and (Test-YoutabResourceTextInside $file.Text $root)) {throw 'An owned-looking Startup launcher has an unrecognized body.'}
    }
  }
  $aliases=Get-YoutabResourcePath $Plan.aliasDirectory
  Assert-NoReparseAncestors $aliases
  if(Test-Path -LiteralPath $aliases) {
    $entries=@(Get-ChildItem -LiteralPath $aliases -Filter '*.bat' -Force -ErrorAction Stop)
    if($entries.Count -gt 4096) {throw 'Too many aliases for bounded uninstall inventory.'}
    foreach($entry in $entries) {
      if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Alias inventory contains a reparse point.'}
      if($entry.PSIsContainer) {continue}
      if($entry.Length -gt 8192) {
        $reader=[IO.StreamReader]::new($entry.FullName)
        try {$buffer=New-Object char[] 8192;$read=$reader.ReadBlock($buffer,0,8192);$head=[string]::new($buffer,0,$read)}finally{$reader.Dispose()}
        if($head -match '(?im)youtab\s+-p\s+') {throw 'An oversized Youtab alias is ambiguous.'}
        continue
      }
      $file=Get-YoutabResourceFile $entry.FullName 8192
      if($file.Text -cmatch '\A@echo off(?<eol>\r\n|\r\r\n)youtab -p (?<id>[a-z0-9][a-z0-9_-]{0,63}) %\*\k<eol>\z') {
        $id=$Matches['id']
        if(@($homes | Where-Object {$_.Id -ceq $id}).Count -eq 0) {continue}
        if($entry.BaseName -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {throw 'An owned alias has an invalid generated filename.'}
        Assert-YoutabAliasRegistryBinding $Plan $RegistryHome $RegistryPath
        $files += [pscustomobject]@{Path=$file.Path;Hash=$file.Hash;Kind='alias';LauncherPath='';LauncherHash=''}
      } elseif($file.Text -match '(?im)youtab\s+-p\s+([a-z0-9][a-z0-9_-]{0,63})(?:\s|$)') {
        $id=$Matches[1]
        if(@($homes | Where-Object {$_.Id -ceq $id}).Count -gt 0) {throw 'A modified Youtab alias requires explicit cleanup.'}
      }
    }
  }
  $resources=[pscustomobject]@{Plan=$Plan;RegistryHome=$RegistryHome;RegistryPath=$RegistryPath;KnownHomes=$homes;Tasks=@($tasks | Sort-Object Path);Files=@($files | Sort-Object Path);Identity=''}
  $resources.Identity=Get-YoutabUninstallResourceIdentity $resources
  return $resources
}
function Assert-YoutabOwnedUninstallResources($Resources,$Scheduler,[string]$RegistryHome=$Resources.RegistryHome,[string]$RegistryPath=$Resources.RegistryPath) {
  if(-not $RegistryHome.Equals([string]$Resources.RegistryHome,[StringComparison]::OrdinalIgnoreCase) -or -not $RegistryPath.Equals([string]$Resources.RegistryPath,[StringComparison]::OrdinalIgnoreCase)) {throw 'Current registry ownership changed during uninstall.'}
  $current=Get-YoutabOwnedUninstallResources $Resources.Plan $Scheduler $RegistryHome $RegistryPath
  if($current.Identity -cne $Resources.Identity) {throw 'Persistence resources changed since uninstall inventory.'}
  foreach($snapshot in $Resources.Tasks) {
    $task=@($current.Tasks | Where-Object {$_.Path -ceq $snapshot.Path})[0]
    $expected=if($snapshot.SuspendedByUninstall){$false}else{$snapshot.OriginalEnabled}
    if([bool]$task.OriginalEnabled -ne [bool]$expected) {throw 'Task enabled state changed during uninstall.'}
  }
}
function Suspend-YoutabOwnedUninstallTasks($Resources,$Scheduler) {
  Assert-YoutabOwnedUninstallResources $Resources $Scheduler
  foreach($snapshot in $Resources.Tasks) {
    if(-not $snapshot.OriginalEnabled -or $snapshot.SuspendedByUninstall) {continue}
    $task=@(Get-YoutabRootTasks $Scheduler | Where-Object {$_.Path -ceq $snapshot.Path})[0]
    if((Get-YoutabTaskFingerprint $task) -cne $snapshot.Fingerprint -or (Get-YoutabResourceFile $snapshot.LauncherPath).Hash -cne $snapshot.LauncherHash) {throw 'Task changed immediately before suspension.'}
    $snapshot.SuspendedByUninstall=$true
    $task.Enabled=$false
    if($task.Enabled) {throw 'An owned task could not be suspended.'}
  }
}
function Restore-YoutabOwnedUninstallTasks($Resources,$Scheduler) {
  $failed=$false
  foreach($snapshot in $Resources.Tasks) {
    if(-not $snapshot.OriginalEnabled -or -not $snapshot.SuspendedByUninstall) {continue}
    try {
      $matching=@(Get-YoutabRootTasks $Scheduler | Where-Object {$_.Path -ceq $snapshot.Path})
      if($matching.Count -ne 1 -or (Get-YoutabTaskFingerprint $matching[0]) -cne $snapshot.Fingerprint) {throw 'Task identity changed before restore.'}
      $launcher=Get-YoutabResourceFile $snapshot.LauncherPath
      if($launcher.Hash -cne $snapshot.LauncherHash) {throw 'Task launcher changed before restore.'}
      $matching[0].Enabled=$true
      if(-not $matching[0].Enabled) {throw 'Task enable state could not be restored.'}
      $snapshot.SuspendedByUninstall=$false
    } catch {$failed=$true}
  }
  if($failed) {throw 'Some owned task states could not be restored safely.'}
}
function Remove-YoutabOwnedUninstallResources($Resources,$Scheduler) {
  Assert-YoutabOwnedUninstallResources $Resources $Scheduler
  $folder=$Scheduler.GetFolder([string][char]92)
  foreach($snapshot in $Resources.Tasks) {
    $task=@(Get-YoutabRootTasks $Scheduler | Where-Object {$_.Path -ceq $snapshot.Path})[0]
    if((Get-YoutabTaskFingerprint $task) -cne $snapshot.Fingerprint -or (Get-YoutabResourceFile $snapshot.LauncherPath).Hash -cne $snapshot.LauncherHash) {throw 'Task changed immediately before deletion.'}
    $task.Enabled=$false
    if($task.Enabled) {throw 'An owned task could not be disabled.'}
    if([int]$task.State -in @(2,4)) {$task.Stop(0)}
    $folder.DeleteTask($snapshot.Name,0)
    if(@(Get-YoutabRootTasks $Scheduler | Where-Object {$_.Path -ceq $snapshot.Path}).Count -gt 0) {throw 'An owned task remains after deletion.'}
  }
  foreach($snapshot in $Resources.Files) {
    if((Get-YoutabResourceFile $snapshot.Path).Hash -cne $snapshot.Hash) {throw 'External persistence file changed immediately before deletion.'}
    Remove-Item -LiteralPath $snapshot.Path -Force -ErrorAction Stop
    if(Test-Path -LiteralPath $snapshot.Path) {throw 'External persistence file remains after deletion.'}
  }
}
`
