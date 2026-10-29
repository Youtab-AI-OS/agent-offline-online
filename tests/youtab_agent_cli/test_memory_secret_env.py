"""Credential writes use isolated synthetic profiles and real filesystem ACLs."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

from plugins.memory.hindsight import HindsightMemoryProvider, _load_simple_env, _materialize_embedded_profile_env
from plugins.memory.mem0._setup import _write_env
from youtab_agent_cli import secret_env
from youtab_agent_cli.config import _parse_env_value
from youtab_agent_cli.memory_setup import _write_env_vars
from youtab_agent_cli import profiles
from youtab_constants import reset_youtab_home_override, set_youtab_home_override


def _assert_private(path):
    if os.name == "nt":
        result = subprocess.run(
            [
                "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                "$acl=Get-Acl -LiteralPath $env:YOUTAB_TEST_ACL_PATH; "
                "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
                "if(-not $acl.AreAccessRulesProtected -or $acl.Access.Count -ne 1) {exit 2}; "
                "$rule=$acl.Access[0]; "
                "if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value "
                "-ne $sid.Value -or $rule.IsInherited -or "
                "$rule.AccessControlType -ne 'Allow' -or "
                "$rule.FileSystemRights -ne 'FullControl') {exit 3}",
            ],
            env={**os.environ, "YOUTAB_TEST_ACL_PATH": str(path)},
            capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, result.stderr
    else:
        info = path.stat()
        assert info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o600


@pytest.mark.parametrize("writer", [_write_env, _write_env_vars, secret_env.write_secret_env])
def test_writers_keep_profile_and_values_without_injected_lines(tmp_path, writer):
    default = tmp_path / "default" / ".env"
    named = tmp_path / "profiles" / "qa" / ".env"
    default.parent.mkdir()
    default.write_bytes(b"DEFAULT=untouched\n")
    named.parent.mkdir(parents=True)
    named.write_bytes("\ufeffexport PROVIDER_KEY=old\n\n# keep café 完了\nOTHER=retain\n".encode())
    value = '  synthetic # café "quoted" \\ key  '
    writer(named, {"PROVIDER_KEY": value, "EXTRA": "safe\nINJECTED=bad\r\u2028\x00tail"})
    text = named.read_text(encoding="utf-8")
    assert text.count("PROVIDER_KEY=") == 1
    assert "\n\n# keep café 完了\nOTHER=retain\n" in text
    assert not text.startswith("\ufeff")
    parsed = _load_simple_env(named)
    assert parsed["PROVIDER_KEY"] == value
    assert parsed["EXTRA"] == "safeINJECTED=badtail"
    assert set(parsed) == {"PROVIDER_KEY", "EXTRA", "OTHER"}
    assert default.read_bytes() == b"DEFAULT=untouched\n"
    _assert_private(named)
    assert not list(named.parent.glob(".env_secret_*"))


@pytest.mark.parametrize("key", ["BAD\nINJECTED", "BAD=KEY", "#BAD", "export KEY", "", "é", 42])
def test_invalid_keys_fail_before_directory_or_file_mutation(tmp_path, key):
    target = tmp_path / "missing" / ".env"
    with pytest.raises(ValueError, match="environment key"):
        secret_env.write_secret_env(target, {key: "synthetic"})
    assert not target.parent.exists()


def test_stage_is_restricted_before_secret_bytes_and_replacement(tmp_path, monkeypatch):
    target = tmp_path / ".env"
    target.write_bytes(b"OLD=unchanged\n")
    original = secret_env._restrict_stage
    observed = []

    def check_stage(path, fd):
        assert path.stat().st_size == 0
        assert target.read_bytes() == b"OLD=unchanged\n"
        original(path, fd)
        _assert_private(path)
        observed.append(path)

    monkeypatch.setattr(secret_env, "_restrict_stage", check_stage)
    secret_env.write_secret_env(target, {"KEY": "synthetic"})
    assert len(observed) == 1
    assert not observed[0].exists()
    assert target.read_bytes() == b"OLD=unchanged\nKEY=synthetic\n"
    _assert_private(target)


@pytest.mark.parametrize("point", ["protect", "fsync", "replace"])
def test_failures_keep_original_file_and_clean_staging(tmp_path, monkeypatch, point):
    target = tmp_path / ".env"
    target.write_bytes(b"ORIGINAL=keep\n")

    def fail(*args):
        raise PermissionError("synthetic protection or filesystem failure")

    if point == "protect":
        monkeypatch.setattr(secret_env, "_restrict_stage", fail)
    else:
        monkeypatch.setattr(secret_env.os, point, fail)
    with pytest.raises(PermissionError):
        secret_env.write_secret_env(target, {"KEY": "synthetic"})
    assert target.read_bytes() == b"ORIGINAL=keep\n"
    assert not list(tmp_path.glob(".env_secret_*"))


def test_replacement_identity_guard_preserves_competing_file(tmp_path, monkeypatch):
    target = tmp_path / ".env"
    target.write_bytes(b"ORIGINAL=keep\n")
    original = secret_env._restrict_stage

    def replace_target(path, fd):
        original(path, fd)
        competing = tmp_path / "competing"
        competing.write_bytes(b"COMPETING=preserve\n")
        os.replace(competing, target)

    monkeypatch.setattr(secret_env, "_restrict_stage", replace_target)
    with pytest.raises(ValueError, match="changed during write"):
        secret_env.write_secret_env(target, {"KEY": "synthetic"})
    assert target.read_bytes() == b"COMPETING=preserve\n"
    assert not list(tmp_path.glob(".env_secret_*"))


def test_directory_and_hardlink_targets_are_denied(tmp_path):
    directory = tmp_path / "directory"
    directory.mkdir()
    outside = tmp_path / "outside"
    outside.write_bytes(b"UNCHANGED\n")
    hardlink = tmp_path / ".env"
    os.link(outside, hardlink)
    for path in (directory, hardlink):
        with pytest.raises(ValueError, match="regular, unlinked"):
            secret_env.write_secret_env(path, {"KEY": "synthetic"})
    assert outside.read_bytes() == hardlink.read_bytes() == b"UNCHANGED\n"


def test_linked_parent_is_denied_without_touching_destination(tmp_path):
    actual = tmp_path / "actual"
    actual.mkdir()
    target = actual / ".env"
    target.write_bytes(b"OUTSIDE=keep\n")
    link = tmp_path / "link"
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(actual)],
            capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, result.stderr
    else:
        link.symlink_to(actual, target_is_directory=True)
    try:
        with pytest.raises(ValueError, match="links or reparse"):
            secret_env.write_secret_env(link / ".env", {"KEY": "synthetic"})
        assert target.read_bytes() == b"OUTSIDE=keep\n"
    finally:
        if os.name == "nt":
            os.rmdir(link)
        else:
            link.unlink()


def test_generated_embedded_env_removes_obsolete_keys_with_exact_values(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    config = {"profile": "synthetic-test", "llm_provider": "openai"}
    key = '  synthetic # "quoted" café \\  '
    path = _materialize_embedded_profile_env(config, llm_api_key=key)
    values = _load_simple_env(path)
    assert values["HINDSIGHT_API_LLM_API_KEY"] == key
    _assert_private(path)
    path.write_text(path.read_text(encoding="utf-8") + "STALE=remove\n", encoding="utf-8")
    _materialize_embedded_profile_env(config, llm_api_key=key)
    assert "STALE" not in _load_simple_env(path)


@pytest.mark.parametrize("value", ["", "unicode 完了 café", "simple", "two words", "quote'\"\\#"])
def test_value_serialization_matches_canonical_reader(tmp_path, value):
    target = tmp_path / ".env"
    secret_env.write_secret_env(target, {"KEY": value})
    written = target.read_text(encoding="utf-8").strip().split("=", 1)[1]
    assert _parse_env_value(written) == value


@pytest.mark.parametrize("provider_name", ["mem0", "hindsight", "generic"])
def test_selected_linked_named_profile_setup_keeps_other_profiles(tmp_path, monkeypatch, provider_name):
    from types import SimpleNamespace
    from youtab_agent_cli import memory_setup
    from plugins.memory.mem0._setup import post_setup

    default = tmp_path / "default"
    default.mkdir()
    (default / ".env").write_bytes(b"DEFAULT=untouched\n")
    profile_root = default / "profiles"
    profile_root.mkdir()
    external = tmp_path / "external-qa"
    external.mkdir()
    sibling = profile_root / "other"
    sibling.mkdir()
    (sibling / ".env").write_bytes(b"OTHER=untouched\n")
    monkeypatch.setattr(profiles, "_get_default_youtab_home", lambda: default)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profile_root)
    selected = profiles.get_profile_dir("qa")
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(selected), str(external)],
            capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, result.stderr
    else:
        selected.symlink_to(external, target_is_directory=True)
    token = set_youtab_home_override(selected)
    monkeypatch.setattr("youtab_agent_cli.config.save_config", lambda config: None)
    try:
        if provider_name == "mem0":
            monkeypatch.setattr("sys.argv", ["youtab", "--mode", "platform", "--api-key", "synthetic-mem0"])
            monkeypatch.setattr("plugins.memory.mem0._setup._prompt", lambda label, default=None, secret=False: default or "")
            post_setup(str(selected), {"memory": {}})
            assert _load_simple_env(external / ".env")["MEM0_API_KEY"] == "synthetic-mem0"
        elif provider_name == "hindsight":
            monkeypatch.setattr(memory_setup, "_curses_select", lambda *args, **kwargs: 0)
            monkeypatch.setattr("builtins.input", lambda *args: "")
            monkeypatch.setattr("sys.stdin.isatty", lambda: True)
            monkeypatch.setattr("getpass.getpass", lambda *args: "synthetic-hindsight")
            monkeypatch.setattr("tools.lazy_deps.install_specs", lambda *args, **kwargs: SimpleNamespace(ok=True))
            HindsightMemoryProvider().post_setup(str(selected), {"memory": {}})
            assert _load_simple_env(external / ".env")["HINDSIGHT_API_KEY"] == "synthetic-hindsight"
        else:
            class Provider:
                def get_config_schema(self):
                    return [{"key": "api_key", "description": "Synthetic", "env_var": "SYNTHETIC_API_KEY", "secret": True, "required": True}]

            monkeypatch.setattr(memory_setup, "_get_available_providers", lambda: [("synthetic", "local", Provider())])
            monkeypatch.setattr(memory_setup, "_curses_select", lambda *args, **kwargs: 0)
            monkeypatch.setattr(memory_setup, "_install_dependencies", lambda *args: None)
            monkeypatch.setattr(memory_setup, "_prompt", lambda *args, **kwargs: "synthetic-generic")
            monkeypatch.setattr("youtab_agent_cli.config.load_config", lambda: {"memory": {}})
            memory_setup.cmd_setup(SimpleNamespace())
            assert _load_simple_env(external / ".env")["SYNTHETIC_API_KEY"] == "synthetic-generic"
        _assert_private(external / ".env")
        assert (default / ".env").read_bytes() == b"DEFAULT=untouched\n"
        assert (sibling / ".env").read_bytes() == b"OTHER=untouched\n"
        with pytest.raises(ValueError, match="links or reparse"):
            secret_env.write_secret_env(selected / ".env", {"ARBITRARY": "denied"})
    finally:
        reset_youtab_home_override(token)
        if os.name == "nt":
            os.rmdir(selected)
        else:
            selected.unlink()


def test_hindsight_blank_to_keep_preserves_quoted_key_in_both_files(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from youtab_agent_cli import memory_setup

    profile = tmp_path / "selected"
    profile.mkdir()
    user_home = tmp_path / "user-home"
    user_home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: user_home)
    key = '  synthetic # "quoted" café \\ key  '
    secret_env.write_secret_env(profile / ".env", {"HINDSIGHT_LLM_API_KEY": key})
    selections = iter([1, 0])
    monkeypatch.setattr(memory_setup, "_curses_select", lambda *args, **kwargs: next(selections))
    monkeypatch.setattr("shutil.which", lambda name: None)
    monkeypatch.setattr("builtins.input", lambda *args: "")
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("getpass.getpass", lambda *args: "")
    monkeypatch.setattr("tools.lazy_deps.install_specs", lambda *args, **kwargs: SimpleNamespace(ok=True))
    monkeypatch.setattr("youtab_agent_cli.config.save_config", lambda config: None)
    HindsightMemoryProvider().post_setup(str(profile), {"memory": {}})
    assert _load_simple_env(profile / ".env")["HINDSIGHT_LLM_API_KEY"] == key
    generated = user_home / ".hindsight" / "profiles" / "youtab.env"
    assert _load_simple_env(generated)["HINDSIGHT_API_LLM_API_KEY"] == key
    _assert_private(profile / ".env")
    _assert_private(generated)


@pytest.mark.parametrize("writer", [_write_env, _write_env_vars])
def test_selected_profile_cannot_authorize_another_env_filename(tmp_path, writer):
    selected = tmp_path / "selected"
    selected.mkdir()
    other = tmp_path / "other.env"
    other.write_bytes(b"OTHER=untouched\n")
    with pytest.raises(ValueError, match="selected profile home"):
        writer(other, {"KEY": "synthetic"}, profile_home=selected)
    assert other.read_bytes() == b"OTHER=untouched\n"
    assert not (selected / ".env").exists()


def test_authorized_profile_still_denies_linked_env_leaf(tmp_path):
    selected = tmp_path / "selected"
    selected.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel"
    sentinel.write_bytes(b"OUTSIDE=untouched\n")
    linked_leaf = selected / ".env"
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(linked_leaf), str(outside)],
            capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, result.stderr
    else:
        linked_leaf.symlink_to(sentinel)
    try:
        with pytest.raises(ValueError, match="links or reparse"):
            secret_env.write_profile_secret_env(selected, {"KEY": "synthetic"})
        assert sentinel.read_bytes() == b"OUTSIDE=untouched\n"
    finally:
        if os.name == "nt":
            os.rmdir(linked_leaf)
        else:
            linked_leaf.unlink()
