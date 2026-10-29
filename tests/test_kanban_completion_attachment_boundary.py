"""Real HTTP/SQLite attachment effects stay inside disposable task storage."""

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
    monkeypatch.delenv("YOUTAB_AGENT_KANBAN_DB", raising=False)
    monkeypatch.delenv("YOUTAB_AGENT_KANBAN_ATTACHMENTS_ROOT", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db(board="default")
    kb.init_db(board="qa")
    return home


@pytest.fixture
def client(storage):
    source = Path(__file__).resolve().parents[1] / "plugins/kanban/dashboard/plugin_api.py"
    spec = importlib.util.spec_from_file_location("kanban_completion_boundary_router", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/kanban")
    return TestClient(app)


@pytest.mark.parametrize("board", ["default", "qa"])
def test_http_completion_cannot_register_reserved_metadata_paths(client, tmp_path, board):
    sentinel = tmp_path / "private-sentinel.txt"
    sentinel.write_bytes(b"synthetic file outside attachment storage")
    workspace = tmp_path / "persistent-workspace"
    workspace.mkdir()
    metadata = {"_staged_artifacts": [str(sentinel)], "fact": "retained"}
    with kb.connect(board=board) as conn:
        task_id = kb.create_task(
            conn, title="synthetic", workspace_kind="dir", workspace_path=str(workspace),
        )
    response = client.patch(f"/kanban/tasks/{task_id}", params={"board": board}, json={
        "status": "done", "metadata": metadata,
    })
    assert response.status_code == 200, response.text
    with kb.connect(board=board) as conn:
        assert kb.list_attachments(conn, task_id) == []
        run = kb.latest_run(conn, task_id)
        assert run.metadata == {"fact": "retained"}
    assert sentinel.read_bytes() == b"synthetic file outside attachment storage"
    assert workspace.is_dir()


@pytest.mark.parametrize("board", ["default", "qa"])
def test_http_delete_preserves_outside_file_even_with_tampered_row(client, tmp_path, board):
    sentinel = tmp_path / "outside.txt"
    sentinel.write_bytes(b"preserve outside bytes")
    with kb.connect(board=board) as conn:
        task_id = kb.create_task(conn, title="synthetic")
        attachment_id = kb.add_attachment(conn, task_id, filename=sentinel.name, stored_path=str(sentinel))
    response = client.delete(f"/kanban/attachments/{attachment_id}", params={"board": board})
    assert response.status_code == 200, response.text
    with kb.connect(board=board) as conn:
        assert kb.get_attachment(conn, attachment_id) is None
    assert sentinel.read_bytes() == b"preserve outside bytes"


def test_delete_cannot_unlink_another_tasks_managed_blob(storage):
    with kb.connect(board="default") as conn:
        owner = kb.create_task(conn, title="actual owner")
        other = kb.create_task(conn, title="other task")
        directory = kb.task_attachments_dir(owner, board="default")
        directory.mkdir(parents=True)
        blob = directory / "owned.txt"
        blob.write_bytes(b"actual owner bytes")
        attachment_id = kb.add_attachment(conn, other, filename=blob.name, stored_path=str(blob))
        assert kb.delete_attachment(conn, attachment_id) is not None
        assert blob.read_bytes() == b"actual owner bytes"


def test_delete_cannot_follow_a_task_directory_link(storage, tmp_path):
    outside = tmp_path / "outside-directory"
    outside.mkdir()
    sentinel = outside / "private.txt"
    sentinel.write_bytes(b"linked target preserved")
    with kb.connect(board="default") as conn:
        task_id = kb.create_task(conn, title="synthetic")
        directory = kb.task_attachments_dir(task_id, board="default")
        directory.parent.mkdir(parents=True)
        if os.name == "nt":
            result = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(directory), str(outside)],
                capture_output=True, text=True, check=False,
            )
            assert result.returncode == 0, result.stdout + result.stderr
        else:
            directory.symlink_to(outside, target_is_directory=True)
        try:
            attachment_id = kb.add_attachment(
                conn, task_id, filename=sentinel.name, stored_path=str(directory / sentinel.name),
            )
            assert kb.delete_attachment(conn, attachment_id) is not None
            assert sentinel.read_bytes() == b"linked target preserved"
        finally:
            if os.name == "nt":
                os.rmdir(directory)  # Remove only the owned junction, never its target.
            else:
                directory.unlink()


@pytest.mark.parametrize("board", ["default", "qa"])
def test_normal_http_upload_download_delete_removes_only_that_blob(client, board):
    kb.set_current_board("qa" if board == "default" else "default")
    with kb.connect(board=board) as conn:
        task_id = kb.create_task(conn, title="synthetic")
    response = client.post(f"/kanban/tasks/{task_id}/attachments", params={"board": board},
                           files={"file": ("report.md", b"synthetic report bytes", "text/markdown")})
    assert response.status_code == 200, response.text
    attachment = response.json()["attachment"]
    path = Path(attachment["stored_path"])
    assert path.read_bytes() == b"synthetic report bytes"
    downloaded = client.get(f'/kanban/attachments/{attachment["id"]}', params={"board": board})
    assert downloaded.status_code == 200
    assert downloaded.content == b"synthetic report bytes"
    deleted = client.delete(f'/kanban/attachments/{attachment["id"]}', params={"board": board})
    assert deleted.status_code == 200, deleted.text
    assert not path.exists()


@pytest.mark.parametrize("board", ["default", "qa"])
def test_real_scratch_copy_ignores_forged_staging_but_retains_artifacts(storage, tmp_path, board):
    sentinel = tmp_path / "outside.txt"
    sentinel.write_bytes(b"outside retained")
    with kb.connect(board=board) as conn:
        task_id = kb.create_task(conn, title="synthetic scratch")
        workspace = kb.resolve_workspace(kb.get_task(conn, task_id), board=board)
        kb.set_workspace_path(conn, task_id, workspace)
        artifact = workspace / "report.txt"
        artifact.write_bytes(b"preserved scratch bytes")
        metadata = {"artifacts": [str(artifact)], "_staged_artifacts": [str(sentinel)]}
        assert kb.complete_task(conn, task_id, metadata=metadata)
        attachments = kb.list_attachments(conn, task_id)
        assert len(attachments) == 1
        stored = Path(attachments[0].stored_path)
        assert stored.parent == kb.task_attachments_dir(task_id, board=board).resolve()
        assert stored.read_bytes() == b"preserved scratch bytes"
        assert "_staged_artifacts" not in kb.latest_run(conn, task_id).metadata
    assert not workspace.exists()
    assert sentinel.read_bytes() == b"outside retained"
