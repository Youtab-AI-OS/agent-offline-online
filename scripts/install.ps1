# ============================================================================
# Youtab Agent Runtime Installer for Windows
# ============================================================================
# Installation script for Windows (PowerShell).
# Uses uv for fast Python provisioning and package management.
#
# Usage:
#   iex (irm https://youtab-agent-runtime.youtab.io/install.ps1)
#
# Or download and run with options:
#   .\install.ps1 -NoVenv -SkipSetup
#
# ============================================================================

param(
    [switch]$NoVenv,
    [switch]$SkipSetup,
    [string]$Branch = "main",
    # -Commit and -Tag are higher-precedence variants of -Branch for users
    # who need reproducible installs (desktop installer pinning, CI, release
    # bundles).  When set, the repository stage clones $Branch (faster than
    # cloning the full default-branch history) and then `git checkout`s the
    # exact ref.  Precedence: Commit > Tag > Branch.
    [string]$Commit = "",
    # Trusted release origin is supplied by Youtab-Setup, never inferred from
    # an ambient environment variable or from downloaded metadata.
    [string]$ReleaseBaseUrl = "",
    # Apply -Commit even when it would roll an existing install BACKWARDS.
    # Without this the repository stage skips a pin that is already an ancestor
    # of HEAD, so a stale baked-in BUILD_PIN_COMMIT can't downgrade a current
    # checkout. Reproducible/CI installs that genuinely want an older SHA on an
    # existing tree pass -ForceCommit.
    [switch]$ForceCommit,
    [string]$Tag = "",
    [string]$YoutabHome = $(if ($env:YOUTAB_AGENT_HOME) { $env:YOUTAB_AGENT_HOME } else { "$env:LOCALAPPDATA\youtab" }),
    [string]$InstallDir = $(if ($env:YOUTAB_AGENT_HOME) { "$env:YOUTAB_AGENT_HOME\youtab-agent-runtime" } else { "$env:LOCALAPPDATA\youtab\youtab-agent-runtime" }),

    # --- Stage protocol (additive; default invocation behaves as before) ----
    # See the "Stage protocol" section near the bottom of the file for the
    # full contract.  Intended for programmatic drivers (the desktop GUI's
    # onboarding wizard, CI, future install.sh parity, etc.).  CLI users
    # running the canonical `irm | iex` one-liner never touch these flags.
    [switch]$Manifest,
    [string]$Stage,
    [switch]$ProtocolVersion,
    [switch]$NonInteractive,
    [switch]$Json,

    # --- Ensure mode (dep_ensure.py entry point) ---
    [string]$Ensure = "",
    [switch]$PostInstall,

    # --- Desktop GUI build (opt-in) ---
    # When set, install.ps1 includes Stage-Desktop in the manifest and
    # builds apps/desktop into a launchable Youtab.exe.
    #
    # Why opt-in:
    #   * Youtab-Setup.exe (the Tauri bootstrap installer) passes
    #     -IncludeDesktop so a user who installed via the GUI ends up
    #     with a launchable desktop binary.
    #   * The Electron desktop's own bootstrap-runner.ts runs install.ps1
    #     from inside an already-launched Youtab.exe; if THAT recursively
    #     built apps/desktop it would try to overwrite the live Youtab.exe
    #     on disk and fail. The recursive path omits the flag.
    #   * The canonical CLI one-liner (irm | iex) omits the flag too;
    #     terminal users don't need a desktop binary built for them, and
    #     `youtab desktop` already builds on demand.
    [switch]$IncludeDesktop,
    # Only common Setup supplies these after verifying immutable artifact metadata
    # and the running/persisted Setup bytes. Node verifies them again before pack.
    [string]$CoordinationSetupSourceSha = "",
    [string]$CoordinationSetupSha256 = "",
    [long]$CoordinationSetupSize = 0,
    [switch]$PrivateHomeRelocation,
    [string]$RelocationJournal = "",
    [string]$RelocationDesktopExe = "",
    [ValidateSet("prepare", "apply", "rollback")][string]$PublicationAction = "prepare" 
)

$ErrorActionPreference = "Stop"

# Suppress Invoke-WebRequest's per-chunk progress bar.  Windows PowerShell
# 5.1's progress UI repaints synchroyoutably on every received byte, which
# pegs CPU on a single core and throttles downloads by 10-100x (a 57MB
# PortableGit grab can take 5 minutes with progress on vs 20 seconds
# with progress off, on the same network).  Every IWR call in this
# script is fire-and-forget so we never need to see the bar.  Restored
# automatically when the script exits.
$ProgressPreference = "SilentlyContinue"

# Force the console to UTF-8 so non-ASCII output from native commands
# (e.g. playwright's box-drawing progress bars and download banners,
# git's bullet glyphs, npm's check marks) renders correctly instead of
# as IBM437/Windows-1252 mojibake (sequences like 0xE2 0x95 0x94 box-
# drawing chars decoded under the legacy DOS codepage).  This is a
# DISPLAY-only fix; the underlying bytes are already correct.  We do
# NOT change the file's own encoding (it remains pure ASCII for PS 5.1
# parser compatibility; see comments at the top of the entry-point
# dispatch).  This affects only what the user sees in their terminal
# during this install run, and reverts automatically when the script
# exits and the host's console encoding is restored.
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
} catch {
    # Some constrained PowerShell hosts disallow encoding mutation.
    # Mojibake on output is then cosmetic-only, install still works.
}

# ============================================================================
# 8.3 short-path normalization
# ============================================================================
# When the Windows user-profile folder name contains a space (e.g.
# "First Last"), Windows generates an 8.3 short alias for it (e.g. FIRST~1.LAS)
# and may expose %TEMP%/%TMP% in that short form:
#   C:\Users\FIRST~1.LAS\AppData\Local\Temp
# PowerShell's FileSystem provider mishandles the "~1.ext" component when such a
# path is handed to a provider cmdlet like `Tee-Object -FilePath` /
# `Out-File -FilePath`, throwing:
#   "An object at the specified path C:\Users\FIRST~1.LAS does not exist."
# Every Node/Electron build+install stage streams its log to %TEMP% via
# Tee-Object, so they all abort with that error, while the Python/uv stages --
# which never write a side log to %TEMP% through a provider cmdlet -- complete
# fine. Expanding %TEMP%/%TMP% back to their long form once, up front, lets
# every downstream cmdlet (and child process) see a path the provider can
# resolve. (GH: Windows desktop installer fails at Node/Electron stages.)

function ConvertTo-LongPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
    # Only 8.3 short names carry a tilde+digit ("~1"); skip the COM round-trip
    # for ordinary long paths.
    if ($Path -notmatch '~\d') { return $Path }
    try {
        $fso = New-Object -ComObject Scripting.FileSystemObject
        if ($fso.FolderExists($Path)) { return $fso.GetFolder($Path).Path }
        if ($fso.FileExists($Path))   { return $fso.GetFile($Path).Path }
    } catch {
        # COM unavailable / locked-down host: fall back to the original path.
    }
    return $Path
}

foreach ($tmpVar in @('TEMP', 'TMP')) {
    $current = [Environment]::GetEnvironmentVariable($tmpVar)
    if ($current) {
        $expanded = ConvertTo-LongPath $current
        if ($expanded -and $expanded -ne $current) {
            Set-Item -Path "Env:$tmpVar" -Value $expanded
        }
    }
}

# ============================================================================
# Configuration
# ============================================================================

$RepoUrlSsh = "git@github.com:eimanghazaei/Youtab-Agent-Runtime.git"
$RepoUrlHttps = "https://github.com/eimanghazaei/Youtab-Agent-Runtime.git"
$PythonVersion = "3.11"
# Minor versions the installer accepts when the requested $PythonVersion isn't
# available, in preference order.  uv discovers both uv-managed and system
# interpreters, so this list also matches a pre-existing system Python.  Single
# source of truth shared by Test-Python's fallback and Resolve-AvailablePythonVersion.
$PythonFallbackVersions = @("3.12", "3.13")
$NodeVersion = "22.23.3"

# Stage-protocol version.  Bumped only for genuinely breaking changes to the
# manifest schema, stage-name set semantics, or stdout JSON shape.  Adding a
# new stage does NOT bump this -- drivers iterate the manifest dynamically.
$InstallStageProtocolVersion = 1

$script:CustomerReleaseMode = $PSBoundParameters.ContainsKey("ReleaseBaseUrl")


# Relocation alone provisions these exact free public prerequisites from the
# lock inside the verified NEW Runtime. Ordinary developer flows are unchanged.
function Get-PrivateHomePrerequisites {
    if (-not $script:CustomerReleaseMode) {
        throw 'Reviewed prerequisites require common customer Setup'
    }
    if ((Get-WindowsArch) -cne 'x64') {
        throw 'Reviewed customer prerequisites are available only for Windows x64'
    }
    $lock = [IO.File]::ReadAllText((Join-Path $InstallDir 'config\windows-private-home-prerequisites.json')) | ConvertFrom-Json
    if ($lock.schema -ne 1 -or $lock.uv.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $lock.uv.executableSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $lock.python.key -cnotmatch '^cpython-3\.11\.\d+-windows-x86_64-none$' -or
        $lock.uv.url -cnotmatch '^https://github\.com/astral-sh/uv/releases/download/' -or
        @($lock.python.catalog.PSObject.Properties).Count -ne 1 -or
        $lock.git.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $lock.git.version -cnotmatch '^\d+\.\d+\.\d+$' -or
        $lock.git.size -le 0 -or $lock.git.size -gt 104857600 -or
        $lock.git.url -cne "https://github.com/git-for-windows/git/releases/download/v$($lock.git.version).windows.1/PortableGit-$($lock.git.version)-64-bit.7z.exe") {
        throw 'Invalid reviewed Windows prerequisite lock'
    }
    return $lock
}
function Initialize-PrivatePythonControls {
    $lock = Get-PrivateHomePrerequisites
    $bundle = Assert-CustomerPrerequisites -Root $InstallDir -SourceSha $Commit
    $cache = Join-Path $YoutabHome 'bootstrap-cache\private-prerequisites'
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $localCatalog = $lock.python.catalog
    $localCatalog.PSObject.Properties[$lock.python.key].Value.url = ([Uri](Join-Path $bundle 'python.tar.gz')).AbsoluteUri
    [IO.File]::WriteAllText((Join-Path $cache 'python-downloads.json'), ($localCatalog | ConvertTo-Json -Depth 20),
        (New-Object Text.UTF8Encoding $false))
    foreach ($name in @('UV_PYTHON_INSTALL_MIRROR', 'UV_ASTRAL_MIRROR_URL', 'UV_NO_MANAGED_PYTHON',
        'UV_PYTHON_ARCH', 'UV_PYTHON_SEARCH_PATH', 'UV_PYTHON', 'UV_PYTHON_PREFERENCE', 'PYTHONHOME', 'PYTHONPATH')) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $YoutabHome 'python'
    $env:UV_PYTHON_DOWNLOADS_JSON_URL = Join-Path $cache 'python-downloads.json'
    $env:UV_PYTHON_CPYTHON_BUILD = "$($lock.python.build)"
    $env:UV_MANAGED_PYTHON = '1'
    $env:UV_PYTHON_NO_REGISTRY = '1'
    $env:UV_PYTHON_INSTALL_REGISTRY = '0'
    $env:UV_PYTHON_INSTALL_BIN = '0'
    $env:UV_CACHE_DIR = Join-Path $cache 'uv-cache'
    $env:UV_PYTHON_CACHE_DIR = Join-Path $cache 'python-cache'
    return $lock
}
function Get-PrivateBasePython {
    $lock = Initialize-PrivatePythonControls
    $python = Join-Path $YoutabHome "python\$($lock.python.key)\python.exe"
    if (-not [IO.File]::Exists($python)) { throw 'Exact private Python base is absent' }
    return $python
}
function Install-PrivateHomeUv {
    $lock = Get-PrivateHomePrerequisites
    $bundle = Assert-CustomerPrerequisites -Root $InstallDir -SourceSha $Commit
    $bin = Join-Path $YoutabHome 'bin'
    $uv = Join-Path $bin 'uv.exe'
    $cache = Join-Path $YoutabHome 'bootstrap-cache\private-prerequisites'
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $receiptPath = Join-Path $cache 'uv-receipt.json'
    if ([IO.File]::Exists($uv) -and [IO.File]::Exists($receiptPath)) {
        $receipt = [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
        if ($receipt.archiveSha256 -ceq $lock.uv.sha256 -and
            $receipt.executableSha256 -ceq $lock.uv.executableSha256 -and
            (Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $lock.uv.executableSha256) {
            $script:UvCmd = $uv
            return
        }
        if ($PrivateHomeRelocation) { throw 'Existing private uv differs from its verified provisioning receipt' }
    } elseif ([IO.File]::Exists($uv) -and $PrivateHomeRelocation) {
        throw 'Unverified existing private uv refused'
    }
    $zip = Join-Path $cache 'uv.zip'
    Copy-Item -LiteralPath (Join-Path $bundle 'uv.zip') -Destination $zip -Force -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.uv.sha256) {
        throw 'Private uv archive checksum mismatch'
    }
    $extracted = Join-Path $cache ('uv-extracted-' + [guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -LiteralPath $zip -DestinationPath $extracted
        $candidates = @(Get-ChildItem -LiteralPath $extracted -Filter uv.exe -File -Recurse)
        if ($candidates.Count -ne 1) { throw 'uv archive has no unique executable' }
        if ((Get-FileHash -LiteralPath $candidates[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.uv.executableSha256) {
            throw 'Private uv executable checksum mismatch'
        }
        [IO.Directory]::CreateDirectory($bin) | Out-Null
        # Preserve any previous managed executable until the replacement and its
        # receipt are both durable. A failed receipt write must restore the old uv.
        $backup = $null
        $hadReceipt = [IO.File]::Exists($receiptPath)
        $oldReceipt = if ($hadReceipt) { [IO.File]::ReadAllBytes($receiptPath) } else { $null }
        if ([IO.File]::Exists($uv)) {
            $backup = Join-Path $cache ('uv-legacy-' + [guid]::NewGuid().ToString('N') + '.exe')
            [IO.File]::Move($uv, $backup)
        }
        try {
            [IO.File]::Copy($candidates[0].FullName, $uv, $false)
            if ((Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.uv.executableSha256) {
                throw 'Private uv installed executable checksum mismatch'
            }
            $receipt = @{ archiveSha256 = $lock.uv.sha256; executableSha256 = $lock.uv.executableSha256 }
            [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
        } catch {
            if ([IO.File]::Exists($uv)) { [IO.File]::Delete($uv) }
            if ($backup) { [IO.File]::Move($backup, $uv) }
            if ($hadReceipt) { [IO.File]::WriteAllBytes($receiptPath, $oldReceipt) }
            elseif ([IO.File]::Exists($receiptPath)) { [IO.File]::Delete($receiptPath) }
            throw
        }
        $script:UvCmd = $uv
    } finally {
        # This GUID-named directory is owned by this attempt; leave any older
        # staging directory untouched for diagnosis.
        if ([IO.Directory]::Exists($extracted) -and
            -not (([IO.DirectoryInfo]$extracted).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            [IO.Directory]::Delete($extracted, $true)
        }
    }
}
function Install-PrivateHomePython {
    $lock = Initialize-PrivatePythonControls
    Resolve-UvCmd
    $base = Join-Path $YoutabHome "python\$($lock.python.key)"
    $receipt = Join-Path $YoutabHome 'bootstrap-cache\private-prerequisites\python-receipt.json'
    if ([IO.Directory]::Exists($base)) {
        if (-not [IO.File]::Exists($receipt)) {
            throw 'Unverified pre-existing Python base refused; no AlreadyAvailable shortcut'
        }
        $prior = [IO.File]::ReadAllText($receipt) | ConvertFrom-Json
        if ($prior.key -cne $lock.python.key -or $prior.sha256 -cne $lock.python.sha256) {
            throw 'Existing Python provisioning receipt differs'
        }
        return
    }
    Invoke-NativeWithRelaxedErrorAction {
        & $script:UvCmd --no-config --managed-python python install --install-dir $env:UV_PYTHON_INSTALL_DIR --no-bin --no-registry $lock.python.key
    }
    if ($LASTEXITCODE -ne 0) { throw 'Exact private Python installation failed' }
    if (-not [IO.File]::Exists((Join-Path $base 'python.exe'))) { throw 'Exact private Python executable absent' }
    [IO.File]::WriteAllText($receipt, (@{ key = $lock.python.key; sha256 = $lock.python.sha256 } | ConvertTo-Json),
        (New-Object Text.UTF8Encoding $false))
    # Setup admits the downloaded BASE before the next venv stage executes it.
}
function Invoke-PrivateHomePublicationStage {
    if (-not $PrivateHomeRelocation -or -not $script:CustomerReleaseMode -or -not $RelocationJournal) {
        throw 'Publication requires common Setup relocation'
    }
    . (Join-Path $InstallDir 'scripts\private-home-publication.ps1')
    if ($PublicationAction -eq 'prepare') {
        $journal = Read-YoutabRelocationJournal $RelocationJournal $YoutabHome
        if ($null -eq $journal.publication) {
            $desktop = $RelocationDesktopExe
            if (-not $desktop) { throw 'Validated target Desktop executable absent' }
            $links = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Youtab.lnk'),
                (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Youtab.lnk'))
            $journal.publication = New-YoutabRelocationPublication $journal $desktop $links
            Write-YoutabRelocationJournal $RelocationJournal $journal
        }
    } else {
        Invoke-YoutabRelocationPublication $RelocationJournal $YoutabHome $PublicationAction
    }
}


$script:RelocationPythonArgs = @()
if ($PrivateHomeRelocation) {
    $script:RelocationPythonArgs = @('-I')
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -like 'PYTHON*' -or $entry.Name -in @('VIRTUAL_ENV', '__PYVENV_LAUNCHER__')) {
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        }
    }
    $env:PYTHONNOUSERSITE = '1'
    if (-not $script:CustomerReleaseMode) { throw 'Private relocation is customer-only' }
    $privateTemp = Join-Path $YoutabHome 'bootstrap-cache\provisioning-tmp'
    [IO.Directory]::CreateDirectory($privateTemp) | Out-Null
    $env:TEMP = $privateTemp
    $env:TMP = $privateTemp
    if ($env:YOUTAB_AGENT_RELOCATION_SOURCE) {
        $sourcePrefix = $env:YOUTAB_AGENT_RELOCATION_SOURCE.TrimEnd('\') + '\'
        if ($env:YOUTAB_AGENT_GIT_BASH_PATH -and
            $env:YOUTAB_AGENT_GIT_BASH_PATH.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath Env:YOUTAB_AGENT_GIT_BASH_PATH
        }
        $env:Path = (@($env:Path -split ';' | Where-Object {
            $_ -and -not $_.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)
        })) -join ';'
    }
}

function Assert-CustomerReleaseSource {
    if (-not $script:CustomerReleaseMode) { return }
    if ($ReleaseBaseUrl -cnotmatch '^https://api\.youtab\.io/pilot-runtime-[a-f0-9]{32,}/releases$') {
        throw "Untrusted release base URL"
    }
    if ($Commit -cnotmatch '^[a-f0-9]{40}$') {
        throw "Customer release mode requires an exact lowercase commit SHA"
    }
    # The Desktop build stamp consumes the same validated release origin.
    $env:YOUTAB_AGENT_RELEASE_BASE_URL = $ReleaseBaseUrl
}

function Get-FileSha256 {
    param([Parameter(Mandatory=$true)] [string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $hash.Dispose()
        $stream.Dispose()
    }
}

# ============================================================================
# Helper functions

# Return the real OS processor architecture as a lowercase string suitable for
# Node.js / electron download URL slugs: "arm64", "x64", or "x86".
#
# Why not just trust [Environment]::Is64BitOperatingSystem or
# [RuntimeInformation]::OSArchitecture?  On Windows on ARM, when this script
# is invoked from Windows PowerShell 5.1 (the default `powershell.exe`) or
# any x64 PowerShell host, the process runs under Prism x64 emulation and
# BOTH of those APIs report `X64` -- they describe the emulated view, not
# the real OS.  We've seen this concretely on Snapdragon X1 hardware: an
# ARM64-based Surface Laptop returns OSArchitecture=X64 from an emulated
# PowerShell session.
#
# Win32_Processor.Architecture is invariant to emulation.  Values:
#   0=x86, 5=ARM, 9=AMD64/x64, 12=ARM64.  We fall back to
#   PROCESSOR_ARCHITEW6432 (set on WoW64 with the real OS arch) and then
#   PROCESSOR_ARCHITECTURE so we still produce a sensible answer if CIM
#   isn't available (locked-down WMI, container, etc.).
function Get-WindowsArch {
    try {
        $proc = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop |
            Select-Object -First 1
        switch ([int]$proc.Architecture) {
            12 { return "arm64" }
            9  { return "x64" }
            0  { return "x86" }
            5  { return "arm" }
        }
    } catch {
        # CIM unavailable -- fall through to env-var path
    }

    $envArch = if ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    } else {
        $env:PROCESSOR_ARCHITECTURE
    }
    switch ($envArch) {
        "ARM64" { return "arm64" }
        "AMD64" { return "x64" }
        "x86"   { return "x86" }
        default {
            # Last-resort: respect 64-bitness so we don't ship a 32-bit
            # toolchain to anyone.
            if ([Environment]::Is64BitOperatingSystem) { return "x64" } else { return "x86" }
        }
    }
}

# ============================================================================

function Write-Banner {
    Write-Host ""
    Write-Host "+---------------------------------------------------------+" -ForegroundColor Magenta
    Write-Host "|             * Youtab Agent Runtime Installer                    |" -ForegroundColor Magenta
    Write-Host "+---------------------------------------------------------+" -ForegroundColor Magenta
    Write-Host "|  An open source AI agent by Youtab B.V..              |" -ForegroundColor Magenta
    Write-Host "+---------------------------------------------------------+" -ForegroundColor Magenta
    Write-Host ""
}

function Write-Info {
    param([string]$Message)
    Write-Host "-> $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[!] $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "[X] $Message" -ForegroundColor Red
}

function Invoke-NativeWithRelaxedErrorAction {
    param([scriptblock]$Script)

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Script
    } finally {
        $ErrorActionPreference = $prevEAP
    }
}
function Discard-LockfileChurn {
    param([string]$Repo = $InstallDir)

    if (-not $Repo -or -not (Test-Path (Join-Path $Repo ".git"))) { return }

    try {
        $diff = & git -c windows.appendAtomically=false -C $Repo diff --name-only 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $diff) { return }

        $dirtyPackageDirs = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        foreach ($path in $diff) {
            if ($path -like "*package.json") {
                $null = $dirtyPackageDirs.Add((Split-Path $path -Parent))
            }
        }

        $dirtyLocks = [System.Collections.Generic.List[string]]::new()
        foreach ($path in $diff) {
            if ($path -notlike "*package-lock.json") { continue }
            $lockDir = Split-Path $path -Parent
            if ($dirtyPackageDirs.Contains($lockDir)) { continue }
            $dirtyLocks.Add($path)
        }

        if ($dirtyLocks.Count -eq 0) { return }
        & git -c windows.appendAtomically=false -C $Repo checkout -- @($dirtyLocks) 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Info "Discarded npm lockfile churn ($($dirtyLocks.Count) file(s))"
        }
    } catch {
        # Best-effort only; never let cleanup block the installer update path.
    }
}
# Inspect npm output for a TLS-trust failure and, if found, print actionable
# remediation. npm/Node surface corporate MITM proxies and missing root CAs as
# "unable to get local issuer certificate" / "self-signed certificate in
# certificate chain" / UNABLE_TO_GET_ISSUER_CERT_LOCALLY -- most commonly while
# Electron's install.js postinstall downloads the Electron binary. The reporter
# usually misreads this as an admin-rights or generic install failure (see
# issue #38016), so detect it once here and route every npm stage through this
# hint. Returns $true when a cert error was detected (caller may adjust its own
# messaging), $false otherwise.
function Show-NpmCertHint {
    param([string]$NpmOutput)
    if (-not $NpmOutput) { return $false }
    $isCertError = $NpmOutput -match "unable to get local issuer certificate" `
        -or $NpmOutput -match "self.signed certificate" `
        -or $NpmOutput -match "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" `
        -or $NpmOutput -match "SELF_SIGNED_CERT_IN_CHAIN" `
        -or $NpmOutput -match "CERT_HAS_EXPIRED"
    if (-not $isCertError) { return $false }
    Write-Warn "This looks like a TLS certificate-trust failure, not a permissions problem."
    Write-Info "  A corporate proxy or antivirus is likely intercepting HTTPS and presenting a"
    Write-Info "  certificate Node.js doesn't trust. To fix, point Node at your org's root CA:"
    Write-Info "    1. Get the corporate root CA as a .pem/.crt from your IT team."
    Write-Info "    2. setx NODE_EXTRA_CA_CERTS `"C:\path\to\corp-ca.pem`""
    Write-Info "    3. Open a NEW terminal (so the env var takes effect) and re-run the installer."
    return $true
}

# --- Ensure-mode helpers ---

function Resolve-NpmCmd {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) { return $null }
    $npmExe = $npmCmd.Source
    if ($npmExe -like "*.ps1") {
        $npmCmdSibling = Join-Path (Split-Path $npmExe -Parent) "npm.cmd"
        if (Test-Path $npmCmdSibling) { return $npmCmdSibling }
    }
    return $npmExe
}

function Find-SystemBrowser {
    # Honor ONLY an explicit, user-set AGENT_BROWSER_EXECUTABLE_PATH override.
    #
    # We no longer scan well-known install locations for a system browser.
    # Auto-detection silently bound the install to an arbitrary binary instead
    # of the bundled Playwright Chromium, which made the browser tool behave
    # differently across hosts (and, on Linux, picked up a sandboxed Snap
    # Chromium that hangs every browser_navigate). Every install now uses the
    # bundled Chromium unless the user explicitly points elsewhere.
    $override = $env:AGENT_BROWSER_EXECUTABLE_PATH
    if ([string]::IsNullOrWhiteSpace($override)) { return $null }
    if (Test-Path $override) { return $override }
    return $null
}

function Write-BrowserEnv {
    param([string]$BrowserPath)
    if (-not (Test-Path $YoutabHome)) {
        New-Item -ItemType Directory -Force -Path $YoutabHome | Out-Null
    }
    $envFile = Join-Path $YoutabHome ".env"
    if (-not (Test-Path $envFile)) {
        Set-Content -Path $envFile -Value "AGENT_BROWSER_EXECUTABLE_PATH=$BrowserPath" -Encoding UTF8
        return
    }
    $content = Get-Content $envFile -Raw -ErrorAction SilentlyContinue
    if ($content -and $content -match "AGENT_BROWSER_EXECUTABLE_PATH=") { return }
    Add-Content -Path $envFile -Value "AGENT_BROWSER_EXECUTABLE_PATH=$BrowserPath" -Encoding UTF8
}

function Install-AgentBrowser {
    param([switch]$SkipChromium)
    $npm = Resolve-NpmCmd
    if (-not $npm) {
        Write-Err "npm not found -- install Node.js first"
        throw "npm not found"
    }

    Write-Info "Installing agent-browser via npm -g --prefix..."
    $prefixDir = Join-Path $YoutabHome "node"
    if (-not (Test-Path $prefixDir)) {
        New-Item -ItemType Directory -Path $prefixDir -Force | Out-Null
    }
    $npmLog = [System.IO.Path]::GetTempFileName()
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $npm install -g --prefix $prefixDir --silent --ignore-scripts "agent-browser@^0.26.0" "@askjo/camofox-browser@^1.5.2" 2>&1 | Tee-Object -FilePath $npmLog | Out-Null
    $npmExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($npmExit -ne 0) {
        $npmDetail = Get-Content $npmLog -Raw -ErrorAction SilentlyContinue
        Remove-Item $npmLog -Force -ErrorAction SilentlyContinue
        Write-Err "npm install -g failed (exit $npmExit): $npmDetail"
        Show-NpmCertHint $npmDetail | Out-Null
        throw "npm install failed"
    }
    Remove-Item $npmLog -Force -ErrorAction SilentlyContinue

    if (-not $SkipChromium) {
        $sysBrowser = Find-SystemBrowser
        if ($sysBrowser) {
            Write-BrowserEnv -BrowserPath $sysBrowser
            Write-Info "Explicit browser override set -- skipping bundled Chromium download"
        } else {
            $abExe = Join-Path $prefixDir "agent-browser.cmd"
            if (Test-Path $abExe) {
                Write-Info "Installing Chromium via agent-browser install..."
                $abLog = [System.IO.Path]::GetTempFileName()
                $prevEAP = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                & $abExe install 2>&1 | Tee-Object -FilePath $abLog | Out-Null
                $abExit = $LASTEXITCODE
                $ErrorActionPreference = $prevEAP
                if ($abExit -ne 0) {
                    $abDetail = Get-Content $abLog -Raw -ErrorAction SilentlyContinue
                    Write-Warn "Chromium install failed (exit $abExit): $abDetail"
                }
                Remove-Item $abLog -Force -ErrorAction SilentlyContinue
            } else {
                Write-Warn "agent-browser.cmd not found at $abExe"
            }
        }
    }
    Write-Success "Agent-browser ready"
}

# ============================================================================
# Dependency checks
# ============================================================================

# Resolve the PowerShell host executable used to spawn child PowerShell
# processes (the astral uv installer below).  We must NOT hardcode the bare
# name `powershell`: it names *Windows PowerShell* and only resolves when its
# System32 directory is on PATH.  When install.ps1 is run under PowerShell 7+
# (`pwsh`) -- or any session where `powershell` isn't on PATH -- a bare
# `powershell` spawn dies with "The term 'powershell' is not recognized",
# aborting uv installation (field report: Windows install stuck, uv install
# failed with exactly that message).  Prefer the absolute path of the host we
# are already running in (PATH-independent), then fall back to whichever of
# powershell/pwsh is resolvable, and only then to the bare name.
function Get-PowerShellHostExe {
    try {
        $hostExe = (Get-Process -Id $PID).Path
        if ($hostExe -and (Test-Path $hostExe)) {
            $leaf = Split-Path $hostExe -Leaf
            # Only trust the current host when it is a real PowerShell CLI
            # (not e.g. powershell_ise.exe or an embedded host that can't take
            # `-ExecutionPolicy`/`-Command`).
            if ($leaf -match '^(?i:powershell|pwsh)\.exe$') { return $hostExe }
        }
    } catch { }
    foreach ($candidate in @("powershell", "pwsh")) {
        $cmd = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($cmd -and $cmd.Source) { return $cmd.Source }
    }
    # Last-ditch: hand back the bare name so the spawn surfaces its own error.
    return "powershell"
}

function Install-Uv {
    # Youtab owns its own uv at $YoutabHome\bin\uv.exe.  Always install there --
    # no PATH probing, no conda guards, no multi-location resolution chains.
    # The runtime update path (youtab_agent_cli/managed_uv.py) looks in the same
    # place, so install.ps1 and `youtab update` stay in sync.
    $managedUv = Join-Path $YoutabHome "bin\uv.exe"

    if (Test-Path $managedUv) {
        $script:UvCmd = $managedUv
        $version = & $managedUv --version
        Write-Success "Managed uv found ($version)"
        return $true
    }

    Write-Info "Installing managed uv into $YoutabHome\bin ..."
    New-Item -ItemType Directory -Path (Join-Path $YoutabHome "bin") -Force | Out-Null

    # UV_INSTALL_DIR tells the astral installer to place the binary
    # directly into $YoutabHome\bin instead of ~/.local/bin.
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $env:UV_INSTALL_DIR = Join-Path $YoutabHome "bin"
        # Spawn via the resolved host exe (see Get-PowerShellHostExe) rather
        # than a bare `powershell`, which isn't guaranteed to be on PATH under
        # PowerShell 7 / pwsh-only setups.
        $psHostExe = Get-PowerShellHostExe
        & $psHostExe -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex" 2>&1 | Out-Null
        $ErrorActionPreference = $prevEAP

        if (Test-Path $managedUv) {
            $script:UvCmd = $managedUv
            $version = & $managedUv --version
            Write-Success "Managed uv installed ($version)"
            return $true
        }

        Write-Err "uv installed but not found at $managedUv"
        Write-Info "Install manually: https://docs.astral.sh/uv/getting-started/installation/"
        return $false
    } catch {
        if ($prevEAP) { $ErrorActionPreference = $prevEAP }
        Write-Err "Failed to install uv: $_"
        Write-Info "Install manually: https://docs.astral.sh/uv/getting-started/installation/"
        return $false
    }
}

# Refresh $env:Path from the User + Machine registry hives.  Stage drivers
# invoke each stage in a fresh powershell process, but those processes
# inherit env from the parent driver shell, NOT from the registry.  When
# an earlier stage (Stage-Git, Stage-Node, ...) installs a binary and
# pushes its directory into User PATH, the next child process's $env:Path
# is stale and the binary appears missing.  This helper re-reads PATH
# from the registry so every Invoke-Stage starts from a fresh, up-to-date
# PATH view.  Cheap (registry reads, no I/O elsewhere) and idempotent.
function Read-YoutabInstallPath([ValidateSet('User', 'Machine')][string]$Scope) {
    return [Environment]::GetEnvironmentVariable('Path', $Scope)
}
function Sync-EnvPath {
    $env:Path = (Read-YoutabInstallPath 'User') + ';' + (Read-YoutabInstallPath 'Machine')
    if (-not $PrivateHomeRelocation) { return }
    # Refreshing registry PATH must never put OLD executable roots back into
    # a relocation child. Setup admits these NEW code trees before each stage.
    $key = {
        param([string]$Value)
        $full = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Value.Trim('"'))).TrimEnd('\')
        if ($full.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { return '\\' + $full.Substring(8) }
        if ($full.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { return $full.Substring(4) }
        return $full
    }
    $source = & $key $env:YOUTAB_AGENT_RELOCATION_SOURCE
    $remaining = @($env:Path -split ';' | Where-Object {
        if (-not $_) { return $false }
        try { $candidate = & $key $_ } catch { return $true }
        return $candidate -ine $source -and -not $candidate.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)
    })
    $fresh = @('youtab-agent-runtime\venv\Scripts', 'bin', 'node', 'node\bin', 'git\cmd', 'git\bin', 'git\usr\bin') |
        ForEach-Object { [IO.Path]::Combine($YoutabHome, $_) } | Where-Object {
            [IO.Directory]::Exists($_) -and -not ([IO.File]::GetAttributes($_) -band [IO.FileAttributes]::ReparsePoint)
        }
    $env:Path = (@($fresh) + $remaining | Select-Object -Unique) -join ';'
}

# npm lifecycle scripts on Windows spawn ``cmd.exe /d /s /c node <script>``.
# PowerShell can resolve ``node`` via Get-Command while the child cmd process
# still sees a PATH without node.exe's directory (nvm4w shims, App Paths
# aliases, stale cross-process PATH).  Prepend the resolved node.exe parent
# directory so postinstall hooks (electron-winstaller, native modules, etc.)
# can find ``node``.  Regression for #48130.
function Ensure-NodeExeOnPath {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { return $false }

    $nodeExeDir = Split-Path $nodeCmd.Source -Parent
    if (-not $nodeExeDir) { return $false }

    $pathParts = $env:Path -split ";"
    if ($pathParts -notcontains $nodeExeDir) {
        $env:Path = "$nodeExeDir;$env:Path"
    }
    return $true
}

# Re-discover uv without re-installing it.  Cross-process stage drivers
# (the desktop GUI's onboarding wizard, CI step-runners) invoke each stage
# in a fresh powershell process, so $script:UvCmd set by Install-Uv in a
# prior process is not visible here.  Later stages (Test-Python,
# Install-Venv, Install-Dependencies, Install-PlatformSdks) call this
# at the top to populate $script:UvCmd from the managed location.
# Throws if uv is not findable -- the caller's stage then surfaces a
# clean error via the stage-driver's try/catch.
function Resolve-UvCmd {
    if ($script:CustomerReleaseMode) {
        $lock = Get-PrivateHomePrerequisites
        $managedUv = Join-Path $YoutabHome 'bin\uv.exe'
        if (-not (Test-Path -LiteralPath $managedUv -PathType Leaf) -or
            (Get-FileHash -LiteralPath $managedUv -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.uv.executableSha256) {
            throw 'Customer managed uv is absent or differs from reviewed executable'
        }
        $script:UvCmd = $managedUv
        return
    }
    # Already resolved (default invocation path: Install-Uv ran earlier
    # in the same process and set $script:UvCmd).
    if ($script:UvCmd) {
        if ($script:UvCmd -eq "uv") {
            # "uv" on PATH -- verify it's still resolvable (PATH could have
            # changed mid-session; cheap to recheck).
            if (Get-Command uv -ErrorAction SilentlyContinue) { return }
        } elseif (Test-Path $script:UvCmd) {
            return
        }
        # Stale; fall through to re-discover.
    }

    # Check the managed location first -- this is where Install-Uv puts it.
    $managedUv = Join-Path $YoutabHome "bin\uv.exe"
    if (Test-Path $managedUv) {
        $script:UvCmd = $managedUv
        return
    }

    if ($PrivateHomeRelocation) { throw 'Private verified uv is absent; system fallback is disabled' }

    # Fall back to PATH (covers edge cases where the installer ran in a
    # sibling process and YOUTAB_AGENT_HOME wasn't propagated).
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        $script:UvCmd = "uv"
        return
    }

    # Refresh PATH from registry in case the current process started before
    # Install-Uv updated User PATH.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        $script:UvCmd = "uv"
        return
    }

    throw "uv is not installed. Run install.ps1 -Stage uv first."
}

function Get-SupportedPythonVersion {
    param([string]$PythonExe)
    if (-not $PythonExe -or $PythonExe -like "*\WindowsApps\*") { return $null }
    # Match pyproject.toml's >=3.11,<3.14 before selecting an interpreter.
    # Native --version may use stderr; preserve WinPS 5.1's caller policy.
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $versionLines = @(& $PythonExe --version 2>&1)
        $versionExitCode = $LASTEXITCODE
        if ($versionExitCode -eq 0) {
            foreach ($line in $versionLines) {
                if ("$line".Trim() -match '^Python (3\.(?:11|12|13))\.[0-9]+') {
                    return $Matches[1]
                }
            }
        }
    } catch { }
    finally { $ErrorActionPreference = $previousErrorAction }
    return $null
}

function Resolve-AvailablePythonVersion {
    # Return the first Python minor version uv can actually find, preferring the
    # requested $PythonVersion and then $PythonFallbackVersions.  Returns $null
    # when none are available.
    #
    # This is the cross-process-safe counterpart to Test-Python's in-memory
    # ``$script:PythonVersion = $fallbackVer`` mutation.  Under Youtab-Setup.exe
    # each ``-Stage NAME`` runs in a *fresh* powershell.exe, so the fallback the
    # ``python`` stage settled on (e.g. 3.12 when 3.11 is absent) does NOT
    # survive into the ``venv`` stage's process -- there $PythonVersion is back
    # at its "3.11" default.  Consumers re-resolve here instead of trusting that
    # default, which is exactly the propagation gap behind issue #50769.
    $candidates = @($PythonVersion) + $PythonFallbackVersions
    $seen = @{}
    foreach ($ver in $candidates) {
        if (-not $ver -or $seen.ContainsKey($ver)) { continue }
        $seen[$ver] = $true
        try {
            $found = & $UvCmd python find $ver 2>$null
            if ($LASTEXITCODE -eq 0 -and $found) {
                $actualVersion = Get-SupportedPythonVersion -PythonExe $found
                if ($actualVersion) { return $actualVersion }
            }
        } catch { }
    }
    return $null
}

function Test-Python {
    Write-Info "Checking Python $PythonVersion..."
    
    # Let uv find or install Python
    try {
        $pythonPath = & $UvCmd python find $PythonVersion 2>$null
        if ($LASTEXITCODE -eq 0 -and $pythonPath) {
            $ver = Get-SupportedPythonVersion -PythonExe $pythonPath
            if ($ver) {
                $script:PythonVersion = $ver
                Write-Success "Python found: $ver"
                return $true
            }
        }
    } catch { }
    
    # Python not found -- use uv to install it (no admin needed!)
    Write-Info "Python $PythonVersion not found, installing via uv..."
    # Capture EAP outside the try block so the catch's restore call always
    # has a meaningful value (see Install-Uv for the full rationale).
    $prevEAP = $ErrorActionPreference
    try {
        # Temporarily relax ErrorActionPreference: uv writes download progress
        # ("Downloading cpython-3.11.15-windows-x86_64-none (24.5MiB)") to
        # stderr.  With $ErrorActionPreference = "Stop" (set at the top of this
        # script) PowerShell wraps stderr lines from native commands as
        # ErrorRecord objects when captured via 2>&1, then throws a terminating
        # exception on the first one -- even though uv exits 0 and Python was
        # installed successfully.  Verify success via `uv python find`
        # afterwards, which is the reliable signal regardless of exit-code
        # semantics or stderr noise.  This fix was previously landed as
        # commit ec1714e71 and then lost in a release squash; reapplied here.
        $ErrorActionPreference = "Continue"
        $uvOutput = & $UvCmd python install $PythonVersion 2>&1
        $uvExitCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP

        # Check if Python is now available (more reliable than exit code
        # since uv may return non-zero due to "already installed" etc.)
        $pythonPath = & $UvCmd python find $PythonVersion 2>$null
        if ($LASTEXITCODE -eq 0 -and $pythonPath) {
            $ver = Get-SupportedPythonVersion -PythonExe $pythonPath
            if ($ver) {
                $script:PythonVersion = $ver
                Write-Success "Python installed: $ver"
                return $true
            }
        }

        # uv ran but Python still not findable -- show what happened
        if ($uvExitCode -ne 0) {
            Write-Warn "uv python install output:"
            Write-Host $uvOutput -ForegroundColor DarkGray
        }
    } catch {
        # Restore EAP in case the try block threw before the assignment
        if ($prevEAP) { $ErrorActionPreference = $prevEAP }
        Write-Warn "uv python install error: $_"
    }

    # Fallback: check for another supported, already-installed interpreter.
    Write-Info "Trying to find existing Python 3.11, 3.12, or 3.13..."
    foreach ($fallbackVer in $PythonFallbackVersions) {
        try {
            $pythonPath = & $UvCmd python find $fallbackVer 2>$null
            if ($LASTEXITCODE -eq 0 -and $pythonPath) {
                $ver = Get-SupportedPythonVersion -PythonExe $pythonPath
                if ($ver) {
                    Write-Success "Found fallback: $ver"
                    $script:PythonVersion = $ver
                    return $true
                }
            }
        } catch { }
    }

    # Fallback: try system python -- but skip the Microsoft Store stub.
    # On Windows, %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is a 0-byte
    # reparse-point stub that prints "Python was not found; run without
    # arguments to install from the Microsoft Store..." to stdout and exits
    # non-zero.  Get-Command finds it; invoking it produces a confusing error
    # that the user sees as our installer crashing.
    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCmd) {
        $isStoreStub = $false
        try {
            $pythonSource = $pythonCmd.Source
            if ($pythonSource -and $pythonSource -like "*\WindowsApps\*") {
                $isStoreStub = $true
            } else {
                # Even outside WindowsApps, a 0-byte file is the stub
                $item = Get-Item $pythonSource -ErrorAction SilentlyContinue
                if ($item -and $item.Length -eq 0) { $isStoreStub = $true }
            }
        } catch { }

        if (-not $isStoreStub) {
            try {
                $sysVer = Get-SupportedPythonVersion -PythonExe $pythonSource
                if ($sysVer) {
                    $script:PythonVersion = $sysVer
                    Write-Success "Using system Python: $sysVer"
                    return $true
                }
            } catch {
            }
        }
    }

    Write-Err "Failed to install Python $PythonVersion"
    Write-Info "Install Python 3.11 manually, then re-run this script:"
    Write-Info "  https://www.python.org/downloads/"
    Write-Info "  Or: winget install Python.Python.3.11"
    return $false
}

$script:GitInstallFailureReason = $null
$script:GitBashPath = $null
$script:GitBashProbeOutput = $null

function Test-GitBashCompatibility {
    <#
    .SYNOPSIS
    Verify that Git Bash can launch external MSYS programs, not just evaluate
    shell builtins. Mandatory ASLR can allow bash.exe itself to start while
    every child linked to msys-2.0.dll fails during fork/spawn.
    #>
    param([Parameter(Mandatory = $true)][string]$BashPath)

    $script:GitBashProbeOutput = $null
    if (-not (Test-Path -LiteralPath $BashPath)) {
        $script:GitBashProbeOutput = "bash.exe was not found at $BashPath"
        return $false
    }

    $process = New-Object System.Diagnostics.Process
    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $BashPath
        $startInfo.Arguments = '--noprofile --norc -c "/usr/bin/true; /usr/bin/cat --version >/dev/null"'
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        if ($PrivateHomeRelocation) {
            foreach ($name in @($startInfo.EnvironmentVariables.Keys)) {
                if ($name -in @('BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS') -or $name -like 'BASH_FUNC_*') {
                    $startInfo.EnvironmentVariables.Remove($name)
                }
            }
            $startInfo.WorkingDirectory = Join-Path $YoutabHome 'git'
        }
        $process.StartInfo = $startInfo

        if (-not $process.Start()) {
            $script:GitBashProbeOutput = "bash.exe did not start"
            return $false
        }
        if (-not $process.WaitForExit(15000)) {
            try { $process.Kill() } catch { }
            $script:GitBashProbeOutput = "Git Bash compatibility probe timed out"
            return $false
        }

        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $script:GitBashProbeOutput = ("$stdout`n$stderr").Trim()
        return ($process.ExitCode -eq 0)
    } catch {
        $script:GitBashProbeOutput = $_.Exception.Message
        return $false
    } finally {
        $process.Dispose()
    }
}

function Test-MandatoryAslrEnabled {
    <# Return true only when Windows reports system-wide ForceRelocateImages=ON. #>
    try {
        $cmd = Get-Command Get-ProcessMitigation -ErrorAction SilentlyContinue
        if (-not $cmd) { return $false }
        $mitigations = & $cmd -System
        $value = $mitigations.Aslr.ForceRelocateImages
        return ($null -ne $value -and $value.ToString().ToUpperInvariant() -eq "ON")
    } catch {
        return $false
    }
}

function Get-GitRootFromBashPath {
    param([Parameter(Mandatory = $true)][string]$BashPath)

    $binDir = Split-Path -Path $BashPath -Parent
    if ((Split-Path -Path $binDir -Leaf) -ine "bin") {
        return (Split-Path -Path $binDir -Parent)
    }

    $parent = Split-Path -Path $binDir -Parent
    if ((Split-Path -Path $parent -Leaf) -ieq "usr") {
        return (Split-Path -Path $parent -Parent)
    }
    return $parent
}

function New-GitBashAslrFailureReason {
    param([Parameter(Mandatory = $true)][string]$BashPath)

    $gitRoot = Get-GitRootFromBashPath -BashPath $BashPath
    $escapedRoot = $gitRoot -replace "'", "''"
    return @(
        "Git Bash at $BashPath cannot launch required MSYS child processes because Windows Mandatory ASLR (ForceRelocateImages) is enabled system-wide. Reinstalling Git will not change this policy."
        "Open PowerShell as Administrator and run:"
        "`$gitRoot = '$escapedRoot'"
        'Get-Item "$gitRoot\bin\bash.exe", "$gitRoot\usr\bin\*.exe" -ErrorAction SilentlyContinue | ForEach-Object { Set-ProcessMitigation -Name $_.FullName -Disable ForceRelocateImages }'
        "Then rerun Youtab setup. If the override is blocked or later re-applied, ask your Windows administrator to allow this per-program exception."
    ) -join [Environment]::NewLine
}

function Install-Git {
    <#
    .SYNOPSIS
    Ensure Git (and Git Bash) are installed.  Git for Windows bundles bash.exe
    which Youtab uses to run shell commands.

    Priority order (deliberately simple -- no winget, no registry, no system
    package manager):
      1. Existing ``git`` on PATH -- use it as-is (the common fast path).
      2. Download **PortableGit** from the official git-for-windows GitHub
         release (self-extracting 7z.exe) and unpack it to
         ``%LOCALAPPDATA%\youtab\git`` -- never touches system Git, never
         requires admin, works even on locked-down machines and machines
         with a broken system Git install.

    **Why PortableGit, not MinGit:**  MinGit is the minimal-automation
    distribution and ships ONLY ``git.exe`` -- no bash, no POSIX utilities.
    Youtab needs ``bash.exe`` to run shell commands.  PortableGit is the
    full Git for Windows distribution without the installer UI; it ships
    ``git.exe`` + ``bash.exe`` + ``sh``, ``awk``, ``sed``, ``grep``, ``curl``,
    ``ssh``, etc. in ``usr\bin\``.

    We deliberately skip winget because it fails badly when the system Git
    install is in a half-installed state (partially registered, or uninstall-
    blocked).  Owning the Youtab copy of Git ourselves is predictable and
    recoverable: if it ever breaks, ``Remove-Item %LOCALAPPDATA%\youtab\git``
    and re-running this installer fully recovers.

    After install we locate ``bash.exe`` and persist the path in
    ``YOUTAB_AGENT_GIT_BASH_PATH`` (User scope) so Youtab can find it in a fresh
    shell without a second PATH refresh.
    #>
    $script:GitInstallFailureReason = $null
    Write-Info "Checking Git..."
    if ($PrivateHomeRelocation) {
        $privateGit = Get-PrivateHomePrerequisites
        if ((Get-WindowsArch) -ne 'x64') { throw 'Reviewed private PortableGit requires x64' }
        if ([IO.Directory]::Exists((Join-Path $YoutabHome 'git'))) {
            $script:GitBashPath = Assert-YoutabFreshManagedGit $YoutabHome
            if (-not (Test-GitBashCompatibility -BashPath $script:GitBashPath)) { throw 'Fresh managed Git Bash compatibility probe failed' }
            $env:YOUTAB_AGENT_GIT_BASH_PATH = $script:GitBashPath
            return $true
        }
    }

    if (-not $PrivateHomeRelocation -and (Get-Command git -ErrorAction SilentlyContinue)) {
        $version = git --version
        Write-Success "Git found ($version)"
        Set-GitBashEnvVar
        if ($script:GitBashPath -and (Test-GitBashCompatibility -BashPath $script:GitBashPath)) {
            Write-Success "Git Bash can launch MSYS programs"
            return $true
        }

        if ($script:GitBashPath -and (Test-MandatoryAslrEnabled)) {
            $script:GitInstallFailureReason = New-GitBashAslrFailureReason -BashPath $script:GitBashPath
            Write-Err $script:GitInstallFailureReason
            return $false
        }

        if ($script:GitBashPath) {
            $probeDetail = if ($script:GitBashProbeOutput) { ": $script:GitBashProbeOutput" } else { "" }
            Write-Warn "System Git Bash could not launch required MSYS programs$probeDetail"
        } else {
            Write-Warn "Git is on PATH, but its Git Bash installation could not be located."
        }
        Write-Info "Trying a Youtab-managed PortableGit install instead..."
    }

    # Download PortableGit into $YoutabHome\git.  Always works as long as
    # we can reach github.com -- no admin, no winget, no reliance on the
    # user's possibly-broken system Git install.
    Write-Info "Git not found -- downloading PortableGit to $YoutabHome\git\ ..."
    Write-Info "(no admin rights required; isolated from any system Git install)"

    try {
        $arch = Get-WindowsArch
        if ($arch -eq 'arm64') {
            $assetTag = 'arm64'
            $downloadIsZip = $false
        } elseif ($arch -eq 'x64') {
            $assetTag = '64-bit'
            $downloadIsZip = $false
        } else {
            # PortableGit does not ship 32-bit / arm builds -- fall back to MinGit
            # 32-bit with a warning that bash-based features will be unavailable.
            $assetTag = '32-bit-mingit'
            $downloadIsZip = $true
        }

        # Pinned git-for-windows release. We deliberately do NOT hit
        # api.github.com/repos/.../releases/latest here: that endpoint
        # is rate-limited to 60 requests/hour/IP for unauthenticated
        # callers, and users behind CGNAT / corporate NAT / dorm WiFi
        # routinely hit the limit, breaking the installer.
        # Static github.com/.../releases/download/<tag>/<asset> URLs
        # are not subject to the API rate limit.
        $gitTag    = "v2.54.0.windows.1"
        $gitVer    = "2.54.0"
        $gitVerTag = "$gitVer.windows.1"

        if ($arch -eq "32-bit-mingit") {
            Write-Warn "32-bit Windows detected -- PortableGit is 64-bit only.  Installing MinGit 32-bit as a last resort; bash-dependent Youtab features (terminal tool, agent-browser) will not work on this machine."
            $assetName    = "MinGit-$gitVer-32-bit.zip"
            $downloadIsZip = $true
        } elseif ($arch -eq "arm64") {
            $assetName    = "PortableGit-$gitVer-arm64.7z.exe"
            $downloadIsZip = $false
        } else {
            $assetName    = "PortableGit-$gitVer-64-bit.7z.exe"
            $downloadIsZip = $false
        }

        $downloadUrl = "https://github.com/git-for-windows/git/releases/download/$gitTag/$assetName"
        $downloadExt = if ($downloadIsZip) { "zip" } else { "7z.exe" }
        $tmpFile = "$env:TEMP\$assetName"
        $gitDir = "$YoutabHome\git"

        Write-Info "Downloading $assetName (Git for Windows $gitVerTag)..."
        if ($PrivateHomeRelocation) {
            $downloadUrl = $privateGit.git.url
            $privateCache = Join-Path $YoutabHome 'bootstrap-cache\private-prerequisites'
            [IO.Directory]::CreateDirectory($privateCache) | Out-Null
            $tmpFile = Join-Path $privateCache "PortableGit-$($privateGit.git.version)-64-bit.7z.exe"
            if ([IO.Directory]::Exists($gitDir)) { throw 'Private Git collision retained for review' }
        }
        if (-not $PrivateHomeRelocation -or -not [IO.File]::Exists($tmpFile)) {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpFile -UseBasicParsing
        }
        if ($PrivateHomeRelocation -and (([IO.File]::GetAttributes($tmpFile) -band [IO.FileAttributes]::ReparsePoint) -or
            ([IO.FileInfo]$tmpFile).Length -ne $privateGit.git.size -or
            (Get-FileHash -LiteralPath $tmpFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $privateGit.git.sha256)) {
            throw 'Private PortableGit archive size/checksum mismatch; no extractor executed'
        }

        if (Test-Path $gitDir) {
            Write-Info "Removing previous Git install at $gitDir ..."
            Remove-Item -Recurse -Force $gitDir
        }
        New-Item -ItemType Directory -Path $gitDir -Force | Out-Null

        if ($downloadIsZip) {
            Expand-Archive -Path $tmpFile -DestinationPath $gitDir -Force
        } else {
            # PortableGit is a self-extracting 7z archive.  Invoke it with
            # `-o<target> -y` (silent) to extract to $gitDir.  No 7z install
            # required; it's fully self-contained.
            Write-Info "Extracting PortableGit to $gitDir ..."
            $extractorGuard = $null
            if ($PrivateHomeRelocation) {
                $extractorGuard = [IO.File]::Open($tmpFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                Assert-YoutabSingleStageFile $extractorGuard
            }
            try {
                $extractProc = Start-Process -FilePath $tmpFile `
                    -ArgumentList "-o`"$gitDir`"", "-y" `
                    -NoNewWindow -Wait -PassThru
            } finally { if ($null -ne $extractorGuard) { $extractorGuard.Dispose() } }
            if ($extractProc.ExitCode -ne 0) {
                throw "PortableGit extraction failed (exit code $($extractProc.ExitCode))"
            }
        }
        if (-not $PrivateHomeRelocation) { Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue }

        # PortableGit layout: cmd\git.exe + bin\bash.exe + usr\bin\ (coreutils)
        # MinGit layout:      cmd\git.exe + usr\bin\bash.exe (if present)
        $gitExe = "$gitDir\cmd\git.exe"
        if (-not (Test-Path $gitExe)) {
            throw "Git extraction did not produce git.exe at $gitExe"
        }

        if ($PrivateHomeRelocation) {
            # No User environment or system discovery changes before publication.
            $script:GitBashPath = Join-Path $gitDir 'bin\bash.exe'
            if (-not (Test-Path -LiteralPath $script:GitBashPath) -or
                -not (Test-GitBashCompatibility -BashPath $script:GitBashPath)) { throw 'Fresh managed Git Bash compatibility probe failed' }
            $files = [ordered]@{}
            foreach ($file in @(Get-ChildItem -LiteralPath $gitDir -Recurse -Force)) {
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private Git contains a linked entry' }
                if (-not $file.PSIsContainer) {
                    $files[$file.FullName.Substring($gitDir.Length + 1)] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
            $receipt = @{ version = $privateGit.git.version; archiveSha256 = $privateGit.git.sha256;
                archiveSize = $privateGit.git.size; files = $files; bashProbePassed = $true }
            $receiptPath = Join-Path $privateCache 'git-receipt.json'
            $stage = "$receiptPath.new-staged"
            $stream = [IO.File]::Open($stage, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Depth 100))
                $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
            } finally { $stream.Dispose() }
            [IO.File]::Move($stage, $receiptPath)
            $script:GitBashPath = Assert-YoutabFreshManagedGit $YoutabHome
            $env:YOUTAB_AGENT_GIT_BASH_PATH = $script:GitBashPath
            $env:Path = "$gitDir\cmd;$env:Path"
            return $true
        }

        # Add to session PATH so the rest of this install run can use git.
        $env:Path = "$gitDir\cmd;$env:Path"

        # Persist to User PATH so fresh shells see it.  PortableGit needs
        # cmd\ (for git.exe), bin\ (for bash.exe + core tools), and
        # usr\bin\ (for perl, ssh, curl, and other POSIX coreutils).
        $newPathEntries = @(
            "$gitDir\cmd",
            "$gitDir\bin",
            "$gitDir\usr\bin"
        )
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $userPathItems = if ($userPath) { $userPath -split ";" } else { @() }
        $changed = $false
        foreach ($entry in $newPathEntries) {
            if ($userPathItems -notcontains $entry) {
                $userPathItems += $entry
                $changed = $true
            }
        }
        if ($changed) {
            if (-not $PrivateHomeRelocation) { [Environment]::SetEnvironmentVariable("Path", ($userPathItems -join ";"), "User") }
        }

        $version = & $gitExe --version
        Write-Success "Git $version installed to $gitDir (portable, user-scoped)"
        Set-GitBashEnvVar
        if (-not $script:GitBashPath) {
            throw "PortableGit extraction did not produce a usable bash.exe"
        }
        if (-not (Test-GitBashCompatibility -BashPath $script:GitBashPath)) {
            if (Test-MandatoryAslrEnabled) {
                $script:GitInstallFailureReason = New-GitBashAslrFailureReason -BashPath $script:GitBashPath
            } else {
                $probeDetail = if ($script:GitBashProbeOutput) { " Probe output: $script:GitBashProbeOutput" } else { "" }
                $script:GitInstallFailureReason = "Git Bash at $script:GitBashPath exists but cannot launch required MSYS programs.$probeDetail"
            }
            throw $script:GitInstallFailureReason
        }
        Write-Success "Git Bash can launch MSYS programs"
        return $true
    } catch {
        if ($script:GitInstallFailureReason) {
            Write-Err $script:GitInstallFailureReason
            return $false
        }
        Write-Err "Could not install portable Git: $_"
        Write-Info ""
        Write-Info "Fallback: install Git manually from https://git-scm.com/download/win"
        Write-Info "then re-run this installer.  Youtab needs Git Bash on Windows to run"
        Write-Info "shell commands (same as Claude Code and other coding agents)."
        return $false
    }
}

function Set-GitBashEnvVar {
    <#
    .SYNOPSIS
    Locate ``bash.exe`` from an already-installed Git and persist the path in
    ``YOUTAB_AGENT_GIT_BASH_PATH`` (User env scope) so Youtab can find it even before
    PATH propagation completes in a newly-spawned shell.
    #>
    $script:GitBashPath = $null
    $candidates = @()

    # Our own portable Git install is ALWAYS checked first, so a broken
    # system Git doesn't hijack us.  If the user had a working system Git
    # we'd have returned early from Install-Git's fast path and never called
    # this with a system-Git-only installation anyway.
    #
    # Layouts:
    #   PortableGit (our default): $YoutabHome\git\bin\bash.exe
    #   MinGit (32-bit fallback):  $YoutabHome\git\usr\bin\bash.exe
    $candidates += "$YoutabHome\git\bin\bash.exe"       # PortableGit layout (primary)
    $candidates += "$YoutabHome\git\usr\bin\bash.exe"   # MinGit / PortableGit usr\bin fallback

    # git.exe on PATH can tell us where the install root is
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        $gitExe = $gitCmd.Source
        # Git for Windows (full installer): <root>\cmd\git.exe + <root>\bin\bash.exe
        # MinGit:                           <root>\cmd\git.exe + <root>\usr\bin\bash.exe
        $gitRoot = Split-Path (Split-Path $gitExe -Parent) -Parent
        $candidates += "$gitRoot\bin\bash.exe"
        $candidates += "$gitRoot\usr\bin\bash.exe"
    }

    # Standard system install locations as a final fallback.  Note:
    # ProgramFiles(x86) can't be referenced via ${env:...} string interpolation
    # because of the parens -- use [Environment]::GetEnvironmentVariable().
    $candidates += "${env:ProgramFiles}\Git\bin\bash.exe"
    $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if ($pf86) { $candidates += "$pf86\Git\bin\bash.exe" }
    $candidates += "${env:LocalAppData}\Programs\Git\bin\bash.exe"

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            [Environment]::SetEnvironmentVariable("YOUTAB_AGENT_GIT_BASH_PATH", $candidate, "User")
            $env:YOUTAB_AGENT_GIT_BASH_PATH = $candidate
            $script:GitBashPath = $candidate
            Write-Info "Set YOUTAB_AGENT_GIT_BASH_PATH=$candidate"
            return
        }
    }

    Write-Warn "Could not locate bash.exe -- Youtab may not find Git Bash."
    Write-Info "If needed, set YOUTAB_AGENT_GIT_BASH_PATH manually to your bash.exe path."
}

# Electron 42 and electron-rebuild require Node >=22.12. Although Vite
# also supports Node 20.19, that does not satisfy the complete desktop build.
# Keep installer admission consistent with the package engines.
function Test-NodeVersionOk {
    param([string]$Version)
    try {
        $v = [version]($Version -replace '^v', '' -replace '-.*$', '')
    } catch {
        return $false
    }

    if ($v.Major -ge 22 -and ($v.Major -gt 22 -or $v.Minor -ge 12)) { return $true }
    return $false
}

# Bound into the reviewed release source. Do not resolve latest-v22.x at install
# time: an index response and a ZIP from the same compromised source would not
# establish the bytes that were approved for this release.
function Get-PinnedNodeArchive {
    param([string]$Arch)
    switch ($Arch) {
        'x64' { return @{ Version = '22.23.3'; Sha256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'; ExeSha256 = '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e' } }
        'arm64' { return @{ Version = '22.23.3'; Sha256 = '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535'; ExeSha256 = 'b5a3165ec6f24c0b1fe2a10fed58e03f6c1d7d141beb3b225ff030ceac6c5eb5' } }
        default { throw "No approved portable Node.js archive for Windows $Arch" }
    }
}

function Test-Node {
    Write-Info "Checking Node.js (for browser tools)..."
    $script:HasNode = $false

    if (-not $PrivateHomeRelocation -and (Get-Command node -ErrorAction SilentlyContinue)) {
        $version = node --version
        if (Test-NodeVersionOk $version) {
            Ensure-NodeExeOnPath | Out-Null
            Write-Success "Node.js $version found"
            $script:HasNode = $true
            return $true
        }
        Write-Warn "Node.js $version is too old for the desktop build (need >=22.12)"
    }

    # Prefer a Youtab-managed Node from a previous run over a too-old system one.
    $arch = Get-WindowsArch
    $pin = Get-PinnedNodeArchive -Arch $arch
    $managedNode = "$YoutabHome\node\node.exe"
    if ((Test-Path -LiteralPath $managedNode -PathType Leaf) -and
        (Get-FileHash -LiteralPath $managedNode -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $pin.ExeSha256 -and
        (Test-NodeVersionOk (& $managedNode --version))) {
        $version = & $managedNode --version
        $env:Path = "$YoutabHome\node;$env:Path"
        Write-Success "Node.js $version found (Youtab-managed)"
        $script:HasNode = $true
        return $true
    }

    Write-Info "Installing Youtab-managed Node.js $NodeVersion LTS..."

    # Try the portable-zip path FIRST -- no UAC, no admin, no winget MSI.
    # winget install OpenJS.NodeJS.LTS triggers a system-wide MSI install
    # which prompts UAC (the dialog often appears minimized in the taskbar
    # and the install silently waits for consent, looking like a hang).
    # The portable zip path drops node.exe + npm into $YoutabHome\node\
    # which is user-scoped and identical to how Install-Git handles
    # PortableGit.  Same UX guarantee: works on locked-down enterprise
    # machines with no admin rights.
    Write-Info "Downloading portable Node.js $NodeVersion to $YoutabHome\node\ ..."
    Write-Info "(no admin rights required; isolated from any system Node install)"
    try {
        $zipName = "node-v$($pin.Version)-win-${arch}.zip"
        $downloadUrl = "https://nodejs.org/dist/v$($pin.Version)/$zipName"
        $tmpDir = Join-Path $env:TEMP ("youtab-node-" + [guid]::NewGuid().ToString('N'))
        $tmpZip = Join-Path $tmpDir $zipName
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip -UseBasicParsing
            if ((Get-FileHash -LiteralPath $tmpZip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.Sha256) {
                throw 'Portable Node.js archive SHA-256 does not match the release pin'
            }
            $extractDir = Join-Path $tmpDir 'extract'
            Expand-Archive -Path $tmpZip -DestinationPath $extractDir -Force

            $extractedDir = Join-Path $extractDir ("node-v$($pin.Version)-win-${arch}")
            $candidateNode = Join-Path $extractedDir 'node.exe'
            if (Test-Path -LiteralPath $candidateNode -PathType Leaf) {
                if ((Get-FileHash -LiteralPath $candidateNode -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.ExeSha256) {
                    throw 'Portable Node.js executable SHA-256 does not match the release pin'
                }
                # Probe the verified, staged executable before touching an
                # existing managed tree. A bad version must leave it intact.
                $version = & $candidateNode --version
                if ($LASTEXITCODE -ne 0 -or $version -cne "v$($pin.Version)" -or -not (Test-NodeVersionOk $version)) {
                    throw "Downloaded Node.js $version does not satisfy the desktop build floor (>=22.12)."
                }
                $nodeDir = Join-Path $YoutabHome 'node'
                $backupDir = Join-Path $YoutabHome ('node-previous-' + [guid]::NewGuid().ToString('N'))
                $hadNode = Test-Path -LiteralPath $nodeDir
                if ($hadNode) { Move-Item -LiteralPath $nodeDir -Destination $backupDir }
                try {
                    Move-Item -LiteralPath $extractedDir -Destination $nodeDir
                    $installedVersion = & (Join-Path $nodeDir 'node.exe') --version
                    if ($LASTEXITCODE -ne 0 -or $installedVersion -cne "v$($pin.Version)") {
                        throw 'Promoted portable Node.js did not match the approved version'
                    }
                } catch {
                    if (Test-Path -LiteralPath $nodeDir) { Remove-Item -LiteralPath $nodeDir -Recurse -Force }
                    if ($hadNode -and (Test-Path -LiteralPath $backupDir)) {
                        Move-Item -LiteralPath $backupDir -Destination $nodeDir
                    }
                    throw
                }
                if ($hadNode) { Remove-Item -LiteralPath $backupDir -Recurse -Force }

                # Session PATH so the rest of this run sees node/npm.
                $env:Path = "$nodeDir;$env:Path"

                # Customer Setup publishes user discovery only after product
                # health and transaction commit. Later stages re-probe this
                # managed Node path in their own process.
                if (-not $PrivateHomeRelocation -and -not $script:CustomerReleaseMode) {
                    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
                    $userPathItems = if ($userPath) { $userPath -split ";" } else { @() }
                    if ($userPathItems -notcontains $nodeDir) {
                        $userPathItems += $nodeDir
                        [Environment]::SetEnvironmentVariable("Path", ($userPathItems -join ";"), "User")
                    }
                }

                Write-Success "Node.js $version installed to $YoutabHome\node\ (portable, user-scoped)"
                $script:HasNode = $true

                return $true
            }
            throw 'Portable Node.js archive is missing the pinned executable'
        } finally {
            Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warn "Portable Node.js download failed: $_"
    }

    # Fallback: try winget (used to be primary, demoted because the MSI
    # install triggers a UAC prompt that frequently appears minimized in
    # the taskbar -- looks like a hang to users on stock Windows).
    # Kept for environments where the portable download fails (proxy,
    # locked firewall, etc.) but the user is willing to consent to UAC.
    if ($PrivateHomeRelocation) { throw 'Private managed Node download failed; system fallback is disabled' }
    if ($script:CustomerReleaseMode) {
        Write-Warn 'Portable Node.js is unavailable; customer Setup will not run a system package manager or request administrator access.'
        return $false
    }

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Falling back to winget (may prompt UAC -- check your taskbar for a flashing icon)..."
        # Capture EAP outside the try block so the catch's restore call always
        # has a meaningful value (see Install-Uv for the full rationale).
        $prevEAP = $ErrorActionPreference
        try {
            # Relax EAP=Stop so stderr lines from winget don't get wrapped
            # as ErrorRecords and short-circuit the 2>&1 pipe before we can
            # check the post-condition.  See the long comment in Install-Uv
            # for the same pattern.
            $ErrorActionPreference = "Continue"
            # On ARM64, force winget to fetch the ARM64 installer.  Without
            # the explicit override, winget on WoW64 sometimes still resolves
            # to x64 manifests, leaving us with an emulated Node toolchain
            # even after a "successful" install.  The OpenJS manifest does
            # publish an arm64 installer, so this is safe.
            $wingetArgs = @(
                'install','OpenJS.NodeJS.LTS','--silent',
                '--accept-package-agreements','--accept-source-agreements'
            )
            if ((Get-WindowsArch) -eq 'arm64') {
                $wingetArgs += @('--architecture','arm64')
            }
            winget @wingetArgs 2>&1 | Out-Null
            $ErrorActionPreference = $prevEAP
            # Refresh PATH
            $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
            if (Get-Command node -ErrorAction SilentlyContinue) {
                $version = node --version
                if ($LASTEXITCODE -eq 0 -and (Test-NodeVersionOk $version)) {
                    Write-Success "Node.js $version installed via winget"
                    $script:HasNode = $true
                    return $true
                }
                Write-Warn "Node.js $version resolved after winget does not satisfy the desktop build floor (>=22.12)."
            }
        } catch {
            if ($prevEAP) { $ErrorActionPreference = $prevEAP }
        }
    }


    Write-Info "Install manually: https://nodejs.org/en/download/"
    $script:HasNode = $false
    return $true
}

function Update-ProcessPathForPackages {
    # Make freshly-installed shims (rg.exe, ffmpeg.exe) visible to Get-Command in
    # THIS process without spawning a new shell, by folding the persisted
    # User+Machine hives plus winget's alias-shim directory into $env:Path.
    # Called after every package-manager attempt (winget/choco/scoop): previously
    # PATH was only refreshed inside the winget branch, so a successful
    # choco/scoop fallback -- or any install on a box without winget -- could be
    # misreported as "not installed".
    #
    # MERGE rather than overwrite: start from the existing process PATH so any
    # process-only entries added earlier in this installer run survive, then
    # APPEND hive/winget-Links entries not already present (case-insensitive,
    # order-preserving dedupe). A wholesale replace would silently drop those
    # process-only entries.
    $candidates = @()
    $candidates += $env:Path
    $candidates += [Environment]::GetEnvironmentVariable("Path", "User")
    $candidates += [Environment]::GetEnvironmentVariable("Path", "Machine")
    $wingetLinks = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    if (Test-Path $wingetLinks) {
        $candidates += $wingetLinks
    }
    $seen = New-Object System.Collections.Generic.HashSet[string] ([StringComparer]::OrdinalIgnoreCase)
    $ordered = New-Object System.Collections.Generic.List[string]
    foreach ($chunk in $candidates) {
        if ([string]::IsNullOrEmpty($chunk)) { continue }
        foreach ($entry in $chunk.Split(';')) {
            $trimmed = $entry.Trim()
            if ($trimmed -and $seen.Add($trimmed)) {
                $ordered.Add($trimmed)
            }
        }
    }
    $env:Path = [string]::Join(';', $ordered)
}

function Install-SystemPackages {
    $script:HasRipgrep = $false
    $script:HasFfmpeg = $false
    $needRipgrep = $false
    $needFfmpeg = $false

    Write-Info "Checking ripgrep (fast file search)..."
    if (Get-Command rg -ErrorAction SilentlyContinue) {
        $version = rg --version | Select-Object -First 1
        Write-Success "$version found"
        $script:HasRipgrep = $true
    } else {
        $needRipgrep = $true
    }

    Write-Info "Checking ffmpeg (TTS voice messages)..."
    if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
        Write-Success "ffmpeg found"
        $script:HasFfmpeg = $true
    } else {
        $needFfmpeg = $true
    }

    if (-not $needRipgrep -and -not $needFfmpeg) { return }

    if ($script:CustomerReleaseMode) {
        # The common Setup installs its managed codec in Stage-NodeDeps. These
        # optional system tools must never start a package manager or UAC.
        if ($needRipgrep) { Write-Warn 'System ripgrep is unavailable; file search will use the bundled or fallback implementation.' }
        if ($needFfmpeg) { Write-Info 'The customer codec is installed by the managed dependency stage.' }
        $script:_StageSkippedReason = 'Optional system packages are not installed by customer Setup'
        return
    }

    # Build description and package lists for each package manager
    $descParts = @()
    $wingetPkgs = @()
    $chocoPkgs = @()
    $scoopPkgs = @()

    if ($needRipgrep) {
        $descParts += "ripgrep for faster file search"
        $wingetPkgs += "BurntSushi.ripgrep.MSVC"
        $chocoPkgs += "ripgrep"
        $scoopPkgs += "ripgrep"
    }
    if ($needFfmpeg) {
        $descParts += "ffmpeg for TTS voice messages"
        $wingetPkgs += "Gyan.FFmpeg"
        $chocoPkgs += "ffmpeg"
        $scoopPkgs += "ffmpeg"
    }

    $description = $descParts -join " and "
    $hasWinget = Get-Command winget -ErrorAction SilentlyContinue
    $hasChoco = Get-Command choco -ErrorAction SilentlyContinue
    $hasScoop = Get-Command scoop -ErrorAction SilentlyContinue

    # Try winget first (most common on modern Windows)
    if ($hasWinget) {
        Write-Info "Installing $description via winget..."
        # Per-package log paths -- key the lookup by package id so we can
        # decide AFTER the post-install Get-Command check whether to keep
        # the log (still missing -> keep as breadcrumb) or delete it (now
        # present -> happy path, no clutter).
        $pkgLogs = @{}
        foreach ($pkg in $wingetPkgs) {
            $log = "$env:TEMP\youtab-winget-$($pkg -replace '[^A-Za-z0-9]','_')-$(Get-Random).log"
            $pkgLogs[$pkg] = $log
            # --source winget pins us to the github-backed source.  Without this,
            # a broken msstore source (cert validation failures like 0x8a15005e
            # are common on Windows-on-ARM and some corporate networks) makes
            # winget bail with "please specify --source" *before* attempting any
            # install -- and it exits 0, so the surrounding try/catch never fires.
            # We don't ship anything from msstore, so pinning is safe.
            try {
                $output = winget install --exact --id $pkg --source winget --silent `
                    --accept-package-agreements --accept-source-agreements 2>&1
                $code = $LASTEXITCODE
                $output | Out-File -FilePath $log -Encoding utf8
                "winget exit: $code" | Out-File -FilePath $log -Encoding utf8 -Append
                # 0x8A15002B (-1978335189) = APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE.
                # winget treats `install` on a package it already has registered as
                # an *upgrade*, finds no newer version, and bails with this code --
                # even when the binary is gone from disk/PATH (stale registration,
                # files removed outside winget, or a missing alias shim). We KNOW the
                # command was missing (that's why we're here), so a plain install
                # dead-ends forever. Force a reinstall to repair the registration so
                # the shim reappears.
                if ($code -eq -1978335189) {
                    "-> already-installed/no-upgrade; retrying with --force" | Out-File -FilePath $log -Encoding utf8 -Append
                    $output = winget install --exact --id $pkg --source winget --silent --force `
                        --accept-package-agreements --accept-source-agreements 2>&1
                    $output | Out-File -FilePath $log -Encoding utf8 -Append
                    "winget exit (force): $LASTEXITCODE" | Out-File -FilePath $log -Encoding utf8 -Append
                }
            } catch {
                $_ | Out-File -FilePath $log -Encoding utf8 -Append
                "winget exit: <exception>" | Out-File -FilePath $log -Encoding utf8 -Append
            }
        }
        # Refresh PATH so packages winget exposed via "command line aliases" in
        # %LOCALAPPDATA%\Microsoft\WinGet\Links (added to PATH only in
        # newly-spawned shells, not this process) are visible to Get-Command below.
        Update-ProcessPathForPackages
        if ($needRipgrep -and (Get-Command rg -ErrorAction SilentlyContinue)) {
            Write-Success "ripgrep installed"
            $script:HasRipgrep = $true
            $needRipgrep = $false
            Remove-Item -Path $pkgLogs["BurntSushi.ripgrep.MSVC"] -ErrorAction SilentlyContinue
        } elseif ($pkgLogs.ContainsKey("BurntSushi.ripgrep.MSVC")) {
            Write-Warn "winget could not install ripgrep; details: $($pkgLogs['BurntSushi.ripgrep.MSVC'])"
        }
        if ($needFfmpeg -and (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
            Write-Success "ffmpeg installed"
            $script:HasFfmpeg = $true
            $needFfmpeg = $false
            Remove-Item -Path $pkgLogs["Gyan.FFmpeg"] -ErrorAction SilentlyContinue
        } elseif ($pkgLogs.ContainsKey("Gyan.FFmpeg")) {
            Write-Warn "winget could not install ffmpeg; details: $($pkgLogs['Gyan.FFmpeg'])"
        }
        if (-not $needRipgrep -and -not $needFfmpeg) { return }
    }

    # Fallback: choco
    if ($hasChoco -and ($needRipgrep -or $needFfmpeg)) {
        Write-Info "Trying Chocolatey..."
        foreach ($pkg in $chocoPkgs) {
            try { choco install $pkg -y 2>&1 | Out-Null } catch { }
        }
        Update-ProcessPathForPackages
        if ($needRipgrep -and (Get-Command rg -ErrorAction SilentlyContinue)) {
            Write-Success "ripgrep installed via chocolatey"
            $script:HasRipgrep = $true
            $needRipgrep = $false
        }
        if ($needFfmpeg -and (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
            Write-Success "ffmpeg installed via chocolatey"
            $script:HasFfmpeg = $true
            $needFfmpeg = $false
        }
    }

    # Fallback: scoop
    if ($hasScoop -and ($needRipgrep -or $needFfmpeg)) {
        Write-Info "Trying Scoop..."
        foreach ($pkg in $scoopPkgs) {
            try { scoop install $pkg 2>&1 | Out-Null } catch { }
        }
        Update-ProcessPathForPackages
        if ($needRipgrep -and (Get-Command rg -ErrorAction SilentlyContinue)) {
            Write-Success "ripgrep installed via scoop"
            $script:HasRipgrep = $true
            $needRipgrep = $false
        }
        if ($needFfmpeg -and (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
            Write-Success "ffmpeg installed via scoop"
            $script:HasFfmpeg = $true
            $needFfmpeg = $false
        }
    }

    # Show manual instructions for anything still missing
    if ($needRipgrep) {
        Write-Warn "ripgrep not installed (file search will use findstr fallback)"
        Write-Info "  winget install BurntSushi.ripgrep.MSVC"
    }
    if ($needFfmpeg) {
        Write-Warn "ffmpeg not installed (TTS voice messages will be limited)"
        Write-Info "  winget install Gyan.FFmpeg"
    }
}

# ============================================================================
# Installation
# ============================================================================

function Assert-CurrentRuntimeBranding {
    param([string]$Root)
    $block = [char]0x2588
    $corner = [char]0x2557
    $retiredPrefix = ('{0}{1}  {0}{1}{2}{1}{3}{1} {4}{1}' -f
        ($block.ToString() * 2), $corner, ($block.ToString() * 7),
        ($block.ToString() * 6), ($block.ToString() * 3))
    $suffixes = @('.py', '.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json', '.yaml', '.yml', '.toml', '.txt', '.svg')
    $excluded = @('.git', 'node_modules', 'venv', '.venv', '__pycache__', 'tests', '__tests__', 'e2e', 'docs', '_evidence', '_backups')
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
      foreach ($source in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
        if ($source.PSIsContainer) {
            if ($source.Name -notin $excluded -and
                -not ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                $pending.Push($source.FullName)
            }
            continue
        }
        if ($source.Extension.ToLowerInvariant() -notin $suffixes) { continue }
        $path = $source.FullName
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
            $text = $text.Replace('\u2588', $block.ToString()).Replace('\u2557', $corner.ToString())
            if ($text.Contains($retiredPrefix)) {
                throw 'Runtime contains retired CLI banner; installation/update refused'
            }
        }
      }
    }
}

function Assert-CustomerImage {
    param([string]$Root, [string]$SourceSha, $ReleaseManifest)
    $relativeManifest = 'customer-image\windows-x64\manifest.json'
    $path = Join-Path $Root $relativeManifest
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
        ([IO.FileInfo]::new($path)).Length -gt 8388608 -or
        -not ($ReleaseManifest.customer_image_manifest_sha256 -is [string]) -or
        $ReleaseManifest.customer_image_manifest_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        (Get-FileSha256 -Path $path) -cne $ReleaseManifest.customer_image_manifest_sha256) {
        throw 'Customer image manifest is missing or differs from the pinned release'
    }
    $image = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($image.schema_version -ne 1 -or $image.platform -cne 'windows' -or
        $image.architecture -cne 'x64' -or $image.source_sha -cne $SourceSha -or
        $image.source_qualified -ne $true -or
        $image.producer_receipt_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $image.lock_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $image.lock_sha256 -cne (Get-FileSha256 -Path (Join-Path $Root 'package-lock.json')) -or
        (@($image.components) -join ',') -cne 'browser,dashboard,desktop,node,tui' -or
        -not ($ReleaseManifest.customer_image_file_count -is [ValueType]) -or
        -not ($ReleaseManifest.customer_image_total_size -is [ValueType]) -or
        $image.file_count -ne $ReleaseManifest.customer_image_file_count -or
        $image.total_size -ne $ReleaseManifest.customer_image_total_size -or
        $image.file_count -lt 1 -or $image.file_count -gt 25000 -or
        $image.total_size -lt 1 -or $image.total_size -gt 3221225472) {
        throw 'Customer image identity or inventory differs from the pinned release'
    }
    $records = @($image.files)
    if ($records.Count -ne $image.file_count) { throw 'Customer image file count differs' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $records) {
        $name = $entry.path
        if (-not ($name -is [string]) -or
            ($name -cne 'producer-receipt.json' -and
                $name -notmatch '^(apps/desktop/release/win-unpacked/|node/|browser/|ui-tui/dist/|youtab_agent_cli/web_dist/)') -or
            $name -match '[<>:"\\|?*\x00-\x1f]' -or
            $name -match '(^|/)(\.|\.\.|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(/|\.|$)' -or
            -not $seen.Add($name) -or
            -not ($entry.size -is [ValueType]) -or $entry.size -lt 0 -or
            $entry.size -gt 805306368 -or
            -not ($entry.sha256 -is [string]) -or $entry.sha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Customer image contains an unsafe or duplicate file record'
        }
        if ($entry.size -eq 0 -and -not ($name -match '^browser/ms-playwright/.+/(DEPENDENCIES_VALIDATED|INSTALLATION_COMPLETE)$')) {
            throw 'Customer image contains an unexpected empty file'
        }
        $relative = $name.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $file = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
            [IO.File]::GetAttributes($file).HasFlag([IO.FileAttributes]::ReparsePoint) -or
            ([IO.FileInfo]::new($file)).Length -ne $entry.size -or
            (Get-FileSha256 -Path $file) -cne $entry.sha256) {
            throw "Customer image file is missing or differs from the release: $name"
        }
        $total += [long]$entry.size
        if ($total -gt 3221225472) { throw 'Customer image exceeds the extraction size bound' }
    }
    if ($total -ne [long]$image.total_size) { throw 'Customer image total size differs' }
    foreach ($required in @(
        'apps/desktop/release/win-unpacked/Youtab.exe',
        'apps/desktop/release/win-unpacked/resources/app.asar',
        'apps/desktop/release/win-unpacked/resources/install-stamp.json',
        'apps/desktop/release/win-unpacked/resources/app.asar.unpacked/dist/native/setup_lease.node',
        'node/node.exe', 'browser/agent-browser.exe', 'browser/ms-playwright/browsers.json',
        'ui-tui/dist/entry.js', 'youtab_agent_cli/web_dist/index.html', 'producer-receipt.json')) {
        if (-not $seen.Contains($required)) { throw "Customer image lacks required file: $required" }
    }
    $receipt = @($records | Where-Object { $_.path -ceq 'producer-receipt.json' })
    if ($receipt.Count -ne 1 -or $receipt[0].sha256 -cne $image.producer_receipt_sha256) {
        throw 'Customer image producer receipt differs from the pinned image'
    }
    Write-Success 'Verified complete prebuilt Windows customer image'
}

function Assert-CustomerPrerequisites {
    param([string]$Root, [string]$SourceSha, $ReleaseManifest = $null)
    $base = Join-Path $Root 'customer-prerequisites\windows-x64'
    $path = Join-Path $base 'manifest.json'
    $wheelPinsPath = Join-Path $Root 'config\windows-customer-wheelhouse.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
        -not (Test-Path -LiteralPath $wheelPinsPath -PathType Leaf)) {
        throw 'Customer Runtime lacks its bundled, reviewed Windows prerequisites'
    }
    $raw = [IO.File]::ReadAllBytes($path)
    if ($raw.Length -gt 49152 -or $raw.Length -lt 100) { throw 'Customer prerequisite manifest is outside bounds' }
    $manifestHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ReleaseManifest -and ($ReleaseManifest.customer_prerequisites_manifest_sha256 -cne $manifestHash -or
        $ReleaseManifest.customer_prerequisites_file_count -lt 100 -or
        $ReleaseManifest.customer_prerequisites_file_count -gt 150)) {
        throw 'Customer prerequisite manifest differs from the pinned release'
    }
    $inventory = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json
    $pins = [IO.File]::ReadAllText($wheelPinsPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $lock = [IO.File]::ReadAllText((Join-Path $Root 'config\windows-private-home-prerequisites.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($inventory.schema -ne 1 -or $inventory.platform -cne 'windows' -or
        $inventory.arch -cne 'x64' -or $inventory.source_sha -cne $SourceSha -or
        $inventory.uv_lock_sha256 -cne (Get-FileSha256 -Path (Join-Path $Root 'uv.lock')) -or
        $inventory.uv_lock_sha256 -cne $pins.uv_lock_sha256 -or
        $pins.wheel_count -ne 132 -or @($inventory.files).Count -ne ($pins.wheel_count + 3) -or
        $inventory.file_count -ne @($inventory.files).Count -or
        $inventory.total_size -gt 335544320) {
        throw 'Customer prerequisite identity or dependency closure differs'
    }
    if ($ReleaseManifest -and ($ReleaseManifest.customer_prerequisites_file_count -ne $inventory.file_count -or
        $ReleaseManifest.customer_prerequisites_total_size -ne $inventory.total_size)) {
        throw 'Customer prerequisite inventory differs from release'
    }
    $expected = @{}
    foreach ($pin in @($pins.files)) { $expected['wheelhouse/' + $pin.name] = $pin.sha256 }
    $expected['uv.zip'] = $lock.uv.sha256
    $expected['python.tar.gz'] = $lock.python.sha256
    $expected['requirements.txt'] = $pins.requirements_sha256
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in @($inventory.files)) {
        $name = $entry.path
        if (-not ($name -is [string]) -or
            $name -cnotmatch '^(uv\.zip|python\.tar\.gz|requirements\.txt|wheelhouse/[A-Za-z0-9_.+\-]+\.whl)$' -or
            -not $seen.Add($name) -or -not $expected.ContainsKey($name) -or
            $entry.sha256 -cne $expected[$name] -or $entry.size -le 0) {
            throw 'Customer prerequisite manifest has an unsafe or unreviewed member'
        }
        $file = Join-Path $base ($name.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -ne $entry.size -or (Get-FileSha256 -Path $file) -cne $entry.sha256) {
            throw "Customer prerequisite differs from reviewed manifest: $name"
        }
        $total += [long]$item.Length
    }
    if ($seen.Count -ne $expected.Count -or $total -ne [long]$inventory.total_size) {
        throw 'Customer prerequisite inventory is incomplete'
    }
    return $base
}

function Assert-CustomerPrebuiltFile {
    param([string]$RelativePath)
    $manifestPath = Join-Path $InstallDir 'customer-image\windows-x64\manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Common Runtime lacks the complete prebuilt customer image manifest'
    }
    $image = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($image.source_sha -cne $Commit -or
        (@($image.components) -join ',') -cne 'browser,dashboard,desktop,node,tui') {
        throw 'Prebuilt customer image identity differs from the requested release'
    }
    $entry = @($image.files | Where-Object { $_.path -ceq $RelativePath })
    if ($entry.Count -ne 1 -or $entry[0].sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw "Prebuilt customer image lacks required file: $RelativePath"
    }
    $file = Join-Path $InstallDir ($RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
        ([IO.FileInfo]::new($file)).Length -ne $entry[0].size -or
        (Get-FileSha256 -Path $file) -cne $entry[0].sha256) {
        throw "Prebuilt customer image file differs from manifest: $RelativePath"
    }
    return $file
}

function Install-RepositoryFromArtifact {
    # The GUI owns promotion and rollback. This stage only creates a verified
    # sibling tree; it must never modify the current installation.
    $manifestUrl = "$ReleaseBaseUrl/$Commit/manifest.json"
    $expectedArtifactUrl = "$ReleaseBaseUrl/$Commit/youtab-runtime-$Commit.zip"
    $expectedScriptUrl = "$ReleaseBaseUrl/$Commit/install-$Commit.ps1"
    $manifest = Invoke-RestMethod -Uri $manifestUrl -MaximumRedirection 0
    if ($null -eq $manifest -or
        -not ($manifest.source_sha -is [string]) -or
        -not ($manifest.artifact_url -is [string]) -or
        -not ($manifest.install_script_url -is [string]) -or
        -not ($manifest.sha256 -is [string]) -or
        -not ($manifest.install_script_sha256 -is [string]) -or
        $manifest.source_sha -cne $Commit -or
        $manifest.artifact_url -cne $expectedArtifactUrl -or
        $manifest.install_script_url -cne $expectedScriptUrl -or
        $manifest.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $manifest.install_script_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $manifest.platform -cne 'windows' -or
        $manifest.architecture -cne 'x64' -or
        $manifest.format -cne 'zip' -or
        -not ($manifest.setup_source_sha -is [string]) -or
        -not ($manifest.setup_url -is [string]) -or
        $manifest.setup_source_sha -cne $Commit -or
        $manifest.setup_url -cne "$ReleaseBaseUrl/$Commit/Youtab-Setup-$Commit.exe" -or
        -not ($manifest.setup_sha256 -is [string]) -or
        $manifest.setup_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        -not (($manifest.setup_size -is [int]) -or ($manifest.setup_size -is [long])) -or
        $manifest.setup_size -le 0 -or $manifest.setup_size -gt 268435456 -or
        -not (($manifest.updater_protocol -is [int]) -or ($manifest.updater_protocol -is [long])) -or
        $manifest.updater_protocol -ne 1 -or
        -not (($manifest.update_coordination_protocol -is [int]) -or ($manifest.update_coordination_protocol -is [long])) -or
        $manifest.update_coordination_protocol -ne 1 -or
        -not ($manifest.version -is [string]) -or
        [string]::IsNullOrWhiteSpace($manifest.version) -or
        -not ($manifest.created_at -is [string]) -or
        $manifest.created_at -notmatch 'Z$' -or
        -not (($manifest.release_sequence -is [int]) -or ($manifest.release_sequence -is [long])) -or
        $manifest.release_sequence -le 0) {
        throw "Release manifest does not match the pinned Windows artifact contract"
    }

    $installPath = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/')
    $stageDir = "$installPath.new-$([guid]::NewGuid().ToString('N'))"
    $zipPath = "$stageDir.zip"
    $rootPrefix = "youtab-runtime-$Commit/"
    $stageCreated = $false
    try {
        New-Item -ItemType Directory -Path $stageDir -ErrorAction Stop | Out-Null
        $stageCreated = $true
        Invoke-WebRequest -Uri $expectedArtifactUrl -OutFile $zipPath -UseBasicParsing -MaximumRedirection 0
        $actualHash = Get-FileSha256 -Path $zipPath
        if ($actualHash -cne $manifest.sha256) {
            throw "Runtime artifact SHA256 does not match the pinned manifest"
        }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        try {
            $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
        } catch {
            throw "Runtime artifact archive is malformed"
        }
        try {
            $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
            if ($archive.Entries.Count -gt 100000) { throw "Runtime artifact has too many entries" }
            [long]$expandedBytes = 0
            foreach ($entry in $archive.Entries) {
                $expandedBytes += $entry.Length
                if ($expandedBytes -gt 4294967296) { throw "Runtime artifact exceeds the extraction size limit" }
                $name = $entry.FullName
                if (-not $name.StartsWith($rootPrefix, [StringComparison]::Ordinal)) {
                    throw "Runtime artifact contains an unexpected archive root"
                }
                if ($name -match '[<>:"\\|?*\x00-\x1f]' -or $name.StartsWith('/')) {
                    throw "Runtime artifact contains an unsafe entry name"
                }
                $relative = $name.Substring($rootPrefix.Length)
                if (-not $relative) { continue }
                $segments = $relative.TrimEnd('/').Split('/')
                foreach ($segment in $segments) {
                    if (-not $segment -or $segment -eq '.' -or $segment -eq '..' -or
                        $segment.EndsWith('.') -or $segment.EndsWith(' ') -or
                        $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') {
                        throw "Runtime artifact contains an unsafe path segment"
                    }
                }
                if (-not $seen.Add($relative.TrimEnd('/'))) {
                    throw "Runtime artifact contains duplicate case-insensitive paths"
                }
                $attributes = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$entry.ExternalAttributes), 0)
                $mode = ($attributes -shr 16) -band 0xF000
                if ($mode -eq 0xA000 -or ($attributes -band 0x400) -ne 0) {
                    throw "Runtime artifact contains a symbolic link or reparse point"
                }
                $destination = [IO.Path]::GetFullPath((Join-Path $stageDir ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
                if (-not $destination.StartsWith("$stageDir$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Runtime artifact entry escapes the staging directory"
                }
                if ($name.EndsWith('/')) {
                    New-Item -ItemType Directory -Path $destination -Force | Out-Null
                } else {
                    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
                    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
                }
            }
        } finally {
            $archive.Dispose()
        }
        foreach ($required in @('scripts/install.ps1', 'pyproject.toml', 'apps/desktop/package.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $stageDir ($required.Replace('/', [IO.Path]::DirectorySeparatorChar))) -PathType Leaf)) {
                throw "Runtime artifact is missing required layout file: $required"
            }
        }
        Assert-CurrentRuntimeBranding -Root $stageDir
        $stagedScriptHash = Get-FileSha256 -Path (Join-Path $stageDir 'scripts/install.ps1')
        if ($stagedScriptHash -cne $manifest.install_script_sha256) {
            throw "Runtime artifact install script does not match the pinned manifest"
        }
        Assert-CustomerImage -Root $stageDir -SourceSha $Commit -ReleaseManifest $manifest
        Assert-CustomerPrerequisites -Root $stageDir -SourceSha $Commit -ReleaseManifest $manifest | Out-Null
        $script:_StageData = @{
            staged_install_dir = $stageDir
            source_sha = $Commit
            artifact_sha256 = $actualHash
            version = $manifest.version
            release_sequence = $manifest.release_sequence
            release_base_url = $ReleaseBaseUrl
            setup_source_sha = $manifest.setup_source_sha
            setup_sha256 = $manifest.setup_sha256
            setup_size = $manifest.setup_size
            update_coordination_protocol = $manifest.update_coordination_protocol
        }
        Write-Success "Verified Runtime artifact staged for Setup promotion"
    } catch {
        if ($stageCreated) { Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
        throw
    } finally {
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    }
}

function Install-Repository {
    if ($script:CustomerReleaseMode) {
        Install-RepositoryFromArtifact
        return
    }
    Write-Info "Installing to $InstallDir..."

    $didUpdate = $false

    if (Test-Path $InstallDir) {
        # Test-Path "$InstallDir\.git" returns True when .git is a file OR a
        # directory OR a symlink OR a submodule-style gitfile -- and also when
        # it's a broken stub left over from a failed previous install (e.g.
        # a partial Remove-Item that couldn't delete a locked index.lock).
        # Validate the repo properly by asking git itself.  Three checks
        # belt-and-braces: rev-parse (work tree), git status, and a resolvable
        # HEAD (an initial commit).  If any fails the repo is broken and we
        # fall through to a fresh clone.
        $repoValid = $false
        if (Test-Path "$InstallDir\.git") {
            Push-Location $InstallDir
            try {
                # Reset $LASTEXITCODE before the probe so we don't pick up
                # a stale 0 from an earlier git call in this session.
                $global:LASTEXITCODE = 0
                $revParseOut = & git -c windows.appendAtomically=false rev-parse --is-inside-work-tree 2>&1
                $revParseOk = ($LASTEXITCODE -eq 0) -and ($revParseOut -match "true")

                $global:LASTEXITCODE = 0
                $null = & git -c windows.appendAtomically=false status --short 2>&1
                $statusOk = ($LASTEXITCODE -eq 0)

                # An interrupted previous clone leaves a repo with NO initial
                # commit. rev-parse/status still succeed there, but the update
                # path's `git stash` (and later `git checkout`) abort with
                # "You do not have the initial commit yet" and fail the install
                # (#40998). Require a resolvable HEAD so such partial checkouts
                # are treated as broken and re-cloned fresh below.
                $global:LASTEXITCODE = 0
                $null = & git -c windows.appendAtomically=false rev-parse --verify HEAD 2>&1
                $hasCommit = ($LASTEXITCODE -eq 0)

                if ($revParseOk -and $statusOk -and $hasCommit) {
                    $repoValid = $true
                }
            } catch {}
            Pop-Location
        }

        if ($repoValid) {
            Write-Info "Existing installation found, updating..."
            Push-Location $InstallDir
            # Wrap the entire fetch+checkout block in EAP=Continue so git's
            # routine stderr output (e.g. 'From <url>' info lines emitted by
            # `git fetch`) doesn't terminate the script under the global
            # EAP=Stop.  We rely on $LASTEXITCODE for actual failures.
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            $autostashRef = ""
            try {
                # This is a MANAGED checkout, not a repo the user edits. Git for
                # Windows defaults to core.autocrlf=true, which renormalizes the
                # repo's LF-only text files to CRLF in the working tree -- so
                # tracked files (.envrc, AGENTS.md, agent/*.py, workflows, ...)
                # show as locally modified even though nobody touched them. A
                # bare `git checkout` then aborts with "Your local changes would
                # be overwritten by checkout", which is exactly the failure GUI
                # users hit on update. Pin autocrlf=false so the dirt is never
                # created in the first place.
                git -c windows.appendAtomically=false config core.autocrlf false 2>$null
                Discard-LockfileChurn $InstallDir
                # Preserve any real local changes before the checkout instead of
                # discarding them with `reset --hard HEAD`. The old hard reset
                # silently destroyed agent-edited source on managed clones (the
                # #38542 data-loss class). Stash + restore mirrors install.sh:
                # nothing is lost, and a failed restore leaves the work in a
                # git stash for manual recovery. Untracked files are included so
                # agent-created dirs (e.g. tinker-atropos/) survive too.
                $statusOut = git -c windows.appendAtomically=false status --porcelain 2>$null
                if (-not [string]::IsNullOrWhiteSpace(($statusOut -join "`n"))) {
                    # A previously interrupted update can leave the index with
                    # unmerged entries. In that state `git stash` aborts with
                    # "could not write index" and the following `git checkout`
                    # aborts with "you need to resolve your current index first"
                    # -- the GUI "git checkout main failed (exit 1)" install
                    # failure. Clear the conflict markers with `git reset` first:
                    # working-tree changes are kept (and stashed just below); only
                    # the index conflict state is dropped. Mirrors the `youtab
                    # update` path (#4735).
                    $unmergedOut = git -c windows.appendAtomically=false ls-files --unmerged 2>$null
                    if (-not [string]::IsNullOrWhiteSpace(($unmergedOut -join "`n"))) {
                        Write-Info "Clearing unmerged index entries from a previous conflict..."
                        git -c windows.appendAtomically=false reset -q 2>$null
                    }
                    $stashName = "youtab-install-autostash-" + (Get-Date -Format "yyyyMMdd-HHmmss")
                    Write-Info "Local changes detected, stashing before update..."
                    git -c windows.appendAtomically=false stash push --include-untracked -m "$stashName"
                    if ($LASTEXITCODE -eq 0) { $autostashRef = "stash@{0}" }
                }
                git -c windows.appendAtomically=false fetch origin $Branch
                if ($LASTEXITCODE -ne 0) { throw "git fetch failed (exit $LASTEXITCODE)" }
                # Precedence: Commit > Tag > Branch.  Commit and Tag check
                # out as detached HEAD intentionally -- they're meant to be
                # reproducible pins, not branches the user pulls into.
                if ($Commit) {
                    # Make sure we have the commit locally (a tag-less commit
                    # SHA isn't always reachable from any one branch fetch).
                    git -c windows.appendAtomically=false fetch origin $Commit
                    # A commit pin must never move an existing install
                    # BACKWARDS. youtab-setup.exe bakes its build-time commit
                    # into the binary (BUILD_PIN_COMMIT) and passes it as
                    # -Commit on every install-mode run -- including the retry
                    # the desktop's "Update didn't finish" screen kicks off. An
                    # installer built months ago would otherwise rewind a
                    # current checkout to its build commit, leaving ancient
                    # code against a current venv (npm workspaces and Python
                    # deps that no longer match: the #74xxx report). Skip the
                    # pin when the target is already an ancestor of HEAD; a
                    # fresh clone has no such ancestry and pins normally.
                    $skipRollback = $false
                    if (-not $ForceCommit) {
                        git -c windows.appendAtomically=false merge-base --is-ancestor $Commit HEAD 2>$null
                        $isAncestor = ($LASTEXITCODE -eq 0)
                        $pinnedSha = (& git -c windows.appendAtomically=false rev-parse "$Commit^{commit}" 2>$null)
                        $headSha = (& git -c windows.appendAtomically=false rev-parse HEAD 2>$null)
                        $skipRollback = $isAncestor -and ($pinnedSha -ne $headSha)
                    }
                    if ($skipRollback) {
                        Write-Warn "Ignoring -Commit $Commit`: the checkout is already newer."
                        Write-Warn "Pinning to it would roll this install back. Pass -ForceCommit to override."
                    } else {
                        git -c windows.appendAtomically=false checkout --detach $Commit
                        if ($LASTEXITCODE -ne 0) { throw "git checkout $Commit failed (exit $LASTEXITCODE)" }
                    }
                } elseif ($Tag) {
                    git -c windows.appendAtomically=false fetch origin "refs/tags/${Tag}:refs/tags/${Tag}"
                    git -c windows.appendAtomically=false checkout --detach "refs/tags/$Tag"
                    if ($LASTEXITCODE -ne 0) { throw "git checkout tag $Tag failed (exit $LASTEXITCODE)" }
                } else {
                    git -c windows.appendAtomically=false checkout $Branch
                    if ($LASTEXITCODE -ne 0) { throw "git checkout $Branch failed (exit $LASTEXITCODE)" }
                    # Managed installs should follow origin/$Branch exactly. If
                    # the checkout has diverged (or has local-only commits),
                    # ff-only pull cannot succeed -- mirror ``youtab update`` and
                    # reset to the fetched remote so bootstrap/install can recover.
                    git -c windows.appendAtomically=false pull --ff-only origin $Branch
                    if ($LASTEXITCODE -ne 0) {
                        Write-Warn "Fast-forward not possible; resetting managed install to origin/$Branch..."
                        git -c windows.appendAtomically=false reset --hard "origin/$Branch"
                        if ($LASTEXITCODE -ne 0) { throw "git reset --hard origin/$Branch failed (exit $LASTEXITCODE)" }
                    }
                }

                if ($autostashRef) {
                    # Default to restoring so work is never silently dropped.
                    # Only prompt when we're certain a human can answer: an
                    # interactive session AND a real, non-redirected console on
                    # both stdin and stdout. The desktop "Update" button and
                    # bootstrap run the installer without a usable console -- in
                    # those cases Read-Host would hang or return empty, so we
                    # skip the prompt and just restore (the safe default).
                    $restoreNow = $true
                    $hasConsole = $false
                    try {
                        $hasConsole = (
                            [Environment]::UserInteractive `
                            -and (-not [Console]::IsInputRedirected) `
                            -and (-not [Console]::IsOutputRedirected) `
                            -and ($Host.Name -eq "ConsoleHost")
                        )
                    } catch { $hasConsole = $false }
                    if ($hasConsole) {
                        Write-Warn "Local changes were stashed before updating."
                        Write-Warn "Restoring them may reapply local customizations onto the updated codebase."
                        $restoreAnswer = Read-Host "Restore local changes now? [Y/n]"
                        if ($restoreAnswer -match '^(n|no)$') { $restoreNow = $false }
                    }

                    if ($restoreNow) {
                        Write-Info "Restoring local changes..."
                        $restoreOutput = @(git -c windows.appendAtomically=false stash apply $autostashRef 2>&1)
                        $restoreExit = $LASTEXITCODE
                        $conflictedFiles = @(
                            git -c windows.appendAtomically=false diff --name-only --diff-filter=U 2>$null
                        ) | Where-Object { $_ -and $_.ToString().Trim() }
                        if (($restoreExit -eq 0) -and ($conflictedFiles.Count -eq 0)) {
                            git -c windows.appendAtomically=false stash drop $autostashRef 2>$null
                            Write-Warn "Local changes were restored on top of the updated codebase."
                            Write-Warn "Review git diff / git status if Youtab behaves unexpectedly."
                        } else {
                            Write-Err "Update pulled new code, but restoring local changes hit conflicts."
                            foreach ($line in $restoreOutput) {
                                if ($line -and $line.ToString().Trim()) {
                                    Write-Host $line
                                }
                            }
                            if ($conflictedFiles.Count -gt 0) {
                                Write-Host ""
                                Write-Host "Conflicted files:"
                                foreach ($file in $conflictedFiles) {
                                    Write-Host "  - $file"
                                }
                            }
                            Write-Host ""
                            Write-Info "Your stashed changes are preserved -- nothing is lost."
                            Write-Info "  Stash ref: $autostashRef"
                            git -c windows.appendAtomically=false reset --hard HEAD 2>$null | Out-Null
                            Write-Info "Working tree reset to clean state."
                            Write-Info "Restore your changes later with: git stash apply $autostashRef"
                        }
                    } else {
                        Write-Info "Skipped restoring local changes."
                        Write-Info "Your changes are still preserved in git stash."
                        Write-Info "Restore manually with: git stash apply $autostashRef"
                    }
                    $autostashRef = ""
                }
            } finally {
                if ($autostashRef) {
                    # We stashed but never reached the restore block (a fetch/
                    # checkout/pull failure threw). Leave the stash in place and
                    # tell the user how to recover it -- never silently drop it.
                    Write-Warn "Update did not complete. Your local changes are preserved in git stash."
                    Write-Info "Restore manually with: git stash apply $autostashRef"
                }
                $ErrorActionPreference = $prevEAP
                Pop-Location
            }
            $didUpdate = $true
        } else {
            # Directory exists but isn't a usable git repo -- e.g. an
            # interrupted clone with no initial commit (#40998), or a leftover
            # ``.git`` stub from a partial uninstall that used to lock the
            # installer into the "update" branch forever. Move it aside rather
            # than deleting it -- never destroy a directory the user might still
            # want -- and fall through to a fresh clone.
            $backupDir = "$InstallDir.broken-" + (Get-Date -Format "yyyyMMdd-HHmmss")
            Write-Warn "Existing directory at $InstallDir is not a valid git repo."
            Write-Warn "Moving it aside to $backupDir before re-cloning."
            try {
                Move-Item -LiteralPath $InstallDir -Destination $backupDir -ErrorAction Stop
            } catch {
                Write-Err "Could not move $InstallDir aside : $_"
                Write-Info "Close any programs that might be using files in $InstallDir (editors,"
                Write-Info "terminals, running youtab processes) and try again."
                throw
            }
        }
    }

    if (-not $didUpdate) {
        $cloneSuccess = $false

        # Fix Windows git "copy-fd: write returned: Invalid argument" error.
        # Git for Windows can fail on atomic file operations (hook templates,
        # config lock files) due to antivirus, OneDrive, or NTFS filter drivers.
        # The -c flag injects config before any file I/O occurs.
        Write-Info "Configuring git for Windows compatibility..."
        $env:GIT_CONFIG_COUNT = "1"
        $env:GIT_CONFIG_KEY_0 = "windows.appendAtomically"
        $env:GIT_CONFIG_VALUE_0 = "false"
        git config --global windows.appendAtomically false 2>$null

        # Try SSH first, then HTTPS, with -c flag for atomic write fix
        Write-Info "Trying SSH clone..."
        $env:GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=5"
        try {
            Invoke-NativeWithRelaxedErrorAction { git -c windows.appendAtomically=false clone --depth 1 --branch $Branch $RepoUrlSsh $InstallDir }
            if ($LASTEXITCODE -eq 0) { $cloneSuccess = $true }
        } catch { }
        $env:GIT_SSH_COMMAND = $null

        if (-not $cloneSuccess) {
            if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue }
            Write-Info "SSH failed, trying HTTPS..."
            try {
                Invoke-NativeWithRelaxedErrorAction { git -c windows.appendAtomically=false clone --depth 1 --branch $Branch $RepoUrlHttps $InstallDir }
                if ($LASTEXITCODE -eq 0) { $cloneSuccess = $true }
            } catch { }
        }

        # Fallback: download ZIP archive (bypasses git file I/O issues entirely)
        if (-not $cloneSuccess) {
            if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue }
            Write-Warn "Git clone failed -- downloading ZIP archive instead..."
            try {
                # Pick the ZIP URL for the most-specific ref the caller asked
                # for.  GitHub supports archive URLs for commits, tags, and
                # branches; we honour Commit > Tag > Branch.
                if ($Commit) {
                    $zipUrl = "https://github.com/eimanghazaei/Youtab-Agent-Runtime/archive/$Commit.zip"
                    $zipLabel = $Commit
                } elseif ($Tag) {
                    $zipUrl = "https://github.com/eimanghazaei/Youtab-Agent-Runtime/archive/refs/tags/$Tag.zip"
                    $zipLabel = $Tag
                } else {
                    $zipUrl = "https://github.com/eimanghazaei/Youtab-Agent-Runtime/archive/refs/heads/$Branch.zip"
                    $zipLabel = $Branch
                }
                $zipPath = "$env:TEMP\youtab-agent-runtime-$zipLabel.zip"
                $extractPath = "$env:TEMP\youtab-agent-runtime-extract"

                Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
                if (Test-Path $extractPath) { Remove-Item -Recurse -Force $extractPath }
                Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

                # GitHub ZIPs extract to repo-branch/ subdirectory
                $extractedDir = Get-ChildItem $extractPath -Directory | Select-Object -First 1
                if ($extractedDir) {
                    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) -ErrorAction SilentlyContinue | Out-Null
                    Move-Item $extractedDir.FullName $InstallDir -Force
                    Write-Success "Downloaded and extracted"

                    # Initialize git repo so updates work later. A bare
                    # `git init` leaves NO HEAD -- desktop's write-build-stamp
                    # then hard-fails with "could not determine git commit"
                    # (#50823 / #61657). Fetch the requested ref and force-check
                    # it out (-f) so untracked ZIP files cannot block checkout.
                    Push-Location $InstallDir
                    git -c windows.appendAtomically=false init 2>$null
                    git -c windows.appendAtomically=false config windows.appendAtomically false 2>$null
                    # Pin autocrlf=false BEFORE the checkout below. Git for Windows
                    # defaults to core.autocrlf=true, which would renormalize the
                    # repo's LF text files to CRLF in the working tree during
                    # `checkout -f FETCH_HEAD` -- leaving this freshly-created
                    # managed checkout dirty vs HEAD and aborting the next
                    # `youtab update` (see the notes at the shared clone-path
                    # config below and install.ps1:1461-1469). The later pin on
                    # the shared path is idempotent and still covers git clones.
                    git -c windows.appendAtomically=false config core.autocrlf false 2>$null
                    git remote add origin $RepoUrlHttps 2>$null
                    $fetchRef = if ($Commit) { $Commit } elseif ($Tag) { "refs/tags/$Tag" } else { $Branch }
                    Write-Info "Fetching $fetchRef so the ZIP checkout has a resolvable HEAD..."
                    $prevZipEAP = $ErrorActionPreference
                    $ErrorActionPreference = "Continue"
                    try {
                        git -c windows.appendAtomically=false fetch --depth 1 origin $fetchRef 2>&1 | Out-Null
                        if ($LASTEXITCODE -eq 0) {
                            if ($Commit -or $Tag) {
                                git -c windows.appendAtomically=false checkout -f --detach FETCH_HEAD 2>&1 | Out-Null
                            } else {
                                git -c windows.appendAtomically=false checkout -f -B $Branch FETCH_HEAD 2>&1 | Out-Null
                            }
                            if ($LASTEXITCODE -eq 0) {
                                Write-Success "ZIP checkout pinned to $fetchRef"
                            } else {
                                # Checkout blocked, but FETCH_HEAD still has a SHA we can stamp with.
                                $fetchSha = & git -c windows.appendAtomically=false rev-parse FETCH_HEAD 2>$null
                                if ($LASTEXITCODE -eq 0 -and $fetchSha) {
                                    if (-not $env:GITHUB_SHA) { $env:GITHUB_SHA = ("$fetchSha").Trim() }
                                    Write-Warn "ZIP checkout failed; seeded GITHUB_SHA from FETCH_HEAD for desktop stamp"
                                } else {
                                    Write-Warn "ZIP extract succeeded but git checkout failed -- desktop build may need `$env:GITHUB_SHA"
                                }
                            }
                        } else {
                            Write-Warn "ZIP extract succeeded but git fetch of $fetchRef failed -- desktop build may need `$env:GITHUB_SHA"
                        }
                    } finally {
                        $ErrorActionPreference = $prevZipEAP
                    }
                    Pop-Location
                    Write-Success "Git repo initialized for future updates"

                    $cloneSuccess = $true
                }

                # Cleanup temp files
                Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
                Remove-Item -Recurse -Force $extractPath -ErrorAction SilentlyContinue
            } catch {
                Write-Err "ZIP download also failed: $_"
            }
        }

        if (-not $cloneSuccess) {
            throw "Failed to download repository (tried git clone SSH, HTTPS, and ZIP)"
        }
    }

    # Set per-repo config (harmless if it fails)
    Push-Location $InstallDir
    git -c windows.appendAtomically=false config windows.appendAtomically false 2>$null
    # Pin autocrlf=false on the managed clone so git never renormalizes the
    # repo's LF text files to CRLF in the working tree. Without this, the very
    # next `youtab update` checkout aborts on a "dirty" tree the user never
    # touched (see the update path above).
    git -c windows.appendAtomically=false config core.autocrlf false 2>$null

    # Post-clone pin: when a clone (or ZIP-fallback init) just landed us on
    # $Branch's tip, honour the higher-precedence $Commit / $Tag by checking
    # the exact ref out as a detached HEAD.  Skipped for the in-place update
    # path (above) since that already routed via the same precedence.
    if (-not $didUpdate) {
        # Same EAP=Continue wrap as the update path -- git fetch's 'From <url>'
        # info line goes to stderr and would terminate the script under the
        # global EAP=Stop otherwise.  We check $LASTEXITCODE for real errors.
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            if ($Commit) {
                Write-Info "Pinning to commit $Commit..."
                git -c windows.appendAtomically=false fetch origin $Commit
                git -c windows.appendAtomically=false checkout --detach $Commit
                if ($LASTEXITCODE -ne 0) {
                    throw "git checkout $Commit failed (exit $LASTEXITCODE)"
                }
            } elseif ($Tag) {
                Write-Info "Pinning to tag $Tag..."
                git -c windows.appendAtomically=false fetch origin "refs/tags/${Tag}:refs/tags/${Tag}"
                git -c windows.appendAtomically=false checkout --detach "refs/tags/$Tag"
                if ($LASTEXITCODE -ne 0) {
                    throw "git checkout tag $Tag failed (exit $LASTEXITCODE)"
                }
            }
        } finally {
            $ErrorActionPreference = $prevEAP
        }
    }

    Assert-CurrentRuntimeBranding -Root $InstallDir
    Write-Success "Repository ready"
}

function Install-Venv {
    if ($NoVenv) {
        Write-Info "Skipping virtual environment (-NoVenv)"
        return
    }

    if ($PrivateHomeRelocation) {
        $privateVenv = [IO.Path]::Combine($InstallDir, 'venv')
        # No private resume may enter the ordinary task/process teardown path.
        if (@([IO.Directory]::GetFileSystemEntries($InstallDir, 'venv')).Count) {
            throw 'Fresh private virtual environment collision refused'
        }
        $privateBasePython = Get-PrivateBasePython
        Invoke-NativeWithRelaxedErrorAction { & $privateBasePython -I -S -B -m venv --without-pip $privateVenv }
        $privateVenvExit = $LASTEXITCODE
        if ($privateVenvExit -ne 0) { throw "Private stdlib venv creation failed ($privateVenvExit)" }
        $privateVenvPython = [IO.Path]::Combine($privateVenv, 'Scripts', 'python.exe')
        if (-not [IO.File]::Exists($privateVenvPython)) { throw 'Private virtual environment interpreter is absent' }
        $env:UV_PYTHON = $privateVenvPython
        return
    }

    # Re-resolve the interpreter before creating the venv.  Under Youtab-Setup.exe
    # each stage runs in its own powershell.exe, so the fallback the `python`
    # stage picked (e.g. 3.12 when 3.11 is absent) did NOT propagate into this
    # fresh process -- $PythonVersion is back at its "3.11" default.  Trusting it
    # here made `uv venv venv --python 3.11` fail with exit 2 on machines without
    # 3.11 even though the `python` stage reported success (issue #50769).
    $resolved = if ($PrivateHomeRelocation) { $null } else { Resolve-AvailablePythonVersion }
    if ($resolved -and $resolved -ne $PythonVersion) {
        Write-Info "Python $PythonVersion not available; using detected Python $resolved"
        $script:PythonVersion = $resolved
    }

    Write-Info "Creating virtual environment with Python $PythonVersion..."
    
    Push-Location $InstallDir

    # Tasks we disabled below and must re-enable no matter how this stage
    # exits. Populated only with tasks that were ENABLED before we touched
    # them, so a task the user deliberately disabled is never re-armed.
    $gatewayTasksDisabled = @()
    try {
    if (Test-Path "venv") {
        Write-Info "Virtual environment already exists, recreating..."
        # On Windows, native Python extensions (e.g. _bcrypt.pyd, tornado's
        # speedups.pyd) are loaded as DLLs by any running youtab process.
        # Windows denies deletion of loaded DLLs, so every process running out
        # of this venv must be stopped before removing it -- otherwise
        # Remove-Item fails with "Access to the path '...' is denied" and the
        # whole install/update aborts at this stage.
        if ($env:OS -eq "Windows_NT") {
            $myPid = $PID
            Write-Info "Stopping any running youtab processes before recreating venv..."
            # Disarm the respawner FIRST: the gateway autostart Scheduled Task
            # relaunches a killed gateway within seconds, and losing that race
            # re-locks the venv's .pyd files between our kill sweep and
            # Remove-Item (the July 2026 _brotlicffi.pyd incident). schtasks
            # /End stops a running task instance; /Change /DISABLE stops it
            # from re-firing mid-install. (The Startup-folder .vbs fallback is
            # NOT touched: it only fires at logon, so it cannot respawn a
            # gateway mid-install.) Re-enabled in the finally below -- including
            # on failure -- but only for tasks that were enabled to begin with.
            # Best-effort: a missing task just errors quietly.
            try {
                schtasks /Query /FO CSV 2>$null | ConvertFrom-Csv | Where-Object { $_.TaskName -like '*Youtab_Gateway*' } | ForEach-Object {
                    $tn = $_.TaskName
                    if ($_.Status -eq 'Disabled') {
                        Write-Info "  gateway autostart task $tn is already disabled; leaving it that way"
                        return
                    }
                    schtasks /End /TN $tn 2>$null | Out-Null
                    schtasks /Change /TN $tn /DISABLE 2>$null | Out-Null
                    $gatewayTasksDisabled += $tn
                    Write-Info "  disabled gateway autostart task $tn for the duration of the install"
                }
            } catch {
                Write-Warn "Could not enumerate gateway scheduled tasks: $($_.Exception.Message)"
            }
            # The launcher CLI (youtab.exe) plus its child tree.
            & taskkill /F /T /IM youtab.exe /FI "PID ne $myPid" 2>$null | Out-Null
            # taskkill /IM youtab.exe is NOT enough: the gateway/agent that a
            # scheduled task or watchdog autostarts runs as
            # `pythonw.exe -m youtab_agent_cli.main gateway run` straight out of
            # venv\Scripts\, so its image name is python/pythonw, not youtab.exe.
            # That process holds the venv's .pyd files open and re-triggers the
            # access-denied failure. Stop anything whose executable lives under
            # this venv, matched by path prefix so the image name does not matter
            # and a global/system python outside the venv is never touched.
            #
            # The gateway autostart task registers with /RL LIMITED as the current
            # user (see youtab_agent_cli/gateway_windows.py), so the installer always
            # runs at equal-or-higher integrity and can read its executable path.
            # Get-CimInstance is used over Get-Process because it returns a null
            # ExecutablePath for a process it cannot inspect (a different session)
            # instead of throwing, so an unreadable process is skipped rather than
            # aborting the whole sweep.
            #
            # The sweep is a bounded LOOP, not single-shot: supervised processes
            # (the Desktop app's backend, a watchdog-managed gateway) respawn in
            # the window between one kill pass and the delete. Each pass re-
            # enumerates; three consecutive clean passes (or the attempt cap)
            # ends the loop.
            $venvPrefix = [System.IO.Path]::GetFullPath((Join-Path $InstallDir "venv")).TrimEnd('\') + '\'
            $cleanPasses = 0
            for ($sweep = 0; $sweep -lt 10 -and $cleanPasses -lt 3; $sweep++) {
                $found = 0
                try {
                    Get-CimInstance Win32_Process -ErrorAction Stop |
                        Where-Object { $_.ProcessId -ne $myPid -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($venvPrefix, [System.StringComparison]::OrdinalIgnoreCase) } |
                        ForEach-Object {
                            $found++
                            Write-Info "  stopping PID $($_.ProcessId) ($($_.Name)) running from venv"
                            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                        }
                } catch {
                    Write-Warn "Could not enumerate venv processes: $($_.Exception.Message)"
                    break
                }
                if ($found -eq 0) { $cleanPasses++ } else { $cleanPasses = 0 }
                Start-Sleep -Milliseconds 400
            }
        }
        # Rename-then-delete: on Windows a directory RENAME succeeds even while
        # files inside it are mapped as DLLs (only in-place delete/replace of
        # the mapped file is denied, and only same-volume renames are atomic
        # moves). Moving the old venv aside means `uv venv` can create a fresh
        # one immediately even if some straggler still holds a .pyd from the
        # old tree; the renamed dir is deleted best-effort (now, and by the
        # cleanup pass below on the NEXT install if a handle outlives this one).
        $staleName = "venv.stale.{0}" -f (Get-Date -Format "yyyyMMddHHmmss")
        $renamed = $false
        try {
            Rename-Item -Path "venv" -NewName $staleName -ErrorAction Stop
            $renamed = $true
        } catch {
            Write-Warn "Could not rename venv aside ($($_.Exception.Message)); falling back to in-place delete"
        }
        if ($renamed) {
            Remove-Item -Recurse -Force $staleName -ErrorAction SilentlyContinue
            if (Test-Path $staleName) {
                Write-Warn "Old venv parked at $staleName (a process still holds files in it); it will be cleaned up on the next install"
            }
        } else {
            Remove-Item -Recurse -Force "venv" -ErrorAction SilentlyContinue
            # A killed process can take a moment to release its file handles, so a
            # first Remove-Item may still hit a locked .pyd. Retry once after a short
            # pause before giving up and letting the stage fail loudly.
            if (Test-Path "venv") {
                Start-Sleep -Seconds 2
                Remove-Item -Recurse -Force "venv"
            }
        }
    }

    # Clean up parked venvs from previous installs whose handles have since
    # been released. Best-effort -- a still-held tree just stays for next time.
    Get-ChildItem -Directory -Filter "venv.stale.*" -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
    }
    
    # uv creates the venv and pins the Python version in one step.  uv emits
    # normal progress such as "Using CPython ..." on stderr; under Windows
    # PowerShell 5.1 with EAP=Stop that stderr is a NativeCommandError unless
    # we temporarily relax EAP and trust $LASTEXITCODE for real failures.
    $venvRequest = if ($script:CustomerReleaseMode) { Get-PrivateBasePython } else { $PythonVersion }
    Invoke-NativeWithRelaxedErrorAction { & $UvCmd venv venv --python $venvRequest }
    # Relaxing EAP above means a *genuine* uv-venv failure (exit != 0) no longer
    # aborts on its own. Capture $LASTEXITCODE immediately and fail fast, so the
    # `venv` stage can't falsely report success (and Invoke-Stage can't emit
    # ok=true) when the venv was never created.
    $venvExitCode = $LASTEXITCODE
    if ($venvExitCode -ne 0) {
        throw "Failed to create virtual environment (uv venv exited with $venvExitCode)"
    }

    # Neutralize any inherited UV_PYTHON (e.g. $env:UV_PYTHON = "3.14" left in
    # the user's shell). uv honours UV_PYTHON over an existing venv for the
    # later `uv sync` / `uv pip install` tiers, so without this it would
    # silently delete this 3.11 venv and recreate it at the inherited version
    # -- building Rust transitives that have no wheel for that version from
    # source via maturin, which fails. Pinning UV_PYTHON to the interpreter we
    # just created forces every subsequent uv command onto it.
    $venvPythonExe = Join-Path $InstallDir "venv\Scripts\python.exe"
    if (Test-Path $venvPythonExe) {
        $env:UV_PYTHON = $venvPythonExe
    }
    } finally {
        Pop-Location
        # Re-arm the gateway autostart tasks disabled during the venv teardown
        # -- in a finally so a failed teardown/creation can never strand the
        # user's gateway autostart in the disabled state. Same function scope,
        # so the list survives even under the stage-per-process bootstrap.
        # Deliberately NOT started here -- dependencies aren't installed yet;
        # the task fires normally on next logon and `youtab update` / the
        # gateway resume path handles the immediate restart.
        if ($gatewayTasksDisabled -and $gatewayTasksDisabled.Count -gt 0) {
            foreach ($tn in $gatewayTasksDisabled) {
                schtasks /Change /TN $tn /ENABLE 2>$null | Out-Null
            }
            Write-Info "Re-enabled gateway autostart task(s): $($gatewayTasksDisabled -join ', ')"
        }
    }

    Write-Success "Virtual environment ready (Python $PythonVersion)"
}

function Get-WindowsPtySdkContext {
    param([string]$PythonExe = "")
    if (-not $PythonExe) {
        if (-not $NoVenv) {
            $PythonExe = Join-Path $InstallDir "venv\Scripts\python.exe"
        } else {
            $resolved = Resolve-AvailablePythonVersion
            if ($resolved) {
                $PythonExe = & $UvCmd python find $resolved 2>$null
            } else {
                $systemPython = Get-Command python -ErrorAction SilentlyContinue
                $PythonExe = if ($systemPython) { $systemPython.Source } else { $null }
            }
        }
    }
    if (-not $PythonExe -or -not (Test-Path $PythonExe)) {
        throw "Windows PTY SDK requires the final interpreter. Run the Python and venv stages first."
    }
    $helper = Join-Path $InstallDir "tools\windows_pty_dependency.py"
    if (-not (Test-Path $helper)) {
        throw "Windows PTY SDK verifier is missing. Use a complete verified Youtab release."
    }
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $PythonExe -I $helper validate --root $InstallDir 2>&1)
        $verificationExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousErrorAction }
    if ($verificationExit -ne 0) {
        throw "Windows PTY SDK packaged inputs or interpreter ABI failed verification: $output"
    }
    $validated = ($output -join "`n") | ConvertFrom-Json
    return [pscustomobject]@{
        PythonExe = $PythonExe; Wheel = $validated.wheel_requirement; VendorDir = $validated.vendor_dir
    }
}

function Assert-WindowsPtySdk {
    param($Context)
    $helper = Join-Path $InstallDir "tools\windows_pty_dependency.py"
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $Context.PythonExe -I $helper attest --root $InstallDir 2>&1)
        $attestationExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousErrorAction }
    if ($attestationExit -ne 0) {
        throw "Installed Windows PTY SDK failed source, native, version, or origin attestation: $output"
    }
}

function Get-CustomerDependencyExtras {
    param([string[]]$Extra = @())
    # Stages run in separate processes. Re-derive the complete selection on
    # every exact sync from the existing desktop flag, built executable, and tokens.
    $selected = @('all')
    $desktopInstalled = (Test-Path -LiteralPath (Join-Path $InstallDir 'apps\desktop\release\win-unpacked\Youtab.exe') -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $InstallDir 'apps\desktop\release\win-arm64-unpacked\Youtab.exe') -PathType Leaf)
    if ($IncludeDesktop -or $desktopInstalled) { $selected += @('wake', 'voice') }
    $envPath = Join-Path $YoutabHome '.env'
    if (Test-Path -LiteralPath $envPath -PathType Leaf) {
        $envLines = Get-Content -LiteralPath $envPath -ErrorAction Stop
        foreach ($name in @('TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'WHATSAPP_ENABLED')) {
            $configured = $envLines | Where-Object {
                $_ -match ('^' + [regex]::Escape($name) + '=.+') -and
                $_ -notmatch 'your-token-here' -and $_ -notmatch '^\s*#'
            }
            if ($configured) { $selected += 'messaging'; break }
        }
    }
    foreach ($name in $Extra) { if ($selected -notcontains $name) { $selected += $name } }
    return $selected
}

function Invoke-CustomerLockedDependencySync {
    param([string[]]$Extra = @(), [switch]$ReinstallPackage)
    if (-not $script:CustomerReleaseMode) { throw 'Locked customer sync is customer-only' }
    if ($NoVenv) { throw 'Customer installation requires a locked virtual environment; -NoVenv is unsupported.' }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'uv.lock') -PathType Leaf)) {
        throw 'Customer installation requires the shipped uv.lock; no unlocked fallback is permitted.'
    }
    $selected = @(Get-CustomerDependencyExtras -Extra $Extra)
    if (@($selected | Where-Object { $_ -notin @('all', 'wake', 'voice', 'messaging') }).Count -gt 0) {
        throw 'Customer prerequisite bundle does not cover a selected dependency extra'
    }
    $bundle = Assert-CustomerPrerequisites -Root $InstallDir -SourceSha $Commit
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $InstallDir 'venv'
    $venvPython = Join-Path $InstallDir 'venv\Scripts\python.exe'
    $requirements = Join-Path $bundle 'requirements.txt'
    $wheelhouse = Join-Path $bundle 'wheelhouse'
    Push-Location $InstallDir
    try {
        Invoke-NativeWithRelaxedErrorAction {
            & $UvCmd --no-config pip install --offline --no-index --find-links $wheelhouse --require-hashes --no-build --python $venvPython -r $requirements
        }
        $lockedExit = $LASTEXITCODE
        if ($lockedExit -ne 0) { throw "Customer bundled dependencies failed (exit $lockedExit); no network or reduced fallback is permitted." }
        $editableArgs = @('--no-config', 'pip', 'install', '--offline', '--no-index', '--no-build-isolation', '--no-deps', '--editable', '.')
        if ($ReinstallPackage) { $editableArgs += '--reinstall' }
        Invoke-NativeWithRelaxedErrorAction { & $UvCmd @editableArgs --python $venvPython }
        if ($LASTEXITCODE -ne 0) { throw 'Customer first-party CLI install failed from the verified Runtime source layout.' }
        Invoke-NativeWithRelaxedErrorAction { & $UvCmd pip check --python $venvPython }
        $checkExit = $LASTEXITCODE
        if ($checkExit -ne 0) { throw "Customer locked dependencies are inconsistent (exit $checkExit); no reduced fallback is permitted." }
    } finally { Pop-Location }
}

function Install-Dependencies {
    if ($script:CustomerReleaseMode) {
        if ($NoVenv) { throw 'Customer installation requires a locked virtual environment; -NoVenv is unsupported.' }
        if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'uv.lock') -PathType Leaf)) {
            throw 'Customer installation requires the shipped uv.lock; no unlocked fallback is permitted.'
        }
    }
    # A standalone dependency stage can encounter an older existing venv.
    # Refuse its unsupported ABI before any dependency operation or env pin.
    $existingPython = Join-Path $InstallDir "venv\Scripts\python.exe"
    if ($NoVenv) {
        $resolved = Resolve-AvailablePythonVersion
        if ($resolved) {
            $existingPython = & $UvCmd python find $resolved 2>$null
        } else {
            $systemPython = Get-Command python -ErrorAction SilentlyContinue
            $existingPython = if ($systemPython) { $systemPython.Source } else { $null }
        }
        $supportedVersion = Get-SupportedPythonVersion -PythonExe $existingPython
        if (-not $supportedVersion) {
            throw "Dependencies require Python 3.11, 3.12, or 3.13. Re-run the Python stage."
        }
        $script:PythonVersion = $supportedVersion
        $env:UV_PYTHON = $existingPython
    } elseif (Test-Path $existingPython) {
        if (-not (Get-SupportedPythonVersion -PythonExe $existingPython)) {
            throw "Dependencies require Python 3.11, 3.12, or 3.13. Re-run the Python and venv stages."
        }
    }
    $ptySdk = Get-WindowsPtySdkContext -PythonExe $existingPython
    Write-Info "Installing dependencies..."
    
    Push-Location $InstallDir
    try {
    
    if (-not $NoVenv) {
        # Tell uv to install into our venv (no activation needed)
        $env:VIRTUAL_ENV = "$InstallDir\venv"
    }

    # Re-pin UV_PYTHON to the venv interpreter. Install-Venv already does this,
    # but the bootstrap runs install stages (venv, python-deps) as separate
    # processes, so the env var set in Install-Venv does NOT survive into a
    # separate python-deps invocation. Re-deriving it here covers that path.
    # Without it, an inherited $env:UV_PYTHON = "3.14" makes the uv sync/pip
    # tiers below recreate the venv at 3.14 and fail the maturin source build
    # (no cp314 wheels yet).
    if (-not $NoVenv) {
        $venvPythonExe = Join-Path $InstallDir "venv\Scripts\python.exe"
        if (Test-Path $venvPythonExe) {
            $env:UV_PYTHON = $venvPythonExe
        }
    }

    # Hash-verified install (Tier 0) -- when uv.lock is present, prefer
    # `uv sync --locked`. The lockfile records SHA256 hashes for every
    # transitive dependency, so a compromised transitive (different hash
    # than what we shipped) is REJECTED by the resolver. This is the
    # *only* path that protects against the "direct dep is fine, but the
    # dep's dep got worm-poisoned overnight" failure mode. The
    # `uv pip install` tiers below re-resolve transitives fresh from PyPI
    # without any hash verification -- they exist to keep installs working
    # when the lockfile is stale, missing, or out-of-sync with the
    # current extras spec, NOT because they're equivalent in posture.
    if ($script:CustomerReleaseMode) {
        Invoke-CustomerLockedDependencySync
        Assert-WindowsPtySdk -Context $ptySdk
        Write-Success "Main package installed (hash-verified via uv.lock)"
        $script:InstalledTier = "hash-verified (uv.lock)"
        $skipPipFallback = $true
    } elseif (-not $NoVenv -and (Test-Path "uv.lock")) {
        Write-Info "Trying tier: hash-verified (uv.lock) ..."
        # Critical flag choice: `--extra all`, NOT `--all-extras`.
        #   --all-extras = every [project.optional-dependencies] key,
        #                  bypassing the curated [all] extra. On Windows
        #                  that means [matrix] -> python-olm (no wheel,
        #                  needs `make` to build from sdist) and the
        #                  install fails.
        #   --extra all  = just the [all] extra's contents (curated).
        #
        # UV_PROJECT_ENVIRONMENT pins the sync target to our venv\.
        # Without it, modern uv (>=0.5) ignores VIRTUAL_ENV for `sync`
        # and creates a sibling .venv\ inside the repo -- leaving venv\
        # empty and producing the broken state where `youtab.exe` exists
        # in the wrong directory and imports fail with ModuleNotFoundError.
        # (Mirrors the same flag in scripts/install.sh::install_deps.)
        $env:UV_PROJECT_ENVIRONMENT = "$InstallDir\venv"
        $ptySdk = Get-WindowsPtySdkContext -PythonExe $ptySdk.PythonExe
        Invoke-NativeWithRelaxedErrorAction { & $UvCmd sync --extra all --locked }
        if ($LASTEXITCODE -eq 0) {
            Assert-WindowsPtySdk -Context $ptySdk
            Write-Success "Main package installed (hash-verified via uv.lock)"
            $script:InstalledTier = "hash-verified (uv.lock)"
            # Skip the rest of the tiered cascade -- we already have a
            # complete, hash-verified install.
            $skipPipFallback = $true
        } else {
            Write-Warn "uv.lock sync failed (lockfile may be stale), falling back to PyPI resolve..."
            $skipPipFallback = $false
        }
    } else {
        if ($NoVenv) {
            Write-Info "NoVenv installs into the selected interpreter via uv pip tiers (not a locked uv sync)."
        } else {
            Write-Info "uv.lock not found -- falling back to PyPI resolve (no hash verification)"
        }
        $skipPipFallback = $false
    }

    # Install main package.  Tiered fallback so a single flaky transitive
    # doesn't silently drop everything.  Each tier's stdout/stderr is
    # preserved -- no Out-Null swallowing -- so the user can see what failed.
    #
    # Tier 1: [all] -- the curated extra in pyproject.toml.
    # Tier 2: [all] minus the currently-broken extras list ($brokenExtras).
    #         Edit $brokenExtras below when something on PyPI breaks; this
    #         lets users keep the rest of [all] when one transitive is
    #         unavailable. The list of [all]'s contents is parsed from
    #         pyproject.toml at runtime -- there is NO hand-mirrored copy
    #         to drift out of sync.
    # Tier 3: bare `.` -- last-resort so at least the core CLI launches.

    # Currently-broken extras. Edit this list when an upstream package
    # gets quarantined / yanked / breaks resolution. Empty means everything
    # in [all] should be installable; populate with the names of extras
    # whose deps are temporarily unavailable.
    $brokenExtras = @()

    # Parse [project.optional-dependencies].all from pyproject.toml.
    # tomllib is stdlib on Python 3.11+ which the bootstrap guarantees.
    $pythonExeForParse = $ptySdk.PythonExe
    $allExtras = @()
    if (Test-Path $pythonExeForParse) {
        $parsed = & $pythonExeForParse @script:RelocationPythonArgs -c @"
import re, sys, tomllib
try:
    with open('pyproject.toml', 'rb') as fh:
        data = tomllib.load(fh)
    specs = data['project']['optional-dependencies']['all']
    out = []
    for s in specs:
        m = re.search(r'youtab-agent-runtime\[([\w-]+)\]', s)
        if m: out.append(m.group(1))
    print(','.join(out))
except Exception:
    sys.exit(1)
"@ 2>$null
        if ($LASTEXITCODE -eq 0 -and $parsed) {
            $allExtras = $parsed.Trim().Split(',')
        }
    }
    if (-not $allExtras -or $allExtras.Count -eq 0) {
        Write-Warn "Could not parse [all] from pyproject.toml; Tier 2 will be a no-op."
        $safeAll = "all"
    } else {
        $safeAll = ($allExtras | Where-Object { $brokenExtras -notcontains $_ }) -join ","
    }
    $brokenLabel = if ($brokenExtras) { ($brokenExtras -join ", ") } else { "none" }

    $installTiers = @(
        @{ Name = "all"; Spec = ".[all]" },
        @{ Name = "all minus known-broken ($brokenLabel)"; Spec = ".[$safeAll]" },
        @{ Name = "core only (no extras)"; Spec = "." }
    )
    $installed = $skipPipFallback
    if (-not $skipPipFallback) {
        foreach ($tier in $installTiers) {
        Write-Info "Trying tier: $($tier.Name) ..."
        $ptySdk = Get-WindowsPtySdkContext -PythonExe $ptySdk.PythonExe
        Invoke-NativeWithRelaxedErrorAction { & $UvCmd pip install -e $tier.Spec --python $ptySdk.PythonExe --find-links $ptySdk.VendorDir $ptySdk.Wheel }
        if ($LASTEXITCODE -eq 0) {
            Assert-WindowsPtySdk -Context $ptySdk
            Write-Success "Main package installed ($($tier.Name))"
            $script:InstalledTier = $tier.Name
            $installed = $true
            break
        }
        Write-Warn "Tier '$($tier.Name)' failed (exit $LASTEXITCODE). Trying next tier..."
        }
    }
    if (-not $installed) {
        throw "Failed to install youtab-agent-runtime package even with no extras. Inspect the uv pip install output above."
    }

    # Baseline-import gate. Even if a tier reported success above, the
    # actual deps may have landed somewhere other than $InstallDir\venv\
    # (e.g. uv 0.5+ syncing into a sibling .venv\ when UV_PROJECT_ENVIRONMENT
    # isn't set, leaving venv\ empty and youtab.exe broken with
    # `ModuleNotFoundError: No module named 'dotenv'` on first run).
    # We probe via the venv's own python so a misdirected sync is caught
    # here, not 30 seconds later when the user runs `youtab`.
    if (-not $NoVenv) {
        $venvPython = "$InstallDir\venv\Scripts\python.exe"
        if (-not (Test-Path $venvPython)) {
            throw "Install reported success but $venvPython does not exist. The dependency sync likely landed in a sibling .venv\ directory. Re-run the installer; if it persists, manually: cd '$InstallDir'; Remove-Item -Recurse -Force venv,.venv; uv venv venv --python $PythonVersion; `$env:UV_PROJECT_ENVIRONMENT='$InstallDir\venv'; uv sync --extra all --locked"
        }
        # Relax EAP=Stop while running the import probe.  Python writes
        # deprecation warnings and import-system info to stderr; under
        # EAP=Stop the 2>&1 merge wraps those as ErrorRecord objects and
        # throws even when the imports succeed.  $LASTEXITCODE is the
        # reliable signal (it's 0 iff the python invocation exited 0,
        # regardless of what was written to stderr).
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $venvPython @script:RelocationPythonArgs -c "import dotenv, openai, rich, prompt_toolkit" 2>&1 | Out-Null
        $importExitCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        if ($importExitCode -ne 0) {
            $sibling = "$InstallDir\.venv"
            $hint = if (Test-Path $sibling) {
                "Detected sibling .venv\ at $sibling -- uv synced there instead of venv\. Recover with: cd '$InstallDir'; Remove-Item -Recurse -Force venv; Move-Item .venv venv"
            } else {
                "Recover with: cd '$InstallDir'; `$env:UV_PROJECT_ENVIRONMENT='$InstallDir\venv'; uv sync --extra all --locked"
            }
            throw "Baseline imports failed in $InstallDir\venv (dotenv/openai/rich/prompt_toolkit). The install completed but dependencies are not in the venv. $hint"
        }
        Write-Success "Baseline imports verified in venv"
    }

    if (-not $NoVenv) {
        # uv on Windows can register youtab.exe in dist-info/RECORD but fail to
        # materialise the .exe (file lock during self-update, distlib edge case).
        # Catch it here so a fresh install/update does not finish with a broken
        # `youtab` command while youtab-agent-runtime.exe / youtab-acp.exe exist
        $scriptsDir = Join-Path $InstallDir "venv\Scripts"
        $pythonExe = Join-Path $scriptsDir "python.exe"
        if ((Test-Path $scriptsDir) -and (Test-Path $pythonExe)) {
            $scriptNames = & $pythonExe @script:RelocationPythonArgs -c @"
import tomllib
with open('pyproject.toml', 'rb') as fh:
    scripts = tomllib.load(fh).get('project', {}).get('scripts', {}) or {}
print(','.join(scripts))
"@ 2>$null
            if ($LASTEXITCODE -eq 0 -and $scriptNames) {
                $expected = @($scriptNames.Trim().Split(',') | Where-Object { $_ })
                $missing = @()
                foreach ($name in $expected) {
                    $exe = Join-Path $scriptsDir "$name.exe"
                    if (-not (Test-Path $exe)) { $missing += "$name.exe" }
                }
                if ($missing.Count -gt 0) {
                    Write-Warn "Console entry point(s) missing: $($missing -join ', ')"
                    Write-Info "Reinstalling entry points..."
                    $env:UV_PROJECT_ENVIRONMENT = "$InstallDir\venv"
                    $ptySdk = Get-WindowsPtySdkContext -PythonExe $pythonExe
                    if ($script:CustomerReleaseMode) {
                        Invoke-CustomerLockedDependencySync -ReinstallPackage
                    } else {
                    Invoke-NativeWithRelaxedErrorAction { & $UvCmd pip install --reinstall -e . --python $ptySdk.PythonExe --find-links $ptySdk.VendorDir $ptySdk.Wheel }
                    }
                    Assert-WindowsPtySdk -Context $ptySdk
                    $stillMissing = @()
                    foreach ($name in $expected) {
                        $exe = Join-Path $scriptsDir "$name.exe"
                        if (-not (Test-Path $exe)) { $stillMissing += "$name.exe" }
                    }
                    if ($stillMissing.Count -gt 0) {
                        if ($script:CustomerReleaseMode) { throw 'Customer console entry points remain missing after locked repair.' }
                        Write-Warn "Entry points still missing after repair: $($stillMissing -join ', ')"
                        Write-Info "Workaround: `"$pythonExe`" -m youtab_agent_cli.main <command>"
                    } else {
                        Write-Success "Console entry points restored"
                    }
                }
            }
        }
    }

    # Verify the dashboard deps specifically -- they're the most common thing
    # users hit and lazy-import errors from `youtab dashboard` are confusing.
    # If tier 1 failed (the common case), [web] was still picked up by tiers
    # 2-3; only tier 4 leaves you without it.
    $pythonExe = $ptySdk.PythonExe
    if (Test-Path $pythonExe) {
        $webOk = $false
        $webServerSyntaxOk = $false
        # Relax EAP=Stop while running the import probe; see the matching
        # comment on the baseline-imports check above.  Python writes
        # deprecation warnings to stderr and we don't want those wrapped
        # as ErrorRecords that silently force the "not importable" path
        # even when fastapi/uvicorn are actually installed.
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & $pythonExe @script:RelocationPythonArgs -c "import fastapi, uvicorn" 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $webOk = $true }
        } catch { }
        try {
            & $pythonExe @script:RelocationPythonArgs -m py_compile "$InstallDir\youtab_agent_cli\web_server.py" 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $webServerSyntaxOk = $true }
        } catch { }
        $ErrorActionPreference = $prevEAP
        if (-not $webOk) {
            if ($script:CustomerReleaseMode) { throw 'Customer locked dashboard dependencies are not importable; unlocked recovery is prohibited.' }
            Write-Warn "fastapi/uvicorn not importable -- `youtab dashboard` will not work."
            Write-Info "Attempting targeted install of [web] extra as last resort..."
            $ptySdk = Get-WindowsPtySdkContext -PythonExe $pythonExe
            Invoke-NativeWithRelaxedErrorAction { & $UvCmd pip install -e ".[web]" --python $ptySdk.PythonExe --find-links $ptySdk.VendorDir $ptySdk.Wheel }
            $webInstallExit = $LASTEXITCODE
            Assert-WindowsPtySdk -Context $ptySdk
            if ($webInstallExit -eq 0) {
                Write-Success "[web] extra installed; `youtab dashboard` should now work."
            } else {
                Write-Warn "Could not install [web] extra. Run manually: uv pip install --python `"$pythonExe`" --find-links `"$($ptySdk.VendorDir)`" `"fastapi>=0.104,<1`" `"uvicorn[standard]>=0.24,<1`" `"$($ptySdk.Wheel)`""
            }
        }
        if (-not $webServerSyntaxOk) {
            throw "dashboard backend source failed syntax check: youtab_agent_cli/web_server.py"
        }
    }
    
    Assert-WindowsPtySdk -Context $ptySdk
    } finally { Pop-Location }
    
    Write-Success "All dependencies installed"
}

function Set-PathVariable {
    if ($PrivateHomeRelocation) { return }
    if ($script:CustomerReleaseMode) {
        # The common Setup publishes discovery only after backend health,
        # bootstrap marker and Runtime/Setup transaction commit have passed.
        $script:_StageSkippedReason = 'Common Setup publishes PATH and home after product validation'
        return
    }
    Write-Info "Setting up youtab command..."
    
    if ($NoVenv) {
        $youtabBin = "$InstallDir"
    } else {
        $youtabBin = "$InstallDir\venv\Scripts"
    }
    
    # Add the venv Scripts dir to user PATH so youtab is globally available
    # On Windows, the youtab.exe in venv\Scripts\ has the venv Python baked in
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    
    if ($currentPath -notlike "*$youtabBin*") {
        [Environment]::SetEnvironmentVariable(
            "Path",
            "$youtabBin;$currentPath",
            "User"
        )
        Write-Success "Added to user PATH: $youtabBin"
    } else {
        Write-Info "PATH already configured"
    }
    
    # Set YOUTAB_AGENT_HOME so the Python code finds config/data in the right place.
    # Only needed on Windows where we install to %LOCALAPPDATA%\youtab instead
    # of the Unix default ~/.youtab-agent-runtime
    $currentYoutabHome = [Environment]::GetEnvironmentVariable("YOUTAB_AGENT_HOME", "User")
    if (-not $currentYoutabHome -or $currentYoutabHome -ne $YoutabHome) {
        [Environment]::SetEnvironmentVariable("YOUTAB_AGENT_HOME", $YoutabHome, "User")
        Write-Success "Set YOUTAB_AGENT_HOME=$YoutabHome"
    }
    $env:YOUTAB_AGENT_HOME = $YoutabHome
    
    # Update current session
    $env:Path = "$youtabBin;$env:Path"
    
    Write-Success "youtab command ready"
}

function Read-YoutabUserEnvironment {
    param([string]$Name)
    [Environment]::GetEnvironmentVariable($Name, 'User')
}
function Write-YoutabUserEnvironment {
    param([string]$Name, [AllowNull()][object]$Value)
    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
}
function Register-ValidatedCustomerHome {
    if (-not $script:CustomerReleaseMode -or $PrivateHomeRelocation) {
        throw 'Home registration requires a validated common customer install'
    }
    $selectedHome = [IO.Path]::GetFullPath($YoutabHome).TrimEnd('\')
    $runtime = [IO.Path]::Combine($selectedHome, 'youtab-agent-runtime')
    if (-not (Test-Path -LiteralPath (Join-Path $runtime '.youtab-agent-runtime-bootstrap-complete') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $selectedHome 'youtab-setup.exe') -PathType Leaf)) {
        throw 'Validated Runtime marker and common Setup are required before home registration'
    }
    $previousHome = Read-YoutabUserEnvironment 'YOUTAB_AGENT_HOME'
    if ($previousHome -and [IO.Path]::GetFullPath($previousHome).TrimEnd('\') -ine $selectedHome) {
        throw 'A different Youtab home is already registered; preserving migration is required'
    }
    $previousPath = Read-YoutabUserEnvironment 'Path'
    $bin = if ($NoVenv) { $runtime } else { [IO.Path]::Combine($runtime, 'venv', 'Scripts') }
    if (-not (Test-Path -LiteralPath (Join-Path $bin 'youtab.exe') -PathType Leaf)) {
        throw 'Validated Youtab CLI executable is absent; home remains unregistered'
    }
    $requiredDirs = @($bin)
    $managedNodeDir = [IO.Path]::Combine($selectedHome, 'node')
    if (Test-Path -LiteralPath (Join-Path $managedNodeDir 'node.exe') -PathType Leaf) {
        $requiredDirs += $managedNodeDir
    }
    $existingDirs = @($previousPath -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
    $missingDirs = @($requiredDirs | Where-Object { $existingDirs -inotcontains $_.TrimEnd('\') })
    $publishedPath = if ($missingDirs.Count -gt 0) {
        (@($missingDirs) + @($previousPath | Where-Object { $_ })) -join ';'
    } else { $previousPath }
    $changedHome = -not $previousHome
    $changedPath = $missingDirs.Count -gt 0
    try {
        if ($changedHome) { Write-YoutabUserEnvironment 'YOUTAB_AGENT_HOME' $selectedHome }
        if ($changedPath) { Write-YoutabUserEnvironment 'Path' $publishedPath }
        if ((Read-YoutabUserEnvironment 'YOUTAB_AGENT_HOME') -ine $selectedHome -or
            (Read-YoutabUserEnvironment 'Path') -cne $publishedPath) {
            throw 'Customer home registration readback differs'
        }
    } catch {
        # Roll back only values this invocation wrote. Never erase a concurrent
        # change or a pre-existing home selected by the user.
        if ($changedPath -and (Read-YoutabUserEnvironment 'Path') -ceq $publishedPath) {
            Write-YoutabUserEnvironment 'Path' $previousPath
        }
        if ($changedHome -and (Read-YoutabUserEnvironment 'YOUTAB_AGENT_HOME') -ieq $selectedHome) {
            Write-YoutabUserEnvironment 'YOUTAB_AGENT_HOME' $previousHome
        }
        throw
    }
    $env:YOUTAB_AGENT_HOME = $selectedHome
    Write-Success "Registered validated Youtab home: $selectedHome"
}

function Write-BootstrapMarker {
    # Writes $InstallDir\.youtab-agent-runtime-bootstrap-complete which tells the Youtab
    # desktop app (apps/desktop/electron/main.ts) "install.ps1 ran
    # successfully -- DON'T trigger the legacy first-launch bootstrap
    # runner."
    #
    # Schema mirrors what main.ts's writeBootstrapMarker() / isBootstrap
    # Complete() expect. Keep this in lockstep when either side changes:
    #   apps/desktop/electron/main.ts lines 1199-1222
    #   BOOTSTRAP_MARKER_SCHEMA_VERSION = 1 (line 187)
    #
    # Pinned commit/branch come from -Commit + -Branch flags (passed by
    # Youtab-Setup.exe) or fall back to whatever git resolves in the
    # checkout. The desktop validates schemaVersion + pinnedCommit
    # length but doesn't enforce that HEAD matches the pin (users
    # update via `youtab update` which moves HEAD legitimately).
    if (-not (Test-Path $InstallDir)) {
        Write-Warn "Skipping bootstrap marker: $InstallDir doesn't exist"
        return
    }

    # Resolve the pinned commit: explicit -Commit wins, otherwise read
    # the checkout's HEAD via git. If git can't run, leave commit empty
    # and the marker will fail desktop validation (pinnedCommit.length
    # >= 7) -- better to be invalid than wrong.
    $pinnedCommit = $Commit
    if (-not $pinnedCommit) {
        # PS 5.1 doesn't support the ?. null-conditional operator, so
        # check Get-Command's result explicitly before reading .Source.
        $gitCmd = Get-Command git -ErrorAction SilentlyContinue
        $gitExe = if ($gitCmd) { $gitCmd.Source } else { $null }
        if ($gitExe) {
            Push-Location $InstallDir
            try {
                $resolved = & $gitExe rev-parse HEAD 2>$null
                if ($LASTEXITCODE -eq 0 -and $resolved) {
                    $pinnedCommit = $resolved.Trim()
                }
            } catch {
                # Ignore -- pinnedCommit stays empty, marker stays invalid,
                # desktop falls through to its legacy bootstrap path.
            } finally {
                Pop-Location
            }
        }
    }

    $pinnedBranch = $Branch
    if (-not $pinnedBranch) {
        $pinnedBranch = "main"  # install.ps1's own default for -Branch
    }

    $markerPath = Join-Path $InstallDir ".youtab-agent-runtime-bootstrap-complete"
    $marker = [ordered]@{
        schemaVersion = 1
        pinnedCommit  = $pinnedCommit
        pinnedBranch  = $pinnedBranch
        completedAt   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        # desktopVersion field intentionally omitted -- only the desktop
        # app knows its own version, and the marker validator doesn't
        # require it. The desktop fills it in if/when it writes its
        # own marker (e.g. after a future in-app upgrade).
    }
    $json = $marker | ConvertTo-Json -Compress:$false

    # Write WITHOUT a UTF-8 BOM. PowerShell 5.1's `Set-Content -Encoding UTF8`
    # always emits a BOM, and Node's plain JSON.parse rejects the BOM as an
    # unexpected character -- so a BOM'd marker would silently fail the
    # desktop's readJson(), make isBootstrapComplete() return null, and the
    # desktop would re-run the legacy bootstrap runner anyway. Defeats the
    # whole point. Use the .NET API directly for BOM-less UTF-8.
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($markerPath, $json, $utf8NoBom)

    Write-Success "Bootstrap marker written: $markerPath"
}

function Copy-ConfigTemplates {
    Write-Info "Setting up configuration files..."
    if ($PrivateHomeRelocation) {
        $pythonExe = Join-Path $InstallDir 'venv\Scripts\python.exe'
        & $pythonExe -I -S -B (Join-Path $InstallDir 'scripts\youtab\relocation_seed.py') apply $InstallDir $YoutabHome
        if ($LASTEXITCODE -ne 0) { throw 'Journal-bound missing-default seeding failed' }
        Write-Success "Journal-bound defaults ready: $YoutabHome"
        return
    }
    
    # Create the YOUTAB_AGENT_HOME directory structure ($YoutabHome, default %LOCALAPPDATA%\youtab)
    New-Item -ItemType Directory -Force -Path "$YoutabHome\cron" | Out-Null
    New-Item -ItemType Directory -Force -Path "$YoutabHome\sessions" | Out-Null
    New-Item -ItemType Directory -Force -Path "$YoutabHome\logs" | Out-Null
    New-Item -ItemType Directory -Force -Path "$YoutabHome\pairing" | Out-Null
    New-Item -ItemType Directory -Force -Path "$YoutabHome\hooks" | Out-Null
    New-Item -ItemType Directory -Force -Path "$YoutabHome\image_cache" | Out-Null
    New-Item -ItemType Directory -Force -Path "$YoutabHome\audio_cache" | Out-Null
    New-Item -ItemType Directory -Force -Path "$YoutabHome\memories" | Out-Null
    New-Item -ItemType Directory -Force -Path "$YoutabHome\skills" | Out-Null

    
    # Create .env
    $envPath = "$YoutabHome\.env"
    if (-not (Test-Path $envPath)) {
        $examplePath = "$InstallDir\.env.example"
        if (Test-Path $examplePath) {
            Copy-Item $examplePath $envPath
            Write-Success "Created $envPath from template"
        } else {
            New-Item -ItemType File -Force -Path $envPath | Out-Null
            Write-Success "Created $envPath"
        }
    } else {
        Write-Info "$envPath already exists, keeping it"
    }
    
    # Create config.yaml
    $configPath = "$YoutabHome\config.yaml"
    if (-not (Test-Path $configPath)) {
        $examplePath = "$InstallDir\cli-config.yaml.example"
        if (Test-Path $examplePath) {
            Copy-Item $examplePath $configPath
            Write-Success "Created $configPath from template"
        }
    } else {
        Write-Info "$configPath already exists, keeping it"
    }
    
    # Create SOUL.md if it doesn't exist (global persona file).
    # IMPORTANT: write without a BOM.  Windows PowerShell 5.1's
    # ``Set-Content -Encoding UTF8`` writes UTF-8 WITH a byte-order-mark
    # (the default PS5 behaviour), and Youtab's prompt-injection scanner
    # flags the BOM as an invisible unicode character and refuses to
    # load the file.  PS7's ``-Encoding utf8NoBOM`` fixes that but we
    # don't control which PowerShell version the user has.  Go direct
    # to .NET with an explicit UTF8Encoding($false) -- BOM-free on every
    # PowerShell version.
    $soulPath = "$YoutabHome\SOUL.md"
    if (-not (Test-Path $soulPath)) {
        # MUST match DEFAULT_SOUL_MD in youtab_agent_cli/default_soul.py. The runtime
        # upgrades the old comment-only scaffold to this text on next run, so
        # drift is self-healing, but keep them in sync to avoid first-run churn.
        $soulContent = @"
You are Youtab Agent Runtime, an intelligent AI assistant created by Youtab B.V.. You are helpful, knowledgeable, and direct. You assist users with a wide range of tasks including answering questions, writing and editing code, analyzing information, creative work, and executing actions via your tools. You communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose unless otherwise directed below. Be targeted and efficient in your exploration and investigations.
"@
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($soulPath, $soulContent, $utf8NoBom)
        Write-Success "Created $soulPath (edit to customize personality)"
    }
    
    Write-Success "Configuration directory ready: $YoutabHome"
    
    # Seed bundled skills into $YoutabHome\skills (manifest-based, one-time per skill)
    Write-Info "Syncing bundled skills to $YoutabHome\skills ..."
    $pythonExe = "$InstallDir\venv\Scripts\python.exe"
    if (Test-Path $pythonExe) {
        try {
            # Force the child python.exe to emit UTF-8 on its stdout/stderr.
            # On non-UTF-8 Windows locales (CP936/GBK zh-CN) Python defaults
            # its stream encoding to the active codepage and crashes on glyphs
            # like the checkmark (U+2713) that the codepage can't encode; the
            # resulting non-UTF-8 bytes break this script's JSON result frame on
            # stdout and abort the config-templates stage. Scope to this call
            # only. (Comment kept ASCII per this file's PS 5.1 contract above.)
            $prevPythonioencoding = $env:PYTHONIOENCODING
            $prevPythonutf8 = $env:PYTHONUTF8
            $env:PYTHONIOENCODING = "utf-8"
            $env:PYTHONUTF8 = "1"
            try {
                if ($PrivateHomeRelocation) {
                    $env:YOUTAB_AGENT_BUNDLED_SKILLS = Join-Path $InstallDir 'skills'
                    & $pythonExe @script:RelocationPythonArgs "$InstallDir\tools\skills_sync.py" --missing-only 2>$null
                    if ($LASTEXITCODE -ne 0) { throw 'Missing-only packaged skills seeding failed' }
                } else { & $pythonExe @script:RelocationPythonArgs "$InstallDir\tools\skills_sync.py" 2>$null }
            } finally {
                $env:PYTHONIOENCODING = $prevPythonioencoding
                $env:PYTHONUTF8 = $prevPythonutf8
            }
            Write-Success "Skills synced to $YoutabHome\skills"
        } catch {
            if ($PrivateHomeRelocation) { throw }
            # Fallback: simple directory copy
            $bundledSkills = "$InstallDir\skills"
            $userSkills = "$YoutabHome\skills"
            if ((Test-Path $bundledSkills) -and -not (Get-ChildItem $userSkills -Exclude '.bundled_manifest' -ErrorAction SilentlyContinue)) {
                Copy-Item -Path "$bundledSkills\*" -Destination $userSkills -Recurse -Force -ErrorAction SilentlyContinue
                Write-Success "Skills copied to $YoutabHome\skills"
            }
        }
    }
}

function Install-NodeDeps {
    if ($script:CustomerReleaseMode) {
        $node = Assert-CustomerPrebuiltFile -RelativePath 'node/node.exe'
        $pin = Get-PinnedNodeArchive -Arch 'x64'
        if ((Get-FileSha256 -Path $node) -cne $pin.ExeSha256 -or
            (& $node --version) -cne "v$($pin.Version)") {
            throw 'Bundled customer Node.js differs from the reviewed Windows x64 release'
        }
        Assert-CustomerPrebuiltFile -RelativePath 'browser/agent-browser.exe' | Out-Null
        Assert-CustomerPrebuiltFile -RelativePath 'browser/ms-playwright/browsers.json' | Out-Null
        Assert-CustomerPrebuiltFile -RelativePath 'ui-tui/dist/entry.js' | Out-Null
        Assert-CustomerPrebuiltFile -RelativePath 'youtab_agent_cli/web_dist/index.html' | Out-Null
        $browserRoot = Join-Path $InstallDir 'browser\ms-playwright'
        $env:PLAYWRIGHT_BROWSERS_PATH = $browserRoot
        $env:Path = "$(Split-Path $node -Parent);$(Join-Path $InstallDir 'browser');$env:Path"
        $script:HasNode = $true
        Write-Success 'Verified producer-built Node, browser and TUI; no customer npm or native build'
        return
    }
    if (-not $HasNode) {
        # Cross-process driver mode (Youtab-Setup.exe runs each -Stage NAME
        # in a fresh powershell.exe) means $script:HasNode set by Stage-Node
        # in the previous process isn't visible here. Re-probe rather than
        # trust the stale global -- Stage-Node already ran successfully or
        # the bootstrap would've aborted, so npm is reachable.
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            Write-Info "Skipping Node.js dependencies (Node not installed)"
            return
        }
    }

    # npm lifecycle scripts need node.exe on the PATH visible to child
    # cmd.exe processes.  Stage-Node may have run in a prior process, so
    # re-apply here before any npm install (regression #48130).
    Ensure-NodeExeOnPath | Out-Null

    # Resolve npm explicitly to npm.cmd, NOT npm.ps1.  Node.js on Windows
    # ships BOTH npm.cmd (a batch shim) and npm.ps1 (a PowerShell shim).
    # Get-Command's default ordering picks whichever comes first in PATHEXT,
    # and on many systems that's .ps1 -- but .ps1 requires scripts to be
    # enabled in PowerShell's execution policy, which most Windows users
    # don't have (the Restricted / RemoteSigned default blocks unsigned
    # .ps1 files).  .cmd has no such restriction and works on every box.
    #
    # Strategy: look next to the npm shim we found and prefer npm.cmd if
    # it exists in the same directory.  Fall back to whatever Get-Command
    # returned if we can't find a .cmd sibling.
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        if ($script:CustomerReleaseMode) {
            throw 'Customer browser dependencies require npm from the verified managed Node.js installation.'
        }
        Write-Warn "npm not found on PATH -- skipping Node.js dependencies."
        Write-Info "Open a new PowerShell window and re-run 'youtab setup tools' later."
        return
    }
    $npmExe = $npmCmd.Source
    if ($npmExe -like "*.ps1") {
        $npmCmdSibling = Join-Path (Split-Path $npmExe -Parent) "npm.cmd"
        if (Test-Path $npmCmdSibling) {
            Write-Info "Using npm.cmd (PowerShell execution policy blocks npm.ps1)"
            $npmExe = $npmCmdSibling
        } else {
            Write-Warn "Only npm.ps1 available -- install may fail if script execution is disabled."
            Write-Info "  If it fails, either enable PS script execution or install Node via winget."
        }
    }

    # Helper: run locked npm ci for customer releases or npm install for
    # development, and surface the real error when it fails.
    #
    # Implementation note: ``Start-Process -FilePath npm.cmd`` fails with
    # ``%1 is not a valid Win32 application`` on some PowerShell versions
    # because Start-Process bypasses cmd.exe / PATHEXT and expects a real
    # PE file.  The invocation-operator ``& $npmExe`` routes through the
    # PowerShell command pipeline which DOES honour .cmd batch shims, so
    # it works uniformly for npm.cmd, npx.cmd, and bare .exe files.
    function _Run-NpmInstall([string]$label, [string]$installDir, [string]$logPath, [string]$npmPath) {
        Push-Location $installDir
        # Capture EAP outside the try block so the catch's restore call always
        # has a meaningful value (see Install-Uv for the full rationale).
        $prevEAP = $ErrorActionPreference
        try {
            # Stream npm's output to BOTH the console and the log file via
            # Tee-Object.  Previously this called ``& npm install --silent
            # *> $logPath`` which redirected every stream to disk and left
            # the user staring at a frozen "Installing..." line for the
            # duration of the install.  On a fresh VM that's 1-3 minutes
            # of total silence, indistinguishable from a hang.
            #
            # Tee writes the live output to stdout AND $logPath; we still
            # capture the exit code afterwards and surface diagnostics
            # on failure.  Note: 2>&1 merges npm's stderr into the success
            # stream first because Tee-Object only sees the success
            # stream of the pipeline.  ForEach-Object { "$_" } coerces
            # each item to a string so PowerShell's NativeCommandError
            # formatter doesn't wrap stderr lines as alarming red blocks
            # (cosmetic polish; the underlying text is unchanged).
            #
            # Relax EAP around the npm invocation: with EAP=Stop (set at
            # the top of this script), PowerShell wraps stderr lines from
            # native commands captured via 2>&1 as ErrorRecord objects and
            # throws on the first one -- even though npm exited 0.  This
            # is the same issue Test-Python and Install-Uv work around
            # for uv's stderr-emitting installer.  Check success via
            # $LASTEXITCODE, which is reliable regardless of stderr noise.
            $ErrorActionPreference = "Continue"
            $npmArgs = if ($script:CustomerReleaseMode) { @('ci', '--include', 'dev', '--silent') } else { @('install', '--silent') }
            & $npmPath @npmArgs 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $logPath
            $code = $LASTEXITCODE
            $ErrorActionPreference = $prevEAP
            if ($code -eq 0) {
                Write-Success "$label dependencies installed"
                Remove-Item -Force $logPath -ErrorAction SilentlyContinue
                return $true
            }
            Write-Warn "$label npm install failed -- exit code $code"
            if (Test-Path $logPath) {
                $errText = (Get-Content $logPath -Raw -ErrorAction SilentlyContinue)
                if ($errText) {
                    $snippet = if ($errText.Length -gt 1200) { $errText.Substring(0, 1200) + "..." } else { $errText }
                    Write-Info "  npm output:"
                    foreach ($line in $snippet -split "`n") {
                        Write-Host "    $line" -ForegroundColor DarkGray
                    }
                    Write-Info "  Full log: $logPath"
                    Show-NpmCertHint $errText | Out-Null
                }
            }
            Write-Info "Run manually later: cd `"$installDir`"; npm install"
            return $false
        } catch {
            if ($prevEAP) { $ErrorActionPreference = $prevEAP }
            Write-Warn "$label npm install could not be launched: $_"
            return $false
        } finally {
            Pop-Location
        }
    }

    # Browser tools
    if (Test-Path "$InstallDir\package.json") {
        if ($script:CustomerReleaseMode -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'package-lock.json') -PathType Leaf)) {
            throw 'Common Runtime is missing package-lock.json required for locked customer browser dependencies.'
        }
        Write-Info "Installing Node.js dependencies (browser tools)..."
        $browserLog = "$env:TEMP\youtab-npm-browser-$(Get-Random).log"
        $browserNpmOk = _Run-NpmInstall "Browser tools" $InstallDir $browserLog $npmExe
        if (-not $browserNpmOk -and $script:CustomerReleaseMode) {
            throw 'Customer browser dependency installation failed; see the npm browser log and retry Setup.'
        }

        # Install Playwright Chromium (mirrors scripts/install.sh behaviour for
        # Linux).  Without this, tools/browser_tool.py::check_browser_requirements
        # returns False (no Chromium under %LOCALAPPDATA%\ms-playwright), and the
        # browser_* tools are silently filtered out of the agent's tool schema.
        # System Chrome at "C:\Program Files\Google\Chrome\..." is NOT used by
        # agent-browser -- it expects a Playwright-managed Chromium.
        if ($browserNpmOk) {
            Write-Info "Installing browser engine (Playwright Chromium)..."
            # npx lives next to npm in the same bin dir.  Prefer .cmd to dodge
            # the same execution-policy gotcha that affects npm.ps1 (see above).
            $npmDir = Split-Path $npmExe -Parent
            $npxExe = $null
            foreach ($cand in @("npx.cmd", "npx.exe", "npx")) {
                $try = Join-Path $npmDir $cand
                if (Test-Path $try) { $npxExe = $try; break }
            }
            if (-not $npxExe) {
                $npxCmd = Get-Command npx -ErrorAction SilentlyContinue
                if ($npxCmd) { $npxExe = $npxCmd.Source }
            }
            if (-not $npxExe) {
                if ($script:CustomerReleaseMode) {
                    throw 'Customer browser engine installation requires npx from the verified managed Node.js installation.'
                }
                Write-Warn "npx not found -- cannot install Playwright Chromium."
                Write-Info "Run manually later: cd `"$InstallDir`"; npx playwright install chromium"
            } else {
                $pwLog = "$env:TEMP\youtab-playwright-install-$(Get-Random).log"
                Push-Location $InstallDir
                # Capture EAP outside the try block so the catch's restore call
                # always has a meaningful value (see Install-Uv for the full
                # rationale).
                $prevEAP = $ErrorActionPreference
                $playwrightReady = $false
                try {
                    # Playwright Chromium is ~170MB compressed and the
                    # download regularly takes 3-10 minutes on a fresh
                    # VM.  Tee the output to console + log so the user
                    # sees download progress in real time instead of
                    # staring at a silent prompt that looks hung.  See
                    # _Run-NpmInstall above for the same pattern and
                    # the rationale behind 2>&1 before the pipe.
                    Write-Info "(this can take several minutes -- streaming progress below)"
                    # Development uses --yes to auto-accept npx's package
                    # prompt. Customer releases use --no-install so a missing
                    # local locked Playwright package fails without fetching.
                    # Without either mode, npx 7+ blocks on stdin
                    # waiting for a y/N answer that never comes when this is
                    # invoked through a pipeline (Tee-Object disconnects stdin
                    # from the user's TTY), and the install hangs indefinitely
                    # after printing "Need to install the following packages:
                    # playwright@X.Y.Z".
                    #
                    # Relax EAP around the playwright invocation: playwright
                    # emits a "Chromium downloaded to ..." success banner to
                    # stderr after a successful install.  Under EAP=Stop, the
                    # 2>&1 merge wraps those stderr lines as ErrorRecord
                    # objects and throws -- causing this catch block to fire
                    # with a mangled banner as the error message even though
                    # the install actually succeeded.  Check $LASTEXITCODE
                    # instead, which is the reliable signal.
                    #
                    # The ForEach-Object { "$_" } coercion BEFORE Tee-Object
                    # is a cosmetic polish: with bare 2>&1, PowerShell still
                    # renders stderr lines through its NativeCommandError
                    # formatter (the red "npx.cmd : ..." block).  Coercing
                    # each pipeline item to a string strips that wrapper so
                    # the user sees clean playwright output instead of the
                    # alarming-looking error formatting.
                    $ErrorActionPreference = "Continue"
                    # The customer dependency tree came from npm ci. Never let
                    # npx resolve a newer remote Playwright package at install
                    # time; --no-install requires the lockfile's local CLI.
                    $npxMode = if ($script:CustomerReleaseMode) { '--no-install' } else { '--yes' }
                    & $npxExe $npxMode playwright install chromium 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $pwLog
                    $pwCode = $LASTEXITCODE
                    $ErrorActionPreference = $prevEAP
                    if ($pwCode -eq 0) {
                        if ($script:CustomerReleaseMode) {
                            # A zero CLI exit is not enough: require the exact
                            # locked Playwright package to resolve an executable
                            # that actually exists on this user's disk.
                            & node -e 'const fs = require("node:fs"); const p = require("playwright").chromium.executablePath(); process.exit(fs.existsSync(p) ? 0 : 1)' 2>&1 | ForEach-Object { "$_" } | Out-Null
                            $playwrightReady = $LASTEXITCODE -eq 0
                        } else {
                            $playwrightReady = $true
                        }
                        if ($playwrightReady) {
                            Write-Success "Playwright Chromium installed (browser tools ready)"
                            Remove-Item -Force $pwLog -ErrorAction SilentlyContinue
                        } else {
                            Write-Warn 'Playwright Chromium executable is missing after installation.'
                        }
                    } else {
                        Write-Warn "Playwright Chromium install failed -- exit code $pwCode"
                        Write-Warn "Browser tools will not work until Chromium is installed."
                        if (Test-Path $pwLog) {
                            $pwErr = Get-Content $pwLog -Raw -ErrorAction SilentlyContinue
                            if ($pwErr) {
                                $snippet = if ($pwErr.Length -gt 1200) { $pwErr.Substring(0, 1200) + "..." } else { $pwErr }
                                Write-Info "  playwright output:"
                                foreach ($line in $snippet -split "`n") {
                                    Write-Host "    $line" -ForegroundColor DarkGray
                                }
                                Write-Info "  Full log: $pwLog"
                            }
                        }
                        Write-Info "Run manually later: cd `"$InstallDir`"; npx playwright install chromium"
                    }
                } catch {
                    if ($prevEAP) { $ErrorActionPreference = $prevEAP }
                    if ($script:CustomerReleaseMode) {
                        Write-Warn 'Playwright Chromium install could not be launched; see the installer log.'
                    } else {
                        Write-Warn "Playwright Chromium install could not be launched: $_"
                    }
                    Write-Info "Run manually later: cd `"$InstallDir`"; npx playwright install chromium"
                } finally {
                    Pop-Location
                }
                if ($script:CustomerReleaseMode -and -not $playwrightReady) {
                    throw 'Customer Playwright Chromium installation failed; see the browser engine log and retry Setup.'
                }
            }
        }
    } elseif ($script:CustomerReleaseMode) {
        throw 'Common Runtime is missing package.json required for customer browser tools.'
    }

    # TUI
    $tuiDir = "$InstallDir\ui-tui"
    if (Test-Path "$tuiDir\package.json") {
        if ($script:CustomerReleaseMode) {
            # ui-tui is a root npm workspace in package-lock.json. The root
            # npm ci above installs it from that same lock; a second npm call
            # here would re-resolve dependencies outside the release lock.
            $tuiWorkspace = Join-Path $InstallDir 'node_modules\youtab-tui\package.json'
            if (-not (Test-Path -LiteralPath $tuiWorkspace -PathType Leaf)) {
                throw 'Customer TUI workspace is missing after locked root dependency installation.'
            }
            Write-Success 'TUI dependencies installed from the root lockfile'
        } else {
            Write-Info "Installing TUI dependencies..."
            $tuiLog = "$env:TEMP\youtab-npm-tui-$(Get-Random).log"
            [void](_Run-NpmInstall "TUI" $tuiDir $tuiLog $npmExe)
        }
    }
    if ($script:CustomerReleaseMode) {
        # Stages are separate PowerShell processes. Record which source lock
        # produced this complete tree so Desktop can reuse it safely.
        $lockHash = (Get-FileHash -LiteralPath (Join-Path $InstallDir 'package-lock.json') -Algorithm SHA256).Hash
        $marker = Join-Path $InstallDir 'node_modules\.youtab-locked-deps.sha256'
        [System.IO.File]::WriteAllText($marker, $lockHash)
    }
}

# Clear the cached Electron download + any half-written unpacked output so the
# next `npm run pack` re-downloads and re-stages from scratch. A corrupt zip in
# the per-user Electron download cache - most often a partial download resumed
# into the same file, leaving concatenated junk - makes electron-builder's
# `app-builder unpack-electron` extract a tree MISSING the electron binary, so
# the final `electron` -> `Youtab` rename dies with ENOENT and every re-run
# repeats the broken extraction forever.
#
# We deliberately do not validate the zip ourselves: the common
# prepended/concatenated-junk corruption slips past naive checks, so a
# self-rolled gate would skip the real-world case. We unconditionally drop the
# cached electron-*.zip (loose copy and any @electron/get hash-subdir copy) plus
# the stale unpacked dir, then let the caller retry once - @electron/get
# re-downloads with its own SHASUM verification, the real source of truth.
#
# Returns the removed paths. Best-effort: never throws.
function Clear-ElectronBuildCache {
    param([string]$DesktopDir)
    $removed = @()

    # Per-user Electron download cache dirs, honoring the overrides @electron/get
    # respects, then the Windows default (%LOCALAPPDATA%\electron\Cache).
    $cacheDirs = @()
    if ($env:electron_config_cache) { $cacheDirs += $env:electron_config_cache }
    if ($env:ELECTRON_CACHE)        { $cacheDirs += $env:ELECTRON_CACHE }
    if ($env:LOCALAPPDATA)          { $cacheDirs += (Join-Path $env:LOCALAPPDATA 'electron\Cache') }
    $cacheDirs += (Join-Path $HOME 'AppData\Local\electron\Cache')

    foreach ($dir in $cacheDirs) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        # Recurse: the bad copy may be the top-level zip OR a copy inside an
        # @electron/get hash subdir.
        $removed += @(Get-ChildItem -LiteralPath $dir -Recurse -Filter 'electron-*.zip' -File -ErrorAction SilentlyContinue | ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; $_.FullName } catch { }
        })
    }

    # A half-written unpacked dir from an interrupted prior pack poisons the
    # rename even after the zip is fixed (win-unpacked / win-arm64-unpacked).
    $releaseDir = Join-Path $DesktopDir 'release'
    if (Test-Path -LiteralPath $releaseDir) {
        $removed += @(Get-ChildItem -LiteralPath $releaseDir -Directory -Filter '*-unpacked' -ErrorAction SilentlyContinue | ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop; $_.FullName } catch { }
        })
    }

    return $removed
}

# Last-resort Electron mirror after GitHub download fails (#47266).
$script:DesktopElectronFallbackMirror = "https://npmmirror.com/mirrors/electron/"

# Electron package dir -- workspace-local nest first, then root hoist.
function Get-ElectronDir {
    param([string]$InstallDir)
    $desktopLocal = Join-Path $InstallDir 'apps\desktop\node_modules\electron'
    if (Test-Path -LiteralPath $desktopLocal) { return $desktopLocal }
    return (Join-Path $InstallDir 'node_modules\electron')
}

# True when dist/ holds a usable Electron binary (#38673 / run-electron-builder.mjs).
function Test-ElectronDist {
    param([string]$InstallDir)
    $electronDir = Get-ElectronDir -InstallDir $InstallDir
    $distExe = Join-Path $electronDir 'dist\electron.exe'
    return (Test-Path -LiteralPath $distExe)
}

# Best-effort: run electron/install.js to populate dist/ (optional mirror).
function Restore-ElectronDist {
    param([string]$InstallDir, [string]$Mirror)
    if (Test-ElectronDist -InstallDir $InstallDir) { return $true }

    $electronDir = Get-ElectronDir -InstallDir $InstallDir
    $distExe = Join-Path $electronDir 'dist\electron.exe'
    $installer = Join-Path $electronDir 'install.js'
    if (-not (Test-Path -LiteralPath $installer)) { return $false }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }

    $distDir = Join-Path $electronDir 'dist'
    if (Test-Path -LiteralPath $distDir) {
        Remove-Item -LiteralPath $distDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath (Join-Path $electronDir 'path.txt') -Force -ErrorAction SilentlyContinue

    $prevMirror = $env:ELECTRON_MIRROR
    if ($Mirror) { $env:ELECTRON_MIRROR = $Mirror }
    try {
        # Out-Host so the downloader's progress shows on the console WITHOUT
        # leaking into this function's return value (PowerShell returns every
        # object left on the output stream, so a bare pipe here would make the
        # boolean below ambiguous).
        & $node.Source $installer 2>&1 | ForEach-Object { "$_" } | Out-Host
    } catch {
    } finally {
        $env:ELECTRON_MIRROR = $prevMirror
    }
    return (Test-Path -LiteralPath $distExe)
}

function Test-ElectronPkgStagedMissingDist {
    param([string]$InstallDir)
    $electronDir = Get-ElectronDir -InstallDir $InstallDir
    return (
        (Test-Path -LiteralPath (Join-Path $electronDir 'package.json')) -and
        (Test-Path -LiteralPath (Join-Path $electronDir 'install.js')) -and
        (-not (Test-ElectronDist -InstallDir $InstallDir))
    )
}

function Try-RestoreElectronDist {
    param([string]$InstallDir)
    if (Restore-ElectronDist -InstallDir $InstallDir) { return $true }
    if ($env:ELECTRON_MIRROR) { return $false }
    return Restore-ElectronDist -InstallDir $InstallDir -Mirror $script:DesktopElectronFallbackMirror
}

function Install-DesktopVoiceDeps {
    if ($script:CustomerReleaseMode) {
        if (-not $script:UvCmd) { Resolve-UvCmd }
        if (-not $script:UvCmd) { throw 'Customer locked voice dependencies require uv.' }
        $ptySdk = Get-WindowsPtySdkContext
        Invoke-CustomerLockedDependencySync -Extra @('wake', 'voice')
        Assert-WindowsPtySdk -Context $ptySdk
        Write-Success 'Voice + wake-word dependencies installed from shipped lock'
        return
    }
    # Desktop ships with working voice out of the box: eagerly install the
    # wake-word + local-STT stacks ([wake] + [voice] extras) instead of
    # leaving them to lazy first-use install. Policy change (Teknium, July
    # 2026, #70509 testing): the first ear-click used to trigger a
    # multi-minute onnxruntime pip install that froze the UI and blew RPC
    # timeouts. Best-effort -- lazy install remains the fallback for anything
    # this step fails to fetch.
    if (-not $script:UvCmd) { Resolve-UvCmd }
    if (-not $script:UvCmd) {
        Write-Warn "uv unavailable -- voice/wake deps will lazy-install at first use instead"
        return
    }
    $ptySdk = Get-WindowsPtySdkContext
    if (-not $NoVenv) { $env:VIRTUAL_ENV = "$InstallDir\venv" }
    Write-Info "Installing voice + wake-word dependencies (onnxruntime, faster-whisper -- 1-3min)..."
    Push-Location $InstallDir
    try {
        $ptySdk = Get-WindowsPtySdkContext -PythonExe $ptySdk.PythonExe
        Invoke-NativeWithRelaxedErrorAction { & $UvCmd pip install -e ".[wake,voice]" --python $ptySdk.PythonExe --find-links $ptySdk.VendorDir $ptySdk.Wheel }
        $voiceInstallExit = $LASTEXITCODE
        Assert-WindowsPtySdk -Context $ptySdk
        if ($voiceInstallExit -eq 0) {
            Write-Success "Voice + wake-word dependencies installed"
        } else {
            Write-Warn "Voice/wake dependency install failed (exit $voiceInstallExit) -- they will lazy-install at first use"
        }
    } finally {
        Pop-Location
    }
}

function Install-Desktop {
    if ($script:CustomerReleaseMode) {
        $desktopExe = Assert-CustomerPrebuiltFile -RelativePath 'apps/desktop/release/win-unpacked/Youtab.exe'
        Assert-CustomerPrebuiltFile -RelativePath 'apps/desktop/release/win-unpacked/resources/app.asar' | Out-Null
        Assert-CustomerPrebuiltFile -RelativePath 'apps/desktop/release/win-unpacked/resources/install-stamp.json' | Out-Null
        Assert-CustomerPrebuiltFile -RelativePath 'apps/desktop/release/win-unpacked/resources/app.asar.unpacked/dist/native/setup_lease.node' | Out-Null
        $stampPath = Join-Path $InstallDir 'apps\desktop\release\win-unpacked\resources\install-stamp.json'
        $stamp = [IO.File]::ReadAllText($stampPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($stamp.commit -cne $Commit -or $stamp.dirty -ne $false) {
            throw 'Prebuilt customer Desktop stamp differs from the requested release'
        }
        if (-not $PrivateHomeRelocation) { New-DesktopShortcuts -TargetExe $desktopExe }
        Write-Success 'Verified producer-built Desktop; no customer Electron build'
        return
    }
    function Test-CustomerLockedNodeDeps {
        param([string]$InstallDir)
        $lock = Join-Path $InstallDir 'package-lock.json'
        $marker = Join-Path $InstallDir 'node_modules\.youtab-locked-deps.sha256'
        if (-not (Test-Path -LiteralPath $lock -PathType Leaf) -or -not (Test-Path -LiteralPath $marker -PathType Leaf)) {
            return $false
        }
        $expected = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash
        $actual = [System.IO.File]::ReadAllText($marker).Trim()
        if ($actual -ne $expected) { return $false }
        foreach ($required in @('node_modules\.package-lock.json', 'node_modules\typescript\package.json', 'node_modules\youtab-tui\package.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $required) -PathType Leaf)) { return $false }
        }
        return (Test-ElectronDist -InstallDir $InstallDir)
    }
    # Build apps/desktop into a launchable Youtab.exe. Only called from
    # Stage-Desktop, which is itself only included in the manifest when
    # -IncludeDesktop was passed to install.ps1.
    #
    # The root npm workspace includes browser tools, TUI and apps/desktop.
    # Customer releases reuse the Stage-NodeDeps tree when its lock hash and
    # required packages still match. A resumed Desktop stage repairs an
    # incomplete tree with npm ci, then npm run pack in apps/desktop
    # produces the unpacked binary at apps/desktop/release/<os>-unpacked/.
    #
    # The Tauri bootstrap installer's launch_youtab_desktop command
    # resolves apps/desktop/release/win-unpacked/Youtab.exe directly,
    # so an "unpacked" build (electron-builder --dir) is enough -- we
    # don't need to produce an NSIS/MSI artifact here.

    # Always re-resolve Node here. Stages run in separate PowerShell processes,
    # so $script:HasNode from Stage-Node isn't visible; more importantly Test-Node
    # enforces the build floor (>=22.12) and prepends the Youtab-managed
    # Node to PATH, so the build never runs on a too-old system Node -- the cause
    # of the opaque "Build desktop app ... exit code 1" failure (Vite crashes on
    # old Node).
    Test-Node | Out-Null
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        if ($script:CustomerReleaseMode) { throw 'Customer Desktop build requires Node.js >=22.12 and npm.' }
        Write-Warn "Skipping desktop build (Node.js / npm not on PATH)"
        $script:_StageSkippedReason = "Node.js not available"
        return
    }

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $nodeVersion = $null
    $nodeExit = 1
    if ($nodeCmd -and $nodeCmd.Source) {
        try { $nodeVersion = & $nodeCmd.Source --version; $nodeExit = $LASTEXITCODE } catch { }
    }
    if (-not $script:HasNode -or $nodeExit -ne 0 -or -not (Test-NodeVersionOk $nodeVersion)) {
        if ($script:CustomerReleaseMode) { throw 'Customer Desktop build requires a verified Node.js >=22.12 executable.' }
        Write-Warn 'Skipping desktop build (verified Node.js >=22.12 unavailable)'
        $script:_StageSkippedReason = 'Node.js >=22.12 not available'
        return
    }

    $desktopDir = "$InstallDir\apps\desktop"
    if (-not (Test-Path "$desktopDir\package.json")) {
        Write-Warn "Skipping desktop build (apps/desktop not present in checkout)"
        $script:_StageSkippedReason = "apps/desktop not present"
        return
    }

    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        Write-Warn "Skipping desktop build (npm not on PATH)"
        $script:_StageSkippedReason = "npm not found"
        return
    }
    $npmExe = $npmCmd.Source
    if ($npmExe -like "*.ps1") {
        $sibling = Join-Path (Split-Path $npmExe -Parent) "npm.cmd"
        if (Test-Path $sibling) { $npmExe = $sibling }
    }

    # 1. Workspace-level install so apps/desktop's deps (Electron, Vite,
    # node-pty prebuilds, etc.) actually land in node_modules. This is
    # the SAME `npm install` Install-NodeDeps does for browser tools,
    # but at the root rather than the browser-tools workspace, so all
    # apps/* workspaces resolve.
    $reuseLockedDeps = $script:CustomerReleaseMode -and (Test-CustomerLockedNodeDeps -InstallDir $InstallDir)
    if ($reuseLockedDeps) {
        Write-Success 'Reusing verified locked workspace dependencies from Stage-NodeDeps'
    } else {
    Write-Info "Installing desktop workspace dependencies (this includes Electron ~150MB, takes 1-3min)..."
    Push-Location $InstallDir
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        # Drop --silent so npm emits its full progress + error trail.
        # When this fails on a non-dev box (e.g. native-module build
        # without VS Build Tools, ETARGET on a transitive, etc.), the
        # actual reason needs to reach the Tauri installer's log; with
        # --silent it was completely suppressed and the user just saw
        # "exit 1" with no actionable detail.
        #
        # The streaming sink in bootstrap.rs's run_install_script
        # captures every stdout/stderr line as it's emitted, so we don't
        # need a side TEMP log file -- the installer's bootstrap log
        # IS the artifact a support engineer reads.
        #
        # Prefer `npm ci`: it wipes node_modules and reinstalls from the
        # lockfile, always producing a complete tree. Bare `npm install`
        # can report "up to date" against a stale
        # node_modules\.package-lock.json marker while node_modules is
        # actually empty (Windows workspace-hoisting flake), leaving
        # tsc/typescript unresolved so `npm run pack`'s `tsc -b` dies with
        # no obvious cause. Only development/legacy installs may fall back
        # to `npm install`. Customer releases must retain the verified
        # lockfile and stop if its exact dependency install fails.
        #
        # Tee the merged output into $npmOut while still emitting every line
        # live. We don't need a side log file (the bootstrap streaming sink
        # is the artifact), but on failure we scan $npmOut for the TLS-trust
        # signature so corporate-proxy users get the NODE_EXTRA_CA_CERTS hint
        # instead of an opaque "exit 1" (issue #38016).
        [string[]]$desktopNpmArgs = if ($script:CustomerReleaseMode) { @('ci', '--include', 'dev') } else { @('ci') }
        & $npmExe @desktopNpmArgs 2>&1 | ForEach-Object { "$_" } | Tee-Object -Variable npmOut
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            if ($script:CustomerReleaseMode) {
                Show-NpmCertHint ($npmOut -join "`n") | Out-Null
                throw "desktop locked dependencies failed to install (npm ci exit $code) -- see lines above for cause"
            }
            Write-Info "  npm ci failed (exit $code) -- retrying with npm install..."
            & $npmExe install 2>&1 | ForEach-Object { "$_" } | Tee-Object -Variable npmOut
            $code = $LASTEXITCODE
        }
        $ErrorActionPreference = $prevEAP
        if ($code -ne 0) {
            if (Test-ElectronPkgStagedMissingDist -InstallDir $InstallDir) {
                Write-Warn "Desktop dependency install failed with a missing Electron dist; attempting self-heal..."
                Try-RestoreElectronDist -InstallDir $InstallDir | Out-Null
            } else {
                Show-NpmCertHint ($npmOut -join "`n") | Out-Null
                throw "desktop workspace npm install failed (exit $code) -- see lines above for cause"
            }
        } else {
            Write-Success "Desktop workspace dependencies installed"
        }
    } catch {
        if ($prevEAP) { $ErrorActionPreference = $prevEAP }
        Pop-Location
        throw
    }
    Pop-Location

    }
    # 2. Build apps/desktop. `npm run pack` runs:
    #      assert-root-install + write-build-stamp + stage-native-deps +
    #      tsc -b + vite build + electron-builder --dir
    # The --dir mode produces an unpacked Youtab.exe in
    # apps/desktop/release/win-unpacked/ without bundling NSIS/MSI;
    # we don't need a distributable installer artifact, just a
    # launchable binary the Tauri installer can spawn.
    #
    # CSC_IDENTITY_AUTO_DISCOVERY=false tells electron-builder we are
    # NOT signing the output. Combined with signAndEditExecutable=false in
    # apps/desktop/package.json's build.win block, electron-builder never
    # invokes signtool and therefore never fetches/extracts winCodeSign
    # (whose macOS symlinks crash 7-Zip on non-admin Windows -- a dead end we
    # are NOT trying to work around). The Youtab icon + product name are
    # stamped onto Youtab.exe by our own rcedit step (Set-DesktopExeIdentity)
    # AFTER this build, completely decoupled from electron-builder signing.
    #
    # WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD explicitly cleared as
    # belt-and-suspenders: if the user's environment has them set
    # for some other tool, electron-builder would still try to sign.
    Write-Info "Building desktop app (this takes 1-3 minutes)..."
    $buildLog = "$env:TEMP\youtab-desktop-build-$(Get-Random).log"
    # Seed GITHUB_SHA for write-build-stamp.mjs. The stamp prefers CI env vars
    # over `git rev-parse`, so this covers: (1) node can't find git.exe on PATH
    # even though this PowerShell session can, (2) ZIP/init trees that still
    # lack a HEAD after a failed post-extract fetch. Without it the desktop
    # pack dies with "could not determine git commit" (#50823).
    if ($script:CustomerReleaseMode) {
        # The archive has no .git directory.  Bind the Desktop stamp to the
        # exact SHA already validated against the immutable release manifest.
        $env:GITHUB_SHA = $Commit
        if ($CoordinationSetupSourceSha -cne $Commit -or
            $CoordinationSetupSha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $CoordinationSetupSize -le 0 -or $CoordinationSetupSize -gt 268435456) {
            throw "Customer Desktop build requires verified common Setup identity"
        }
        $env:YOUTAB_AGENT_CUSTOMER_BUILD = '1'
        $env:YOUTAB_AGENT_COORDINATION_SETUP_PATH = Join-Path $YoutabHome 'youtab-setup.exe'
        $env:YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY = (@{
            protocol = 1; sourceSha = $CoordinationSetupSourceSha
            sha256 = $CoordinationSetupSha256; size = $CoordinationSetupSize
        } | ConvertTo-Json -Compress)
    } elseif (-not $env:GITHUB_SHA) {
        if ($Commit) {
            $env:GITHUB_SHA = $Commit
        } else {
            Push-Location $InstallDir
            try {
                $global:LASTEXITCODE = 0
                $resolvedSha = & git -c windows.appendAtomically=false rev-parse HEAD 2>$null
                if ($LASTEXITCODE -ne 0 -or -not $resolvedSha) {
                    # ZIP path may have FETCH_HEAD after a fetch even when HEAD is unset.
                    $global:LASTEXITCODE = 0
                    $resolvedSha = & git -c windows.appendAtomically=false rev-parse FETCH_HEAD 2>$null
                }
                if ($LASTEXITCODE -eq 0 -and $resolvedSha) {
                    $env:GITHUB_SHA = ("$resolvedSha").Trim()
                }
            } catch { } finally {
                Pop-Location
            }
        }
    }
    if (-not $env:GITHUB_REF_NAME) {
        $env:GITHUB_REF_NAME = if ($Branch) { $Branch } else { "main" }
    }
    if ($env:GITHUB_SHA) {
        $shaPreview = if ($env:GITHUB_SHA.Length -ge 12) { $env:GITHUB_SHA.Substring(0, 12) } else { $env:GITHUB_SHA }
        Write-Info "Desktop build stamp: $shaPreview ($($env:GITHUB_REF_NAME))"
    } else {
        Write-Warn "Could not resolve a git commit for the desktop stamp -- write-build-stamp will use its non-git fallback"
    }
    Push-Location $desktopDir
    $prevEAP = $ErrorActionPreference
    $prevCSCAuto = $env:CSC_IDENTITY_AUTO_DISCOVERY
    $prevWinCscLink = $env:WIN_CSC_LINK
    $prevWinCscKeyPassword = $env:WIN_CSC_KEY_PASSWORD
    try {
        $ErrorActionPreference = "Continue"
        $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
        $env:WIN_CSC_LINK = ""
        $env:WIN_CSC_KEY_PASSWORD = ""
        & $npmExe run pack 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $buildLog
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            $purged = @()
            $restored = $false
            if (-not (Test-ElectronDist -InstallDir $InstallDir)) {
                $purged = @(Clear-ElectronBuildCache -DesktopDir $desktopDir)
                $restored = Restore-ElectronDist -InstallDir $InstallDir
            }
            if ($restored) {
                Write-Warn "Desktop build failed - refreshed the Electron download, retrying once:"
                foreach ($p in $purged) { Write-Info "  - $p" }
                & $npmExe run pack 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $buildLog
                $code = $LASTEXITCODE
            }
        }
        if ($code -ne 0 -and -not $env:ELECTRON_MIRROR) {
            $mirror = $script:DesktopElectronFallbackMirror
            Write-Warn "Desktop build still failing - the Electron download from GitHub looks blocked."
            Write-Warn "Re-downloading Electron via a public mirror ($mirror), then rebuilding:"
            Write-Info "  (set ELECTRON_MIRROR yourself to use a different/trusted mirror)"
            if (-not (Test-ElectronDist -InstallDir $InstallDir)) {
                Restore-ElectronDist -InstallDir $InstallDir -Mirror $mirror | Out-Null
            }
            $prevMirror = $env:ELECTRON_MIRROR
            $env:ELECTRON_MIRROR = $mirror
            try {
                & $npmExe run pack 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $buildLog
                $code = $LASTEXITCODE
            } finally {
                $env:ELECTRON_MIRROR = $prevMirror
            }
        }
        $ErrorActionPreference = $prevEAP
        if ($code -ne 0) {
            $errText = Get-Content $buildLog -Raw -ErrorAction SilentlyContinue
            if ($errText) {
                $snippet = if ($errText.Length -gt 1800) { $errText.Substring(0, 1800) + "..." } else { $errText }
                Write-Info "  desktop build output:"
                foreach ($line in $snippet -split "`n") { Write-Host "    $line" -ForegroundColor DarkGray }
                Write-Info "  Full log: $buildLog"
            }
            throw "apps/desktop build failed (exit $code)"
        }
        Write-Success "Desktop app built"
        Remove-Item -Force $buildLog -ErrorAction SilentlyContinue
    } catch {
        if ($prevEAP) { $ErrorActionPreference = $prevEAP }
        Pop-Location
        throw
    } finally {
        # Restore env to whatever the caller had -- don't leak our
        # signing-off override into anything install.ps1 invokes later
        # (Stage-PlatformSdks, etc.).
        $env:CSC_IDENTITY_AUTO_DISCOVERY = $prevCSCAuto
        $env:WIN_CSC_LINK = $prevWinCscLink
        $env:WIN_CSC_KEY_PASSWORD = $prevWinCscKeyPassword
    }
    Pop-Location

    # 3. Sanity-check the produced binary. Probe both arches so this works
    # on x64 and arm64 build machines.
    $exeCandidates = @(
        "$desktopDir\release\win-unpacked\Youtab.exe",
        "$desktopDir\release\win-arm64-unpacked\Youtab.exe"
    )
    $found = $false
    $desktopExe = $null
    foreach ($cand in $exeCandidates) {
        if (Test-Path $cand) {
            Write-Success "Desktop ready: $cand"
            $desktopExe = $cand
            $found = $true
            break
        }
    }
    if (-not $found) {
        throw "Desktop build completed but no Youtab.exe was found under $desktopDir\release\*-unpacked\"
    }

    # 3b. The Youtab icon + identity are stamped onto Youtab.exe by the
    #     electron-builder `afterPack` hook (apps/desktop/scripts/after-pack.mjs)
    #     during `npm run pack` above -- for every build, so the installer's
    #     --update rebuild stays branded too. No separate stamp step needed here.
    #     electron-builder's own rcedit step stays disabled (signAndEditExecutable
    #     =false) because enabling it drags in signtool -> winCodeSign -> the
    #     unfixable symlink crash; the afterPack hook runs rcedit directly.

    # 3c. Grant ALL APPLICATION PACKAGES (S-1-15-2-2) RX on the unpacked app
    #     directory. Chromium's GPU/renderer sandboxes CHECK-fail with
    #     0x80000003 when this ACE is missing alongside orphan AppContainer
    #     SIDs under %LOCALAPPDATA% (electron/electron#51761, youtab-agent-runtime#38216).
    #     Best-effort -- never fail an otherwise-good install over ACL repair.
    try {
        $appDir = Split-Path -Parent $desktopExe
        & icacls $appDir /grant "*S-1-15-2-2:(OI)(CI)(RX)" /T /C /Q | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Granted AppContainer read access on $appDir"
        } else {
            Write-Warn "icacls AppContainer grant returned exit $LASTEXITCODE for $appDir"
        }
    } catch {
        Write-Warn "Could not grant AppContainer ACL: $($_.Exception.Message)"
    }

    # 4. Create Start Menu + Desktop shortcuts pointing DIRECTLY at the packed
    #    Youtab.exe. We deliberately do NOT point them at `youtab desktop`: that
    #    command rebuilds (npm install + electron-builder) on every launch,
    #    which would cost minutes each time. The packed exe is the consumer --
    #    launching it directly is instant, and updates flow through the
    #    installer's --update path (which rebuilds once, then relaunches).
    if (-not $PrivateHomeRelocation) { New-DesktopShortcuts -TargetExe $desktopExe }
}

function New-DesktopShortcuts {
    param([Parameter(Mandatory = $true)][string]$TargetExe)

    # Best-effort: a shortcut failure must never fail an otherwise-good install.
    try {
        $shell = New-Object -ComObject WScript.Shell
        $workDir = Split-Path -Parent $TargetExe

        # Prefer the standalone icon.ico (shipped beside the exe via
        # electron-builder extraResources -> resources/icon.ico) over the exe's
        # embedded resource. An explicit .ico path is more stable across update
        # cycles: pointing at "$TargetExe,0" makes Windows cache the icon it
        # extracted from the exe at shortcut-creation time, and that cached
        # bitmap can persist (showing the OLD/Electron icon) even after the exe
        # is re-stamped on update. A dedicated .ico sidesteps that extraction.
        $iconIco = Join-Path $workDir 'resources\icon.ico'
        if (Test-Path $iconIco) {
            $iconLocation = "$iconIco,0"
        } else {
            $iconLocation = "$TargetExe,0"
        }

        $targets = @(
            (Join-Path ([Environment]::GetFolderPath('Programs')) 'Youtab.lnk'),
            (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Youtab.lnk')
        )

        foreach ($lnkPath in $targets) {
            try {
                $parent = Split-Path -Parent $lnkPath
                if (-not (Test-Path $parent)) {
                    New-Item -ItemType Directory -Force -Path $parent | Out-Null
                }
                $sc = $shell.CreateShortcut($lnkPath)
                $sc.TargetPath = $TargetExe
                $sc.WorkingDirectory = $workDir
                $sc.IconLocation = $iconLocation
                $sc.Description = 'Youtab Agent Runtime'
                $sc.Save()
                Write-Success "Shortcut created: $lnkPath"
            } catch {
                Write-Warn "Could not create shortcut $lnkPath : $($_.Exception.Message)"
            }
        }

        # Bust the Windows shell icon cache so the desktop/Start-Menu shortcut
        # repaints with the (possibly newly-stamped) icon instead of a stale
        # cached bitmap. Critical on the --update path: the exe was re-stamped
        # with the Youtab icon, but without this the shortcut can keep drawing
        # the old Electron icon until the user manually refreshes / reboots.
        # Best-effort and silent -- never fail the install over a cosmetic cache.
        try {
            & ie4uinit.exe -show 2>$null
        } catch {
            # ie4uinit may be absent/renamed on some SKUs -- ignore.
        }
    } catch {
        Write-Warn "Skipping shortcut creation: $($_.Exception.Message)"
    }
}

function Install-PlatformSdks {
    if ($script:CustomerReleaseMode -and $NoVenv) { throw 'Customer platform SDKs require a locked virtual environment.' }
    # Ensure messaging-platform SDKs matching tokens the user added to
    # ~/.youtab-agent-runtime/.env are importable.  Two problems this solves:
    #
    # 1. The tiered `uv pip install` cascade above can fall through to a
    #    lower tier when the first fails (common when RL git deps choke),
    #    which silently skips some messaging SDKs from [messaging].
    # 2. `uv` creates the venv without pip.  If a messaging SDK ends up
    #    missing, the user can't `pip install python-telegram-bot` to
    #    recover -- pip simply isn't in their venv.
    #
    # Strategy: bootstrap pip via `python -m ensurepip` (idempotent), then
    # for each token set in .env, verify the matching SDK imports.  If not,
    # run one targeted `pip install` as last-chance recovery.  Keeps fresh
    # Windows installs from hitting silent "python-telegram-bot not installed"
    # at runtime.
    if ($NoVenv) {
        Write-Info "Skipping platform-SDK verification (-NoVenv: no venv to bootstrap)"
        return
    }

    $pythonExe = "$InstallDir\venv\Scripts\python.exe"
    if (-not (Test-Path $pythonExe)) {
        throw "Windows PTY SDK requires the final interpreter: $pythonExe not found"
    }
    $ptySdk = Get-WindowsPtySdkContext -PythonExe $pythonExe
    Assert-WindowsPtySdk -Context $ptySdk

    $envPath = "$YoutabHome\.env"
    if (-not (Test-Path $envPath)) { return }
    $envLines = Get-Content $envPath -ErrorAction SilentlyContinue

    # Map: env var set in .env -> (import name, pip spec matching [messaging] extra).
    # Specs mirror pyproject.toml to avoid version drift.
    $sdkMap = @(
        @{ Var = "TELEGRAM_BOT_TOKEN"; Import = "telegram";  Spec = "python-telegram-bot[webhooks]>=22.6,<23" },
        @{ Var = "DISCORD_BOT_TOKEN";  Import = "discord";   Spec = "discord.py[voice]>=2.7.1,<3" },
        @{ Var = "SLACK_BOT_TOKEN";    Import = "slack_sdk"; Spec = "slack-sdk>=3.27.0,<4" },
        @{ Var = "SLACK_APP_TOKEN";    Import = "slack_bolt";Spec = "slack-bolt>=1.18.0,<2" },
        @{ Var = "WHATSAPP_ENABLED";   Import = "qrcode";    Spec = "qrcode>=7.0,<8" }
    )

    # Which tokens are actually set (not placeholder)?
    $needed = @()
    foreach ($sdk in $sdkMap) {
        $match = $envLines | Where-Object {
            $_ -match ("^" + [regex]::Escape($sdk.Var) + "=.+") `
            -and $_ -notmatch "your-token-here" `
            -and $_ -notmatch "^\s*#"
        }
        if ($match) { $needed += $sdk }
    }
    if ($needed.Count -eq 0) { return }

    Write-Host ""
    Write-Info "Verifying platform SDKs for tokens found in $envPath ..."

    # Verify each SDK's import without triggering side-effect imports.
    # Quirk: PowerShell wraps non-zero-exit native stderr as a
    # NativeCommandError that prints even with `2>$null` / `*> $null`
    # unless we set $ErrorActionPreference to SilentlyContinue for the
    # span.  Save + restore rather than nuking globally.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        $missing = @()
        foreach ($sdk in $needed) {
            & $pythonExe @script:RelocationPythonArgs -c "import $($sdk.Import)" 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                $missing += $sdk
                Write-Warn "  $($sdk.Import) NOT importable (needed for $($sdk.Var))"
            } else {
                Write-Success "  $($sdk.Import) OK"
            }
        }
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($missing.Count -eq 0) { return }

    if ($script:CustomerReleaseMode) {
        # messaging is absent from curated [all]; retain required SDKs via its locked extra.
        Invoke-CustomerLockedDependencySync -Extra @('messaging')
        Assert-WindowsPtySdk -Context $ptySdk
        $prevEAP = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            foreach ($sdk in $missing) {
                & $pythonExe @script:RelocationPythonArgs -c "import $($sdk.Import)" 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Customer messaging SDK remains unavailable after locked repair.' }
            }
        } finally { $ErrorActionPreference = $prevEAP }
        return
    }

    # Bootstrap pip into the venv if it isn't there.  `uv` creates venvs
    # without pip; ensurepip is the stdlib-blessed way to add it.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        & $pythonExe @script:RelocationPythonArgs -m pip --version 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Info "Bootstrapping pip into venv (uv doesn't ship pip)..."
            & $pythonExe @script:RelocationPythonArgs -m ensurepip --upgrade 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "ensurepip failed -- can't auto-install missing SDKs."
                Write-Info "Manual recovery: $UvCmd pip install --python `"$pythonExe`" --find-links `"$($ptySdk.VendorDir)`" `"$($missing[0].Spec)`" `"$($ptySdk.Wheel)`""
                return
            }
        }

        foreach ($sdk in $missing) {
            Write-Info "  Installing $($sdk.Spec) ..."
            $ptySdk = Get-WindowsPtySdkContext -PythonExe $pythonExe
            & $pythonExe @script:RelocationPythonArgs -m pip install $sdk.Spec --find-links $ptySdk.VendorDir $ptySdk.Wheel 2>&1 | ForEach-Object { Write-Host "    $_" }
            $sdkInstallExit = $LASTEXITCODE
            Assert-WindowsPtySdk -Context $ptySdk
            if ($sdkInstallExit -eq 0) {
                Write-Success "  Installed $($sdk.Import)"
            } else {
                Write-Warn "  Failed to install $($sdk.Spec). Recover manually: $pythonExe -m pip install --find-links `"$($ptySdk.VendorDir)`" `"$($sdk.Spec)`" `"$($ptySdk.Wheel)`""
            }
        }
    } finally {
        $ErrorActionPreference = $prevEAP
    }
}

function Invoke-SetupWizard {
    if ($SkipSetup) {
        Write-Info "Skipping setup wizard (-SkipSetup)"
        return
    }

    if ($NonInteractive) {
        # The setup wizard prompts for API keys, model choice, persona, etc.
        # Non-interactive callers (GUI installer) own that UX themselves; let
        # them drive it after install.ps1 returns.
        Write-Info "Skipping setup wizard (non-interactive). Configure via the GUI or 'youtab setup'."
        return
    }

    Write-Host ""
    Write-Info "Starting setup wizard..."
    Write-Host ""

    Push-Location $InstallDir

    # Run youtab setup using the venv Python directly (no activation needed)
    if (-not $NoVenv) {
        & ".\venv\Scripts\python.exe" -m youtab_agent_cli.main setup
    } else {
        python -m youtab_agent_cli.main setup
    }

    Pop-Location
}

function Start-GatewayIfConfigured {
    $envPath = "$YoutabHome\.env"
    if (-not (Test-Path $envPath)) { return }

    $hasMessaging = $false
    $content = Get-Content $envPath -ErrorAction SilentlyContinue
    foreach ($var in @("TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "WHATSAPP_ENABLED")) {
        $match = $content | Where-Object { $_ -match "^${var}=.+" -and $_ -notmatch "your-token-here" }
        if ($match) { $hasMessaging = $true; break }
    }

    if (-not $hasMessaging) { return }

    $youtabCmd = "$InstallDir\venv\Scripts\youtab.exe"
    if (-not (Test-Path $youtabCmd)) {
        $youtabCmd = "youtab"
    }

    # If WhatsApp is enabled but not yet paired, run foreground for QR scan
    $whatsappEnabled = $content | Where-Object { $_ -match "^WHATSAPP_ENABLED=true" }
    $whatsappSession = "$YoutabHome\whatsapp\session\creds.json"
    if ($whatsappEnabled -and -not (Test-Path $whatsappSession)) {
        Write-Host ""
        Write-Info "WhatsApp is enabled but not yet paired."
        Write-Info "Running 'youtab whatsapp' to pair via QR code..."
        Write-Host ""
        # Non-interactive callers (GUI installer, CI) skip the QR-pair prompt;
        # WhatsApp pairing requires a human looking at a phone camera, so the
        # downstream UI is responsible for surfacing this when it makes sense.
        if (-not $NonInteractive) {
            $response = Read-Host "Pair WhatsApp now? [Y/n]"
            if ($response -eq "" -or $response -match "^[Yy]") {
                try {
                    & $youtabCmd whatsapp
                } catch {
                    # Expected after pairing completes
                }
            }
        } else {
            Write-Info "Skipping WhatsApp pairing prompt (non-interactive)."
        }
    }

    Write-Host ""
    Write-Info "Messaging platform token detected!"
    Write-Info "The gateway handles messaging platforms and cron job execution."
    Write-Host ""

    # In non-interactive mode the gateway lifecycle is the caller's problem
    # (the GUI manages its own gateway process, CI doesn't want background
    # services on the build agent, etc.).  Treat it like the user declined.
    if ($NonInteractive) {
        Write-Info "Skipping gateway autostart prompt (non-interactive)."
        Write-Info "Start the gateway later with: youtab gateway"
        return
    }

    $response = Read-Host "Would you like to start the gateway now? [Y/n]"

    if ($response -eq "" -or $response -match "^[Yy]") {
        Write-Info "Starting gateway in background..."
        try {
            $logFile = "$YoutabHome\logs\gateway.log"
            Start-Process -FilePath $youtabCmd -ArgumentList "gateway" `
                -RedirectStandardOutput $logFile `
                -RedirectStandardError "$YoutabHome\logs\gateway-error.log" `
                -WindowStyle Hidden
            Write-Success "Gateway started! Your bot is now online."
            Write-Info "Logs: $logFile"
            Write-Info "To stop: close the gateway process from Task Manager"
        } catch {
            Write-Warn "Failed to start gateway. Run manually: youtab gateway"
        }
    } else {
        Write-Info "Skipped. Start the gateway later with: youtab gateway"
    }
}

function Write-Completion {
    Write-Host ""
    Write-Host "+---------------------------------------------------------+" -ForegroundColor Green
    Write-Host "|              [OK] Installation Complete!                |" -ForegroundColor Green
    Write-Host "+---------------------------------------------------------+" -ForegroundColor Green
    Write-Host ""
    
    # Show file locations
    Write-Host "* Your files:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "   Config:    " -NoNewline -ForegroundColor Yellow
    Write-Host "$YoutabHome\config.yaml"
    Write-Host "   API Keys:  " -NoNewline -ForegroundColor Yellow
    Write-Host "$YoutabHome\.env"
    Write-Host "   Data:      " -NoNewline -ForegroundColor Yellow
    Write-Host "$YoutabHome\cron\, sessions\, logs\"
    Write-Host "   Code:      " -NoNewline -ForegroundColor Yellow
    Write-Host "$YoutabHome\youtab-agent-runtime\"
    Write-Host ""
    
    Write-Host "---------------------------------------------------------" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "* Commands:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "   youtab              " -NoNewline -ForegroundColor Green
    Write-Host "Start chatting"
    Write-Host "   youtab setup        " -NoNewline -ForegroundColor Green
    Write-Host "Configure API keys & settings"
    Write-Host "   youtab config       " -NoNewline -ForegroundColor Green
    Write-Host "View/edit configuration"
    Write-Host "   youtab config edit  " -NoNewline -ForegroundColor Green
    Write-Host "Open config in editor"
    Write-Host "   youtab gateway      " -NoNewline -ForegroundColor Green
    Write-Host "Start messaging gateway (Telegram, Discord, etc.)"
    Write-Host "   youtab update       " -NoNewline -ForegroundColor Green
    Write-Host "Update to latest version"
    Write-Host ""
    
    Write-Host "---------------------------------------------------------" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "[*] Restart your terminal for PATH changes to take effect" -ForegroundColor Yellow
    Write-Host ""
    
    if (-not $HasNode) {
        Write-Host "Note: Node.js could not be installed automatically." -ForegroundColor Yellow
        Write-Host "Browser tools need Node.js. Install manually:" -ForegroundColor Yellow
        Write-Host "  https://nodejs.org/en/download/" -ForegroundColor Yellow
        Write-Host ""
    }
    
    if (-not $HasRipgrep) {
        Write-Host "Note: ripgrep (rg) was not installed. For faster file search:" -ForegroundColor Yellow
        Write-Host "  winget install BurntSushi.ripgrep.MSVC" -ForegroundColor Yellow
        Write-Host ""
    }
}

# ============================================================================
# Stage protocol
# ============================================================================
#
# install.ps1 supports a small, stable "stage protocol" that lets programmatic
# callers (the desktop GUI's onboarding wizard, CI, future install.sh, etc.)
# drive the install one step at a time and surface progress/errors with their
# own UI.  CLI users running the canonical `irm | iex` one-liner never
# encounter this -- default invocation behaves exactly as before.
#
# Entry points:
#
#   install.ps1                       Interactive install (today's behavior).
#   install.ps1 -ProtocolVersion      Emit the protocol version integer.
#   install.ps1 -Manifest             Emit the stage manifest as JSON.
#   install.ps1 -Stage <name>         Run one stage and emit its result.
#   install.ps1 -NonInteractive       Disable all Read-Host prompts (also
#                                     skips the setup wizard and the gateway
#                                     autostart prompt).  Can be combined
#                                     with default invocation to do a full
#                                     non-interactive install.
#   install.ps1 -Json                 Emit machine-readable JSON instead of
#                                     the human-readable success banner at
#                                     the end of a full install.
#
# Manifest schema (the JSON returned by -Manifest):
#
#   {
#     "protocol_version": 1,
#     "stages": [
#       {
#         "name": "uv",
#         "title": "Installing uv package manager",
#         "category": "prereqs",
#         "needs_user_input": false
#       },
#       ...
#     ]
#   }
#
# Stage result (the JSON written by -Stage <name>):
#
#   {
#     "stage": "uv",
#     "ok": true,
#     "skipped": false,
#     "reason": null,
#     "duration_ms": 1234
#   }
#
# Exit codes:
#
#   0 -- success (stage ran, or stage was deliberately skipped).
#   1 -- generic failure; the stage threw.
#   2 -- unknown stage name passed to -Stage.
#
# Adding a stage:
#
#   1. Append an entry to $InstallStages below.
#   2. Make sure the worker function it points at is idempotent and respects
#      $NonInteractive when it has prompts.  Add it before "configure"
#      (the wizard) or "gateway" (autostart) if it should run unconditionally;
#      after those if it's optional post-install glue.
#   3. Do NOT bump $InstallStageProtocolVersion -- adding stages is additive.
#      Drivers iterate the manifest dynamically.
#
# ============================================================================

# Stage definitions -- the single source of truth.  Each entry maps a stable
# stage name (the API contract drivers depend on) to the worker function that
# implements it.  ``Title`` is what UIs show; ``Category`` lets UIs group
# stages; ``NeedsUserInput`` tells UIs "this stage prompts -- either skip it
# or arrange to provide answers another way."
$nodeDepsTitle = if ($script:CustomerReleaseMode) { 'Verifying bundled Node and browser tools' } else { 'Installing Node.js dependencies' }
$desktopTitle = if ($script:CustomerReleaseMode) { 'Verifying prebuilt desktop app' } else { 'Building desktop app' }
$InstallStages = @(
    @{ Name = "uv";               Title = "Installing uv package manager";        Category = "prereqs";      NeedsUserInput = $false; Worker = "Stage-Uv" }
    @{ Name = "python";           Title = "Verifying Python $PythonVersion";      Category = "prereqs";      NeedsUserInput = $false; Worker = "Stage-Python" }
    @{ Name = "git";              Title = "Installing Git";                       Category = "prereqs";      NeedsUserInput = $false; Worker = "Stage-Git" }
    @{ Name = "node";             Title = "Detecting Node.js";                    Category = "prereqs";      NeedsUserInput = $false; Worker = "Stage-Node" }
    @{ Name = "system-packages";  Title = "Installing ripgrep and ffmpeg";        Category = "prereqs";      NeedsUserInput = $false; Worker = "Stage-SystemPackages" }
    @{ Name = "repository";       Title = "Cloning Youtab repository";            Category = "install";      NeedsUserInput = $false; Worker = "Stage-Repository" }
    @{ Name = "venv";             Title = "Creating Python virtual environment";  Category = "install";      NeedsUserInput = $false; Worker = "Stage-Venv" }
    @{ Name = "dependencies";     Title = "Installing Python dependencies";       Category = "install";      NeedsUserInput = $false; Worker = "Stage-Dependencies" }
    @{ Name = "node-deps";        Title = $nodeDepsTitle;                          Category = "install";      NeedsUserInput = $false; Worker = "Stage-NodeDeps" }
)
if ($IncludeDesktop) {
    # Insert AFTER node-deps so workspace npm is already installed when
    # the desktop build runs. Inserted only when explicitly requested
    # (Youtab-Setup.exe), never via the irm|iex CLI one-liner.
    $InstallStages += @{ Name = "desktop"; Title = $desktopTitle; Category = "install"; NeedsUserInput = $false; Worker = "Stage-Desktop" }
}
$InstallStages += @(
    @{ Name = "path";             Title = "Adding Youtab to PATH";                Category = "finalize";     NeedsUserInput = $false; Worker = "Stage-Path" }
    @{ Name = "config-templates"; Title = "Writing configuration templates";      Category = "finalize";     NeedsUserInput = $false; Worker = "Stage-ConfigTemplates" }
    @{ Name = "platform-sdks";    Title = "Installing messaging platform SDKs";   Category = "finalize";     NeedsUserInput = $false; Worker = "Stage-PlatformSdks" }
    @{ Name = "bootstrap-marker"; Title = "Marking install complete";              Category = "finalize";     NeedsUserInput = $false; Worker = "Stage-BootstrapMarker" }
    # Interactive stages.  In non-interactive mode these become no-ops; the
    # caller (GUI / CI) handles the equivalent UX themselves.
    @{ Name = "configure";        Title = "Configuring API keys and models";      Category = "post-install"; NeedsUserInput = $true;  Worker = "Stage-Configure" }
    @{ Name = "gateway";          Title = "Starting messaging gateway";           Category = "post-install"; NeedsUserInput = $true;  Worker = "Stage-Gateway" }
)

# The customer artifact itself carries reviewed uv/Node prerequisites. On a
# clean device there is no InstallDir yet, so repository verification and the
# existing transactional promotion must run before any stage reads those pins.
if ($script:CustomerReleaseMode) {
    $repositoryStage = @($InstallStages | Where-Object { $_.Name -eq 'repository' })
    if ($repositoryStage.Count -ne 1) { throw 'Customer install requires one repository stage' }
    $InstallStages = @($repositoryStage[0]) + @($InstallStages | Where-Object { $_.Name -ne 'repository' })
}

# Stage workers -- thin wrappers that delegate to the existing Install-* /
# Test-* / Invoke-* functions while preserving their error semantics.  Kept
# as a separate layer so the existing functions remain callable directly
# (helpful for one-off recovery: ``. install.ps1; Install-Venv``).
#
# Stages that depend on uv (anything after Stage-Uv) call Resolve-UvCmd
# first so they work in cross-process driver mode where $script:UvCmd
# set by Stage-Uv in a sibling powershell process is not visible here.
# Resolve-UvCmd is a fast no-op when $script:UvCmd is already populated
# (the default-invocation case where Main runs everything in one
# process), and throws cleanly if uv truly isn't installed yet.
function Stage-Uv { if ($script:CustomerReleaseMode) { Install-PrivateHomeUv } elseif (-not (Install-Uv)) { throw "uv installation failed" } }
function Stage-Python { if ($script:CustomerReleaseMode) { Install-PrivateHomePython } else { Resolve-UvCmd; if (-not (Test-Python)) { throw "Python $PythonVersion not available" } } }
function Stage-Git              {
    if ($PrivateHomeRelocation) {
        if (-not (Get-Command Get-YoutabManagedGitBashTarget -CommandType Function -ErrorAction SilentlyContinue)) {
            . (Join-Path $InstallDir 'scripts\private-home-publication.ps1')
        }
        $journal = [IO.File]::ReadAllText($RelocationJournal) | ConvertFrom-Json
        if ($journal.schema -ne 1 -or (Get-YoutabPublicationPath $journal.target) -ine (Get-YoutabPublicationPath $YoutabHome)) { throw 'Git stage relocation identity differs' }
        $previousBash = Read-YoutabUserValue 'YOUTAB_AGENT_GIT_BASH_PATH'
        if (-not (Get-YoutabManagedGitBashTarget $previousBash $journal.source $journal.target)) {
            $script:_StageSkippedReason = 'No source-owned Git Bash binding to retarget'
            return
        }
    } elseif ($script:CustomerReleaseMode) {
        $script:_StageSkippedReason = "Git is not required for an exact-SHA artifact install"
        return
    }
    if (-not (Install-Git)) {
        if ($script:GitInstallFailureReason) { throw $script:GitInstallFailureReason }
        throw "Git not available and auto-install failed -- install from https://git-scm.com/download/win then re-run"
    }
}
# Node remains optional for developer CLI installs. Customer Setup requires it
# for the Desktop build, so its stage fails immediately if acquisition fails.
function Stage-Node             {
    if ($script:CustomerReleaseMode) {
        $script:_StageSkippedReason = 'Node is bundled and verified after the Runtime artifact is staged'
        return
    }
    if (-not (Test-Node)) {
        if ($script:CustomerReleaseMode) {
            throw 'Customer Node.js >=22.12 is unavailable; retry the portable download without administrator access.'
        }
        $script:_StageSkippedReason = "Node.js not available; browser tools will be unavailable until node is installed manually from https://nodejs.org/en/download/"
    } elseif ($script:CustomerReleaseMode -and -not $script:HasNode) {
        throw 'Customer Node.js >=22.12 is unavailable; retry the portable download without administrator access.'
    }
}
function Stage-SystemPackages   { Install-SystemPackages }
function Stage-Repository       { Install-Repository }
function Stage-Venv             { Resolve-UvCmd; Install-Venv }
function Stage-Dependencies     { Resolve-UvCmd; Install-Dependencies }
function Stage-NodeDeps {
    if ($script:CustomerReleaseMode) {
        $codecHelper = Join-Path $InstallDir 'scripts/install-managed-ffmpeg.ps1'
        if (-not (Test-Path -LiteralPath $codecHelper -PathType Leaf)) { throw 'Common Runtime lacks its managed codec installer' }
        . $codecHelper
        Install-YoutabManagedCodec -RuntimeRoot $InstallDir
    }
    Install-NodeDeps
}
function Stage-Desktop          { Install-DesktopVoiceDeps; Install-Desktop }
function Stage-Path             { Set-PathVariable }
function Stage-ConfigTemplates  { Copy-ConfigTemplates }
function Stage-PlatformSdks     { Resolve-UvCmd; Install-PlatformSdks }
function Stage-BootstrapMarker  {
    if ($script:CustomerReleaseMode) {
        # Setup writes this only after the promoted install passes backend
        # health; an earlier marker would falsely certify a failed install.
        $script:_StageSkippedReason = "Youtab-Setup writes the marker after installed-backend health"
        return
    }
    Write-BootstrapMarker
}
function Stage-Configure        { Invoke-SetupWizard }
function Stage-Gateway          { Start-GatewayIfConfigured }
function Stage-HomePublication { Invoke-PrivateHomePublicationStage }
function Stage-HomeRegistration { Register-ValidatedCustomerHome }

function Get-InstallStage {
    param([string]$Name)
    if ($script:CustomerReleaseMode -and -not $PrivateHomeRelocation -and $Name -eq 'home-registration') {
        return @{ Name = 'home-registration'; Title = 'Registering validated Youtab home'; Category = 'finalize'; NeedsUserInput = $false; Worker = 'Stage-HomeRegistration' }
    }
    if ($PrivateHomeRelocation -and $Name -eq "home-publication") {
        return @{ Name = "home-publication"; Title = "Publishing validated relocation"; Category = "finalize"; NeedsUserInput = $false; Worker = "Stage-HomePublication" }
    }
    foreach ($s in $InstallStages) {
        if ($s.Name -eq $Name) { return $s }
    }
    return $null
}

function Step-OutOfInstallDir {
    # Windows refuses to delete a directory any shell is currently cd'd
    # inside -- and silently leaves orphan files behind, which then wedge
    # "is this a valid git repo" probes on re-install.  Harmless when the
    # caller ran the installer from somewhere else.
    try {
        $currentResolved = (Get-Location).ProviderPath
        $installResolved = $null
        if (Test-Path $InstallDir) {
            $installResolved = (Resolve-Path $InstallDir -ErrorAction SilentlyContinue).ProviderPath
        }
        if ($installResolved -and $currentResolved.ToLower().StartsWith($installResolved.ToLower())) {
            Write-Info "Stepping out of $InstallDir so Windows can replace files there if needed..."
            Set-Location $env:USERPROFILE
        }
    } catch {}
}

function Invoke-Stage {
    param(
        [Parameter(Mandatory=$true)] [hashtable]$StageDef
    )

    # Refresh PATH from registry so this stage sees binaries installed by
    # prior stages, even when each stage runs in its own powershell process.
    # No-op in cost-relevant cases (default invocation path syncs once per
    # foreach pass; cross-process drivers get the necessary freshening).
    Sync-EnvPath

    # Per-stage soft-skip channel.  A worker can populate
    # $script:_StageSkippedReason to surface "ran, but the thing it was
    # supposed to set up is not available" as skipped=true in the JSON
    # frame, without throwing.  Used by Stage-Node so the install flow
    # doesn't abort when an optional capability is missing while still
    # being honest in the protocol contract.  Reset before each stage so
    # a prior stage's reason can never leak into a later stage's frame.
    $script:_StageSkippedReason = $null
    $script:_StageData = $null

    $start = [DateTime]::UtcNow
    $result = @{
        stage        = $StageDef.Name
        ok           = $false
        skipped      = $false
        reason       = $null
        duration_ms  = 0
    }

    try {
        & $StageDef.Worker
        $result.ok = $true
        if ($script:_StageData) { $result.data = $script:_StageData }
        if ($script:_StageSkippedReason) {
            $result.skipped = $true
            $result.reason  = $script:_StageSkippedReason
        }
    } catch {
        $result.ok = $false
        $result.reason = "$_"
        throw
    } finally {
        $result.duration_ms = [int]([DateTime]::UtcNow - $start).TotalMilliseconds
        if ($Json -or $Stage) {
            # In stage-driver mode every stage emits a JSON line so the
            # caller can stream progress.  In default interactive mode we
            # stay silent here (the worker already wrote human output).
            $result | ConvertTo-Json -Depth 5 -Compress | Write-Output
            # Tell the entry-point catch that we've already emitted a
            # frame for this failure (when $result.ok = $false), so it
            # doesn't double-emit a second JSON object and break the
            # one-line-per-stage contract the driver protocol promises.
            if (-not $result.ok) {
                $script:_StageEmittedErrorFrame = $true
            }
        }
    }
}

# ============================================================================
# Main
# ============================================================================

function Invoke-AllStages {
    Step-OutOfInstallDir
    foreach ($s in $InstallStages) {
        Invoke-Stage -StageDef $s
    }
}

function Invoke-EnsureMode {
    param([string]$Deps)
    $depList = $Deps -split ","
    foreach ($dep in $depList) {
        $dep = $dep.Trim()
        switch ($dep) {
            "node" {
                [void](Test-Node)
                if (-not $script:HasNode) {
                    Write-Err "Node.js could not be installed"
                    exit 1
                }
            }
            "browser" {
                [void](Test-Node)
                if ($script:HasNode) {
                    Install-AgentBrowser
                } else {
                    Write-Err "Node.js is required for browser tools but could not be installed"
                    exit 1
                }
            }
            "ripgrep" {
                Write-Info "ripgrep: install manually on Windows (scoop install ripgrep)"
            }
            "ffmpeg" {
                Write-Info "ffmpeg: install manually on Windows (scoop install ffmpeg)"
            }
            default {
                Write-Err "Unknown dependency: $dep"
                exit 1
            }
        }
    }
}

function Invoke-PostInstallMode {
    Write-Info "Running post-install setup..."
    Invoke-EnsureMode -Deps "node,browser"
    Write-Info "Post-install complete"
}

function Main {
    Write-Banner
    Invoke-AllStages
    if (-not $Json) {
        Write-Completion
    } else {
        @{ ok = $true; protocol_version = $InstallStageProtocolVersion } | ConvertTo-Json -Compress | Write-Output
    }
}

# ----------------------------------------------------------------------------
# Entry-point dispatch
# ----------------------------------------------------------------------------
#
# All branches funnel through one try/catch so errors don't kill an `irm |
# iex` PowerShell session, and so failures in stage-driver mode produce a
# structured JSON error frame instead of a bare exception.

try {
    Assert-CustomerReleaseSource
    if ($Ensure -ne "") {
        if ($PSBoundParameters.ContainsKey("Stage")) {
            Write-Err "Cannot use -Ensure and -Stage simultaneously"
            exit 1
        }
        Invoke-EnsureMode -Deps $Ensure
        exit 0
    }
    if ($PostInstall) {
        Invoke-PostInstallMode
        exit 0
    }

    if ($ProtocolVersion) {
        Write-Output $InstallStageProtocolVersion
        exit 0
    }

    if ($Manifest) {
        $payload = @{
            protocol_version = $InstallStageProtocolVersion
            stages = @($InstallStages | ForEach-Object {
                @{
                    name             = $_.Name
                    title            = $_.Title
                    category         = $_.Category
                    needs_user_input = $_.NeedsUserInput
                }
            })
        }
        $payload | ConvertTo-Json -Depth 5 -Compress | Write-Output
        exit 0
    }

    # Use PSBoundParameters rather than $Stage truthiness so that an
    # explicit `-Stage ""` from a misbehaving driver doesn't fall through
    # to the full-install Main path and silently kick off a destructive
    # operation.  Empty string is a contract violation; surface it as
    # unknown-stage exit 2 with a structured JSON frame.
    if ($PSBoundParameters.ContainsKey("Stage")) {
        $def = Get-InstallStage -Name $Stage
        if (-not $def) {
            $err = @{
                ok     = $false
                stage  = $Stage
                reason = "unknown stage: $Stage. Run install.ps1 -Manifest to list valid stages."
            }
            $err | ConvertTo-Json -Compress | Write-Output
            exit 2
        }
        Step-OutOfInstallDir
        Invoke-Stage -StageDef $def
        exit 0
    }

    # Default: full install (today's behavior, plus optional -NonInteractive
    # and -Json layered on by the params above).
    if ($script:CustomerReleaseMode) {
        throw "Customer release mode requires Youtab-Setup stage promotion"
    }
    Main
} catch {
    if ($Json -or $Stage) {
        # Stage-driver mode: caller wants JSON they can parse.  Emit a
        # structured error frame and exit non-zero -- BUT only if
        # Invoke-Stage didn't already emit one for this same failure.
        # The inner finally emits the authoritative per-stage frame
        # (with duration_ms + skipped fields); a second emit here
        # would produce two concatenated JSON objects on stdout and
        # break drivers that parse one-line-per-invocation.
        if (-not $script:_StageEmittedErrorFrame) {
            $err = @{
                ok     = $false
                stage  = if ($Stage) { $Stage } else { $null }
                reason = "$_"
            }
            $err | ConvertTo-Json -Compress | Write-Output
        }
        exit 1
    }

    # Interactive mode: keep today's friendly recovery hint.
    Write-Host ""
    Write-Err "Installation failed: $_"
    Write-Host ""
    Write-Info "If the error is unclear, try downloading and running the script directly:"
    Write-Host "  Invoke-WebRequest -Uri 'https://youtab-agent-runtime.youtab.io/install.ps1' -OutFile install.ps1" -ForegroundColor Yellow
    Write-Host "  .\install.ps1" -ForegroundColor Yellow
    Write-Host ""
}
