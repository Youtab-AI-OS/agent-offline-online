"""Regression tests for _wait_for_process subprocess cleanup on exception exit.

When the poll loop exits via KeyboardInterrupt or SystemExit (SIGTERM via
cli.py signal handler, SIGINT on the main thread in non-interactive -q mode,
or explicit sys.exit from some caller), the child subprocess must be killed
before the exception propagates — otherwise the local backend's use of
os.setsid leaves an orphan with PPID=1.

The live repro that motivated this: youtab chat -q ... 'sleep 300', SIGTERM
to the python process, sleep 300 survived with PPID=1 for the full 300 s
because _wait_for_process never got to call _kill_process before python
died.  See commit message for full context.
"""
import os
import signal
import shlex
import sys
import subprocess
import threading
import time
from types import SimpleNamespace

import pytest

from tools.environments import local as local_mod
from tools.environments.local import LocalEnvironment, _quote_bash_path


@pytest.fixture(autouse=True)
def _isolate_youtab_home(tmp_path, monkeypatch):
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    (tmp_path / "logs").mkdir(exist_ok=True)


def _pgid_still_alive(pgid: int) -> bool:
    """Return True if any process in the given process group is still alive."""
    try:
        os.killpg(pgid, 0)  # signal 0 = existence check
        return True
    except ProcessLookupError:
        return False


def _process_group_snapshot(pgid: int) -> str:
    """Return a process-table snapshot for diagnostics."""
    return subprocess.run(
        ["ps", "-o", "pid,ppid,pgid,stat,cmd", "-g", str(pgid)],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()


def _wait_for_pgid_exit(pgid: int, timeout: float = 60.0) -> bool:
    """Wait for a process group to disappear under loaded xdist hosts.

    The cleanup chain is: SIGTERM → 3s TimeoutStopSec → SIGKILL → reap.
    Under heavy xdist load (40 parallel workers, 6-shard CI), the full
    sequence can exceed 10s. Default timeout is generous to avoid CI
    flakes; in practice the wait returns in <1s on quiet hosts.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pgid_still_alive(pgid):
            return True
        time.sleep(0.1)
    return not _pgid_still_alive(pgid)


def test_kill_process_uses_cached_pgid_if_wrapper_already_exited(monkeypatch):
    """If the shell wrapper exits before cleanup, still kill its process group.

    Without the cached pgid fallback, ``os.getpgid(proc.pid)`` raises for the
    dead wrapper and cleanup falls back to ``proc.kill()``, which cannot reach
    orphaned grandchildren still running in the original process group.
    """
    env = object.__new__(LocalEnvironment)
    proc = SimpleNamespace(
        pid=12345,
        _youtab_pgid=67890,
        poll=lambda: 0,
        kill=lambda: None,
    )
    killpg_calls = []

    def fake_getpgid(_pid):
        raise ProcessLookupError

    def fake_killpg(pgid, sig):
        killpg_calls.append((pgid, sig))
        if sig == 0:
            raise ProcessLookupError

    monkeypatch.setattr(local_mod, "_IS_WINDOWS", False)
    monkeypatch.setattr(os, "getpgid", fake_getpgid, raising=False)
    monkeypatch.setattr(os, "killpg", fake_killpg, raising=False)

    env._kill_process(proc)

    assert killpg_calls == [(67890, signal.SIGTERM), (67890, 0)]


def test_wait_for_process_kills_subprocess_on_keyboardinterrupt(tmp_path, monkeypatch):
    """When KeyboardInterrupt arrives mid-poll, the subprocess group must be
    killed before the exception is re-raised."""
    import psutil

    marker = tmp_path / "owned-child.pid"
    child_code = (
        "from pathlib import Path; import os,time; "
        f"Path({marker.as_posix()!r}).write_text(str(os.getpid())); time.sleep(30)"
    )
    command = f"{_quote_bash_path(sys.executable)} -c {shlex.quote(child_code)}"
    env = LocalEnvironment(cwd=str(tmp_path))
    command_started = threading.Event()
    command_procs = []
    owned_children = []
    real_popen = subprocess.Popen

    def capture_owned_process(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        # Capture only this test's command wrapper, never search host processes.
        if args and "owned-child.pid" in str(args[0]):
            command_procs.append(proc)
            command_started.set()
        return proc

    monkeypatch.setattr(local_mod.subprocess, "Popen", capture_owned_process)
    try:
        result_holder = {}

        # Drive execute() on a separate thread so we can SIGNAL-interrupt it
        # via a thread-targeted exception without killing our test process.
        def worker():
            # Spawn a subprocess that will definitely be alive long enough
            # to observe the cleanup, via env.execute(...) — the normal path
            # that goes through _wait_for_process.
            try:
                result_holder["result"] = env.execute(command, timeout=60)
            except BaseException as e:  # noqa: BLE001 — we want to observe it
                result_holder["exception"] = type(e).__name__

        t = threading.Thread(target=worker, daemon=True)
        t.start()
        assert command_started.wait(20.0), "owned command wrapper did not start"
        command_proc = command_procs[0]
        owner = psutil.Process(command_proc.pid)
        deadline = time.monotonic() + 20.0
        sleeper_pid = None
        while time.monotonic() < deadline:
            if marker.exists():
                value = marker.read_text().strip()
                if value.isdigit():
                    sleeper_pid = int(value)
                    break
            time.sleep(0.1)
        assert sleeper_pid is not None, "owned sleeper did not report its PID"
        sleeper = psutil.Process(sleeper_pid)
        assert marker.as_posix() in " ".join(sleeper.cmdline())
        assert sleeper.is_running(), "owned sleeper exited before interruption"
        # MSYS children may not retain a native parent link. The child's own
        # unique marker proves ownership independently of Windows PID mapping.
        owned_children = [sleeper, *owner.children(recursive=True)]
        owned_processes = [owner, *owned_children]
        if not local_mod._IS_WINDOWS:
            pgid = os.getpgid(command_proc.pid)
            assert _pgid_still_alive(pgid), "sanity: subprocess should be alive"

        # Now inject a KeyboardInterrupt into the worker thread the same
        # way CPython's signal machinery would.  We use ctypes.PyThreadState_SetAsyncExc
        # which is how signal delivery to non-main threads is simulated.
        import ctypes
        # py-thread-state exception targets need the ident, not the Thread
        tid = t.ident
        assert tid is not None
        # Fire KeyboardInterrupt into the worker thread
        ret = ctypes.pythonapi.PyThreadState_SetAsyncExc(
            ctypes.c_ulong(tid), ctypes.py_object(KeyboardInterrupt),
        )
        assert ret == 1, f"SetAsyncExc returned {ret}, expected 1"

        # Give the worker a moment to: hit the exception at the next poll,
        # run the except-block cleanup (_kill_process), and exit.  Under
        # xdist load the SIGTERM → 3s wait → SIGKILL chain can take longer
        # than 5s before the worker's join() returns; bumped to 15s.
        t.join(timeout=30.0)
        assert not t.is_alive(), "worker didn't exit within 30 s of the interrupt"

        # The critical assertion: the subprocess GROUP must be dead.  Not
        # just the bash wrapper — the 'sleep 30' child too. Under xdist load,
        # process-group disappearance can lag briefly after the worker exits,
        # especially if the process is already dying or waiting to be reaped.
        if local_mod._IS_WINDOWS:
            _, alive = psutil.wait_procs(owned_processes, timeout=60.0)
            assert not alive, f"owned subprocesses survived KeyboardInterrupt: {alive}"
        else:
            assert _wait_for_pgid_exit(pgid), (
                f"owned subprocess group {pgid} survived KeyboardInterrupt\n"
                f"{_process_group_snapshot(pgid)}"
            )
        # And the worker should have observed the KeyboardInterrupt (i.e.
        # it re-raised cleanly, not silently swallowed).
        assert result_holder.get("exception") == "KeyboardInterrupt", (
            f"worker result: {result_holder!r} — expected KeyboardInterrupt "
            f"propagation after cleanup"
        )
    finally:
        # A failed assertion still cleans only processes spawned by this test.
        for proc in command_procs:
            if proc.poll() is None:
                env._kill_process(proc)
        for child in owned_children:
            try:
                # psutil verifies process identity before kill (PID reuse).
                if child.is_running():
                    child.kill()
            except psutil.NoSuchProcess:
                pass
        try:
            env.cleanup()
        except Exception:
            pass
