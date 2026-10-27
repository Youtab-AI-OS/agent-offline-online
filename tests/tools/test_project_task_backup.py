from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from tools import project_task_backup as backup


@pytest.fixture
def paths(tmp_path):
    workspace = tmp_path / "project"
    home = tmp_path / "synthetic-profile"
    workspace.mkdir()
    home.mkdir()
    return workspace, home


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_complete_ready_covers_secrets_large_binary_and_empty_directory(paths):
    work, home = paths
    (work / ".env").write_bytes(b"SYNTHETIC_TEST_VALUE=not-a-real-key\n")
    (work / "large.bin").write_bytes(b"x" * (11 * 1024 * 1024))
    (work / "empty").mkdir()
    receipt = backup.snapshot([{"path": str(work)}], "synthetic-turn", home=home)
    manifest = backup.verify(receipt, home=home)
    assert receipt["status"] == "READY"
    entries = {item["path"]: item for item in manifest["roots"][0]["entries"]}
    assert entries[".env"]["sha256"] == sha(work / ".env")
    assert entries["large.bin"]["size"] == 11 * 1024 * 1024
    assert entries["empty"]["kind"] == "dir"
    assert Path(receipt["retained_directory"]).is_relative_to(work / "Youtab")
    assert len(backup.list_backups(str(work), home=home)) == 1


def test_source_and_copy_are_independent_declared_roots(paths):
    source, home = paths
    working = source / "Youtab" / "Demo"
    working.mkdir(parents=True)
    (source / "original.md").write_text("original")
    (working / "original.md").write_text("working")
    receipt = backup.snapshot([{"path": str(working)}, {"path": str(source), "excluded": ["Youtab/Demo"]}], "task", home=home)
    manifest = backup.verify(receipt, home=home)
    assert "Youtab/Demo" in manifest["roots"][1]["excluded"]
    assert "original.md" in [entry["path"] for entry in manifest["roots"][1]["entries"]]
    assert next(item for item in manifest["roots"][0]["entries"] if item["path"] == "original.md")["sha256"] != next(item for item in manifest["roots"][1]["entries"] if item["path"] == "original.md")["sha256"]


def test_bound_failure_never_advertises_partial_coverage_as_ready(paths, monkeypatch):
    work, home = paths
    (work / "a").write_text("a")
    (work / "b").write_text("b")
    monkeypatch.setattr(backup, "MAX_ENTRIES", 1)
    with pytest.raises(backup.ProjectBackupError, match="limit"):
        backup.snapshot([{"path": str(work)}], "task", home=home)
    assert backup.list_backups(str(work), home=home) == []
    assert (work / "a").read_text() == "a"


def test_changed_source_inventory_fails_closed(paths, monkeypatch):
    work, home = paths
    (work / "a").write_text("a")
    original = backup._inventory
    calls = 0
    def inventory(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            (work / "new").write_text("external change")
        return original(*args, **kwargs)
    monkeypatch.setattr(backup, "_inventory", inventory)
    with pytest.raises(backup.ProjectBackupError, match="changed during backup"):
        backup.snapshot([{"path": str(work)}], "task", home=home)
    assert backup.list_backups(str(work), home=home) == []


def test_tampered_payload_or_manifest_cannot_be_used_or_advertised(paths):
    work, home = paths
    (work / "a").write_text("original")
    receipt = backup.snapshot([{"path": str(work)}], "task", home=home)
    copied = Path(receipt["directory"]) / "root-0" / "a"
    copied.write_text("tampered")
    with pytest.raises(backup.ProjectBackupError, match="verification"):
        backup.verify(receipt, home=home)
    assert backup.list_backups(str(work), home=home) == []


def test_receipt_is_bound_to_exact_project_and_manifest(paths):
    work, home = paths
    (work / "a").write_text("a")
    other = work.parent / "other"
    other.mkdir()
    receipt = backup.snapshot([{"path": str(work)}], "task", home=home)
    with pytest.raises(backup.ProjectBackupError, match="does not belong"):
        backup.verify({**receipt, "workspace": str(other)}, home=home)
    with pytest.raises(backup.ProjectBackupError, match="manifest changed"):
        backup.verify({**receipt, "manifest_sha256": "0" * 64}, home=home)


def test_rejects_relative_and_overly_broad_roots(paths):
    work, home = paths
    with pytest.raises(backup.ProjectBackupError, match="absolute"):
        backup.snapshot([{"path": "relative"}], "task", home=home)
    with pytest.raises(backup.ProjectBackupError, match="too broad"):
        backup.snapshot([{"path": work.anchor}], "task", home=home)
    with pytest.raises(backup.ProjectBackupError, match="too broad"):
        backup.snapshot([{"path": str(home)}], "task", home=home)


def test_files_only_restore_preserves_chat_and_unrelated_new_files(paths):
    work, home = paths
    (work / "a").write_text("before")
    chat = home / "synthetic-chat.db"
    chat.write_bytes(b"synthetic chat sentinel")
    chat_hash = sha(chat)
    receipt = backup.snapshot([{"path": str(work)}], "task", home=home)
    (work / "a").write_text("after")
    (work / "new").write_text("unrelated output")
    result = backup.restore_files({**receipt, "directory": str(work.parent / "untrusted")}, ["a"], {"a": sha(work / "a")}, home=home)
    assert result["status"] == "RESTORED"
    assert result["chats_changed"] is False
    assert (work / "a").read_text() == "before"
    assert (work / "new").read_text() == "unrelated output"
    assert sha(chat) == chat_hash
    backup.verify(result["undo_receipt"], home=home)


def test_restore_rejects_external_change_or_uncovered_path_before_writing(paths):
    work, home = paths
    (work / "a").write_text("before")
    receipt = backup.snapshot([{"path": str(work)}], "task", home=home)
    preview_hash = sha(work / "a")
    (work / "a").write_text("external newer edit")
    with pytest.raises(backup.ProjectBackupError, match="changed since"):
        backup.restore_files(receipt, ["a"], {"a": preview_hash}, home=home)
    assert (work / "a").read_text() == "external newer edit"
    with pytest.raises(backup.ProjectBackupError, match="not covered"):
        backup.restore_files(receipt, ["../outside"], {"../outside": None}, home=home)


def test_manifest_traversal_is_rejected_even_if_caller_supplies_recomputed_hash(paths):
    work, home = paths
    (work / "a").write_text("before")
    receipt = backup.snapshot([{"path": str(work)}], "task", home=home)
    manifest_path = Path(receipt["directory"]) / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["roots"][0]["entries"][0]["path"] = "../outside"
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(backup.ProjectBackupError, match="relative path"):
        backup.verify({**receipt, "manifest_sha256": sha(manifest_path)}, home=home)


def test_deleted_parent_can_be_previewed_and_recreated_from_covered_manifest(paths):
    work, home = paths
    folder = work / "sub"
    folder.mkdir()
    (folder / "a.txt").write_text("before")
    receipt = backup.snapshot([{"path": str(work)}], "task", home=home)
    (folder / "a.txt").unlink()
    folder.rmdir()
    preview = backup.prepare_restore(str(work), receipt["id"], ["sub/a.txt"], home=home)
    assert preview["files"][0]["current_sha256"] is None
    result = backup.commit_restore(str(work), receipt["id"], preview["token"], True, home=home)
    assert result["status"] == "RESTORED"
    assert (folder / "a.txt").read_text() == "before"


def test_restore_preview_is_explicit_one_use_and_bound_to_current_hash(paths):
    work, home = paths
    (work / "a").write_text("before")
    receipt = backup.snapshot([{"path": str(work)}], "task", home=home)
    (work / "a").write_text("after")
    preview = backup.prepare_restore(str(work), receipt["id"], ["a"], home=home)
    with pytest.raises(backup.ProjectBackupError, match="Explicit confirmation"):
        backup.commit_restore(str(work), receipt["id"], preview["token"], False, home=home)
    (work / "a").write_text("newer external write")
    with pytest.raises(backup.ProjectBackupError, match="changed since"):
        backup.commit_restore(str(work), receipt["id"], preview["token"], True, home=home)
    with pytest.raises(backup.ProjectBackupError, match="already used"):
        backup.commit_restore(str(work), receipt["id"], preview["token"], True, home=home)
    assert (work / "a").read_text() == "newer external write"


def test_partial_restore_returns_actual_files_and_verified_undo_receipt(paths, monkeypatch):
    work, home = paths
    for name in ["a", "b"]:
        (work / name).write_text("before")
    receipt = backup.snapshot([{"path": str(work)}], "task", home=home)
    for name in ["a", "b"]:
        (work / name).write_text("after")
    real_replace = backup.os.replace
    def replace(source, target):
        if Path(target).name == "b":
            raise OSError("synthetic replacement failure")
        return real_replace(source, target)
    monkeypatch.setattr(backup.os, "replace", replace)
    result = backup.restore_files(receipt, ["a", "b"], {name: sha(work/name) for name in ["a", "b"]}, home=home)
    assert result["status"] == "PARTIAL"
    assert result["files"] == ["a"]
    assert "synthetic replacement failure" in result["error"]
    backup.verify(result["undo_receipt"], home=home)
    assert list(work.glob(".youtab-restore-*.tmp")) == []


def test_link_or_reparse_source_is_rejected_before_ready(paths):
    work, home = paths
    other = work.parent / "outside"
    other.mkdir()
    link = work / "linked"
    try:
        link.symlink_to(other, target_is_directory=True)
    except OSError:
        # Windows junction creation does not require Developer Mode.
        import subprocess
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(other)], capture_output=True)
        assert result.returncode == 0, result.stderr
    try:
        with pytest.raises(backup.ProjectBackupError, match="linked/reparse"):
            backup.snapshot([{"path": str(work)}], "task", home=home)
        assert backup.list_backups(str(work), home=home) == []
    finally:
        if link.is_symlink():
            link.unlink()
        else:
            link.rmdir()


def test_retained_project_backup_preserves_existing_youtab_content_and_has_no_recursion(paths):
    work, home = paths
    user_dir = work / "Youtab"
    user_dir.mkdir()
    (user_dir / "customer-original.txt").write_text("must stay covered")
    (work / "a").write_text("original")
    first = backup.snapshot([{"path": str(work)}], "first", home=home)
    second = backup.snapshot([{"path": str(work)}], "second", home=home)
    manifest = backup.verify(second, home=home)
    entries = manifest["roots"][0]["entries"]
    assert any(item["path"] == "Youtab/customer-original.txt" for item in entries)
    assert all(".youtab-task-backups-v1-" not in item["path"] for item in entries)
    assert Path(first["retained_directory"]).parent == Path(second["retained_directory"]).parent
    assert (user_dir / "customer-original.txt").read_text() == "must stay covered"
    retained = Path(second["retained_directory"])
    # The actual recoverable bytes do not reference the application's profile.
    (Path(second["directory"]) / "manifest.json").unlink()
    assert (retained / "root-0" / "a").read_text() == "original"
    local_manifest = json.loads((retained / "manifest.json").read_text())
    assert next(item for item in local_manifest["roots"][0]["entries"] if item["path"] == "a")["sha256"] == sha(retained / "root-0" / "a")


def test_required_local_mirror_failure_never_returns_or_lists_ready(paths, monkeypatch):
    work, home = paths
    (work / "a").write_text("original")
    def fail(*args, **kwargs):
        raise OSError("synthetic retained backup failure")
    monkeypatch.setattr(backup, "_mirror_snapshot", fail)
    with pytest.raises(OSError, match="retained backup failure"):
        backup.snapshot([{"path": str(work)}], "task", home=home)
    assert backup.list_backups(str(work), home=home) == []
    assert (work / "a").read_text() == "original"


def test_mapped_source_restore_and_next_task_do_not_capture_retained_backups_recursively(paths):
    source, home = paths
    work = source / "Youtab" / "Demo"
    work.mkdir(parents=True)
    (source / "original.md").write_text("original")
    (work / "a.txt").write_text("before")
    roots = [{"path": str(work)}, {"path": str(source), "excluded": ["Youtab/Demo"]}]
    receipt = backup.snapshot(roots, "first", home=home)
    (work / "a.txt").write_text("after")
    result = backup.restore_files(receipt, ["a.txt"], {"a.txt": sha(work/"a.txt")}, home=home)
    assert result["status"] == "RESTORED"
    assert Path(result["undo_receipt"]["retained_directory"]).parent == Path(receipt["retained_directory"]).parent
    following = backup.snapshot(roots, "next-task", home=home)
    for root in backup.verify(following, home=home)["roots"]:
        assert not any(".youtab-task-backups-v1-" in item["path"] for item in root["entries"])


def test_effect_lease_serializes_another_runtime_process_for_same_profile(paths):
    import subprocess
    import sys
    import time
    work, home = paths
    ready = home / "child-ready"
    acquired = home / "child-acquired"
    script = "from pathlib import Path; import sys; from tools.project_task_backup import _lock; h=Path(sys.argv[1]); (h/'child-ready').write_text('ready', encoding='utf-8'); exec(\"with _lock('nested-root', home=h):\\n    (h/'child-acquired').write_text('acquired', encoding='utf-8')\")"
    with backup._lock(str(work), home=home):
        child = subprocess.Popen([sys.executable, "-c", script, str(home)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline and child.poll() is None:
            time.sleep(0.02)
        assert ready.exists(), child.communicate(timeout=2)
        assert not acquired.exists()
    output, error = child.communicate(timeout=5)
    assert child.returncode == 0, (output, error)
    assert acquired.read_text(encoding="utf-8") == "acquired"
