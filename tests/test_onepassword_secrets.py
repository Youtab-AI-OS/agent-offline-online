"""Hermetic tests for the 1Password (`op` CLI) secret source.

We never invoke the real ``op`` binary: ``subprocess.run`` is mocked so the
suite stays fast and offline-safe.  A live resolve is exercised manually via
``youtab secrets onepassword sync`` outside of pytest.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from unittest import mock

import pytest


# Make the worktree importable without depending on the installed wheel.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.secret_sources import onepassword as op  # noqa: E402


def test_shared_disk_cache_is_private_and_retains_schema(tmp_path):
    from agent.secret_sources._cache import CachedFetch, DiskCache
    from tests.test_bitwarden_secrets import _assert_private_cache

    cache = DiskCache("synthetic-cache.json", key_serializer=lambda key: key)
    entry = CachedFetch(secrets={"K": "synthetic-value"}, fetched_at=time.time())
    cache.write("synthetic-key", entry, 60, tmp_path)
    target = cache.path(tmp_path)
    assert json.loads(target.read_text()) == {
        "key": "synthetic-key", "secrets": {"K": "synthetic-value"},
        "fetched_at": entry.fetched_at,
    }
    _assert_private_cache(target)
    assert cache.read("synthetic-key", 60, tmp_path).secrets == entry.secrets


@pytest.mark.parametrize("point", ["protect", "fsync", "replace"])
def test_shared_disk_cache_failure_preserves_original_and_cleans_stage(tmp_path, monkeypatch, point):
    from agent.secret_sources._cache import CachedFetch, DiskCache
    from youtab_agent_cli import secret_env

    cache = DiskCache("synthetic-cache.json", key_serializer=lambda key: key)
    target = cache.path(tmp_path)
    target.parent.mkdir()
    target.write_bytes(b"synthetic-original-preserved")

    def fail(*args):
        raise PermissionError("synthetic protection failure")

    if point == "protect":
        monkeypatch.setattr(secret_env, "_restrict_stage", fail)
    else:
        monkeypatch.setattr(secret_env.os, point, fail)
    cache.write("synthetic-key", CachedFetch({"K": "fresh"}, time.time()), 60, tmp_path)
    assert target.read_bytes() == b"synthetic-original-preserved"
    assert not list(target.parent.glob(".secret_bytes_*.tmp"))


def test_shared_disk_cache_disabled_does_not_create_file(tmp_path):
    from agent.secret_sources._cache import CachedFetch, DiskCache

    cache = DiskCache("synthetic-cache.json", key_serializer=lambda key: key)
    cache.write("synthetic-key", CachedFetch({"K": "fresh"}, time.time()), 0, tmp_path)
    assert not cache.path(tmp_path).exists()
    assert cache.read("synthetic-key", 0, tmp_path) is None


def test_shared_disk_cache_restricts_existing_bytes_before_accepting(tmp_path):
    from agent.secret_sources._cache import DiskCache
    from tests.test_bitwarden_secrets import _assert_private_cache

    cache = DiskCache("synthetic-cache.json", key_serializer=lambda key: key)
    target = cache.path(tmp_path)
    target.parent.mkdir()
    original = json.dumps({
        "key": "synthetic-key", "secrets": {"K": "legacy"}, "fetched_at": time.time(),
    }).encode("utf-8")
    target.write_bytes(original)  # Ordinary inherited legacy permissions.
    if os.name != "nt":
        target.chmod(0o644)
    assert cache.read("synthetic-key", 60, tmp_path).secrets == {"K": "legacy"}
    assert target.read_bytes() == original
    _assert_private_cache(target)


def test_shared_disk_cache_read_protection_failure_is_miss_and_preserves_bytes(tmp_path, monkeypatch):
    from agent.secret_sources._cache import DiskCache
    from youtab_agent_cli import secret_env

    cache = DiskCache("synthetic-cache.json", key_serializer=lambda key: key)
    target = cache.path(tmp_path)
    target.parent.mkdir()
    original = json.dumps({
        "key": "synthetic-key", "secrets": {"K": "legacy"}, "fetched_at": time.time(),
    }).encode("utf-8")
    target.write_bytes(original)

    def fail(*args):
        raise PermissionError("synthetic existing cache protection failure")

    monkeypatch.setattr(secret_env, "_restrict_stage", fail)
    assert cache.read("synthetic-key", 60, tmp_path) is None
    assert target.read_bytes() == original


def test_existing_cache_writer_handle_obeys_platform_read_contract(tmp_path):
    from agent.secret_sources._cache import DiskCache
    from tests.test_bitwarden_secrets import _assert_private_cache

    cache = DiskCache("synthetic-cache.json", key_serializer=lambda key: key)
    target = cache.path(tmp_path)
    target.parent.mkdir()
    original = json.dumps({
        "key": "synthetic-key", "secrets": {"K": "legacy"}, "fetched_at": time.time(),
    }).encode("utf-8")
    target.write_bytes(original)
    if os.name == "nt":
        import win32con
        import win32file
        import win32security

        info = win32security.DACL_SECURITY_INFORMATION
        before = win32security.ConvertSecurityDescriptorToStringSecurityDescriptor(
            win32security.GetFileSecurity(str(target), info), 1, info,
        )
        writer = win32file.CreateFile(
            str(target), win32con.GENERIC_WRITE,
            win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE | win32con.FILE_SHARE_DELETE,
            None, win32con.OPEN_EXISTING, 0, None,
        )
        try:
            assert cache.read("synthetic-key", 60, tmp_path) is None
            after = win32security.ConvertSecurityDescriptorToStringSecurityDescriptor(
                win32security.GetFileSecurity(str(target), info), 1, info,
            )
            assert after == before
            assert target.read_bytes() == original
        finally:
            writer.Close()
        # Once the incompatible writer closes, owned legacy bytes can migrate.
        assert cache.read("synthetic-key", 60, tmp_path).secrets == {"K": "legacy"}
        _assert_private_cache(target)
    else:
        # POSIX does not provide mandatory Windows file-share denial. Preserve
        # its existing owner/mode contract without claiming old FDs were revoked.
        with target.open("r+b"):
            assert cache.read("synthetic-key", 60, tmp_path).secrets == {"K": "legacy"}
        _assert_private_cache(target)
    assert target.read_bytes() == original


def test_shared_disk_cache_refuses_hardlink_without_modifying_alias(tmp_path):
    from agent.secret_sources._cache import CachedFetch, DiskCache

    cache = DiskCache("synthetic-cache.json", key_serializer=lambda key: key)
    target = cache.path(tmp_path)
    target.parent.mkdir()
    target.write_bytes(b"synthetic-original-preserved")
    outside = tmp_path / "outside"
    os.link(target, outside)
    cache.write("synthetic-key", CachedFetch({"K": "fresh"}, time.time()), 60, tmp_path)
    assert cache.read("synthetic-key", 60, tmp_path) is None
    assert target.read_bytes() == outside.read_bytes() == b"synthetic-original-preserved"
    assert not list(target.parent.glob(".secret_bytes_*.tmp"))


def test_shared_disk_cache_refuses_directory_link(tmp_path):
    from agent.secret_sources._cache import CachedFetch, DiskCache

    home = tmp_path / "home"
    home.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "synthetic-cache.json"
    sentinel.write_bytes(b"synthetic-original-preserved")
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(outside), str(home / "cache"))
    else:
        (home / "cache").symlink_to(outside, target_is_directory=True)
    cache = DiskCache("synthetic-cache.json", key_serializer=lambda key: key)
    cache.write("synthetic-key", CachedFetch({"K": "fresh"}, time.time()), 60, home)
    assert cache.read("synthetic-key", 60, home) is None
    assert sentinel.read_bytes() == b"synthetic-original-preserved"


@pytest.fixture(autouse=True)
def _reset_caches():
    op._reset_cache_for_tests()
    yield
    op._reset_cache_for_tests()


@pytest.fixture(autouse=True)
def _clean_op_env(monkeypatch):
    """Start every test from a known 1Password auth state."""
    for key in list(os.environ):
        if key.startswith("OP_SESSION_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("OP_SERVICE_ACCOUNT_TOKEN", raising=False)
    monkeypatch.delenv("OP_ACCOUNT", raising=False)
    monkeypatch.delenv("OP_CONNECT_HOST", raising=False)
    monkeypatch.delenv("OP_CONNECT_TOKEN", raising=False)
    yield


def _ok(value: str):
    return mock.Mock(returncode=0, stdout=value, stderr="")


def _err(code: int, stderr: str):
    return mock.Mock(returncode=code, stdout="", stderr=stderr)


# ---------------------------------------------------------------------------
# Reference validation
# ---------------------------------------------------------------------------


def test_validate_references_filters_bad_names_and_refs():
    refs = {
        "OPENAI_API_KEY": "op://Private/OpenAI/api key",
        "1BAD_NAME": "op://Private/x/y",          # bad env name
        "HAS SPACE": "op://Private/x/y",          # bad env name
        "NOT_A_REF": "https://example.com",        # not op://
        "WHITESPACE": "  op://Private/z/field  ",  # stripped + kept
    }
    valid, warnings = op._validate_references(refs)
    assert valid == {
        "OPENAI_API_KEY": "op://Private/OpenAI/api key",
        "WHITESPACE": "op://Private/z/field",
    }
    assert len(warnings) == 3


# ---------------------------------------------------------------------------
# fetch_onepassword_secrets
# ---------------------------------------------------------------------------


def test_fetch_happy_path(monkeypatch, tmp_path):
    fake_op = tmp_path / "op"
    fake_op.write_text("", encoding="utf-8")
    values = {
        "op://Private/OpenAI/api key": "sk-abc\n",
        "op://Private/Anthropic/credential": "sk-ant-xyz",
    }

    def fake_run(cmd, **kwargs):
        # argv list, never shell=True; reference passed after `--`.
        assert "--" in cmd
        ref = cmd[cmd.index("--") + 1]
        return _ok(values[ref])

    monkeypatch.setattr(op.subprocess, "run", fake_run)

    secrets, warnings = op.fetch_onepassword_secrets(
        references={
            "OPENAI_API_KEY": "op://Private/OpenAI/api key",
            "ANTHROPIC_API_KEY": "op://Private/Anthropic/credential",
        },
        binary=fake_op,
        use_cache=False,
    )
    assert secrets == {"OPENAI_API_KEY": "sk-abc", "ANTHROPIC_API_KEY": "sk-ant-xyz"}
    assert warnings == []






def test_fetch_read_failure_becomes_warning(monkeypatch, tmp_path):
    fake_op = tmp_path / "op"
    fake_op.write_text("", encoding="utf-8")
    monkeypatch.setattr(
        op.subprocess, "run", lambda *a, **k: _err(1, "\x1b[31m[ERROR] not signed in\x1b[0m")
    )

    secrets, warnings = op.fetch_onepassword_secrets(
        references={"K": "op://V/I/F"}, binary=fake_op, use_cache=False
    )
    assert secrets == {}
    assert len(warnings) == 1
    # ANSI control sequences are fully scrubbed from the surfaced message.
    assert "\x1b" not in warnings[0]
    assert "[31m" not in warnings[0]
    assert "not signed in" in warnings[0]










# ---------------------------------------------------------------------------
# Caching
# ---------------------------------------------------------------------------


def test_inprocess_cache_hit(monkeypatch, tmp_path):
    fake_op = tmp_path / "op"
    fake_op.write_text("", encoding="utf-8")
    calls = {"n": 0}

    def fake_run(*a, **k):
        calls["n"] += 1
        return _ok("v")

    monkeypatch.setattr(op.subprocess, "run", fake_run)
    op._reset_cache_for_tests(tmp_path)
    for _ in range(2):
        op.fetch_onepassword_secrets(
            references={"K": "op://V/I/F"}, cache_ttl_seconds=60,
            binary=fake_op, home_path=tmp_path,
        )
    assert calls["n"] == 1  # second call served from L1 cache








def test_connect_credential_change_invalidates_cache(monkeypatch, tmp_path):
    """A different 1Password Connect identity must not reuse a cached value."""
    fake_op = tmp_path / "op"
    fake_op.write_text("", encoding="utf-8")
    calls = {"n": 0}

    def fake_run(*a, **k):
        calls["n"] += 1
        return _ok("v")

    monkeypatch.setattr(op.subprocess, "run", fake_run)
    op._reset_cache_for_tests(tmp_path)

    monkeypatch.setenv("OP_CONNECT_HOST", "https://connect.example.com")
    monkeypatch.setenv("OP_CONNECT_TOKEN", "tokenA")
    op.fetch_onepassword_secrets(
        references={"K": "op://V/I/F"}, cache_ttl_seconds=300,
        binary=fake_op, home_path=tmp_path,
    )
    # Rotate the Connect token → new identity.
    monkeypatch.setenv("OP_CONNECT_TOKEN", "tokenB")
    op._CACHE.clear()
    op.fetch_onepassword_secrets(
        references={"K": "op://V/I/F"}, cache_ttl_seconds=300,
        binary=fake_op, home_path=tmp_path,
    )
    assert calls["n"] == 2  # cache key changed → refetch






# ---------------------------------------------------------------------------
# find_op
# ---------------------------------------------------------------------------


def test_find_op_pinned_path_not_on_path(tmp_path, monkeypatch):
    pinned = tmp_path / "op"
    pinned.write_text("", encoding="utf-8")
    pinned.chmod(0o755)
    # PATH lookup must NOT be consulted when a binary_path is pinned.
    monkeypatch.setattr(op.shutil, "which", lambda name: "/usr/bin/op")
    assert op.find_op(str(pinned)) == pinned




# ---------------------------------------------------------------------------
# apply_onepassword_secrets
# ---------------------------------------------------------------------------


def test_apply_disabled_returns_empty():
    result = op.apply_onepassword_secrets(enabled=False, env={"K": "op://V/I/F"})
    assert result.ok
    assert not result.applied


def test_apply_missing_binary_sets_error(monkeypatch):
    monkeypatch.setattr(op, "find_op", lambda binary_path="": None)
    result = op.apply_onepassword_secrets(
        enabled=True, env={"K": "op://V/I/F"}
    )
    assert not result.ok
    assert "op CLI" in result.error


def test_apply_sets_env(monkeypatch, tmp_path):
    fake_op = tmp_path / "op"
    fake_op.write_text("", encoding="utf-8")
    monkeypatch.setattr(op, "find_op", lambda binary_path="": fake_op)
    monkeypatch.setattr(op.subprocess, "run", lambda *a, **k: _ok("resolved-val"))
    monkeypatch.delenv("MY_OP_KEY", raising=False)

    result = op.apply_onepassword_secrets(
        enabled=True, env={"MY_OP_KEY": "op://V/I/F"}, cache_ttl_seconds=0,
    )
    assert result.ok
    assert result.applied == ["MY_OP_KEY"]
    assert os.environ["MY_OP_KEY"] == "resolved-val"


def test_apply_skips_before_fetch_when_not_overriding(monkeypatch, tmp_path):
    fake_op = tmp_path / "op"
    fake_op.write_text("", encoding="utf-8")
    monkeypatch.setattr(op, "find_op", lambda binary_path="": fake_op)
    monkeypatch.setenv("MY_OP_KEY", "from-env")
    calls = {"n": 0}

    def fake_run(*a, **k):
        calls["n"] += 1
        return _ok("from-1password")

    monkeypatch.setattr(op.subprocess, "run", fake_run)

    result = op.apply_onepassword_secrets(
        enabled=True, env={"MY_OP_KEY": "op://V/I/F"},
        override_existing=False, cache_ttl_seconds=0,
    )
    assert "MY_OP_KEY" in result.skipped
    assert os.environ["MY_OP_KEY"] == "from-env"
    assert calls["n"] == 0  # never even called op for a value we'd discard


def test_apply_never_overrides_token_var(monkeypatch, tmp_path):
    fake_op = tmp_path / "op"
    fake_op.write_text("", encoding="utf-8")
    monkeypatch.setattr(op, "find_op", lambda binary_path="": fake_op)
    monkeypatch.setenv("OP_SERVICE_ACCOUNT_TOKEN", "original")
    calls = {"n": 0}

    def fake_run(*a, **k):
        calls["n"] += 1
        return _ok("malicious")

    monkeypatch.setattr(op.subprocess, "run", fake_run)

    result = op.apply_onepassword_secrets(
        enabled=True,
        env={"OP_SERVICE_ACCOUNT_TOKEN": "op://V/I/F"},
        override_existing=True, cache_ttl_seconds=0,
    )
    assert "OP_SERVICE_ACCOUNT_TOKEN" in result.skipped
    assert os.environ["OP_SERVICE_ACCOUNT_TOKEN"] == "original"
    assert calls["n"] == 0




