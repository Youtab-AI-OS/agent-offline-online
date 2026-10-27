"""Explicit-profile dotenv writes with restricted, atomic secret staging.

These files remain plaintext. Protection applies to ordinary local filesystems;
failure to establish owner-only access aborts before any secret is staged.
"""

from __future__ import annotations

import os
import re
import stat
import tempfile
from pathlib import Path


def _check_path(path: Path) -> os.stat_result | None:
    for component in (*reversed(path.parents), path):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Credential paths must not contain links or reparse points")
        if component == path:
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("Credential target must be a regular, unlinked file")
            return info
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("Credential parent must be a directory")
    return None


def _restrict_windows_file(path: Path) -> None:
    """Set and verify a protected DACL granting only the current token SID."""
    import ctypes
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    pointer = ctypes.c_void_p
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [pointer]
    kernel.LocalFree.restype = pointer
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, pointer, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [pointer, ctypes.POINTER(pointer)]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(pointer), pointer]
    advapi.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, pointer]
    advapi.GetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, pointer, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [pointer, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pointer), pointer]

    def require(ok: bool) -> None:
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())

    token = wintypes.HANDLE()
    sid_text = pointer()
    descriptor = pointer()
    actual_text = pointer()
    try:
        require(advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)))
        needed = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        if not needed.value:
            require(False)
        user = ctypes.create_string_buffer(needed.value)
        require(advapi.GetTokenInformation(token, 1, user, needed, ctypes.byref(needed)))
        sid = pointer.from_buffer(user).value
        require(advapi.ConvertSidToStringSidW(sid, ctypes.byref(sid_text)))
        expected = f"D:P(A;;FA;;;{ctypes.wstring_at(sid_text)})"
        require(advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(expected, 1, ctypes.byref(descriptor), None))
        require(advapi.SetFileSecurityW(str(path), 4 | 0x80000000, descriptor))
        needed = wintypes.DWORD()
        advapi.GetFileSecurityW(str(path), 4, None, 0, ctypes.byref(needed))
        if not needed.value:
            require(False)
        actual = ctypes.create_string_buffer(needed.value)
        require(advapi.GetFileSecurityW(str(path), 4, actual, needed, ctypes.byref(needed)))
        require(advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(actual, 1, 4, ctypes.byref(actual_text), None))
        if ctypes.wstring_at(actual_text) != expected:
            raise PermissionError("Credential file owner-only DACL could not be verified")
    finally:
        for allocated in (sid_text, descriptor, actual_text):
            if allocated.value:
                kernel.LocalFree(allocated)
        if token.value:
            kernel.CloseHandle(token)


def _restrict_stage(path: Path, fd: int) -> None:
    if os.name == "nt":
        _restrict_windows_file(path)
    else:
        os.fchmod(fd, 0o600)
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise PermissionError("Credential file owner-only mode could not be verified")


def write_profile_secret_env(profile_home: Path, env_writes: dict[str, str]) -> None:
    """Write within a caller-selected profile, which may be an authorized link.

    Only the selected home is resolved. The literal credential filename is
    appended afterwards, so a linked .env or substituted resolved ancestor is
    still rejected by the strict writer. This is not a general path resolver.
    """
    selected_home = Path(profile_home).resolve()
    write_secret_env(selected_home / ".env", env_writes)


def write_secret_env(
    env_path: Path, env_writes: dict[str, str], *, replace: bool = False
) -> None:
    """Update explicit dotenv assignments without changing other logical lines."""
    from youtab_agent_cli.config import _quote_env_value, invalidate_env_cache

    values: dict[str, str] = {}
    for key, value in env_writes.items():
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Invalid credential environment key")
        text = value if isinstance(value, str) else str(value)
        values[key] = _quote_env_value("".join(text.replace("\x00", "").splitlines()))
    if not values and not replace:
        return

    path = Path(os.path.abspath(env_path))
    previous = _check_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _check_path(path)
    parent = path.parent.stat()
    lines: list[str] = []
    if previous is not None:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        with os.fdopen(os.open(path, flags), "r", encoding="utf-8-sig") as handle:
            if not os.path.samestat(previous, os.fstat(handle.fileno())):
                raise ValueError("Credential file changed during read")
            existing_lines = handle.read().splitlines()
            if not replace:
                lines = existing_lines

    updated: set[str] = set()
    result: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        key = stripped.partition("=")[0].strip() if "=" in stripped else ""
        if key in values:
            result.append(f"{key}={values[key]}")
            updated.add(key)
        else:
            result.append(line)
    result.extend(f"{key}={value}" for key, value in values.items() if key not in updated)

    fd, stage = tempfile.mkstemp(dir=path.parent, prefix=".env_secret_", suffix=".tmp")
    stage_path = Path(stage)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            _restrict_stage(stage_path, handle.fileno())
            handle.write("\n".join(result) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        current = _check_path(path)
        if not os.path.samestat(parent, path.parent.stat()) or (
            (previous is None) != (current is None)
            or (previous is not None and not os.path.samestat(previous, current))
        ):
            raise ValueError("Credential path changed during write")
        os.replace(stage_path, path)
        invalidate_env_cache()
    finally:
        stage_path.unlink(missing_ok=True)


def write_secret_bytes(secret_path: Path, content: bytes) -> None:
    """Replace an explicit credential file without exposing unprotected bytes.

    Unlike dotenv assignments, backup contents are preserved byte for byte.
    Links are rejected; callers may resolve only a previously selected home.
    """
    if not isinstance(content, bytes):
        raise TypeError("Credential contents must be bytes")
    path = Path(os.path.abspath(secret_path))
    previous = _check_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _check_path(path)
    parent = path.parent.stat()
    fd, stage = tempfile.mkstemp(dir=path.parent, prefix=".secret_bytes_", suffix=".tmp")
    stage_path = Path(stage)
    try:
        with os.fdopen(fd, "wb") as handle:
            _restrict_stage(stage_path, handle.fileno())
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        current = _check_path(path)
        if not os.path.samestat(parent, path.parent.stat()) or (
            (previous is None) != (current is None)
            or (previous is not None and not os.path.samestat(previous, current))
        ):
            raise ValueError("Credential path changed during write")
        os.replace(stage_path, path)
    finally:
        stage_path.unlink(missing_ok=True)
