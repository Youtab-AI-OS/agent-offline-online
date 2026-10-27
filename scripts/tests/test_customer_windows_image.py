"""Behavior tests for the producer-built Desktop image boundary."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "youtab"))
from build_customer_windows_image import build_image, verify_image
from customer_windows_producer_receipt import BUILD_STEPS, NODE_SHA256, _tree_digest


SHA = "a" * 40
BASE = "https://api.youtab.io/pilot-runtime-" + "0" * 32 + "/releases"


def _pe_x64() -> bytes:
    image = bytearray(512)
    image[:2] = b"MZ"
    image[60:64] = (128).to_bytes(4, "little")
    image[128:132] = b"PE\0\0"
    image[132:134] = (0x8664).to_bytes(2, "little")
    return bytes(image)


def _fixture(tmp: Path) -> tuple[Path, Path, Path]:
    desktop = tmp / "win-unpacked"
    resources = desktop / "resources"
    native = resources / "app.asar.unpacked" / "dist" / "native"
    native.mkdir(parents=True)
    (desktop / "Youtab.exe").write_bytes(_pe_x64())
    (resources / "app.asar").write_bytes(b"compiled app")
    (resources / "app.asar.unpacked/dist/index.html").parent.mkdir(parents=True, exist_ok=True)
    (resources / "app.asar.unpacked/dist/index.html").write_bytes(b"<html>Youtab</html>")
    pty = resources / "app.asar.unpacked/dist/node_modules/node-pty"
    (pty / "lib").mkdir(parents=True)
    (pty / "prebuilds/win32-x64").mkdir(parents=True)
    (pty / "package.json").write_bytes(b'{"name":"node-pty"}')
    (pty / "lib/index.js").write_bytes(b"module.exports={}")
    (pty / "prebuilds/win32-x64/pty.node").write_bytes(b"MZ" + b"pty" * 30)
    addon = b"MZ" + b"native Setup lease" * 30
    (native / "setup_lease.node").write_bytes(addon)
    setup = resources / "update-coordination/Youtab-Setup.exe"
    setup.parent.mkdir(parents=True)
    setup.write_bytes(_pe_x64() + b"synthetic Setup identity")
    setup_hash = hashlib.sha256(setup.read_bytes()).hexdigest()
    stamp = {
        "commit": SHA, "dirty": False,
        "releaseBaseUrl": BASE,
        "updateCoordination": {"protocol": 1, "sourceSha": SHA,
                               "sha256": setup_hash, "size": setup.stat().st_size,
                               "handoffProtocol": 2},
        "setupLease": {"napi": "youtab.setup-lease/napi-v1",
                       "sha256": hashlib.sha256(addon).hexdigest(), "size": len(addon)},
    }
    (resources / "install-stamp.json").write_text(json.dumps(stamp), encoding="utf-8")
    lock = tmp / "package-lock.json"
    lock.write_text(json.dumps({"packages": {"": {"name": "youtab"}}}) + " " * 100, encoding="utf-8")
    _receipt(tmp, desktop, lock)
    return desktop, lock, tmp / "output"


def _receipt(tmp: Path, desktop: Path, lock: Path) -> Path:
    count, total, tree = _tree_digest(desktop)
    lease = desktop / "resources/app.asar.unpacked/dist/native/setup_lease.node"
    setup = desktop / "resources/update-coordination/Youtab-Setup.exe"
    receipt = {
        "schema_version": 1, "source_sha": SHA,
        "lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
        "node_sha256": NODE_SHA256, "npm_version": "10.9.4",
        "steps": [{"command": step, "exit_code": 0} for step in BUILD_STEPS],
        "desktop": {"file_count": count, "total_size": total, "tree_sha256": tree},
        "web": {"file_count": 1, "total_size": 1, "tree_sha256": "a" * 64},
        "tui_sha256": hashlib.sha256(b"synthetic tui").hexdigest(),
        "lease_sha256": hashlib.sha256(lease.read_bytes()).hexdigest(),
        "release_base_url": BASE,
        "common_setup": {"sha256": hashlib.sha256(setup.read_bytes()).hexdigest(),
                         "size": setup.stat().st_size},
    }
    path = tmp / "producer-receipt.json"
    path.write_text(json.dumps(receipt), encoding="utf-8")
    return path


def _build(desktop: Path, lock: Path, output: Path):
    return build_image(desktop, lock, SHA, output, hashlib.sha256(lock.read_bytes()).hexdigest(),
                       lock.parent / "producer-receipt.json")


def test_stages_deterministic_bounded_desktop_and_verifies_tamper(tmp_path: Path) -> None:
    desktop, lock, output = _fixture(tmp_path)
    (desktop / "resources" / "debug.map").write_text("source map", encoding="utf-8")
    _receipt(tmp_path, desktop, lock)
    manifest = _build(desktop, lock, output)
    assert manifest["components"] == ["desktop"]
    assert manifest["source_sha"] == SHA
    assert manifest["lock_sha256"] == hashlib.sha256(lock.read_bytes()).hexdigest()
    assert manifest["file_count"] == 9
    assert not (output / "apps/desktop/release/win-unpacked/resources/debug.map").exists()
    verify_image(output, manifest)
    assert json.loads((output / "manifest.json").read_text()) == manifest
    (output / "apps/desktop/release/win-unpacked/resources/app.asar").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="differs from manifest"):
        verify_image(output, manifest)


def test_rejects_unsafe_manifest_paths_and_extra_file(tmp_path: Path) -> None:
    desktop, lock, output = _fixture(tmp_path)
    manifest = _build(desktop, lock, output)
    mutated = json.loads(json.dumps(manifest))
    mutated["files"][0]["path"] = "apps/desktop/release/win-unpacked/../escape"
    with pytest.raises(ValueError, match="unsafe image path"):
        verify_image(output, mutated)
    (output / "unexpected.exe").write_bytes(b"extra")
    with pytest.raises(ValueError, match="differs from manifest"):
        verify_image(output, manifest)


def test_rejects_source_symlink_hardlink_and_secret(tmp_path: Path) -> None:
    desktop, lock, output = _fixture(tmp_path)
    extra = desktop / "secret.key"
    extra.write_bytes(b"not a real key")
    _receipt(tmp_path, desktop, lock)
    with pytest.raises(ValueError, match="credential-like"):
        _build(desktop, lock, output)
    extra.unlink()
    hardlink = desktop / "hardlink.bin"
    try:
        os.link(desktop / "Youtab.exe", hardlink)
    except OSError:
        pass  # Some Windows volumes/profiles deny hardlink creation.
    else:
        with pytest.raises(ValueError, match="single-link|linked or irregular"):
            _build(desktop, lock, output)
        hardlink.unlink()
    _receipt(tmp_path, desktop, lock)
    try:
        os.symlink(desktop / "Youtab.exe", desktop / "linked.exe")
    except OSError:
        pytest.skip("Windows account cannot create test symlinks")
    with pytest.raises(ValueError, match="single-link|linked or irregular"):
        _build(desktop, lock, output)


def test_rejects_bad_stamp_and_private_key_material(tmp_path: Path) -> None:
    desktop, lock, output = _fixture(tmp_path)
    stamp = desktop / "resources/install-stamp.json"
    content = json.loads(stamp.read_text())
    content["commit"] = "b" * 40
    stamp.write_text(json.dumps(content), encoding="utf-8")
    _receipt(tmp_path, desktop, lock)
    with pytest.raises(ValueError, match="does not match source"):
        _build(desktop, lock, output)
    content["commit"] = SHA
    stamp.write_text(json.dumps(content), encoding="utf-8")
    synthetic_key_header = b"-----BEGIN " + b"PRIVATE KEY-----"
    (desktop / "resources" / "note.txt").write_bytes(synthetic_key_header)
    _receipt(tmp_path, desktop, lock)
    with pytest.raises(ValueError, match="private-key material"):
        _build(desktop, lock, output)


def test_rejects_stale_desktop_and_receipt_tamper(tmp_path: Path) -> None:
    desktop, lock, output = _fixture(tmp_path)
    (desktop / "resources/app.asar").write_bytes(b"stale substitute")
    with pytest.raises(ValueError, match="Desktop output differs"):
        _build(desktop, lock, output)
    assert not output.exists()
    _receipt(tmp_path, desktop, lock)
    receipt_path = tmp_path / "producer-receipt.json"
    receipt = json.loads(receipt_path.read_text())
    receipt["steps"][2]["exit_code"] = 1
    receipt_path.write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="producer receipt"):
        _build(desktop, lock, output)


def test_rejects_packaged_setup_handoff_mismatch_even_with_refreshed_tree(
        tmp_path: Path) -> None:
    desktop, lock, output = _fixture(tmp_path)
    stamp_path = desktop / "resources/install-stamp.json"
    stamp = json.loads(stamp_path.read_text())
    stamp["updateCoordination"]["handoffProtocol"] = 1
    stamp_path.write_text(json.dumps(stamp))
    _receipt(tmp_path, desktop, lock)
    with pytest.raises(ValueError, match="packaged common Setup"):
        _build(desktop, lock, output)
    assert not output.exists()
