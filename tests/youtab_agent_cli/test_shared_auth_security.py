"""Shared OAuth stores restrict synthetic tokens before staging and publication."""

import json
import os
import subprocess

import pytest

from tests.youtab_agent_cli.test_auth_youtab_provider import _assert_private_shared_store
from youtab_agent_cli import auth, secret_env


@pytest.fixture
def target(tmp_path, monkeypatch):
    monkeypatch.setenv("YOUTAB_AGENT_SHARED_AUTH_DIR", str(tmp_path / "shared"))
    return auth._youtab_shared_store_path()


def _state():
    return {
        "access_token": ' synthetic "quoted" café \\ access ',
        "refresh_token": ' synthetic "quoted" 完了 \\ refresh ',
    }


def test_shared_stage_is_private_while_empty_and_final_json_roundtrips(target, monkeypatch):
    original = secret_env._restrict_stage
    observed = []

    def protect(path, fd):
        assert os.fstat(fd).st_size == path.stat().st_size == 0
        original(path, fd)
        _assert_private_shared_store(path)
        observed.append(path)

    monkeypatch.setattr(secret_env, "_restrict_stage", protect)
    auth._write_shared_youtab_state(_state())
    assert len(observed) == 1
    assert not observed[0].exists()
    _assert_private_shared_store(target)
    loaded = auth._read_shared_youtab_state()
    for key, value in _state().items():
        assert loaded[key] == value
    assert not list(target.parent.glob("*.tmp.*"))


@pytest.mark.parametrize("point", ["protect", "fsync", "replace"])
def test_shared_write_failures_keep_original_and_clean_stage(target, monkeypatch, point):
    target.parent.mkdir()
    original_bytes = b'{"synthetic_original": true}'
    target.write_bytes(original_bytes)

    def fail(*args):
        if point == "protect":
            assert args[0].stat().st_size == 0
        raise PermissionError("synthetic stage failure")

    if point == "protect":
        monkeypatch.setattr(secret_env, "_restrict_stage", fail)
    else:
        monkeypatch.setattr(auth.os, point, fail)
    auth._write_shared_youtab_state(_state())
    assert target.read_bytes() == original_bytes
    assert not list(target.parent.glob("*.tmp.*"))


def test_shared_target_identity_change_preserves_competing_file(target, monkeypatch):
    target.parent.mkdir()
    target.write_bytes(b"original")
    original = secret_env._restrict_stage

    def compete(path, fd):
        original(path, fd)
        competing = target.parent / "competing"
        competing.write_bytes(b"competing-preserved")
        os.replace(competing, target)

    monkeypatch.setattr(secret_env, "_restrict_stage", compete)
    auth._write_shared_youtab_state(_state())
    assert target.read_bytes() == b"competing-preserved"
    assert not list(target.parent.glob("*.tmp.*"))


def test_shared_hardlinked_target_is_denied(target, tmp_path):
    target.parent.mkdir()
    outside = tmp_path / "outside"
    outside.write_bytes(b"outside-preserved")
    os.link(outside, target)
    auth._write_shared_youtab_state(_state())
    assert target.read_bytes() == outside.read_bytes() == b"outside-preserved"
    assert os.path.samestat(target.stat(), outside.stat())


def test_shared_linked_parent_is_denied_before_lock_or_write(tmp_path, monkeypatch):
    actual = tmp_path / "actual"
    actual.mkdir()
    target = actual / auth.YOUTAB_SHARED_STORE_FILENAME
    target.write_bytes(b"outside-preserved")
    linked = tmp_path / "linked"
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(linked), str(actual)],
            capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, result.stderr
    else:
        linked.symlink_to(actual, target_is_directory=True)
    monkeypatch.setenv("YOUTAB_AGENT_SHARED_AUTH_DIR", str(linked))
    try:
        auth._write_shared_youtab_state(_state())
        assert target.read_bytes() == b"outside-preserved"
        assert not (actual / "youtab_auth.lock").exists()
    finally:
        if os.name == "nt":
            os.rmdir(linked)
        else:
            linked.unlink()


@pytest.mark.skipif(os.name != "nt", reason="Native Windows DACL inheritance proof")
def test_permissive_windows_parent_does_not_expose_shared_tokens(target):
    target.parent.mkdir()
    result = subprocess.run(
        [
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "$p=$env:YOUTAB_TEST_ACL_PATH; $acl=Get-Acl -LiteralPath $p; "
            "$acl.SetAccessRuleProtection($true,$false); "
            "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
            "$i=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'; "
            "$n=[System.Security.AccessControl.PropagationFlags]::None; "
            "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$i,$n,'Allow')); "
            "$everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); "
            "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'ReadAndExecute',$i,$n,'Allow')); "
            "Set-Acl -LiteralPath $p -AclObject $acl",
        ],
        env={**os.environ, "YOUTAB_TEST_ACL_PATH": str(target.parent)},
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stderr
    auth._write_shared_youtab_state(_state())
    _assert_private_shared_store(target)
    assert json.loads(target.read_text(encoding="utf-8"))["refresh_token"] == _state()["refresh_token"]
