"""Pairing platform names and redirected files cannot escape synthetic storage."""

import json
import os
import subprocess
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from gateway.pairing import PairingStore, _merge_pairing_dir


@pytest.fixture
def store(tmp_path):
    home = tmp_path / "home"
    with patch("gateway.pairing.PAIRING_DIR", home / "pairing"), patch(
        "gateway.pairing.get_youtab_home", return_value=home
    ):
        return PairingStore()


OPERATIONS = [
    lambda s, p: s.generate_code(p, "synthetic-user"),
    lambda s, p: s.approve_code(p, "ABCDEFGH"),
    lambda s, p: s.approve_request(p, "a" * 16),
    lambda s, p: s._approve_user(p, "synthetic-user"),
    lambda s, p: s.revoke(p, "synthetic-user"),
    lambda s, p: s.is_approved(p, "synthetic-user"),
    lambda s, p: s.list_approved(p),
    lambda s, p: s.list_pending(p),
    lambda s, p: s.clear_pending(p),
    lambda s, p: s._cleanup_expired(p),
    lambda s, p: s._is_locked_out(p),
    lambda s, p: s._record_failed_attempt(p),
    lambda s, p: s._reset_failed_attempts(p),
    lambda s, p: s._is_rate_limited(p, "synthetic-user"),
    lambda s, p: s._record_rate_limit(p, "synthetic-user"),
]


@pytest.mark.parametrize("platform", [
    "../../victim", r"..\..\victim", "/victim", r"C:\victim", "C:victim",
    "//server/share", r"\\server\share", "victim:stream", "\x00", ".", "..",
    "", " telegram", "telegram ", "telegram.", "victim\n", "a/b", r"a\b",
])
@pytest.mark.parametrize("operation", OPERATIONS)
def test_invalid_platform_refused_before_storage(store, platform, operation):
    with patch.object(store, "_load_json") as load, patch.object(store, "_save_json") as save:
        with pytest.raises(ValueError, match="Invalid pairing platform"):
            operation(store, platform)
        load.assert_not_called()
        save.assert_not_called()


@pytest.mark.parametrize("operation", OPERATIONS[:10])
def test_actual_traversal_canaries_preserved(store, tmp_path, operation):
    payload = json.dumps({"expired": {"created_at": time.time() - 7200,
                                       "user_id": "synthetic-user"}})
    canaries = [tmp_path / "victim-pending.json", tmp_path / "victim-approved.json"]
    for canary in canaries:
        canary.write_text(payload, encoding="utf-8")
    before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in canaries}
    with pytest.raises(ValueError):
        operation(store, "../../victim")
    assert {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in canaries} == before


@pytest.mark.parametrize("platform", ["telegram", "whatsapp_cloud", "plugin-test", "plugin.test", "插件"])
def test_valid_platform_round_trip(store, platform):
    with patch("gateway.pairing._sync_allowlist_add"), patch("gateway.pairing._sync_allowlist_remove"):
        code = store.generate_code(platform, "synthetic-user", "Synthetic")
        assert code
        assert store.list_pending(platform)[0]["platform"] == platform
        assert store.approve_code(platform, code)["user_id"] == "synthetic-user"
        assert store.is_approved(platform, "synthetic-user")
        assert store.list_approved(platform)[0]["platform"] == platform
        assert store.revoke(platform, "synthetic-user")
        assert not store.is_approved(platform, "synthetic-user")


def _directory_link(link, target):
    if os.name == "nt":
        subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(target)],
                       check=True, capture_output=True)
    else:
        link.symlink_to(target, target_is_directory=True)


def test_actual_directory_junction_refused(store, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    canary = outside / "telegram-pending.json"
    canary.write_text('{"expired": {"created_at": 0}}', encoding="utf-8")
    before = canary.read_bytes(), canary.stat().st_mtime_ns
    redirected = tmp_path / "redirected"
    _directory_link(redirected, outside)
    with patch("gateway.pairing.PAIRING_DIR", redirected), patch(
        "gateway.pairing._load_json_file"
    ) as load, patch("gateway.pairing._secure_write") as save:
        with pytest.raises(ValueError):
            PairingStore()
        load.assert_not_called()
        save.assert_not_called()
    store._dir = redirected
    with patch.object(store, "_load_json") as load, patch.object(store, "_save_json") as save:
        with pytest.raises(ValueError):
            store._cleanup_expired("telegram")
        load.assert_not_called()
        save.assert_not_called()
    assert (canary.read_bytes(), canary.stat().st_mtime_ns) == before


def test_selected_home_junction_preserves_existing_pairing_data(tmp_path):
    selected_home, real_home = tmp_path / "selected-home", tmp_path / "real-home"
    real_home.mkdir()
    legacy, new = real_home / "pairing", real_home / "platforms" / "pairing"
    legacy.mkdir()
    new.mkdir(parents=True)
    (legacy / "plugin-test-approved.json").write_text(
        json.dumps({"existing-user": {"user_name": "Existing", "approved_at": 123}}), encoding="utf-8"
    )
    (new / "plugin-test-approved.json").write_text(
        json.dumps({"consolidated-user": {"user_name": "Consolidated", "approved_at": 456}}), encoding="utf-8"
    )
    credential_canary = real_home / "synthetic-credentials.json"
    credential_canary.write_text('{"synthetic": "keep-existing-credentials"}', encoding="utf-8")
    chat_canary = real_home / "synthetic-chat.json"
    chat_canary.write_text('{"synthetic": "keep-existing-chat"}', encoding="utf-8")
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (credential_canary, chat_canary)}
    _directory_link(selected_home, real_home)
    with patch("gateway.pairing.PAIRING_DIR", selected_home / "platforms" / "pairing"), patch(
        "gateway.pairing.get_youtab_home", return_value=selected_home
    ), patch("gateway.pairing._sync_allowlist_add"), patch("gateway.pairing._sync_allowlist_remove"):
        store = PairingStore()
        assert store.is_approved("plugin-test", "existing-user")
        assert store.is_approved("plugin-test", "consolidated-user")
        code = store.generate_code("plugin-test", "new-user")
        assert store.approve_code("plugin-test", code)["user_id"] == "new-user"
        assert store.revoke("plugin-test", "new-user")
        assert store.is_approved("plugin-test", "existing-user")
        assert {row["user_id"] for row in store.list_approved()} == {"existing-user", "consolidated-user"}
    assert json.loads((legacy / "plugin-test-approved.json").read_text(encoding="utf-8"))["existing-user"]
    assert {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (credential_canary, chat_canary)} == before


@pytest.mark.parametrize("child", ["pairing", "platforms", "platforms/pairing"])
def test_selected_home_alias_does_not_authorize_child_junction(tmp_path, child):
    selected_home, real_home, outside = (tmp_path / name for name in ("selected", "real", "outside"))
    real_home.mkdir()
    outside.mkdir()
    canary = outside / "plugin-test-approved.json"
    canary.write_text('{"existing-user": {"approved_at": 123}}', encoding="utf-8")
    before = canary.read_bytes(), canary.stat().st_mtime_ns
    _directory_link(selected_home, real_home)
    link = real_home / child
    link.parent.mkdir(parents=True, exist_ok=True)
    _directory_link(link, outside)
    with patch("gateway.pairing.PAIRING_DIR", selected_home / "platforms" / "pairing"), patch(
        "gateway.pairing.get_youtab_home", return_value=selected_home
    ), patch("gateway.pairing._load_json_file") as load, patch("gateway.pairing._secure_write") as save:
        with pytest.raises(ValueError):
            PairingStore()
        load.assert_not_called()
        save.assert_not_called()
    assert (canary.read_bytes(), canary.stat().st_mtime_ns) == before


@pytest.mark.parametrize("filename", ["telegram-pending.json", "telegram-approved.json", "_rate_limits.json"])
def test_redirected_file_refused_on_every_io_boundary(store, tmp_path, filename):
    path = store._dir / filename
    outside = tmp_path / "victim.json"
    outside.write_text('{"synthetic": true}', encoding="utf-8")
    original_resolve = Path.resolve

    def resolve(candidate, *args, **kwargs):
        return outside if candidate == path else original_resolve(candidate, *args, **kwargs)

    with patch.object(Path, "resolve", resolve), patch.object(Path, "read_text") as read, patch(
        "gateway.pairing._secure_write"
    ) as save:
        with pytest.raises(ValueError):
            store._load_json(path)
        with pytest.raises(ValueError):
            store._save_json(path, {})
        read.assert_not_called()
        save.assert_not_called()
    assert outside.read_text(encoding="utf-8") == '{"synthetic": true}'


def test_migration_refuses_redirected_source_before_load(tmp_path):
    active, alternate, outside = (tmp_path / name for name in ("active", "alternate", "outside"))
    active.mkdir()
    alternate.mkdir()
    outside.mkdir()
    source = alternate / "telegram-approved.json"
    source.write_text("{}", encoding="utf-8")
    original_resolve = Path.resolve

    def resolve(candidate, *args, **kwargs):
        return outside / source.name if candidate == source else original_resolve(candidate, *args, **kwargs)

    with patch.object(Path, "resolve", resolve), patch("gateway.pairing._load_json_file") as load:
        with pytest.raises(ValueError):
            _merge_pairing_dir(active, alternate)
        load.assert_not_called()


def test_standalone_migration_does_not_trust_directory_junction(tmp_path):
    active, alternate, outside = (tmp_path / name for name in ("active", "alternate", "outside"))
    active.mkdir()
    outside.mkdir()
    canary = outside / "telegram-approved.json"
    canary.write_text('{"existing-user": {"approved_at": 123}}', encoding="utf-8")
    before = canary.read_bytes(), canary.stat().st_mtime_ns
    _directory_link(alternate, outside)
    with patch("gateway.pairing._load_json_file") as load, patch("gateway.pairing._secure_write") as save:
        with pytest.raises(ValueError):
            _merge_pairing_dir(active, alternate)
        load.assert_not_called()
        save.assert_not_called()
    assert (canary.read_bytes(), canary.stat().st_mtime_ns) == before


def test_discovery_refuses_unsafe_filename_without_storage(store):
    (store._dir / "bad:stream-pending.json").touch() if os.name != "nt" else None
    with patch.object(Path, "iterdir", return_value=iter([store._dir / "bad:stream-pending.json"])), patch.object(
        store, "_load_json"
    ) as load:
        with pytest.raises(ValueError):
            store.list_pending()
        load.assert_not_called()
