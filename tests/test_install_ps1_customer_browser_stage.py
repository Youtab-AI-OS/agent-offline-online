"""Native Windows behavior checks for the prebuilt customer install path.

Fixtures use synthetic files and a local Node copy; no network or real home.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install.ps1"
POWERSHELL = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
COMMIT = "a" * 40
REQUIRED = (
    "apps/desktop/release/win-unpacked/Youtab.exe",
    "apps/desktop/release/win-unpacked/resources/app.asar",
    "apps/desktop/release/win-unpacked/resources/install-stamp.json",
    "apps/desktop/release/win-unpacked/resources/app.asar.unpacked/dist/native/setup_lease.node",
    "node/node.exe", "browser/agent-browser.exe",
    "browser/ms-playwright/browsers.json", "ui-tui/dist/entry.js",
    "youtab_agent_cli/web_dist/index.html",
    "producer-receipt.json",
)


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _image(tmp_path: Path, node: Path | None = None) -> tuple[Path, dict[str, object]]:
    root = tmp_path / "runtime"
    root.mkdir()
    (root / "package-lock.json").write_bytes(b"synthetic lock")
    records = []
    for name in REQUIRED:
        path = root.joinpath(*name.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        if name == "node/node.exe" and node is not None:
            shutil.copyfile(node, path)
        elif name.endswith("install-stamp.json"):
            path.write_text(json.dumps({"commit": COMMIT, "dirty": False}), encoding="utf-8")
        else:
            path.write_bytes(("fixture:" + name).encode())
        data = path.read_bytes()
        records.append({"path": name, "size": len(data), "sha256": _hash(data)})
    image = {
        "schema_version": 1, "platform": "windows", "architecture": "x64",
        "source_sha": COMMIT, "source_qualified": True,
        "producer_receipt_sha256": _hash((root / "producer-receipt.json").read_bytes()),
        "lock_sha256": _hash((root / "package-lock.json").read_bytes()),
        "components": ["browser", "dashboard", "desktop", "node", "tui"],
        "file_count": len(records), "total_size": sum(item["size"] for item in records),
        "files": records,
    }
    manifest = root / "customer-image/windows-x64/manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps(image), encoding="utf-8")
    release = {
        "customer_image_manifest_sha256": _hash(manifest.read_bytes()),
        "customer_image_file_count": image["file_count"],
        "customer_image_total_size": image["total_size"],
    }
    return root, release


HARNESS = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production installer parser errors' }
$names = @('Get-FileSha256', 'Assert-CustomerImage', 'Assert-CustomerPrebuiltFile', 'Install-NodeDeps', 'Install-Desktop')
foreach ($name in $names) {
    $definitions = @($ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Expected one production $name function" }
    Invoke-Expression $definitions[0].Extent.Text
}
function Write-Success { param($Message) }
function Write-Warn { param($Message) }
function Write-Info { param($Message) }
function New-DesktopShortcuts { param($TargetExe)
    Add-Content -LiteralPath $env:YT_EVENTS -Value 'shortcuts'
}
function Get-PinnedNodeArchive { param($Arch)
    return [pscustomobject]@{ Version = $env:YT_NODE_VERSION; ExeSha256 = $env:YT_NODE_SHA }
}
function Test-Node { Add-Content -LiteralPath $env:YT_EVENTS -Value 'dev-node'; return $false }
function Ensure-NodeExeOnPath { return $true }
function Get-Command { param($Name)
    if ($Name -eq 'npm') { return [pscustomobject]@{ Source = $env:YT_NPM_SHIM } }
    return $null
}
$InstallDir = $env:YT_INSTALL_ROOT
$Commit = $env:YT_COMMIT
$script:CustomerReleaseMode = $env:YT_CUSTOMER -eq '1'
$script:HasNode = $false
$PrivateHomeRelocation = $false
$release = Get-Content -LiteralPath $env:YT_RELEASE -Raw | ConvertFrom-Json
$failure = $null
try {
    if ($env:YT_CUSTOMER -eq '1') {
        Assert-CustomerImage -Root $InstallDir -SourceSha $Commit -ReleaseManifest $release
        Install-NodeDeps
        Install-Desktop
    } else {
        Install-NodeDeps
    }
} catch { $failure = $_.Exception.Message }
[ordered]@{
    failure = $failure
    hasNode = $script:HasNode
    playwrightPath = $env:PLAYWRIGHT_BROWSERS_PATH
} | ConvertTo-Json -Compress
'''


def _run(
    tmp_path: Path, root: Path, release: dict[str, object],
    *, customer: bool = True, node: Path | None = None,
) -> tuple[dict[str, object], list[str]]:
    assert POWERSHELL.is_file()
    events = tmp_path / "events.txt"
    release_file = tmp_path / "release.json"
    release_file.write_text(json.dumps(release), encoding="utf-8")
    npm = tmp_path / "npm.cmd"
    npm.write_text("@echo off\r\necho npm>>%YT_EVENTS%\r\nexit /b 0\r\n", encoding="ascii")
    env = os.environ.copy()
    env.update({
        "YT_SCRIPT": str(SCRIPT), "YT_INSTALL_ROOT": str(root), "YT_RELEASE": str(release_file),
        "YT_COMMIT": COMMIT, "YT_CUSTOMER": "1" if customer else "0",
        "YT_EVENTS": str(events), "YT_NPM_SHIM": str(npm),
        "YT_NODE_SHA": _hash(node.read_bytes()) if node else "0" * 64,
        "YT_NODE_VERSION": subprocess.check_output([str(node), "--version"], text=True).strip().removeprefix("v") if node else "0",
        "HOME": str(tmp_path), "USERPROFILE": str(tmp_path),
        "APPDATA": str(tmp_path / "Roaming"), "LOCALAPPDATA": str(tmp_path / "Local"),
        "TEMP": str(tmp_path), "TMP": str(tmp_path),
    })
    result = subprocess.run(
        [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HARNESS],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=45, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip().splitlines()[-1])
    return frame, events.read_text(encoding="utf-8").splitlines() if events.exists() else []


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows PowerShell")
def test_customer_uses_verified_prebuilt_components_without_package_tools(tmp_path: Path) -> None:
    node = shutil.which("node.exe")
    if node is None:
        pytest.skip("Local Node executable needed for native version probe")
    root, release = _image(tmp_path, Path(node))
    frame, events = _run(tmp_path, root, release, node=Path(node))
    assert frame["failure"] is None, frame
    assert frame["hasNode"] is True
    assert frame["playwrightPath"] == str(root / "browser/ms-playwright")
    assert events == ["shortcuts"]


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows PowerShell")
@pytest.mark.parametrize("mutation,expected", [
    ("missing-manifest", "Customer image manifest is missing"),
    ("tampered-manifest", "Customer image manifest is missing"),
    ("missing-browser", "Customer image file is missing"),
    ("tampered-desktop", "Customer image file is missing"),
    ("missing-required-record", "Customer image lacks required file"),
    ("wrong-commit", "Customer image identity or inventory differs"),
])
def test_customer_rejects_incomplete_or_tampered_image_before_stage(
    tmp_path: Path, mutation: str, expected: str,
) -> None:
    root, release = _image(tmp_path)
    manifest = root / "customer-image/windows-x64/manifest.json"
    if mutation == "missing-manifest":
        manifest.unlink()
    elif mutation == "tampered-manifest":
        manifest.write_bytes(manifest.read_bytes() + b" ")
    elif mutation == "missing-browser":
        (root / "browser/agent-browser.exe").unlink()
    elif mutation == "tampered-desktop":
        (root / "apps/desktop/release/win-unpacked/Youtab.exe").write_bytes(b"changed")
    else:
        image = json.loads(manifest.read_text(encoding="utf-8"))
        if mutation == "missing-required-record":
            image["files"] = [item for item in image["files"] if item["path"] != "ui-tui/dist/entry.js"]
            image["file_count"] -= 1
            image["total_size"] = sum(item["size"] for item in image["files"])
            release["customer_image_file_count"] = image["file_count"]
            release["customer_image_total_size"] = image["total_size"]
        elif mutation == "wrong-commit":
            image["source_sha"] = "b" * 40
        manifest.write_text(json.dumps(image), encoding="utf-8")
        release["customer_image_manifest_sha256"] = _hash(manifest.read_bytes())
    frame, events = _run(tmp_path, root, release)
    assert expected in frame["failure"], frame
    assert events == []


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows PowerShell")
def test_development_path_does_not_require_customer_image(tmp_path: Path) -> None:
    root = tmp_path / "development"
    root.mkdir()
    (root / "package.json").write_text("{}", encoding="ascii")
    frame, events = _run(tmp_path, root, {}, customer=False)
    assert frame["failure"] is None, frame
    assert events == ["npm"]


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows PowerShell")
@pytest.mark.parametrize("customer,first", [(True, "repository"), (False, "uv")])
def test_stage_manifest_orders_artifact_before_customer_prerequisites(
    customer: bool, first: str,
) -> None:
    command = r'''
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $env:YT_SCRIPT -Raw
$start = $source.IndexOf('$nodeDepsTitle =')
$end = $source.IndexOf('# Stage workers --', $start)
if ($start -lt 0 -or $end -lt 0) { throw 'Stage manifest block not found' }
$script:CustomerReleaseMode = $env:YT_CUSTOMER -eq '1'
$IncludeDesktop = $true
$PythonVersion = '3.11'
Invoke-Expression $source.Substring($start, $end - $start)
@($InstallStages | ForEach-Object { $_.Name }) | ConvertTo-Json -Compress
'''
    env = os.environ.copy()
    env.update(YT_SCRIPT=str(SCRIPT), YT_CUSTOMER="1" if customer else "0")
    result = subprocess.run(
        [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        env=env, capture_output=True, text=True, timeout=20, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    names = json.loads(result.stdout.strip())
    assert names[0] == first
    assert names.index("repository") < names.index("node-deps")
    assert names.index("node-deps") < names.index("desktop")


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows PowerShell and cmd.exe")
@pytest.mark.parametrize("uv_exit", [0, 7])
def test_customer_dependency_sync_uses_exact_lock_and_fails_closed(
    tmp_path: Path, uv_exit: int,
) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    (root / "uv.lock").write_text("synthetic lock", encoding="ascii")
    home = tmp_path / "home"
    home.mkdir()
    events = tmp_path / "uv-arguments.txt"
    uv = tmp_path / "uv.cmd"
    uv.write_text("@echo off\r\necho %*>>%YT_EVENTS%\r\nexit /b %YT_UV_EXIT%\r\n", encoding="ascii")
    command = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production installer parser errors' }
foreach ($name in @('Get-CustomerDependencyExtras', 'Invoke-CustomerLockedDependencySync')) {
    $definitions = @($ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Expected one production $name function" }
    Invoke-Expression $definitions[0].Extent.Text
}
function Invoke-NativeWithRelaxedErrorAction { param([scriptblock]$Command) & $Command }
$InstallDir = $env:YT_INSTALL_ROOT
$YoutabHome = $env:YT_HOME
$UvCmd = $env:YT_UV_SHIM
$IncludeDesktop = $true
$NoVenv = $false
$script:CustomerReleaseMode = $true
$before = (Get-Location).Path
$failure = $null
try { Invoke-CustomerLockedDependencySync -Extra @('messaging') }
catch { $failure = $_.Exception.Message }
@{ failure = $failure; locationRestored = ((Get-Location).Path -eq $before);
   environment = $env:UV_PROJECT_ENVIRONMENT } | ConvertTo-Json -Compress
'''
    env = os.environ.copy()
    env.update({
        "YT_SCRIPT": str(SCRIPT), "YT_INSTALL_ROOT": str(root), "YT_HOME": str(home),
        "YT_UV_SHIM": str(uv), "YT_UV_EXIT": str(uv_exit), "YT_EVENTS": str(events),
        "HOME": str(home), "USERPROFILE": str(home),
        "APPDATA": str(tmp_path / "Roaming"), "LOCALAPPDATA": str(tmp_path / "Local"),
        "TEMP": str(tmp_path), "TMP": str(tmp_path),
    })
    result = subprocess.run(
        [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip().splitlines()[-1])
    assert frame["locationRestored"] is True
    assert frame["environment"] == str(root / "venv")
    assert events.read_text(encoding="utf-8").splitlines() == [
        "sync --locked --no-build --extra all --extra wake --extra voice --extra messaging"
    ]
    if uv_exit:
        assert f"Customer locked dependencies failed (exit {uv_exit})" in frame["failure"]
    else:
        assert frame["failure"] is None


def test_installer_does_not_recommend_disabling_npm_tls_verification() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "npm config set strict-ssl false" not in source
    assert "NODE_EXTRA_CA_CERTS" in source
