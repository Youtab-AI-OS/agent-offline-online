"""Tests for the stale-dashboard handling run at the end of ``youtab update``.

``youtab update`` detects ``youtab dashboard`` processes left over from the
previous version and stops only installation-owned process handles with graceful/forced cleanup.  Without this, the running backend silently serves stale Python
against a freshly-updated JS bundle, producing 401s / empty data.

History:
- #16872 introduced the warn-only helper (``_warn_stale_dashboard_processes``).
- #17049 fixed a Windows wmic UnicodeDecodeError crash on non-UTF-8 locales.
- This file now also covers the kill semantics that replaced the warning.
"""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
from unittest.mock import patch, MagicMock

import pytest

from youtab_agent_cli.main import (
    _finish_dashboard_update_cleanup,
    _find_stale_dashboard_pids,
    _kill_stale_dashboard_processes,
    _restart_managed_dashboard_service,
    _warn_stale_dashboard_processes,  # back-compat alias
)


@pytest.fixture(autouse=True)
def _refresh_bindings_against_live_module():
    """Rebind module-level names to the *current* ``youtab_agent_cli.main``.

    Other tests in the suite (notably ``test_env_loader.py`` and
    ``test_skills_subparser.py``) reload or delete ``youtab_agent_cli.main`` from
    ``sys.modules``.  When that happens on the same xdist worker before we
    run, our top-of-file ``from youtab_agent_cli.main import ...`` bindings end
    up pointing at the *old* module object.  ``patch(\"youtab_agent_cli.main.X\")``
    then patches the *new* module, but the function we call still resolves
    ``_find_stale_dashboard_pids`` via its stale ``__globals__``, so every
    patch becomes a no-op and the kill path silently returns early.

    Refreshing the bindings (and the patch target) to the live module
    object — and keeping them consistent — makes the tests immune to
    ordering within the worker.  The fix lives in the test module because
    the two pollutants above are load-bearing for their own tests.
    """
    global _finish_dashboard_update_cleanup
    global _find_stale_dashboard_pids
    global _kill_stale_dashboard_processes
    global _restart_managed_dashboard_service
    global _warn_stale_dashboard_processes

    live = sys.modules.get("youtab_agent_cli.main")
    if live is None:
        live = importlib.import_module("youtab_agent_cli.main")

    _finish_dashboard_update_cleanup = live._finish_dashboard_update_cleanup
    _find_stale_dashboard_pids = live._find_stale_dashboard_pids
    _kill_stale_dashboard_processes = live._kill_stale_dashboard_processes
    _restart_managed_dashboard_service = live._restart_managed_dashboard_service
    _warn_stale_dashboard_processes = live._warn_stale_dashboard_processes
    yield


def _ps_line(pid: int, cmd: str) -> str:
    """Format a line as it would appear in ``ps -A -o pid=,command=`` output."""
    return f"{pid:>7} {cmd}"


def _ps_runner(stdout: str):
    """Build a subprocess.run side_effect that only stubs ps -A calls.

    Any other subprocess.run invocation (e.g. taskkill on Windows) is
    handed back as a successful no-op.  This lets tests exercise the real
    scan path without having to re-stub every unrelated subprocess call
    made later in ``_kill_stale_dashboard_processes``.
    """
    def _side_effect(args, *a, **kw):
        if isinstance(args, (list, tuple)) and args and args[0] == "ps":
            return MagicMock(returncode=0, stdout=stdout, stderr="")
        # Any other subprocess.run (e.g. taskkill) — benign success stub.
        return MagicMock(returncode=0, stdout="", stderr="")
    return _side_effect


class TestFindStaleDashboardPids:
    """Unit tests for ownership-based process discovery."""



    def test_self_pid_excluded(self, owned_handles):
        owned_handles(os.getpid())
        owned_handles(12345)
        assert _find_stale_dashboard_pids() == [12345]


    def test_enumeration_denied_returns_empty(self):
        import psutil
        with patch.object(psutil, "process_iter", side_effect=psutil.AccessDenied()):
            assert _find_stale_dashboard_pids() == []




@pytest.mark.skipif(sys.platform == "win32", reason="POSIX kill semantics")
class TestKillStaleDashboardPosix:
    """Kill path on Linux / macOS: SIGTERM then SIGKILL any survivors."""


    def test_sigterm_graceful_exit(self, owned_handles, capsys):
        processes = [owned_handles(12345), owned_handles(12346)]
        result = _kill_stale_dashboard_processes()
        assert result["matched"] == [12345, 12346]
        assert result["killed"] == [12345, 12346]
        assert result["failed"] == []
        for proc in processes:
            proc.terminate.assert_called_once()
            proc.kill.assert_not_called()
        out = capsys.readouterr().out
        assert "Stopping 2 dashboard" in out
        assert "✓ stopped PID 12345" in out
        assert "✓ stopped PID 12346" in out
        assert "Restart the dashboard" in out





    def test_user_scope_restart_never_falls_back_to_system_or_sudo(self, capsys):
        """A user unit is discovered and restarted through ``systemctl --user``."""
        calls: list[list[str]] = []

        def fake_run(args, *a, **kw):
            calls.append(list(args))
            if args == ["systemctl", "--user", "list-unit-files", "youtab-dashboard.service", "--no-legend", "--no-pager"]:
                return MagicMock(returncode=0, stdout="youtab-dashboard.service enabled enabled\n", stderr="")
            if args == ["systemctl", "--user", "is-active", "youtab-dashboard.service"]:
                return MagicMock(returncode=0, stdout="active\n", stderr="")
            if args == ["systemctl", "--user", "is-enabled", "youtab-dashboard.service"]:
                return MagicMock(returncode=0, stdout="enabled\n", stderr="")
            if args == ["systemctl", "--user", "restart", "youtab-dashboard.service"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            raise AssertionError(f"unexpected subprocess.run call: {args}")

        with patch("subprocess.run", side_effect=fake_run), \
             patch("youtab_agent_cli.main._find_stale_dashboard_pids", return_value=[12345]) as find_pids, \
             patch("os.kill") as kill:
            _kill_stale_dashboard_processes(restart_managed=True)

        assert calls == [
            ["systemctl", "--user", "list-unit-files", "youtab-dashboard.service", "--no-legend", "--no-pager"],
            ["systemctl", "--user", "is-active", "youtab-dashboard.service"],
            ["systemctl", "--user", "is-enabled", "youtab-dashboard.service"],
            ["systemctl", "--user", "restart", "youtab-dashboard.service"],
        ]
        assert all(call[:1] != ["sudo"] and call[:2] != ["systemctl"] for call in calls)
        find_pids.assert_not_called()
        kill.assert_not_called()
        assert "✓ restarted youtab-dashboard.service" in capsys.readouterr().out




class TestKillStaleDashboardWindows:
    """Kill path on Windows: captured process handles, never naked taskkill PIDs."""

    def test_process_handle_stopped_for_each_pid(self, owned_handles, monkeypatch, capsys):
        monkeypatch.setattr(sys, "platform", "win32")
        processes = [owned_handles(12345), owned_handles(12346)]
        with patch("subprocess.run") as run:
            result = _kill_stale_dashboard_processes()
        run.assert_not_called()
        assert result["killed"] == [12345, 12346]
        for proc in processes:
            proc.terminate.assert_called_once()
        out = capsys.readouterr().out
        assert "✓ stopped PID 12345" in out
        assert "✓ stopped PID 12346" in out


class TestBackCompatAlias:
    """``_warn_stale_dashboard_processes`` is kept as an alias for the
    new kill function so old imports don't break."""

    def test_alias_is_the_kill_function(self):
        assert _warn_stale_dashboard_processes is _kill_stale_dashboard_processes


class TestDashboardUpdateCleanup:
    """The git and Windows ZIP update paths share this final cleanup."""

    def test_all_failed_stops_do_not_claim_the_dashboard_was_stopped(self, capsys):
        with patch(
            "youtab_agent_cli.main._kill_stale_dashboard_processes",
            return_value={"matched": [12345], "killed": [], "failed": [(12345, "denied")],
                          "unrecovered": []},
        ):
            _finish_dashboard_update_cleanup([])

        assert "stopped during update" not in capsys.readouterr().out


class TestWindowsWmicEncoding:
    """Unicode argv are obtained directly from psutil without WMIC byte decoding.
    """

    def test_unicode_argv_does_not_require_wmic_decoding(self, owned_handles, monkeypatch):
        monkeypatch.setattr(sys, "platform", "win32")
        proc = owned_handles(12345)
        proc.cmdline.return_value += ["--label", "中文 فارسی"]
        with patch("subprocess.run") as run:
            assert _find_stale_dashboard_pids() == [12345]
        run.assert_not_called()


class TestSupervisedBackendRestart:
    """After the kill, systemd-supervised PIDs get their owning unit
    restarted (#68934) — SIGTERM reads as a clean stop to systemd, so
    Restart=on-failure never fires on its own."""

    def _live(self):
        return sys.modules["youtab_agent_cli.main"]

    def test_supervised_pid_restarts_owning_unit(self, capsys, monkeypatch, owned_handles):
        """A killed PID whose cgroup names a custom unit → systemctl restart."""
        from gateway import status

        monkeypatch.setattr(status, "_pid_exists", lambda pid: False)
        monkeypatch.setattr(sys, "platform", "linux")
        live = self._live()

        def fake_kill(pid, sig):
            if sig == 0:
                raise ProcessLookupError

        owned_handles(4321)
        with patch.object(live, "_restart_managed_dashboard_service", return_value=False), \
             patch.object(live, "_get_pid_cgroup_path",
                          return_value="/system.slice/youtab-serve.service"), \
             patch.object(live, "_get_systemd_service_for_pid",
                          return_value="youtab-serve.service"), \
             patch.object(live, "_try_restart_systemd_service", return_value=True) as restart, \
             patch("os.kill", side_effect=fake_kill), \
             patch("time.sleep"):
            _kill_stale_dashboard_processes(restart_managed=True)

        restart.assert_called_once_with(
            "youtab-serve.service", "/system.slice/youtab-serve.service"
        )
        out = capsys.readouterr().out
        assert "✓ restarted systemd service youtab-serve.service" in out
        # Supervised restart succeeded — no manual hint.
        assert "when you're ready" not in out


class TestManualBackendRespawn:
    """Manually-started dashboards/serves have their argv captured before the
    kill and are respawned detached after the update (#40449)."""

    def _live(self):
        return sys.modules["youtab_agent_cli.main"]


    def test_argv_capture_failure_falls_back_to_hint(self, capsys, monkeypatch, owned_handles):
        from gateway import status

        monkeypatch.setattr(status, "_pid_exists", lambda pid: False)
        monkeypatch.setattr(sys, "platform", "linux")
        live = self._live()

        def fake_kill(pid, sig):
            if sig == 0:
                raise ProcessLookupError

        owned_handles(5555)
        with patch.object(live, "_restart_managed_dashboard_service", return_value=False), \
             patch.object(live, "_get_pid_cgroup_path", return_value=None), \
             patch.object(live, "_get_systemd_service_for_pid", return_value=None), \
             patch.object(live, "_dashboard_cmdline_for_pid", return_value=None), \
             patch.object(live, "_respawn_dashboard_processes") as respawn, \
             patch("os.kill", side_effect=fake_kill), \
             patch("time.sleep"):
            _kill_stale_dashboard_processes(restart_managed=True)

        respawn.assert_not_called()
        out = capsys.readouterr().out
        assert "Restart anything not auto-restarted" in out

    def test_respawn_adds_no_open_to_dashboard_commands(self, tmp_path, monkeypatch):
        """Respawned `dashboard` argv gains --no-open; `serve` argv untouched."""
        live = self._live()
        monkeypatch.setenv("YOUTAB_AGENT_HOME", str(tmp_path / ".youtab-agent-runtime"))
        spawned: list[list[str]] = []

        class _FakePopen:
            def __init__(self, cmd, **kwargs):
                spawned.append(list(cmd))

        with patch.object(live.subprocess, "Popen", _FakePopen):
            failed = live._respawn_dashboard_processes([
                ["youtab", "dashboard", "--port", "8300"],
                ["youtab", "serve", "--host", "0.0.0.0"],
            ])

        assert failed == []
        assert spawned[0] == ["youtab", "dashboard", "--port", "8300", "--no-open"]
        assert spawned[1] == ["youtab", "serve", "--host", "0.0.0.0"]

    def test_respawn_failure_returned(self, tmp_path, monkeypatch, capsys):
        live = self._live()
        monkeypatch.setenv("YOUTAB_AGENT_HOME", str(tmp_path / ".youtab-agent-runtime"))

        with patch.object(live.subprocess, "Popen", side_effect=OSError("no such file")):
            failed = live._respawn_dashboard_processes([["youtab", "serve"]])

        assert failed == [["youtab", "serve"]]
        out = capsys.readouterr().out
        assert "✗ failed to restart" in out


class TestCmdlineCapture:
    """_dashboard_cmdline_for_pid reads /proc on Linux, ps on macOS."""

    def _live(self):
        return sys.modules["youtab_agent_cli.main"]

    def test_reads_proc_cmdline_when_available(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sys, "platform", "linux")
        live = self._live()
        proc_file = tmp_path / "cmdline"
        proc_file.write_bytes(b"/usr/bin/python3\x00-m\x00youtab_agent_cli.main\x00serve\x00")

        real_exists = os.path.exists

        def fake_exists(path):
            if path == "/proc/777/cmdline":
                return True
            return real_exists(path)

        real_open = open

        def fake_open(path, *a, **kw):
            if path == "/proc/777/cmdline":
                return real_open(proc_file, *a, **kw)
            return real_open(path, *a, **kw)

        with patch.object(live.os.path, "exists", fake_exists), \
             patch("builtins.open", fake_open):
            argv = live._dashboard_cmdline_for_pid(777)

        assert argv == ["/usr/bin/python3", "-m", "youtab_agent_cli.main", "serve"]

    def test_falls_back_to_ps_without_proc(self, monkeypatch):
        monkeypatch.setattr(sys, "platform", "darwin")
        live = self._live()

        def fake_run(args, *a, **kw):
            assert args == ["ps", "-p", "888", "-o", "command="]
            return MagicMock(returncode=0, stdout="youtab serve --port 8300\n", stderr="")

        with patch.object(live.os.path, "exists", return_value=False), \
             patch("subprocess.run", side_effect=fake_run):
            argv = live._dashboard_cmdline_for_pid(888)

        assert argv == ["youtab", "serve", "--port", "8300"]

    def test_returns_none_on_windows(self, monkeypatch):
        live = self._live()
        monkeypatch.setattr(live.sys, "platform", "win32")
        assert live._dashboard_cmdline_for_pid(123) is None


class TestWindowsDashboardDiscoveryFallback:
    @pytest.mark.parametrize("wmic_failure", [
        FileNotFoundError("wmic missing"),
        subprocess.TimeoutExpired("wmic", 10),
        MagicMock(returncode=1, stdout="", stderr="failed"),
        MagicMock(returncode=0, stdout=None, stderr=""),
    ])
    def test_psutil_preserves_matches_and_protected_pids(self, monkeypatch, wmic_failure, owned_handles):
        owned_handles(12345)
        owned_handles(12346, "serve")
        owned_handles(os.getpid())
        owned_handles(12347, "chat")
        empty = owned_handles(12348)
        empty.cmdline.return_value = []
        with patch("subprocess.run", side_effect=wmic_failure if isinstance(wmic_failure, Exception) else None) as run:
            assert _find_stale_dashboard_pids(exclude_pids={12346}) == [12345]
        run.assert_not_called()

    @pytest.mark.parametrize("process_error", ["gone", "denied"])
    def test_process_error_does_not_hide_later_match(self, monkeypatch, process_error, owned_handles):
        import psutil
        gone = owned_handles(12344)
        gone.exe.side_effect = psutil.NoSuchProcess(12344) if process_error == "gone" else psutil.AccessDenied(12344)
        owned_handles(12345, "serve")
        assert _find_stale_dashboard_pids() == [12345]

    def test_fallback_enumeration_denied_returns_empty(self, monkeypatch):
        import psutil

        monkeypatch.setattr(sys, "platform", "win32")
        with patch("subprocess.run", side_effect=FileNotFoundError), \
             patch.object(psutil, "process_iter", side_effect=psutil.AccessDenied()):
            assert _find_stale_dashboard_pids() == []

    def test_desktop_child_exclusion_without_any_signal(self, monkeypatch, owned_handles):
        monkeypatch.setenv("YOUTAB_AGENT_DESKTOP_CHILD_PID", "12345, 12346, invalid")
        processes = [owned_handles(12345, "serve"), owned_handles(12346)]
        with patch("subprocess.run") as run:
            assert _kill_stale_dashboard_processes() == {"matched": [], "killed": [], "failed": []}
        run.assert_not_called()
        for proc in processes:
            proc.terminate.assert_not_called()
            proc.kill.assert_not_called()

    def test_untrusted_wmic_text_cannot_authorize_stop(self, owned_handles):
        with patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="CommandLine=youtab dashboard\nProcessId=12345\n")) as run:
            assert _find_stale_dashboard_pids() == []
        run.assert_not_called()


@pytest.fixture
def owned_handles(tmp_path, monkeypatch):
    import psutil
    from youtab_agent_cli import dashboard_procs
    root = tmp_path / "owned-installation"
    (root / "youtab_agent_cli").mkdir(parents=True)
    (root / "youtab_agent_cli" / "main.py").touch()
    (root / ".venv" / "Scripts").mkdir(parents=True)
    exe = root / ".venv" / "Scripts" / "python.exe"
    exe.touch()
    monkeypatch.setattr(dashboard_procs, "__file__", str(root / "youtab_agent_cli" / "dashboard_procs.py"))
    processes = []
    def make(pid, role="dashboard"):
        proc = MagicMock()
        proc.pid = pid
        proc.exe.return_value = str(exe)
        proc.cmdline.return_value = [str(exe), "-m", "youtab_agent_cli.main", role]
        proc.cwd.return_value = str(root)
        proc.environ.return_value = {}
        proc.username.return_value = psutil.Process().username()
        proc.is_running.return_value = True
        proc.create_time.return_value = float(pid)
        processes.append(proc)
        return proc
    monkeypatch.setattr(psutil, "process_iter", lambda: iter(processes))
    monkeypatch.setattr(psutil, "wait_procs", lambda handles, timeout: (handles, []))
    return make
