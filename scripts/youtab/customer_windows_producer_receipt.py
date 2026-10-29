#!/usr/bin/env python3
"""Build and attest customer UI outputs from one exact clean Windows checkout.

The receipt is producer evidence, not a signature. It is written only after the
fixed build sequence succeeds, and component packagers rehash its outputs.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
from urllib.parse import urlsplit

SOURCE = re.compile(r"[a-f0-9]{40}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
NODE_SHA256 = "9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e"
NODE_ARCHIVE_SHA256 = "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71"
NODE_ARCHIVE_PREFIX = "node-v22.23.3-win-x64/"
BUILD_STEPS = (
    "npm ci",
    "npm run build:setup-lease:producer --prefix apps/desktop",
    "npm run build --prefix ui-tui",
    "npm run build --prefix web",
    "npm run pack --prefix apps/desktop",
)
OUTPUTS = (
    "ui-tui/dist",
    "youtab_agent_cli/web_dist",
    "apps/desktop/build",
    "apps/desktop/dist",
    "apps/desktop/release",
)
MAX_FILES = 10_000
MAX_TOTAL = 2 * 1024 * 1024 * 1024
SETUP_RELATIVE = "resources/update-coordination/Youtab-Setup.exe"


def _release_base(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("release base must be an approved Pilot URL")
    url = urlsplit(value)
    if (url.scheme != "https" or url.hostname != "api.youtab.io" or url.port is not None
            or url.username is not None or url.password is not None or url.query or url.fragment
            or not re.fullmatch(r"/pilot-runtime-[0-9a-f]{32,}/releases", url.path)):
        raise ValueError("release base must be an approved Pilot URL")
    return value


def _setup_input(path: Path, source_sha: str, release_base_url: str,
                 expected_sha256: str) -> tuple[int, str]:
    if (not path.is_absolute() or not path.is_file() or path.is_symlink()
            or getattr(path.lstat(), "st_file_attributes", 0) & 0x400
            or path.lstat().st_nlink != 1 or not 64 <= path.stat().st_size <= 256 * 1024 * 1024
            or not SHA256.fullmatch(expected_sha256)):
        raise ValueError("common Setup is not a bounded regular file with a pinned hash")
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha256:
        raise ValueError("common Setup differs from pinned hash")
    pe = int.from_bytes(data[60:64], "little")
    if (data[:2] != b"MZ" or pe < 64 or pe + 26 > len(data)
            or data[pe:pe + 4] != b"PE\0\0" or data[pe + 4:pe + 6] != b"\x64\x86"
            or source_sha.encode() not in data or release_base_url.encode() not in data
            or b"youtab.update-coordination/version1" not in data
            or b"youtab.setup-handoff/version2" not in data):
        raise ValueError("common Setup lacks exact Windows x64 source/update handoff identity")
    return len(data), digest


def _is_windows() -> bool:
    return os.name == "nt"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def _clean_source(repo: Path, source_sha: str, lock_sha256: str) -> None:
    if not SOURCE.fullmatch(source_sha) or _git(repo, "rev-parse", "--verify", "HEAD") != source_sha:
        raise ValueError("producer checkout is not the exact source commit")
    if _git(repo, "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("producer checkout has modified or untracked source")
    if sha256(repo / "package-lock.json") != lock_sha256:
        raise ValueError("producer lockfile differs from exact approved lock")


def _tree_digest(root: Path) -> tuple[int, int, str]:
    if not root.is_dir() or root.is_symlink():
        raise ValueError(f"producer output is not a directory: {root}")
    records: list[tuple[str, int, str]] = []
    total = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        parent = Path(base)
        if parent.is_symlink() or getattr(parent.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("producer output directory is a link")
        for name in dirs:
            child = parent / name
            if child.is_symlink() or getattr(child.lstat(), "st_file_attributes", 0) & 0x400:
                raise ValueError("producer output directory is a link")
        for name in files:
            file = parent / name
            meta = file.lstat()
            if (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or file.is_symlink()
                    or getattr(meta, "st_file_attributes", 0) & 0x400):
                raise ValueError("producer output contains a linked or irregular file")
            rel = file.relative_to(root).as_posix()
            # Desktop image intentionally does not ship source maps. Bind the
            # receipt to exactly the files that its component producer ships.
            if name.casefold().endswith(".map"):
                continue
            if any(part in {"", ".", ".."} or part.endswith((".", " ")) for part in rel.split("/")):
                raise ValueError("producer output has an unsafe path")
            total += meta.st_size
            if total > MAX_TOTAL or len(records) >= MAX_FILES:
                raise ValueError("producer output exceeds bounds")
            records.append((rel, meta.st_size, sha256(file)))
    if not records:
        raise ValueError("producer output is empty")
    digest = hashlib.sha256()
    for rel, size, content in sorted(records, key=lambda item: item[0].casefold()):
        digest.update(f"{rel}\0{size}\0{content}\n".encode())
    return len(records), total, digest.hexdigest()


def verify_receipt(receipt_path: Path, *, source_sha: str, lock_sha256: str,
                   desktop: Path | None = None, tui_entry: Path | None = None,
                   web_dist: Path | None = None) -> str:
    """Check immutable receipt identity and the component bytes used by a packager."""
    if (not SOURCE.fullmatch(source_sha) or not SHA256.fullmatch(lock_sha256)
            or not receipt_path.is_file() or receipt_path.is_symlink()
            or getattr(receipt_path.lstat(), "st_file_attributes", 0) & 0x400):
        raise ValueError("invalid producer receipt path or identity")
    raw = receipt_path.read_bytes()
    if not 100 < len(raw) <= 16_384:
        raise ValueError("producer receipt size is outside bounds")
    receipt = json.loads(raw)
    expected = {"schema_version", "source_sha", "lock_sha256", "node_sha256",
                "npm_version", "steps", "desktop", "web", "tui_sha256", "lease_sha256",
                "release_base_url", "common_setup"}
    if (not isinstance(receipt, dict) or set(receipt) != expected
            or receipt["schema_version"] != 1 or receipt["source_sha"] != source_sha
            or receipt["lock_sha256"] != lock_sha256 or receipt["node_sha256"] != NODE_SHA256
            or not re.fullmatch(r"\d+\.\d+\.\d+", receipt["npm_version"])
            or receipt["steps"] != [{"command": step, "exit_code": 0} for step in BUILD_STEPS]
            or _release_base(receipt["release_base_url"]) != receipt["release_base_url"]
            or not isinstance(receipt["common_setup"], dict)
            or set(receipt["common_setup"]) != {"sha256", "size"}
            or not isinstance(receipt["common_setup"]["sha256"], str)
            or not SHA256.fullmatch(receipt["common_setup"]["sha256"])
            or type(receipt["common_setup"]["size"]) is not int
            or not 64 <= receipt["common_setup"]["size"] <= 256 * 1024 * 1024
            or not isinstance(receipt["desktop"], dict)
            or set(receipt["desktop"]) != {"file_count", "total_size", "tree_sha256"}
            or type(receipt["desktop"]["file_count"]) is not int
            or type(receipt["desktop"]["total_size"]) is not int
            or not 1 <= receipt["desktop"]["file_count"] <= MAX_FILES
            or not 1 <= receipt["desktop"]["total_size"] <= MAX_TOTAL
            or any(not isinstance(receipt[key], str) or not SHA256.fullmatch(receipt[key])
                   for key in ("tui_sha256", "lease_sha256"))
            or not isinstance(receipt["desktop"]["tree_sha256"], str)
            or not SHA256.fullmatch(receipt["desktop"]["tree_sha256"])
            or not isinstance(receipt["web"], dict)
            or set(receipt["web"]) != {"file_count", "total_size", "tree_sha256"}
            or type(receipt["web"]["file_count"]) is not int
            or type(receipt["web"]["total_size"]) is not int
            or not 1 <= receipt["web"]["file_count"] <= MAX_FILES
            or not 1 <= receipt["web"]["total_size"] <= MAX_TOTAL
            or not isinstance(receipt["web"]["tree_sha256"], str)
            or not SHA256.fullmatch(receipt["web"]["tree_sha256"])):
        raise ValueError("invalid or mismatched producer receipt")
    if desktop is not None and _tree_digest(desktop) != (
            receipt["desktop"]["file_count"], receipt["desktop"]["total_size"],
            receipt["desktop"]["tree_sha256"]):
        raise ValueError("Desktop output differs from producer receipt")
    if desktop is not None and sha256(
            desktop / "resources/app.asar.unpacked/dist/native/setup_lease.node") != receipt["lease_sha256"]:
        raise ValueError("native Setup lease differs from producer receipt")
    if desktop is not None:
        stamp = json.loads((desktop / "resources/install-stamp.json").read_text(encoding="utf-8"))
        identity = stamp.get("updateCoordination") if isinstance(stamp, dict) else None
        setup = desktop / SETUP_RELATIVE
        if (stamp.get("releaseBaseUrl") != receipt["release_base_url"]
                or not isinstance(identity, dict) or identity.get("protocol") != 1
                or identity.get("sourceSha") != source_sha or identity.get("handoffProtocol") != 2
                or identity.get("sha256") != receipt["common_setup"]["sha256"]
                or identity.get("size") != receipt["common_setup"]["size"]
                or not setup.is_file() or setup.is_symlink()
                or setup.stat().st_size != receipt["common_setup"]["size"]
                or sha256(setup) != receipt["common_setup"]["sha256"]):
            raise ValueError("packaged common Setup differs from producer receipt")
    if tui_entry is not None and sha256(tui_entry) != receipt["tui_sha256"]:
        raise ValueError("TUI output differs from producer receipt")
    if web_dist is not None:
        if not (web_dist / "index.html").is_file() or _tree_digest(web_dist) != (
                receipt["web"]["file_count"], receipt["web"]["total_size"],
                receipt["web"]["tree_sha256"]):
            raise ValueError("dashboard output differs from producer receipt")
    return hashlib.sha256(raw).hexdigest()


def _remove_output(repo: Path, relative: str) -> None:
    # Fixed allowlist and resolved containment before any recursive deletion.
    if relative not in OUTPUTS:
        raise ValueError("refusing to remove an unapproved producer path")
    target = repo / relative
    resolved_repo = repo.resolve()
    resolved_target = target.resolve()
    if resolved_repo not in resolved_target.parents or resolved_target == resolved_repo:
        raise ValueError("producer output escaped the clean checkout")
    if target.is_symlink():
        raise ValueError("producer output is a link")
    if target.exists():
        if getattr(target.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("producer output is a link")
        shutil.rmtree(target)


def _extract_node(archive: Path, scratch: Path) -> Path:
    if not archive.is_file() or archive.is_symlink() or not 0 < archive.stat().st_size <= 128 * 1024 * 1024:
        raise ValueError("Node archive is missing or outside bounds")
    archive_bytes = archive.read_bytes()
    if hashlib.sha256(archive_bytes).hexdigest() != NODE_ARCHIVE_SHA256:
        raise ValueError("Node archive differs from official pinned ZIP")
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as source:
        names: set[str] = set()
        total = 0
        for member in source.infolist():
            name = member.filename
            if name == NODE_ARCHIVE_PREFIX and member.is_dir():
                continue
            relative = name.removeprefix(NODE_ARCHIVE_PREFIX)
            if (not name.startswith(NODE_ARCHIVE_PREFIX) or not relative
                    or "\\" in relative or any(part in {"", ".", ".."} or ":" in part
                                             or part.endswith((".", " "))
                                             for part in relative.rstrip("/").split("/"))):
                raise ValueError("Node archive contains an unsafe member")
            key = name.casefold()
            if key in names:
                raise ValueError("Node archive has duplicate member names")
            names.add(key)
            total += member.file_size
            if len(names) > MAX_FILES or total > MAX_TOTAL:
                raise ValueError("Node archive exceeds producer bounds")
            destination = scratch / name
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with source.open(member) as input_stream, destination.open("xb") as output:
                    shutil.copyfileobj(input_stream, output)
                if destination.stat().st_size != member.file_size:
                    raise ValueError("Node archive member changed during extraction")
    node = scratch / NODE_ARCHIVE_PREFIX / "node.exe"
    npm = node.parent / "node_modules/npm/bin/npm-cli.js"
    if not npm.is_file() or not node.is_file() or sha256(node) != NODE_SHA256:
        raise ValueError("Node archive lacks its pinned Node and npm executables")
    return node


def run_producer(*, repo: Path, node_archive: Path, receipt_path: Path,
                 source_sha: str, lock_sha256: str, common_setup: Path,
                 common_setup_sha256: str, release_base_url: str) -> dict:
    """Perform the fixed build sequence; never attest caller-supplied output."""
    repo = repo.resolve(strict=True)
    if not _is_windows() or not SOURCE.fullmatch(source_sha) or not SHA256.fullmatch(lock_sha256):
        raise ValueError("producer requires Windows and exact source/lock hashes")
    if repo in receipt_path.resolve().parents:
        raise ValueError("producer receipt and scratch must be outside the clean source checkout")
    _clean_source(repo, source_sha, lock_sha256)
    release_base_url = _release_base(release_base_url)
    setup_size, setup_hash = _setup_input(common_setup, source_sha, release_base_url,
                                         common_setup_sha256)
    if receipt_path.exists():
        raise FileExistsError("immutable producer receipt already exists")
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="youtab-node-producer-", dir=receipt_path.parent) as temp:
        node_exe = _extract_node(node_archive.resolve(strict=True), Path(temp))
        npm_cli = node_exe.parent / "node_modules/npm/bin/npm-cli.js"
        for relative in OUTPUTS:
            _remove_output(repo, relative)
        base_env = os.environ.copy()
        base_env["PATH"] = str(node_exe.parent) + os.pathsep + base_env.get("PATH", "")
        base_env.pop("YOUTAB_AGENT_DEVELOPMENT_COORDINATION", None)
        base_env.pop("YOUTAB_AGENT_CUSTOMER_BUILD", None)
        version = subprocess.check_output([str(node_exe), str(npm_cli), "--version"],
                                          cwd=repo, env=base_env, text=True).strip()
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("npm version could not be verified")
        commands = (
            [str(node_exe), str(npm_cli), "ci"],
            [str(node_exe), str(npm_cli), "run", "build:setup-lease:producer", "--prefix", "apps/desktop"],
            [str(node_exe), str(npm_cli), "run", "build", "--prefix", "ui-tui"],
            [str(node_exe), str(npm_cli), "run", "build", "--prefix", "web"],
            [str(node_exe), str(npm_cli), "run", "pack", "--prefix", "apps/desktop"],
        )
        for index, command in enumerate(commands):
            env = base_env.copy()
            if index == 4:
                lease = repo / "apps/desktop/build/native/setup_lease.node"
                if not lease.is_file():
                    raise ValueError("native Setup lease did not build")
                env.update({"YOUTAB_AGENT_CUSTOMER_BUILD": "1",
                            "YOUTAB_AGENT_RELEASE_BASE_URL": release_base_url,
                            "YOUTAB_AGENT_COORDINATION_SETUP_PATH": str(common_setup),
                            "YOUTAB_AGENT_COORDINATION_SETUP_IDENTITY": json.dumps({
                                "protocol": 1, "sourceSha": source_sha,
                                "sha256": setup_hash, "size": setup_size,
                            }, separators=(",", ":")),
                            "YOUTAB_AGENT_SETUP_LEASE_SHA256": sha256(lease),
                            "YOUTAB_AGENT_SETUP_LEASE_SIZE": str(lease.stat().st_size),
                            "CSC_IDENTITY_AUTO_DISCOVERY": "false"})
            subprocess.run(command, cwd=repo, env=env, check=True)
        # Build tools may write ignored outputs, but must not mutate tracked or
        # newly visible source. This rechecks both HEAD and the lockfile.
        _clean_source(repo, source_sha, lock_sha256)
        desktop = repo / "apps/desktop/release/win-unpacked"
        tui = repo / "ui-tui/dist/entry.js"
        web = repo / "youtab_agent_cli/web_dist"
        lease = repo / "apps/desktop/build/native/setup_lease.node"
        if not tui.is_file() or not lease.is_file():
            raise ValueError("producer build omitted TUI or native Setup lease")
        count, total, tree = _tree_digest(desktop)
        if not (web / "index.html").is_file():
            raise ValueError("producer build omitted dashboard index")
        web_count, web_total, web_tree = _tree_digest(web)
        receipt = {"schema_version": 1, "source_sha": source_sha, "lock_sha256": lock_sha256,
                   "node_sha256": NODE_SHA256, "npm_version": version,
                   "release_base_url": release_base_url,
                   "common_setup": {"sha256": setup_hash, "size": setup_size},
                   "steps": [{"command": step, "exit_code": 0} for step in BUILD_STEPS],
                   "desktop": {"file_count": count, "total_size": total, "tree_sha256": tree},
                   "web": {"file_count": web_count, "total_size": web_total, "tree_sha256": web_tree},
                   "tui_sha256": sha256(tui), "lease_sha256": sha256(lease)}
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    with receipt_path.open("x", encoding="utf-8") as output:
        json.dump(receipt, output, sort_keys=True, separators=(",", ":"))
        output.write("\n")
    verify_receipt(receipt_path, source_sha=source_sha, lock_sha256=lock_sha256,
                   desktop=desktop, tui_entry=tui, web_dist=web)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repo", "node-archive", "receipt", "source-sha", "lock-sha256",
                 "common-setup", "common-setup-sha256", "release-base-url"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    result = run_producer(repo=Path(args.repo), node_archive=Path(args.node_archive),
                          receipt_path=Path(args.receipt), source_sha=args.source_sha,
                          lock_sha256=args.lock_sha256, common_setup=Path(args.common_setup),
                          common_setup_sha256=args.common_setup_sha256,
                          release_base_url=args.release_base_url)
    print(json.dumps({"status": "PASS", "source_sha": result["source_sha"],
                      "receipt": str(args.receipt)}, sort_keys=True))


if __name__ == "__main__":
    main()
