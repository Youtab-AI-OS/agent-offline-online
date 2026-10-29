"""Real WinPS functions and actual owned SDK prefix; other deps/UV are stand-ins.

These tests verify installer control flow/arguments, not a full runtime install.
SDK validation, import origins, and postinstall file hashes are genuinely executed.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from tools import windows_pty_dependency as sdk


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/install.ps1"
SHELL = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"


@pytest.fixture(scope="module")
def sdk_runtime(tmp_path_factory):
    if os.name != "nt":
        pytest.skip("Actual Windows PowerShell/native SDK is required")
    context = sdk.installation_context(ROOT)
    root = tmp_path_factory.mktemp("actual-owned-sdk")
    venv = root / "venv"
    result = subprocess.run([sys.executable, "-m", "venv", str(venv)],
                            capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    python = venv / "Scripts/python.exe"
    result = subprocess.run([str(python), "-I", "-m", "pip", "install", "--no-index", "--no-deps", context["wheel_requirement"]],
                            capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    return python, venv / "Lib/site-packages"


UV_STAND_IN = r'''
if ($args[0] -eq 'python' -and $args[1] -eq 'find') {
    $global:LASTEXITCODE = 0
    return $env:SDK_TEST_PYTHON
}
Add-Content -LiteralPath $env:SDK_TEST_EVENTS -Value (ConvertTo-Json -InputObject @($args) -Compress)
if ($args[0] -eq 'sync') { $global:LASTEXITCODE = [int]$env:SDK_TEST_SYNC_EXIT; return }
if ($args[0] -ne 'pip') { throw 'Unexpected UV stand-in operation' }
if ($env:SDK_TEST_CORRUPT -eq '1') { Add-Content -LiteralPath $env:SDK_TEST_SOURCE -Value '# synthetic corrupt SDK' }
if ($args -contains '--reinstall') {
    $cli = Join-Path (Split-Path $env:SDK_TEST_PYTHON) 'synthetic-cli.exe'
    Set-Content -LiteralPath $cli -Value 'secondary entry-point stand-in'
}
if ($args -contains '.[wake,voice]' -and $env:SDK_TEST_VOICE_FAIL -eq '1') { $global:LASTEXITCODE = 17; return }
if ($args -contains '.[all]' -and $env:SDK_TEST_CORE_ONLY -eq '1') { $global:LASTEXITCODE = 17; return }
if ($args -contains '.[web]' -and $env:SDK_TEST_CORE_ONLY -eq '1') { $global:LASTEXITCODE = 17; return }
$global:LASTEXITCODE = 0
'''
HARNESS = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:SDK_TEST_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production installer parser error' }
$names = @('Get-SupportedPythonVersion','Resolve-AvailablePythonVersion','Get-WindowsPtySdkContext',
    'Assert-WindowsPtySdk','Install-Dependencies','Install-DesktopVoiceDeps','Install-PlatformSdks','Invoke-NativeWithRelaxedErrorAction')
foreach ($definition in $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names
}, $true)) { Invoke-Expression $definition.Extent.Text }
function Write-Info { param($Message) }
function Write-Warn { param($Message) Add-Content -LiteralPath $env:SDK_TEST_WARN -Value $Message }
function Write-Success { param($Message) Add-Content -LiteralPath $env:SDK_TEST_SUCCESS -Value $Message }
$InstallDir = $env:SDK_TEST_ROOT
$YoutabHome = $env:SDK_TEST_ROOT
$UvCmd = $env:SDK_TEST_UV
$NoVenv = $env:SDK_TEST_NO_VENV -eq '1'
$PythonVersion = $env:SDK_TEST_MINOR
$PythonFallbackVersions = @('3.12','3.13')
$script:CustomerReleaseMode = $true
$before = (Get-Location).Path
$failure = $null
try {
    if ($env:SDK_TEST_ACTION -eq 'voice') { Install-DesktopVoiceDeps }
    elseif ($env:SDK_TEST_ACTION -eq 'platform') { Install-PlatformSdks }
    else { Install-Dependencies }
} catch { $failure = $_.Exception.Message }
[ordered]@{ error = $failure; errorPolicyRestored = ($ErrorActionPreference -eq 'Stop');
    locationRestored = ((Get-Location).Path -eq $before); tier = $script:InstalledTier } | ConvertTo-Json -Compress
'''


@pytest.mark.parametrize("scenario", ["sync", "pip", "core", "no-venv", "web", "reinstall", "voice", "voice-failure", "tampered-installed", "missing-wheel", "platform", "platform-tamper"])
def test_installer_paths_bind_direct_verified_sdk_and_attest(tmp_path, sdk_runtime, scenario):
    python, site = sdk_runtime
    installed_source = site / "winpty/ptyprocess.py"
    original_source = installed_source.read_bytes()
    root = tmp_path / "product"
    vendor = root / sdk.VENDOR_RELATIVE_DIR
    vendor.parent.mkdir(parents=True)
    shutil.copytree(ROOT / sdk.VENDOR_RELATIVE_DIR, vendor)
    (root / "tools").mkdir()
    shutil.copyfile(ROOT / "tools/windows_pty_dependency.py", root / "tools/windows_pty_dependency.py")
    # A trusted existing interpreter is selected directly; no system SDK writes.
    if scenario != "no-venv":
        (root / "venv").symlink_to(python.parent.parent, target_is_directory=True) if os.name != "nt" else subprocess.run(
            ["cmd.exe", "/c", "mklink", "/J", str(root / "venv"), str(python.parent.parent)],
            capture_output=True, check=True)
    (root / "uv.lock").write_text("secondary resolver stand-in", encoding="ascii")
    (root / "pyproject.toml").write_text(
        '[project]\nname="sdk-controller-fixture"\nversion="0"\n'
        + ('[project.scripts]\nsynthetic-cli="secondary:main"\n' if scenario == "reinstall" else '')
        + '[project.optional-dependencies]\nall=["youtab-agent-runtime[web]"]\n', encoding="ascii")
    (root / "youtab_agent_cli").mkdir()
    (root / "youtab_agent_cli/web_server.py").write_text("pass\n", encoding="ascii")
    if scenario.startswith("platform"):
        (root / ".env").write_text("TELEGRAM_BOT_TOKEN=synthetic-fixture-token\n", encoding="ascii")
    pip_entry = site / "pip/__main__.py"
    original_pip_entry = pip_entry.read_bytes()
    if scenario.startswith("platform"):
        pip_entry.write_text('''import json, os, pathlib, sys
if sys.argv[1:] == ['--version']:
    print('explicit secondary pip transport stand-in')
    raise SystemExit(0)
with open(os.environ['SDK_TEST_EVENTS'], 'a', encoding='utf-8') as stream:
    stream.write(json.dumps(['native-pip'] + sys.argv[1:]) + '\\n')
if os.environ['SDK_TEST_CORRUPT'] == '1':
    with open(os.environ['SDK_TEST_SOURCE'], 'ab') as stream:
        stream.write(b'\\n# synthetic corrupt SDK\\n')
''', encoding="ascii")
    secondary = ["dotenv", "openai", "rich", "prompt_toolkit", "fastapi", "uvicorn"]
    for name in secondary:
        (site / f"{name}.py").write_text("raise ImportError('secondary fixture')\n" if name == "fastapi" and scenario == "web" else "pass\n", encoding="ascii")
    uv = tmp_path / "uv-stand-in.ps1"
    uv.write_text(UV_STAND_IN, encoding="ascii")
    harness = tmp_path / "harness.ps1"
    harness.write_text(HARNESS, encoding="ascii")
    events, success, warnings = tmp_path / "events", tmp_path / "success", tmp_path / "warnings"
    env = os.environ.copy()
    env.update(SDK_TEST_SCRIPT=str(SCRIPT), SDK_TEST_ROOT=str(root), SDK_TEST_UV=str(uv),
               SDK_TEST_PYTHON=str(python), SDK_TEST_MINOR=f"{sys.version_info.major}.{sys.version_info.minor}",
               SDK_TEST_SYNC_EXIT="0" if scenario in ("sync", "web", "reinstall") else "17",
               SDK_TEST_CORE_ONLY="1" if scenario == "core" else "0",
               SDK_TEST_NO_VENV="1" if scenario == "no-venv" else "0",
               SDK_TEST_ACTION="voice" if scenario.startswith("voice") else "platform" if scenario.startswith("platform") else "dependencies",
               SDK_TEST_VOICE_FAIL="1" if scenario == "voice-failure" else "0", SDK_TEST_WARN=str(warnings),
               SDK_TEST_EVENTS=str(events), SDK_TEST_SUCCESS=str(success), SDK_TEST_SOURCE=str(installed_source),
               SDK_TEST_CORRUPT="1" if scenario in ("tampered-installed", "platform-tamper") else "0",
               PATHEXT=".COM;.EXE;.BAT;.CMD")
    if scenario == "missing-wheel":
        (root / sdk.EXPECTED_WHEELS["cp313"]["relative_path"]).unlink()
    try:
        result = subprocess.run([str(SHELL), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(harness)],
                                env=env, capture_output=True, text=True, timeout=45, check=False)
        assert result.returncode == 0, result.stdout + result.stderr
        frame = json.loads(result.stdout.strip().splitlines()[-1])
        commands = [json.loads(line) for line in events.read_text(encoding="utf-8-sig").splitlines()] if events.exists() else []
        messages = success.read_text(encoding="utf-8-sig") if success.exists() else ""
        assert frame["errorPolicyRestored"]
        if scenario in ("tampered-installed", "missing-wheel", "platform-tamper"):
            assert "SDK" in frame["error"]
            assert "All dependencies installed" not in messages
            if scenario == "missing-wheel":
                assert commands == []
            if scenario == "platform-tamper":
                assert "Installed telegram" not in messages
        else:
            assert frame["error"] is None, frame
            if scenario == "voice-failure":
                assert "exit 17" in warnings.read_text(encoding="utf-8-sig")
                assert "Voice + wake-word dependencies installed" not in messages
            else:
                assert "installed" in messages.lower()
            assert frame["locationRestored"]
        for command in commands:
            if command[0] == "sync":
                assert "--locked" in command
                continue
            if command[0] == "native-pip":
                assert command[1] == "install"
            else:
                assert command[:2] == ["pip", "install"]
                assert "--python" in command
            assert "--find-links" in command
            assert command[command.index("--find-links") + 1] == str(vendor)
            assert command[-1].startswith("pywinpty @ file:") and "#sha256=" in command[-1]
        if scenario == "no-venv":
            assert not any(command[0] == "sync" for command in commands)
            assert frame["tier"] != "hash-verified (uv.lock)"
    finally:
        installed_source.write_bytes(original_source)
        pip_entry.write_bytes(original_pip_entry)
        for name in secondary:
            (site / f"{name}.py").unlink(missing_ok=True)
