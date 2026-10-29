"""Session artifacts stay private even under a permissive Windows parent."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

from tools.environments.local import LocalEnvironment
from tools.environments.windows_private_directory import WindowsPrivateDirectory


@pytest.fixture(autouse=True)
def synthetic_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))


def _acl_view(path):
    import win32security

    descriptor = win32security.GetNamedSecurityInfo(
        str(path), win32security.SE_FILE_OBJECT,
        win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION,
    )
    acl = descriptor.GetSecurityDescriptorDacl()
    assert acl is not None
    return (
        win32security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner()),
        tuple((acl.GetAce(i)[0], acl.GetAce(i)[1],
               win32security.ConvertSidToStringSid(acl.GetAce(i)[2]))
              for i in range(acl.GetAceCount())),
    )


def _permissive_parent(tmp_path):
    parent = tmp_path / "permissive-staging"
    parent.mkdir()
    if os.name == "nt":
        import ntsecuritycon
        import win32security

        owner, _ = _acl_view(parent)
        acl = win32security.ACL()
        for sid in (owner, "S-1-5-11", "S-1-5-32-545"):
            acl.AddAccessAllowedAceEx(
                win32security.ACL_REVISION, 3, ntsecuritycon.FILE_ALL_ACCESS,
                win32security.ConvertStringSidToSid(sid),
            )
        descriptor = win32security.SECURITY_DESCRIPTOR()
        descriptor.SetSecurityDescriptorDacl(True, acl, False)
        win32security.SetFileSecurity(
            str(parent), win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION, descriptor
        )
    return parent


def _assert_private(path):
    if os.name == "nt":
        owner, grants = _acl_view(path)
        assert grants and all(grant[2] == owner for grant in grants), grants
    else:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def _chosen_environment(parent):
    class ChosenEnvironment(LocalEnvironment):
        def get_temp_dir(self):
            if os.name == "nt":
                return self._private_windows_temp_dir(parent)
            return parent.as_posix()
    return ChosenEnvironment


def test_private_before_bootstrap_and_after_atomic_updates(tmp_path, monkeypatch):
    parent = _permissive_parent(tmp_path)
    original_parent_acl = _acl_view(parent) if os.name == "nt" else None
    real_run = LocalEnvironment._run_bash
    before_bootstrap = []

    def observe_run(self, command, **kwargs):
        if not self._snapshot_ready:
            assert not Path(self._snapshot_path).exists()
            if os.name == "nt":
                private = self._windows_snapshot_private
                private._verify()
                assert list(private.path.iterdir()) == []
                owner, grants = _acl_view(private.path)
                assert all(grant[2] == owner for grant in grants)
            before_bootstrap.append(True)
        return real_run(self, command, **kwargs)

    monkeypatch.setattr(LocalEnvironment, "_run_bash", observe_run)
    env = _chosen_environment(parent)(cwd=str(parent), timeout=15)
    try:
        assert before_bootstrap == [True]
        snapshot = Path(env._snapshot_path)
        _assert_private(snapshot)
        previous_inode = snapshot.stat().st_ino
        first = env.execute("export SYNTHETIC_SESSION_VALUE=first; echo ready")
        assert first["returncode"] == 0, first
        _assert_private(snapshot)
        assert snapshot.stat().st_ino != previous_inode
        second = env.execute('echo "$SYNTHETIC_SESSION_VALUE"; export SYNTHETIC_SESSION_VALUE=second')
        assert second["returncode"] == 0 and "first" in second["output"], second
        _assert_private(snapshot)
        assert "second" in snapshot.read_text(encoding="utf-8")
        assert not Path(env._cwd_file).exists()
        if os.name == "nt":
            assert _acl_view(parent) == original_parent_acl
            assert {"S-1-5-11", "S-1-5-32-545"} <= {grant[2] for grant in original_parent_acl[1]}
    finally:
        env.cleanup()
    assert not snapshot.exists()


def test_protection_denial_happens_before_bootstrap(tmp_path, monkeypatch):
    from tools.environments import windows_private_directory as private_mod

    calls = []
    def denied(*args, **kwargs):
        raise PermissionError("synthetic privacy denial")
    monkeypatch.setattr(private_mod, "WindowsPrivateDirectory", denied)
    monkeypatch.setattr(LocalEnvironment, "_run_bash", lambda *args, **kwargs: calls.append(True))

    class ProtectedEnvironment(LocalEnvironment):
        def get_temp_dir(self):
            return self._private_windows_temp_dir(tmp_path)
    with pytest.raises(PermissionError, match="synthetic privacy denial"):
        ProtectedEnvironment(cwd=str(tmp_path))
    assert calls == []
    assert list(tmp_path.glob("session-*")) == []
    if os.name == "nt":
        import ntsecuritycon
        import win32security

        captured = []
        real_verify = WindowsPrivateDirectory._verify
        def tampered_acl(self):
            captured.append(self)
            descriptor = win32security.SECURITY_DESCRIPTOR()
            acl = win32security.ACL()
            for sid in (self._owner_sid, "S-1-5-11"):
                acl.AddAccessAllowedAceEx(
                    win32security.ACL_REVISION, 3, ntsecuritycon.FILE_ALL_ACCESS,
                    win32security.ConvertStringSidToSid(sid),
                )
            descriptor.SetSecurityDescriptorDacl(True, acl, False)
            win32security.SetFileSecurity(
                str(self.path), win32security.DACL_SECURITY_INFORMATION |
                win32security.PROTECTED_DACL_SECURITY_INFORMATION, descriptor,
            )
            real_verify(self)
        monkeypatch.setattr(WindowsPrivateDirectory, "_verify", tampered_acl)
        with pytest.raises(PermissionError, match="protected owner-only DACL"):
            WindowsPrivateDirectory(tmp_path, prefix="verify-")
        assert captured[0]._handle is None
        assert not captured[0].path.exists()
        assert calls == []


def test_partial_initialization_releases_owned_directory(tmp_path, monkeypatch):
    from tools.environments import windows_private_directory as private_mod

    closed = []
    class FakePrivateDirectory:
        def __init__(self, parent, prefix):
            self.path = parent / "owned-private"
            self.path.mkdir()
        def close(self):
            closed.append(True)
            self.path.rmdir()
    monkeypatch.setattr(private_mod, "WindowsPrivateDirectory", FakePrivateDirectory)
    def fail_bootstrap(self):
        raise RuntimeError("synthetic construction failure")
    monkeypatch.setattr(LocalEnvironment, "init_session", fail_bootstrap)
    class ProtectedEnvironment(LocalEnvironment):
        def get_temp_dir(self):
            return self._private_windows_temp_dir(tmp_path)
    with pytest.raises(RuntimeError, match="synthetic construction failure"):
        ProtectedEnvironment(cwd=str(tmp_path))
    assert closed == [True]
    assert not (tmp_path / "owned-private").exists()


def test_private_namespace_pin_is_released_by_cleanup(tmp_path):
    parent = _permissive_parent(tmp_path)
    env = _chosen_environment(parent)(cwd=str(parent), timeout=15)
    snapshot = Path(env._snapshot_path)
    moved = parent.with_name("permissive-staging-moved")
    try:
        _assert_private(snapshot)
        if os.name == "nt":
            try:
                parent.rename(moved)
            except OSError as error:
                assert error.winerror in (5, 32), error
            else:
                moved.rename(parent)
                pytest.fail("private snapshot namespace moved while pinned")
    finally:
        env.cleanup()
    assert not snapshot.exists()
    parent.rename(moved)
    moved.rename(parent)


def test_cleanup_preserves_external_link_target(tmp_path):
    target = tmp_path / "external-target"
    target.mkdir()
    sentinel = target / "keep.txt"
    sentinel.write_text("synthetic external data", encoding="utf-8")
    parent = tmp_path / "staging"
    parent.mkdir()
    if os.name == "nt":
        with WindowsPrivateDirectory(parent) as private:
            result = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(private.path / "link"), str(target)],
                stdin=subprocess.DEVNULL, capture_output=True, text=True,
            )
            assert result.returncode == 0, result.stderr
            (private.path / "owned.txt").write_text("synthetic staged data")
        assert not private.path.exists()
    else:
        import tempfile
        with tempfile.TemporaryDirectory(dir=parent) as private:
            (Path(private) / "link").symlink_to(target, target_is_directory=True)
            (Path(private) / "owned.txt").write_text("synthetic staged data")
    assert sentinel.read_text(encoding="utf-8") == "synthetic external data"
