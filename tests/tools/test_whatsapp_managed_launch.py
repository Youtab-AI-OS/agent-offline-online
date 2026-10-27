"""All managed launchers retain the same private parent through child exit."""
import os
from pathlib import Path
import subprocess
from unittest.mock import MagicMock

import pytest

from plugins.platforms.whatsapp import bridge_launch


def test_actual_private_parent_lives_until_owned_child_exit(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_launch.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(bridge_launch, "resolve_managed_ffmpeg", lambda root: None)
    child = MagicMock()
    child.poll.return_value = None
    monkeypatch.setattr(bridge_launch.subprocess, "Popen", lambda *args, **kwargs: child)
    process = bridge_launch.spawn_managed_bridge(["synthetic-node"], repo_root=tmp_path, env={"PATH": ""})
    private = process._youtab_bridge_private_temp
    directory = Path(private.path if os.name == "nt" else private.name)
    assert directory.is_dir()
    assert bridge_launch.release_managed_bridge_parent(process) is False
    assert directory.is_dir()
    child.poll.return_value = 0
    assert bridge_launch.release_managed_bridge_parent(process) is True
    assert not directory.exists()
    assert bridge_launch.release_managed_bridge_parent(process) is True


def test_spawn_failure_cleans_actual_private_parent(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_launch.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(bridge_launch, "resolve_managed_ffmpeg", lambda root: None)
    monkeypatch.setattr(bridge_launch.subprocess, "Popen", MagicMock(side_effect=OSError("synthetic spawn failure")))
    before = set(tmp_path.iterdir())
    with pytest.raises(OSError, match="synthetic spawn failure"):
        bridge_launch.spawn_managed_bridge(["synthetic-node"], repo_root=tmp_path, env={})
    assert set(tmp_path.iterdir()) == before


def test_web_pairing_uses_verified_env_and_retains_parent(tmp_path, monkeypatch):
    from youtab_agent_cli import web_server
    from gateway.platforms import whatsapp_common
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    (bridge / "bridge.js").write_text("// synthetic pairing process\n")
    monkeypatch.setattr(whatsapp_common, "resolve_whatsapp_bridge_dir", lambda: bridge)
    monkeypatch.setattr("youtab_constants.find_node_executable", lambda kind: "synthetic-node")
    monkeypatch.setattr(web_server, "_ensure_whatsapp_bridge_dependencies", lambda root: None)
    monkeypatch.setattr(bridge_launch.tempfile, "gettempdir", lambda: str(tmp_path))
    expected = tmp_path / "verified-ffmpeg.exe"
    monkeypatch.setattr(bridge_launch, "resolve_managed_ffmpeg", lambda root: expected)
    child = MagicMock()
    child.poll.return_value = None
    spawn = MagicMock(return_value=child)
    monkeypatch.setattr(bridge_launch.subprocess, "Popen", spawn)
    result = web_server._spawn_whatsapp_pairing_process(tmp_path / "synthetic-session", "bot")
    environment = spawn.call_args.kwargs["env"]
    assert environment["WHATSAPP_MODE"] == "bot"
    assert environment["WHATSAPP_DM_POLICY"] == "pairing"
    assert environment["YOUTAB_AGENT_WHATSAPP_FFMPEG_EXE"] == str(expected)
    assert "--pair-json" in spawn.call_args.args[0]
    assert Path(environment["YOUTAB_AGENT_WHATSAPP_PRIVATE_TMP_PARENT"]).is_dir()
    assert bridge_launch.release_managed_bridge_parent(result) is False
    child.poll.return_value = 0
    assert bridge_launch.release_managed_bridge_parent(result) is True


@pytest.mark.parametrize("interrupted", [False, True])
def test_cli_pairing_preserves_session_order_and_private_child_lifetime(tmp_path, monkeypatch, interrupted):
    from youtab_agent_cli import main, config
    from plugins.platforms.whatsapp import adapter
    from gateway.platforms import whatsapp_common
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    (bridge / "bridge.js").write_text("// synthetic pairing process\n")
    (bridge / "node_modules").mkdir()
    home = tmp_path / "synthetic-home"
    home.mkdir()
    saved = {}
    monkeypatch.setattr(main, "get_youtab_home", lambda: home)
    monkeypatch.setattr(main, "_require_tty", lambda *args: None)
    monkeypatch.setattr(config, "get_env_value", lambda key: {"WHATSAPP_MODE": "bot", "WHATSAPP_ALLOWED_USERS": "15551234567"}.get(key))
    monkeypatch.setattr(config, "save_env_value", lambda key, value: saved.setdefault(key, value))
    monkeypatch.setattr("builtins.input", lambda *args: "n")
    monkeypatch.setattr(whatsapp_common, "resolve_whatsapp_bridge_dir", lambda: bridge)
    monkeypatch.setattr("youtab_constants.find_node_executable", lambda kind: "synthetic-node")
    monkeypatch.setattr(bridge_launch.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(bridge_launch, "resolve_managed_ffmpeg", lambda root: None)
    class SyntheticChild:
        exited = False
        waits = 0
        def poll(self): return 0 if self.exited else None
        def wait(self, timeout=None):
            self.waits += 1
            private = self._youtab_bridge_private_temp
            directory = Path(private.path if os.name == "nt" else private.name)
            assert directory.is_dir(), "Parent must remain private and alive during pairing"
            if self.waits == 1 and interrupted:
                raise KeyboardInterrupt
            self.exited = True
            if not interrupted:
                (home / "whatsapp/session/creds.json").write_text("{}")
            return 0
    child = SyntheticChild()
    spawn = MagicMock(return_value=child)
    monkeypatch.setattr(bridge_launch.subprocess, "Popen", spawn)
    monkeypatch.setattr(adapter, "_terminate_bridge_process", lambda process, force=False: setattr(process, "exited", True))
    main.cmd_whatsapp(MagicMock())
    assert "--pair-only" in spawn.call_args.args[0]
    assert "--pair-json" not in spawn.call_args.args[0]
    parent = Path(spawn.call_args.kwargs["env"]["YOUTAB_AGENT_WHATSAPP_PRIVATE_TMP_PARENT"])
    assert not parent.exists()
    assert saved.get("WHATSAPP_ENABLED") == (None if interrupted else "true")
    assert child._youtab_bridge_private_temp is None


@pytest.mark.parametrize("requested", ["default", subprocess.PIPE, subprocess.DEVNULL])
def test_shared_launcher_explicit_stdin_preserves_pipe_and_devnull(tmp_path, monkeypatch, requested):
    monkeypatch.setattr(bridge_launch.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(bridge_launch, "resolve_managed_ffmpeg", lambda root: None)
    child = MagicMock()
    child.poll.return_value = 0
    spawn = MagicMock(return_value=child)
    monkeypatch.setattr(bridge_launch.subprocess, "Popen", spawn)
    arguments = {} if requested == "default" else {"stdin": requested}
    process = bridge_launch.spawn_managed_bridge(["synthetic-node"], repo_root=tmp_path, env={}, **arguments)
    assert spawn.call_args.kwargs["stdin"] == (subprocess.DEVNULL if requested == "default" else requested)
    assert bridge_launch.release_managed_bridge_parent(process) is True
