function Get-YoutabPublicationPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { return '\\' + $full.Substring(8) }
    if ($full.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { return $full.Substring(4) }
    return $full
}
# Narrow publication journal for common Setup private-home relocation.
# Loaded only from the verified NEW Runtime. These functions are never used by
# ordinary installation/update or by source-home code.
function Read-YoutabUserValue([string]$Name) {
    [Environment]::GetEnvironmentVariable($Name, 'User')
}
function Write-YoutabUserValue([string]$Name, [AllowNull()][string]$Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
}
function Read-YoutabLinkBytes([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    if ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Shortcut reparse point refused'
    }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt 1048576) { throw 'Publication file is too large' }
        $bytes = New-Object byte[] $stream.Length
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if (-not $count) { throw 'Publication file changed while reading' }
            $offset += $count
        }
        return [Convert]::ToBase64String($bytes)
    } finally { $stream.Dispose() }
}
function Assert-YoutabSingleStageFile($Stream) {
    if (-not ('YoutabPublicationFileInfo' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YoutabPublicationFileInfo {
    [StructLayout(LayoutKind.Sequential)] public struct Info {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, NumberOfLinks, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);
}
'@
    }
    $info = New-Object YoutabPublicationFileInfo+Info
    if (-not [YoutabPublicationFileInfo]::GetFileInformationByHandle($Stream.SafeFileHandle.DangerousGetHandle(), [ref]$info) -or
        $info.NumberOfLinks -ne 1 -or ($info.Attributes -band 1040)) {
        throw 'Publication stage is not a regular single-link file'
    }
}
function Get-YoutabLinkStagePath([string]$Path, [AllowNull()]$Value, [string]$TargetHome) {
    if ($null -eq $Value) { return $null }
    $homeKey = (Get-YoutabPublicationPath $TargetHome).ToLowerInvariant()
    $pathKey = (Get-YoutabPublicationPath $Path).ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$homeKey`n$pathKey`n$Value"))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return Join-Path ([IO.Path]::GetDirectoryName($Path)) ".youtab-relocation-$hash.staged"
}
function Get-YoutabStagePrefixLength($Stream, [byte[]]$Bytes) {
    Assert-YoutabSingleStageFile $Stream
    if ($Stream.Length -gt $Bytes.Length -or $Bytes.Length -gt 1048576) { throw 'Publication stage length differs from journal intent' }
    $prefix = New-Object byte[] $Stream.Length
    $offset = 0
    while ($offset -lt $prefix.Length) {
        $count = $Stream.Read($prefix, $offset, $prefix.Length - $offset)
        if (-not $count) { throw 'Publication stage changed while reading' }
        $offset += $count
    }
    for ($index = 0; $index -lt $prefix.Length; $index++) {
        if ($prefix[$index] -ne $Bytes[$index]) { throw 'Publication stage differs from journal intent; retained for review' }
    }
    return $prefix.Length
}
function Assert-YoutabLinkStage([string]$Path, [AllowNull()]$Value, [string]$TargetHome) {
    $stage = Get-YoutabLinkStagePath $Path $Value $TargetHome
    if ($null -eq $stage -or -not [IO.File]::Exists($stage)) { return }
    if ([IO.File]::GetAttributes($stage) -band [IO.FileAttributes]::ReparsePoint) { throw 'Publication stage reparse point refused' }
    $stream = [IO.File]::Open($stage, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { $null = Get-YoutabStagePrefixLength $stream ([Convert]::FromBase64String($Value)) }
    finally { $stream.Dispose() }
}
function Remove-YoutabLinkStages([string]$Path, [AllowNull()]$Previous, [AllowNull()]$Desired, [string]$TargetHome) {
    foreach ($value in @($Previous, $Desired) | Select-Object -Unique) {
        Assert-YoutabLinkStage $Path $value $TargetHome
        $stage = Get-YoutabLinkStagePath $Path $value $TargetHome
        if ($null -ne $stage -and [IO.File]::Exists($stage)) { [IO.File]::Delete($stage) }
    }
}
function Write-YoutabPublicationFileBytes($Stream, [byte[]]$Bytes, [int]$Offset, [string]$Path) {
    $Stream.Write($Bytes, $Offset, $Bytes.Length - $Offset)
}
function Write-YoutabLinkBytes([string]$Path, [AllowNull()]$Value, [string]$TargetHome,
    [AllowNull()]$Previous = $null, [AllowNull()]$Desired = $Value) {
    # Both allowed destination states and the deterministic sibling stage are
    # bound to the publication snapshot persisted before Invoke's first effect.
    if (-not $TargetHome) { throw 'Publication stage requires its target identity' }
    if ($null -ne $Value) {
        $bytes = [Convert]::FromBase64String($Value)
        if ($bytes.Length -gt 1048576) { throw 'Publication file is too large' }
        $stage = Get-YoutabLinkStagePath $Path $Value $TargetHome
        Assert-YoutabLinkStage $Path $Value $TargetHome
        $mode = if ([IO.File]::Exists($stage)) { [IO.FileMode]::Open } else { [IO.FileMode]::CreateNew }
        $stream = [IO.File]::Open($stage, $mode, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            $offset = Get-YoutabStagePrefixLength $stream $bytes
            Write-YoutabPublicationFileBytes $stream $bytes $offset $Path
            $stream.Flush($true)
        } finally { $stream.Dispose() }
    }
    $current = Read-YoutabLinkBytes $Path
    if ($current -cne $Previous -and $current -cne $Desired) { throw 'Publication destination changed; stage retained for review' }
    if ($current -ceq $Value) { return }
    if ($null -eq $Value) {
        if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }
    } elseif ([IO.File]::Exists($Path)) {
        [IO.File]::Replace($stage, $Path, [System.Management.Automation.Language.NullString]::Value)
    } else { [IO.File]::Move($stage, $Path) }
}

function Get-YoutabManagedGitBashTarget([AllowNull()][string]$Value, [string]$SourceHome, [string]$TargetHome) {
    if (-not $Value) { return $null }
    $source = (Get-YoutabPublicationPath $SourceHome).TrimEnd('\') + '\'
    try { $current = Get-YoutabPublicationPath $Value } catch { return $null }
    if (-not $current.StartsWith($source, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return Join-Path (Get-YoutabPublicationPath $TargetHome) 'git\bin\bash.exe'
}
function Assert-YoutabFreshManagedGit([string]$TargetHome) {
    $target = Get-YoutabPublicationPath $TargetHome
    $runtime = Join-Path $target 'youtab-agent-runtime'
    $lock = [IO.File]::ReadAllText((Join-Path $runtime 'config\windows-private-home-prerequisites.json')) | ConvertFrom-Json
    $receiptPath = Join-Path $target 'bootstrap-cache\private-prerequisites\git-receipt.json'
    if (-not [IO.File]::Exists($receiptPath) -or ([IO.File]::GetAttributes($receiptPath) -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Fresh managed Git receipt is absent or linked'
    }
    $receipt = [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
    if ($receipt.archiveSha256 -cne $lock.git.sha256 -or $receipt.archiveSize -ne $lock.git.size -or
        $receipt.version -cne $lock.git.version -or $receipt.bashProbePassed -ne $true) { throw 'Fresh managed Git receipt differs from the reviewed lock' }
    $git = Join-Path $target 'git'
    if (-not [IO.Directory]::Exists($git) -or ([IO.File]::GetAttributes($git) -band [IO.FileAttributes]::ReparsePoint)) { throw 'Fresh managed Git root absent or linked' }
    $files = @(Get-ChildItem -LiteralPath $git -Recurse -Force)
    if (@($receipt.files.PSObject.Properties).Count -ne @($files | Where-Object { -not $_.PSIsContainer }).Count) { throw 'Fresh Git inventory differs' }
    foreach ($file in $files) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fresh Git entry is linked' }
        if (-not $file.PSIsContainer) {
            $relative = $file.FullName.Substring($git.Length + 1)
            $expected = $receipt.files.PSObject.Properties[$relative]
            if ($null -eq $expected -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected.Value) { throw 'Fresh Git bytes differ from provisioning receipt' }
        }
    }
    foreach ($relative in @('bin\bash.exe', 'cmd\git.exe', 'usr\bin\msys-2.0.dll')) {
        if (-not [IO.File]::Exists((Join-Path $git $relative))) { throw 'Fresh managed Git binding lacks required code' }
    }
    return Join-Path $git 'bin\bash.exe'
}

function Write-YoutabRelocationJournal([string]$Path, $Journal) {
    $temp = "$Path.new-staged"
    $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($Journal | ConvertTo-Json -Depth 100))
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    [IO.File]::Replace($temp, $Path, [System.Management.Automation.Language.NullString]::Value)
}
function Read-YoutabRelocationJournal([string]$Path, [string]$TargetHome) {
    if ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Publication journal reparse point refused'
    }
    if (([IO.FileInfo]$Path).Length -gt 16777216) { throw 'Publication journal is too large' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt 16777216) { throw 'Publication journal is too large' }
        $reader = New-Object IO.StreamReader $stream
        try { $journal = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    if ($journal.schema -ne 1 -or $journal.phase -ne 'product-validated' -or
        (Get-YoutabPublicationPath $journal.target) -ine (Get-YoutabPublicationPath $TargetHome)) {
        throw 'Relocation product is not ready for publication'
    }
    return $journal
}
function New-YoutabRelocationPublication($Journal, [string]$TargetExe, [string[]]$LinkPaths) {
    $target = Get-YoutabPublicationPath $Journal.target
    $source = Get-YoutabPublicationPath $Journal.source
    $prefix = $target.TrimEnd('\') + '\youtab-agent-runtime\'
    if (-not $TargetExe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Publication Desktop is outside target Runtime'
    }
    $previousPath = Read-YoutabUserValue 'Path'
    $oldManaged = @(
        "$source\youtab-agent-runtime\venv\Scripts", "$source\node", "$source\node\bin",
        "$source\git\cmd", "$source\git\bin", "$source\git\usr\bin", "$source\bin"
    )
    $remaining = @($previousPath -split ';' | Where-Object {
        $_ -and $oldManaged -notcontains $_.TrimEnd('\')
    })
    $desiredPath = (@("$target\youtab-agent-runtime\venv\Scripts", "$target\node") + $remaining |
        Select-Object -Unique) -join ';'
    $variables = @(
        @{ name = 'Path'; previous = $previousPath; desired = $desiredPath },
        @{ name = 'YOUTAB_AGENT_HOME'; previous = (Read-YoutabUserValue 'YOUTAB_AGENT_HOME'); desired = $target }
    )
    # Preserve unrelated Git Bash choices; source-owned executable references
    # must be replaced with fresh target code before runtime use.
    $previousBash = Read-YoutabUserValue 'YOUTAB_AGENT_GIT_BASH_PATH'
    $newBash = Get-YoutabManagedGitBashTarget $previousBash $source $target
    if ($newBash) {
        if ((Assert-YoutabFreshManagedGit $target) -ine $newBash) { throw 'Fresh managed Git Bash binding differs' }
        $variables[0].desired = (@("$target\youtab-agent-runtime\venv\Scripts", "$target\node",
            "$target\git\cmd", "$target\git\bin", "$target\git\usr\bin") + $remaining | Select-Object -Unique) -join ';'
        $variables += @{ name = 'YOUTAB_AGENT_GIT_BASH_PATH'; previous = $previousBash; desired = $newBash }
    }
    $links = @()
    $shell = New-Object -ComObject WScript.Shell
    $pending = Join-Path $target 'bootstrap-cache\relocation-shortcuts'
    [IO.Directory]::CreateDirectory($pending) | Out-Null
    $index = 0
    foreach ($path in $LinkPaths) {
        if ([IO.Path]::GetFileName($path) -ne 'Youtab.lnk') { throw 'Unexpected product shortcut' }
        $previous = Read-YoutabLinkBytes $path
        if ($null -ne $previous) {
            $oldShortcut = $shell.CreateShortcut($path)
            if (-not $oldShortcut.TargetPath.StartsWith("$source\youtab-agent-runtime\", [StringComparison]::OrdinalIgnoreCase) -and
                -not $oldShortcut.TargetPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Unrelated shortcut collision'
            }
        }
        $staged = Join-Path $pending "$index.lnk"
        $existing = [IO.File]::Exists($staged)
        $shortcut = $shell.CreateShortcut($staged)
        if ($existing -and ($shortcut.TargetPath -ine $TargetExe -or $shortcut.Arguments -or
            $shortcut.WorkingDirectory -ine [IO.Path]::GetDirectoryName($TargetExe))) {
            throw 'Shortcut staging collision retained for review'
        }
        $shortcut.TargetPath = $TargetExe
        $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($TargetExe)
        $shortcut.IconLocation = "$TargetExe,0"
        if (-not $existing) { $shortcut.Save() }
        $links += @{ path = $path; previous = $previous; desired = (Read-YoutabLinkBytes $staged) }
        $index++
    }
    return @{ schema = 1; phase = 'prepared'; variables = $variables; links = $links;
        autostart = @(New-YoutabAutostartRelocation $Journal) }
}
function Invoke-YoutabRelocationPublication([string]$JournalPath, [string]$TargetHome,
    [ValidateSet('apply', 'rollback')][string]$Action) {
    $journal = Read-YoutabRelocationJournal $JournalPath $TargetHome
    $publication = $journal.publication
    if ($null -eq $publication -or $publication.schema -ne 1 -or
        @('prepared', 'environment-applied', 'autostart-applied', 'published', 'rolled-back') -notcontains $publication.phase) {
        throw 'Publication snapshot is absent or invalid'
    }
    # Check ALL effects before the first write. Concurrent external changes
    # fail closed rather than being overwritten during apply or recovery.
    foreach ($variable in $publication.variables) {
        if (@('Path', 'YOUTAB_AGENT_HOME', 'YOUTAB_AGENT_GIT_BASH_PATH') -notcontains $variable.name) {
            throw 'Unknown publication environment variable'
        }
        $current = Read-YoutabUserValue $variable.name
        if ($current -cne $variable.previous -and $current -cne $variable.desired) {
            throw 'Environment changed outside this relocation; journal retained'
        }
    }
    foreach ($link in $publication.links) {
        if ([IO.Path]::GetFileName($link.path) -ne 'Youtab.lnk') { throw 'Unknown publication shortcut' }
        Assert-YoutabLinkStage $link.path $link.previous $journal.target
        Assert-YoutabLinkStage $link.path $link.desired $journal.target
        $current = Read-YoutabLinkBytes $link.path
        if ($current -cne $link.previous -and $current -cne $link.desired) {
            throw 'Shortcut changed outside this relocation; journal retained'
        }
    }
    foreach ($binding in @($publication.autostart)) {
        Assert-YoutabAutostartBinding $binding $journal
        if ($binding.kind -eq 'startup') {
            Assert-YoutabLinkStage $binding.path $binding.previous $journal.target
            Assert-YoutabLinkStage $binding.path $binding.desired $journal.target
        }
        $current = Read-YoutabAutostartBinding $binding
        if ($current -cne $binding.previous -and $current -cne $binding.desired) {
            throw 'Autostart changed outside this relocation; journal retained'
        }
    }
    foreach ($variable in $publication.variables) {
        $next = if ($Action -eq 'apply') { $variable.desired } else { $variable.previous }
        if ((Read-YoutabUserValue $variable.name) -cne $next) {
            Write-YoutabUserValue $variable.name $next
        }
    }
    $publication.phase = if ($Action -eq 'apply') { 'environment-applied' } else { 'prepared' }
    Write-YoutabRelocationJournal $JournalPath $journal
    foreach ($binding in @($publication.autostart)) {
        $next = if ($Action -eq 'apply') { $binding.desired } else { $binding.previous }
        if ((Read-YoutabAutostartBinding $binding) -cne $next) {
            Write-YoutabAutostartBinding $binding $next $journal
        }
        if ($binding.kind -eq 'startup') { Remove-YoutabLinkStages $binding.path $binding.previous $binding.desired $journal.target }
    }
    $publication.phase = if ($Action -eq 'apply') { 'autostart-applied' } else { 'prepared' }
    Write-YoutabRelocationJournal $JournalPath $journal
    foreach ($link in $publication.links) {
        $next = if ($Action -eq 'apply') { $link.desired } else { $link.previous }
        if ((Read-YoutabLinkBytes $link.path) -cne $next) {
            Write-YoutabLinkBytes $link.path $next $journal.target $link.previous $link.desired
        }
        Remove-YoutabLinkStages $link.path $link.previous $link.desired $journal.target
    }
    $publication.phase = if ($Action -eq 'apply') { 'published' } else { 'rolled-back' }
    Write-YoutabRelocationJournal $JournalPath $journal
}


# Reuse gateway_windows.py's exact wrapper and Startup formats from NEW code.
# Task XML remains the existing task's XML with only its owned action retargeted;
# trigger, enabled state, principal, and restart policy are preserved.
function Read-YoutabTaskXml([string]$Name) {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    try { return $service.GetFolder('\').GetTask($Name).Xml } catch {
        if ($_.Exception.HResult -eq -2147024894) { return $null }
        throw
    }
}
function Write-YoutabTaskXml([string]$Name, [string]$Xml) {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $task = $service.GetFolder('\').GetTask($Name)
    # UPDATE only: never create a previously absent service or start a task.
    $null = $service.GetFolder('\').RegisterTask($Name, $Xml, 4,
        $task.Definition.Principal.UserId, $null, 3, $null)
}
function Read-YoutabAutostartBinding($Binding) {
    if ($Binding.kind -eq 'task') { return Read-YoutabTaskXml $Binding.name }
    return Read-YoutabLinkBytes $Binding.path
}
function Write-YoutabAutostartBinding($Binding, [AllowNull()]$Value, $Journal) {
    if ($Binding.kind -eq 'task') { Write-YoutabTaskXml $Binding.name $Value }
    else { Write-YoutabLinkBytes $Binding.path $Value $Journal.target $Binding.previous $Binding.desired }
}
function ConvertTo-YoutabTaskDocument([string]$Text) {
    if (-not $Text -or $Text.Length -gt 1048576) { throw 'Invalid task XML size' }
    $settings = New-Object Xml.XmlReaderSettings
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create((New-Object IO.StringReader $Text), $settings)
    try {
        $doc = New-Object Xml.XmlDocument
        $doc.XmlResolver = $null
        $doc.Load($reader)
        return ,$doc
    } finally { $reader.Dispose() }
}
function Assert-YoutabOwnedGatewayTask($Doc, [string]$Launcher) {
    $ns = New-Object Xml.XmlNamespaceManager $Doc.NameTable
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $description = $Doc.SelectSingleNode('/t:Task/t:RegistrationInfo/t:Description', $ns)
    $principals = @($Doc.SelectNodes('/t:Task/t:Principals/t:Principal', $ns))
    $actions = @($Doc.SelectNodes('/t:Task/t:Actions/*', $ns))
    if ($null -eq $description -or $description.InnerText -cne 'Youtab Agent Runtime Gateway - Messaging Platform Integration' -or
        $principals.Count -ne 1 -or $actions.Count -ne 1 -or $actions[0].LocalName -ne 'Exec') {
        throw 'Unrelated gateway task collision'
    }
    $principal = $principals[0]
    $user = $principal.SelectSingleNode('t:UserId', $ns)
    if ($null -eq $user) { throw 'Gateway task has no owner identity' }
    $sid = New-Object Security.Principal.NTAccount $user.InnerText
    if ($user.InnerText.StartsWith('S-1-')) { $owner = $user.InnerText }
    else { $owner = $sid.Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($owner -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
        $principal.SelectSingleNode('t:LogonType', $ns).InnerText -cne 'InteractiveToken' -or
        $principal.SelectSingleNode('t:RunLevel', $ns).InnerText -cne 'LeastPrivilege') {
        throw 'Gateway task principal is outside current-user ownership'
    }
    $command = $actions[0].SelectSingleNode('t:Command', $ns)
    $arguments = $actions[0].SelectSingleNode('t:Arguments', $ns)
    if ($null -eq $command -or $null -eq $arguments -or
        $command.InnerText -ine 'wscript.exe' -or $arguments.InnerText -cne "//B //Nologo `"$Launcher`"") {
        throw 'Gateway task action is outside the known owned launcher'
    }
    return ,$arguments
}
function Assert-YoutabAutostartBinding($Binding, $Journal) {
    if ($Binding.name -cnotmatch '^Youtab_Gateway(?:_[a-z0-9][a-z0-9_-]{0,63})?$' -or
        @('task', 'startup') -notcontains $Binding.kind) { throw 'Unknown autostart identity' }
    if ($Binding.kind -eq 'startup') {
        $expected = Join-Path ([Environment]::GetFolderPath('Startup')) "$($Binding.name).vbs"
        if ([IO.Path]::GetFullPath($Binding.path) -ine [IO.Path]::GetFullPath($expected)) {
            throw 'Startup binding is outside the known current-user folder'
        }
    }
    if ($null -eq $Binding.launchers -or @($Binding.launchers).Count -ne 2) { throw 'Gateway launcher evidence absent' }
    $profile = if ($Binding.profile) { "profiles\$($Binding.profile)\" } else { '' }
    if ($Binding.profile -and $Binding.profile -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {
        throw 'Invalid autostart profile'
    }
    foreach ($launcher in $Binding.launchers) {
        $expectedParent = "$(Get-YoutabPublicationPath $Journal.target)\${profile}gateway-service"
        if ([IO.Path]::GetDirectoryName($launcher.path) -ine $expectedParent -or
            [IO.Path]::GetFileName($launcher.path) -notin @("$($Binding.name).cmd", "$($Binding.name).vbs") -or
            (Read-YoutabLinkBytes $launcher.path) -cne $launcher.bytes) { throw 'Fresh gateway launcher changed before publication' }
    }
    if ($Binding.kind -eq 'task') {
        $old = "$(Get-YoutabPublicationPath $Journal.source)\${profile}gateway-service\$($Binding.name).vbs"
        $new = "$(Get-YoutabPublicationPath $Journal.target)\${profile}gateway-service\$($Binding.name).vbs"
        $null = Assert-YoutabOwnedGatewayTask (ConvertTo-YoutabTaskDocument $Binding.previous) $old
        $null = Assert-YoutabOwnedGatewayTask (ConvertTo-YoutabTaskDocument $Binding.desired) $new
    }
}
function New-YoutabAutostartRelocation($Journal) {
    $targetRoot = Get-YoutabPublicationPath $Journal.target
    $sourceRoot = Get-YoutabPublicationPath $Journal.source
    $runtime = Join-Path $targetRoot 'youtab-agent-runtime'
    $python = Join-Path $runtime 'venv\Scripts\python.exe'
    $homes = @(@{ source = $sourceRoot; target = $targetRoot; profile = '' })
    $profiles = Join-Path $sourceRoot 'profiles'
    if ([IO.Directory]::Exists($profiles)) {
        foreach ($dir in @(Get-ChildItem -LiteralPath $profiles -Directory)) {
            if ($dir.Name -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$' -or
                $dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid source profile' }
            $homes += @{ source = $dir.FullName; target = (Join-Path $targetRoot "profiles\$($dir.Name)"); profile = $dir.Name }
        }
    }
    $bindings = @()
    foreach ($home in $homes) {
        $serviceDir = Join-Path $home.source 'gateway-service'
        if (-not [IO.Directory]::Exists($serviceDir)) { continue }
        if ([IO.File]::GetAttributes($serviceDir) -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked source gateway service refused' }
        foreach ($wrapper in @(Get-ChildItem -LiteralPath $serviceDir -Filter 'Youtab_Gateway*.vbs' -File)) {
            $name = $wrapper.BaseName
            if ($name -cnotmatch '^Youtab_Gateway(?:_[a-z0-9][a-z0-9_-]{0,63})?$') { throw 'Unknown gateway launcher identity' }
            if ($bindings.Count -ge 128) { throw 'Autostart binding limit reached; none are dropped' }
            $startup = Join-Path ([Environment]::GetFolderPath('Startup')) "$name.vbs"
            $legacy = [IO.Path]::ChangeExtension($startup, '.cmd')
            if ([IO.File]::Exists($legacy)) { throw 'Legacy Startup format retained for explicit review' }
            $previousStartup = Read-YoutabLinkBytes $startup
            $previousTask = Read-YoutabTaskXml $name
            if ($null -eq $previousStartup -and $null -eq $previousTask) { continue }
            $profileToken = if ($home.profile) { $home.profile } else { '-' }
            $rendered = & $python -I (Join-Path $runtime 'scripts\private-home-launchers.py') $runtime $home.source $home.target $name $profileToken
            if ($LASTEXITCODE -ne 0) { throw 'Fresh gateway launcher rendering failed' }
            $rendered = ($rendered -join "`n") | ConvertFrom-Json
            if ($null -ne $previousStartup -and $previousStartup -cne $rendered.previousStartup) {
                throw 'Unrelated or modified Startup collision'
            }
            $dest = Join-Path $home.target 'gateway-service'
            [IO.Directory]::CreateDirectory($dest) | Out-Null
            foreach ($extension in @('cmd', 'vbs')) {
                $path = Join-Path $dest "$name.$extension"
                $desired = $rendered.$extension
                $current = Read-YoutabLinkBytes $path
                if ($null -ne $current -and $current -cne $desired) { throw 'Target gateway launcher collision' }
                if ($null -eq $current) { Write-YoutabLinkBytes $path $desired $targetRoot }
            }
            $launchers = @(@{ path = (Join-Path $dest "$name.cmd"); bytes = $rendered.cmd },
                @{ path = (Join-Path $dest "$name.vbs"); bytes = $rendered.vbs })
            if ($null -ne $previousStartup) {
                $bindings += @{ kind = 'startup'; name = $name; profile = $home.profile; path = $startup; launchers = $launchers;
                    previous = $previousStartup; desired = $rendered.desiredStartup }
            }
            if ($null -ne $previousTask) {
                $doc = ConvertTo-YoutabTaskDocument $previousTask
                $arguments = Assert-YoutabOwnedGatewayTask $doc $wrapper.FullName
                $arguments.InnerText = "//B //Nologo `"$(Join-Path $dest "$name.vbs")`""
                $bindings += @{ kind = 'task'; name = $name; profile = $home.profile; launchers = $launchers;
                    previous = $previousTask; desired = $doc.OuterXml }
            }
        }
    }
    return $bindings
}
