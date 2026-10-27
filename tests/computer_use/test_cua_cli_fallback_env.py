"""Regression test: the cua-driver CLI-fallback transport must sanitize the
subprocess environment like every other cua-driver spawn site.

``_CuaDriverSession._call_tool_via_cli()`` (the EAGAIN/silent-empty MCP
fallback) invoked ``subprocess.run`` with no ``env=`` at all, so the
third-party ``cua-driver`` binary inherited the full, unsanitized parent
environment — including provider API keys and other Youtab-managed
secrets that ``_lifecycle_coro``'s primary MCP spawn already strips via
``_sanitize_subprocess_env(cua_driver_child_env())``.
"""

import json
from unittest.mock import MagicMock

from tools.computer_use.cua_backend import _CuaDriverSession


def _make_session() -> _CuaDriverSession:
    # _call_tool_via_cli() doesn't touch any instance state (bridge/session/
    # capabilities); bypass __init__ so the test doesn't need a real
    # _AsyncBridge.
    return object.__new__(_CuaDriverSession)


def _fake_completed_process(stdout: str) -> MagicMock:
    proc = MagicMock()
    proc.stdout = stdout
    proc.stderr = ""
    proc.returncode = 0
    return proc


def test_cli_fallback_strips_provider_secret_from_subprocess_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "«redacted:sk-…»")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setattr(
        "tools.computer_use.cua_backend.resolve_cua_driver_cmd",
        lambda: "/resolved/cua-driver",
    )

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["env"] = kwargs.get("env")
        return _fake_completed_process(json.dumps({"tree_markdown": "root"}))

    monkeypatch.setattr("subprocess.run", fake_run)

    session = _make_session()
    result = session._call_tool_via_cli("list_windows", {}, timeout=5.0)

    assert result["isError"] is False
    assert captured["env"] is not None, "subprocess.run must receive an explicit env="
    assert "ANTHROPIC_API_KEY" not in captured["env"]
    # Sanitization filters secrets, not everything — an ordinary var survives.
    assert captured["env"].get("PATH") == "/usr/bin:/bin"




def test_packaged_driver_is_preferred_to_host_path(tmp_path, monkeypatch):
    from tools.computer_use import cua_backend

    runtime = tmp_path / "Youtab" / "youtab-agent-runtime"
    module_path = runtime / "tools" / "computer_use" / "cua_backend.py"
    managed = runtime.parent / "bin" / "cua-driver" / "cua-driver.exe"
    monkeypatch.setattr(cua_backend, "__file__", str(module_path))
    monkeypatch.setattr(cua_backend.sys, "platform", "win32")
    monkeypatch.delenv("YOUTAB_AGENT_CUA_DRIVER_CMD", raising=False)
    monkeypatch.setattr(cua_backend.shutil, "which",
                        lambda name: str(managed) if name == str(managed) else "host-driver")

    assert cua_backend.resolve_cua_driver_cmd() == str(managed)


def test_packaged_driver_does_not_override_explicit_selection(monkeypatch):
    from tools.computer_use import cua_backend

    monkeypatch.setenv("YOUTAB_AGENT_CUA_DRIVER_CMD", "selected-driver")
    monkeypatch.setattr(cua_backend.shutil, "which", lambda name: None)
    assert cua_backend.resolve_cua_driver_cmd() is None