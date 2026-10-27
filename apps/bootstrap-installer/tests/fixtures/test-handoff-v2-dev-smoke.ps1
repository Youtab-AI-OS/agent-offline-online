param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$QaHome
)

$ErrorActionPreference = 'Stop'
$setupItem = Get-Item -LiteralPath $Setup -ErrorAction Stop
$homeItem = Get-Item -LiteralPath $QaHome -ErrorAction Stop
$profilePath = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
$homePath = [IO.Path]::GetFullPath($homeItem.FullName).TrimEnd('\')
$qaName = [IO.Path]::GetFileName($homePath)
if ($setupItem.PSIsContainer -or $homeItem.PSIsContainer -eq $false -or
    $qaName -notmatch '^Youtab-Handoff-V2-QA-[0-9a-f]{8}$' -or
    $homePath -ne (Join-Path $profilePath $qaName) -or
    @(Get-ChildItem -LiteralPath $homePath -Force).Count -ne 0 -or
    (Test-Path -LiteralPath (Join-Path $homePath 'youtab-agent-runtime')) -or
    (Test-Path -LiteralPath (Join-Path $homePath 'youtab-setup.exe'))) {
    throw 'QA fixture identity changed or contains a product installation'
}
$actualSha = (Get-FileHash -LiteralPath $setupItem.FullName -Algorithm SHA256).Hash
if ($actualSha -ne $ExpectedSha256.ToUpperInvariant()) { throw 'QA Setup hash changed' }
if ($setupItem.Length -le 0 -or $setupItem.Length -gt 256MB) { throw 'QA Setup size invalid' }
if ($env:YOUTAB_AGENT_SETUP_DEV_REPO_ROOT -or $env:YOUTAB_AGENT_RELEASE_BASE_URL) {
    throw 'QA process has a development repo or release base override'
}

$capability = & $setupItem.FullName --setup-handoff-v2 capability
if ($LASTEXITCODE -ne 0 -or ($capability -join "`n") -notmatch '"version":2') {
    throw 'v2 capability probe failed'
}

$stageId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
$cacheExe = Join-Path $homePath ("update-cache\setup-v2-$stageId.exe")
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $setupItem.FullName
$psi.Arguments = "--setup-handoff-v2 --home $homePath --sha256 $($actualSha.ToLowerInvariant()) --size $($setupItem.Length) --channel pilot --source-sha $('a' * 40) --request-id $stageId"
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$broker = [Diagnostics.Process]::Start($psi)
if (-not $broker) { throw 'Could not start QA broker' }
try {
    $source = [IO.File]::Open($setupItem.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $source.CopyTo($broker.StandardInput.BaseStream) }
    finally { $source.Dispose(); $broker.StandardInput.Close() }

    # Read exactly one bounded broker response with a timeout.
    $responseTask = $broker.StandardOutput.ReadLineAsync()
    if (-not $responseTask.Wait(30000)) { throw 'QA broker response timed out' }
    $line = $responseTask.Result
    if (-not $line -or $line.Length -gt 4096) { throw 'QA broker response invalid' }
    $reply = $line | ConvertFrom-Json
    if ($reply.protocol -ne 'youtab.setup-handoff' -or $reply.version -ne 2 -or
        $reply.status -ne 'started' -or $reply.reason -ne 'lease-held' -or
        $reply.stageId -ne $stageId -or -not $reply.createdAt) {
        throw "QA broker did not confirm child lease: $line"
    }
    if (-not $broker.WaitForExit(10000) -or $broker.ExitCode -ne 0) {
        throw 'QA broker did not exit successfully'
    }

    # The unpinned debug child can briefly show an Update window. Empty QA
    # home has no CLI, so run_update fails before any actual install. Stop only
    # the exact process whose image and FILETIME match this stage's ACK.
    $child = Get-Process -Id ([int]$reply.pid) -ErrorAction SilentlyContinue
    if ($child) {
        $image = [IO.Path]::GetFullPath($child.Path)
        $started = $child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        if (-not [string]::Equals($image, $cacheExe, [StringComparison]::OrdinalIgnoreCase) -or
            $started -ne [string]$reply.createdAt) {
            throw 'QA child identity mismatch; child was not stopped'
        }
        Stop-Process -Id $child.Id -Force -ErrorAction Stop
        $child.WaitForExit(10000) | Out-Null
    }

    $reap = & $setupItem.FullName --setup-handoff-v2 --reap --home $homePath
    if ($LASTEXITCODE -ne 0 -or ($reap -join "`n") -notmatch '"status":"clear","reason":"reaped"') {
        throw 'QA cache reap failed'
    }
    if ((Test-Path -LiteralPath $cacheExe) -or
        (Test-Path -LiteralPath (Join-Path $homePath ("update-cache\setup-v2-$stageId.json"))) -or
        (Test-Path -LiteralPath (Join-Path $homePath 'youtab-agent-runtime'))) {
        throw 'QA cache or installation state unexpected after reap'
    }
    "BROKER_ACK=PASS; REAP=PASS; SETUP_SHA256=$actualSha; QA_HOME=$homePath; PRODUCT_INSTALL=NO"
} finally {
    if (-not $broker.HasExited) { $broker.Kill(); $broker.WaitForExit(10000) | Out-Null }
    $broker.Dispose()
}
