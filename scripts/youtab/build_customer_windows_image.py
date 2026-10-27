#!/usr/bin/env python3
"""Stage a pinned, bounded Windows x64 Desktop image for the Runtime archive.

The output is an archive member tree, not an installer. Release packaging puts
its contents beneath customer-image/windows-x64/ in the one Runtime ZIP.
Node, browser and TUI payloads require separate proven layouts before this can
be considered a complete customer image.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path

try:
    from .customer_windows_producer_receipt import verify_receipt
except ImportError:  # Direct producer CLI invocation.
    from customer_windows_producer_receipt import verify_receipt

SOURCE_SHA = re.compile(r"[a-f0-9]{40}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
IMAGE_PREFIX = Path("apps/desktop/release/win-unpacked")
MAX_FILES = 10_000
MAX_FILE_SIZE = 768 * 1024 * 1024
MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024
SECRET_NAMES = {"id_rsa", "id_ed25519", "credentials.json", "secrets.json", "auth.json", ".env"}
SECRET_SUFFIXES = (".pem", ".p12", ".pfx", ".key", ".kdbx")
PRIVATE_KEY = re.compile(rb"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----")
REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
WINDOWS_RESERVED = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\Z", re.I)


def _safe_relative(path: str) -> None:
    parts = path.split("/")
    if (not path or "\\" in path or path.startswith("/") or
            any(part in {"", ".", ".."} or ":" in part or part.endswith((".", " "))
                or WINDOWS_RESERVED.fullmatch(part) for part in parts)):
        raise ValueError(f"unsafe image path: {path}")


def _regular_file(path: Path) -> os.stat_result:
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
            or (hasattr(info, "st_file_attributes")
                and info.st_file_attributes & REPARSE_ATTRIBUTE)):
        raise ValueError(f"image input must be a single-link regular file: {path}")
    return info


def _safe_directory(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError(f"image input directory is a link or non-directory: {path}")
    if hasattr(info, "st_file_attributes") and info.st_file_attributes & REPARSE_ATTRIBUTE:
        raise ValueError(f"image input directory is a reparse point: {path}")


def _hash_file(path: Path) -> tuple[int, str]:
    info = _regular_file(path)
    if not 0 < info.st_size <= MAX_FILE_SIZE:
        raise ValueError(f"image file size outside bounds: {path}")
    digest = hashlib.sha256()
    overlap = b""
    read_size = 0
    with path.open("rb") as reader:
        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
            read_size += len(chunk)
            if PRIVATE_KEY.search(overlap + chunk):
                raise ValueError(f"private-key material in image file: {path}")
            digest.update(chunk)
            overlap = chunk[-64:]
    if read_size != info.st_size or path.lstat().st_size != info.st_size:
        raise ValueError(f"image file changed while being read: {path}")
    return read_size, digest.hexdigest()


def _iter_image_files(root: Path):
    pending = [root]
    seen: set[str] = set()
    while pending:
        directory = pending.pop()
        _safe_directory(directory)
        for item in sorted(directory.iterdir(), key=lambda p: p.name.casefold()):
            rel = item.relative_to(root).as_posix()
            _safe_relative(rel)
            folded = rel.casefold()
            if folded in seen:
                raise ValueError(f"case-colliding image path: {rel}")
            seen.add(folded)
            if item.is_dir():
                _safe_directory(item)
                pending.append(item)
            else:
                _regular_file(item)
                if item.name.casefold().endswith(".map"):
                    continue
                if item.name.casefold() in SECRET_NAMES or item.name.casefold().endswith(SECRET_SUFFIXES):
                    raise ValueError(f"credential-like image path: {rel}")
                yield rel, item


def _validate_desktop(root: Path, source_sha: str) -> None:
    required = (
        "Youtab.exe", "resources/app.asar", "resources/install-stamp.json",
        "resources/app.asar.unpacked/dist/index.html",
        "resources/app.asar.unpacked/dist/node_modules/node-pty/package.json",
        "resources/app.asar.unpacked/dist/node_modules/node-pty/lib/index.js",
        "resources/app.asar.unpacked/dist/native/setup_lease.node",
    )
    for rel in required:
        _safe_relative(rel)
        if not (root / rel).is_file():
            raise ValueError(f"Desktop image lacks required file: {rel}")
    with (root / "Youtab.exe").open("rb") as reader:
        exe = reader.read(512)
    pe = int.from_bytes(exe[60:64], "little") if len(exe) >= 64 else 0
    if (exe[:2] != b"MZ" or pe < 64 or pe + 26 > len(exe) or
            exe[pe:pe + 4] != b"PE\0\0" or int.from_bytes(exe[pe + 4:pe + 6], "little") != 0x8664):
        raise ValueError("Desktop executable is not Windows x64 PE")
    stamp_path = root / "resources/install-stamp.json"
    stamp_size, _ = _hash_file(stamp_path)
    if stamp_size > 64 * 1024:
        raise ValueError("Desktop stamp is too large")
    stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
    if not isinstance(stamp, dict) or stamp.get("commit") != source_sha or stamp.get("dirty") is not False:
        raise ValueError("Desktop stamp is not clean or does not match source commit")
    lease = stamp.get("setupLease")
    if not isinstance(lease, dict) or lease.get("napi") != "youtab.setup-lease/napi-v1":
        raise ValueError("Desktop stamp lacks native Setup lease")
    size, digest = _hash_file(root / required[-1])
    if lease.get("size") != size or lease.get("sha256") != digest:
        raise ValueError("packaged native Setup lease differs from install stamp")
    native_root = root / "resources/app.asar.unpacked/dist/node_modules/node-pty"
    binaries = [
        native_root / "prebuilds/win32-x64/pty.node",
        native_root / "build/Release/pty.node",
    ]
    if not any(candidate.is_file() for candidate in binaries):
        raise ValueError("packaged node-pty lacks a Windows x64 native binding")
    for candidate in binaries:
        if candidate.is_file():
            _hash_file(candidate)


def build_image(desktop: Path, lockfile: Path, source_sha: str, output: Path,
                expected_lock_sha256: str, producer_receipt: Path | None = None) -> dict:
    if not SOURCE_SHA.fullmatch(source_sha):
        raise ValueError("source SHA must be an exact lowercase Git commit")
    desktop, lockfile, output = desktop.absolute(), lockfile.absolute(), output.absolute()
    if output.exists():
        raise FileExistsError(f"immutable image output already exists: {output}")
    if desktop == output or desktop in output.parents or output in desktop.parents:
        raise ValueError("image output and input must not overlap")
    _safe_directory(desktop)
    lock_size, lock_digest = _hash_file(lockfile)
    if (lock_size < 100 or not SHA256.fullmatch(expected_lock_sha256)
            or lock_digest != expected_lock_sha256):
        raise ValueError("invalid dependency lock")
    if producer_receipt is None:
        raise ValueError("final Desktop image requires a producer receipt")
    receipt_sha = verify_receipt(producer_receipt, source_sha=source_sha,
                                lock_sha256=lock_digest, desktop=desktop)
    _validate_desktop(desktop, source_sha)
    files = sorted(_iter_image_files(desktop), key=lambda pair: pair[0].casefold())
    if not files or len(files) > MAX_FILES:
        raise ValueError("Desktop image file count outside bounds")
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix=".youtab-image-", dir=output.parent))
    try:
        entries = []
        total = 0
        for rel, input_file in files:
            size, digest = _hash_file(input_file)
            total += size
            if total > MAX_TOTAL_SIZE:
                raise ValueError("Desktop image exceeds total size bound")
            member = (IMAGE_PREFIX / rel).as_posix()
            _safe_relative(member)
            target = staged / member
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(input_file, target, follow_symlinks=False)
            if _hash_file(target) != (size, digest):
                raise ValueError(f"image file changed during copy: {rel}")
            entries.append({"path": member, "size": size, "sha256": digest})
        manifest = {
            "schema_version": 1, "platform": "windows", "architecture": "x64",
            "source_sha": source_sha, "lock_sha256": lock_digest,
            "producer_receipt_sha256": receipt_sha,
            "components": ["desktop"], "file_count": len(entries),
            "total_size": total, "files": entries,
        }
        (staged / "manifest.json").write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        staged.rename(output)
    finally:
        # Only the unique directory made above is ours to remove. On success
        # its old name no longer exists; on failure the partial image is never
        # exposed under the requested immutable output path.
        if staged.exists():
            if staged.parent != output.parent or not staged.name.startswith(".youtab-image-"):
                raise RuntimeError("refusing to remove an unexpected staging path")
            shutil.rmtree(staged)
    return manifest


def verify_image(output: Path, manifest: dict) -> None:
    """Verify a staged image using only its explicit manifest."""
    if (manifest.get("schema_version") != 1 or manifest.get("platform") != "windows"
            or manifest.get("architecture") != "x64" or manifest.get("components") != ["desktop"]
            or not isinstance(manifest.get("source_sha"), str)
            or not SOURCE_SHA.fullmatch(manifest["source_sha"])
            or not isinstance(manifest.get("lock_sha256"), str)
            or not SHA256.fullmatch(manifest["lock_sha256"])
            or not isinstance(manifest.get("producer_receipt_sha256"), str)
            or not SHA256.fullmatch(manifest["producer_receipt_sha256"])):
        raise ValueError("invalid image manifest identity")
    if (not isinstance(manifest.get("files"), list) or
            not isinstance(manifest.get("file_count"), int) or
            not 1 <= manifest["file_count"] <= MAX_FILES or
            not isinstance(manifest.get("total_size"), int) or
            not 1 <= manifest["total_size"] <= MAX_TOTAL_SIZE):
        raise ValueError("invalid image manifest bounds")
    for item in manifest["files"]:
        if not isinstance(item, dict) or set(item) != {"path", "size", "sha256"}:
            raise ValueError("invalid image manifest entry")
        rel = item["path"]
        if not isinstance(rel, str):
            raise ValueError("invalid image manifest path")
        _safe_relative(rel)
        if (not rel.startswith(IMAGE_PREFIX.as_posix() + "/")
                or not isinstance(item["size"], int) or not 0 < item["size"] <= MAX_FILE_SIZE
                or not isinstance(item["sha256"], str) or not SHA256.fullmatch(item["sha256"])):
            raise ValueError("invalid image manifest member")
    if [item["path"] for item in manifest["files"]] != sorted(
            [item["path"] for item in manifest["files"]], key=str.casefold):
        raise ValueError("image manifest entries are not sorted")
    _safe_directory(output)
    expected = {item["path"]: item for item in manifest["files"]}
    if len(expected) != manifest["file_count"] or sum(item["size"] for item in expected.values()) != manifest["total_size"]:
        raise ValueError("image manifest count or size mismatch")
    actual = set()
    for rel, file in _iter_image_files(output):
        if rel == "manifest.json":
            continue
        actual.add(rel)
        _safe_relative(rel)
        entry = expected.get(rel)
        if entry is None or _hash_file(file) != (entry["size"], entry["sha256"]):
            raise ValueError(f"image member differs from manifest: {rel}")
    if actual != set(expected):
        raise ValueError("image manifest lacks files or has unexpected files")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop-dir", type=Path, required=True)
    parser.add_argument("--lock-file", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--expected-lock-sha256", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--producer-receipt", type=Path, required=True)
    args = parser.parse_args()
    manifest = build_image(args.desktop_dir, args.lock_file, args.source_sha, args.output_dir,
                           args.expected_lock_sha256, args.producer_receipt)
    verify_image(args.output_dir, manifest)
    print(json.dumps({"output": str(args.output_dir), "file_count": manifest["file_count"],
                      "total_size": manifest["total_size"]}, sort_keys=True))


if __name__ == "__main__":
    main()
