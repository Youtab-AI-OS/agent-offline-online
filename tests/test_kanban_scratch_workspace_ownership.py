"""Destructive scratch cleanup requires the actual board/task's ownership."""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from youtab_agent_cli import kanban_db as kb


@pytest.fixture
def storage(tmp_path, monkeypatch):
    home = tmp_path / "synthetic-home"
    home.mkdir()
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(home))
    for name in ("YOUTAB_AGENT_KANBAN_DB", "YOUTAB_AGENT_KANBAN_WORKSPACES_ROOT", "YOUTAB_AGENT_KANBAN_HOME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db(board="default")
    kb.init_db(board="qa")
    return home


@pytest.fixture
def client(storage):
    source = Path(__file__).resolve().parents[1] / "plugins/kanban/dashboard/plugin_api.py"
    spec = importlib.util.spec_from_file_location("kanban_scratch_ownership_router", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/kanban")
    return TestClient(app)


def _workspace(conn, task_id, board):
    path = kb.resolve_workspace(kb.get_task(conn, task_id), board=board)
    kb.set_workspace_path(conn, task_id, path)
    return path


@pytest.mark.parametrize("victim_board,alias_board", [
    ("default", "default"), ("qa", "qa"), ("default", "qa"), ("qa", "default"),
])
def test_http_alias_completion_cannot_delete_active_victims_files(client, victim_board, alias_board):
    with kb.connect(board=victim_board) as conn:
        victim = kb.create_task(conn, title="active synthetic victim")
        path = _workspace(conn, victim, victim_board)
        sentinel = path / "active.txt"
        sentinel.write_bytes(b"active victim content")
    created = client.post("/kanban/tasks", params={"board": alias_board}, json={
        "title": "synthetic alias", "workspace_kind": "scratch", "workspace_path": str(path),
    })
    assert created.status_code == 200, created.text
    alias = created.json()["task"]["id"]
    completed = client.patch(f"/kanban/tasks/{alias}", params={"board": alias_board}, json={"status": "done"})
    assert completed.status_code == 200, completed.text
    with kb.connect(board=victim_board) as conn:
        assert kb.get_task(conn, victim).status not in {"done", "archived", "failed", "cancelled"}
    assert sentinel.read_bytes() == b"active victim content"


@pytest.mark.parametrize("board", ["default", "qa"])
def test_legacy_alias_direct_cleanup_retains_actual_owner(storage, board):
    with kb.connect(board=board) as conn:
        owner = kb.create_task(conn, title="owner")
        path = _workspace(conn, owner, board)
        sentinel = path / "preserve.txt"
        sentinel.write_bytes(b"owner content")
        alias = kb.create_task(conn, title="legacy alias", workspace_path=str(path))
        assert kb.complete_task(conn, alias, result="alias finished")
        assert sentinel.read_bytes() == b"owner content"


@pytest.mark.parametrize("board", ["default", "qa"])
def test_explicit_legacy_custom_scratch_remains_usable_and_is_retained(storage, board):
    custom = kb.workspaces_root(board=board) / "legacy-custom-folder"
    with kb.connect(board=board) as conn:
        task_id = kb.create_task(conn, title="legacy custom", workspace_path=str(custom))
        assert _workspace(conn, task_id, board) == custom
        sentinel = custom / "preserve.txt"
        sentinel.write_bytes(b"custom content")
        assert kb.complete_task(conn, task_id, result="finished")
        assert sentinel.read_bytes() == b"custom content"


@pytest.mark.parametrize("board", ["default", "qa"])
def test_normal_owned_scratch_cleanup_uses_connection_not_active_board(storage, board):
    kb.set_current_board("qa" if board == "default" else "default")
    with kb.connect(board=board) as conn:
        task_id = kb.create_task(conn, title="actual owner")
        path = _workspace(conn, task_id, board)
        (path / "owned.txt").write_bytes(b"owned content")
        assert kb.complete_task(conn, task_id, result="finished")
        assert not path.exists()


@pytest.mark.parametrize("board", ["default", "qa"])
@pytest.mark.parametrize("parent_finishes_first", [False, True])
def test_parent_child_shared_workspace_lives_until_owner_and_children_finish(storage, board, parent_finishes_first):
    with kb.connect(board=board) as conn:
        parent = kb.create_task(conn, title="parent owner")
        path = _workspace(conn, parent, board)
        sentinel = path / "handoff.txt"
        sentinel.write_bytes(b"shared handoff")
        if parent_finishes_first:
            child = kb.create_task(conn, title="shared child", parents=[parent], workspace_path=str(path))
        else:
            # A dependency may be linked to an already running task. Use the
            # public claim/link APIs, rather than bypassing task-state guards.
            child = kb.create_task(conn, title="shared child", workspace_path=str(path))
            assert kb.claim_task(conn, child, claimer="synthetic-owner") is not None
            kb.link_tasks(conn, parent, child)
        if parent_finishes_first:
            assert kb.complete_task(conn, parent, result="handoff")
            assert sentinel.read_bytes() == b"shared handoff"
            assert kb.complete_task(conn, child, result="child finished")
        else:
            assert kb.complete_task(conn, child, result="child finished")
            assert sentinel.read_bytes() == b"shared handoff"
            assert kb.complete_task(conn, parent, result="parent finished")
        assert not path.exists()


def test_junction_task_leaf_cannot_make_victims_workspace_look_owned(storage):
    with kb.connect(board="default") as conn:
        victim = kb.create_task(conn, title="victim")
        victim_path = _workspace(conn, victim, "default")
        sentinel = victim_path / "active.txt"
        sentinel.write_bytes(b"active victim content")
        alias = kb.create_task(conn, title="linked alias")
        alias_path = kb.workspaces_root(board="default") / alias
        if os.name == "nt":
            result = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(alias_path), str(victim_path)],
                capture_output=True, text=True, timeout=20,
            )
            assert result.returncode == 0, result.stderr
        else:
            alias_path.symlink_to(victim_path, target_is_directory=True)
        try:
            kb.set_workspace_path(conn, alias, alias_path)
            assert kb.complete_task(conn, alias, result="finished")
            assert sentinel.read_bytes() == b"active victim content"
            assert alias_path.exists(), "a task-leaf link is never an owned removable directory"
        finally:
            if alias_path.exists():
                if os.name == "nt":
                    os.rmdir(alias_path)
                else:
                    alias_path.unlink()


def test_custom_database_unknown_ownership_retains_scratch(storage, tmp_path):
    db = tmp_path / "custom.sqlite"
    kb.init_db(db_path=db)
    with kb.connect(db_path=db) as conn:
        task_id = kb.create_task(conn, title="custom database")
        path = kb.workspaces_root(board="default") / task_id
        path.mkdir(parents=True)
        kb.set_workspace_path(conn, task_id, path)
        sentinel = path / "preserve.txt"
        sentinel.write_bytes(b"unknown ownership")
        assert kb.complete_task(conn, task_id, result="finished")
        assert sentinel.read_bytes() == b"unknown ownership"


@pytest.mark.parametrize("paired", [False, True])
def test_worker_override_cleanup_requires_current_database_binding(storage, tmp_path, monkeypatch, paired):
    db = kb.kanban_db_path(board="default")
    root = tmp_path / "worker-scratch"
    monkeypatch.setenv("YOUTAB_AGENT_KANBAN_WORKSPACES_ROOT", str(root))
    if paired:
        monkeypatch.setenv("YOUTAB_AGENT_KANBAN_DB", str(db))
    with kb.connect(db_path=db) as conn:
        task_id = kb.create_task(conn, title="worker synthetic")
        path = _workspace(conn, task_id, "default")
        (path / "owned.txt").write_bytes(b"worker owned")
        assert kb.complete_task(conn, task_id, result="finished")
        assert path.exists() is not paired


def test_worker_override_mismatched_database_retains_scratch(storage, tmp_path, monkeypatch):
    db = kb.kanban_db_path(board="default")
    other_db = kb.kanban_db_path(board="qa")
    monkeypatch.setenv("YOUTAB_AGENT_KANBAN_WORKSPACES_ROOT", str(tmp_path / "worker-scratch"))
    monkeypatch.setenv("YOUTAB_AGENT_KANBAN_DB", str(other_db))
    with kb.connect(db_path=db) as conn:
        task_id = kb.create_task(conn, title="mismatched worker binding")
        path = _workspace(conn, task_id, "default")
        sentinel = path / "owned.txt"
        sentinel.write_bytes(b"retain unbound worker scratch")
        assert kb.complete_task(conn, task_id, result="finished")
        assert sentinel.read_bytes() == b"retain unbound worker scratch"


@pytest.mark.parametrize("board", ["default", "qa"])
def test_deferred_alias_parent_cannot_remove_unrelated_owners_workspace(storage, board):
    with kb.connect(board=board) as conn:
        victim = kb.create_task(conn, title="unrelated owner")
        path = _workspace(conn, victim, board)
        sentinel = path / "active.txt"
        sentinel.write_bytes(b"active unrelated owner")
        parent = kb.create_task(conn, title="alias parent", workspace_path=str(path))
        child = kb.create_task(conn, title="alias child", parents=[parent], workspace_kind="dir")
        assert kb.complete_task(conn, parent, result="parent finished")
        assert sentinel.read_bytes() == b"active unrelated owner"
        assert kb.complete_task(conn, child, result="child finished")
        assert sentinel.read_bytes() == b"active unrelated owner"


def test_selected_linked_home_preserves_canonical_owner_cleanup(storage, tmp_path, monkeypatch):
    linked_home = tmp_path / "selected-home"
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(linked_home), str(storage)],
            capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, result.stderr
    else:
        linked_home.symlink_to(storage, target_is_directory=True)
    try:
        monkeypatch.setenv("YOUTAB_AGENT_HOME", str(linked_home))
        with kb.connect(board="default") as conn:
            task_id = kb.create_task(conn, title="selected linked home")
            path = _workspace(conn, task_id, "default")
            (path / "owned.txt").write_bytes(b"owned linked-home content")
            assert kb.complete_task(conn, task_id, result="finished")
            assert not path.exists()
    finally:
        if os.name == "nt":
            os.rmdir(linked_home)
        else:
            linked_home.unlink()
