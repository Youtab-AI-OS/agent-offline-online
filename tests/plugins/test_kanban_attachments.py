"""Tests for Kanban task file attachments (#35338).

Covers three layers:
  * ``youtab_agent_cli.kanban_db`` accessors (add/list/get/delete + path helpers)
  * the dashboard REST surface (upload / list / download / delete)
  * worker-context surfacing so a kanban worker sees the absolute paths

The plugin router is attached to a bare FastAPI app — same approach as
``test_kanban_dashboard_plugin.py`` — so we exercise the real HTTP path
(multipart upload, streaming download) without the whole dashboard.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from youtab_agent_cli import kanban_db as kb


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _load_plugin_router():
    repo_root = Path(__file__).resolve().parents[2]
    plugin_file = repo_root / "plugins" / "kanban" / "dashboard" / "plugin_api.py"
    assert plugin_file.exists(), f"plugin file missing: {plugin_file}"
    spec = importlib.util.spec_from_file_location(
        "youtab_dashboard_plugin_kanban_attach_test", plugin_file,
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod.router


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".youtab-agent-runtime"
    home.mkdir()
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture
def client(kanban_home):
    app = FastAPI()
    app.include_router(_load_plugin_router(), prefix="/api/plugins/kanban")
    return TestClient(app)


def _make_task(conn, title="t") -> str:
    return kb.create_task(conn, title=title)


# ---------------------------------------------------------------------------
# DB-layer accessors
# ---------------------------------------------------------------------------


def test_add_list_get_delete_attachment(kanban_home, tmp_path):
    conn = kb.connect()
    try:
        task_id = _make_task(conn)
        # Write a real blob under the per-task dir so delete can unlink it.
        dest_dir = kb.task_attachments_dir(task_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        blob = dest_dir / "source.pdf"
        blob.write_bytes(b"%PDF-1.4 fake")

        att_id = kb.add_attachment(
            conn,
            task_id,
            filename="source.pdf",
            stored_path=str(blob),
            content_type="application/pdf",
            size=blob.stat().st_size,
            uploaded_by="tester",
        )
        assert att_id > 0

        atts = kb.list_attachments(conn, task_id)
        assert len(atts) == 1
        a = atts[0]
        assert a.filename == "source.pdf"
        assert a.content_type == "application/pdf"
        assert a.size == len(b"%PDF-1.4 fake")
        assert a.uploaded_by == "tester"
        assert a.stored_path == str(blob)

        got = kb.get_attachment(conn, att_id)
        assert got is not None and got.id == att_id

        removed = kb.delete_attachment(conn, att_id)
        assert removed is not None and removed.id == att_id
        assert kb.list_attachments(conn, task_id) == []
        assert not blob.exists(), "delete should unlink the on-disk blob"
        assert kb.get_attachment(conn, att_id) is None
    finally:
        conn.close()


def test_delete_attachment_missing_returns_none(kanban_home):
    conn = kb.connect()
    try:
        assert kb.delete_attachment(conn, 999999) is None
    finally:
        conn.close()


def test_attachments_root_is_per_board(kanban_home, monkeypatch):
    # default board uses <root>/kanban/attachments
    default_root = kb.attachments_root(board="default")
    assert default_root.name == "attachments"
    # a named board nests under its board dir
    monkeypatch.delenv("YOUTAB_AGENT_KANBAN_ATTACHMENTS_ROOT", raising=False)
    named = kb.attachments_root(board="default")
    assert named == default_root


# ---------------------------------------------------------------------------
# Worker context surfacing
# ---------------------------------------------------------------------------


def test_worker_context_lists_attachments_with_absolute_path(kanban_home):
    conn = kb.connect()
    try:
        task_id = _make_task(conn, title="translate PDF")
        dest_dir = kb.task_attachments_dir(task_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        blob = dest_dir / "manual.pdf"
        blob.write_bytes(b"data")
        kb.add_attachment(
            conn,
            task_id,
            filename="manual.pdf",
            stored_path=str(blob.resolve()),
            content_type="application/pdf",
            size=4,
        )
        ctx = kb.build_worker_context(conn, task_id)
        assert "## Attachments" in ctx
        assert "manual.pdf" in ctx
        # The absolute path must appear so the worker can read_file it.
        assert str(blob.resolve()) in ctx
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# REST surface — upload / list / download / delete round-trip
# ---------------------------------------------------------------------------


def _create_task_via_api(client) -> str:
    r = client.post("/api/plugins/kanban/tasks", json={"title": "x"})
    assert r.status_code == 200, r.text
    return r.json()["task"]["id"]


def test_upload_list_download_delete_roundtrip(client):
    task_id = _create_task_via_api(client)
    content = b"hello attachment world"

    # Upload
    r = client.post(
        f"/api/plugins/kanban/tasks/{task_id}/attachments",
        files={"file": ("notes.txt", content, "text/plain")},
    )
    assert r.status_code == 200, r.text
    att = r.json()["attachment"]
    assert att["filename"] == "notes.txt"
    assert att["size"] == len(content)
    att_id = att["id"]

    # List (drawer also embeds it in GET /tasks/:id)
    r = client.get(f"/api/plugins/kanban/tasks/{task_id}/attachments")
    assert r.status_code == 200
    assert [a["filename"] for a in r.json()["attachments"]] == ["notes.txt"]

    detail = client.get(f"/api/plugins/kanban/tasks/{task_id}").json()
    assert "attachments" in detail
    assert len(detail["attachments"]) == 1

    # Download streams the exact bytes back
    r = client.get(f"/api/plugins/kanban/attachments/{att_id}")
    assert r.status_code == 200
    assert r.content == content
    ranged = client.get(
        f"/api/plugins/kanban/attachments/{att_id}",
        headers={"Range": "bytes=6-15"},
    )
    assert ranged.status_code == 206
    assert ranged.content == content[6:16]

    # Delete removes the row and the file
    r = client.delete(f"/api/plugins/kanban/attachments/{att_id}")
    assert r.status_code == 200
    assert client.get(f"/api/plugins/kanban/attachments/{att_id}").status_code == 404
    assert client.get(
        f"/api/plugins/kanban/tasks/{task_id}/attachments"
    ).json()["attachments"] == []


def test_upload_sanitizes_traversal_filename(client):
    task_id = _create_task_via_api(client)
    r = client.post(
        f"/api/plugins/kanban/tasks/{task_id}/attachments",
        files={"file": ("../../../../etc/passwd", b"x", "text/plain")},
    )
    assert r.status_code == 200, r.text
    stored_path = r.json()["attachment"]["stored_path"]
    # The leaf name only; never escapes the per-task attachments dir.
    assert Path(stored_path).name == "passwd"
    task_dir = kb.task_attachments_dir(task_id).resolve()
    assert Path(stored_path).resolve().is_relative_to(task_dir)


def test_upload_removes_its_blob_if_metadata_insert_fails(client, monkeypatch):
    task_id = _create_task_via_api(client)

    def fail_insert(*_args, **_kwargs):
        raise RuntimeError("database insert failed")

    monkeypatch.setattr(kb, "add_attachment", fail_insert)
    with pytest.raises(RuntimeError, match="database insert failed"):
        client.post(
            f"/api/plugins/kanban/tasks/{task_id}/attachments",
            files={"file": ("orphan.txt", b"private upload", "text/plain")},
        )
    assert list(kb.task_attachments_dir(task_id).iterdir()) == []


def test_upload_insert_failure_never_deletes_substituted_blob(client, monkeypatch):
    task_id = _create_task_via_api(client)
    blob = kb.task_attachments_dir(task_id) / "upload.txt"
    moved = blob.with_name("original-moved.txt")
    replacement = b"unrelated replacement"
    swapped = False

    def fail_after_swap(*_args, **_kwargs):
        nonlocal swapped
        try:
            blob.rename(moved)
            blob.write_bytes(replacement)
            swapped = True
        except OSError:
            # A retained Windows handle denies rename during insertion.
            assert blob.exists()
            assert not moved.exists()
        raise RuntimeError("database insert failed")

    monkeypatch.setattr(kb, "add_attachment", fail_after_swap)
    with pytest.raises(RuntimeError, match="database insert failed"):
        client.post(
            f"/api/plugins/kanban/tasks/{task_id}/attachments",
            files={"file": ("upload.txt", b"original upload", "text/plain")},
        )
    if swapped:
        assert blob.read_bytes() == replacement
        assert moved.read_bytes() == b"original upload"
    else:
        assert not blob.exists()


@pytest.mark.parametrize(
    "task_id",
    ["../outside", "..\\outside", "C:outside", "/tmp/outside", "a/b", "a\\b", ".", ""],
)
def test_task_id_cannot_escape_attachment_or_worker_log_roots(
    kanban_home, task_id,
):
    with pytest.raises(ValueError, match="invalid task id"):
        kb.task_attachments_dir(task_id)
    with pytest.raises(ValueError, match="invalid task id"):
        kb.worker_log_path(task_id)


@pytest.mark.parametrize("task_id", ["../outside", "..\\outside"])
def test_traversal_task_id_cannot_write_attachment_or_read_worker_log(
    kanban_home, task_id,
):
    escaped_attachment_dir = kanban_home / "kanban" / "outside"
    escaped_attachment_dir.mkdir(parents=True)
    outside_log = kanban_home / "kanban" / "outside.log"
    outside_log.write_bytes(b"leave intact")
    with pytest.raises(ValueError, match="invalid task id"):
        kb.read_worker_log(task_id)
    conn = kb.connect()
    try:
        with pytest.raises(ValueError, match="invalid task id"):
            kb.store_attachment_bytes(conn, task_id, "payload.txt", b"overwrite")
    finally:
        conn.close()
    assert not (escaped_attachment_dir / "payload.txt").exists()
    assert outside_log.read_bytes() == b"leave intact"


def test_dashboard_rejects_malformed_existing_task_id_before_file_access(client):
    original_id = _create_task_via_api(client)
    malformed_id = "t_bad\\outside"
    conn = kb.connect()
    try:
        conn.execute("UPDATE tasks SET id = ? WHERE id = ?", (malformed_id, original_id))
        conn.commit()
    finally:
        conn.close()

    route_id = "t_bad%5Coutside"
    uploaded = client.post(
        f"/api/plugins/kanban/tasks/{route_id}/attachments",
        files={"file": ("payload.txt", b"untrusted", "text/plain")},
    )
    assert uploaded.status_code == 400, uploaded.text
    log = client.get(f"/api/plugins/kanban/tasks/{route_id}/log")
    assert log.status_code == 400, log.text
    assert not (kb.attachments_root() / malformed_id).exists()


def test_task_attachment_directory_rejects_symlink_redirect(kanban_home):
    root = kb.attachments_root()
    root.mkdir(parents=True, exist_ok=True)
    outside = kanban_home / "outside"
    outside.mkdir()
    try:
        (root / "t_deadbeef").symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")
    with pytest.raises(ValueError, match="invalid task attachment directory"):
        kb.task_attachments_dir("t_deadbeef")


def test_store_rejects_directory_swap_after_collision_check(kanban_home, monkeypatch):
    """A native junction/symlink inserted at the check-to-open gap cannot receive bytes."""
    conn = kb.connect()
    task_id = _make_task(conn)
    task_dir = kb.task_attachments_dir(task_id)
    outside = kanban_home / "outside-swap"
    outside.mkdir()
    original = kb._collision_free_path

    def swap_after_check(directory, filename):
        candidate = original(directory, filename)
        directory.rename(directory.with_name(directory.name + "-moved"))
        if os.name == "nt":
            result = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(directory), str(outside)],
                capture_output=True, text=True, check=False,
            )
            assert result.returncode == 0, result.stderr
        else:
            directory.symlink_to(outside, target_is_directory=True)
        return candidate

    monkeypatch.setattr(kb, "_collision_free_path", swap_after_check)
    try:
        with pytest.raises((ValueError, PermissionError, OSError)):
            kb.store_attachment_bytes(conn, task_id, "payload.txt", b"secret")
        assert not (outside / "payload.txt").exists()
        assert kb.list_attachments(conn, task_id) == []
    finally:
        conn.close()


def test_worker_log_path_rejects_symlink_redirect(kanban_home):
    root = kb.worker_logs_dir()
    root.mkdir(parents=True, exist_ok=True)
    outside = kanban_home / "outside.log"
    outside.write_bytes(b"private")
    try:
        (root / "t_deadbeef.log").symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")
    with pytest.raises(ValueError, match="invalid task worker log path"):
        kb.worker_log_path("t_deadbeef")
    assert outside.read_bytes() == b"private"


@pytest.mark.parametrize("filename", ["F:config.yaml", "notes.txt:secret", "C:"])
def test_upload_rejects_drive_relative_and_stream_names(client, monkeypatch, filename):
    task_id = _create_task_via_api(client)
    # If the regression returns, fail before any write outside this fixture.
    module = sys.modules["youtab_dashboard_plugin_kanban_attach_test"]
    original = module._collision_free_path
    root = kb.task_attachments_dir(task_id).resolve()

    def guarded_destination(*args):
        candidate = original(*args)
        assert candidate.resolve().is_relative_to(root), "upload escaped fixture"
        return candidate

    monkeypatch.setattr(module, "_collision_free_path", guarded_destination)
    response = client.post(
        f"/api/plugins/kanban/tasks/{task_id}/attachments",
        files={"file": (filename, b"untrusted upload", "text/plain")},
    )
    assert response.status_code == 400
    assert client.get(
        f"/api/plugins/kanban/tasks/{task_id}/attachments"
    ).json()["attachments"] == []


@pytest.mark.parametrize("filename", ["F:config.yaml", "notes.txt:secret", "../outside"])
def test_collision_builder_rejects_unsafe_direct_call(tmp_path, filename):
    with pytest.raises(ValueError):
        kb._collision_free_path(tmp_path, filename)


def test_collision_builder_rejects_outside_symlink(tmp_path):
    root = tmp_path / "attachments"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"original")
    try:
        (root / "notes.txt").symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")
    with pytest.raises(ValueError):
        kb._collision_free_path(root, "notes.txt")
    assert outside.read_bytes() == b"original"


def test_download_unknown_attachment_404(client):
    assert client.get("/api/plugins/kanban/attachments/424242").status_code == 404


def test_download_and_delete_refuse_redirected_blob(client, kanban_home):
    task_id = _create_task_via_api(client)
    task_dir = kb.task_attachments_dir(task_id)
    task_dir.mkdir(parents=True, exist_ok=True)
    outside = kanban_home / "private.txt"
    outside.write_bytes(b"do not serve or delete")
    blob = task_dir / "linked.txt"
    try:
        blob.symlink_to(outside)
    except OSError:
        # Windows without SeCreateSymbolicLinkPrivilege can still exercise
        # the single-link admission check using a same-volume hard link.
        os.link(outside, blob)
    conn = kb.connect()
    try:
        att_id = kb.add_attachment(
            conn, task_id, filename="linked.txt", stored_path=str(blob), size=outside.stat().st_size,
        )
    finally:
        conn.close()
    assert client.get(f"/api/plugins/kanban/attachments/{att_id}").status_code == 404
    assert client.delete(f"/api/plugins/kanban/attachments/{att_id}").status_code == 200
    assert outside.read_bytes() == b"do not serve or delete"


# ---------------------------------------------------------------------------
# Shared helper — store_attachment_bytes (used by dashboard + tool + CLI)
# ---------------------------------------------------------------------------


def test_store_attachment_bytes_roundtrip(kanban_home):
    conn = kb.connect()
    try:
        task_id = _make_task(conn)
        att_id = kb.store_attachment_bytes(
            conn, task_id, "doc.txt", b"some bytes",
            content_type="text/plain", uploaded_by="tester",
        )
        a = kb.get_attachment(conn, att_id)
        assert a is not None
        assert a.filename == "doc.txt"
        assert a.size == len(b"some bytes")
        assert a.uploaded_by == "tester"
        assert Path(a.stored_path).read_bytes() == b"some bytes"
        assert Path(a.stored_path).resolve().is_relative_to(
            kb.task_attachments_dir(task_id).resolve()
        )
    finally:
        conn.close()


def test_shared_store_insert_failure_never_deletes_substituted_blob(kanban_home, monkeypatch):
    conn = kb.connect()
    task_id = _make_task(conn)
    blob = kb.task_attachments_dir(task_id) / "upload.txt"
    moved = blob.with_name("original-moved.txt")
    replacement = b"unrelated replacement"
    swapped = False

    def fail_after_swap(*_args, **_kwargs):
        nonlocal swapped
        try:
            blob.rename(moved)
            blob.write_bytes(replacement)
            swapped = True
        except OSError:
            assert blob.exists()
            assert not moved.exists()
        raise RuntimeError("database insert failed")

    monkeypatch.setattr(kb, "add_attachment", fail_after_swap)
    try:
        with pytest.raises(RuntimeError, match="database insert failed"):
            kb.store_attachment_bytes(conn, task_id, "upload.txt", b"original upload")
        if swapped:
            assert blob.read_bytes() == replacement
            assert moved.read_bytes() == b"original upload"
        else:
            assert not blob.exists()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# CLI — youtab kanban attach / attachments / attach-rm
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path_form", ["unquoted", "double_quoted", "single_quoted", "posix_escaped"])
def test_cli_attach_attachments_and_rm(kanban_home, tmp_path, monkeypatch, path_form):
    from youtab_agent_cli.kanban import run_slash

    conn = kb.connect()
    try:
        task_id = _make_task(conn, title="cli-attach")
    finally:
        conn.close()

    directory = tmp_path / ("input folder" if path_form != "unquoted" else "input")
    directory.mkdir()
    src = directory / "upload.txt"
    src.write_bytes(b"cli file body")

    if path_form == "posix_escaped":
        # A relative slash path keeps this POSIX escape case meaningful on
        # Windows as well as Unix, without replacing the native-path cases.
        monkeypatch.chdir(tmp_path)
        argument = "input\\ folder/upload.txt"
    elif path_form == "double_quoted":
        argument = f'"{src}"'
    elif path_form == "single_quoted":
        argument = f"'{src}'"
    else:
        argument = str(src)
    out = run_slash(f"attach {task_id} {argument}")
    assert "Attached" in out, out

    conn = kb.connect()
    try:
        atts = kb.list_attachments(conn, task_id)
        assert len(atts) == 1
        att_id = atts[0].id
        assert atts[0].filename == "upload.txt"
        assert Path(atts[0].stored_path).read_bytes() == b"cli file body"
    finally:
        conn.close()

    listed = run_slash(f"attachments {task_id}")
    assert "upload.txt" in listed

    removed = run_slash(f"attach-rm {att_id}")
    assert "Deleted attachment" in removed
    conn = kb.connect()
    try:
        assert kb.list_attachments(conn, task_id) == []
    finally:
        conn.close()


