"""Tests for utils.atomic_json_write — crash-safe JSON file writes."""

import errno
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import utils
from utils import atomic_json_write


class TestAtomicJsonWrite:
    """Core atomic write behavior."""







    def test_cleans_up_temp_file_on_baseexception(self, tmp_path):
        class SimulatedAbort(BaseException):
            pass

        target = tmp_path / "data.json"
        original = {"preserved": True}
        target.write_text(json.dumps(original), encoding="utf-8")

        with patch("utils.json.dump", side_effect=SimulatedAbort):
            with pytest.raises(SimulatedAbort):
                atomic_json_write(target, {"new": True})

        tmp_files = [f for f in tmp_path.iterdir() if ".tmp" in f.name]
        assert len(tmp_files) == 0
        assert json.loads(target.read_text(encoding="utf-8")) == original




    def test_mode_does_not_crash_without_fchmod(self, tmp_path):
        """Regression: os.fchmod is Unix-only and absent on Windows. Passing a
        mode must not raise AttributeError when fchmod is unavailable.

        Simulates the Windows os module by removing fchmod from the namespace.
        Previously this crashed in `youtab memory setup` while saving the
        Hindsight config with mode=0o600 (GitHub: Windows setup traceback).
        """
        import utils

        target = tmp_path / "secret.json"
        no_fchmod = {k: getattr(os, k) for k in dir(os) if k != "fchmod"}
        fake_os = type("FakeOs", (), no_fchmod)
        assert not hasattr(fake_os, "fchmod")

        with patch.object(utils, "os", fake_os):
            atomic_json_write(target, {"api_key": "secret"}, mode=0o600)

        assert json.loads(target.read_text(encoding="utf-8")) == {"api_key": "secret"}


    def test_concurrent_writes_dont_corrupt(self, tmp_path):
        """Every concurrent write succeeds and leaves a complete JSON file."""
        import threading

        target = tmp_path / "concurrent.json"
        errors = []
        completed = []

        def writer(n):
            for turn in range(20):
                try:
                    atomic_json_write(
                        target, {"writer": n, "turn": turn, "data": list(range(100))}
                    )
                    completed.append((n, turn))
                except Exception as e:
                    errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert not any(t.is_alive() for t in threads)
        assert not errors
        assert len(completed) == 200
        # File should contain valid JSON from one of the writers
        result = json.loads(target.read_text(encoding="utf-8"))
        assert "writer" in result
        assert len(result["data"]) == 100
        assert not list(tmp_path.glob("*.tmp"))

    @pytest.mark.parametrize("winerror", [5, 32, 33])
    def test_retries_transient_windows_replace_denial(self, tmp_path, monkeypatch, winerror):
        target = tmp_path / "data.json"
        target.write_text('{"old": true}', encoding="utf-8")
        real_replace = os.replace
        calls = []
        sleeps = []
        error = PermissionError(errno.EACCES, "temporary sharing conflict")
        error.winerror = winerror

        def replace(source, destination):
            calls.append((source, destination))
            if len(calls) <= 2:
                raise error
            return real_replace(source, destination)

        fake_os = SimpleNamespace(**{**vars(os), "name": "nt", "replace": replace})
        monkeypatch.setattr(utils, "os", fake_os)
        monkeypatch.setattr(
            utils, "time", SimpleNamespace(monotonic=utils.time.monotonic, sleep=sleeps.append)
        )
        atomic_json_write(target, {"new": True})

        assert len(calls) == 3
        assert sleeps == [0.01, 0.01]
        assert json.loads(target.read_text(encoding="utf-8")) == {"new": True}
        assert not list(tmp_path.glob("*.tmp"))

    def test_persistent_windows_denial_preserves_target_and_raises(self, tmp_path, monkeypatch):
        target = tmp_path / "data.json"
        target.write_text('{"old": true}', encoding="utf-8")
        error = PermissionError(errno.EACCES, "permanent access denial")
        error.winerror = 5
        calls = []
        sleeps = []
        clock = iter([0.0, 0.2, 0.4, 1.0])

        def replace(source, destination):
            calls.append((source, destination))
            raise error

        def unexpected_copy(*args, **kwargs):
            pytest.fail("A permission failure must never use copy fallback")

        fake_os = SimpleNamespace(**{**vars(os), "name": "nt", "replace": replace})
        monkeypatch.setattr(utils, "os", fake_os)
        monkeypatch.setattr(
            utils, "time", SimpleNamespace(monotonic=lambda: next(clock), sleep=sleeps.append)
        )
        monkeypatch.setattr(utils.shutil, "copyfile", unexpected_copy)

        with pytest.raises(PermissionError) as caught:
            atomic_json_write(target, {"new": True})

        assert caught.value is error
        assert len(calls) == 3
        assert sleeps == [0.01, 0.01]
        assert json.loads(target.read_text(encoding="utf-8")) == {"old": True}
        assert not list(tmp_path.glob("*.tmp"))

    @pytest.mark.parametrize("platform,winerror", [("posix", 5), ("nt", 19), ("nt", None)])
    def test_other_permission_failures_are_not_retried(self, tmp_path, monkeypatch, platform, winerror):
        target = tmp_path / "data.json"
        target.write_text('{"old": true}', encoding="utf-8")
        error = PermissionError(errno.EACCES, "access denial")
        error.winerror = winerror
        calls = []

        def replace(source, destination):
            calls.append((source, destination))
            raise error

        def unexpected_sleep(_seconds):
            pytest.fail("Unrecognized or non-Windows errors must fail immediately")

        fake_os = SimpleNamespace(**{**vars(os), "name": platform, "replace": replace})
        monkeypatch.setattr(utils, "os", fake_os)
        monkeypatch.setattr(
            utils, "time", SimpleNamespace(monotonic=utils.time.monotonic, sleep=unexpected_sleep)
        )

        with pytest.raises(PermissionError) as caught:
            atomic_json_write(target, {"new": True})

        assert caught.value is error
        assert len(calls) == 1
        assert json.loads(target.read_text(encoding="utf-8")) == {"old": True}
        assert not list(tmp_path.glob("*.tmp"))

    @pytest.mark.parametrize("code", [errno.EXDEV, errno.EBUSY])
    def test_existing_cross_device_and_busy_fallback(self, tmp_path, monkeypatch, code):
        target = tmp_path / "data.json"
        target.write_text('{"old": true}', encoding="utf-8")

        def replace(source, destination):
            raise OSError(code, "existing fallback condition")

        monkeypatch.setattr(utils.os, "replace", replace)
        atomic_json_write(target, {"new": True})

        assert json.loads(target.read_text(encoding="utf-8")) == {"new": True}
        assert not list(tmp_path.glob("*.tmp"))
