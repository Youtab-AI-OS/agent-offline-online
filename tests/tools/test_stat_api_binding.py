"""Cross-API ctime divergence must coexist with same-API mutation refusal."""
import asyncio
import hashlib
import os
from pathlib import Path

import pytest

from agent.file_safety import BoundReadFile
from plugins.platforms.whatsapp import adapter, managed_codec, media_delivery


class StatSnapshot:
    def __init__(self, actual, ctime):
        self.actual = actual
        self.st_ctime_ns = ctime

    def __getattr__(self, name):
        return getattr(self.actual, name)


@pytest.mark.parametrize("reader", ["bridge", "codec", "frame", "bound-read"])
@pytest.mark.parametrize("change", ["split-only", "named-ctime", "opened-ctime"])
def test_stat_api_ctime_binding(tmp_path, monkeypatch, reader, change):
    target = tmp_path / "bridge.js"
    target.write_bytes(b"synthetic attachment")
    named_before = target.lstat()
    real_fstat = os.fstat
    real_lstat = Path.lstat
    calls = {"named": 0, "opened": 0}

    def named(path, *args, **kwargs):
        info = real_lstat(path, *args, **kwargs)
        if path == target:
            calls["named"] += 1
            return StatSnapshot(info, named_before.st_ctime_ns + (1 if change == "named-ctime" and calls["named"] > 1 else 0))
        return info

    def opened(fd):
        info = real_fstat(fd)
        if (info.st_dev, info.st_ino) == (named_before.st_dev, named_before.st_ino):
            calls["opened"] += 1
            return StatSnapshot(info, named_before.st_ctime_ns + 100 + (1 if change == "opened-ctime" and calls["opened"] > 1 else 0))
        return info

    monkeypatch.setattr(Path, "lstat", named)
    monkeypatch.setattr(os, "fstat", opened)
    monkeypatch.setattr(managed_codec, "FFMPEG_FILES", {"bridge.js": (target.stat().st_size, hashlib.sha256(target.read_bytes()).hexdigest())})
    monkeypatch.setattr(media_delivery, "validate_media_delivery_path", lambda path: str(target) if str(path) == str(target) else None)

    def consume():
        if reader == "bridge":
            assert len(adapter._bridge_content_hash(tmp_path)) == 16
        elif reader == "codec":
            assert managed_codec.verify_ffmpeg_bundle(tmp_path) == {"bridge.js": target}
        elif reader == "frame":
            async def collect(frame):
                return b"".join([part async for part in frame.body()])
            with media_delivery.prepare_media_frame(str(target), "synthetic", "document", max_bytes=128) as frame:
                assert asyncio.run(collect(frame)).endswith(b"synthetic attachment")
        else:
            def authorized(path):
                if path != target:
                    raise PermissionError("Unexpected synthetic path")
            with BoundReadFile(target, authorized, 128) as stream:
                assert stream.read(128) == b"synthetic attachment"

    if change == "split-only":
        consume()
        assert calls["named"] >= 2 and calls["opened"] >= 2
    else:
        with pytest.raises((PermissionError, ValueError), match="changed"):
            consume()
