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
$ErrorActionPreference='Stop'
$source=$env:YOUTAB_RELOCATION_QA_SOURCE
$fixture=[IO.Path]::GetFullPath($env:YOUTAB_NATIVE_PRIVATE_QA_ROOT)
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $source 'scripts\install.ps1'),[ref]$null,[ref]$null)
$self=[Management.Automation.Language.Parser]::ParseFile($PSCommandPath,[ref]$null,[ref]$null)
# WindowsPS5.1 probe proves the complete schema text differs only by CRLF/LF.
# Preserve exact literals/defaults/types/comments after this representation fix.
$stageSourceSchema=$ast.ParamBlock.Extent.Text.Replace("`r`n","`n")
$stageHelperSchema=$self.ParamBlock.Extent.Text.Replace("`r`n","`n")
if ($stageSourceSchema -cne $stageHelperSchema) { throw 'QA binding schema differs from actual installer parameters' }
if ($Stage -cne 'git' -or -not $PrivateHomeRelocation -or -not $Json -or -not $NonInteractive -or -not $RelocationJournal) {
    throw 'Production per-stage request omitted required relocation contract fields'
}
# Use the existing production spelling resolver without changing admission.
. (Join-Path $source 'scripts\private-home-publication.ps1')
$stageContractHome=Get-YoutabPublicationPath ([IO.Path]::GetFullPath($YoutabHome))
$stageContractFixture=Get-YoutabPublicationPath $fixture
if (-not $stageContractHome.StartsWith($stageContractFixture+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Production stage home escaped owned fixture' }
foreach ($path in @($stageContractFixture,$stageContractHome,$RelocationJournal)) {
    if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) { throw 'Stage contract fixture link refused' }
}
$packet=[IO.File]::ReadAllText($RelocationJournal) | ConvertFrom-Json
foreach ($name in @('Stage-Git','Sync-EnvPath','Invoke-Stage')) {
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    Invoke-Expression $definition.Extent.Text
}
$script:CustomerReleaseMode=$PSBoundParameters.ContainsKey('ReleaseBaseUrl')
$script:gitCalls=0
function Read-YoutabUserValue([string]$Name) {
    if ($Name -cne 'YOUTAB_AGENT_GIT_BASH_PATH') { throw 'Stage contract attempted unrelated User value read' }
    return Join-Path (Get-YoutabPublicationPath $packet.source) 'git\bin\bash.exe'
}
function Read-YoutabInstallPath([string]$Scope) {
    if ($Scope -eq 'User') { return "$(Get-YoutabPublicationPath $packet.source)\git\cmd;C:\synthetic-custom-tools" }
    return "$env:SystemRoot\System32"
}
function Write-YoutabUserValue($Name,$Value) { throw 'Stage contract attempted real registry mutation' }
function Install-Git {
    if (-not $script:CustomerReleaseMode) { throw 'Actual installer release parameter did not bind' }
    foreach ($entry in $env:Path -split ';') {
        if ($entry.StartsWith((Get-YoutabPublicationPath $packet.source)+'\',[StringComparison]::OrdinalIgnoreCase)) {
            throw 'Actual production request restored OLD search path'
        }
    }
    $script:gitCalls++
    $script:_StageData=@{production_journal_bound=$true;git_calls=$script:gitCalls}
    return $true
}
Invoke-Stage -StageDef @{Name=$Stage;Worker='Stage-Git'}
if ($script:gitCalls -ne 1) { throw 'Actual Stage-Git acquisition seam was not reached' }
