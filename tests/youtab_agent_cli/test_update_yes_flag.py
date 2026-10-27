"""Tests for `youtab update --yes / -y` — assume yes for interactive prompts.

Covers:
  1. argparse parses the flag
  2. Config-migration prompt is auto-answered (no input() call) and migrate_config
     runs with interactive=False so API-key prompts are skipped
  3. Autostash restore prompt is auto-answered (prompt_for_restore == False, no
     input() call) and the stash is applied automatically
"""

import subprocess
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from youtab_agent_cli.main import cmd_update


def _make_run_side_effect(
    branch="main", verify_ok=True, commit_count="1", dirty=False
):
    """Minimal subprocess.run side_effect for the update flow."""

    def side_effect(cmd, **kwargs):
        joined = " ".join(str(c) for c in cmd)

        if "rev-parse" in joined and "--abbrev-ref" in joined:
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{branch}\n", stderr="")
        if "rev-parse" in joined and "--verify" in joined:
            return subprocess.CompletedProcess(
                cmd, 0 if verify_ok else 128, stdout="", stderr=""
            )
        if "rev-list" in joined:
            return subprocess.CompletedProcess(
                cmd, 0, stdout=f"{commit_count}\n", stderr=""
            )
        # `git status --porcelain` for dirty-tree detection during autostash.
        if "status" in joined and "--porcelain" in joined:
            out = " M youtab_agent_cli/main.py\n" if dirty else ""
            return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")
        # `git stash list` — return a stash ref when dirty (so _stash_local_changes
        # gets something to return). _stash_local_changes_if_needed is what we
        # actually patch in tests that exercise restore, so this is a catch-all.
        if "stash" in joined and "list" in joined:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    return side_effect


class TestUpdateYesConfigMigration:
    """--yes auto-answers the config-migration prompt and skips API-key prompts."""

    @pytest.fixture(autouse=True)
    def quiet_update_installation(self, tmp_path, monkeypatch):
        """Branch/config tests use a quiet legacy checkout, not the host fleet."""
        from unittest.mock import Mock
        import psutil
        from youtab_agent_cli import gateway, main as hm, managed_uv, update_cmd

        checkout = tmp_path / "checkout"
        (checkout / ".git").mkdir(parents=True)
        scripts_dir = checkout / "venv" / "Scripts"
        scripts_dir.mkdir(parents=True)
        monkeypatch.setattr(hm, "PROJECT_ROOT", checkout)
        monkeypatch.setattr(hm, "_venv_scripts_dir", Mock(return_value=scripts_dir))
        holders = Mock(return_value=[])
        monkeypatch.setattr(hm, "_detect_venv_python_processes", holders)
        monkeypatch.setattr(hm, "_detect_concurrent_youtab_instances", Mock(return_value=[]))
        for name in (
            "_run_pre_update_backup", "_pause_windows_gateways_for_update",
            "_resume_windows_gateways_after_update", "_reload_updated_runtime_modules",
            "_refresh_active_memory_provider_dependencies",
            "_upgrade_pip_before_lazy_refresh", "_install_python_dependencies_with_optional_fallback",
        ):
            monkeypatch.setattr(hm, name, Mock(return_value=None))
        monkeypatch.setattr(hm, "_refresh_active_lazy_features", Mock(return_value=True))
        monkeypatch.setattr(update_cmd, "_venv_core_imports_healthy", Mock(return_value=(True, "")))
        monkeypatch.setattr(update_cmd, "_finish_dashboard_update_cleanup", Mock())
        monkeypatch.setattr(managed_uv, "ensure_uv", Mock(return_value=None))
        monkeypatch.setattr(managed_uv, "update_managed_uv", Mock(return_value=None))
        monkeypatch.setattr(gateway, "supports_systemd_services", Mock(return_value=False))
        monkeypatch.setattr(gateway, "find_gateway_pids", Mock(return_value=[]))
        monkeypatch.setattr(gateway, "find_profile_gateway_processes", Mock(return_value=[]))
        monkeypatch.setattr(gateway, "_get_service_pids", Mock(return_value=set()))
        spawn = Mock(side_effect=AssertionError("Update unit tests must not launch processes"))
        enumerate_processes = Mock(side_effect=AssertionError("Update unit tests must not enumerate the host"))
        monkeypatch.setattr(subprocess, "Popen", spawn)
        monkeypatch.setattr(psutil, "process_iter", enumerate_processes)
        yield holders
        spawn.assert_not_called()
        enumerate_processes.assert_not_called()


    @patch("youtab_agent_cli.config.migrate_config")
    @patch("youtab_agent_cli.config.check_config_version", return_value=(1, 2))
    @patch("youtab_agent_cli.config.get_missing_config_fields", return_value=[])
    @patch("youtab_agent_cli.config.get_missing_env_vars", return_value=["NEW_KEY"])
    @patch("shutil.which", return_value=None)
    @patch("subprocess.run")
    def test_yes_auto_migrates_without_input(
        self,
        mock_run,
        _mock_which,
        _mock_missing_env,
        _mock_missing_cfg,
        _mock_version,
        mock_migrate,
        capsys,
    ):
        mock_run.side_effect = _make_run_side_effect(
            branch="main", verify_ok=True, commit_count="1"
        )
        mock_migrate.return_value = {"env_added": [], "config_added": []}

        args = SimpleNamespace(yes=True)

        with patch("builtins.input") as mock_input:
            cmd_update(args)
            # Never prompted the user.
            mock_input.assert_not_called()

        # migrate_config was invoked with interactive=False — API-key prompts
        # are suppressed, matching gateway-mode semantics.
        assert mock_migrate.call_count == 1
        _, kwargs = mock_migrate.call_args
        assert kwargs.get("interactive") is False

        out = capsys.readouterr().out
        assert "--yes: auto-applying config migration" in out
        # The "Would you like to configure them now?" prompt text never appears.
        assert "Would you like to configure them now?" not in out

    @patch("youtab_agent_cli.config.migrate_config")
    @patch("youtab_agent_cli.config.check_config_version", return_value=(1, 2))
    @patch("youtab_agent_cli.config.get_missing_config_fields", return_value=[])
    @patch("youtab_agent_cli.config.get_missing_env_vars", return_value=["NEW_KEY"])
    @patch("shutil.which", return_value=None)
    @patch("subprocess.run")
    def test_no_yes_flag_still_prompts_in_tty(
        self,
        mock_run,
        _mock_which,
        _mock_missing_env,
        _mock_missing_cfg,
        _mock_version,
        mock_migrate,
        capsys,
    ):
        """Regression guard: without --yes, the TTY prompt path still fires."""
        mock_run.side_effect = _make_run_side_effect(
            branch="main", verify_ok=True, commit_count="1"
        )
        mock_migrate.return_value = {"env_added": [], "config_added": []}

        args = SimpleNamespace(yes=False)

        # Patch ``sys.stdin.isatty`` and ``sys.stdout.isatty`` directly on the
        # real ``sys`` module instead of replacing ``youtab_agent_cli.main.sys`` with
        # a MagicMock. The MagicMock approach was flaky under ``pytest-xdist``
        # — a sibling test that imported ``youtab_agent_cli.main`` first could leave
        # a different ``sys`` reference resolved inside the function and the
        # mock would never be consulted, with CI then taking the
        # "Non-interactive session" branch instead of prompting.
        import sys as _sys

        with patch("builtins.input", return_value="n") as mock_input, patch.object(
            _sys.stdin, "isatty", return_value=True
        ), patch.object(_sys.stdout, "isatty", return_value=True):
            cmd_update(args)
            # The user was actually prompted.
            assert mock_input.called
            prompts = [c.args[0] if c.args else "" for c in mock_input.call_args_list]
            assert any("configure them now" in p for p in prompts)


class TestUpdateYesStashRestore:
    """--yes auto-restores the pre-update autostash without prompting."""

