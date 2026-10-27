"""`youtab update` must self-heal the ``youtab-acp`` launcher.

ACP hosts (Zed, JetBrains, Buzz Desktop) resolve the agent by the
``youtab-acp`` command name on the login-shell PATH. Fresh installs get the
launcher from ``scripts/install.sh``; existing installs get it from
``_ensure_acp_launcher()`` during ``youtab update``.
"""

import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, patch

import pytest

from youtab_agent_cli.main import _ensure_acp_launcher
from youtab_agent_cli import main


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    # Exercise the POSIX shim implementation even on Windows; the native
    # Windows no-op is covered separately below.
    monkeypatch.setattr(main, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(tmp_path / ".youtab-agent-runtime"))
    bin_dir = tmp_path / ".local" / "bin"
    bin_dir.mkdir(parents=True)
    return bin_dir








def test_does_not_follow_symlink_into_venv(fake_home, tmp_path, monkeypatch):
    """#21454 failure mode: never write through a symlinked youtab-acp."""
    (fake_home / "youtab").write_text("#!/bin/sh\n", encoding="utf-8")
    console_script = tmp_path / "venv" / "bin" / "youtab-acp"
    console_script.parent.mkdir(parents=True)
    marker = "#!/usr/bin/env python\n# real console script\n"
    console_script.write_text(marker, encoding="utf-8")
    acp_cmd = fake_home / "youtab-acp"
    if os.name == "nt":
        # Windows file symlinks require privileges. Inject the predicate at
        # the filesystem seam to test the guard without changing privileges.
        # POSIX retains the actual symlink integration coverage.
        real_is_symlink = Path.is_symlink
        monkeypatch.setattr(
            Path, "is_symlink",
            lambda path: path == acp_cmd or real_is_symlink(path),
        )
    else:
        acp_cmd.symlink_to(console_script)

    with patch.object(Path, "write_text", autospec=True) as write:
        _ensure_acp_launcher()
    write.assert_not_called()

    assert console_script.read_text(encoding="utf-8") == marker
    assert (fake_home / "youtab-acp").is_symlink()






def test_unwritable_bin_dir_is_skipped(fake_home):
    (fake_home / "youtab").write_text("#!/bin/sh\n", encoding="utf-8")
    acp_cmd = fake_home / "youtab-acp"
    real_write_text = Path.write_text

    def deny_launcher_write(path, *args, **kwargs):
        if path == acp_cmd:
            raise PermissionError("synthetic unwritable bin directory")
        return real_write_text(path, *args, **kwargs)

    # chmod does not deny directory creation on Windows or for root. Inject
    # the real failing operation and assert it was reached and contained.
    with patch.object(Path, "write_text", autospec=True, side_effect=deny_launcher_write) as write:
        _ensure_acp_launcher()  # must not raise
        write.assert_any_call(acp_cmd, ANY, encoding="utf-8")
    assert not acp_cmd.exists()


def test_windows_uses_existing_console_entrypoint(fake_home, monkeypatch):
    monkeypatch.setattr(main, "sys", SimpleNamespace(platform="win32"))
    (fake_home / "youtab").write_text("synthetic launcher", encoding="utf-8")
    with patch.object(Path, "write_text") as write:
        _ensure_acp_launcher()
    write.assert_not_called()
