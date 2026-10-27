"""Shared substrate for external secret-source backends.

Every backend (Bitwarden, 1Password, …) needs the same handful of
security-sensitive primitives:

  * a uniform result object (:class:`FetchResult`),
  * environment-variable name validation (:func:`is_valid_env_name`),
  * a two-layer fetch cache whose disk half writes atomically with ``0600``
    permissions and honours a TTL (:class:`DiskCache`, :class:`CachedFetch`).

These used to live inline inside ``bitwarden.py``.  Pulling them here means
the atomic-write / ``0600`` / TTL logic is audited and fixed in exactly one
place instead of drifting across copy-pasted per-backend modules — each
backend supplies only its own cache-key shape and a serializer for it.

Nothing in this module ever raises out to the caller's hot path: the disk
layer is strictly best-effort (a miss just triggers a refetch), because a
cache problem must never block Youtab startup.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Generic, Optional, TypeVar

__all__ = [
    "FetchResult",
    "CachedFetch",
    "DiskCache",
    "is_valid_env_name",
    "resolve_cache_home",
]


# ---------------------------------------------------------------------------
# Result object + env-name validation — canonical definitions live in
# ``agent.secret_sources.base`` (the SecretSource contract module); re-exported
# here so backends that import from ``_cache`` keep working.
# ---------------------------------------------------------------------------

from agent.secret_sources.base import (  # noqa: E402
    FetchResult,
    is_valid_env_name,
)


# ---------------------------------------------------------------------------
# Cache entry
# ---------------------------------------------------------------------------


@dataclass
class CachedFetch:
    """A set of fetched secret values plus when they were fetched."""

    secrets: Dict[str, str]
    fetched_at: float

    def is_fresh(self, ttl_seconds: float) -> bool:
        if ttl_seconds <= 0:
            return False
        return (time.time() - self.fetched_at) < ttl_seconds




# ---------------------------------------------------------------------------
# Disk cache
# ---------------------------------------------------------------------------


def resolve_cache_home(home_path: Optional[Path] = None) -> Path:
    """Resolve the Youtab home used for cache paths.

    ``home_path`` is whatever ``load_youtab_dotenv()`` already resolved;
    falling back to ``$YOUTAB_AGENT_HOME`` / ``~/.youtab-agent-runtime`` keeps direct callers
    (and tests that don't thread a home through) working.
    """
    if home_path is None:
        from youtab_constants import get_youtab_home

        home_path = get_youtab_home()
    return home_path


K = TypeVar("K")


def _read_private_cache(path: Path) -> bytes:
    """Protect an owned ordinary existing cache, then read the same file.

    This closes inherited legacy permissions without deleting cache bytes.
    It cannot establish that a legacy plaintext cache was never tampered with.
    """
    from youtab_agent_cli.secret_env import _check_path, _restrict_stage

    previous = _check_path(path)
    if previous is None:
        raise FileNotFoundError(path)
    if os.name == "nt":
        import msvcrt
        import pywintypes
        import win32con
        import win32file
        import win32security
        from youtab_agent_cli.windows_ssh_runtime import _current_sid

        # Deny concurrent writes and delete/rename while protection and read run.
        native = None
        try:
            native = win32file.CreateFile(
                str(path), win32con.GENERIC_READ | win32con.READ_CONTROL,
                win32con.FILE_SHARE_READ, None,
                win32con.OPEN_EXISTING, win32file.FILE_FLAG_OPEN_REPARSE_POINT, None,
            )
            actual = win32file.GetFinalPathNameByHandle(native, 0)
            if actual.startswith("\\\\?\\"):
                actual = actual[4:]
            if os.path.normcase(actual) != os.path.normcase(os.path.abspath(path)):
                raise PermissionError("Secret cache handle escaped its path")
            descriptor = win32security.GetSecurityInfo(
                native, win32security.SE_FILE_OBJECT, win32security.OWNER_SECURITY_INFORMATION,
            )
            if descriptor.GetSecurityDescriptorOwner() != _current_sid():
                raise PermissionError("Secret cache belongs to a different user")
            fd = msvcrt.open_osfhandle(int(native), os.O_RDONLY | os.O_BINARY)
            native.Detach()  # The CRT file descriptor now owns this handle.
            native = None
        except pywintypes.error:
            # pywintypes.error is not an OSError; preserve cache-miss behavior.
            raise OSError("Windows secret cache could not be protected") from None
        finally:
            if native is not None:
                native.Close()
    else:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as handle:
        current = os.fstat(handle.fileno())
        if not os.path.samestat(previous, current) or current.st_nlink != 1:
            raise PermissionError("Secret cache identity changed")
        if os.name != "nt" and current.st_uid != os.getuid():
            raise PermissionError("Secret cache belongs to a different user")
        _restrict_stage(path, handle.fileno())
        after = _check_path(path)
        if after is None or not os.path.samestat(previous, after):
            raise PermissionError("Secret cache changed while being protected")
        return handle.read()


class DiskCache(Generic[K]):
    """Best-effort, profile-aware on-disk cache for fetched secret values.

    One JSON object per backend lives at ``<youtab_home>/cache/<basename>``::

        {"key": "<serialized cache key>", "secrets": {...}, "fetched_at": 1.0}

    The file holds only secret *values* keyed by the serialized cache key —
    never raw auth material.  Backends are responsible for fingerprinting
    tokens/sessions *before* they reach ``key_serializer`` so the token can't
    land in the key.

    Writes use the shared atomic credential writer (POSIX ``0600`` or a
    verified current-user-only Windows DACL), and the
    containing ``cache/`` directory is forced to ``0700`` — ``mkdir``'s mode is
    umask-subject, so the chmod is the reliable form.  Both ``read`` and
    ``write`` short-circuit when ``ttl_seconds <= 0``, so setting the TTL to
    zero disables *both* cache layers symmetrically: a user opting out never
    gets secret values written to disk at all.
    """

    def __init__(self, basename: str, *, key_serializer: Callable[[K], str]) -> None:
        self._basename = basename
        self._key_serializer = key_serializer

    def path(self, home_path: Optional[Path] = None) -> Path:
        return resolve_cache_home(home_path) / "cache" / self._basename

    def read(
        self,
        key: K,
        ttl_seconds: float,
        home_path: Optional[Path] = None,
    ) -> Optional[CachedFetch]:
        """Return a fresh cached entry for ``key``, or None.

        Best-effort: any I/O or parse error, a key mismatch, or a stale entry
        all return None so the caller re-fetches.
        """
        if ttl_seconds <= 0:
            return None
        path = self.path(home_path)
        try:
            payload = json.loads(_read_private_cache(path).decode("utf-8"))
        except (OSError, ValueError, ImportError):
            return None
        if not isinstance(payload, dict):
            return None
        if payload.get("key") != self._key_serializer(key):
            return None
        secrets = payload.get("secrets")
        fetched_at = payload.get("fetched_at")
        if not isinstance(secrets, dict) or not isinstance(fetched_at, (int, float)):
            return None
        # JSON permits non-string values; env vars need strings, so coerce by
        # dropping anything that isn't a str→str pair.
        typed: Dict[str, str] = {
            k: v for k, v in secrets.items() if isinstance(k, str) and isinstance(v, str)
        }
        entry = CachedFetch(secrets=typed, fetched_at=float(fetched_at))
        if not entry.is_fresh(ttl_seconds):
            return None
        return entry

    def write(
        self,
        key: K,
        entry: CachedFetch,
        ttl_seconds: float,
        home_path: Optional[Path] = None,
    ) -> None:
        """Persist ``entry`` for ``key`` atomically at mode ``0600``.

        No-op when ``ttl_seconds <= 0`` (so caching is genuinely off) or on any
        I/O error — the next invocation just re-fetches.
        """
        if ttl_seconds <= 0:
            return
        path = self.path(home_path)
        try:
            from youtab_agent_cli.secret_env import _check_path, write_secret_bytes

            _check_path(path)
            cache_dir = path.parent
            cache_dir.mkdir(parents=True, exist_ok=True)
            # mkdir's mode is umask-subject; chmod the dir to 0700 so cache
            # metadata isn't exposed if YOUTAB_AGENT_HOME is ever made traversable.
            try:
                os.chmod(cache_dir, 0o700)
            except OSError:
                pass
            payload = {
                "key": self._key_serializer(key),
                "secrets": entry.secrets,
                "fetched_at": entry.fetched_at,
            }
            write_secret_bytes(path, json.dumps(payload).encode("utf-8"))
        except (OSError, ValueError):
            pass  # best-effort — a disk-cache miss next invocation is fine

    def clear(self, home_path: Optional[Path] = None) -> None:
        """Delete the on-disk cache file if present (idempotent)."""
        try:
            self.path(home_path).unlink()
        except (FileNotFoundError, OSError):
            pass
