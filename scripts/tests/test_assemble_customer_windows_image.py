"""Behavior checks for combining independently built customer components."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "youtab"))
from assemble_customer_windows_image import assemble  # noqa: E402
from customer_windows_producer_receipt import _tree_digest  # noqa: E402
from test_customer_windows_image import _build, _fixture  # noqa: E402


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _runtime(root: Path, desktop: dict) -> Path:
    root.mkdir()
    revision = "1234"
    content = {
        "node/node.exe": b"MZnode",
        "browser/agent-browser.exe": b"MZagent",
        "browser/ms-playwright/browsers.json": b'{"browsers":[]}',
        "browser/ms-playwright/chromium-1234/chrome-win64/chrome.exe": b"MZchrome",
        "browser/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe": b"MZheadless",
        "browser/ms-playwright/ffmpeg-1011/ffmpeg-win64.exe": b"MZffmpeg",
        "browser/ms-playwright/winldd-1007/PrintDeps.exe": b"MZwinldd",
        "browser/ms-playwright/chromium-1234/INSTALLATION_COMPLETE": b"",
        "ui-tui/dist/entry.js": b"console.log('Youtab')",
        "youtab_agent_cli/web_dist/index.html": b"<main>dashboard</main>",
    }
    entries = []
    for rel, data in sorted(content.items(), key=lambda pair: pair[0].casefold()):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        entries.append({"path": rel, "size": len(data), "sha256": _sha(data)})
    def inventory(items: list[dict]) -> str:
        digest = hashlib.sha256()
        for item in items:
            digest.update(f'{item["path"]}\0{item["size"]}\0{item["sha256"]}\n'.encode())
        return digest.hexdigest()
    browser = [item for item in entries if item["path"].startswith("browser/ms-playwright/")
               and item["path"] != "browser/ms-playwright/browsers.json"]
    dashboard = [item for item in entries if item["path"].startswith("youtab_agent_cli/web_dist/")]
    manifest = {
        "schema_version": 1, "platform": "windows", "architecture": "x64",
        "source_sha": desktop["source_sha"], "source_qualified": True,
        "lock_sha256": desktop["lock_sha256"],
        "producer_receipt_sha256": desktop["producer_receipt_sha256"],
        "components": ["browser", "dashboard", "node", "tui"],
        "agent_browser_version": "0.26.0", "playwright_chromium_revision": revision,
        "playwright_ffmpeg_revision": "1011", "playwright_winldd_revision": "1007",
        "browser_tree_sha256": inventory(browser), "node_sha256": _sha(content["node/node.exe"]),
        "dashboard_tree_sha256": inventory(dashboard),
        "agent_browser_sha256": _sha(content["browser/agent-browser.exe"]),
        "playwright_browsers_json_sha256": _sha(content["browser/ms-playwright/browsers.json"]),
        "file_count": len(entries), "total_size": sum(item["size"] for item in entries),
        "tree_sha256": inventory(entries), "files": entries,
    }
    (root / "payload-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def _components(tmp_path: Path) -> tuple[Path, Path, Path]:
    desktop_source, lock, _ = _fixture(tmp_path)
    receipt_path = tmp_path / "producer-receipt.json"
    runtime_root = _runtime(tmp_path / "runtime-component", {
        "source_sha": "a" * 40,
        "lock_sha256": _sha(lock.read_bytes()),
        "producer_receipt_sha256": "0" * 64,
    })
    receipt = json.loads(receipt_path.read_text())
    receipt["tui_sha256"] = _sha((runtime_root / "ui-tui/dist/entry.js").read_bytes())
    web = runtime_root / "youtab_agent_cli/web_dist"
    count, total, tree = _tree_digest(web)
    receipt["web"] = {"file_count": count, "total_size": total, "tree_sha256": tree}
    receipt_path.write_text(json.dumps(receipt))
    desktop_root = tmp_path / "desktop-component"
    desktop_manifest = _build(desktop_source, lock, desktop_root)
    runtime_manifest_path = runtime_root / "payload-manifest.json"
    runtime_manifest = json.loads(runtime_manifest_path.read_text())
    runtime_manifest["producer_receipt_sha256"] = desktop_manifest["producer_receipt_sha256"]
    runtime_manifest_path.write_text(json.dumps(runtime_manifest))
    return desktop_root, runtime_root, tmp_path / "combined"


def test_combines_verified_components_at_install_root_paths(tmp_path: Path) -> None:
    desktop, runtime, output = _components(tmp_path)
    manifest = assemble(desktop, runtime, output, tmp_path / "producer-receipt.json")
    assert manifest["components"] == ["browser", "dashboard", "desktop", "node", "tui"]
    assert manifest["file_count"] == 20
    assert (output / "youtab_agent_cli/web_dist/index.html").exists()
    assert (output / "apps/desktop/release/win-unpacked/Youtab.exe").exists()
    assert (output / "node/node.exe").exists()
    assert (output / "browser/agent-browser.exe").exists()
    assert not (output / "payload-manifest.json").exists()
    assert (output / "producer-receipt.json").is_file()
    assert json.loads((output / "manifest.json").read_text()) == manifest


def test_rejects_tampered_runtime_or_unlisted_file_without_output(tmp_path: Path) -> None:
    desktop, runtime, output = _components(tmp_path)
    (runtime / "node/node.exe").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="differs from manifest"):
        assemble(desktop, runtime, output, tmp_path / "producer-receipt.json")
    assert not output.exists()
    (runtime / "node/node.exe").write_bytes(b"MZnode")
    (runtime / "extra.txt").write_text("unexpected")
    with pytest.raises(ValueError, match="unlisted or missing"):
        assemble(desktop, runtime, output, tmp_path / "producer-receipt.json")
    assert not output.exists()


def test_rejects_tampered_dashboard_without_output(tmp_path: Path) -> None:
    desktop, runtime, output = _components(tmp_path)
    (runtime / "youtab_agent_cli/web_dist/index.html").write_text("tampered", encoding="utf-8")
    with pytest.raises(ValueError, match="differs from manifest"):
        assemble(desktop, runtime, output, tmp_path / "producer-receipt.json")
    assert not output.exists()


def test_rejects_cross_source_mismatch_and_browser_digest(tmp_path: Path) -> None:
    desktop, runtime, output = _components(tmp_path)
    path = runtime / "payload-manifest.json"
    manifest = json.loads(path.read_text())
    manifest["source_sha"] = "b" * 40
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="identities differ"):
        assemble(desktop, runtime, output, tmp_path / "producer-receipt.json")
    manifest["source_sha"] = "a" * 40
    manifest["browser_tree_sha256"] = "0" * 64
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="inventory digest"):
        assemble(desktop, runtime, output, tmp_path / "producer-receipt.json")


def test_rejects_provisional_dirty_source(tmp_path: Path) -> None:
    desktop, runtime, output = _components(tmp_path)
    path = runtime / "payload-manifest.json"
    manifest = json.loads(path.read_text())
    manifest["source_qualified"] = False
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="identities differ"):
        assemble(desktop, runtime, output, tmp_path / "producer-receipt.json")


def test_rejects_changed_lock_or_receipt_without_output(tmp_path: Path) -> None:
    desktop, runtime, output = _components(tmp_path)
    receipt_path = tmp_path / "producer-receipt.json"
    receipt = json.loads(receipt_path.read_text())
    receipt["lock_sha256"] = "f" * 64
    receipt_path.write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="producer receipt"):
        assemble(desktop, runtime, output, receipt_path)
    assert not output.exists()
    receipt["lock_sha256"] = json.loads((desktop / "manifest.json").read_text())["lock_sha256"]
    receipt["steps"][1]["exit_code"] = 1
    receipt_path.write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="producer receipt"):
        assemble(desktop, runtime, output, receipt_path)
    assert not output.exists()
