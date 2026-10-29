"""Canonical policy/descriptor contracts for outbound WhatsApp content."""

import asyncio
import json
import os
import struct
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from plugins.platforms.whatsapp import media_delivery as delivery


async def collect(frame):
    return b"".join([chunk async for chunk in frame.body()])


def unpack(body):
    length = struct.unpack(">I", body[:4])[0]
    return json.loads(body[4:4 + length]), body[4 + length:]


@pytest.fixture
def private_home(tmp_path, monkeypatch):
    home = tmp_path / "synthetic-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(home / "runtime"))
    monkeypatch.setenv("YOUTAB_AGENT_MEDIA_DELIVERY_STRICT", "0")
    return home


def test_default_policy_preserves_cross_workspace_bytes_and_metadata(tmp_path, private_home):
    source = tmp_path / "ordinary-workspace" / "report.pdf"
    source.parent.mkdir()
    source.write_bytes(b"synthetic document")
    with delivery.prepare_media_frame(str(source), "synthetic@s.whatsapp.net", "document", caption="caption", file_name="display.pdf") as frame:
        descriptor = frame.descriptor
        metadata, content = unpack(asyncio.run(collect(frame)))
        assert metadata == {"contract": "youtab.whatsapp.media", "version": 1, "chatId": "synthetic@s.whatsapp.net", "byteLength": 18, "attachmentName": "report.pdf", "mediaType": "document", "caption": "caption", "fileName": "display.pdf"}
        assert content == source.read_bytes()
    with pytest.raises(OSError):
        os.fstat(descriptor)


def test_policy_denial_never_opens_or_reads_credential_fixture(tmp_path, private_home, monkeypatch):
    source = private_home / ".ssh" / "synthetic-key"
    source.parent.mkdir()
    source.write_bytes(b"DO-NOT-READ-SYNTHETIC")
    calls = []
    monkeypatch.setattr(delivery.os, "open", lambda *args: calls.append(args))
    with pytest.raises(PermissionError, match="not authorized"):
        with delivery.prepare_media_frame(str(source), "synthetic", "document"):
            pytest.fail("denied attachment admitted")
    assert calls == []


def test_strict_policy_and_explicit_allow_root_remain_authoritative(tmp_path, private_home, monkeypatch):
    source = tmp_path / "workspace" / "artifact.txt"
    source.parent.mkdir()
    source.write_bytes(b"allowed")
    monkeypatch.setenv("YOUTAB_AGENT_MEDIA_DELIVERY_STRICT", "1")
    monkeypatch.setenv("YOUTAB_AGENT_MEDIA_TRUST_RECENT_FILES", "0")
    monkeypatch.delenv("YOUTAB_AGENT_MEDIA_ALLOW_DIRS", raising=False)
    with pytest.raises(PermissionError):
        with delivery.prepare_media_frame(str(source), "synthetic", "document"):
            pytest.fail("strict denial admitted")
    monkeypatch.setenv("YOUTAB_AGENT_MEDIA_ALLOW_DIRS", str(source.parent))
    with delivery.prepare_media_frame(str(source), "synthetic", "document") as frame:
        assert unpack(asyncio.run(collect(frame)))[1] == b"allowed"


def test_size_limit_is_exact_and_rejects_oversize_before_open(tmp_path, private_home, monkeypatch):
    source = tmp_path / "size.dat"
    source.write_bytes(b"1234")
    with delivery.prepare_media_frame(str(source), "synthetic", "document", max_bytes=4) as frame:
        assert unpack(asyncio.run(collect(frame)))[1] == b"1234"
    calls = []
    monkeypatch.setattr(delivery.os, "open", lambda *args: calls.append(args))
    with pytest.raises(ValueError, match="configured"):
        with delivery.prepare_media_frame(str(source), "synthetic", "document", max_bytes=3):
            pytest.fail("oversize admitted")
    assert calls == []


def test_replaced_descriptor_is_rejected_before_any_byte_read(tmp_path, private_home, monkeypatch):
    source, other = tmp_path / "allowed.dat", tmp_path / "other.dat"
    source.write_bytes(b"allowed")
    other.write_bytes(b"OUTSIDE-SYNTHETIC-BYTES")
    real_open = os.open
    reads = []
    monkeypatch.setattr(delivery.os, "open", lambda _path, flags: real_open(other, flags))
    monkeypatch.setattr(delivery.os, "read", lambda *args: reads.append(args))
    with pytest.raises(PermissionError, match="changed"):
        with delivery.prepare_media_frame(str(source), "synthetic", "document"):
            pytest.fail("wrong descriptor admitted")
    assert reads == []


def test_replaced_entry_during_stream_prevents_successful_eof(tmp_path, private_home):
    source = tmp_path / "race.dat"
    source.write_bytes(b"first")
    async def exercise(frame):
        stream = frame.body()
        await anext(stream)  # metadata; no file bytes consumed yet
        replacement = tmp_path / "replacement"
        replacement.write_bytes(b"second")
        try:
            os.replace(replacement, source)
        except PermissionError:
            # Native Windows pins the opened entry against deletion/replacement.
            assert os.name == "nt"
            assert source.read_bytes() == b"first"
            assert await anext(stream) == b"first"
            with pytest.raises(StopAsyncIteration):
                await anext(stream)
            await stream.aclose()
            return False
        with pytest.raises(PermissionError, match="changed|escaped"):
            await anext(stream)
        await stream.aclose()
        return True
    with delivery.prepare_media_frame(str(source), "synthetic", "document") as frame:
        replaced = asyncio.run(exercise(frame))
    assert source.read_bytes() == (b"second" if replaced else b"first")


def test_interrupted_stream_closes_only_its_owned_descriptor(tmp_path, private_home):
    source = tmp_path / "interrupted.dat"
    source.write_bytes(b"synthetic")
    async def interrupt(frame):
        stream = frame.body()
        await anext(stream)
        await stream.aclose()
    with delivery.prepare_media_frame(str(source), "synthetic", "document") as frame:
        descriptor = frame.descriptor
        asyncio.run(interrupt(frame))
    with pytest.raises(OSError):
        os.fstat(descriptor)
    assert source.read_bytes() == b"synthetic"


@pytest.mark.parametrize("value", ["0", "-1", "1.5", "1e6", " 1", "536870913", "unlimited"])
def test_operator_size_config_rejects_invalid_values(value):
    with pytest.raises(ValueError):
        delivery.get_media_max_bytes({"YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES": value})


def test_operator_size_config_default_and_bounds():
    assert delivery.get_media_max_bytes({}) == 128 * 1024 * 1024
    assert delivery.get_media_max_bytes({"YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES": "1"}) == 1
    assert delivery.get_media_max_bytes({"YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES": "536870912"}) == 512 * 1024 * 1024

def test_in_place_growth_after_metadata_aborts_before_content_chunk(tmp_path, private_home):
    source = tmp_path / "changed.dat"
    source.write_bytes(b"first")
    async def exercise(frame):
        stream = frame.body()
        await anext(stream)
        source.write_bytes(b"second-longer")
        with pytest.raises((ValueError, PermissionError), match="declared|limit|changed"):
            await anext(stream)
        await stream.aclose()
    with delivery.prepare_media_frame(str(source), "synthetic", "document") as frame:
        asyncio.run(exercise(frame))


def test_closed_generator_never_reads_reused_fd_denied_canary(tmp_path, private_home):
    source = tmp_path / "authorized.dat"
    source.write_bytes(b"authorized")
    canary = private_home / ".ssh" / "denied-canary"
    canary.parent.mkdir()
    canary.write_bytes(b"DO-NOT-READ-CANARY")
    assert delivery.validate_media_delivery_path(str(canary)) is None
    async def exercise():
        with delivery.prepare_media_frame(str(source), "synthetic", "document") as frame:
            stream = frame.body()
            await anext(stream)
            released = frame.descriptor
        assert frame.closed is True
        assert frame.descriptor is None
        reused = os.open(canary, os.O_RDONLY | getattr(os, "O_BINARY", 0))
        try:
            assert reused == released, "Actual kernel descriptor reuse was required by this regression"
            with pytest.raises(RuntimeError, match="closed"):
                await anext(stream)
            assert os.read(reused, 64) == b"DO-NOT-READ-CANARY", "Suspended producer consumed the unrelated descriptor"
            await stream.aclose()
        finally:
            os.close(reused)
    asyncio.run(exercise())


def test_authorized_alias_keeps_requested_basename_and_extension(tmp_path, private_home, monkeypatch):
    physical = tmp_path / "physical-data.bin"
    physical.write_bytes(b"GIF89a-synthetic")
    alias = tmp_path / "pretty.gif"
    if os.name == "nt":
        # Truthful alias-name seam: Windows file symlinks require privileges.
        # The ordinary physical descriptor/handle is still read on real NTFS.
        original_validator = delivery.validate_media_delivery_path
        assert original_validator(str(physical)) == str(physical)
        monkeypatch.setattr(delivery, "validate_media_delivery_path", lambda requested: str(physical) if requested == str(alias) else original_validator(requested))
    else:
        alias.symlink_to(physical)
    with delivery.prepare_media_frame(str(alias), "synthetic", "image") as frame:
        metadata, content = unpack(asyncio.run(collect(frame)))
    assert metadata["attachmentName"] == "pretty.gif"
    assert metadata["mediaType"] == "image"
    assert content == b"GIF89a-synthetic"


@pytest.mark.asyncio
async def test_cron_health_identity_failure_prevents_attachment_open_and_post(tmp_path, private_home, monkeypatch):
    from plugins.platforms.whatsapp.adapter import _bridge_content_hash
    source = tmp_path / "report.txt"
    source.write_bytes(b"authorized report")
    root = Path(__file__).resolve().parents[2] / "scripts/whatsapp-bridge"
    health = {"mediaContract": delivery.MEDIA_CONTRACT, "mediaVersion": 1,
              "mediaMaxBytes": delivery.get_media_max_bytes(), "scriptHash": "old-helper-closure"}
    response = MagicMock(status=200)
    response.json = AsyncMock(return_value=health)
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=response)
    context.__aexit__ = AsyncMock(return_value=False)
    session = MagicMock()
    session.get.return_value = context
    monkeypatch.setattr(delivery, "prepare_media_frame", MagicMock(side_effect=AssertionError("Attachment must not be opened")))
    with pytest.raises(RuntimeError, match="inputs or verified codec"):
        await delivery.post_media_frame(session, "http://127.0.0.1:1", {}, str(source), "synthetic", "document")
    delivery.prepare_media_frame.assert_not_called()
    session.post.assert_not_called()
    health["scriptHash"] = _bridge_content_hash(root)
    monkeypatch.setattr("plugins.platforms.whatsapp.adapter._bridge_codec_matches", lambda value: False)
    with pytest.raises(RuntimeError, match="inputs or verified codec"):
        await delivery.post_media_frame(session, "http://127.0.0.1:1", {}, str(source), "synthetic", "document")
    delivery.prepare_media_frame.assert_not_called()
    session.post.assert_not_called()
