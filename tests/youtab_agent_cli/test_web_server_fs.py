import base64
import os
from pathlib import Path

import pytest

from youtab_agent_cli import web_server

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    previous_auth_required = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = False
    test_client = TestClient(web_server.app)
    test_client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    try:
        yield test_client
    finally:
        if previous_auth_required is None:
            try:
                delattr(web_server.app.state, "auth_required")
            except AttributeError:
                pass
        else:
            web_server.app.state.auth_required = previous_auth_required


def test_fs_list_sorts_and_hides_noise(client, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "b.txt").write_text("b", encoding="utf-8")
    (root / "a_dir").mkdir()
    (root / "a.txt").write_text("a", encoding="utf-8")
    (root / "node_modules").mkdir()
    (root / ".git").mkdir()

    response = client.get("/api/fs/list", params={"path": str(root)})

    assert response.status_code == 200
    entries = response.json()["entries"]
    assert [entry["name"] for entry in entries] == ["a_dir", "a.txt", "b.txt"]
    assert entries[0] == {"name": "a_dir", "path": str(root / "a_dir"), "isDirectory": True}
    assert all(entry["name"] not in {".git", "node_modules"} for entry in entries)


def test_fs_read_data_url_rejects_over_cap(client, tmp_path, monkeypatch):
    monkeypatch.setattr(web_server, "_FS_DATA_URL_MAX_BYTES", 3)
    target = tmp_path / "image.png"
    target.write_bytes(b"1234")

    response = client.get("/api/fs/read-data-url", params={"path": str(target)})

    assert response.status_code == 413


def test_fs_endpoints_require_auth(tmp_path):
    client = TestClient(web_server.app)
    target = tmp_path / "secret.txt"
    target.write_text("secret", encoding="utf-8")

    list_response = client.get("/api/fs/list", params={"path": str(tmp_path)})
    read_response = client.get("/api/fs/read-text", params={"path": str(target)})
    default_response = client.get("/api/fs/default-cwd")

    assert list_response.status_code == 401
    assert read_response.status_code == 401
    assert default_response.status_code == 401


def test_normal_user_generic_write_preserves_runtime_and_allows_project(client, tmp_path, monkeypatch):
    import youtab_constants
    from youtab_agent_cli.authz import Principal, Role, ROLE_SCOPES

    if os.name != "nt" and not Path("/proc/self/fd").is_dir():
        pytest.skip("Current POSIX staging adapter requires /proc/self/fd directory binding")

    runtime = tmp_path / "runtime"
    runtime.mkdir()
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(runtime))
    monkeypatch.setattr(youtab_constants, "_committed_relocation_override", lambda _home: None)
    monkeypatch.setattr(youtab_constants, "_get_platform_default_youtab_home", lambda: tmp_path / "default-runtime")
    principal = Principal(user_id="synthetic-user", org_id="synthetic-org", role=Role.NORMAL_USER,
                          scopes=ROLE_SCOPES[Role.NORMAL_USER])
    assert principal.has("fs:write") and not principal.has("credential:write")
    monkeypatch.setattr(web_server, "_principal_for_request", lambda _request: principal)
    credential = runtime / "config.yaml"
    runtime_canary = b"# synthetic-runtime-canary\n{}\n"
    credential.write_bytes(runtime_canary)
    denied = client.post("/api/fs/write-text", json={"path": str(credential), "content": "tamper"})
    assert denied.status_code == 403, denied.text
    assert credential.read_bytes() == runtime_canary
    project = tmp_path / "project"
    project.mkdir()
    config = project / "config.yaml"
    config.write_bytes(b"# synthetic-project-config\n{}\n")
    project_config_denied = client.post("/api/fs/write-text", json={"path": str(config), "content": "tamper"})
    assert project_config_denied.status_code == 403, project_config_denied.text
    assert config.read_bytes() == b"# synthetic-project-config\n{}\n"
    report = project / "report.md"
    allowed = client.post("/api/fs/write-text", json={"path": str(report), "content": "project-only"})
    assert allowed.status_code == 200, allowed.text
    assert report.read_text(encoding="utf-8") == "project-only"
