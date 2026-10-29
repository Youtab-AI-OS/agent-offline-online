"""Regression tests for issue #8340.

When a user command backgrounds a child process (``cmd &``, ``setsid cmd &
disown``, etc.), the backgrounded grandchild inherits the write-end of our
stdout pipe via fork().  Before the fix, the drain thread's blocking
``for line in proc.stdout`` would never see EOF until that grandchild
closed the pipe — causing the terminal tool to hang for the full lifetime
of the backgrounded service (indefinitely for a uvicorn server).

The fix switches ``_drain()`` to select()-based non-blocking reads and
stops draining shortly after bash exits even if the pipe hasn't EOF'd.
"""
import subprocess
import time
import sys
import os
import shlex
import json
from pathlib import Path

import psutil

import pytest

from tools.environments.local import LocalEnvironment, _quote_bash_path

pytestmark = pytest.mark.live_system_guard_bypass


def _python_command(code: str) -> str:
    return _quote_bash_path(sys.executable) + " -c " + shlex.quote(code)


@pytest.fixture(autouse=True)
def _synthetic_home(tmp_path, monkeypatch):
    for key in ("HOME", "USERPROFILE"):
        monkeypatch.setenv(key, str(tmp_path))


@pytest.fixture
def local_env(tmp_path):
    env = LocalEnvironment(cwd=str(tmp_path))
    try:
        yield env
    finally:
        env.cleanup()


@pytest.fixture
def owned_background(tmp_path):
    child = tmp_path / "owned_background_child.py"
    identity = tmp_path / "owned_background_identity.json"
    child.write_text(
        "import os, time, json\nfrom pathlib import Path\n"
        + f"ready = Path({str(identity)!r}); stage = ready.with_suffix('.tmp'); stage.write_text(json.dumps({{'pid': os.getpid()}})); stage.replace(ready)\n"
        + "time.sleep(60)\n", encoding="utf-8", newline="\n",
    )

    retained = []

    def wait_ready():
        deadline = time.monotonic() + 5
        while not identity.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert identity.exists(), "Owned child did not start"
        data = json.loads(identity.read_text(encoding="utf-8"))
        proc = psutil.Process(data["pid"])
        stamp = proc.create_time()
        command = " ".join(proc.cmdline()).replace("\\", "/")
        assert child.as_posix().lower() in command.lower() if os.name == "nt" else child.as_posix() in command
        retained[:] = [(proc, stamp)]
        return proc, stamp

    try:
        yield child, wait_ready
    finally:
        if not retained and identity.exists():
            wait_ready()
        for proc, stamp in retained:
            try:
                if proc.is_running() and proc.create_time() == stamp:
                    assert child.name in " ".join(proc.cmdline())
                    proc.kill()
                    proc.wait(3)
            except psutil.NoSuchProcess:
                pass


class TestBackgroundChildDoesNotHang:
    """Regression guard for issue #8340."""

    def test_plain_background_returns_promptly(self, local_env, owned_background):
        """``cmd &`` with no output redirection must not hang on pipe inherit."""
        marker = "youtab_8340_plain_bg"
        child, wait_ready = owned_background
        cmd = f"{_quote_bash_path(sys.executable)} {shlex.quote(child.as_posix())} & echo {marker}"
        try:
            t0 = time.monotonic()
            result = local_env.execute(cmd, timeout=15)
            elapsed = time.monotonic() - t0

            assert elapsed < 10.0, (  # hang under guard is 15s+; loose bound rides out runner stalls
                f"terminal_tool hung for {elapsed:.1f}s — drain thread "
                f"is still blocking on backgrounded child's inherited pipe fd"
            )
            assert result["returncode"] == 0
            assert marker in result["output"]
        finally:
            wait_ready()

    def test_setsid_disown_pattern_returns_promptly(self, local_env, owned_background):
        """The exact pattern from the issue: setsid ... & disown."""
        child, wait_ready = owned_background
        if os.name == "nt":
            # Windows detached process is the native counterpart of setsid.
            cmd = _python_command(
                "import subprocess, sys; "
                + f"subprocess.Popen([sys.executable, {child.as_posix()!r}], "
                + "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, "
                + "close_fds=True, creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP); "
                + "print('started')"
            )
        else:
            cmd = (f"setsid {_quote_bash_path(sys.executable)} {shlex.quote(child.as_posix())} "
                   "> /dev/null 2>&1 < /dev/null & disown; echo started")
        try:
            t0 = time.monotonic()
            result = local_env.execute(cmd, timeout=15)
            elapsed = time.monotonic() - t0

            assert elapsed < 10.0, f"setsid+disown path hung for {elapsed:.1f}s"
            assert result["returncode"] == 0
            assert "started" in result["output"]
        finally:
            wait_ready()


    def test_default_capture_is_full_fidelity_for_internal_consumers(
        self, local_env
    ):
        """Default execute() (no bounded_capture) must return complete output.

        Internal consumers — file-operation ``cat`` reads that feed the patch
        engine, code-execution RPC reads, log reads — rely on full-fidelity
        capture. Bounding them at tool_output.max_bytes would CORRUPT files
        on read-modify-write (#64435 review finding), so only the foreground
        terminal tool opts in via bounded_capture=True.
        """
        # ~200 KB — four times the default 50 KB cap.
        expected = "START-MARK\n" + "y" * 200000 + "\nEND-MARK"
        command = _python_command(
            "import sys; sys.stdout.buffer.write(('START-MARK\\n' + ('y' * 200000) + '\\nEND-MARK').encode('utf-8'))"
        )

        result = local_env.execute(command, timeout=10)

        assert result["returncode"] == 0
        assert "[OUTPUT TRUNCATED" not in result["output"]
        assert result["output"].startswith("START-MARK")
        assert result["output"].endswith("END-MARK")
        assert len(result["output"]) > 200000
        assert result["output"] == expected


    def test_utf8_multibyte_across_read_boundary(self, local_env):
        """Multibyte UTF-8 characters straddling a 4096-byte ``os.read()`` boundary
        must be decoded correctly via the incremental decoder — not lost to a
        ``UnicodeDecodeError`` fallback.  Regression for a bug in the first draft
        of the fix where a strict ``bytes.decode('utf-8')`` on each raw chunk
        wiped the entire buffer as soon as any chunk split a multi-byte char.
        """
        # 10000 "日" chars = 30000 bytes — guaranteed to cross multiple 4096
        # read boundaries, and most boundaries will land in the middle of the
        # 3-byte UTF-8 encoding of U+65E5.
        cmd = _python_command(
            'import sys; '
            'sys.stdout.buffer.write(chr(0x65e5).encode("utf-8") * 10000); '
            'sys.stdout.buffer.write(b"\\n")'
        )
        result = local_env.execute(cmd, timeout=10)
        assert result["returncode"] == 0
        # All 10000 characters must survive the round-trip
        assert result["output"].count("\u65e5") == 10000, (
            f"lost multibyte chars across read boundaries: got "
            f"{result['output'].count(chr(0x65e5))} / 10000"
        )
        # And the "[binary output detected ...]" fallback must NOT fire
        assert "binary output detected" not in result["output"]

    def test_invalid_utf8_uses_replacement_not_fallback(self, local_env):
        """Truly invalid byte sequences must be substituted with U+FFFD (matching
        the pre-fix ``errors='replace'`` behaviour of the old ``TextIOWrapper``
        drain), not clobber the entire buffer with a fallback placeholder.
        """
        # Write a deliberate invalid UTF-8 lead byte sandwiched between valid ASCII
        cmd = _python_command(
            'import sys; '
            'sys.stdout.buffer.write(b"before "); '
            'sys.stdout.buffer.write(b"\\xff\\xfe"); '
            'sys.stdout.buffer.write(b" after\\n")'
        )
        result = local_env.execute(cmd, timeout=15)
        assert result["returncode"] == 0
        assert "before" in result["output"]
        assert "after" in result["output"]
        assert "binary output detected" not in result["output"]


def test_continuously_writing_background_child_releases_pipe(local_env, owned_background, monkeypatch):
    child, wait_ready = owned_background
    content = child.read_text(encoding="utf-8")
    child.write_text(content.replace("time.sleep(60)", "while True:\n    os.write(1, b'background-data\\n' * 64)\n    time.sleep(0.01)"), encoding="utf-8", newline="\n")
    # Spawn a real child that keeps our parent's stdout writer alive.
    code = f"import subprocess, sys; subprocess.Popen([sys.executable, {child.as_posix()!r}]); print('PARENT-EXIT')"
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    try:
        wait_ready()  # Retain native child's verified identity before draining.
        started = time.monotonic()
        result = local_env._wait_for_process(proc, timeout=15, bounded_capture=True)
        assert time.monotonic() - started < 10.0
        assert result["returncode"] == 0
        assert "PARENT-EXIT" in result["output"]
        assert "background-data" in result["output"]
        assert proc.stdout.closed
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(3)

    if os.name == "nt":
        # The portable inherited-pipe test above runs on both platforms.
        # Also verify native Windows API failures reach the caller instead of
        # returning a successful result with silently omitted output.
        import ctypes

        class FailedPeek:
            def __call__(self, *args):
                ctypes.set_last_error(5)
                return 0

        class Kernel:
            PeekNamedPipe = FailedPeek()

        monkeypatch.setattr(ctypes, "WinDLL", lambda *args, **kwargs: Kernel())
        failed_proc = subprocess.Popen(
            [sys.executable, "-c", "print('owned-output')"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        # A direct Popen handle owns this process. Avoid an external tree-kill
        # command so this pipe-error assertion tests only reader behavior.
        monkeypatch.setattr(
            local_env, "_kill_process",
            lambda process: process.kill() if process.poll() is None else None,
        )
        try:
            with pytest.raises(OSError) as caught:
                local_env._wait_for_process(failed_proc, timeout=10)
            assert caught.value.winerror == 5
            assert failed_proc.stdout.closed
        finally:
            if failed_proc.poll() is None:
                failed_proc.kill()
            failed_proc.wait(3)
