param([Parameter(Mandatory=$true)][string]$Fixture,
    [Parameter(Mandatory=$true)][string]$Source,
    [ValidateSet('seams','poison')][string]$Mode='seams', [string]$PrivateHome='')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($Fixture)
# Rust's admitted native fixture is canonical verbatim syntax; normalize only
# this spelling before the unchanged owned local UUID qualification.
if($root.StartsWith('\\?\',[StringComparison]::Ordinal)){ $root=$root.Substring(4) }
if (-not $env:YOUTAB_NATIVE_PRIVATE_QA_ROOT) { throw 'Explicit native private QA root required' }
$admitted=[IO.Path]::GetFullPath($env:YOUTAB_NATIVE_PRIVATE_QA_ROOT)
if($admitted.StartsWith('\\?\',[StringComparison]::Ordinal)){ $admitted=$admitted.Substring(4) }
if ($root -ine $admitted) { throw 'Fixture must equal the explicitly admitted native QA root' }
$qualified=[IO.Path]::GetDirectoryName($admitted)+'\'
if ([IO.Path]::GetDirectoryName($root)+'\' -ine $qualified -or
    [IO.Path]::GetFileName($root) -cnotmatch '^[a-f0-9]{8}-[a-f0-9-]{27}$') { throw 'Owned UUID fixture required' }
foreach ($part in @($root,$qualified.TrimEnd('\'))) {
    if ([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture link refused' }
}
. (Join-Path $Source 'scripts\private-home-publication.ps1')
function Assert-Equal($Actual,$Expected,[string]$Message) { if ($Actual -cne $Expected) { throw $Message } }
$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Source 'scripts\install.ps1'),[ref]$null,[ref]$parseErrors)
if (@($parseErrors).Count) { throw 'Frozen installer did not parse' }
$functionNames=if($Mode -eq 'poison'){@('Test-GitBashCompatibility')}else{@('Get-PrivateHomePrerequisites','Install-Git','Stage-Git','Read-YoutabInstallPath','Sync-EnvPath','Invoke-Stage')}
foreach ($name in $functionNames) {
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    if ($null -eq $definition) { throw 'Installer seam function absent' }
    Invoke-Expression $definition.Extent.Text
}
$PrivateHomeRelocation=$true
$script:CustomerReleaseMode=$true
function Read-YoutabUserValue([string]$Name) {
    if ($Name -cne 'YOUTAB_AGENT_GIT_BASH_PATH') { throw 'Unexpected User environment read' }
    return $script:binding
}
function Write-YoutabUserValue([string]$Name,$Value) { throw 'Managed Git test attempted User environment write' }
function Write-Info($Message) { }
function Write-Success($Message) { }
function Write-Warn($Message) { }
function Write-Err($Message) { }
if ($Mode -eq 'poison') {
    $expected=Join-Path $root 'fresh-private-home'
    if ([IO.Path]::GetFullPath($PrivateHome) -ine $expected) { throw 'Fresh Git poison proof requires exact owned private fixture' }
    $YoutabHome=$PrivateHome
    $InstallDir=Join-Path $PrivateHome 'youtab-agent-runtime'
    $lockPath=Join-Path $InstallDir 'config\windows-private-home-prerequisites.json'
    if ((Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash -cne
        (Get-FileHash -LiteralPath (Join-Path $Source 'config\windows-private-home-prerequisites.json') -Algorithm SHA256).Hash) { throw 'Fresh runtime prerequisite lock differs from frozen source' }
    $lock=[IO.File]::ReadAllText($lockPath) | ConvertFrom-Json
    $archive=Join-Path $PrivateHome "bootstrap-cache\private-prerequisites\PortableGit-$($lock.git.version)-64-bit.7z.exe"
    if (-not [IO.File]::Exists($archive) -or ([IO.FileInfo]$archive).Length -ne $lock.git.size -or
        (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.git.sha256) { throw 'Verified fresh PortableGit archive witness absent' }
    $bash=Assert-YoutabFreshManagedGit $PrivateHome
    # Caller is the ignored Rust proof that holds the existing private-code
    # namespace and full fresh Git executable tree across this actual launch.
    $probe=Join-Path $root ('managed-git-poison-'+[Guid]::NewGuid().ToString())
    [IO.Directory]::CreateDirectory($probe) | Out-Null
    $canary=Join-Path $probe 'source-code-executed'
    $unix=$canary.Replace('\','/') -replace '^([A-Za-z]):','/$1'
    $scriptPath=Join-Path $probe 'malicious-bash-env.sh'
    [IO.File]::WriteAllText($scriptPath,"printf poisoned > '$unix'`n",(New-Object Text.UTF8Encoding $false))
    $names=@('BASH_ENV','ENV','SHELLOPTS','BASHOPTS','BASH_FUNC_youtab_poison%%')
    $saved=@{}
    foreach ($name in $names) { $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
    try {
        $env:BASH_ENV=$scriptPath; $env:ENV=$scriptPath
        $env:SHELLOPTS='xtrace'; $env:BASHOPTS='extglob'
        [Environment]::SetEnvironmentVariable('BASH_FUNC_youtab_poison%%',"() { printf poisoned > '$unix'; }",'Process')
        if (-not (Test-GitBashCompatibility -BashPath $bash)) { throw 'Actual fresh Git Bash probe failed' }
        if ([IO.File]::Exists($canary)) { throw 'Fresh Git Bash executed inherited synthetic source code' }
        $null=Assert-YoutabFreshManagedGit $PrivateHome
    } finally { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') } }
    Write-Output 'Actual locked fresh Git compatibility process ignored malicious BASH_ENV/ENV/exported function inputs; no source canary effect'
    $global:LASTEXITCODE=0
    return
}
$parent=Join-Path $root ('managed-git-seams-'+[Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($parent) | Out-Null
$old=Join-Path $parent 'old-home'; $new=Join-Path $parent 'new-home'
$oldBash=Join-Path $old 'git\bin\bash.exe'
$newBash=Join-Path $new 'git\bin\bash.exe'
Assert-Equal (Get-YoutabManagedGitBashTarget $oldBash $old $new) $newBash 'Managed binding did not retarget'
Assert-Equal (Get-YoutabManagedGitBashTarget ('\\?\'+$oldBash.ToUpperInvariant()) $old $new) $newBash 'Managed canonical/case alias did not retarget'
foreach ($custom in @('C:\synthetic-custom\bash.exe','custom-invalid-choice')) {
    Assert-Equal (Get-YoutabManagedGitBashTarget $custom $old $new) $null 'Unrelated custom choice was changed'
}
$YoutabHome=$new; $InstallDir=Join-Path $new 'youtab-agent-runtime'
[IO.Directory]::CreateDirectory((Join-Path $InstallDir 'config')) | Out-Null
[IO.File]::Copy((Join-Path $Source 'config\windows-private-home-prerequisites.json'),(Join-Path $InstallDir 'config\windows-private-home-prerequisites.json'))
$lock=Get-PrivateHomePrerequisites
$fileMap=@{}
foreach ($relative in @('bin\bash.exe','cmd\git.exe','usr\bin\msys-2.0.dll')) {
    $path=Join-Path (Join-Path $new 'git') $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
    [IO.File]::WriteAllText($path,'SYNTHETIC DATA - NEVER EXECUTE',(New-Object Text.UTF8Encoding $false))
    $fileMap[$relative]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$cache=Join-Path $new 'bootstrap-cache\private-prerequisites'; [IO.Directory]::CreateDirectory($cache) | Out-Null
$receipt=@{version=$lock.git.version;archiveSha256=$lock.git.sha256;archiveSize=$lock.git.size;bashProbePassed=$true;files=$fileMap}
[IO.File]::WriteAllText((Join-Path $cache 'git-receipt.json'),($receipt | ConvertTo-Json -Depth 100),(New-Object Text.UTF8Encoding $false))
Assert-Equal (Assert-YoutabFreshManagedGit $new) $newBash 'Synthetic fresh binding receipt did not validate'
$script:probeCalls=0
function Test-GitBashCompatibility([string]$BashPath) {
    Assert-Equal $BashPath $newBash 'Probe attempted OLD/system executable'
    $script:probeCalls++; return $true
}
function Get-WindowsArch { return 'x64' }
function Set-GitBashEnvVar { throw 'Private Git attempted ordinary User environment mutation' }
Assert-Equal (Install-Git) $true 'Fresh receipt resume failed'
Assert-Equal $script:probeCalls 1 'Fresh probe was not exercised'
[IO.File]::WriteAllText($newBash,'CHANGED SYNTHETIC DATA',(New-Object Text.UTF8Encoding $false))
try { $null=Assert-YoutabFreshManagedGit $new; throw 'Changed fresh Git accepted' }
catch { if ($_.Exception.Message -cnotlike 'Fresh Git bytes differ*') { throw } }
$bad=Join-Path $parent 'bad-archive'; $YoutabHome=$bad; $InstallDir=Join-Path $bad 'youtab-agent-runtime'
[IO.Directory]::CreateDirectory((Join-Path $InstallDir 'config')) | Out-Null
[IO.File]::Copy((Join-Path $Source 'config\windows-private-home-prerequisites.json'),(Join-Path $InstallDir 'config\windows-private-home-prerequisites.json'))
$badCache=Join-Path $bad 'bootstrap-cache\private-prerequisites'; [IO.Directory]::CreateDirectory($badCache) | Out-Null
[IO.File]::WriteAllText((Join-Path $badCache "PortableGit-$($lock.git.version)-64-bit.7z.exe"),'UNVERIFIED SYNTHETIC ARCHIVE',(New-Object Text.UTF8Encoding $false))
$script:networkCalls=0; $script:extractorCalls=0
function Invoke-WebRequest { $script:networkCalls++; throw 'Synthetic seam attempted network acquisition' }
function Start-Process { $script:extractorCalls++; throw 'Synthetic seam attempted extractor execution' }
Assert-Equal (Install-Git) $false 'Invalid archive was accepted'
Assert-Equal $script:networkCalls 0 'Existing invalid archive caused a network acquisition'
Assert-Equal $script:extractorCalls 0 'Unverified archive was executed'
Assert-Equal $script:probeCalls 1 'Invalid archive reached Bash execution'
# Exercise the actual Stage-Git decision while its acquisition seam is mocked.
$YoutabHome=Join-Path $parent 'stage-home'; [IO.Directory]::CreateDirectory($YoutabHome) | Out-Null
$RelocationJournal=Join-Path $parent 'stage-journal.json'
[IO.File]::WriteAllText($RelocationJournal,(@{schema=1;source=$old;target=$YoutabHome} | ConvertTo-Json),(New-Object Text.UTF8Encoding $false))
$script:installCalls=0
$script:sourceCallback=Join-Path (Join-Path $old 'bin') 'youtab-old-source-poison.cmd'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($script:sourceCallback)) | Out-Null
$script:canary=Join-Path $parent 'old-source-callback-executed'
[IO.File]::WriteAllText($script:sourceCallback,"@echo off`r`necho poisoned > `"$script:canary`"`r`n",(New-Object Text.UTF8Encoding $false))
$script:userPath="$old;$old\bin;$old\git\cmd;C:\synthetic-custom-tools"
function Read-YoutabInstallPath([string]$Scope) {
    if ($Scope -eq 'User') { return $script:userPath }
    return "$env:SystemRoot\System32"
}
$env:YOUTAB_AGENT_RELOCATION_SOURCE=$old
[IO.Directory]::CreateDirectory((Join-Path $YoutabHome 'bin')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $YoutabHome 'node')) | Out-Null
function Install-Git {
    foreach ($entry in $env:Path -split ';') {
        if ($entry -ieq $old -or $entry.StartsWith($old+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invoke-Stage resurrected OLD search paths' }
    }
    $callback=Get-Command 'youtab-old-source-poison.cmd' -ErrorAction SilentlyContinue
    if ($callback) { & $callback.Source; throw 'OLD source callback was executed' }
    $parts=$env:Path -split ';'
    if ($parts[0] -ine (Join-Path $YoutabHome 'bin') -or $parts -notcontains (Join-Path $YoutabHome 'node') -or
        $parts -notcontains 'C:\synthetic-custom-tools') { throw 'Fresh/custom stage paths were not preserved' }
    $script:installCalls++; return $true
}
$script:binding=$oldBash
$Json=$true
$frame=Invoke-Stage -StageDef @{Name='git';Worker='Stage-Git'} | ConvertFrom-Json
Assert-Equal $frame.ok $true 'Actual Invoke-Stage/Sync-EnvPath chain failed'
Assert-Equal $frame.skipped $false 'Actual customer managed binding was skipped'
if ([IO.File]::Exists($script:canary)) { throw 'Source callback canary was touched' }
Assert-Equal $script:installCalls 1 'Customer relocation skipped managed Git provisioning'
foreach ($custom in @($null,'C:\synthetic-custom\bash.exe')) {
    $script:binding=$custom; $script:_StageSkippedReason=$null
    $frame=Invoke-Stage -StageDef @{Name='git';Worker='Stage-Git'} | ConvertFrom-Json
    Assert-Equal $frame.ok $true 'Custom-choice actual stage chain failed'
    Assert-Equal $frame.skipped $true 'Custom choice was not skipped'
    Assert-Equal $script:installCalls 1 'Unrelated custom choice triggered managed provisioning'
    Assert-Equal $script:_StageSkippedReason 'No source-owned Git Bash binding to retarget' 'Wrong managed Git skip reason'
}
Write-Output 'Managed Git retarget/custom-choice, receipt/inventory tamper, invalid archive-before-execution, fresh-only resume and actual Invoke-Stage/Sync-EnvPath/customer Git chain cases passed; no acquisition or real Git execution'
$global:LASTEXITCODE=0
