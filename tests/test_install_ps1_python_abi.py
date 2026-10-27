"""Execute real WinPS5.1 installer functions with explicit synthetic native canaries.

The compiled executable emits pinned version/exit scenarios; it is NOT a Python
interpreter or wheel/ABI proof. A separate probe executes the actual test Python.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install.ps1"
SHELL = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
CANARY = r'''
using System;
using System.IO;
using System.Reflection;
using System.Text;
public class NativeAbiCanary {
  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    string role = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
    string events = Environment.GetEnvironmentVariable("YT_ABI_EVENTS");
    File.AppendAllText(events, role + " " + String.Join(" ", args) + "\n");
    string marker = Environment.GetEnvironmentVariable("YT_ABI_MARKER");
    if (role == "uv") {
      if (args.Length == 3 && args[0] == "python" && args[1] == "find") {
        string available = File.Exists(marker) ? "3.11" : Environment.GetEnvironmentVariable("YT_ABI_AVAILABLE");
        if (args[2] == available) { Console.WriteLine(Environment.GetEnvironmentVariable("YT_ABI_PYTHON")); return 0; }
        return 1;
      }
      if (args.Length == 3 && args[0] == "python" && args[1] == "install") {
        Console.Error.WriteLine("synthetic download progress \u00e9");
        if (Environment.GetEnvironmentVariable("YT_ABI_DOWNLOAD_OK") == "1") { File.WriteAllText(marker, "synthetic"); return 0; }
        return 1;
      }
      throw new Exception("Unexpected synthetic uv operation");
    }
    if (args.Length != 1 || args[0] != "--version") { throw new Exception("Canary only supports --version"); }
    if (Environment.GetEnvironmentVariable("YT_ABI_PROGRESS") == "1") { Console.Error.WriteLine("synthetic native progress \u00e9"); }
    string version = File.Exists(marker) ? "Python 3.11.99" : Environment.GetEnvironmentVariable("YT_ABI_VERSION");
    if (Environment.GetEnvironmentVariable("YT_ABI_STDERR") == "1") { Console.Error.WriteLine(version); }
    else { Console.WriteLine(version); }
    return Int32.Parse(Environment.GetEnvironmentVariable("YT_ABI_EXIT"));
  }
}
'''
HARNESS = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_ABI_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production installer parser errors' }
$assignments = $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $node.Left.VariablePath.UserPath -in @('PythonVersion', 'PythonFallbackVersions')
}, $true)
foreach ($assignment in $assignments) { Invoke-Expression $assignment.Extent.Text }
$names = @('Get-SupportedPythonVersion', 'Resolve-AvailablePythonVersion', 'Test-Python', 'Install-Dependencies')
$functions = $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names
}, $true)
foreach ($definition in $functions) { Invoke-Expression $definition.Extent.Text }
function Write-Info { param($Message) }
function Write-Warn { param($Message) }
function Write-Success { param($Message) }
function Write-Err { param($Message) }
function Invoke-NativeWithRelaxedErrorAction { param([scriptblock]$Operation)
    $script:DependencyCalls += 1
    throw 'SYNTHETIC_DEPENDENCY_BOUNDARY'
}
# This suite isolates ABI selection; SDK attestation has real-interpreter tests.
function Get-WindowsPtySdkContext { param($PythonExe)
    $script:SdkPreflightCalls += 1
    throw 'SYNTHETIC_SDK_PREFLIGHT_BOUNDARY'
}
$UvCmd = $env:YT_ABI_UV
$InstallDir = $env:YT_ABI_ROOT
$NoVenv = $env:YT_ABI_NO_VENV -eq '1'
$script:DependencyCalls = 0
$script:SdkPreflightCalls = 0
$beforeLocation = (Get-Location).Path
$failure = $null; $value = $null
try {
    switch ($env:YT_ABI_MODE) {
        'resolve' { $value = Resolve-AvailablePythonVersion }
        'python' { $value = Test-Python }
        'probe' { $value = Get-SupportedPythonVersion -PythonExe $env:YT_ABI_PYTHON }
        'dependencies' { Install-Dependencies }
        default { throw 'Unknown synthetic test mode' }
    }
} catch { $failure = $_.Exception.Message }
[ordered]@{ value = $value; error = $failure; selected = $PythonVersion;
    errorPolicyRestored = ($ErrorActionPreference -eq 'Stop');
    locationRestored = ((Get-Location).Path -eq $beforeLocation);
    dependencyCalls = $script:DependencyCalls;
    sdkPreflightCalls = $script:SdkPreflightCalls;
    dependencyPython = $env:UV_PYTHON;
    hostVersion = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress
'''


@pytest.fixture(scope="module")
def native_canary(tmp_path_factory):
    if os.name != "nt":
        pytest.skip("Behavior requires actual Windows PowerShell 5.1")
    assert SHELL.is_file(), "Windows PowerShell 5.1 is required"
    root = tmp_path_factory.mktemp("native-abi-canary")
    source = root / "canary.cs"
    source.write_text(CANARY, encoding="utf-8")
    exe = root / "canary.exe"
    command = "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:YT_ABI_CS)) -OutputAssembly $env:YT_ABI_EXE -OutputType ConsoleApplication -Language CSharp"
    env = os.environ.copy()
    env.update(YT_ABI_CS=str(source), YT_ABI_EXE=str(exe))
    result = subprocess.run([str(SHELL), "-NoProfile", "-NonInteractive", "-Command", command],
                            env=env, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert exe.is_file()
    return exe


def _run(tmp_path, native_canary, mode, *, available="", version="Python 3.11.99",
         exit_code=0, stderr=False, progress=False, download=False, no_venv=False, real=False, store_path=False):
    root = tmp_path / "synthetic install with spaces"
    binary = tmp_path / "bin" / "WindowsApps" if store_path else tmp_path / "bin"
    binary.mkdir(parents=True)
    root.mkdir()
    python = binary / "python.exe"
    uv = binary / "uv.exe"
    shutil.copyfile(native_canary, python)
    shutil.copyfile(native_canary, uv)
    venv = root / "venv" / "Scripts"
    venv.mkdir(parents=True)
    shutil.copyfile(native_canary, venv / "python.exe")
    (root / "uv.lock").write_text("synthetic dependency boundary\n", encoding="ascii")
    harness = tmp_path / "harness.ps1"
    harness.write_text(HARNESS, encoding="ascii")
    events = tmp_path / "events.txt"
    env = os.environ.copy()
    env.update(
        YT_ABI_SCRIPT=str(SCRIPT), YT_ABI_CS="", YT_ABI_MODE=mode,
        YT_ABI_ROOT=str(root), YT_ABI_UV=str(uv), YT_ABI_PYTHON=sys.executable if real else str(python),
        YT_ABI_AVAILABLE=available, YT_ABI_VERSION=version, YT_ABI_EXIT=str(exit_code),
        YT_ABI_STDERR=str(int(stderr)), YT_ABI_PROGRESS=str(int(progress)),
        YT_ABI_DOWNLOAD_OK=str(int(download)), YT_ABI_NO_VENV=str(int(no_venv)),
        YT_ABI_EVENTS=str(events), YT_ABI_MARKER=str(tmp_path / "download-marker"),
        PATH=str(binary) + os.pathsep + os.environ.get("PATH", ""),
        PATHEXT=".COM;.EXE;.BAT;.CMD",
        COMSPEC=str(Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/cmd.exe"),
    )
    canary_result = subprocess.run([str(python), "--version"], env=env,
                                   capture_output=True, text=True, timeout=10, check=False)
    assert canary_result.returncode == exit_code, canary_result.stdout + canary_result.stderr
    if not real:
        assert version in canary_result.stdout + canary_result.stderr
    result = subprocess.run([str(SHELL), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(harness)],
                            env=env, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip().splitlines()[-1])
    assert frame["hostVersion"].startswith("5.1.")
    assert frame["errorPolicyRestored"]
    frame["nativeCanarySha256"] = hashlib.sha256(native_canary.read_bytes()).hexdigest()
    frame["syntheticInterpreter"] = not real
    (tmp_path / "native-frame.json").write_text(json.dumps(frame, indent=2), encoding="utf-8")
    return frame, events.read_text(encoding="utf-8-sig").splitlines() if events.exists() else []


def test_unsupported_310_not_selected_from_uv(tmp_path, native_canary):
    frame, events = _run(tmp_path, native_canary, "resolve", available="3.10", version="Python 3.10.99")
    assert frame["value"] is None, frame
    assert "uv python find 3.10" not in events


def test_unsupported_314_not_accepted_from_path(tmp_path, native_canary):
    frame, _ = _run(tmp_path, native_canary, "python", version="Python 3.14.99")
    assert frame["value"] is False, frame


@pytest.mark.parametrize("minor", ["3.11", "3.12", "3.13"])
def test_supported_existing_interpreter_selected(tmp_path, native_canary, minor):
    frame, _ = _run(tmp_path, native_canary, "resolve", available=minor, version=f"Python {minor}.99")
    assert frame["value"] == minor


@pytest.mark.parametrize("minor", ["3.11", "3.12", "3.13"])
def test_supported_path_fallback_records_actual_minor(tmp_path, native_canary, minor):
    frame, _ = _run(tmp_path, native_canary, "python", version=f"Python {minor}.99")
    assert frame["value"] is True
    assert frame["selected"] == minor


def test_download_fallback_and_native_stderr_policy_preserved(tmp_path, native_canary):
    frame, events = _run(tmp_path, native_canary, "python", version="Python 3.14.99", download=True)
    assert frame["value"] is True
    assert frame["selected"] == "3.11"
    assert "uv python install 3.11" in events


@pytest.mark.parametrize("version,exit_code", [
    ("Python 3.10.99", 0), ("Python 3.14.99", 0), ("Python 3.110.99", 0),
    ("not a Python version", 0), ("Python 3.11.99", 7),
])
def test_actual_candidate_output_and_exit_are_validated(tmp_path, native_canary, version, exit_code):
    frame, _ = _run(tmp_path, native_canary, "resolve", available="3.11", version=version, exit_code=exit_code)
    assert frame["value"] is None


@pytest.mark.parametrize("stderr,progress", [(True, False), (False, True)])
def test_supported_native_stderr_version_or_progress_preserves_error_policy(tmp_path, native_canary, stderr, progress):
    frame, _ = _run(tmp_path, native_canary, "probe", version="Python 3.12.99", stderr=stderr, progress=progress)
    assert frame["value"] == "3.12"


@pytest.mark.parametrize("minor", ["3.10", "3.14"])
def test_existing_unsupported_venv_refused_before_dependencies(tmp_path, native_canary, minor):
    frame, _ = _run(tmp_path, native_canary, "dependencies", version=f"Python {minor}.99")
    assert frame["dependencyCalls"] == 0
    assert frame["locationRestored"]
    assert "Python 3.11, 3.12, or 3.13" in frame["error"]


def test_existing_supported_venv_can_reach_sdk_preflight_boundary(tmp_path, native_canary):
    frame, _ = _run(tmp_path, native_canary, "dependencies", version="Python 3.13.99")
    assert frame["dependencyCalls"] == 0
    assert frame["sdkPreflightCalls"] == 1
    assert frame["error"] == "SYNTHETIC_SDK_PREFLIGHT_BOUNDARY"


@pytest.mark.parametrize("available", ["", "3.12"])
def test_no_venv_validated_path_is_pinned_before_dependency_boundary(tmp_path, native_canary, available):
    frame, _ = _run(tmp_path, native_canary, "dependencies", available=available,
                    version="Python 3.12.99", no_venv=True)
    assert frame["dependencyCalls"] == 0
    assert frame["sdkPreflightCalls"] == 1
    assert frame["selected"] == "3.12"
    assert frame["dependencyPython"] == str(tmp_path / "bin" / "python.exe")


@pytest.mark.parametrize("minor", ["3.10", "3.14"])
def test_no_venv_unsupported_path_cannot_start_dependency_operations(tmp_path, native_canary, minor):
    frame, _ = _run(tmp_path, native_canary, "dependencies", available=minor,
                    version=f"Python {minor}.99", no_venv=True)
    assert frame["dependencyCalls"] == 0
    assert frame["locationRestored"]
    assert "Python 3.11, 3.12, or 3.13" in frame["error"]


def test_real_test_interpreter_passes_supported_probe(tmp_path, native_canary):
    frame, _ = _run(tmp_path, native_canary, "probe", real=True)
    assert frame["syntheticInterpreter"] is False
    assert frame["value"] == f"{sys.version_info.major}.{sys.version_info.minor}"


@pytest.mark.parametrize("mode", ["probe", "python"])
def test_store_stub_location_is_not_adopted(tmp_path, native_canary, mode):
    frame, _ = _run(tmp_path, native_canary, mode, store_path=True)
    assert frame["value"] is (None if mode == "probe" else False)
