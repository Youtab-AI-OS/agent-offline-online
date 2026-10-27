"""Real filesystem protection and atomicity of synthetic backup credentials."""

from argparse import Namespace
import os
from pathlib import Path
import stat
import subprocess
import zipfile

import pytest

from youtab_agent_cli import backup, secret_env


def _assert_private(path):
    if os.name == "nt":
        command = (
            "$ErrorActionPreference='Stop'; "
            "$acl=Get-Acl -LiteralPath $env:YOUTAB_TEST_ACL_PATH -ErrorAction Stop; "
            "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
            "if(-not $acl.AreAccessRulesProtected -or $acl.Access.Count -ne 1) {exit 2}; "
            "$rule=$acl.Access[0]; "
            "if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value "
            "-ne $sid.Value -or $rule.IsInherited -or "
            "$rule.AccessControlType -ne 'Allow' -or "
            "$rule.FileSystemRights -ne 'FullControl') {exit 3}"
        )
        environment = {
            key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"
        }
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            env={**environment, "YOUTAB_TEST_ACL_PATH": str(path)},
            capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, result.stderr
    else:
        info = path.stat()
        assert info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o600


@pytest.fixture
def storage(tmp_path, monkeypatch):
    home = tmp_path / "synthetic-home"
    root = home / "runtime"
    root.mkdir(parents=True)
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(root))
    monkeypatch.setattr(Path, "home", lambda: home)
    return home, root


def _archive(tmp_path, members):
    archive = tmp_path / "synthetic-backup.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("config.yaml", b"model: {}\n")
        for name, content in members.items():
            zf.writestr(name, content)
    return Namespace(zipfile=str(archive), force=True)


def _target(storage, member):
    home, root = storage
    if member.startswith("_external/"):
        return home / member.removeprefix("_external/")
    return root / member


@pytest.mark.parametrize("member", [
    ".env", "auth.json", "state.db", "profiles/synthetic_private_restore/.env",
    "_external/.honcho/config.json", "_external/.provider/secrets.env",
    "_external/.provider/secrets.conf", "_external/.provider/auth.json",
])
def test_import_restricts_empty_stage_before_exact_secret_bytes(storage, tmp_path, monkeypatch, member):
    target = _target(storage, member)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"OLD=untouched\r\n")
    payload = b"SYNTHETIC_KEY=caf\xc3\xa9\r\n\x00\xff"
    real_restrict = secret_env._restrict_stage
    observed = []

    def observe_stage(path, fd):
        assert path.stat().st_size == 0
        assert target.read_bytes() == b"OLD=untouched\r\n"
        real_restrict(path, fd)
        _assert_private(path)
        observed.append(path)

    monkeypatch.setattr(secret_env, "_restrict_stage", observe_stage)
    backup.run_import(_archive(tmp_path, {member: payload}))
    _assert_private(target)
    assert target.read_bytes() == payload
    assert len(observed) == 1
    assert not observed[0].exists()


@pytest.mark.parametrize("member", [".env", "_external/.honcho/config.json"])
@pytest.mark.parametrize("failure", ["protect", "fsync", "replace"])
def test_import_failure_keeps_old_secret_and_cleans_stage(storage, tmp_path, monkeypatch, capsys, member, failure):
    target = _target(storage, member)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"OLD_PRIVATE=untouched\r\n")
    with target.open("rb") as handle:
        secret_env._restrict_stage(target, handle.fileno())
    _assert_private(target)

    def fail(*args):
        raise PermissionError("synthetic restore failure")

    if failure == "protect":
        monkeypatch.setattr(secret_env, "_restrict_stage", fail)
    else:
        monkeypatch.setattr(secret_env.os, failure, fail)
    backup.run_import(_archive(tmp_path, {member: b"NEW_PRIVATE=synthetic\n"}))
    assert target.read_bytes() == b"OLD_PRIVATE=untouched\r\n"
    _assert_private(target)
    assert not list(target.parent.glob(".secret_bytes_*"))
    assert "synthetic restore failure" in capsys.readouterr().out


@pytest.mark.parametrize("member", [".ENV", "AUTH.JSON", "_external/.provider/SECRETS.JSON"])
def test_case_aliases_follow_actual_platform_classification(storage, tmp_path, monkeypatch, member):
    target = _target(storage, member)
    target.parent.mkdir(parents=True, exist_ok=True)
    initial = target.with_name(target.name.casefold())
    initial.write_bytes(b"OLD=keep\n")
    payload = b"SYNTHETIC=new\r\n"
    real_restrict = secret_env._restrict_stage
    observed = []

    def observe_stage(path, fd):
        assert path.stat().st_size == 0
        assert initial.read_bytes() == b"OLD=keep\n"
        real_restrict(path, fd)
        _assert_private(path)
        observed.append(path)

    monkeypatch.setattr(secret_env, "_restrict_stage", observe_stage)
    backup.run_import(_archive(tmp_path, {member: payload}))
    assert target.read_bytes() == payload
    if os.name == "nt":
        _assert_private(target)
        assert len(observed) == 1
    else:
        assert len(observed) == 0
        assert initial.read_bytes() == b"OLD=keep\n"
    assert not list(target.parent.glob(".secret_bytes_*"))


@pytest.mark.parametrize("member", ["auth.json", "_external/.honcho/config.json"])
def test_import_rejects_hardlinked_secret_without_mutating_other_path(storage, tmp_path, capsys, member):
    target = _target(storage, member)
    target.parent.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "unrelated-secret"
    outside.write_bytes(b"UNRELATED=preserve\n")
    os.link(outside, target)
    backup.run_import(_archive(tmp_path, {member: b"ATTACKER=synthetic\n"}))
    assert outside.read_bytes() == b"UNRELATED=preserve\n"
    assert target.read_bytes() == b"UNRELATED=preserve\n"
    assert not list(target.parent.glob(".secret_bytes_*"))
    assert "unlinked file" in capsys.readouterr().out


def _directory_link(link, target):
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, result.stderr
    else:
        link.symlink_to(target, target_is_directory=True)


def _remove_directory_link(link):
    if os.name == "nt":
        os.rmdir(link)
    else:
        link.unlink()


@pytest.mark.parametrize("external", [False, True])
@pytest.mark.parametrize("outside", [False, True])
def test_import_rejects_linked_secret_ancestors_inside_or_outside_scope(storage, tmp_path, capsys, external, outside):
    home, root = storage
    boundary = home if external else root
    destination = tmp_path / "outside" if outside else boundary / "unrelated"
    destination.mkdir(parents=True)
    sentinel = destination / "auth.json"
    sentinel.write_bytes(b"UNRELATED=keep\n")
    link = boundary / "linked"
    _directory_link(link, destination)
    member = "_external/linked/auth.json" if external else "linked/auth.json"
    try:
        backup.run_import(_archive(tmp_path, {member: b"ATTACKER=synthetic\n"}))
        assert sentinel.read_bytes() == b"UNRELATED=keep\n"
        assert not list(destination.glob(".secret_bytes_*"))
        output = capsys.readouterr().out
        assert ("path traversal blocked" if outside else "links or reparse") in output
    finally:
        _remove_directory_link(link)


def test_import_allows_only_selected_root_link_and_preserves_raw_bytes(storage, tmp_path, monkeypatch):
    home, root = storage
    link = home / "selected-root"
    _directory_link(link, root)
    try:
        monkeypatch.setenv("YOUTAB_AGENT_HOME", str(link))
        backup.run_import(_archive(tmp_path, {".env": b"SYNTHETIC=raw\r\n\x00"}))
        assert (root / ".env").read_bytes() == b"SYNTHETIC=raw\r\n\x00"
        _assert_private(root / ".env")
    finally:
        _remove_directory_link(link)


def test_import_nonsensitive_files_keep_original_exact_bytes(storage, tmp_path, monkeypatch):
    _, root = storage
    payload = b"NONSECRET\x00\xff\r\n"

    def unexpected_private_stage(*args):
        pytest.fail("Nonsensitive files must retain their existing classification")

    monkeypatch.setattr(secret_env, "_restrict_stage", unexpected_private_stage)
    members = {"notes/output.bin": payload, "config.json": payload, "_external/cache.bin": payload}
    backup.run_import(_archive(tmp_path, members))
    for relative in ("notes/output.bin", "config.json"):
        assert (root / relative).read_bytes() == payload
    assert (storage[0] / "cache.bin").read_bytes() == payload
