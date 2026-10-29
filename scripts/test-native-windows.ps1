param(
    [Parameter(Mandatory=$true)][string]$Python,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$PythonSha256,
    [Parameter(Mandatory=$true)][string]$PrivateQaRoot,
    [Parameter(Mandatory=$true)][string]$CargoTargetDir,
    [Parameter(Mandatory=$true)][string]$CargoHome,
    [Parameter(Mandatory=$true)][string]$RustupHome
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:OS -cne 'Windows_NT') { throw 'Native Windows test wrapper requires Windows' }
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pythonPath=[IO.Path]::GetFullPath($Python)
$qaParent=[IO.Path]::GetFullPath($PrivateQaRoot)
$targetPath=[IO.Path]::GetFullPath($CargoTargetDir)
# Capture admitted actual developer roots before changing any home variable.
$cargoHomePath=[IO.Path]::GetFullPath($CargoHome)
$rustupHomePath=[IO.Path]::GetFullPath($RustupHome)
function Assert-NoReparseChain([string]$Path) {
    $current=$Path
    while ($current) {
        if (-not (Test-Path -LiteralPath $current)) { throw 'Every input ancestor must already exist' }
        if ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) { throw 'Native QA reparse ancestor refused' }
        $next=[IO.Path]::GetDirectoryName($current)
        if ($next -eq $current) { break }
        $current=$next
    }
}
foreach ($path in @($sourceRoot,$pythonPath,$qaParent,$targetPath,$cargoHomePath,$rustupHomePath)) { Assert-NoReparseChain $path }
if (-not [IO.File]::Exists($pythonPath) -or (Get-FileHash -LiteralPath $pythonPath -Algorithm SHA256).Hash -ine $PythonSha256) { throw 'Explicit qualified Python bytes differ' }
if (-not [IO.Directory]::Exists($qaParent) -or -not [IO.Directory]::Exists($targetPath)) { throw 'Explicit external QA parent/target directories required' }
foreach ($external in @($qaParent,$targetPath)) {
    if ($external -ieq $sourceRoot -or $external.StartsWith($sourceRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test state/build cache must be outside Source' }
}
foreach ($developmentRoot in @($cargoHomePath,$rustupHomePath)) { if (-not [IO.Directory]::Exists($developmentRoot)) { throw 'Explicit existing Rust development roots required' } }
$probe='import json,sys,os,struct,sysconfig; print(json.dumps({"implementation":sys.implementation.name,"version":list(sys.version_info[:2]),"os":os.name,"bits":struct.calcsize("P")*8,"platform":sysconfig.get_platform()}))'
$metadata=$probe | & $pythonPath -I -S -B -
if ($LASTEXITCODE -ne 0) { throw 'Qualified interpreter stdlib probe failed' }
$facts=$metadata | ConvertFrom-Json
if ($facts.implementation -cne 'cpython' -or $facts.os -cne 'nt' -or $facts.bits -ne 64 -or $facts.platform -cne 'win-amd64' -or $facts.version[0] -ne 3 -or $facts.version[1] -notin @(11,12,13)) { throw 'Explicit supported Windows x64 CPython required' }
$fixture=Join-Path $qaParent ([Guid]::NewGuid().ToString())
if (Test-Path -LiteralPath $fixture) { throw 'Fresh native UUID fixture required' }
[IO.Directory]::CreateDirectory($fixture) | Out-Null
# Protect only this fresh owned directory; never change the supplied parent ACL.
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $fixture -AclObject $acl
Assert-NoReparseChain $fixture
$homePath=Join-Path $fixture 'synthetic-home'
foreach ($relative in @('synthetic-home','synthetic-home\.youtab-agent-runtime','synthetic-home\AppData','synthetic-home\AppData\Local','synthetic-home\AppData\Roaming','temp','ps-cache')) { [IO.Directory]::CreateDirectory((Join-Path $fixture $relative)) | Out-Null }
$bindings=@{
    'YOUTAB_NATIVE_PRIVATE_QA_ROOT'=$fixture
    'YOUTAB_RELOCATION_QA_SOURCE'=$sourceRoot
    'YOUTAB_RELOCATION_STAGE_CONTRACT_HELPER'=(Join-Path $sourceRoot 'apps\bootstrap-installer\tests\fixtures\test-installer-stage-contract.ps1')
    'YOUTAB_RELOCATION_GIT_POISON_HELPER'=(Join-Path $sourceRoot 'apps\bootstrap-installer\tests\fixtures\test-managed-git-relocation.ps1')
    'YOUTAB_RELOCATION_TEST_PYTHON'=$pythonPath
    'PSModuleAnalysisCachePath'=(Join-Path $fixture 'ps-cache\ModuleAnalysisCache')
    'HOME'=$homePath;'USERPROFILE'=$homePath
    'YOUTAB_AGENT_HOME'=(Join-Path $homePath '.youtab-agent-runtime')
    'LOCALAPPDATA'=(Join-Path $homePath 'AppData\Local');'APPDATA'=(Join-Path $homePath 'AppData\Roaming')
    'TEMP'=(Join-Path $fixture 'temp');'TMP'=(Join-Path $fixture 'temp')
    'CARGO_TARGET_DIR'=$targetPath
    'CARGO_HOME'=$cargoHomePath
    'RUSTUP_HOME'=$rustupHomePath
    'YOUTAB_AGENT_BUILD_PIN_BRANCH'='qa-unpublished-coordination'
    # An empty release-base variable is still "set" to build.rs. Remove the
    # variable entirely for this unpublished development test build.
    'YOUTAB_AGENT_BUILD_PIN_COMMIT'=$null
    'YOUTAB_AGENT_RELEASE_BASE_URL'=$null
    'PYTHONDONTWRITEBYTECODE'='1'
}
foreach ($helper in @($bindings.YOUTAB_RELOCATION_STAGE_CONTRACT_HELPER,$bindings.YOUTAB_RELOCATION_GIT_POISON_HELPER)) { Assert-NoReparseChain $helper }
$saved=@{}
foreach ($name in $bindings.Keys) { $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
$code=1
try {
    foreach ($name in $bindings.Keys) {
        if ($null -eq $bindings[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($name,$bindings[$name],'Process')
        }
    }
    Push-Location $sourceRoot
    try {
        & cargo test --manifest-path apps/bootstrap-installer/src-tauri/Cargo.toml --lib --offline --locked -j 1 -- --test-threads 1
        $code=$LASTEXITCODE
    } finally { Pop-Location }
} finally {
    foreach ($name in $bindings.Keys) {
        if ($null -eq $saved[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')
        }
    }
    # Evidence and failed fixture contents remain owned and inspectable.
    [IO.File]::WriteAllText((Join-Path $fixture 'HARNESS_RESULT.json'),(@{schema=1;scope='SYNTHETIC_NATIVE_WINDOWS_LIB_TESTS';exit=$code;python_sha256=$PythonSha256.ToLowerInvariant();fresh_provisioning_tests_executed=$false;fixture_preserved=$true} | ConvertTo-Json),(New-Object Text.UTF8Encoding $false))
}
Write-Output ('NATIVE_QA_FIXTURE='+$fixture)
if ($code -ne 0) { throw "Native Windows tests failed with exit $code" }
