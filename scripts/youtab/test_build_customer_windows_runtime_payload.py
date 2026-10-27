"""Behavior checks for the offline Windows customer runtime assembler."""

from __future__ import annotations

import hashlib
import base64
import json
from pathlib import Path
import subprocess
import tarfile

import pytest

import scripts.youtab.build_customer_windows_runtime_payload as producer
from scripts.youtab.build_customer_windows_runtime_payload import (
    PayloadError,
    _browser_files,
    _inventory,
    build_payload,
)
from scripts.youtab.customer_windows_producer_receipt import BUILD_STEPS, NODE_SHA256, _tree_digest


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_pe(path: Path, marker: bytes = b"test") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = bytearray(128)
    header[:2] = b"MZ"
    header[0x3C:0x40] = (64).to_bytes(4, "little")
    header[64:70] = b"PE\0\0\x64\x86"
    path.write_bytes(header + marker)


@pytest.fixture
def inputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    repo = tmp_path / "repo"
    repo.mkdir()
    lock = {
        "packages": {
            "node_modules/agent-browser": {"version": "0.26.0", "integrity": "sha512-test"},
            "node_modules/playwright-core": {"version": "1.62.1", "integrity": "sha512-test"},
        }
    }
    pw = repo / "node_modules/playwright-core"
    pw.mkdir(parents=True)
    (pw / "package.json").write_text('{"version":"1.62.1"}', encoding="utf-8")
    browsers_json = pw / "browsers.json"
    browsers_json.write_text(json.dumps({"browsers": [
        {"name": "chromium", "revision": "1234"},
        {"name": "chromium-headless-shell", "revision": "1234"},
        {"name": "ffmpeg", "revision": "1011"},
        {"name": "winldd", "revision": "1007"},
    ]}), encoding="utf-8")
    tarball = tmp_path / "playwright-core-1.62.1.tgz"
    with tarfile.open(tarball, "w:gz") as archive:
        archive.add(pw / "package.json", arcname="package/package.json")
        archive.add(browsers_json, arcname="package/browsers.json")
    lock["packages"]["node_modules/playwright-core"]["integrity"] = (
        "sha512-" + base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode("ascii")
    )
    (repo / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "add", "package-lock.json",
                    "node_modules/playwright-core/package.json",
                    "node_modules/playwright-core/browsers.json"], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                    "commit", "-q", "-m", "test"], check=True)
    source_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    supply = tmp_path / "supply"
    supply.mkdir()
    node = supply / "node.exe"
    agent = supply / "agent-browser-win32-x64.exe"
    _write_pe(node)
    _write_pe(agent)
    browsers = supply / "ms-playwright"
    _write_pe(browsers / "chromium-1234/chrome-win64/chrome.exe")
    _write_pe(browsers / "chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe")
    _write_pe(browsers / "ffmpeg-1011/ffmpeg-win64.exe")
    _write_pe(browsers / "winldd-1007/PrintDeps.exe")
    (browsers / "chromium-1234/chrome-win64/resources.pak").write_bytes(b"resource")
    tui = supply / "entry.js"
    tui.write_text("console.log('offline tui')", encoding="utf-8")
    web = supply / "web_dist"
    web.mkdir()
    (web / "index.html").write_text("<main>dashboard</main>", encoding="utf-8")
    web_count, web_total, web_tree = _tree_digest(web)
    receipt = tmp_path / "producer-receipt.json"
    receipt.write_text(json.dumps({
        "schema_version": 1, "source_sha": source_sha,
        "lock_sha256": _sha(repo / "package-lock.json"),
        "node_sha256": NODE_SHA256, "npm_version": "10.9.4",
        "steps": [{"command": step, "exit_code": 0} for step in BUILD_STEPS],
        "desktop": {"file_count": 1, "total_size": 1, "tree_sha256": "a" * 64},
        "web": {"file_count": web_count, "total_size": web_total, "tree_sha256": web_tree},
        "tui_sha256": _sha(tui), "lease_sha256": "b" * 64,
        "release_base_url": "https://api.youtab.io/pilot-runtime-" + "0" * 32 + "/releases",
        "common_setup": {"sha256": "c" * 64, "size": 512},
    }), encoding="utf-8")
    monkeypatch.setattr(producer, "OFFICIAL_NODE_X64_SHA256", _sha(node))
    monkeypatch.setattr(producer, "OFFICIAL_AGENT_BROWSER_X64_SHA256", _sha(agent))
    browser_tree_hash = _inventory(_browser_files(browsers, {
        "chromium": "1234", "chromium-headless-shell": "1234",
        "ffmpeg": "1011", "winldd": "1007",
    }))[1]
    return dict(
        repo=repo, out=tmp_path / "image", source_sha=source_sha,
        expected_lock_sha256=_sha(repo / "package-lock.json"),
        node_exe=node, node_sha256=_sha(node),
        agent_browser_exe=agent, agent_browser_sha256=_sha(agent),
        browser_root=browsers, browser_tree_sha256=browser_tree_hash,
        tui_entry=tui, expected_browsers_json_sha256=_sha(browsers_json),
        web_dist=web,
        playwright_package_dir=pw, playwright_package_tarball=tarball,
        producer_receipt=receipt,
    )


def test_stages_pinned_component_tree(inputs: dict) -> None:
    manifest = build_payload(**inputs)
    out = inputs["out"]
    assert manifest["components"] == ["browser", "dashboard", "node", "tui"]
    assert manifest["source_qualified"] is True
    assert manifest["file_count"] == 10
    assert (out / "youtab_agent_cli/web_dist/index.html").is_file()
    assert manifest["playwright_chromium_revision"] == "1234"
    for record in manifest["files"]:
        assert _sha(out / record["path"]) == record["sha256"]
    assert (out / "payload-manifest.json").is_file()


@pytest.mark.parametrize("field,new_value", [
    ("node_sha256", "0" * 64),
    ("agent_browser_sha256", "0" * 64),
    ("browser_tree_sha256", "0" * 64),
    ("expected_lock_sha256", "0" * 64),
    ("expected_browsers_json_sha256", "0" * 64),
    ("source_sha", "0" * 40),
])
def test_rejects_unapproved_inputs_without_output(inputs: dict, field: str, new_value: str) -> None:
    inputs[field] = new_value
    with pytest.raises(PayloadError):
        build_payload(**inputs)
    assert not inputs["out"].exists()


def test_rejects_browser_mutation_after_approval(inputs: dict) -> None:
    (inputs["browser_root"] / "chromium-1234/chrome-win64/resources.pak").write_bytes(b"changed")
    with pytest.raises(PayloadError, match="browser tree hash mismatch"):
        build_payload(**inputs)


def test_rejects_wrong_arch_executable(inputs: dict) -> None:
    node = inputs["node_exe"]
    _write_pe(node)
    data = bytearray(node.read_bytes())
    data[68:70] = b"\x4c\x01"  # x86 PE machine, not AMD64
    node.write_bytes(data)
    inputs["node_sha256"] = _sha(node)
    with pytest.raises(PayloadError, match="Windows x64"):
        build_payload(**inputs)


def test_rejects_source_map_and_secret_paths(inputs: dict) -> None:
    (inputs["browser_root"] / "chromium-1234/chrome-win64/source.map").write_bytes(b"map")
    with pytest.raises(PayloadError, match="forbidden customer file"):
        build_payload(**inputs)


def test_rejects_existing_output_without_replacement(inputs: dict) -> None:
    inputs["out"].mkdir()
    sentinel = inputs["out"] / "sentinel"
    sentinel.write_text("keep", encoding="utf-8")
    with pytest.raises(PayloadError, match="output already exists"):
        build_payload(**inputs)
    assert sentinel.read_text(encoding="utf-8") == "keep"


def test_rejects_tui_source_map_reference(inputs: dict) -> None:
    inputs["tui_entry"].write_text("//# sourceMappingURL=entry.js.map", encoding="utf-8")
    receipt = json.loads(inputs["producer_receipt"].read_text())
    receipt["tui_sha256"] = _sha(inputs["tui_entry"])
    inputs["producer_receipt"].write_text(json.dumps(receipt))
    with pytest.raises(PayloadError, match="source map"):
        build_payload(**inputs)


def test_dirty_source_requires_explicit_provisional_label(inputs: dict) -> None:
    (inputs["repo"] / "untracked.txt").write_text("unreviewed", encoding="utf-8")
    with pytest.raises(PayloadError, match="dirty"):
        build_payload(**inputs)
    assert not inputs["out"].exists()
    manifest = build_payload(**inputs, allow_dirty_provisional=True)
    assert manifest["source_qualified"] is False


def test_rejects_stale_tui_and_receipt_tamper(inputs: dict) -> None:
    inputs["tui_entry"].write_text("console.log('stale')", encoding="utf-8")
    with pytest.raises(ValueError, match="TUI output differs"):
        build_payload(**inputs)
    receipt = json.loads(inputs["producer_receipt"].read_text())
    receipt["tui_sha256"] = _sha(inputs["tui_entry"])
    receipt["steps"][3]["exit_code"] = 1
    inputs["producer_receipt"].write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="producer receipt"):
        build_payload(**inputs)


def test_rejects_stale_dashboard_and_source_map(inputs: dict) -> None:
    web = inputs["web_dist"]
    (web / "index.html").write_text("tampered", encoding="utf-8")
    with pytest.raises(ValueError, match="dashboard output differs"):
        build_payload(**inputs)
    receipt = json.loads(inputs["producer_receipt"].read_text())
    count, total, tree = _tree_digest(web)
    receipt["web"] = {"file_count": count, "total_size": total, "tree_sha256": tree}
    inputs["producer_receipt"].write_text(json.dumps(receipt))
    (web / "assets/app.js.map").parent.mkdir()
    (web / "assets/app.js.map").write_text("source map", encoding="utf-8")
    with pytest.raises(PayloadError, match="forbidden customer file"):
        build_payload(**inputs)
