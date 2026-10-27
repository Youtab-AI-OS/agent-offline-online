#!/usr/bin/env python3
"""Stage the prebuilt Windows x64 Node, browser and TUI payload.

This producer never downloads or executes a customer dependency. The caller
must independently pin the hashes of binaries that npm's lockfile does not
cover (Node, agent-browser's postinstall exe, and Playwright's browser tree).
The output is a component tree for the single customer-image ZIP assembler.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tarfile

try:
    from .customer_windows_producer_receipt import verify_receipt
except ImportError:  # Direct producer CLI invocation.
    from customer_windows_producer_receipt import verify_receipt

MAX_FILES = 20_000
MAX_TOTAL_BYTES = 2_000_000_000
MAX_FILE_BYTES = 300_000_000
# GitHub Releases asset metadata for v0.26.0 publishes this SHA-256. npm's
# integrity covers the JS tarball, not its separately downloaded native EXE.
# https://github.com/vercel-labs/agent-browser/releases/tag/v0.26.0
OFFICIAL_AGENT_BROWSER_X64_SHA256 = (
    "540fc7d8b3ec8dea2f84df605492d5ca0e1921281adf8543dc0326109c851b2a"
)
# node-v22.23.3-win-x64.zip is pinned in scripts/install.ps1; the executable
# digest is also published in Node's versioned SHASUMS256.txt.
OFFICIAL_NODE_X64_SHA256 = (
    "9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e"
)
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
FORBIDDEN_NAME = re.compile(
    r"(?:^\.env(?:\.|$)|\.(?:map|pem|p12|pfx|key)$|"
    r"(?:^|[._-])(?:secret|credential|password|token)(?:[._-]|$))",
    re.IGNORECASE,
)


class PayloadError(ValueError):
    """An input cannot be attested as a customer runtime component."""


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _require_hash(value: str, label: str) -> str:
    value = value.lower()
    if not SHA256.fullmatch(value):
        raise PayloadError(f"{label} must be a full SHA-256 hex digest")
    return value


def _safe_file(path: Path) -> None:
    if not path.is_file() or path.is_symlink():
        raise PayloadError(f"not a regular file: {path}")
    current = path
    while True:
        meta = current.lstat()
        if stat.S_ISLNK(meta.st_mode) or (
            getattr(meta, "st_file_attributes", 0) & 0x400  # FILE_ATTRIBUTE_REPARSE_POINT
        ):
            raise PayloadError(f"link or reparse point in input: {current}")
        if current == current.parent:
            break
        current = current.parent


def _pe_x64(path: Path) -> None:
    _safe_file(path)
    with path.open("rb") as stream:
        header = stream.read(64)
        if len(header) < 64 or header[:2] != b"MZ":
            raise PayloadError(f"not a PE executable: {path}")
        offset = int.from_bytes(header[0x3C:0x40], "little")
        if offset < 64 or offset > 1_000_000:
            raise PayloadError(f"invalid PE header offset: {path}")
        stream.seek(offset)
        if stream.read(4) != b"PE\0\0" or stream.read(2) != b"\x64\x86":
            raise PayloadError(f"not a Windows x64 executable: {path}")


def _relative(path: Path, root: Path) -> str:
    try:
        parts = path.relative_to(root).parts
    except ValueError as exc:
        raise PayloadError("file outside the browser input root") from exc
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise PayloadError("unsafe browser input path")
    if any(FORBIDDEN_NAME.search(part) for part in parts):
        raise PayloadError(f"forbidden customer file: {'/'.join(parts)}")
    return PurePosixPath(*parts).as_posix()


def _browser_files(root: Path, revisions: dict[str, str]) -> list[tuple[str, Path]]:
    required = {
        f"chromium-{revisions['chromium']}": "chrome-win64/chrome.exe",
        f"chromium_headless_shell-{revisions['chromium-headless-shell']}":
            "chrome-headless-shell-win64/chrome-headless-shell.exe",
        f"ffmpeg-{revisions['ffmpeg']}": "ffmpeg-win64.exe",
        f"winldd-{revisions['winldd']}": "PrintDeps.exe",
    }
    files: list[tuple[str, Path]] = []
    for directory, executable in required.items():
        browser = root / directory
        target = browser / Path(executable)
        _pe_x64(target)
        for base, dirs, names in os.walk(browser, followlinks=False):
            base_path = Path(base)
            for name in dirs:
                entry = base_path / name
                if entry.is_symlink() or (getattr(entry.lstat(), "st_file_attributes", 0) & 0x400):
                    raise PayloadError(f"link or reparse point in browser tree: {entry}")
            for name in names:
                entry = base_path / name
                _safe_file(entry)
                rel = _relative(entry, root)
                files.append((f"browser/ms-playwright/{rel}", entry))
    return files


def _dashboard_files(root: Path) -> list[tuple[str, Path]]:
    _safe_file(root / "index.html")
    files: list[tuple[str, Path]] = []
    for base, dirs, names in os.walk(root, followlinks=False):
        for name in dirs:
            entry = Path(base) / name
            if entry.is_symlink() or (getattr(entry.lstat(), "st_file_attributes", 0) & 0x400):
                raise PayloadError(f"link or reparse point in dashboard tree: {entry}")
        for name in names:
            entry = Path(base) / name
            _safe_file(entry)
            rel = _relative(entry, root)
            files.append((f"youtab_agent_cli/web_dist/{rel}", entry))
    return files


def _lock_versions(
    repo: Path, playwright_package_dir: Path, playwright_package_tarball: Path,
    expected_browsers_json_sha256: str,
) -> tuple[str, str, dict[str, str]]:
    lock_path = repo / "package-lock.json"
    _safe_file(lock_path)
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    packages = lock["packages"]
    agent = packages["node_modules/agent-browser"]
    playwright = packages["node_modules/playwright-core"]
    if agent["version"] != "0.26.0" or playwright["version"] != "1.62.1":
        raise PayloadError("unsupported locked browser dependency versions")
    if not agent.get("integrity") or not playwright.get("integrity"):
        raise PayloadError("npm package integrity missing from lockfile")
    _safe_file(playwright_package_tarball)
    digest = hashlib.sha512()
    with playwright_package_tarball.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    integrity = "sha512-" + base64.b64encode(digest.digest()).decode("ascii")
    if integrity != playwright["integrity"]:
        raise PayloadError("Playwright npm tarball does not match package-lock integrity")
    browsers_path = playwright_package_dir / "browsers.json"
    _safe_file(browsers_path)
    if _sha(browsers_path) != _require_hash(expected_browsers_json_sha256, "browsers.json SHA"):
        raise PayloadError("installed Playwright browser registry hash mismatch")
    package_path = playwright_package_dir / "package.json"
    _safe_file(package_path)
    with tarfile.open(playwright_package_tarball, "r:gz") as archive:
        for member_name, expected_file in (
            ("package/package.json", package_path),
            ("package/browsers.json", browsers_path),
        ):
            member = archive.getmember(member_name)
            if not member.isfile() or member.size > 2_000_000:
                raise PayloadError(f"unsafe Playwright npm member: {member_name}")
            stream = archive.extractfile(member)
            if stream is None or stream.read() != expected_file.read_bytes():
                raise PayloadError(f"extracted Playwright member differs from lock-bound npm tarball: {member_name}")
    package = json.loads(package_path.read_text("utf-8"))
    if package.get("version") != playwright["version"]:
        raise PayloadError("installed Playwright does not match root lockfile")
    browser_entries = json.loads(browsers_path.read_text("utf-8"))["browsers"]
    required_names = {"chromium", "chromium-headless-shell", "ffmpeg", "winldd"}
    revisions = {
        item["name"]: item["revision"] for item in browser_entries
        if item.get("name") in required_names
    }
    if set(revisions) != required_names or revisions["chromium"] != revisions["chromium-headless-shell"]:
        raise PayloadError("Playwright browser revisions are incomplete or inconsistent")
    if any(not re.fullmatch(r"[0-9]+", value) for value in revisions.values()):
        raise PayloadError("invalid Playwright browser revision")
    return _sha(lock_path), agent["version"], revisions


def _inventory(items: list[tuple[str, Path]]) -> tuple[list[dict], str, int]:
    if len(items) > MAX_FILES:
        raise PayloadError("runtime file-count limit exceeded")
    seen: set[str] = set()
    records: list[dict] = []
    total = 0
    for rel, source in sorted(items, key=lambda item: item[0].casefold()):
        key = rel.casefold()
        if key in seen:
            raise PayloadError(f"case-insensitive output collision: {rel}")
        seen.add(key)
        _safe_file(source)
        size = source.stat().st_size
        marker = rel.startswith("browser/ms-playwright/") and PurePosixPath(rel).name in {
            "DEPENDENCIES_VALIDATED", "INSTALLATION_COMPLETE",
        }
        if (size == 0 and not marker) or size > MAX_FILE_BYTES:
            raise PayloadError(f"invalid runtime file size: {rel}")
        total += size
        if total > MAX_TOTAL_BYTES:
            raise PayloadError("runtime size limit exceeded")
        records.append({"path": rel, "size": size, "sha256": _sha(source)})
    digest = hashlib.sha256()
    for item in records:
        digest.update(f'{item["path"]}\0{item["size"]}\0{item["sha256"]}\n'.encode("utf-8"))
    return records, digest.hexdigest(), total


def build_payload(
    *, repo: Path, out: Path, source_sha: str, expected_lock_sha256: str,
    node_exe: Path, node_sha256: str, agent_browser_exe: Path,
    agent_browser_sha256: str, browser_root: Path,
    browser_tree_sha256: str, tui_entry: Path,
    expected_browsers_json_sha256: str,
    playwright_package_dir: Path,
    playwright_package_tarball: Path,
    web_dist: Path,
    allow_dirty_provisional: bool = False,
    producer_receipt: Path | None = None,
) -> dict:
    """Validate and atomically stage a fixed-layout component tree."""
    source_sha = source_sha.lower()
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise PayloadError("source_sha must be a full Git commit SHA")
    current = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True,
    ).strip().lower()
    if current != source_sha:
        raise PayloadError("source Git HEAD differs from the approved source SHA")
    dirty = bool(subprocess.check_output(
        ["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=normal"],
        text=True,
    ).strip())
    if dirty and not allow_dirty_provisional:
        raise PayloadError("source tree is dirty; final runtime payload requires a reviewed commit")
    lock_sha, agent_version, revisions = _lock_versions(
        repo, playwright_package_dir, playwright_package_tarball,
        expected_browsers_json_sha256,
    )
    if lock_sha != _require_hash(expected_lock_sha256, "lock SHA"):
        raise PayloadError("root lockfile hash changed")
    if producer_receipt is None and not allow_dirty_provisional:
        raise PayloadError("final runtime payload requires a producer receipt")
    receipt_sha = (verify_receipt(producer_receipt, source_sha=source_sha,
                                  lock_sha256=lock_sha, tui_entry=tui_entry,
                                  web_dist=web_dist)
                   if producer_receipt is not None else None)
    for path, expected, label in (
        (node_exe, node_sha256, "Node executable"),
        (agent_browser_exe, agent_browser_sha256, "agent-browser executable"),
    ):
        _pe_x64(path)
        if _sha(path) != _require_hash(expected, label):
            raise PayloadError(f"{label} hash mismatch")
    if _sha(agent_browser_exe) != OFFICIAL_AGENT_BROWSER_X64_SHA256:
        raise PayloadError("agent-browser EXE does not match publisher release digest")
    if _sha(node_exe) != OFFICIAL_NODE_X64_SHA256:
        raise PayloadError("Node EXE does not match the pinned Node release digest")
    _safe_file(tui_entry)
    if b"sourceMappingURL" in tui_entry.read_bytes():
        raise PayloadError("TUI bundle carries a source map reference")
    if not node_exe.name.lower() == "node.exe" or not agent_browser_exe.name.lower() == "agent-browser-win32-x64.exe":
        raise PayloadError("unexpected Windows x64 executable names")
    if tui_entry.name != "entry.js":
        raise PayloadError("TUI must be the prebuilt entry.js bundle")
    browser_files = _browser_files(browser_root, revisions)
    dashboard_files = _dashboard_files(web_dist)
    _, browser_hash, _ = _inventory(browser_files)
    if browser_hash != _require_hash(browser_tree_sha256, "browser tree SHA"):
        raise PayloadError("Playwright browser tree hash mismatch")
    items = [
        ("node/node.exe", node_exe),
        ("browser/agent-browser.exe", agent_browser_exe),
        ("browser/ms-playwright/browsers.json", playwright_package_dir / "browsers.json"),
        ("ui-tui/dist/entry.js", tui_entry),
        *browser_files,
        *dashboard_files,
    ]
    records, tree_hash, total = _inventory(items)
    _, dashboard_hash, _ = _inventory(dashboard_files)
    if out.exists():
        raise PayloadError("output already exists; refusing to replace it")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="customer-runtime-", dir=out.parent) as temp:
        stage = Path(temp) / "tree"
        stage.mkdir()
        for record, (_, source) in zip(records, sorted(items, key=lambda item: item[0].casefold())):
            destination = stage / Path(record["path"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            if _sha(destination) != record["sha256"]:
                raise PayloadError(f'copy changed: {record["path"]}')
        manifest = {
            "schema_version": 1,
            "platform": "windows",
            "architecture": "x64",
            "source_sha": source_sha,
            "source_qualified": not dirty,
            "producer_receipt_sha256": receipt_sha,
            "lock_sha256": lock_sha,
            "components": ["browser", "dashboard", "node", "tui"],
            "agent_browser_version": agent_version,
            "playwright_chromium_revision": revisions["chromium"],
            "playwright_ffmpeg_revision": revisions["ffmpeg"],
            "playwright_winldd_revision": revisions["winldd"],
            "browser_tree_sha256": browser_hash,
            "dashboard_tree_sha256": dashboard_hash,
            "node_sha256": _sha(node_exe),
            "agent_browser_sha256": _sha(agent_browser_exe),
            "playwright_browsers_json_sha256": _sha(playwright_package_dir / "browsers.json"),
            "file_count": len(records),
            "total_size": total,
            "tree_sha256": tree_hash,
            "files": records,
        }
        (stage / "payload-manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8",
        )
        stage.rename(out)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "repo", "out", "source-sha", "expected-lock-sha256", "node-exe",
        "node-sha256", "agent-browser-exe", "agent-browser-sha256",
        "browser-root", "browser-tree-sha256", "tui-entry",
        "expected-browsers-json-sha256",
        "playwright-package-dir",
        "playwright-package-tarball",
        "web-dist",
    ):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--allow-dirty-provisional", action="store_true")
    parser.add_argument("--producer-receipt", type=Path)
    args = parser.parse_args(argv)
    try:
        manifest = build_payload(
            repo=Path(args.repo), out=Path(args.out), source_sha=args.source_sha,
            expected_lock_sha256=args.expected_lock_sha256,
            node_exe=Path(args.node_exe), node_sha256=args.node_sha256,
            agent_browser_exe=Path(args.agent_browser_exe),
            agent_browser_sha256=args.agent_browser_sha256,
            browser_root=Path(args.browser_root),
            browser_tree_sha256=args.browser_tree_sha256,
            tui_entry=Path(args.tui_entry),
            expected_browsers_json_sha256=args.expected_browsers_json_sha256,
            playwright_package_dir=Path(args.playwright_package_dir),
            playwright_package_tarball=Path(args.playwright_package_tarball),
            web_dist=Path(args.web_dist),
            allow_dirty_provisional=args.allow_dirty_provisional,
            producer_receipt=args.producer_receipt,
        )
    except (OSError, KeyError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"RUNTIME_PAYLOAD=FAIL: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "PASS", "files": manifest["file_count"], "tree_sha256": manifest["tree_sha256"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
