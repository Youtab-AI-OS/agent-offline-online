"""Windows stage tests for the pinned, customer-facing Runtime artifact path."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install.ps1"
SHA = "a" * 40
BASE = "https://api.youtab.io/pilot-runtime-" + "b" * 32 + "/releases"
ROOT = f"youtab-runtime-{SHA}/"
FILES = {
    "scripts/install.ps1": b"# pinned install script\n",
    "pyproject.toml": b"[project]\nname='youtab'\n",
    "apps/desktop/package.json": b'{"name":"youtab"}',
}

# A small but valid prebuilt customer-image inventory exercises the actual
# artifact staging contract without requiring a production Desktop build.
CUSTOMER_FILES = {
    "apps/desktop/release/win-unpacked/Youtab.exe": b"synthetic desktop executable",
    "apps/desktop/release/win-unpacked/resources/app.asar": b"synthetic app archive",
    "apps/desktop/release/win-unpacked/resources/install-stamp.json": b"synthetic stamp",
    "apps/desktop/release/win-unpacked/resources/app.asar.unpacked/dist/native/setup_lease.node": b"synthetic addon",
    "node/node.exe": b"synthetic node executable",
    "browser/agent-browser.exe": b"synthetic browser executable",
    "browser/ms-playwright/browsers.json": b"synthetic browser registry",
    "ui-tui/dist/entry.js": b"synthetic tui entry",
    "youtab_agent_cli/web_dist/index.html": b"synthetic dashboard index",
    "producer-receipt.json": b"synthetic producer receipt",
}
FILES["package-lock.json"] = b'{"lockfileVersion":3}'
FILES.update(CUSTOMER_FILES)
CUSTOMER_RECORDS = [
    {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    for name, data in sorted(CUSTOMER_FILES.items())
]
CUSTOMER_MANIFEST = json.dumps({
    "schema_version": 1,
    "platform": "windows",
    "architecture": "x64",
    "source_sha": SHA,
    "source_qualified": True,
    "producer_receipt_sha256": hashlib.sha256(CUSTOMER_FILES["producer-receipt.json"]).hexdigest(),
    "lock_sha256": hashlib.sha256(FILES["package-lock.json"]).hexdigest(),
    "components": ["browser", "dashboard", "desktop", "node", "tui"],
    "file_count": len(CUSTOMER_RECORDS),
    "total_size": sum(record["size"] for record in CUSTOMER_RECORDS),
    "files": CUSTOMER_RECORDS,
}).encode("utf-8")
FILES["customer-image/windows-x64/manifest.json"] = CUSTOMER_MANIFEST


def _powershell() -> str:
    shell = shutil.which("powershell.exe")
    if not shell:
        pytest.skip("Windows PowerShell 5.1 is required for installer stage tests")
    return shell


def _make_archive(
    path: Path, *, entry: str | None = None, symlink: bool = False,
    customer_fault: str | None = None,
) -> bytes:
    payloads = dict(FILES)
    image_path = "customer-image/windows-x64/manifest.json"
    if customer_fault == "missing_manifest":
        payloads.pop(image_path)
    elif customer_fault == "missing_executable":
        payloads.pop("apps/desktop/release/win-unpacked/Youtab.exe")
    elif customer_fault == "missing_dashboard":
        payloads.pop("youtab_agent_cli/web_dist/index.html")
    elif customer_fault == "altered_executable":
        payloads["apps/desktop/release/win-unpacked/Youtab.exe"] = b"changed executable"
    elif customer_fault in {"unqualified", "receipt_mismatch"}:
        image = json.loads(CUSTOMER_MANIFEST)
        if customer_fault == "unqualified":
            image["source_qualified"] = False
        else:
            image["producer_receipt_sha256"] = "0" * 64
        payloads[image_path] = json.dumps(image).encode("utf-8")
    elif customer_fault is not None:
        raise ValueError("unknown synthetic customer fault")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in payloads.items():
            archive.writestr(ROOT + name, data)
        if entry:
            member = zipfile.ZipInfo(ROOT + entry)
            if symlink:
                member.create_system = 3
                member.external_attr = 0o120777 << 16
            archive.writestr(member, b"outside")
    return payloads.get(image_path, CUSTOMER_MANIFEST)


def _run_stage(
    tmp_path: Path,
    *,
    manifest_change: dict[str, object] | None = None,
    entry: str | None = None,
    symlink: bool = False,
    missing_file: str | None = None,
    malformed_archive: bool = False,
    missing_manifest: bool = False,
    base: str = BASE,
    customer_fault: str | None = None,
) -> tuple[subprocess.CompletedProcess[str], dict[str, object], Path]:
    archive_path = tmp_path / "runtime.zip"
    customer_manifest = _make_archive(archive_path, entry=entry, symlink=symlink, customer_fault=customer_fault)
    if missing_file:
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in FILES.items():
                if name != missing_file:
                    archive.writestr(ROOT + name, data)
    if malformed_archive:
        archive_path.write_bytes(b"not-a-zip")

    manifest: dict[str, object] = {
        "version": "0.19.1",
        "release_sequence": 1,
        "source_sha": SHA,
        "artifact_url": f"{BASE}/{SHA}/youtab-runtime-{SHA}.zip",
        "sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        "install_script_url": f"{BASE}/{SHA}/install-{SHA}.ps1",
        "install_script_sha256": hashlib.sha256(FILES["scripts/install.ps1"]).hexdigest(),
        "created_at": "2026-10-01T00:00:00Z",
        "platform": "windows",
        "architecture": "x64",
        "format": "zip",
        "setup_source_sha": SHA,
        "setup_url": f"{BASE}/{SHA}/Youtab-Setup-{SHA}.exe",
        "setup_sha256": hashlib.sha256(b"synthetic setup").hexdigest(),
        "setup_size": len(b"synthetic setup"),
        "updater_protocol": 1,
        "update_coordination_protocol": 1,
        "customer_image_manifest_sha256": hashlib.sha256(customer_manifest).hexdigest(),
        "customer_image_file_count": len(CUSTOMER_RECORDS),
        "customer_image_total_size": sum(record["size"] for record in CUSTOMER_RECORDS),
    }
    manifest.update(manifest_change or {})
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "existing.txt").write_text("unchanged", encoding="utf-8")

    env = os.environ.copy()
    env.update(
        YT_TEST_MANIFEST=str(manifest_path),
        YT_TEST_ZIP=str(archive_path),
        YT_TEST_INSTALL_DIR=str(install_dir),
        YT_TEST_SHA=SHA,
        YT_TEST_BASE=base,
        YT_TEST_SCRIPT=str(SCRIPT),
        YT_TEST_MISSING_MANIFEST="1" if missing_manifest else "0",
    )
    command = r"""
function git { throw 'Git must not be called in customer release mode' }
function Invoke-RestMethod {
    param($Uri, $MaximumRedirection)
    if ($env:YT_TEST_MISSING_MANIFEST -eq '1') { throw 'HTTP 404' }
    if ($Uri -cne "$env:YT_TEST_BASE/$env:YT_TEST_SHA/manifest.json" -or $MaximumRedirection -ne 0) { throw 'unexpected manifest URL' }
    Get-Content -LiteralPath $env:YT_TEST_MANIFEST -Raw | ConvertFrom-Json
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $MaximumRedirection)
    if ($Uri -cne "$env:YT_TEST_BASE/$env:YT_TEST_SHA/youtab-runtime-$env:YT_TEST_SHA.zip" -or $MaximumRedirection -ne 0) { throw 'unexpected artifact URL' }
    Copy-Item -LiteralPath $env:YT_TEST_ZIP -Destination $OutFile
}
& $env:YT_TEST_SCRIPT -Stage repository -NonInteractive -Json -InstallDir $env:YT_TEST_INSTALL_DIR -Commit $env:YT_TEST_SHA -ReleaseBaseUrl $env:YT_TEST_BASE
"""
    result = subprocess.run(
        [_powershell(), "-NoProfile", "-NonInteractive", "-Command", command],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    frames = [json.loads(line) for line in result.stdout.splitlines() if line.strip().startswith("{")]
    assert len(frames) == 1, result.stdout + result.stderr
    return result, frames[0], install_dir


def test_pinned_artifact_stages_without_mutating_current(tmp_path: Path) -> None:
    result, frame, current = _run_stage(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert frame["ok"] is True
    data = frame["data"]
    assert data["source_sha"] == SHA
    assert data["release_base_url"] == BASE
    assert data["artifact_sha256"] == hashlib.sha256((tmp_path / "runtime.zip").read_bytes()).hexdigest()
    stage = Path(data["staged_install_dir"])
    assert stage.parent == current.parent
    assert stage.name.startswith(current.name + ".new-")
    assert (stage / "scripts" / "install.ps1").read_bytes() == FILES["scripts/install.ps1"]
    assert (current / "existing.txt").read_text(encoding="utf-8") == "unchanged"
    assert not (stage / ".git").exists()


@pytest.mark.parametrize(
    ("fault", "reason"),
    [
        ("missing_manifest", "Customer image manifest"),
        ("missing_executable", "Customer image file is missing"),
        ("missing_dashboard", "Customer image file is missing"),
        ("altered_executable", "Customer image file is missing"),
        ("unqualified", "Customer image identity"),
        ("receipt_mismatch", "Customer image producer receipt"),
    ],
)
def test_bad_customer_image_fails_closed_without_current_mutation(
    tmp_path: Path, fault: str, reason: str,
) -> None:
    result, frame, current = _run_stage(tmp_path, customer_fault=fault)
    assert result.returncode != 0
    assert frame["ok"] is False
    assert reason.lower() in str(frame["reason"]).lower()
    assert (current / "existing.txt").read_text(encoding="utf-8") == "unchanged"
    assert not list(tmp_path.glob("install.new-*"))


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"manifest_change": {"source_sha": "c" * 40}}, "manifest"),
        ({"manifest_change": {"sha256": "0" * 64}}, "SHA256"),
        ({"manifest_change": {"artifact_url": "https://github.com/evil.zip"}}, "manifest"),
        ({"manifest_change": {"install_script_sha256": "0" * 64}}, "install script"),
        ({"manifest_change": {"architecture": "arm64"}}, "manifest"),
        ({"manifest_change": {"customer_image_manifest_sha256": "0" * 64}}, "Customer image manifest"),
        ({"missing_manifest": True}, "404"),
        ({"entry": "../outside.txt"}, "unsafe path"),
        ({"entry": "link", "symlink": True}, "symbolic link"),
        ({"missing_file": "pyproject.toml"}, "missing required"),
        ({"missing_file": "scripts/install.ps1"}, "missing required"),
        ({"malformed_archive": True}, "archive"),
        ({"base": "https://github.com/example/releases"}, "Untrusted release"),
    ],
)
def test_bad_artifact_fails_closed_without_git_or_current_mutation(
    tmp_path: Path, kwargs: dict[str, object], reason: str
) -> None:
    result, frame, current = _run_stage(tmp_path, **kwargs)
    assert result.returncode != 0
    assert frame["ok"] is False
    assert reason.lower() in str(frame["reason"]).lower()
    assert (current / "existing.txt").read_text(encoding="utf-8") == "unchanged"
    assert not list(tmp_path.glob("install.new-*"))


@pytest.mark.parametrize("customer_mode", [True, False])
def test_bootstrap_marker_waits_for_setup_health_only_in_customer_mode(
    tmp_path: Path, customer_mode: bool
) -> None:
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    env = os.environ.copy()
    env.update(YT_TEST_SCRIPT=str(SCRIPT), YT_TEST_INSTALL_DIR=str(install_dir), YT_TEST_SHA=SHA, YT_TEST_BASE=BASE)
    release_args = "-ReleaseBaseUrl $env:YT_TEST_BASE" if customer_mode else ""
    command = (
        "& $env:YT_TEST_SCRIPT -Stage bootstrap-marker -NonInteractive -Json "
        "-InstallDir $env:YT_TEST_INSTALL_DIR -Commit $env:YT_TEST_SHA " + release_args
    )
    result = subprocess.run(
        [_powershell(), "-NoProfile", "-NonInteractive", "-Command", command],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    frames = [json.loads(line) for line in result.stdout.splitlines() if line.strip().startswith("{")]
    assert len(frames) == 1
    assert frames[0]["ok"] is True
    assert frames[0]["skipped"] is customer_mode
    marker = install_dir / ".youtab-agent-runtime-bootstrap-complete"
    assert marker.exists() is not customer_mode
    if not customer_mode:
        assert json.loads(marker.read_text(encoding="utf-8"))["pinnedCommit"] == SHA


def test_customer_artifact_git_stage_is_skipped(tmp_path: Path) -> None:
    env = os.environ.copy()
    env.update(YT_TEST_SCRIPT=str(SCRIPT), YT_TEST_INSTALL_DIR=str(tmp_path / "install"),
               YT_TEST_SHA=SHA, YT_TEST_BASE=BASE)
    command = (
        "& $env:YT_TEST_SCRIPT -Stage git -NonInteractive -Json "
        "-InstallDir $env:YT_TEST_INSTALL_DIR -Commit $env:YT_TEST_SHA "
        "-ReleaseBaseUrl $env:YT_TEST_BASE"
    )
    result = subprocess.run([_powershell(), "-NoProfile", "-NonInteractive", "-Command", command],
                            env=env, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    frames = [json.loads(line) for line in result.stdout.splitlines() if line.strip().startswith("{")]
    assert len(frames) == 1
    assert frames[0]["ok"] is True
    assert frames[0]["skipped"] is True
    assert "not required" in str(frames[0]["reason"])


def _retired_header():
    block, corner = chr(0x2588), chr(0x2557)
    return block * 2 + corner + "  " + block * 2 + corner + block * 7 + corner + block * 6 + corner + " " + block * 3 + corner

@pytest.mark.parametrize("name", ["cli.py", "youtab_agent_cli/banner.py", "ui-tui/src/banner.ts", "assets/renamed-title.txt"])
def test_retired_banner_artifact_rejected_before_promotion(tmp_path, monkeypatch, name):
    monkeypatch.setitem(FILES, name, ('BANNER = "' + _retired_header() + '"\n').encode("utf-8"))
    result, frame, current = _run_stage(tmp_path)
    assert result.returncode != 0
    assert frame["ok"] is False
    assert "retired CLI banner" in str(frame)
    assert (current / "existing.txt").read_text(encoding="utf-8") == "unchanged"
    assert not list(current.parent.glob(current.name + ".new-*"))
