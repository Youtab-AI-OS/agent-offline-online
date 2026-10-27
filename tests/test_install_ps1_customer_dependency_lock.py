"""Exercise customer dependency locks and the development Desktop stage offline."""

import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install.ps1"


def stage_customer_prerequisites(root: Path) -> None:
    """Make a small, complete 132-wheel fixture for the real PS hash validator."""
    def sha(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    source = "a" * 40
    base = root / "customer-prerequisites" / "windows-x64"
    wheelhouse = base / "wheelhouse"
    wheelhouse.mkdir(parents=True)
    config = root / "config"
    config.mkdir(exist_ok=True)
    lock_bytes = (root / "uv.lock").read_bytes()
    records = []
    pins = []
    for index in range(132):
        name = f"synthetic_{index:03}-1.0-py3-none-any.whl"
        data = f"fixture wheel {index}".encode()
        (wheelhouse / name).write_bytes(data)
        records.append({"path": f"wheelhouse/{name}", "size": len(data), "sha256": sha(data)})
        pins.append({"name": name, "size": len(data), "sha256": sha(data)})
    standalone = {
        "uv.zip": b"synthetic uv",
        "python.tar.gz": b"synthetic python",
        "requirements.txt": b"synthetic locked requirements",
    }
    for name, data in standalone.items():
        (base / name).write_bytes(data)
        records.append({"path": name, "size": len(data), "sha256": sha(data)})
    records.sort(key=lambda record: record["path"].casefold())
    (config / "windows-customer-wheelhouse.json").write_text(json.dumps({
        "schema": 1, "uv_lock_sha256": sha(lock_bytes), "wheel_count": len(pins),
        "requirements_sha256": sha(standalone["requirements.txt"]), "files": pins,
    }), encoding="utf-8")
    (config / "windows-private-home-prerequisites.json").write_text(json.dumps({
        "uv": {"sha256": sha(standalone["uv.zip"])},
        "python": {"sha256": sha(standalone["python.tar.gz"])},
    }), encoding="utf-8")
    (base / "manifest.json").write_text(json.dumps({
        "schema": 1, "platform": "windows", "arch": "x64", "source_sha": source,
        "uv_lock_sha256": sha(lock_bytes), "files": records,
        "file_count": len(records), "total_size": sum(record["size"] for record in records),
    }), encoding="utf-8")


@pytest.mark.parametrize("stamp_state", ["valid", "missing", "wrong-commit", "dirty"])
def test_customer_desktop_requires_prebuilt_files_and_exact_stamp_without_build_tools(
    tmp_path, stamp_state,
):
    shell = shutil.which("powershell.exe")
    if not shell:
        pytest.skip("Real Windows PowerShell is required for Desktop stage behavior")
    root = tmp_path / "workspace"
    required = [
        "apps/desktop/release/win-unpacked/Youtab.exe",
        "apps/desktop/release/win-unpacked/resources/app.asar",
        "apps/desktop/release/win-unpacked/resources/install-stamp.json",
        "apps/desktop/release/win-unpacked/resources/app.asar.unpacked/dist/native/setup_lease.node",
    ]
    for name in required:
        path = root.joinpath(*name.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic prebuilt file")
    stamp = root.joinpath(*required[2].split("/"))
    if stamp_state == "missing":
        stamp.unlink()
    else:
        stamp.write_text(json.dumps({
            "commit": "b" * 40 if stamp_state == "wrong-commit" else "a" * 40,
            "dirty": stamp_state == "dirty",
        }), encoding="utf-8")
    events = tmp_path / "events.txt"
    env = os.environ.copy()
    env.update(YT_LOCK_SCRIPT=str(SCRIPT), YT_LOCK_ROOT=str(root), YT_LOCK_EVENTS=str(events))
    command = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_LOCK_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'production script syntax error' }
$definition = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-Desktop'
}, $true)
if (-not $definition) { throw 'Production Install-Desktop function missing' }
Invoke-Expression $definition.Extent.Text
function Assert-CustomerPrebuiltFile {
    param([string]$RelativePath)
    Add-Content -LiteralPath $env:YT_LOCK_EVENTS -Value $RelativePath
    $path = Join-Path $InstallDir $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Prebuilt file missing: $RelativePath" }
    return $path
}
function New-DesktopShortcuts { param($TargetExe)
    Add-Content -LiteralPath $env:YT_LOCK_EVENTS -Value 'shortcuts'
}
function Write-Success { param($Message) }
function Test-Node { throw 'Unexpected customer Node build' }
function Get-Command { throw 'Unexpected customer package manager lookup' }
$InstallDir = $env:YT_LOCK_ROOT
$Commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$PrivateHomeRelocation = $false
$script:CustomerReleaseMode = $true
$failure = $null
try { Install-Desktop } catch { $failure = $_.Exception.Message }
[ordered]@{ error = $failure } | ConvertTo-Json -Compress
'''
    result = subprocess.run(
        [shell, "-NoProfile", "-NonInteractive", "-Command", command],
        env=env, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip())
    actual = events.read_text(encoding="utf-8-sig").splitlines()
    if stamp_state == "missing":
        assert "Prebuilt file missing" in frame["error"]
        assert actual == required[:3]
    elif stamp_state in {"wrong-commit", "dirty"}:
        assert "Prebuilt customer Desktop stamp differs" in frame["error"]
        assert actual == required
    else:
        assert frame["error"] is None
        assert actual == required + ["shortcuts"]


@pytest.mark.parametrize(
    "ci_exit,expected_commands,expected_error",
    [
        (17, ["ci", "install", "run pack"], "TEST_PACK_BOUNDARY"),
        (0, ["ci", "run pack"], "TEST_PACK_BOUNDARY"),
    ],
)
def test_development_desktop_uses_locked_dependencies_before_pack(
    tmp_path, ci_exit, expected_commands, expected_error,
):
    shell = shutil.which("powershell.exe")
    if not shell:
        pytest.skip("Real Windows PowerShell is required for Desktop stage behavior")
    root = tmp_path / "workspace"
    desktop = root / "apps" / "desktop"
    desktop.mkdir(parents=True)
    (desktop / "package.json").write_text('{}', encoding="utf-8")
    lock = root / "package-lock.json"
    lock.write_bytes(b"synthetic immutable lock\n")
    fake_node = tmp_path / "node-stand-in.cmd"
    fake_node.write_text("@echo off\r\necho v24.15.0\r\nexit /b 0\r\n", encoding="ascii", newline="")
    fake_npm = tmp_path / "npm-stand-in.ps1"
    fake_npm.write_text(r'''
$command = $args -join ' '
Add-Content -LiteralPath $env:YT_LOCK_EVENTS -Value $command
if ($command -eq 'ci') { $global:LASTEXITCODE = [int]$env:YT_LOCK_CI_EXIT; return }
if ($command -eq 'install') {
    Set-Content -LiteralPath $env:YT_LOCK_FILE -Value 'changed by fallback'
    $global:LASTEXITCODE = 0
    return
}
if ($command -eq 'run pack') { throw 'TEST_PACK_BOUNDARY' }
throw 'unexpected npm invocation'
''', encoding="utf-8")
    events = tmp_path / "npm-events.txt"
    events.write_text("", encoding="utf-8")
    env = os.environ.copy()
    env.update(
        YT_LOCK_SCRIPT=str(SCRIPT), YT_LOCK_ROOT=str(root),
        YT_LOCK_NPM=str(fake_npm), YT_LOCK_EVENTS=str(events),
        YT_LOCK_NODE=str(fake_node), PATHEXT=".COM;.EXE;.BAT;.CMD",
        YT_LOCK_FILE=str(lock), YT_LOCK_CI_EXIT=str(ci_exit),
        YT_LOCK_CUSTOMER="0", YT_LOCK_MISSING="0",
    )
    command = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_LOCK_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'production script syntax error' }
foreach ($name in @('Test-NodeVersionOk', 'Install-Desktop')) {
    $definition = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (-not $definition) { throw "Production function missing: $name" }
    Invoke-Expression $definition.Extent.Text
}
function Test-Node { $script:HasNode = $true; return $true }
function Get-Command {
    param($Name)
    if ($Name -eq 'node') { return [pscustomobject]@{ Source = $env:YT_LOCK_NODE } }
    if ($Name -eq 'npm') { return [pscustomobject]@{ Source = $env:YT_LOCK_NPM } }
}
function Write-Info { param($Message) }
function Write-Warn { param($Message) }
function Write-Success { param($Message) }
function Show-NpmCertHint { param($Message) }
function Test-ElectronPkgStagedMissingDist { param($InstallDir) return ($env:YT_LOCK_MISSING -eq '1') }
function Try-RestoreElectronDist { throw 'TEST_UNEXPECTED_SELF_HEAL' }
$InstallDir = $env:YT_LOCK_ROOT
$Commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$Branch = 'main'
$script:CustomerReleaseMode = $false
$before = (Get-Location).Path
$failure = $null
try { Install-Desktop } catch { $failure = $_.Exception.Message }
[ordered]@{ error = $failure; restoredLocation = ((Get-Location).Path -eq $before);
    restoredErrorPolicy = ($ErrorActionPreference -eq 'Stop') } | ConvertTo-Json -Compress
'''
    result = subprocess.run(
        [shell, "-NoProfile", "-NonInteractive", "-Command", command],
        env=env, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip())
    assert expected_error in frame["error"]
    assert frame["restoredLocation"] is True
    assert frame["restoredErrorPolicy"] is True
    assert events.read_text(encoding="utf-8-sig").splitlines() == expected_commands
    if ci_exit == 0:
        assert lock.read_bytes() == b"synthetic immutable lock\n"
    else:
        assert b"changed by fallback" in lock.read_bytes()


# Customer Python lock and exact-sync capability retention regressions.
@pytest.mark.parametrize('customer,locked_exit,check_exit,has_lock,no_venv,expected_events,expected_error',[
    (True,0,0,True,False,['dependencies','editable','check'],'TEST_LOCK_BOUNDARY'),
    (True,0,23,True,False,['dependencies','editable','check'],'inconsistent'),
    (True,17,0,True,False,['dependencies'],'no network or reduced fallback'),
    (True,0,0,False,False,[],'shipped uv.lock'),
    (True,0,0,True,True,[],'-NoVenv is unsupported'),
    (False,17,0,True,False,['sync','pip'],'TEST_LOCK_BOUNDARY'),
    (False,0,0,False,False,['pip'],'TEST_LOCK_BOUNDARY'),
])
def test_customer_python_dependency_lock_boundary(tmp_path,customer,locked_exit,check_exit,has_lock,no_venv,expected_events,expected_error):
    shell=shutil.which('powershell.exe')
    if not shell:pytest.skip('Real Windows PowerShell required')
    workspace=tmp_path/'workspace';workspace.mkdir()
    lock=workspace/'uv.lock'
    if has_lock:
        lock.write_bytes(b'synthetic immutable lock\n')
        stage_customer_prerequisites(workspace)
    uv=tmp_path/'uv-stand-in.ps1'
    uv.write_text("$kind = if ($args -contains '-r') { 'dependencies' } elseif ($args -contains '--editable') { 'editable' } elseif ($args -contains 'check') { 'check' } elseif ($args[0] -eq 'sync') { 'sync' } else { 'pip' }\nAdd-Content -LiteralPath $env:YT_EVENTS -Value $kind\n$global:LASTEXITCODE = if ($kind -in @('dependencies','sync')) { [int]$env:YT_LOCK_EXIT } elseif ($kind -eq 'check') { [int]$env:YT_CHECK_EXIT } else { 0 }\n",encoding='utf-8')
    events=tmp_path/'events.txt';events.write_text('')
    env=os.environ.copy();env.update(YT_PROPOSAL=str(SCRIPT),YT_ROOT=str(workspace),YT_UV=str(uv),YT_EVENTS=str(events),YT_LOCK_EXIT=str(locked_exit),YT_CHECK_EXIT=str(check_exit),YT_CUSTOMER=str(int(customer)),YT_NOVENV=str(int(no_venv)))
    command=r'''
$ErrorActionPreference='Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:YT_PROPOSAL,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'proposal syntax error'}
foreach($name in @('Get-FileSha256','Assert-CustomerPrerequisites','Get-CustomerDependencyExtras','Invoke-CustomerLockedDependencySync','Install-Dependencies')) {
    $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    if(-not $definition){throw 'function missing'}
    Invoke-Expression $definition.Extent.Text
}
function Get-WindowsPtySdkContext {param($PythonExe) [pscustomobject]@{PythonExe=(Join-Path $InstallDir 'not-an-interpreter.exe');VendorDir='synthetic';Wheel='synthetic.whl'} }
function Assert-WindowsPtySdk {param($Context) throw 'TEST_LOCK_BOUNDARY'}
function Invoke-NativeWithRelaxedErrorAction {param([scriptblock]$Action) & $Action}
function Write-Info {param($Message)}
function Write-Warn {param($Message)}
function Write-Success {param($Message)}
$InstallDir=$env:YT_ROOT;$YoutabHome=$env:YT_ROOT;$UvCmd=$env:YT_UV;$Commit='a' * 40
$NoVenv=$env:YT_NOVENV -eq '1';$IncludeDesktop=$false
$script:CustomerReleaseMode=$env:YT_CUSTOMER -eq '1'
$before=(Get-Location).Path;$failure=$null
try {Install-Dependencies} catch {$failure=$_.Exception.Message}
[ordered]@{error=$failure;restoredLocation=((Get-Location).Path -eq $before);restoredErrorPolicy=($ErrorActionPreference -eq 'Stop')} | ConvertTo-Json -Compress
'''
    result=subprocess.run([shell,'-NoProfile','-NonInteractive','-Command',command],env=env,capture_output=True,text=True,timeout=30,check=False)
    assert result.returncode==0,result.stdout+result.stderr
    frame=json.loads(result.stdout.strip())
    assert expected_error in frame['error']
    assert frame['restoredLocation'] and frame['restoredErrorPolicy']
    assert events.read_text(encoding='utf-8-sig').splitlines()==expected_events
    if has_lock:assert lock.read_bytes()==b'synthetic immutable lock\n'

@pytest.mark.parametrize('extra,include_desktop,reinstall',[
    ([],False,False),([],True,False),(['wake','voice'],False,False),(['messaging'],True,False),([],True,True),
])
def test_customer_locked_selection_preserves_explicit_capabilities(tmp_path,extra,include_desktop,reinstall):
    shell=shutil.which('powershell.exe')
    if not shell:pytest.skip('Real Windows PowerShell required')
    workspace=tmp_path/'workspace';workspace.mkdir();(workspace/'uv.lock').write_text('synthetic')
    stage_customer_prerequisites(workspace)
    uv=tmp_path/'uv-stand-in.ps1';events=tmp_path/'args.json'
    uv.write_text("ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:YT_EVENTS\n$global:LASTEXITCODE=0\n",encoding='utf-8')
    env=os.environ.copy();env.update(YT_PROPOSAL=str(SCRIPT),YT_ROOT=str(workspace),YT_UV=str(uv),YT_EVENTS=str(events),YT_EXTRA=json.dumps(extra),YT_DESKTOP=str(int(include_desktop)),YT_REINSTALL=str(int(reinstall)))
    command=r'''
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:YT_PROPOSAL,[ref]$tokens,[ref]$errors)
foreach($name in @('Get-FileSha256','Assert-CustomerPrerequisites','Get-CustomerDependencyExtras','Invoke-CustomerLockedDependencySync')) {
    $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    Invoke-Expression $definition.Extent.Text
}
function Invoke-NativeWithRelaxedErrorAction {param([scriptblock]$Action) & $Action}
$InstallDir=$env:YT_ROOT;$YoutabHome=$env:YT_ROOT;$UvCmd=$env:YT_UV;$NoVenv=$false;$Commit='a' * 40
$IncludeDesktop=$env:YT_DESKTOP -eq '1';$script:CustomerReleaseMode=$true
$parsedExtra = ConvertFrom-Json -InputObject $env:YT_EXTRA
[string[]]$flatExtras = @()
foreach ($name in $parsedExtra) { $flatExtras += [string]$name }
if ($flatExtras.GetType().FullName -ne 'System.String[]') { throw 'extra fixture must be a flat string array' }
Invoke-CustomerLockedDependencySync -Extra $flatExtras -ReinstallPackage:($env:YT_REINSTALL -eq '1')
'''
    literal_extra = '@(' + ','.join("'" + name.replace("'", "''") + "'" for name in extra) + ')'
    command += '\nInvoke-CustomerLockedDependencySync -Extra ' + literal_extra + " -ReinstallPackage:($env:YT_REINSTALL -eq '1')\n"
    result=subprocess.run([shell,'-NoProfile','-NonInteractive','-Command',command],env=env,capture_output=True,text=True,timeout=30,check=False)
    assert result.returncode==0,result.stdout+result.stderr
    actual=[json.loads(line) for line in events.read_text(encoding='utf-8-sig').splitlines()]
    base=workspace/'customer-prerequisites'/'windows-x64'
    python=str(workspace/'venv'/'Scripts'/'python.exe')
    deps=['--no-config','pip','install','--offline','--no-index','--find-links',
          str(base/'wheelhouse'),'--require-hashes','--no-build','--python',python,
          '-r',str(base/'requirements.txt')]
    editable=['--no-config','pip','install','--offline','--no-index','--no-build-isolation',
              '--no-deps','--editable','.']
    if reinstall:editable+=['--reinstall']
    editable+=['--python',python]
    check=['pip','check','--python',python]
    assert actual==[deps,editable,check,deps,editable,check]


# A native executable models import outcomes from the uv stand-in's exact
# installed set. No interpreter, SDK, package manager, or network is invoked.
PYTHON_PROBE = r'''
using System;
using System.IO;
public static class Probe {
    public static int Main(string[] args) {
        string code = String.Join(" ", args);
        string state = File.ReadAllText(Environment.GetEnvironmentVariable("YT_STATE"));
        if (code.Contains("tomllib")) {
            Console.WriteLine(code.Contains("scripts =") ? "youtab" : "web");
            return 0;
        }
        if (code.Contains("import fastapi")) {
            return Environment.GetEnvironmentVariable("YT_WEB_ERROR") == "1" || !state.Contains("web") ? 19 : 0;
        }
        if (code.Contains("import telegram")) {
            string marker = Environment.GetEnvironmentVariable("YT_PROBE_MARKER");
            if (Environment.GetEnvironmentVariable("YT_FORCE_MESSAGING_PROBE") == "1" && !File.Exists(marker)) {
                File.WriteAllText(marker, "probed"); return 21;
            }
            return state.Contains("messaging") ? 0 : 21;
        }
        if (code.Contains("ensurepip") || code.Contains("-m pip")) return 97;
        return state.Contains("core") ? 0 : 22;
    }
}
'''

UV_EXACT_SYNC = r'''
if ($args -contains '-r') {
    $kind = 'dependencies'
    foreach ($flag in @('--no-config','--offline','--no-index','--find-links','--require-hashes','--no-build')) {
        if ($args -notcontains $flag) { throw "MISSING_OFFLINE_LOCK_FLAG:$flag" }
    }
} elseif ($args -contains '--editable') {
    $kind = 'editable'
    foreach ($flag in @('--no-config','--offline','--no-index','--no-deps','--no-build-isolation')) {
        if ($args -notcontains $flag) { throw "MISSING_FIRST_PARTY_OFFLINE_FLAG:$flag" }
    }
} elseif ($args[0] -eq 'pip' -and $args[1] -eq 'check') {
    $kind = 'check'
} else { throw 'UNEXPECTED_CUSTOMER_PACKAGE_COMMAND' }
$prior = @(Get-Content -LiteralPath $env:YT_EVENTS | Where-Object { $_ -match '"-r"' })
$call = $prior.Count + 1
ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:YT_EVENTS
Add-Content -LiteralPath $env:YT_WORKDIR_EVENTS -Value (Get-Location).Path
if ($kind -eq 'dependencies') {
    if ($call -eq [int]$env:YT_FAIL_CALL) { $global:LASTEXITCODE = 17; return }
    # One reviewed requirement export always contains all customer capabilities.
    Set-Content -LiteralPath $env:YT_STATE -Value 'core,web,pty,wake,voice,messaging'
}
if ($kind -eq 'editable' -and ($env:YT_CONSOLE -ne '1' -or $args -contains '--reinstall')) {
    Set-Content -LiteralPath (Join-Path $env:YT_ROOT 'venv\Scripts\youtab.exe') -Value 'synthetic entry point'
}
$global:LASTEXITCODE = 0
'''

STAGE_COMMAND = r'''
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_PROPOSAL, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'proposal syntax error' }
foreach ($name in @('Get-FileSha256', 'Assert-CustomerPrerequisites', 'Get-CustomerDependencyExtras', 'Invoke-CustomerLockedDependencySync', 'Install-Dependencies', 'Install-DesktopVoiceDeps', 'Install-PlatformSdks', 'Stage-Desktop')) {
    $definition = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if (-not $definition) { throw "function missing: $name" }
    Invoke-Expression $definition.Extent.Text
}
function Get-WindowsPtySdkContext {param($PythonExe) [pscustomobject]@{PythonExe=(Join-Path $InstallDir 'venv\Scripts\python.exe'); VendorDir='synthetic'; Wheel='synthetic.whl'} }
function Assert-WindowsPtySdk {param($Context) }
function Get-SupportedPythonVersion {param($PythonExe) '3.13'}
function Invoke-NativeWithRelaxedErrorAction {param([scriptblock]$Action) & $Action}
function Resolve-UvCmd { $script:UvCmd = $env:YT_UV }
function Write-Info {param($Message)}
function Write-Warn {param($Message)}
function Write-Success {param($Message)}
function Write-Host {param($Message)}
# Build boundary only: invoke the actual Stage-Desktop wrapper and actual voice
# stage, then model the successful build's existing executable evidence.
function Install-Desktop {
    if ($env:YT_BUILD_FAILURE -eq '1') { throw 'TEST_DESKTOP_BUILD_FAILED' }
    $candidate = Join-Path $InstallDir ('apps\desktop\release\' + $env:YT_DESKTOP_ARCH + '\Youtab.exe')
    New-Item -ItemType Directory -Path (Split-Path $candidate -Parent) -Force | Out-Null
    Set-Content -LiteralPath $candidate -Value 'synthetic built desktop'
}
$InstallDir = $env:YT_ROOT; $YoutabHome = $env:YT_HOME; $Commit = 'a' * 40
$script:UvCmd = $env:YT_UV; $script:CustomerReleaseMode = $true
$IncludeDesktop = $env:YT_DESKTOP -eq '1'; $NoVenv = $env:YT_NOVENV -eq '1'
$script:RelocationPythonArgs = @()
$before = (Get-Location).Path; $failure = $null
try { & $env:YT_STAGE } catch { $failure = $_.Exception.Message }
[ordered]@{error=$failure; restoredLocation=((Get-Location).Path -eq $before);
    restoredErrorPolicy=($ErrorActionPreference -eq 'Stop')} | ConvertTo-Json -Compress
'''


@pytest.mark.parametrize('stages,desktop,token,fail_call,console,web_error,has_lock,no_venv,error', [
    (['Install-Dependencies'], False, False, 0, False, False, True, False, None),
    (['Install-Dependencies'], True, True, 1, False, False, True, False, 'no network or reduced fallback'),
    (['Install-Dependencies'], True, True, 2, True, False, True, False, 'no network or reduced fallback'),
    (['Install-Dependencies'], True, True, 0, True, False, True, False, None),
    (['Install-Dependencies'], True, True, 0, False, True, True, False, 'locked dashboard dependencies'),
    (['Install-DesktopVoiceDeps'], True, True, 1, False, False, True, False, 'no network or reduced fallback'),
    (['Install-PlatformSdks'], True, True, 1, False, False, True, False, 'no network or reduced fallback'),
    (['Install-PlatformSdks', 'Install-Dependencies'], True, True, 0, True, False, True, False, None),
    (['Install-DesktopVoiceDeps', 'Install-PlatformSdks', 'Install-Dependencies'], True, True, 0, True, False, True, False, None),
    (['Install-Dependencies'], False, False, 0, False, False, False, False, 'shipped uv.lock'),
    (['Install-Dependencies'], False, False, 0, False, False, True, True, '-NoVenv is unsupported'),
    (['Install-DesktopVoiceDeps'], True, True, 0, False, False, False, False, 'shipped uv.lock'),
    (['Install-DesktopVoiceDeps'], True, True, 0, False, False, True, True, '-NoVenv is unsupported'),
    (['Install-PlatformSdks'], True, True, 0, False, False, False, False, 'shipped uv.lock'),
    (['Install-PlatformSdks'], True, True, 0, False, False, True, True, 'locked virtual environment'),
])
def test_customer_dependency_stages_keep_exact_capability_union(
    tmp_path, stages, desktop, token, fail_call, console, web_error, has_lock, no_venv, error,
    desktop_arch=None, build_failure=False,
):
    shell = shutil.which('powershell.exe')
    if not shell:
        pytest.skip('Real Windows PowerShell required')
    root = tmp_path / 'workspace'; scripts = root / 'venv' / 'Scripts'; scripts.mkdir(parents=True)
    home = tmp_path / 'isolated-home'; home.mkdir()
    (home / '.env').write_text('TELEGRAM_BOT_TOKEN=synthetic\n' if token else '# TELEGRAM_BOT_TOKEN=synthetic\nTELEGRAM_BOT_TOKEN=your-token-here\n')
    lock = root / 'uv.lock'
    if has_lock:
        lock.write_bytes(b'synthetic immutable lock\n')
        stage_customer_prerequisites(root)
    initial_state = 'core,web,pty'
    if desktop_arch:
        candidate = root / 'apps' / 'desktop' / 'release' / desktop_arch / 'Youtab.exe'
        candidate.parent.mkdir(parents=True)
        candidate.write_text('synthetic existing desktop')
        initial_state += ',wake,voice'
        if token: initial_state += ',messaging'
    state = tmp_path / 'installed.txt'; state.write_text(initial_state)
    events = tmp_path / 'events.jsonl'; events.write_text('')
    workdirs = tmp_path / 'uv-workdirs.txt'; workdirs.write_text('')
    uv = tmp_path / 'uv-stand-in.ps1'; uv.write_text(UV_EXACT_SYNC, encoding='utf-8')
    probe = tmp_path / 'probe.cs'; probe.write_text(PYTHON_PROBE)
    env = os.environ.copy()
    env.update(YT_PROPOSAL=str(SCRIPT), YT_ROOT=str(root), YT_HOME=str(home),
               YT_UV=str(uv), YT_STATE=str(state), YT_EVENTS=str(events),
               YT_WORKDIR_EVENTS=str(workdirs), YT_PROBE=str(probe),
               YT_DESKTOP=str(int(desktop)), YT_NOVENV=str(int(no_venv)),
               YT_FAIL_CALL=str(fail_call), YT_CONSOLE=str(int(console)), YT_WEB_ERROR=str(int(web_error)),
               YT_DESKTOP_ARCH=desktop_arch or 'win-unpacked', YT_BUILD_FAILURE=str(int(build_failure)),
               PATHEXT='.COM;.EXE;.BAT;.CMD',
               HOME=str(home), USERPROFILE=str(home))
    compiled = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-Command',
        "Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:YT_PROBE) -OutputAssembly (Join-Path $env:YT_ROOT 'venv\\Scripts\\python.exe') -OutputType ConsoleApplication"],
        env=env, capture_output=True, text=True, timeout=30, check=False)
    assert compiled.returncode == 0, compiled.stdout + compiled.stderr
    assert (scripts / 'python.exe').read_bytes()[:2] == b'MZ'
    probe_execution = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; & (Join-Path $env:YT_ROOT 'venv\\Scripts\\python.exe') -c 'import dotenv, openai, rich, prompt_toolkit'; if ($LASTEXITCODE -ne 0) { throw 'native probe execution precondition failed' }; Write-Output 'NATIVE_PROBE_EXECUTED'"],
        env=env, capture_output=True, text=True, timeout=30, check=False)
    assert probe_execution.returncode == 0, probe_execution.stdout + probe_execution.stderr
    assert probe_execution.stdout.strip() == 'NATIVE_PROBE_EXECUTED'
    for stage in stages:
        before_calls = len(events.read_text(encoding='utf-8-sig').splitlines())
        selected_for_stage = {'all'}
        if desktop or stage == 'Stage-Desktop' or any((root / 'apps' / 'desktop' / 'release' / arch / 'Youtab.exe').exists() for arch in ('win-unpacked', 'win-arm64-unpacked')):
            selected_for_stage |= {'wake', 'voice'}
        if token: selected_for_stage.add('messaging')
        env['YT_STAGE'] = stage
        env['YT_PROBE_MARKER'] = str(tmp_path / (stage + '.probe'))
        env['YT_FORCE_MESSAGING_PROBE'] = str(int(stage == 'Install-PlatformSdks'))
        entrypoint = scripts / 'youtab.exe'
        if console and stage == 'Install-Dependencies' and entrypoint.exists():
            entrypoint.unlink()
        result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-Command', STAGE_COMMAND],
                                env=env, capture_output=True, text=True, timeout=30, check=False)
        assert result.returncode == 0, result.stdout + result.stderr
        frame = json.loads(result.stdout.strip())
        if error:
            assert error in frame['error']
        else:
            assert frame['error'] is None
        assert frame['restoredLocation'] and frame['restoredErrorPolicy']
        stage_calls = [json.loads(line) for line in events.read_text(encoding='utf-8-sig').splitlines()][before_calls:]
        for call in stage_calls:
            if '-r' in call:
                assert {'--offline','--no-index','--require-hashes','--no-build','--find-links'} <= set(call)
                assert '--extra' not in call
                assert Path(call[call.index('-r') + 1]).name == 'requirements.txt'
            elif '--editable' in call:
                assert {'--offline','--no-index','--no-deps','--no-build-isolation'} <= set(call)
            else:
                assert call[:2] == ['pip','check']
        if not error or build_failure:
            installed = set(state.read_text(encoding='utf-8-sig').strip().split(','))
            required = {'core', 'web', 'pty', 'voice', 'wake', 'messaging'}
            assert installed == required
    calls = [json.loads(line) for line in events.read_text(encoding='utf-8-sig').splitlines()]
    observed_workdirs = workdirs.read_text(encoding='utf-8-sig').splitlines()
    assert len(observed_workdirs) == len(calls)
    assert all(os.path.normcase(os.path.normpath(path)) == os.path.normcase(os.path.normpath(str(root)))
               for path in observed_workdirs)
    attempts = [call for call in calls if '-r' in call]
    expected_count = sum(2 if console and stage == 'Install-Dependencies' else 1 for stage in stages)
    assert len(attempts) == (fail_call if fail_call else (0 if not has_lock or no_venv else expected_count))
    if console and not fail_call and len(attempts) >= 2 and 'Install-Dependencies' in stages:
        assert any('--reinstall' in call for call in calls if '--editable' in call)
    if fail_call == 1 or not has_lock or no_venv:
        assert state.read_text().strip() == initial_state
    elif fail_call:
        assert set(state.read_text(encoding='utf-8-sig').strip().split(',')) == {'core','web','pty','wake','voice','messaging'}
    if has_lock: assert lock.read_bytes() == b'synthetic immutable lock\n'


@pytest.mark.parametrize('stages,arch,fail_call,build_failure,error', [
    (['Stage-Desktop', 'Install-PlatformSdks', 'Install-Dependencies'], None, 0, False, None),
    (['Install-PlatformSdks', 'Stage-Desktop', 'Install-Dependencies'], None, 0, False, None),
    (['Install-PlatformSdks', 'Install-Dependencies'], 'win-unpacked', 0, False, None),
    (['Install-PlatformSdks', 'Install-Dependencies'], 'win-arm64-unpacked', 0, False, None),
    (['Stage-Desktop'], 'win-unpacked', 1, False, 'no network or reduced fallback'),
    (['Stage-Desktop'], 'win-arm64-unpacked', 1, False, 'no network or reduced fallback'),
    (['Stage-Desktop'], 'win-unpacked', 0, True, 'TEST_DESKTOP_BUILD_FAILED'),
    (['Stage-Desktop'], 'win-arm64-unpacked', 0, True, 'TEST_DESKTOP_BUILD_FAILED'),
])
def test_independent_desktop_without_include_flag_preserves_capabilities(
    tmp_path, stages, arch, fail_call, build_failure, error,
):
    test_customer_dependency_stages_keep_exact_capability_union(
        tmp_path, stages, False, True, fail_call, 'Install-Dependencies' in stages,
        False, True, False, error, desktop_arch=arch, build_failure=build_failure,
    )
