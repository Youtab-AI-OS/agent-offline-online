"""Regression tests for #48130: Windows npm lifecycle scripts need node on PATH.

The desktop installer can resolve ``npm.cmd`` while postinstall hooks fail with
``'node' is not recognized`` because child ``cmd.exe`` processes do not inherit
a PATH that includes ``node.exe``'s directory.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"


def _install_ps1() -> str:
    return INSTALL_PS1.read_text(encoding="utf-8")


def test_install_ps1_defines_ensure_node_exe_on_path_helper() -> None:
    text = _install_ps1()
    assert "function Ensure-NodeExeOnPath" in text
    assert re.search(
        r"\$env:Path\s*=\s*\"\$nodeExeDir;\$env:Path\"",
        text,
    ), "Ensure-NodeExeOnPath must prepend node.exe's directory to PATH"


def test_test_node_prepends_node_dir_before_success() -> None:
    text = _install_ps1()
    assert re.search(
        r"if \(Test-NodeVersionOk \$version\) \{[\s\S]{0,200}?Ensure-NodeExeOnPath",
        text,
    ), "Test-Node must call Ensure-NodeExeOnPath when a system Node passes the version floor"


def test_install_node_deps_prepends_node_dir_before_npm() -> None:
    text = _install_ps1()
    start = text.index("function Install-NodeDeps {")
    end = text.find("\nfunction ", start + 1)
    body = text[start:end if end != -1 else None]
    assert body.index("Ensure-NodeExeOnPath") < body.index("# Resolve npm explicitly"), (
        "Install-NodeDeps must call Ensure-NodeExeOnPath before invoking npm"
    )


@pytest.mark.skipif(os.name != "nt", reason="Node admission behavior requires native Windows PowerShell")
@pytest.mark.parametrize(
    "version,expected",
    [
        ("v20.19.0", False),
        ("v20.20.0", False),
        ("v21.9.0", False),
        ("v22.11.0", False),
        ("bad", False),
        ("v22.12.0", True),
        ("v22.13.0", True),
        ("v24.15.0", True),
    ],
)
def test_desktop_node_version_admission_executes_actual_function(tmp_path, version, expected):
    shell = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    assert shell.is_file(), "Actual Windows PowerShell is required for Node admission behavior"
    home = tmp_path / "isolated-home"
    home.mkdir()
    for relative in ("AppData/Roaming", "AppData/Local", "temp"):
        (home / relative).mkdir(parents=True)
    env = os.environ.copy()
    env.update(
        YT_NODE_SCRIPT=str(INSTALL_PS1), YT_NODE_VERSION=version,
        HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / "AppData/Roaming"),
        LOCALAPPDATA=str(home / "AppData/Local"), TEMP=str(home / "temp"), TMP=str(home / "temp"),
    )
    command = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_NODE_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production installer parser errors' }
$definitions = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Test-NodeVersionOk'
}, $true))
if ($definitions.Count -ne 1) { throw 'Expected one production Node admission function' }
# Evaluate only this pure function definition. No installer initialization,
# stage/global assignments, installed Node probe, download, or install runs.
Invoke-Expression $definitions[0].Extent.Text
$before = (Get-Location).Path
$value = Test-NodeVersionOk -Version $env:YT_NODE_VERSION
if ($value -isnot [bool]) { throw 'Node admission must return one Boolean' }
[ordered]@{ accepted = $value; locationRestored = ((Get-Location).Path -eq $before);
    errorPolicyRestored = ($ErrorActionPreference -eq 'Stop') } | ConvertTo-Json -Compress
'''
    result = subprocess.run(
        [str(shell), "-NoProfile", "-NonInteractive", "-Command", command],
        env=env, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip())
    assert frame["accepted"] is expected
    assert frame["locationRestored"] is True
    assert frame["errorPolicyRestored"] is True


@pytest.fixture(scope="module")
def node_version_canary(tmp_path_factory):
    """Synthetic native --version executable; never runs installed Node."""
    shell = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    assert shell.is_file(), "Actual Windows PowerShell is required for Node caller behavior"
    root = tmp_path_factory.mktemp("node-version-canary")
    source = root / "canary.cs"
    source.write_text(r'''
using System;
using System.IO;
public class NodeVersionCanary {
    public static int Main(string[] args) {
        if (args.Length != 1 || args[0] != "--version") return 99;
        string version = Environment.GetEnvironmentVariable("YT_NODE_CANDIDATE_VERSION");
        File.AppendAllText(Environment.GetEnvironmentVariable("YT_NODE_EVENTS"), "node:" + version + "\n");
        Console.WriteLine(version);
        return 0;
    }
}
''', encoding="ascii")
    exe = root / "node-canary.exe"
    env = os.environ.copy()
    env.update(YT_NODE_CS=str(source), YT_NODE_EXE=str(exe), TEMP=str(root), TMP=str(root),
               HOME=str(root), USERPROFILE=str(root))
    result = subprocess.run(
        [str(shell), "-NoProfile", "-NonInteractive", "-Command",
         "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:YT_NODE_CS)) -OutputAssembly $env:YT_NODE_EXE -OutputType ConsoleApplication -Language CSharp"],
        env=env, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert exe.read_bytes()[:2] == b"MZ"
    return shell, exe


NODE_CALLER_HARNESS = r'''
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
# Bind only the AST's external Environment Get/Set dependency below. Even a
# regression must not persist real User PATH; admission logic stays untouched.
Add-Type -TypeDefinition @'
public static class SyntheticNodeEnvironment {
    public static int PersistentWrites = 0;
    public static string GetEnvironmentVariable(string name, string target) { return ""; }
    public static void SetEnvironmentVariable(string name, string value, string target) {
        PersistentWrites++;
        throw new System.InvalidOperationException("SYNTHETIC_PERSISTENT_PATH_WRITE_DENIED");
    }
}
'@
if ([SyntheticNodeEnvironment].FullName -ne 'SyntheticNodeEnvironment') { throw 'Synthetic Environment boundary missing' }
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_NODE_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production installer parser errors' }
foreach ($name in @('Test-NodeVersionOk', 'Test-Node', 'Install-Desktop')) {
    $definitions = @($ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Expected one production function: $name" }
    $definition = $definitions[0]
    $definitionText = $definition.Extent.Text
    $environmentUses = @($definition.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.TypeExpressionAst] -and
        $node.TypeName.FullName -in @('Environment', 'System.Environment')
    }, $true))
    if ($name -eq 'Test-Node' -and $environmentUses.Count -eq 0) { throw 'Expected external Environment dependency' }
    foreach ($use in ($environmentUses | Sort-Object { $_.Extent.StartOffset } -Descending)) {
        $call = $use.Parent
        if ($call -isnot [System.Management.Automation.Language.InvokeMemberExpressionAst] -or
            -not $call.Static -or $call.Member.Value -notin @('GetEnvironmentVariable', 'SetEnvironmentVariable')) {
            throw 'Unexpected Environment dependency; refuse unbound outside effect'
        }
        $offset = $use.Extent.StartOffset - $definition.Extent.StartOffset
        $definitionText = $definitionText.Remove($offset, $use.Extent.Text.Length).Insert($offset, '[SyntheticNodeEnvironment]')
    }
    $boundTokens = $null; $boundErrors = $null
    $boundAst = [System.Management.Automation.Language.Parser]::ParseInput($definitionText, [ref]$boundTokens, [ref]$boundErrors)
    if ($boundErrors.Count) { throw 'Fixture dependency binding parser errors' }
    $unbound = @($boundAst.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.TypeExpressionAst] -and
        $node.TypeName.FullName -in @('Environment', 'System.Environment')
    }, $true))
    if ($unbound.Count) { throw 'Synthetic Environment boundary missing' }
    Invoke-Expression $definitionText
}
function Write-Info { param($Message) }
function Write-Success { param($Message) }
function Write-Warn { param($Message) $script:Warnings += [string]$Message }
function Show-NpmCertHint { param($Message) }
function Ensure-NodeExeOnPath { }
function Get-WindowsArch { 'x64' }
function Get-Command {
    param($Name)
    if ($Name -eq 'node') {
        if ($env:YT_NODE_MODE -eq 'optional-missing' -or ($env:YT_NODE_MODE -like 'portable*' -and -not $script:WingetInstalled)) { return }
        return [pscustomobject]@{ Source = $env:YT_NODE_CANARY }
    }
    if ($Name -eq 'winget') {
        if ($env:YT_NODE_MODE -ne 'optional-missing') { return [pscustomobject]@{ Source = 'synthetic-winget' } }
        return
    }
    if ($Name -eq 'npm' -and $env:YT_NODE_NPM -eq '1') { return [pscustomobject]@{ Source = $env:YT_NODE_NPM_STANDIN } }
}
function Get-PinnedNodeArchive {
    param($Arch)
    $approved = Join-Path $env:TEMP 'approved-node.zip'
    Set-Content -LiteralPath $approved -Value 'synthetic archive'
    @{ Version = '22.23.3'; Sha256 = (Get-FileHash -LiteralPath $approved -Algorithm SHA256).Hash.ToLowerInvariant();
       ExeSha256 = (Get-FileHash -LiteralPath $env:YT_NODE_CANARY -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function node { & $env:YT_NODE_CANARY --version }
function winget {
    Add-Content -LiteralPath $env:YT_NODE_EVENTS -Value 'winget'
    $script:WingetInstalled = $true
    if ($env:YT_NODE_WINGET_VERSION) { $env:YT_NODE_CANDIDATE_VERSION = $env:YT_NODE_WINGET_VERSION }
    $global:LASTEXITCODE = 0
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing)
    if ($env:YT_NODE_MODE -notlike 'portable*') { throw 'SYNTHETIC_PORTABLE_UNAVAILABLE' }
    if ($Uri -match 'latest-v22|SHASUMS|index') { throw 'MUTABLE_NODE_INDEX_USED' }
    if ($OutFile) {
        Add-Content -LiteralPath $env:YT_NODE_EVENTS -Value 'portable-download'
        if ($env:YT_NODE_MODE -eq 'portable-tamper') {
            Set-Content -LiteralPath $OutFile -Value 'tampered archive'
        } else {
            Copy-Item -LiteralPath (Join-Path $env:TEMP 'approved-node.zip') -Destination $OutFile
        }
        return
    }
    throw 'MUTABLE_NODE_INDEX_USED'
}
function Expand-Archive {
    param($Path, $DestinationPath, [switch]$Force)
    Add-Content -LiteralPath $env:YT_NODE_EVENTS -Value 'portable-extract'
    $directory = Join-Path $DestinationPath 'node-v22.23.3-win-x64'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Copy-Item -LiteralPath $env:YT_NODE_CANARY -Destination (Join-Path $directory 'node.exe')
}
$InstallDir = $env:YT_NODE_ROOT
$YoutabHome = $env:YT_NODE_HOME
$NodeVersion = '22.23.3'
$PrivateHomeRelocation = $env:YT_NODE_PRIVATE -eq '1'
$script:CustomerReleaseMode = $env:YT_NODE_CUSTOMER -eq '1'
if ($env:YT_NODE_MODE -in @('portable-old-preserve','portable-swap')) {
    $oldDir=Join-Path $YoutabHome 'node'
    [IO.Directory]::CreateDirectory($oldDir) | Out-Null
    [IO.File]::WriteAllText((Join-Path $oldDir 'keep.txt'),'old node tree')
    if ($env:YT_NODE_MODE -eq 'portable-old-preserve') {
        Copy-Item -LiteralPath $env:YT_NODE_CANARY -Destination (Join-Path $oldDir 'node.exe')
    } else {
        [IO.File]::WriteAllText((Join-Path $oldDir 'node.exe'),'old unapproved node')
    }
}
# A previous stage's stale success must not bless a failed current probe.
$script:HasNode = $true
$script:Warnings = @(); $script:WingetInstalled = $false
if ($env:YT_NODE_MODE -eq 'desktop') {
    # Isolate the real Desktop caller from Node acquisition (covered above).
    function Test-Node { $script:HasNode = $env:YT_NODE_ADMITTED -eq '1'; return $true }
}
$before = (Get-Location).Path; $failure = $null; $value = $null
try {
    if ($env:YT_NODE_MODE -eq 'desktop') { Install-Desktop } else { $value = Test-Node }
} catch { $failure = $_.Exception.Message }
[ordered]@{ value = $value; error = $failure; hasNode = $script:HasNode;
    skipped = $script:_StageSkippedReason; warnings = @($script:Warnings);
    oldMarker = (Test-Path -LiteralPath (Join-Path $YoutabHome 'node\keep.txt'));
    persistentPathWrites = [SyntheticNodeEnvironment]::PersistentWrites;
    errorPolicyRestored = ($ErrorActionPreference -eq 'Stop');
    locationRestored = ((Get-Location).Path -eq $before) } | ConvertTo-Json -Compress
'''


@pytest.mark.skipif(os.name != "nt", reason="Portable Node tamper test needs Windows PowerShell")
def test_customer_portable_node_refuses_tampered_archive_before_extract_or_execute(tmp_path):
    """Execute the production acquisition function with a synthetic bad download."""
    shell = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    events = tmp_path / "events.txt"
    events.write_text("", encoding="ascii")
    script = r'''
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:YT_NODE_SCRIPT,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'production parser error' }
foreach ($name in @('Test-NodeVersionOk','Get-PinnedNodeArchive','Test-Node')) {
  $definitions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))
  if ($definitions.Count -ne 1) { throw "missing function: $name" }
  Invoke-Expression $definitions[0].Extent.Text
}
function Write-Info { param($Message) }
function Write-Success { param($Message) }
function Write-Warn { param($Message) }
function Get-WindowsArch { 'x64' }
function Invoke-WebRequest {
  param($Uri,$OutFile,[switch]$UseBasicParsing)
  if ($Uri -ne 'https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip') { throw 'mutable URL used' }
  [IO.File]::WriteAllText($OutFile,'tampered archive')
  [IO.File]::AppendAllText($env:YT_NODE_EVENTS,"download`n")
}
function Expand-Archive { [IO.File]::AppendAllText($env:YT_NODE_EVENTS,"extract`n"); throw 'unsafe extraction' }
$PrivateHomeRelocation=$true
$script:CustomerReleaseMode=$true
$YoutabHome=$env:YT_NODE_HOME
$NodeVersion='22.23.3'
$value=$null
try { $value=Test-Node } catch { $value=$_.Exception.Message }
@{value=$value; hasNode=$script:HasNode} | ConvertTo-Json -Compress
'''
    env = os.environ.copy()
    env.update(YT_NODE_SCRIPT=str(INSTALL_PS1), YT_NODE_EVENTS=str(events),
               YT_NODE_HOME=str(tmp_path / "isolated-home"), TEMP=str(tmp_path), TMP=str(tmp_path))
    result = subprocess.run([str(shell), "-NoProfile", "-NonInteractive", "-Command", script],
                            env=env, capture_output=True, text=True, timeout=20, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip())
    assert "Private managed Node download failed" in frame["value"]
    assert frame["hasNode"] is False
    assert events.read_text(encoding="ascii").splitlines() == ["download"]
    assert "latest-v22" not in INSTALL_PS1.read_text(encoding="utf-8").split("function Test-Node {")[1].split("function Update-ProcessPathForPackages")[0]


@pytest.mark.skipif(os.name != "nt", reason="Node caller behavior requires native Windows PowerShell")
@pytest.mark.parametrize(
    "mode,version,private,winget_version,customer,admitted,npm,expected_value,expected_node,expected_error,expected_events",
    [
        ("portable", "v22.23.3", True, "", False, False, True, True, True, None,
         ["portable-download", "portable-extract", "node:v22.23.3", "node:v22.23.3"]),
        ("portable", "v22.23.3", False, "", True, False, True, True, True, None,
         ["portable-download", "portable-extract", "node:v22.23.3", "node:v22.23.3"]),
        ("portable-old-preserve", "v20.20.0", True, "", False, False, True, None, False, "Private managed Node download failed",
         ["node:v20.20.0", "portable-download", "portable-extract", "node:v20.20.0"]),
        ("portable-swap", "v22.23.3", False, "", True, False, True, True, True, None,
         ["portable-download", "portable-extract", "node:v22.23.3", "node:v22.23.3"]),
        ("portable-tamper", "v22.23.3", False, "", True, False, True, False, False, None,
         ["portable-download"]),
        ("portable", "v20.20.0", True, "", False, False, True, None, False, "Private managed Node download failed",
         ["portable-download", "portable-extract", "node:v20.20.0"]),
        ("portable-recover", "v20.20.0", False, "v22.12.0", False, False, True, True, True, None,
         ["portable-download", "portable-extract", "node:v20.20.0", "winget", "node:v22.12.0"]),
        ("portable-recover", "v20.20.0", False, "v22.12.0", True, False, True, False, False, None,
         ["portable-download", "portable-extract", "node:v20.20.0"]),
        ("winget", "v20.20.0", False, "", False, False, True, True, False, None,
         ["node:v20.20.0", "winget", "node:v20.20.0"]),
        ("winget", "v20.20.0", False, "v22.12.0", False, False, True, True, True, None,
         ["node:v20.20.0", "winget", "node:v22.12.0"]),
        ("optional-missing", "v20.20.0", False, "", False, False, True, True, False, None, []),
        ("desktop", "v22.12.0", True, "", True, False, True, None, False, "requires a verified Node.js",
         ["node:v22.12.0"]),
        ("desktop", "v20.20.0", True, "", True, True, True, None, True, "requires a verified Node.js",
         ["node:v20.20.0"]),
        ("desktop", "v22.12.0", True, "", True, True, True, None, True, "SYNTHETIC_NPM_BOUNDARY",
         ["node:v22.12.0", "npm:ci --include dev"]),
        ("desktop", "v20.20.0", True, "", False, False, True, None, False, None,
         ["node:v20.20.0"]),
        ("desktop", "v22.12.0", True, "", True, True, False, None, True, "requires Node.js >=22.12 and npm", []),
    ],
)
def test_node_acquisition_and_desktop_admission_execute_actual_callers(
    tmp_path, node_version_canary, mode, version, private, winget_version, customer,
    admitted, npm, expected_value, expected_node, expected_error, expected_events,
):
    shell, canary = node_version_canary
    root = tmp_path / "synthetic-install"; (root / "apps/desktop").mkdir(parents=True)
    (root / "apps/desktop/package.json").write_text("{}", encoding="ascii")
    home = tmp_path / "isolated-home"; home.mkdir()
    temporary = tmp_path / "isolated-temp"; temporary.mkdir()
    events = tmp_path / "events.txt"; events.write_text("", encoding="ascii")
    npm_standin = tmp_path / "npm-stand-in.ps1"
    npm_standin.write_text("Add-Content -LiteralPath $env:YT_NODE_EVENTS -Value ('npm:' + ($args -join ' '))\nthrow 'SYNTHETIC_NPM_BOUNDARY'\n", encoding="ascii")
    env = os.environ.copy()
    env.update(YT_NODE_SCRIPT=str(INSTALL_PS1), YT_NODE_CANARY=str(canary), YT_NODE_EVENTS=str(events),
               YT_NODE_ROOT=str(root), YT_NODE_HOME=str(home), YT_NODE_MODE=mode,
               YT_NODE_CANDIDATE_VERSION=version, YT_NODE_PRIVATE=str(int(private)),
               YT_NODE_WINGET_VERSION=winget_version, YT_NODE_CUSTOMER=str(int(customer)),
               YT_NODE_ADMITTED=str(int(admitted)), YT_NODE_NPM=str(int(npm)), YT_NODE_NPM_STANDIN=str(npm_standin),
               HOME=str(home), USERPROFILE=str(home), TEMP=str(temporary), TMP=str(temporary),
               APPDATA=str(home), LOCALAPPDATA=str(home), PATHEXT=".COM;.EXE;.BAT;.CMD")
    result = subprocess.run([str(shell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", NODE_CALLER_HARNESS],
                            env=env, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip())
    assert frame["value"] is expected_value, frame
    assert frame["hasNode"] is expected_node
    if expected_error:
        assert expected_error in frame["error"]
    else:
        assert frame["error"] is None
    assert frame["errorPolicyRestored"] is True
    assert frame["locationRestored"] is True
    assert frame["persistentPathWrites"] == 0
    if mode == 'portable-old-preserve':
        assert frame["oldMarker"] is True
    if mode == 'portable-swap':
        assert frame["oldMarker"] is False
    assert events.read_text(encoding="utf-8-sig").splitlines() == expected_events
    if mode.startswith("portable") and version.startswith("v20"):
        assert any("does not satisfy the desktop build floor" in message for message in frame["warnings"])
    if mode == "desktop" and not customer:
        assert frame["skipped"] == "Node.js >=22.12 not available"
