"""Native log and scratch artifact path binding at the effect boundary."""

import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from youtab_agent_cli import kanban_db as kb


@pytest.fixture
def storage(tmp_path, monkeypatch):
    home = tmp_path / "synthetic-home"
    home.mkdir()
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(home))
    monkeypatch.delenv("YOUTAB_AGENT_KANBAN_DB", raising=False)
    monkeypatch.delenv("YOUTAB_AGENT_KANBAN_WORKSPACES_ROOT", raising=False)
    monkeypatch.delenv("YOUTAB_AGENT_KANBAN_BOARD", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db(board="default")
    kb.init_db(board="qa")
    return home


def _directory_link(link: Path, target: Path) -> None:
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, text=True, check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
    else:
        link.symlink_to(target, target_is_directory=True)


def _remove_directory_link(link: Path) -> None:
    if os.name == "nt":
        os.rmdir(link)  # Remove only the junction, never its target.
    else:
        link.unlink()


@pytest.mark.parametrize("board", ["default", "qa"])
def test_native_log_handle_appends_after_parent_guard_closes(storage, board):
    path = kb.worker_log_path("t_safe", board=board).absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"first\n")
    with kb.MutationParentGuard(
        path, lambda candidate: kb._validate_worker_log_leaf(candidate, path),
    ) as guard:
        descriptor = kb._open_worker_log_descriptor(path, guard, append=True)
    with os.fdopen(descriptor, "ab", buffering=0) as stream:
        stream.write(b"second\n")
    assert kb.read_worker_log("t_safe", board=board) == "first\nsecond\n"
    assert kb.read_worker_log("t_safe", board=board, tail_bytes=8) == "second\n"


def test_native_log_handle_can_be_inherited_by_worker_process(storage):
    path = kb.worker_log_path("t_child").absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    with kb.MutationParentGuard(
        path, lambda candidate: kb._validate_worker_log_leaf(candidate, path),
    ) as guard:
        descriptor = kb._open_worker_log_descriptor(path, guard, append=True)
    with os.fdopen(descriptor, "ab", buffering=0) as stream:
        completed = subprocess.run(
            [sys.executable, "-c", "print('worker-output')"],
            stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
            check=False, timeout=10,
        )
    assert completed.returncode == 0
    assert kb.read_worker_log("t_child").splitlines() == ["worker-output"]


def test_log_rotation_and_gc_keep_generations_and_unrelated_files(storage):
    path = kb.worker_log_path("t_rotate").absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"newer content")
    older = path.with_name(path.name + ".1")
    older.write_bytes(b"older content")
    kb._rotate_worker_log(path, 3, 2)
    assert not path.exists()
    assert older.read_bytes() == b"newer content"
    assert path.with_name(path.name + ".2").read_bytes() == b"older content"
    unrelated = path.parent / "unrelated.txt"
    unrelated.write_bytes(b"must stay")
    for log in (older, path.with_name(path.name + ".2")):
        os.utime(log, (time.time() - 100, time.time() - 100))
    assert kb.gc_worker_logs(older_than_seconds=10) == 2
    assert unrelated.read_bytes() == b"must stay"


@pytest.mark.parametrize("backup_count", [0, 1])
def test_rotation_does_not_act_on_a_replaced_current_log(storage, monkeypatch, backup_count):
    path = kb.worker_log_path("t_changed").absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"old log over limit")
    parked = path.with_name("parked-old.log")
    original_stat = kb._regular_worker_log
    switched = False

    def swap_after_size_check(target):
        nonlocal switched
        info = original_stat(target)
        if Path(target) == path and not switched:
            switched = True
            path.rename(parked)
            path.write_bytes(b"new log must stay")
        return info

    monkeypatch.setattr(kb, "_regular_worker_log", swap_after_size_check)
    kb._rotate_worker_log(path, 3, backup_count)
    assert switched
    assert path.read_bytes() == b"new log must stay"
    assert parked.read_bytes() == b"old log over limit"
    if backup_count:
        assert not path.with_name(path.name + ".1").exists()


def test_rotation_does_not_move_a_replaced_backup_generation(storage, monkeypatch):
    path = kb.worker_log_path("t_generations").absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"current over limit")
    generation = path.with_name(path.name + ".1")
    generation.write_bytes(b"original backup")
    parked = path.with_name("parked-backup.log")
    original_stat = kb._regular_worker_log
    switched = False

    def swap_after_generation_check(target):
        nonlocal switched
        info = original_stat(target)
        if Path(target) == generation and not switched:
            switched = True
            generation.rename(parked)
            generation.write_bytes(b"replacement backup")
        return info

    monkeypatch.setattr(kb, "_regular_worker_log", swap_after_generation_check)
    kb._rotate_worker_log(path, 3, 2)
    assert switched
    assert generation.read_bytes() == b"replacement backup"
    assert parked.read_bytes() == b"original backup"
    assert not path.with_name(path.name + ".2").exists()


def test_gc_does_not_delete_new_log_replacing_an_old_entry(storage, monkeypatch):
    path = kb.worker_log_path("t_replaced").absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"old")
    os.utime(path, (time.time() - 100, time.time() - 100))
    parked = path.with_name("old-parked.log")
    original_delete = kb._delete_worker_log_leaf
    switched = False

    def swap_before_delete(target, *args, **kwargs):
        nonlocal switched
        if not switched and Path(target) == path:
            switched = True
            path.rename(parked)
            path.write_bytes(b"new log must survive")
        return original_delete(target, *args, **kwargs)

    monkeypatch.setattr(kb, "_delete_worker_log_leaf", swap_before_delete)
    assert kb.gc_worker_logs(older_than_seconds=10) == 0
    assert switched
    assert path.read_bytes() == b"new log must survive"
    assert parked.read_bytes() == b"old"


def test_log_directory_junction_swap_after_path_precheck_is_rejected(storage, tmp_path, monkeypatch):
    path = kb.worker_log_path("t_safe").absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"inside log")
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / path.name
    sentinel.write_bytes(b"outside secret")
    parked = path.parent.with_name("parked-logs")
    original_guard = kb.MutationParentGuard
    switched = False

    def swap_before_guard(target, validate, **kwargs):
        nonlocal switched
        if not switched and Path(target) == path:
            switched = True
            path.parent.rename(parked)
            _directory_link(path.parent, outside)
        return original_guard(target, validate, **kwargs)

    monkeypatch.setattr(kb, "MutationParentGuard", swap_before_guard)
    try:
        assert kb.read_worker_log("t_safe") is None
        assert switched
        assert sentinel.read_bytes() == b"outside secret"
    finally:
        if path.parent.is_symlink() or path.parent.exists():
            _remove_directory_link(path.parent)
        parked.rename(path.parent)


def test_scratch_copy_rejects_source_directory_swap(storage, tmp_path, monkeypatch):
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "report.txt"
    sentinel.write_bytes(b"outside secret")
    with kb.connect(board="default") as conn:
        task_id = kb.create_task(conn, title="copy scratch report")
        workspace = kb.resolve_workspace(kb.get_task(conn, task_id), board="default")
        kb.set_workspace_path(conn, task_id, workspace)
        source_dir = workspace / "output"
        source_dir.mkdir()
        artifact = source_dir / sentinel.name
        artifact.write_bytes(b"inside report")
        parked = workspace / "parked-output"
        original_reader = kb.BoundReadFile
        switched = False

        def swap_before_open(path, validate, maximum):
            nonlocal switched
            if not switched and Path(path) == artifact:
                switched = True
                source_dir.rename(parked)
                _directory_link(source_dir, outside)
            return original_reader(path, validate, maximum)

        monkeypatch.setattr(kb, "BoundReadFile", swap_before_open)
        try:
            with pytest.raises(kb.ArtifactPreservationError):
                kb.complete_task(conn, task_id, metadata={"artifacts": [str(artifact)]})
            assert switched
            assert kb.list_attachments(conn, task_id) == []
            assert sentinel.read_bytes() == b"outside secret"
        finally:
            if source_dir.is_symlink() or source_dir.exists():
                _remove_directory_link(source_dir)
            parked.rename(source_dir)


def test_scratch_copy_keeps_collision_names_and_metadata(storage):
    with kb.connect(board="default") as conn:
        task_id = kb.create_task(conn, title="copy two reports")
        workspace = kb.resolve_workspace(kb.get_task(conn, task_id), board="default")
        kb.set_workspace_path(conn, task_id, workspace)
        first = workspace / "a" / "report.txt"
        second = workspace / "b" / "report.txt"
        first.parent.mkdir()
        second.parent.mkdir()
        first.write_bytes(b"first")
        second.write_bytes(b"second")
        assert kb.complete_task(conn, task_id, metadata={"artifacts": [str(first), str(second)]})
        attachments = kb.list_attachments(conn, task_id)
        assert [(item.filename, Path(item.stored_path).read_bytes()) for item in attachments] == [
            ("report.txt", b"first"), ("report_1.txt", b"second"),
        ]
        run = kb.latest_run(conn, task_id)
        assert run.metadata["artifacts"] == [item.stored_path for item in attachments]


def test_scratch_copy_discards_prior_artifact_when_later_source_is_missing(storage):
    with kb.connect(board="default") as conn:
        task_id = kb.create_task(conn, title="incomplete artifacts")
        workspace = kb.resolve_workspace(kb.get_task(conn, task_id), board="default")
        kb.set_workspace_path(conn, task_id, workspace)
        first = workspace / "report.txt"
        first.write_bytes(b"first")
        missing = workspace / "missing.txt"
        with pytest.raises(kb.ArtifactPreservationError):
            kb.complete_task(conn, task_id, metadata={"artifacts": [str(first), str(missing)]})
        assert kb.list_attachments(conn, task_id) == []
        assert not (kb.task_attachments_dir(task_id) / first.name).exists()


def test_scratch_copy_failure_never_deletes_a_replacement_blob(storage, monkeypatch):
    with kb.connect(board="default") as conn:
        task_id = kb.create_task(conn, title="incomplete artifacts")
        workspace = kb.resolve_workspace(kb.get_task(conn, task_id), board="default")
        kb.set_workspace_path(conn, task_id, workspace)
        first = workspace / "report.txt"
        first.write_bytes(b"first")
        missing = workspace / "missing.txt"
        destination = kb.task_attachments_dir(task_id) / first.name
        parked = destination.with_name("parked-original.txt")
        original_reader = kb.BoundReadFile
        switched = False
        blocked = False

        def replace_before_second_read(path, validate, maximum):
            nonlocal switched, blocked
            if Path(path) == missing:
                switched = True
                try:
                    destination.rename(parked)
                except OSError:
                    blocked = True  # Windows retained handle denies replacement.
                else:
                    destination.write_bytes(b"unrelated replacement")
            return original_reader(path, validate, maximum)

        monkeypatch.setattr(kb, "BoundReadFile", replace_before_second_read)
        with pytest.raises(kb.ArtifactPreservationError):
            kb.complete_task(conn, task_id, metadata={"artifacts": [str(first), str(missing)]})
        assert switched
        if not blocked:
            assert destination.read_bytes() == b"unrelated replacement"
            assert parked.read_bytes() == b"first"
        else:
            assert not destination.exists()


@pytest.mark.parametrize("failure_hook", ["_insert_completion_attachment", "_end_run"])
def test_scratch_copy_is_removed_if_sqlite_completion_fails(storage, monkeypatch, failure_hook):
    with kb.connect(board="default") as conn:
        task_id = kb.create_task(conn, title="late completion failure")
        workspace = kb.resolve_workspace(kb.get_task(conn, task_id), board="default")
        kb.set_workspace_path(conn, task_id, workspace)
        source = workspace / "report.txt"
        source.write_bytes(b"staged bytes")

        def fail_late(*_args, **_kwargs):
            raise RuntimeError("synthetic late completion failure")

        monkeypatch.setattr(kb, failure_hook, fail_late)
        with pytest.raises(RuntimeError, match="synthetic late completion failure"):
            kb.complete_task(conn, task_id, metadata={"artifacts": [str(source)]})
        assert kb.list_attachments(conn, task_id) == []
        assert not (kb.task_attachments_dir(task_id) / source.name).exists()


def test_scratch_copy_survives_post_commit_invariant_error(storage, monkeypatch):
    with kb.connect(board="default") as conn:
        task_id = kb.create_task(conn, title="committed despite diagnostic failure")
        workspace = kb.resolve_workspace(kb.get_task(conn, task_id), board="default")
        kb.set_workspace_path(conn, task_id, workspace)
        source = workspace / "report.txt"
        source.write_bytes(b"durable bytes")

        def fail_after_commit(_conn):
            raise RuntimeError("synthetic post-COMMIT invariant failure")

        monkeypatch.setattr(kb, "_check_file_length_invariant", fail_after_commit)
        with pytest.raises(RuntimeError, match="synthetic post-COMMIT"):
            kb.complete_task(conn, task_id, metadata={"artifacts": [str(source)]})
        attachments = kb.list_attachments(conn, task_id)
        assert len(attachments) == 1
        assert Path(attachments[0].stored_path).read_bytes() == b"durable bytes"
