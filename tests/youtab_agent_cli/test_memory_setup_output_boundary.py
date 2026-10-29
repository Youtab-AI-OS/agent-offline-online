"""Synthetic credential canaries at the actual setup-result HTTP boundary."""

import subprocess
import sys

import pytest
from starlette.testclient import TestClient

from youtab_agent_cli import web_server


CANARY = "opaque-memory-canary-4827b05c971e063f"


@pytest.fixture(autouse=True)
def _canary_environment(monkeypatch):
    monkeypatch.setenv("MEM0_API_KEY", CANARY)
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", False)


def _assert_no_canary(value):
    assert CANARY not in str(value)
    assert "4827b05c" not in str(value)


def test_real_child_output_is_protected_without_changing_status():
    completed = web_server._run_setup_command(
        [sys.executable, "-c",
         "import os,sys; print('install diagnostic'); print(os.environ['MEM0_API_KEY']); "
         "print('stderr '+os.environ['MEM0_API_KEY'], file=sys.stderr); sys.exit(3)"],
        display="synthetic child",
        timeout=10,
    )
    assert completed.returncode == 3
    assert CANARY in completed.stdout and CANARY in completed.stderr
    result = web_server._command_result(
        kind="external", name="synthetic", status="failed", completed=completed,
        command="check " + CANARY,
    )
    _assert_no_canary(result)
    assert result["returncode"] == 3
    assert result["status"] == "failed"
    assert "install diagnostic" in result["stdout"]
    assert "stderr" in result["stderr"]


@pytest.mark.parametrize("text", [
    "MEM0_API_KEY=" + CANARY,
    '{"api_key":"' + CANARY + '"}',
    "https://example.test/install?access_token=" + CANARY,
    "https://user:" + CANARY + "@example.test/install",
    "a" * 3968 + " " + CANARY,
])
def test_redaction_precedes_output_truncation_even_when_user_opted_out(text):
    result = web_server._command_result(
        kind="pip", name="synthetic", status="failed", error=text,
    )
    _assert_no_canary(result)
    assert result["returncode"] is None
    assert result["status"] == "failed"


def test_authenticated_setup_http_returns_safe_diagnostics(monkeypatch):
    monkeypatch.setattr(web_server, "_load_memory_provider", lambda _name: None)
    monkeypatch.setattr(web_server, "_memory_provider_manifest", lambda _name: {"name": "synthetic"})

    def installer(name):
        completed = subprocess.CompletedProcess(
            args=["synthetic"], returncode=1, stdout="ok " + CANARY,
            stderr="API_KEY=" + CANARY,
        )
        return {"name": name, "results": [web_server._command_result(
            kind="external", name=name, status="failed", completed=completed,
        )]}

    monkeypatch.setattr(web_server, "_install_memory_provider_setup", installer)
    with TestClient(web_server.app) as client:
        client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
        response = client.post("/api/memory/providers/synthetic/setup", json={"values": {}})
    assert response.status_code == 200
    _assert_no_canary(response.text)
    row = response.json()["results"][0]
    assert row["status"] == "failed" and row["returncode"] == 1
    assert "ok" in row["stdout"]


def test_nonsecret_diagnostics_remain_unchanged():
    completed = subprocess.CompletedProcess(
        args=["synthetic"], returncode=0, stdout="installed package 1.2\n", stderr="",
    )
    result = web_server._command_result(
        kind="pip", name="package", status="installed", command="check package",
        completed=completed,
    )
    assert result["stdout"] == "installed package 1.2\n"
    assert result["stderr"] == ""
    assert result["command"] == "check package"
    assert result["returncode"] == 0
