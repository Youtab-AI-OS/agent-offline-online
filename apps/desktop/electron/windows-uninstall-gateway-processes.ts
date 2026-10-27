/** Native, narrowly scoped gateway inventory/drain for an already confirmed full uninstall. */
export const WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS = String.raw`
function Initialize-YoutabGatewayNative {
  if ('YoutabUninstallGatewayNative' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class YoutabUninstallGatewayNative {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string text, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [StructLayout(LayoutKind.Sequential)] struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
  [StructLayout(LayoutKind.Sequential)] struct AttributeTag { public uint Attributes; public uint Tag; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref Disposition info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out AttributeTag info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
  public static string[] Arguments(string text) {
    int count; IntPtr value=CommandLineToArgvW(text,out count);
    if(value==IntPtr.Zero) throw new Win32Exception();
    try { var result=new string[count]; for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(value,i*IntPtr.Size)); return result; }
    finally { LocalFree(value); }
  }
  public static bool RemoveIfSame(string path,string content) {
    using(var handle=CreateFile(path,0x80010000,0,IntPtr.Zero,3,0x00200080,IntPtr.Zero)) {
      if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); if(error==2 || error==3) return false; throw new Win32Exception(error); }
      AttributeTag attributes;
      if(!GetFileInformationByHandleEx(handle,9,out attributes,(uint)Marshal.SizeOf(typeof(AttributeTag)))) throw new Win32Exception();
      if((attributes.Attributes & 0x400)!=0) throw new InvalidOperationException("Refusing a reparse stop marker.");
      using(var stream=new FileStream(handle,FileAccess.Read)) {
        if(stream.Length>8192) return false;
        using(var reader=new StreamReader(stream,new UTF8Encoding(false,true),true,1024,true)) {
          if(reader.ReadToEnd()!=content) return false;
        }
        var disposition=new Disposition { Delete=true };
        if(!SetFileInformationByHandle(handle,4,ref disposition,(uint)Marshal.SizeOf(typeof(Disposition)))) throw new Win32Exception();
        return true;
      }
    }
  }
  public static bool TerminateIfSame(int pid,long start,string executable) {
    IntPtr process=OpenProcess(0x1001,false,pid);
    if(process==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==87) return false; throw new Win32Exception(error); }
    try {
      long created,exited,kernel,user;
      if(!GetProcessTimes(process,out created,out exited,out kernel,out user)) throw new Win32Exception();
      long fingerprint=(long)Math.Round((DateTime.FromFileTimeUtc(created)-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalSeconds*100);
      var name=new StringBuilder(32768); int size=name.Capacity;
      if(!QueryFullProcessImageName(process,0,name,ref size)) throw new Win32Exception();
      if(fingerprint!=start || !Path.GetFullPath(name.ToString()).Equals(Path.GetFullPath(executable),StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Gateway process identity changed before termination.");
      if(!TerminateProcess(process,1)) throw new Win32Exception();
      return true;
    } finally { CloseHandle(process); }
  }
}
'@ -ErrorAction Stop
}
function Get-YoutabGatewayProcessIdentity([int]$TargetPid) {
  $native = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $native) { return $null }
  $created = $native.StartTime.ToUniversalTime()
  $executable = [string]$native.Path
  $cim = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $TargetPid) -OperationTimeoutSec 3 -ErrorAction Stop
  if (-not $cim) { return $null }
  $fingerprint = [long][Math]::Round(($created - [DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalSeconds * 100)
  $cimFingerprint = [long][Math]::Round(($cim.CreationDate.ToUniversalTime() - [DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalSeconds * 100)
  if ($cim.ProcessId -ne $TargetPid -or $fingerprint -ne $cimFingerprint -or -not $executable -or -not $cim.ExecutablePath -or
    -not $executable.Equals([string]$cim.ExecutablePath,[StringComparison]::OrdinalIgnoreCase) -or -not $cim.CommandLine) { throw 'Gateway live identity is unavailable or changed.' }
  return [pscustomobject]@{Pid=$TargetPid;StartTime=$fingerprint;Executable=$executable;CommandLine=[string]$cim.CommandLine}
}
function Assert-YoutabGatewayCommand($Identity,$Plan,[string]$ProfileId) {
  $runtime = [IO.Path]::Combine($Plan.installRoot,'youtab-agent-runtime')
  $venv = [IO.Path]::Combine($runtime,'venv\Scripts')
  $base = [IO.Path]::Combine($Plan.installRoot,'python\cpython-3.11-windows-x86_64-none')
  $allowed = @([IO.Path]::Combine($venv,'python.exe'),[IO.Path]::Combine($venv,'pythonw.exe'),[IO.Path]::Combine($venv,'youtab.exe'),
    [IO.Path]::Combine($base,'python.exe'),[IO.Path]::Combine($base,'pythonw.exe'))
  $executable = [IO.Path]::GetFullPath([string]$Identity.Executable)
  if (-not @($allowed | Where-Object { $_.Equals($executable,[StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'Gateway executable is outside this installation private Runtime.' }
  Assert-NoReparseAncestors $executable
  $arguments = @([YoutabUninstallGatewayNative]::Arguments([string]$Identity.CommandLine))
  if ($arguments.Count -lt 3 -or -not ([IO.Path]::GetFullPath($arguments[0]).Equals($executable,[StringComparison]::OrdinalIgnoreCase))) { throw 'Gateway executable and command line disagree.' }
  $index = 1
  if (-not $executable.EndsWith('\youtab.exe',[StringComparison]::OrdinalIgnoreCase)) {
    while ($index -lt $arguments.Count -and $arguments[$index] -cin @('-u','-B')) { $index++ }
    if ($index + 1 -lt $arguments.Count -and $arguments[$index] -ceq '-m' -and $arguments[$index+1] -ceq 'youtab_agent_cli.main') { $index += 2 }
    elseif ($index -lt $arguments.Count -and ([string]$arguments[$index]).Equals([IO.Path]::Combine($venv,'youtab.exe'),[StringComparison]::OrdinalIgnoreCase)) { $index++ }
    else { throw 'Gateway command does not use this Runtime entry point.' }
  }
  $profile = $null; $verbs = New-Object 'System.Collections.Generic.List[string]'
  for (; $index -lt $arguments.Count; $index++) {
    $part = [string]$arguments[$index]
    if ($part -cin @('--profile','-p')) {
      if ($null -ne $profile -or ++$index -ge $arguments.Count) { throw 'Ambiguous gateway profile selector.' }
      $profile = [string]$arguments[$index]
    } elseif ($part -cmatch '^(--profile|-p)=(.+)$') {
      if ($null -ne $profile) { throw 'Ambiguous gateway profile selector.' }
      $profile = $Matches[2]
    } else { $verbs.Add($part) }
  }
  if ($verbs.Count -lt 2 -or $verbs.Count -gt 3 -or $verbs[0] -cne 'gateway' -or $verbs[1] -cne 'run' -or ($verbs.Count -eq 3 -and $verbs[2] -cne '--replace')) { throw 'Live process is not the recognized gateway run command.' }
  if (($ProfileId -eq 'default' -and $null -ne $profile -and $profile -cne 'default') -or
    ($ProfileId -ne 'default' -and $profile -cne $ProfileId)) { throw 'Live gateway belongs to another profile.' }
}
function Get-YoutabOwnedGatewayProcesses($Plan,$KnownHomes) {
  Initialize-YoutabGatewayNative
  $snapshots = @(); $seen = @{}
  if (@($KnownHomes).Count -gt 128) { throw 'Too many gateway homes for a bounded uninstall preflight.' }
  foreach ($entry in @($KnownHomes)) {
    $gatewayHome = [IO.Path]::GetFullPath([string]$entry.Home).TrimEnd([char[]]@([char]92,[char]47))
    $profileId = [string]$entry.Id
    $expected = [string]$Plan.installRoot
    if ($profileId -ne 'default') {
      if ($profileId -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { throw 'Unrecognized gateway profile.' }
      $expected = [IO.Path]::Combine($Plan.installRoot,'profiles',$profileId)
    }
    if (-not $gatewayHome.Equals([IO.Path]::GetFullPath($expected).TrimEnd([char]92),[StringComparison]::OrdinalIgnoreCase)) { throw 'Gateway home escaped its known profile.' }
    Assert-NoReparseAncestors $gatewayHome
    $pidFile = [IO.Path]::Combine($gatewayHome,'gateway.pid')
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    Assert-NoReparseAncestors $pidFile
    $file = Get-Item -LiteralPath $pidFile -Force -ErrorAction Stop
    if ($file.PSIsContainer -or $file.Length -gt 65536) { throw 'Gateway PID record is not a bounded file.' }
    try { $record = [IO.File]::ReadAllText($pidFile) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Gateway PID record is malformed; stop ownership is unproven.' }
    $target = $record.pid
    if ($record -is [int] -or $record -is [long]) { $target=$record }
    if (($target -isnot [int] -and $target -isnot [long]) -or $target -le 0 -or $target -gt [int]::MaxValue) { throw 'Gateway PID record has no valid numeric process identity.' }
    $identity = Get-YoutabGatewayProcessIdentity ([int]$target)
    if ($null -eq $identity) { continue }
    if ($record.kind -cne 'youtab-gateway' -or ($record.start_time -isnot [int] -and $record.start_time -isnot [long]) -or $record.start_time -le 0 -or
      -not ([string]$record.youtab_home).Equals($gatewayHome,[StringComparison]::OrdinalIgnoreCase)) { throw 'Live gateway has legacy or unverified PID ownership.' }
    if ([long]$identity.StartTime -ne [long]$record.start_time) { throw 'Gateway PID was reused by another process.' }
    Assert-YoutabGatewayCommand $identity $Plan $profileId
    if ($seen.ContainsKey([string]$target)) { throw 'One gateway process is claimed by multiple homes.' }
    $seen[[string]$target] = $true
    $marker = [IO.Path]::Combine($gatewayHome,'.gateway-planned-stop.json')
    Assert-NoReparseAncestors $marker
    if (Test-Path -LiteralPath $marker) { throw 'A gateway stop operation is already pending.' }
    $snapshots += [pscustomobject]@{Pid=[int]$target;StartTime=[long]$record.start_time;Home=$gatewayHome;ProfileId=$profileId;
      PidFile=$pidFile;Executable=[string]$identity.Executable;CommandLine=[string]$identity.CommandLine;MarkerPath=$marker;MarkerContent=$null;MarkerToken=$null;StopperPid=$null}
  }
  return $snapshots
}
function Get-YoutabRevalidatedGateway($Snapshot,$Plan) {
  $identity = Get-YoutabGatewayProcessIdentity $Snapshot.Pid
  if ($null -eq $identity) { return $null }
  if ([long]$identity.StartTime -ne [long]$Snapshot.StartTime -or -not ([string]$identity.Executable).Equals([string]$Snapshot.Executable,[StringComparison]::OrdinalIgnoreCase) -or
    [string]$identity.CommandLine -cne [string]$Snapshot.CommandLine) { throw 'Gateway live identity changed after preflight.' }
  Assert-NoReparseAncestors $Snapshot.Home
  Assert-NoReparseAncestors $Snapshot.PidFile
  if (-not (Test-Path -LiteralPath $Snapshot.PidFile)) { throw 'Live gateway ownership record disappeared; force stop is refused.' }
  $file = Get-Item -LiteralPath $Snapshot.PidFile -Force -ErrorAction Stop
  if ($file.PSIsContainer -or $file.Length -gt 65536) { throw 'Gateway ownership record changed.' }
  $record = [IO.File]::ReadAllText($Snapshot.PidFile) | ConvertFrom-Json -ErrorAction Stop
  if ($record.kind -cne 'youtab-gateway' -or ($record.pid -isnot [int] -and $record.pid -isnot [long]) -or $record.pid -ne $Snapshot.Pid -or
    ($record.start_time -isnot [int] -and $record.start_time -isnot [long]) -or $record.start_time -ne $Snapshot.StartTime -or
    -not ([string]$record.youtab_home).Equals([string]$Snapshot.Home,[StringComparison]::OrdinalIgnoreCase)) { throw 'Gateway ownership record changed after preflight.' }
  Assert-YoutabGatewayCommand $identity $Plan $Snapshot.ProfileId
  return $identity
}
function Assert-YoutabGatewayStopNotCancelled($Handoff) {
  Assert-NoReparseAncestors $Handoff.directory
  $cancel = [IO.Path]::Combine($Handoff.directory,'cancel')
  if (Test-Path -LiteralPath $cancel) {
    Assert-NoReparseAncestors $cancel
    if ([IO.File]::ReadAllText($cancel) -ceq [string]$Handoff.token) { throw 'Uninstall was cancelled before gateway teardown completed.' }
  }
}
function Remove-YoutabOwnedGatewayStopMarkers($Snapshots,$Handoff) {
  foreach ($snapshot in @($Snapshots)) {
    if ($snapshot.MarkerContent -and $snapshot.MarkerToken -ceq [string]$Handoff.token -and $snapshot.StopperPid -eq $PID) {
      Assert-NoReparseAncestors $snapshot.MarkerPath
      [void][YoutabUninstallGatewayNative]::RemoveIfSame($snapshot.MarkerPath,$snapshot.MarkerContent)
    }
  }
}
function Stop-YoutabGatewayProcess($Identity) {
  [void][YoutabUninstallGatewayNative]::TerminateIfSame($Identity.Pid,$Identity.StartTime,$Identity.Executable)
}
function Stop-YoutabOwnedGatewayProcesses($Snapshots,$Plan,$Handoff,[int]$GraceMilliseconds=20000) {
  $grace = [Math]::Min(20000,[Math]::Max(1,$GraceMilliseconds))
  try {
    Assert-YoutabGatewayStopNotCancelled $Handoff
    foreach ($snapshot in @($Snapshots)) {
      Assert-YoutabGatewayStopNotCancelled $Handoff
      [void](Get-YoutabRevalidatedGateway $snapshot $Plan)
    }
    foreach ($snapshot in @($Snapshots)) {
      Assert-YoutabGatewayStopNotCancelled $Handoff
      if ($null -eq (Get-YoutabRevalidatedGateway $snapshot $Plan)) { continue }
      $snapshot.MarkerContent = [ordered]@{target_pid=$snapshot.Pid;target_start_time=$snapshot.StartTime;stopper_pid=$PID;
        written_at=[DateTime]::UtcNow.ToString('o');target_youtab_home=$snapshot.Home} | ConvertTo-Json -Compress
      $snapshot.MarkerToken = [string]$Handoff.token; $snapshot.StopperPid = $PID
      $temporary = [IO.Path]::Combine($snapshot.Home,('.youtab-uninstall-stop-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
      try {
        $stream = New-Object IO.FileStream($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($snapshot.MarkerContent);$stream.Write($bytes,0,$bytes.Length);$stream.Flush() } finally { $stream.Dispose() }
        Assert-YoutabGatewayStopNotCancelled $Handoff
        if ($null -eq (Get-YoutabRevalidatedGateway $snapshot $Plan)) { continue }
        Assert-NoReparseAncestors $snapshot.MarkerPath
        [IO.File]::Move($temporary,$snapshot.MarkerPath)
      } finally {
        if (Test-Path -LiteralPath $temporary) { [void][YoutabUninstallGatewayNative]::RemoveIfSame($temporary,$snapshot.MarkerContent) }
      }
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
      Assert-YoutabGatewayStopNotCancelled $Handoff
      $live = @()
      foreach ($snapshot in @($Snapshots)) {
        Assert-YoutabGatewayStopNotCancelled $Handoff
        if ($null -ne (Get-YoutabGatewayProcessIdentity $snapshot.Pid)) { $live += $snapshot }
      }
      if ($live.Count -eq 0) { return }
      Start-Sleep -Milliseconds 100
    } while ($clock.ElapsedMilliseconds -lt $grace)
    foreach ($snapshot in @($Snapshots)) {
      Assert-YoutabGatewayStopNotCancelled $Handoff
      $identity = Get-YoutabRevalidatedGateway $snapshot $Plan
      if ($null -ne $identity) { Stop-YoutabGatewayProcess $identity }
    }
    $clock.Restart()
    do {
      Assert-YoutabGatewayStopNotCancelled $Handoff
      $live = @()
      foreach ($snapshot in @($Snapshots)) {
        Assert-YoutabGatewayStopNotCancelled $Handoff
        if ($null -ne (Get-YoutabGatewayProcessIdentity $snapshot.Pid)) { $live += $snapshot }
      }
      if ($live.Count -eq 0) { return }
      Start-Sleep -Milliseconds 100
    } while ($clock.ElapsedMilliseconds -lt 2000)
    throw 'Verified gateways did not exit after the bounded stop window.'
  } catch {
    Remove-YoutabOwnedGatewayStopMarkers $Snapshots $Handoff
    throw
  }
}
`
