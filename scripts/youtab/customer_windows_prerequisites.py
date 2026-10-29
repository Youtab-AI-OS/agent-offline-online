"""Build and verify a bounded, hash-pinned Windows customer prerequisite tree.

The tree is an input to the existing Runtime ZIP, not a second installer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tomllib
from urllib.parse import unquote, urlsplit

SHA256 = re.compile(r"[0-9a-f]{64}\Z")
SOURCE = re.compile(r"[0-9a-f]{40}\Z")
ROOT = "customer-prerequisites/windows-x64"
MAX_FILES = 150
MAX_SIZE = 320 * 1024 * 1024


def verify_lock_wheels(lock_path: Path, pins: dict) -> None:
    """Require every distributed wheel to have its exact name and hash in uv.lock."""
    lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    locked: dict[str, str] = {}
    for package in lock["package"]:
        for wheel in package.get("wheels", []):
            filename = wheel.get("filename") or unquote(
                urlsplit(wheel["url"]).path.rsplit("/", 1)[-1])
            sha256 = wheel["hash"]
            if not sha256.startswith("sha256:") or not SHA256.fullmatch(sha256[7:]):
                raise ValueError("invalid wheel hash in uv.lock")
            if filename in locked and locked[filename] != sha256[7:]:
                raise ValueError("conflicting wheel in uv.lock")
            locked[filename] = sha256[7:]
    for wheel in pins["files"]:
        if locked.get(wheel["name"]) != wheel["sha256"]:
            raise ValueError(f"wheel not pinned by uv.lock: {wheel['name']}")


def digest(path: Path) -> tuple[int, str]:
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or getattr(info, "st_file_attributes", 0) & 0x400):
        raise ValueError(f"linked or irregular prerequisite file: {path}")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    if path.lstat().st_size != info.st_size:
        raise ValueError("prerequisite file changed during hashing")
    return info.st_size, h.hexdigest()


def verify(root: Path, source_sha: str, lock_sha256: str) -> tuple[bytes, list[dict]]:
    """Validate all actual bytes, package identity and exact declared inventory."""
    if not SOURCE.fullmatch(source_sha) or not SHA256.fullmatch(lock_sha256):
        raise ValueError("invalid prerequisite identity")
    root_info = root.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or getattr(root_info, "st_file_attributes", 0) & 0x400:
        raise ValueError("prerequisite root is a redirect or non-directory")
    manifest_path = root / "manifest.json"
    digest(manifest_path)
    raw = manifest_path.read_bytes()
    if not 100 < len(raw) < 48_000:
        raise ValueError("prerequisite manifest outside bounds")
    manifest = json.loads(raw)
    if (set(manifest) != {"schema", "platform", "arch", "source_sha", "uv_lock_sha256",
                         "files", "file_count", "total_size"}
            or manifest["schema"] != 1 or manifest["platform"] != "windows"
            or manifest["arch"] != "x64" or manifest["source_sha"] != source_sha
            or manifest["uv_lock_sha256"] != lock_sha256):
        raise ValueError("prerequisite manifest identity differs")
    files = manifest["files"]
    if (not isinstance(files, list) or not 4 <= len(files) <= MAX_FILES
            or manifest["file_count"] != len(files)
            or type(manifest["total_size"]) is not int or manifest["total_size"] > MAX_SIZE):
        raise ValueError("prerequisite inventory outside bounds")
    pins = json.loads((Path(__file__).parents[2] / "config" /
                       "windows-customer-wheelhouse.json").read_text(encoding="utf-8"))
    reviewed = json.loads((Path(__file__).parents[2] / "config" /
                           "windows-private-home-prerequisites.json").read_text(encoding="utf-8"))
    if pins["uv_lock_sha256"] != lock_sha256:
        raise ValueError("prerequisites differ from the reviewed uv.lock")
    pin_files = {f"wheelhouse/{entry['name']}": (entry["size"], entry["sha256"])
                 for entry in pins["files"]}
    pin_files.update({"uv.zip": (None, reviewed["uv"]["sha256"]),
                      "python.tar.gz": (None, reviewed["python"]["sha256"]),
                      "requirements.txt": (None, pins["requirements_sha256"])})
    expected: set[str] = set()
    total = 0
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise ValueError("invalid prerequisite record")
        relative = entry["path"]
        if (not isinstance(relative, str) or not re.fullmatch(
                r"(?:uv\.zip|python\.tar\.gz|requirements\.txt|wheelhouse/[A-Za-z0-9_.+\-]+\.whl)", relative)
                or relative.casefold() in expected
                or type(entry["size"]) is not int or not 0 < entry["size"] < 130_000_000
                or not isinstance(entry["sha256"], str) or not SHA256.fullmatch(entry["sha256"])):
            raise ValueError("unsafe prerequisite record")
        if digest(root / relative) != (entry["size"], entry["sha256"]):
            raise ValueError(f"prerequisite differs: {relative}")
        if relative not in pin_files or pin_files[relative][1] != entry["sha256"] or (
                pin_files[relative][0] is not None and pin_files[relative][0] != entry["size"]):
            raise ValueError("prerequisite differs from committed closure")
        expected.add(relative.casefold())
        total += entry["size"]
    if (expected != {name.casefold() for name in pin_files}
            or total != manifest["total_size"]
            or [entry["path"] for entry in files] != sorted(
                (entry["path"] for entry in files), key=str.casefold)):
        raise ValueError("prerequisite inventory incomplete or inconsistent")
    actual = set()
    for current, directories, filenames in os.walk(root, followlinks=False):
        for name in directories:
            path = Path(current) / name
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("prerequisite directory is a redirect")
        for name in filenames:
            actual.add((Path(current) / name).relative_to(root).as_posix().casefold())
    if actual != expected | {"manifest.json"}:
        raise ValueError("unlisted prerequisite file")
    return raw, files


def build(root: Path, source_sha: str, lock_sha256: str, uv: Path, python: Path,
          requirements: Path, wheels: Path, wheel_manifest: Path) -> dict:
    if root.exists():
        raise FileExistsError(root)
    pins = json.loads(wheel_manifest.read_text(encoding="utf-8"))
    if (pins["schema"] != 1 or pins["uv_lock_sha256"] != lock_sha256
            or pins["wheel_count"] != len(pins["files"])
            or not 100 <= pins["wheel_count"] <= 145
            or not isinstance(pins["files"], list)):
        raise ValueError("expected reviewed Windows wheel closure")
    if digest(requirements)[1] != pins["requirements_sha256"]:
        raise ValueError("exported requirements differ from reviewed uv.lock closure")
    reviewed = json.loads((Path(__file__).parents[2] / "config" /
                           "windows-private-home-prerequisites.json").read_text(encoding="utf-8"))
    if (digest(uv)[1] != reviewed["uv"]["sha256"]
            or digest(python)[1] != reviewed["python"]["sha256"]):
        raise ValueError("uv or CPython archive differs from committed prerequisite lock")
    items = [("uv.zip", uv), ("python.tar.gz", python),
             ("requirements.txt", requirements)]
    for wheel in pins["files"]:
        name = wheel["name"]
        if not re.fullmatch(r"[A-Za-z0-9_.+\-]+\.whl", name):
            raise ValueError("unsafe wheel name")
        item = wheels / name
        if digest(item) != (wheel["size"], wheel["sha256"]):
            raise ValueError(f"wheel differs from reviewed closure: {name}")
        items.append((f"wheelhouse/{name}", item))
    staged = root.with_name(root.name + ".staging")
    if staged.exists():
        raise FileExistsError(staged)
    staged.mkdir(parents=True)
    try:
        records = []
        for relative, source in sorted(items, key=lambda item: item[0].casefold()):
            size, sha = digest(source)
            target = staged / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target, follow_symlinks=False)
            if digest(target) != (size, sha):
                raise ValueError("prerequisite copy changed")
            records.append({"path": relative, "size": size, "sha256": sha})
        manifest = {"schema": 1, "platform": "windows", "arch": "x64",
                    "source_sha": source_sha, "uv_lock_sha256": lock_sha256,
                    "files": records, "file_count": len(records),
                    "total_size": sum(item["size"] for item in records)}
        (staged / "manifest.json").write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        verify(staged, source_sha, lock_sha256)
        staged.rename(root)
        return manifest
    finally:
        if staged.exists():
            shutil.rmtree(staged)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--uv-lock", type=Path, required=True)
    parser.add_argument("--uv-archive", type=Path, required=True)
    parser.add_argument("--python-archive", type=Path, required=True)
    parser.add_argument("--wheelhouse", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).parents[2]
    lock_sha256 = digest(args.uv_lock)[1]
    if args.uv_lock.resolve() != (repo / "uv.lock").resolve():
        raise ValueError("prerequisites require the source checkout uv.lock")
    pins = json.loads((repo / "config/windows-customer-wheelhouse.json").read_text(
        encoding="utf-8"))
    verify_lock_wheels(args.uv_lock, pins)
    result = build(args.output, args.source_sha, lock_sha256, args.uv_archive,
                   args.python_archive, repo / "config/windows-customer-requirements.txt",
                   args.wheelhouse, repo / "config/windows-customer-wheelhouse.json")
    print(json.dumps({"output": str(args.output), "file_count": result["file_count"],
                      "total_size": result["total_size"]}, sort_keys=True))


if __name__ == "__main__":
    main()
