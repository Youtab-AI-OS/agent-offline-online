"""The receipt must follow a successful clean build, never stale output."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

import pytest

from scripts.youtab import customer_windows_producer_receipt as producer

SOURCE_SHA = "a" * 40
BASE = "https://api.youtab.io/pilot-runtime-" + "0" * 32 + "/releases"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo = tmp_path / "checkout"
    repo.mkdir()
    lock = repo / "package-lock.json"
    lock.write_bytes(b"locked source")
    node = tmp_path / "node/node.exe"
    node.parent.mkdir()
    node.write_bytes(b"official synthetic node")
    npm = node.parent / "node_modules/npm/bin/npm-cli.js"
    npm.parent.mkdir(parents=True)
    npm.write_bytes(b"synthetic npm")
    archive = tmp_path / "node.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr(producer.NODE_ARCHIVE_PREFIX, b"")
        output.write(node, producer.NODE_ARCHIVE_PREFIX + "node.exe")
        output.write(npm, producer.NODE_ARCHIVE_PREFIX + "node_modules/npm/bin/npm-cli.js")
    monkeypatch.setattr(producer, "NODE_SHA256", _sha(node.read_bytes()))
    monkeypatch.setattr(producer, "NODE_ARCHIVE_SHA256", _sha(archive.read_bytes()))
    monkeypatch.setattr(producer, "_is_windows", lambda: True)
    monkeypatch.setattr(producer, "_git", lambda _repo, *args: SOURCE_SHA if args[0] == "rev-parse" else "")
    monkeypatch.setattr(producer.subprocess, "check_output", lambda *args, **kwargs: "10.9.4")
    setup = tmp_path / "Youtab-Setup.exe"
    pe = bytearray(512)
    pe[:2] = b"MZ"
    pe[60:64] = (128).to_bytes(4, "little")
    pe[128:134] = b"PE\0\0\x64\x86"
    setup.write_bytes(bytes(pe) + SOURCE_SHA.encode() + BASE.encode()
                      + b"youtab.update-coordination/version1"
                      + b"youtab.setup-handoff/version2")
    return repo, archive, tmp_path / "receipt.json", _sha(lock.read_bytes()), setup


def _fake_build(repo: Path, setup: Path, *, fail_at: int | None = None,
                mutate_lock: bool = False):
    calls = []

    def run(command, *, cwd, env, check):
        assert cwd == repo and check is True
        assert not (repo / "ui-tui/dist/stale.js").exists()
        assert not (repo / "apps/desktop/release/stale.exe").exists()
        index = len(calls)
        calls.append(command)
        if index == fail_at:
            raise subprocess.CalledProcessError(1, command)
        if index == 1:
            lease = repo / "apps/desktop/build/native/setup_lease.node"
            lease.parent.mkdir(parents=True)
            lease.write_bytes(b"synthetic native lease")
        if index == 2:
            tui = repo / "ui-tui/dist/entry.js"
            tui.parent.mkdir(parents=True)
            tui.write_bytes(b"fresh TUI")
        if index == 3:
            web = repo / "youtab_agent_cli/web_dist/index.html"
            web.parent.mkdir(parents=True)
            web.write_bytes(b"fresh dashboard")
        if index == 4:
            assert env["YOUTAB_AGENT_SETUP_LEASE_SHA256"] == _sha(b"synthetic native lease")
            assert env["YOUTAB_AGENT_RELEASE_BASE_URL"] == BASE
            assert env["YOUTAB_AGENT_COORDINATION_SETUP_PATH"] == str(setup)
            desktop = repo / "apps/desktop/release/win-unpacked"
            desktop.mkdir(parents=True)
            (desktop / "Youtab.exe").write_bytes(b"fresh Desktop")
            lease_out = desktop / "resources/app.asar.unpacked/dist/native/setup_lease.node"
            lease_out.parent.mkdir(parents=True)
            lease_out.write_bytes(b"synthetic native lease")
            setup_out = desktop / producer.SETUP_RELATIVE
            setup_out.parent.mkdir(parents=True)
            setup_out.write_bytes(setup.read_bytes())
            stamp = desktop / "resources/install-stamp.json"
            stamp.write_text(json.dumps({
                "releaseBaseUrl": BASE,
                "updateCoordination": {"protocol": 1, "sourceSha": SOURCE_SHA,
                                       "sha256": _sha(setup.read_bytes()),
                                       "size": setup.stat().st_size,
                                       "handoffProtocol": 2},
            }), encoding="utf-8")
            if mutate_lock:
                (repo / "package-lock.json").write_bytes(b"changed lock")
        return subprocess.CompletedProcess(command, 0)

    return run, calls


def test_producer_removes_stale_outputs_then_attests_success(environment, monkeypatch) -> None:
    repo, archive, receipt, lock_sha, setup = environment
    for relative in producer.OUTPUTS:
        stale = repo / relative / ("stale.exe" if relative.endswith("release") else "stale.js")
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_bytes(b"old")
    runner, calls = _fake_build(repo, setup)
    monkeypatch.setattr(producer.subprocess, "run", runner)
    result = producer.run_producer(repo=repo, node_archive=archive, receipt_path=receipt,
                                   source_sha=SOURCE_SHA, lock_sha256=lock_sha,
                                   common_setup=setup, common_setup_sha256=_sha(setup.read_bytes()),
                                   release_base_url=BASE)
    assert len(calls) == 5
    assert calls[3][-4:] == ["run", "build", "--prefix", "web"]
    assert result["tui_sha256"] == _sha(b"fresh TUI")
    assert result["web"]["tree_sha256"] == producer._tree_digest(
        repo / "youtab_agent_cli/web_dist")[2]
    assert producer.verify_receipt(receipt, source_sha=SOURCE_SHA, lock_sha256=lock_sha,
                                   desktop=repo / "apps/desktop/release/win-unpacked",
                                   tui_entry=repo / "ui-tui/dist/entry.js",
                                   web_dist=repo / "youtab_agent_cli/web_dist") == _sha(receipt.read_bytes())


@pytest.mark.parametrize("fail_at,mutate_lock", [(2, False), (None, True)])
def test_failed_build_or_lock_mutation_cannot_mint_receipt(
        environment, monkeypatch, fail_at: int | None, mutate_lock: bool) -> None:
    repo, archive, receipt, lock_sha, setup = environment
    runner, _ = _fake_build(repo, setup, fail_at=fail_at, mutate_lock=mutate_lock)
    monkeypatch.setattr(producer.subprocess, "run", runner)
    with pytest.raises((subprocess.CalledProcessError, ValueError)):
        producer.run_producer(repo=repo, node_archive=archive, receipt_path=receipt,
                              source_sha=SOURCE_SHA, lock_sha256=lock_sha,
                              common_setup=setup, common_setup_sha256=_sha(setup.read_bytes()),
                              release_base_url=BASE)
    assert not receipt.exists()


def test_rejects_setup_hash_or_release_base_before_any_build(environment, monkeypatch) -> None:
    repo, archive, receipt, lock_sha, setup = environment
    runner, calls = _fake_build(repo, setup)
    monkeypatch.setattr(producer.subprocess, "run", runner)
    with pytest.raises(ValueError, match="pinned hash"):
        producer.run_producer(repo=repo, node_archive=archive, receipt_path=receipt,
                              source_sha=SOURCE_SHA, lock_sha256=lock_sha,
                              common_setup=setup, common_setup_sha256="0" * 64,
                              release_base_url=BASE)
    with pytest.raises(ValueError, match="approved Pilot URL"):
        producer.run_producer(repo=repo, node_archive=archive, receipt_path=receipt,
                              source_sha=SOURCE_SHA, lock_sha256=lock_sha,
                              common_setup=setup, common_setup_sha256=_sha(setup.read_bytes()),
                              release_base_url="https://example.com/releases")
    assert not calls and not receipt.exists()
