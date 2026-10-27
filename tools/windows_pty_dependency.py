"""Verify the packaged Windows PTY SDK and attest its actual installed origin.

This module performs stdlib-only I/O. It never installs, downloads, patches, or
imports the installed SDK until its files and interpreter have been verified.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import stat
import struct
import sys
import sysconfig
import zipfile
from email.parser import BytesParser


SDK_VERSION = "2.0.15+youtab.1"
SDK_REQUIREMENT = f"pywinpty=={SDK_VERSION}"
VENDOR_RELATIVE_DIR = "native/python-wheels/pywinpty"
PATCHED_SOURCE_SHA256 = "85607b6521367483b5975b281246be3afa168c9b94c8686d20bdeaf6be44a79d"
LICENSE_SHA256 = "f878d4767f9ad2e43d3083efa00201b000ce937d9ee8626e00ba5c72aac951e2"
DIST_INFO = f"pywinpty-{SDK_VERSION}.dist-info"

EXPECTED_WHEELS = {
    "cp311": {
        "relative_path": f"{VENDOR_RELATIVE_DIR}/pywinpty-{SDK_VERSION}-cp311-cp311-win_amd64.whl",
        "wheel_sha256": "715faba1f605889ca39242b9c6b09f247f815393b62b154cf8cbc93cb55bbbbf",
        "official_sha256": "9a6bcec2df2707aaa9d08b86071970ee32c5026e10bcc3cc5f6f391d85baf7ca",
        "native_sha256": "0bdbcda99f77f54ca1bb8fb10bbf9d78a721aac5f32ea95249254e19d3002298",
        "size_bytes": 1391107,
    },
    "cp312": {
        "relative_path": f"{VENDOR_RELATIVE_DIR}/pywinpty-{SDK_VERSION}-cp312-cp312-win_amd64.whl",
        "wheel_sha256": "c7bf8efadc2804a5c3e186b46fe4254ba63bf78d211908267d0b6b97b606b285",
        "official_sha256": "83a8f20b430bbc5d8957249f875341a60219a4e971580f2ba694fbfb54a45ebc",
        "native_sha256": "488c12aaea91b2828cd5224b1050565ce4e6660e7adef2fb07510f89f5743d33",
        "size_bytes": 1391011,
    },
    "cp313": {
        "relative_path": f"{VENDOR_RELATIVE_DIR}/pywinpty-{SDK_VERSION}-cp313-cp313-win_amd64.whl",
        "wheel_sha256": "1dc2c6c5d8f3a57c0f9f443d1e99bedb950764da93e0e9564f74a3f65be257ff",
        "official_sha256": "ab5920877dd632c124b4ed17bc6dd6ef3b9f86cd492b963ffdb1a67b85b0f408",
        "native_sha256": "45a87d51d06645c2cce52632e4fe8c9af53eb0471e80047c6b95ee37abe89555",
        "size_bytes": 1390831,
    },
}
for _spec in EXPECTED_WHEELS.values():
    _spec.update(patched_source_sha256=PATCHED_SOURCE_SHA256, license_sha256=LICENSE_SHA256)


def _identity(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _same_file(info: os.stat_result) -> tuple:
    # Win CPython 3.12+ fstat reports creation time as ctime while path stat
    # reports change time. Compare ctime only within the same API snapshots.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _read_fixed(path: Path, expected_size: int) -> bytes:
    """Bound the actual FD read and reject replaced or changed named inputs."""
    if path.resolve(strict=True) != path:
        raise ValueError(f"Windows PTY input changed its resolved origin: {path}")
    named_before = path.stat()
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_size != expected_size
                or _same_file(before) != _same_file(named_before)):
            raise ValueError(f"Windows PTY input size/type mismatch: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            data = stream.read(expected_size + 1)
        after = os.fstat(descriptor)
        named = path.stat()
        if (len(data) != expected_size or _identity(before) != _identity(after)
                or _identity(named_before) != _identity(named) or _same_file(after) != _same_file(named)
                or path.resolve(strict=True) != path):
            raise ValueError(f"Windows PTY input changed during verification: {path}")
    finally:
        os.close(descriptor)
    return data


def _bytes_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _packaged_path(root: Path, relative: str) -> Path:
    expected = root.resolve() / relative
    if expected.resolve(strict=True) != expected:
        raise ValueError(f"Windows PTY input redirects its packaged path: {relative}")
    return expected


def _wheel_bytes(root: Path, spec: dict) -> bytes:
    data = _read_fixed(_packaged_path(root, spec["relative_path"]), spec["size_bytes"])
    if _bytes_hash(data) != spec["wheel_sha256"]:
        raise ValueError(f"Windows PTY wheel hash mismatch: {spec['relative_path']}")
    return data


def validate_packaged_wheels(repo_root: str | Path) -> dict:
    """Validate all three immutable packaged wheels without importing winpty."""
    root = Path(repo_root)
    records = []
    for abi, spec in EXPECTED_WHEELS.items():
        with zipfile.ZipFile(io.BytesIO(_wheel_bytes(root, spec))) as wheel:
            names = wheel.namelist()
            if len(names) != len(set(names)):
                raise ValueError("Windows PTY wheel has duplicate archive members")
            metadata = BytesParser().parsebytes(wheel.read(f"{DIST_INFO}/METADATA"))
            wheel_info = BytesParser().parsebytes(wheel.read(f"{DIST_INFO}/WHEEL"))
            if metadata["Name"] != "pywinpty" or metadata["Version"] != SDK_VERSION:
                raise ValueError("Windows PTY wheel metadata does not match the pinned SDK")
            if wheel_info.get_all("Tag") != [f"{abi}-{abi}-win_amd64"]:
                raise ValueError("Windows PTY wheel ABI tag does not match its manifest")
            checks = {
                "winpty/ptyprocess.py": spec["patched_source_sha256"],
                f"winpty/winpty.{abi}-win_amd64.pyd": spec["native_sha256"],
                f"{DIST_INFO}/licenses/LICENSE.txt": spec["license_sha256"],
            }
            for member, expected_hash in checks.items():
                if _bytes_hash(wheel.read(member)) != expected_hash:
                    raise ValueError(f"Windows PTY embedded input hash mismatch: {member}")
        records.append({"abi": abi, **spec})
    return {"name": "pywinpty", "version": SDK_VERSION, "wheels": records}


def runtime_metadata() -> dict:
    return {
        "implementation": sys.implementation.name,
        "version": f"{sys.version_info.major}.{sys.version_info.minor}",
        "platform": sys.platform,
        "sysconfig_platform": sysconfig.get_platform(),
        "pointer_bits": struct.calcsize("P") * 8,
        "extension_suffix": sysconfig.get_config_var("EXT_SUFFIX"),
        "prefix": str(Path(sys.prefix).resolve()),
        "executable": str(Path(sys.executable).resolve()),
    }


def _runtime_abi(runtime: dict) -> str:
    abi = {"3.11": "cp311", "3.12": "cp312", "3.13": "cp313"}.get(runtime["version"])
    if (not abi or runtime["implementation"] != "cpython" or runtime["platform"] != "win32"
            or runtime["sysconfig_platform"] != "win-amd64" or runtime["pointer_bits"] != 64
            or runtime["extension_suffix"] != f".{abi}-win_amd64.pyd"):
        raise ValueError("Verified Windows PTY SDK requires standard 64-bit CPython 3.11, 3.12, or 3.13 for win-amd64")
    return abi


def installation_context(repo_root: str | Path) -> dict:
    manifest = validate_packaged_wheels(repo_root)
    runtime = runtime_metadata()
    abi = _runtime_abi(runtime)
    selected = next(record for record in manifest["wheels"] if record["abi"] == abi)
    return {
        "version": SDK_VERSION, "requirement": SDK_REQUIREMENT, "runtime": runtime,
        "abi": abi, "wheel": str(_packaged_path(Path(repo_root), selected["relative_path"])),
        "vendor_dir": str(Path(repo_root).resolve() / VENDOR_RELATIVE_DIR),
        "wheel_sha256": selected["wheel_sha256"],
        "wheel_requirement": f"pywinpty @ {_packaged_path(Path(repo_root), selected['relative_path']).as_uri()}#sha256={selected['wheel_sha256']}",
    }


def attest_installed_sdk(repo_root: str | Path) -> dict:
    """Hash installed files before importing, then verify actual import origins."""
    context = installation_context(repo_root)
    prefix = Path(context["runtime"]["prefix"])
    distribution = importlib.metadata.distribution("pywinpty")
    if distribution.version != SDK_VERSION:
        raise ValueError("Installed Windows PTY SDK version does not match the verified local build")
    paths = {}
    verified = {}
    with zipfile.ZipFile(io.BytesIO(_wheel_bytes(Path(repo_root), EXPECTED_WHEELS[context["abi"]]))) as wheel:
        for member in wheel.namelist():
            if member.endswith("/") or member == f"{DIST_INFO}/RECORD":
                continue  # Installers update RECORD with generated installer entries.
            path = Path(distribution.locate_file(member)).resolve(strict=True)
            if not path.is_relative_to(prefix):
                raise ValueError(f"Installed Windows PTY SDK is outside the actual interpreter prefix: {member}")
            payload = wheel.read(member)
            expected_hash = _bytes_hash(payload)
            if _bytes_hash(_read_fixed(path, len(payload))) != expected_hash:
                raise ValueError(f"Installed Windows PTY SDK file hash mismatch: {member}")
            paths[member] = path
            verified[member] = (len(payload), expected_hash)
    package = importlib.import_module("winpty")
    source = importlib.import_module("winpty.ptyprocess")
    native = importlib.import_module("winpty.winpty")
    expected_origins = [
        (package, paths["winpty/__init__.py"]),
        (source, paths["winpty/ptyprocess.py"]),
        (native, paths[f"winpty/winpty.{context['abi']}-win_amd64.pyd"]),
    ]
    for module, expected in expected_origins:
        if Path(module.__file__).resolve(strict=True) != expected:
            raise ValueError("Windows PTY SDK import origin does not match the verified installed distribution")
    for member, (size, expected_hash) in verified.items():
        if _bytes_hash(_read_fixed(paths[member], size)) != expected_hash:
            raise ValueError(f"Windows PTY SDK installed input changed during import: {member}")
    return {
        **context, "attested": True,
        "source_path": str(expected_origins[1][1]), "source_sha256": PATCHED_SOURCE_SHA256,
        "native_path": str(expected_origins[2][1]), "native_sha256": EXPECTED_WHEELS[context["abi"]]["native_sha256"],
        "license_sha256": LICENSE_SHA256,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("verify-vendor", "validate", "attest"))
    parser.add_argument("--root", required=True)
    args = parser.parse_args(argv)
    try:
        functions = {"verify-vendor": validate_packaged_wheels, "validate": installation_context,
                     "attest": attest_installed_sdk}
        print(json.dumps(functions[args.action](args.root), sort_keys=True))
    except (OSError, ValueError, zipfile.BadZipFile, KeyError, ImportError) as exc:
        print(f"Windows PTY SDK verification failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
