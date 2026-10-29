from __future__ import annotations
import hashlib
from pathlib import Path

import tui_gateway.server as server
from tools import project_task_backup as backup
from youtab_agent_cli import projects_db as pdb


def test_actual_projects_backup_rpc_recovery_keeps_chat_bytes(tmp_path, monkeypatch):
    home = tmp_path / "profile"
    home.mkdir()
    work = tmp_path / "project"
    work.mkdir()
    (work / "a.txt").write_text("before")
    chat = home / "state.db"
    chat.write_bytes(b"synthetic unchanged chat sentinel")
    original = hashlib.sha256(chat.read_bytes()).hexdigest()
    monkeypatch.setattr(backup, "get_youtab_home", lambda: home)
    monkeypatch.setattr(pdb, "projects_db_path", lambda: home / "projects.db")
    monkeypatch.setattr(server, "_sessions", {})
    def call(method, **params):
        result = server._methods[method](1, params)
        assert "error" not in result, result
        return result["result"]
    project = call("projects.create", name="Synthetic", folders=[str(work)], primary_path=str(work))["project"]
    receipt = backup.snapshot([{"path": str(work)}], "test-turn", home=home)
    (work / "a.txt").write_text("after")
    assert call("projects.backups.list", id=project["id"])["backups"][0]["id"] == receipt["id"]
    assert call("projects.backups.files", id=project["id"], snapshot_id=receipt["id"])["files"][0]["path"] == "a.txt"
    preview = call("projects.backups.preview", id=project["id"], snapshot_id=receipt["id"], files=["a.txt"])
    assert preview["files"][0]["changed"]
    restored = call("projects.backups.restore", id=project["id"], snapshot_id=receipt["id"], preview_token=preview["token"], confirmed=True)
    assert restored["status"] == "RESTORED" and restored["chats_changed"] is False
    assert (work / "a.txt").read_text() == "before"
    assert hashlib.sha256(chat.read_bytes()).hexdigest() == original


def test_working_copy_contract_persists_in_existing_meta_without_schema_migration(tmp_path, monkeypatch):
    home = tmp_path / "profile"
    home.mkdir()
    source = tmp_path / "source"
    work = source / "Youtab" / "Demo"
    work.mkdir(parents=True)
    monkeypatch.setattr(pdb, "projects_db_path", lambda: home / "projects.db")
    with pdb.connect_closing() as conn:
        before = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        identifier = pdb.create_project(conn, name="Demo", folders=[str(work)], primary_path=str(work), working_copy={"source_path": str(source), "working_path": str(work)})
        after = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        assert before == after
        assert pdb.get_project(conn, identifier).to_dict()["working_copy"]["backup_required"] is True
        assert pdb.working_copy_policy_for_cwd(conn, str(work))["source_path"] == str(source)
