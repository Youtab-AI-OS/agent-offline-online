"""Versioned WhatsApp attachment bytes, authorized before any file read."""

import asyncio
import json
import os
import re
import stat
import struct
from threading import RLock
from contextlib import contextmanager
from pathlib import Path

from gateway.platforms.base import validate_media_delivery_path

MEDIA_CONTENT_TYPE = "application/vnd.youtab.whatsapp-media.v1"
MEDIA_CONTRACT = "youtab.whatsapp.media"
MEDIA_VERSION = 1
MAX_METADATA_BYTES = 65536
DEFAULT_MEDIA_MAX_BYTES = 128 * 1024 * 1024
MAX_MEDIA_BYTES = 512 * 1024 * 1024
CHUNK_BYTES = 65536


async def post_media_frame(session, base_url, headers, file_path, chat_id, media_type,
                           *, caption=None, file_name=None, bridge_dir=None):
    """Negotiate the exact bytes contract, then stream one authorized descriptor."""
    import aiohttp

    limit = get_media_max_bytes()
    async with session.get(f"{base_url}/health", headers=headers,
                           timeout=aiohttp.ClientTimeout(total=10)) as response:
        if response.status != 200:
            raise RuntimeError(f"WhatsApp bridge health failed ({response.status})")
        health = await response.json()
    if (health.get("mediaContract") != MEDIA_CONTRACT or
            health.get("mediaVersion") != MEDIA_VERSION or
            type(health.get("mediaMaxBytes")) is not int or health["mediaMaxBytes"] != limit):
        raise RuntimeError("WhatsApp bridge media contract or byte limit differs; restart with the current Runtime")
    # The adapter imports this streaming module. Resolve its shared identity
    # helpers lazily after initialization so Cron uses the same actual guard.
    from .adapter import _bridge_content_hash, _bridge_codec_matches
    directory = Path(bridge_dir) if bridge_dir is not None else Path(__file__).resolve().parents[3] / "scripts/whatsapp-bridge"
    if health.get("scriptHash") != _bridge_content_hash(directory) or not _bridge_codec_matches(health):
        raise RuntimeError("WhatsApp bridge inputs or verified codec differ; restart with the current Runtime")
    with prepare_media_frame(file_path, chat_id, media_type, caption=caption,
                             file_name=file_name, max_bytes=limit) as frame:
        try:
            async with session.post(f"{base_url}/send-media",
                                    headers={**headers, "Content-Type": MEDIA_CONTENT_TYPE},
                                    data=frame.body(), timeout=aiohttp.ClientTimeout(total=120)) as response:
                if response.status != 200:
                    raise RuntimeError(f"WhatsApp media error ({response.status}): {await response.text()}")
                return await response.json()
        finally:
            # aiohttp's writer owns iteration. Finish cancellation before closing
            # its descriptor so an OS-reused descriptor cannot be consumed.
            await frame.cancel_and_wait()


def get_media_max_bytes(environ=None):
    environ = os.environ if environ is None else environ
    raw = environ.get("YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES")
    if raw is None:
        return DEFAULT_MEDIA_MAX_BYTES
    if not isinstance(raw, str) or not re.fullmatch(r"[1-9][0-9]*", raw):
        raise ValueError("YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES must be a positive decimal integer")
    value = int(raw)
    if value > MAX_MEDIA_BYTES:
        raise ValueError("Media byte limit must be an integer between 1 and 536870912")
    return value


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _same_file(info):
    # ctime is compared within each API; dev/ino/size/mtime bind across APIs.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _descriptor_path(descriptor, approved):
    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes

        query = ctypes.WinDLL("kernel32", use_last_error=True).GetFinalPathNameByHandleW
        query.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
        query.restype = wintypes.DWORD
        handle = msvcrt.get_osfhandle(descriptor)
        needed = query(handle, None, 0, 0)
        if not needed:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_unicode_buffer(needed + 1)
        written = query(handle, buffer, len(buffer), 0)
        if not written or written >= len(buffer):
            raise OSError("Unable to bind the media descriptor path")
        actual = buffer.value
        if actual.startswith("\\\\?\\UNC\\"):
            return "\\\\" + actual[8:]
        if actual.startswith("\\\\?\\"):
            return actual[4:]
        return actual
    descriptor_link = Path("/proc/self/fd") / str(descriptor)
    if descriptor_link.parent.is_dir():
        return os.readlink(descriptor_link)
    # Other POSIX systems retain nofollow, regular-file and inode checks below.
    return approved


def _display_name(name):
    # A basename is display data, never a decoder or filesystem argument.
    if not isinstance(name, str):
        raise ValueError("WhatsApp attachment display name must be a string")
    name = name.replace("/", "_").replace("\\", "_").replace("\0", "_")
    if not name or name in (".", ".."):
        raise ValueError("WhatsApp attachment display name must be a basename")
    return name


def _attachment_name(file_path):
    # Match the already-authorized path spelling cleanup for its display name.
    # This value is never used to reopen the file or select a decoder pathname.
    candidate = str(file_path).strip()
    if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in "`\"'":
        candidate = candidate[1:-1].strip()
    candidate = candidate.lstrip("`\"'").rstrip("`\"',.;:)}]")
    return _display_name(Path(os.path.expanduser(candidate)).name)


class PreparedMediaFrame:
    def __init__(self, original, approved, descriptor, before, metadata, limit, *, named_before):
        self._lock = RLock()
        self.closed = False
        self._started = False
        self._consumer = None
        self.original = original
        self.approved = approved
        self.descriptor = descriptor
        self.before = before
        self.named_before = named_before
        self.metadata = metadata
        self.limit = limit
        encoded = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if not encoded or len(encoded) > MAX_METADATA_BYTES:
            raise ValueError("WhatsApp media metadata exceeds 65536 bytes")
        self.header = struct.pack(">I", len(encoded)) + encoded

    def _require_open(self):
        if self.closed or self.descriptor is None:
            raise RuntimeError("WhatsApp media frame is closed")

    def close(self):
        with self._lock:
            if self.closed:
                return
            self.closed = True
            descriptor, self.descriptor = self.descriptor, None
            os.close(descriptor)

    def assert_bound(self):
        with self._lock:
            self._require_open()
            self._assert_bound()

    def _assert_bound(self):
        current = os.fstat(self.descriptor)
        if not stat.S_ISREG(current.st_mode) or _identity(current) != _identity(self.before):
            raise PermissionError("WhatsApp attachment changed while reading")
        actual = _descriptor_path(self.descriptor, self.approved)
        if os.path.normcase(os.path.normpath(actual)) != os.path.normcase(os.path.normpath(self.approved)):
            raise PermissionError("WhatsApp attachment descriptor escaped its authorized path")
        if validate_media_delivery_path(self.original) != self.approved:
            raise PermissionError("WhatsApp attachment delivery authorization changed")
        named = Path(self.approved).lstat()
        if (not stat.S_ISREG(named.st_mode) or _identity(named) != _identity(self.named_before)
                or _same_file(named) != _same_file(current)):
            raise PermissionError("WhatsApp attachment entry changed while reading")

    async def cancel_and_wait(self):
        consumer = self._consumer
        if consumer is not None and consumer is not asyncio.current_task() and not consumer.done():
            consumer.cancel()
            await asyncio.gather(consumer, return_exceptions=True)

    async def body(self):
        with self._lock:
            self._require_open()
            if self._started:
                raise RuntimeError("WhatsApp media frame was already consumed")
            self._started = True
        consumer = asyncio.current_task()
        self._consumer = consumer
        try:
            self.assert_bound()
            yield self.header
            total = 0
            while True:
                # Chunked EOF is withheld until the final identity/policy checks.
                with self._lock:
                    self._require_open()
                    self._assert_bound()
                    chunk = os.read(self.descriptor, min(CHUNK_BYTES, self.limit - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > self.limit or total > self.before.st_size:
                    raise ValueError("WhatsApp attachment exceeds its declared or configured byte limit")
                yield chunk
            if total != self.before.st_size:
                raise ValueError("WhatsApp attachment length changed while reading")
            self.assert_bound()
        finally:
            if self._consumer is consumer:
                self._consumer = None


@contextmanager
def prepare_media_frame(file_path, chat_id, media_type, *, caption=None, file_name=None, max_bytes=None):
    limit = get_media_max_bytes() if max_bytes is None else max_bytes
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_MEDIA_BYTES:
        raise ValueError("Media byte limit must be an integer between 1 and 536870912")
    approved = validate_media_delivery_path(file_path)
    if not approved:
        if not os.path.exists(os.path.expanduser(str(file_path))):
            raise FileNotFoundError(f"WhatsApp media file not found: {file_path}")
        raise PermissionError("WhatsApp media path is not authorized by delivery policy")
    before = Path(approved).lstat()
    if not stat.S_ISREG(before.st_mode):
        raise PermissionError("WhatsApp media must be a regular file")
    if before.st_size > limit:
        raise ValueError(f"WhatsApp attachment exceeds the configured {limit}-byte media limit")
    descriptor = os.open(approved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    prepared = None
    try:
        metadata = {"contract": MEDIA_CONTRACT, "version": MEDIA_VERSION, "chatId": chat_id,
                    "byteLength": before.st_size, "attachmentName": _attachment_name(file_path), "mediaType": media_type}
        if caption is not None:
            metadata["caption"] = caption
        if file_name is not None:
            metadata["fileName"] = _display_name(file_name)
        if not isinstance(chat_id, str) or not chat_id or media_type not in {"image", "video", "audio", "document"}:
            raise ValueError("Invalid WhatsApp media destination or type")
        if caption is not None and not isinstance(caption, str):
            raise ValueError("WhatsApp media caption must be a string")
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or _same_file(opened) != _same_file(before):
            raise PermissionError("WhatsApp attachment changed before reading")
        prepared = PreparedMediaFrame(file_path, approved, descriptor, opened, metadata, limit, named_before=before)
        prepared.assert_bound()
        yield prepared
    finally:
        if prepared is not None:
            prepared.close()
        else:
            os.close(descriptor)
