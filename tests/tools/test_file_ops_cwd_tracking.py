"""Regression tests for cwd-staleness in ShellFileOperations.

The bug: ShellFileOperations captured the terminal env's cwd at __init__
time and used that stale value for every subsequent _exec() call.  When
a user ran ``cd`` via the terminal tool, ``env.cwd`` updated but
``ops.cwd`` did not.  Relative paths passed to patch/read/write/search
then targeted the wrong directory — typically the session's start dir
instead of the current working directory.

Observed symptom: patch_replace() returned ``success=True`` with a
plausible diff, but the user's ``git diff`` showed no change (because
the patch landed in a different directory's copy of the same file).

Fix: _exec() now prefers the LIVE ``env.cwd`` over the init-time
``self.cwd``.  Explicit ``cwd`` arg to _exec still wins over both.
"""

from __future__ import annotations


from tools.file_operations import ShellFileOperations
from tools.environments.local import LocalEnvironment


class _FakeEnv:
    """Minimal terminal env that tracks cwd across execute() calls.

    Matches the real ``BaseEnvironment`` contract: ``cwd`` attribute plus
    an ``execute(command, cwd=...)`` method whose return dict carries
    ``output`` and ``returncode``.  Commands are executed in a real
    subdirectory so file system effects match production.
    """

    def __init__(self, start_cwd: str):
        self.cwd = start_cwd
        self.calls: list[dict] = []
        self.local = LocalEnvironment(cwd=start_cwd)

    def cleanup(self):
        self.local.cleanup()

    def execute(self, command: str, cwd: str = None, **kwargs) -> dict:
        self.calls.append({"command": command, "cwd": cwd})
        # Simulate cd by updating self.cwd (the real env does the same
        # via _extract_cwd_from_output after a successful command)
        if command.strip().startswith("cd "):
            new = command.strip()[3:].strip()
            self.cwd = new
            return {"output": "", "returncode": 0}
        # Delegate to the real resolver/environment, rather than arbitrary PATH
        # bash (which can be WSL on Windows). Keep the fake cwd contract above.
        self.local.cwd = self.cwd
        return self.local.execute(command, cwd=cwd or self.cwd, **kwargs)


class TestShellFileOpsCwdTracking:
    """_exec() must use live env.cwd, not the init-time cached cwd."""

    def test_exec_follows_env_cwd_after_cd(self, tmp_path, request):
        dir_a = tmp_path / "a"
        dir_b = tmp_path / "b"
        dir_a.mkdir()
        dir_b.mkdir()
        (dir_a / "target.txt").write_text("content-a\n", encoding="utf-8")
        (dir_b / "target.txt").write_text("content-b\n", encoding="utf-8")

        env = _FakeEnv(start_cwd=str(dir_a))
        request.addfinalizer(env.cleanup)
        ops = ShellFileOperations(env, cwd=str(dir_a))
        assert ops.cwd == str(dir_a)  # init-time

        # Simulate the user running `cd b` in terminal
        env.execute(f"cd {dir_b}")
        assert env.cwd == str(dir_b)
        assert ops.cwd == str(dir_a), "ops.cwd is still init-time (fallback only)"

        # Reading a relative path must now hit dir_b, not dir_a
        result = ops._exec("cat target.txt")
        assert result.exit_code == 0
        assert "content-b" in result.stdout, (
            f"Expected dir_b content, got {result.stdout!r}. "
            "Stale ops.cwd leaked through — _exec must prefer env.cwd."
        )


    def test_env_without_cwd_attribute_falls_back_to_self_cwd(self, tmp_path, request):
        """Backends without a cwd attribute still work via init-time cwd."""
        dir_a = tmp_path / "fixed"
        dir_a.mkdir()
        (dir_a / "target.txt").write_text("fixed-content\n", encoding="utf-8")
        local = LocalEnvironment(cwd=str(dir_a))
        request.addfinalizer(local.cleanup)

        class _NoCwdEnv:
            def execute(self, command, cwd=None, **kwargs):
                return local.execute(command, cwd=cwd, **kwargs)

        env = _NoCwdEnv()
        ops = ShellFileOperations(env, cwd=str(dir_a))
        result = ops._exec("cat target.txt")
        assert result.exit_code == 0
        assert "fixed-content" in result.stdout

    def test_patch_returns_success_only_when_file_actually_written(self, tmp_path, request):
        """Safety rail: patch_replace success must reflect the real file state.

        This test doesn't trigger the bug directly (it would require manual
        corruption of the write), but it pins the invariant: when
        patch_replace returns success=True, the file on disk matches the
        intended content.  If a future write_file change ever regresses,
        this test catches it.
        """
        target = tmp_path / "file.txt"
        target.write_text("old content\n", encoding="utf-8")

        env = _FakeEnv(start_cwd=str(tmp_path))
        request.addfinalizer(env.cleanup)
        ops = ShellFileOperations(env, cwd=str(tmp_path))

        result = ops.patch_replace(str(target), "old content\n", "new content\n")
        assert result.success is True
        assert result.error is None
        assert target.read_text(encoding="utf-8") == "new content\n", (
            "patch_replace claimed success but file wasn't written correctly"
        )
