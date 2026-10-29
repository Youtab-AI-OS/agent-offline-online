"""WhatsApp media delivery for send_message (#19105).

Covers two layers:

* ``_bridge_media_type`` — extension/voice/force_document -> bridge mediaType.
* ``_standalone_send`` — text-first then per-file ``/send-media`` uploads,
  media-only (skip ``/send``), and missing-file errors. The bridge HTTP calls
  are mocked at the ``aiohttp.ClientSession`` boundary.
"""

import asyncio
import json
import os
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from plugins.platforms.whatsapp.adapter import _bridge_media_type, _standalone_send, WhatsAppAdapter


# ---------------------------------------------------------------------------
# _bridge_media_type
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path,is_voice,force_document,expected",
    [
        ("a.png", False, False, "image"),
        ("a.JPG", False, False, "image"),
        ("a.jpeg", False, False, "image"),
        ("a.webp", False, False, "image"),
        ("a.gif", False, False, "image"),
        ("a.mp4", False, False, "video"),
        ("a.mov", False, False, "video"),
        ("a.webm", False, False, "video"),
        ("a.ogg", True, False, "audio"),
        ("a.opus", False, False, "audio"),
        ("a.mp3", False, False, "audio"),
        ("a.wav", False, False, "audio"),
        ("a.pdf", False, False, "document"),
        ("a.zip", False, False, "document"),
        # force_document overrides everything
        ("a.png", False, True, "document"),
        ("a.mp4", False, True, "document"),
        # is_voice wins over a video extension
        ("a.mp4", True, False, "audio"),
    ],
)
def test_bridge_media_type(path, is_voice, force_document, expected):
    assert _bridge_media_type(path, is_voice, force_document) == expected


# ---------------------------------------------------------------------------
# _standalone_send — bridge HTTP mocked
# ---------------------------------------------------------------------------


def _resp(status, json_data=None, text_data=None):
    r = AsyncMock()
    r.status = status
    r.json = AsyncMock(return_value=json_data or {})
    r.text = AsyncMock(return_value=text_data or "")
    return r


def _session_with(responses, *, bridge_dir=None, health_override=None):
    """Build a mocked aiohttp.ClientSession that returns *responses* in order
    and records every POST (url, json_payload)."""
    calls = []
    idx = [0]

    def _post(url, **kwargs):
        r = responses[idx[0]] if idx[0] < len(responses) else responses[-1]
        idx[0] += 1
        ctx = MagicMock()
        async def enter():
            payload = kwargs.get("json")
            if "data" in kwargs:
                from plugins.platforms.whatsapp.media_delivery import MEDIA_CONTENT_TYPE
                assert kwargs["headers"]["Content-Type"] == MEDIA_CONTENT_TYPE
                body = b"".join([chunk async for chunk in kwargs["data"]])
                size = int.from_bytes(body[:4], "big")
                payload = json.loads(body[4:4 + size])
                assert body[4 + size:] == b"x"
                assert "filePath" not in payload
            calls.append((url, payload, kwargs.get("headers")))
            return r
        ctx.__aenter__ = AsyncMock(side_effect=enter)
        ctx.__aexit__ = AsyncMock(return_value=False)
        return ctx

    session = MagicMock()
    session.post = MagicMock(side_effect=_post)
    from plugins.platforms.whatsapp.media_delivery import MEDIA_CONTRACT, get_media_max_bytes
    from plugins.platforms.whatsapp.adapter import _bridge_content_hash
    from pathlib import Path
    health_data = {
        "mediaContract": MEDIA_CONTRACT, "mediaVersion": 1, "mediaMaxBytes": get_media_max_bytes(),
        "scriptHash": _bridge_content_hash(bridge_dir or Path(__file__).resolve().parents[2] / "scripts/whatsapp-bridge"),
    }
    health_data.update(health_override or {})
    health = MagicMock()
    health.__aenter__ = AsyncMock(return_value=_resp(200, health_data))
    health.__aexit__ = AsyncMock(return_value=False)
    session.get = MagicMock(return_value=health)
    session_ctx = MagicMock()
    session_ctx.__aenter__ = AsyncMock(return_value=session)
    session_ctx.__aexit__ = AsyncMock(return_value=False)
    return session_ctx, calls


def _pconfig():
    from youtab_constants import get_youtab_dir

    session_path = get_youtab_dir("platforms/whatsapp/session", "whatsapp/session")
    session_path.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(session_path / "bridge-capability", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write("t" * 43)
    return SimpleNamespace(token="", extra={"bridge_port": 3000})


def _tmpfile(suffix):
    f = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    f.write(b"x")
    f.close()
    return f.name


def test_text_plus_mixed_media_routes_native_types():
    img = _tmpfile(".png")
    vid = _tmpfile(".mp4")
    voice = _tmpfile(".ogg")
    try:
        session_ctx, calls = _session_with(
            [
                _resp(200, {"messageId": "t1"}),
                _resp(200, {"messageId": "m1"}),
                _resp(200, {"messageId": "m2"}),
                _resp(200, {"messageId": "m3"}),
            ]
        )
        with patch("aiohttp.ClientSession", return_value=session_ctx):
            res = asyncio.run(
                _standalone_send(
                    _pconfig(),
                    "12345",
                    "hello",
                    media_files=[(img, False), (vid, False), (voice, True)],
                )
            )
        assert res["success"] is True
        assert all(call[2]["Authorization"] == "Bearer " + "t" * 43 for call in calls)
        # text first, then three media uploads in order
        assert calls[0][0].endswith("/send")
        assert calls[0][1]["message"] == "hello"
        media_types = [c[1]["mediaType"] for c in calls if c[0].endswith("/send-media")]
        assert media_types == ["image", "video", "audio"]
        # chat id normalized to a WhatsApp JID
        assert "@" in calls[0][1]["chatId"]
    finally:
        for p in (img, vid, voice):
            os.unlink(p)


def test_missing_captioned_file_falls_back_to_text():
    """If the single captioned file is missing, the caption is delivered as a
    plain /send message rather than being silently lost (W1)."""
    session_ctx, calls = _session_with([_resp(200, {"messageId": "t1"})])
    with patch("aiohttp.ClientSession", return_value=session_ctx):
        res = asyncio.run(
            _standalone_send(
                _pconfig(),
                "12345",
                "",
                media_files=[("/no/such/file.png", False)],
                caption="floor plan",
            )
        )
    # The send still surfaces the missing-file error...
    assert "error" in res
    assert "not found" in res["error"]
    # ...but the caption text was delivered on its own first.
    assert len(calls) == 1
    assert calls[0][0].endswith("/send")
    assert calls[0][1]["message"] == "floor plan"


@pytest.mark.parametrize("configured", [None, ""])
def test_managed_null_or_empty_script_sends_with_default_closure(tmp_path, monkeypatch, configured):
    from gateway.config import PlatformConfig
    bridge = tmp_path / "default-bridge"
    bridge.mkdir()
    (bridge / "bridge.js").write_text("// selected default bridge\n")
    monkeypatch.setattr(WhatsAppAdapter, "_DEFAULT_BRIDGE_DIR", bridge)
    adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra={"bridge_script": configured}))
    assert adapter._bridge_script == str(bridge / "bridge.js")
    # __new__/configuration reload callers may retain the optional spelling.
    adapter._bridge_script = configured
    adapter._session_path = None
    adapter._bridge_capability = "t" * 43
    adapter._running = True
    context, calls = _session_with([_resp(200, {"messageId": "managed"})], bridge_dir=bridge)
    adapter._http_session = context.__aenter__.return_value
    source = tmp_path / "report.pdf"
    source.write_bytes(b"x")
    result = asyncio.run(adapter._send_media_to_bridge("12345", str(source), "document"))
    assert result.success is True, result.error
    assert result.message_id == "managed"
    assert len(calls) == 1
    assert calls[0][1]["attachmentName"] == "report.pdf"
    assert "filePath" not in calls[0][1]


def test_cron_custom_bridge_uses_configured_closure_and_rejects_old_helpers(tmp_path, monkeypatch):
    bridge = tmp_path / "custom-bridge"
    bridge.mkdir()
    (bridge / "bridge.js").write_text("// custom bridge\n")
    helper = bridge / "media-route.js"
    helper.write_text("// selected helper\n")
    source = tmp_path / "report.pdf"
    source.write_bytes(b"x")
    context, calls = _session_with([_resp(200, {"messageId": "cron"})], bridge_dir=bridge)
    config = _pconfig()
    config.extra["bridge_script"] = str(bridge / "bridge.js")
    with patch("aiohttp.ClientSession", return_value=context):
        result = asyncio.run(_standalone_send(config, "12345", "", media_files=[(str(source), False)]))
    assert result.get("success") is True, result
    assert result["message_id"] == "cron"
    assert len(calls) == 1
    context, calls = _session_with([_resp(200, {"messageId": "must-not-send"})], bridge_dir=bridge)
    helper.write_text("// repaired helper, previous health is now stale\n")
    with patch("aiohttp.ClientSession", return_value=context):
        result = asyncio.run(_standalone_send(config, "12345", "", media_files=[(str(source), False)]))
    assert "inputs or verified codec differ" in result.get("error", "")
    assert calls == []
