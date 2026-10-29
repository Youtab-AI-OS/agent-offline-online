# Behavior tests for customer discovery publication. Registry access is mocked;
# no operator environment, credentials, or installed files are changed.
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'scripts\install.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "install.ps1 has parser errors: $($parseErrors.Count)" }
foreach ($name in @('Set-PathVariable', 'Register-ValidatedCustomerHome')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $definition) { throw "Function $name is absent" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Assert-True([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function Write-Success { param([string]$message) }
$script:values = @{}
$script:writes = 0
$script:failPathWrite = $false
function Read-YoutabUserEnvironment { param([string]$Name) return $script:values[$Name] }
function Write-YoutabUserEnvironment {
    param([string]$Name, [AllowNull()][object]$Value)
    if ($Name -eq 'Path' -and $script:failPathWrite) { throw 'synthetic registry failure' }
    $script:writes++
    if ($null -eq $Value) { $script:values.Remove($Name) | Out-Null } else { $script:values[$Name] = $Value }
}

$script:CustomerReleaseMode = $true
$PrivateHomeRelocation = $false
$script:_StageSkippedReason = $null
Set-PathVariable
Assert-True ($script:writes -eq 0 -and $script:_StageSkippedReason) 'Early customer path stage changed discovery state'

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('youtab-home-registration-' + [guid]::NewGuid().ToString('N'))
try {
    $YoutabHome = Join-Path $fixture 'home'
    $InstallDir = Join-Path $YoutabHome 'youtab-agent-runtime'
    $bin = Join-Path $InstallDir 'venv\Scripts'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    New-Item -ItemType File -Path (Join-Path $bin 'youtab.exe') | Out-Null
    New-Item -ItemType File -Path (Join-Path $YoutabHome 'youtab-setup.exe') | Out-Null
    $nodeDir = Join-Path $YoutabHome 'node'
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    New-Item -ItemType File -Path (Join-Path $nodeDir 'node.exe') | Out-Null
    $NoVenv = $false

    $rejected = $false
    try { Register-ValidatedCustomerHome } catch { $rejected = $true }
    Assert-True ($rejected -and $script:writes -eq 0) 'Missing product marker published home'

    New-Item -ItemType File -Path (Join-Path $InstallDir '.youtab-agent-runtime-bootstrap-complete') | Out-Null
    $script:values['YOUTAB_AGENT_HOME'] = (Join-Path $fixture 'existing')
    $rejected = $false
    try { Register-ValidatedCustomerHome } catch { $rejected = $true }
    Assert-True ($rejected -and $script:writes -eq 0) 'Different existing user home was overwritten'

    $script:values.Remove('YOUTAB_AGENT_HOME') | Out-Null
    $script:values['Path'] = 'C:\Windows\System32'
    Register-ValidatedCustomerHome
    Assert-True ($script:values['YOUTAB_AGENT_HOME'] -ieq $YoutabHome) 'Validated home was not registered'
    Assert-True ($script:values['Path'].StartsWith($bin + ';')) 'CLI path was not registered'
    Assert-True (@($script:values['Path'] -split ';' | Where-Object { $_ -ieq $nodeDir }).Count -eq 1) 'Managed Node path was not published exactly once after validation'
    $writes = $script:writes
    Register-ValidatedCustomerHome
    Assert-True ($script:writes -eq $writes) 'Repeated registration was not idempotent'

    $script:values.Remove('YOUTAB_AGENT_HOME') | Out-Null
    $script:values['Path'] = 'C:\Windows\System32'
    $script:failPathWrite = $true
    $rejected = $false
    try { Register-ValidatedCustomerHome } catch { $rejected = $true }
    Assert-True ($rejected -and -not $script:values.ContainsKey('YOUTAB_AGENT_HOME') -and
        $script:values['Path'] -ceq 'C:\Windows\System32') 'Failed publication did not restore prior discovery state'
    Write-Output 'HOME_REGISTRATION_TEST=PASS; USER_REGISTRY_CHANGED=NO'
} finally {
    $verifiedFixture = [IO.Path]::GetFullPath($fixture).TrimEnd('\')
    $verifiedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($verifiedFixture.StartsWith($verifiedTemp, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($verifiedFixture) -match '^youtab-home-registration-[a-f0-9]{32}$' -and
        (Test-Path -LiteralPath $verifiedFixture)) {
        Remove-Item -LiteralPath $verifiedFixture -Recurse -Force
    }
}
