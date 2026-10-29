#!/usr/bin/env python3
"""Combine verified producer components for the single Windows Runtime ZIP.

Input directories are immutable build outputs, never developer caches. The
result uses install-root-relative paths and one manifest for release.py.
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
import tempfile

try:
    from .build_customer_windows_image import verify_image as verify_desktop_image
    from .customer_windows_producer_receipt import verify_receipt
except ImportError:  # Direct producer CLI invocation.
    from build_customer_windows_image import verify_image as verify_desktop_image
    from customer_windows_producer_receipt import verify_receipt

SHA256 = re.compile(r"[a-f0-9]{64}\Z")
SHA = re.compile(r"[a-f0-9]{40}\Z")
MAX_FILES = 25_000
MAX_TOTAL = 3 * 1024 * 1024 * 1024
MAX_FILE = 768 * 1024 * 1024
RUNTIME_PREFIXES = ("node/", "browser/", "ui-tui/dist/", "youtab_agent_cli/web_dist/")


def _digest(path: Path) -> tuple[int, str]:
    meta = path.lstat()
    if (not stat.S_ISREG(meta.st_mode) or stat.S_ISLNK(meta.st_mode)
            or meta.st_nlink != 1 or getattr(meta, "st_file_attributes", 0) & 0x400):
        raise ValueError(f"component is not a single-link regular file: {path}")
    if meta.st_size > MAX_FILE:
        raise ValueError(f"component file is outside size bounds: {path}")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as reader:
        for block in iter(lambda: reader.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
            if size > MAX_FILE:
                raise ValueError(f"component file grew outside size bounds: {path}")
    if size != meta.st_size or path.lstat().st_size != size:
        raise ValueError(f"component changed during read: {path}")
    return size, digest.hexdigest()


def _safe_path(relative: str) -> None:
    if (not isinstance(relative, str) or not relative or relative.startswith("/")
            or "\\" in relative or any(part in {"", ".", ".."} or ":" in part
                                  or part.endswith((".", " ")) for part in relative.split("/"))):
        raise ValueError("unsafe component path")


def _read_manifest(path: Path) -> dict:
    size, _ = _digest(path)
    if not 0 < size <= 8 * 1024 * 1024:
        raise ValueError("component manifest is outside bounds")
    result = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise ValueError("component manifest must be an object")
    return result


def _safe_directory(path: Path) -> None:
    meta = path.lstat()
    if (not stat.S_ISDIR(meta.st_mode) or stat.S_ISLNK(meta.st_mode)
            or getattr(meta, "st_file_attributes", 0) & 0x400):
        raise ValueError(f"component directory is a link or non-directory: {path}")


def _safe_runtime_file(root: Path, relative: str) -> Path:
    path = root / relative
    parent = path.parent
    while True:
        _safe_directory(parent)
        if parent == root:
            break
        if root not in parent.parents:
            raise ValueError("runtime member escaped its component root")
        parent = parent.parent
    return path


def _verify_runtime(root: Path, manifest: dict, desktop: dict) -> list[dict]:
    _safe_directory(root)
    required = {"schema_version", "platform", "architecture", "source_sha", "lock_sha256",
                "source_qualified", "producer_receipt_sha256",
                "components", "agent_browser_version", "playwright_chromium_revision",
                "playwright_ffmpeg_revision", "playwright_winldd_revision",
                "browser_tree_sha256", "dashboard_tree_sha256", "node_sha256", "agent_browser_sha256",
                "playwright_browsers_json_sha256", "file_count", "total_size", "tree_sha256", "files"}
    if (set(manifest) != required or manifest["schema_version"] != 1
            or manifest["platform"] != "windows" or manifest["architecture"] != "x64"
            or manifest["components"] != ["browser", "dashboard", "node", "tui"]
            or manifest["source_qualified"] is not True
            or manifest["source_sha"] != desktop["source_sha"]
            or manifest["lock_sha256"] != desktop["lock_sha256"]
            or manifest["producer_receipt_sha256"] != desktop["producer_receipt_sha256"]):
        raise ValueError("runtime and Desktop component identities differ")
    for key in ("browser_tree_sha256", "dashboard_tree_sha256", "node_sha256", "agent_browser_sha256",
                "playwright_browsers_json_sha256", "tree_sha256"):
        if not isinstance(manifest[key], str) or not SHA256.fullmatch(manifest[key]):
            raise ValueError(f"invalid runtime {key}")
    revision = manifest["playwright_chromium_revision"]
    if (not isinstance(revision, str) or not re.fullmatch(r"[1-9]\d{2,5}", revision)
            or not isinstance(manifest["agent_browser_version"], str)
            or not re.fullmatch(r"\d+\.\d+\.\d+", manifest["agent_browser_version"])):
        raise ValueError("invalid browser component version")
    for key in ("playwright_ffmpeg_revision", "playwright_winldd_revision"):
        if not isinstance(manifest[key], str) or not re.fullmatch(r"[1-9]\d{2,5}", manifest[key]):
            raise ValueError(f"invalid {key}")
    records = manifest["files"]
    if (not isinstance(records, list) or type(manifest["file_count"]) is not int
            or not 3 <= manifest["file_count"] <= MAX_FILES
            or type(manifest["total_size"]) is not int
            or not 3 <= manifest["total_size"] <= MAX_TOTAL
            or len(records) != manifest["file_count"]):
        raise ValueError("runtime component inventory is outside bounds")
    seen: set[str] = set()
    total = 0
    all_digest = hashlib.sha256()
    browser_digest = hashlib.sha256()
    dashboard_digest = hashlib.sha256()
    for record in records:
        if not isinstance(record, dict) or set(record) != {"path", "size", "sha256"}:
            raise ValueError("invalid runtime file record")
        rel = record["path"]
        _safe_path(rel)
        if (not rel.startswith(RUNTIME_PREFIXES) or rel.casefold() in seen
                or type(record["size"]) is not int or not 0 <= record["size"] <= MAX_FILE
                or not isinstance(record["sha256"], str)
                or not SHA256.fullmatch(record["sha256"])):
            raise ValueError("invalid or duplicate runtime file")
        if record["size"] == 0 and not (rel.startswith("browser/ms-playwright/")
                and Path(rel).name in {"DEPENDENCIES_VALIDATED", "INSTALLATION_COMPLETE"}):
            raise ValueError("unexpected empty runtime file")
        seen.add(rel.casefold())
        total += record["size"]
        line = f'{rel}\0{record["size"]}\0{record["sha256"]}\n'.encode("utf-8")
        all_digest.update(line)
        if rel.startswith("browser/ms-playwright/") and rel != "browser/ms-playwright/browsers.json":
            browser_digest.update(line)
        if rel.startswith("youtab_agent_cli/web_dist/"):
            dashboard_digest.update(line)
        if _digest(_safe_runtime_file(root, rel)) != (record["size"], record["sha256"]):
            raise ValueError(f"runtime file differs from manifest: {rel}")
    if ([item["path"] for item in records] != sorted((item["path"] for item in records), key=str.casefold)
            or total != manifest["total_size"] or all_digest.hexdigest() != manifest["tree_sha256"]
            or browser_digest.hexdigest() != manifest["browser_tree_sha256"]
            or dashboard_digest.hexdigest() != manifest["dashboard_tree_sha256"]):
        raise ValueError("runtime inventory digest or ordering differs")
    indexed = {record["path"]: record for record in records}
    required_paths = ("node/node.exe", "browser/agent-browser.exe", "ui-tui/dist/entry.js",
                      "youtab_agent_cli/web_dist/index.html",
                      "browser/ms-playwright/browsers.json",
                      f"browser/ms-playwright/chromium-{revision}/chrome-win64/chrome.exe",
                      f"browser/ms-playwright/chromium_headless_shell-{revision}/chrome-headless-shell-win64/chrome-headless-shell.exe",
                      f'browser/ms-playwright/ffmpeg-{manifest["playwright_ffmpeg_revision"]}/ffmpeg-win64.exe',
                      f'browser/ms-playwright/winldd-{manifest["playwright_winldd_revision"]}/PrintDeps.exe')
    if not all(path in indexed for path in required_paths):
        raise ValueError("runtime lacks a required Node, browser or TUI file")
    if (indexed["node/node.exe"]["sha256"] != manifest["node_sha256"]
            or indexed["browser/agent-browser.exe"]["sha256"] != manifest["agent_browser_sha256"]
            or indexed["browser/ms-playwright/browsers.json"]["sha256"]
            != manifest["playwright_browsers_json_sha256"]):
        raise ValueError("runtime executable hashes differ from manifest")
    actual: set[str] = set()
    for base, dirs, files in os.walk(root, followlinks=False):
        parent = Path(base)
        _safe_directory(parent)
        for name in dirs:
            directory = parent / name
            _safe_directory(directory)
        for name in files:
            rel = (parent / name).relative_to(root).as_posix()
            _safe_path(rel)
            if rel == "payload-manifest.json":
                continue
            actual.add(rel.casefold())
            _digest(parent / name)
    if actual != seen:
        raise ValueError("runtime component has unlisted or missing files")
    return records


def assemble(desktop_root: Path, runtime_root: Path, output: Path,
             producer_receipt: Path | None = None) -> dict:
    desktop_root, runtime_root, output = desktop_root.absolute(), runtime_root.absolute(), output.absolute()
    if output.exists() or any(output == root or output in root.parents or root in output.parents
                              for root in (desktop_root, runtime_root)):
        raise ValueError("output exists or overlaps a component input")
    _safe_directory(desktop_root)
    _safe_directory(runtime_root)
    desktop = _read_manifest(desktop_root / "manifest.json")
    if (not isinstance(desktop.get("source_sha"), str) or not SHA.fullmatch(desktop["source_sha"])
            or not isinstance(desktop.get("lock_sha256"), str)
            or not SHA256.fullmatch(desktop["lock_sha256"])):
        raise ValueError("invalid Desktop source or lock identity")
    verify_desktop_image(desktop_root, desktop)
    runtime = _read_manifest(runtime_root / "payload-manifest.json")
    runtime_files = _verify_runtime(runtime_root, runtime, desktop)
    if producer_receipt is None:
        raise ValueError("combined customer image requires its producer receipt")
    receipt_sha = verify_receipt(producer_receipt, source_sha=desktop["source_sha"],
                                 lock_sha256=desktop["lock_sha256"],
                                 desktop=desktop_root / "apps/desktop/release/win-unpacked",
                                 tui_entry=runtime_root / "ui-tui/dist/entry.js",
                                 web_dist=runtime_root / "youtab_agent_cli/web_dist")
    if receipt_sha != desktop["producer_receipt_sha256"]:
        raise ValueError("component producer receipt hash differs")
    receipt_size, _ = _digest(producer_receipt)
    receipt_record = {"path": "producer-receipt.json", "size": receipt_size,
                      "sha256": receipt_sha}
    files = sorted([*desktop["files"], *runtime_files, receipt_record],
                   key=lambda item: item["path"].casefold())
    total = sum(item["size"] for item in files)
    if len(files) > MAX_FILES or total > MAX_TOTAL:
        raise ValueError("combined customer image exceeds bounds")
    manifest = {"schema_version": 1, "platform": "windows", "architecture": "x64",
                "source_sha": desktop["source_sha"], "source_qualified": True,
                "lock_sha256": desktop["lock_sha256"],
                "producer_receipt_sha256": desktop["producer_receipt_sha256"],
                "components": ["browser", "dashboard", "desktop", "node", "tui"],
                "agent_browser_version": runtime["agent_browser_version"],
                "playwright_chromium_revision": runtime["playwright_chromium_revision"],
                "playwright_ffmpeg_revision": runtime["playwright_ffmpeg_revision"],
                "playwright_winldd_revision": runtime["playwright_winldd_revision"],
                "browser_tree_sha256": runtime["browser_tree_sha256"],
                "dashboard_tree_sha256": runtime["dashboard_tree_sha256"],
                "node_sha256": runtime["node_sha256"],
                "agent_browser_sha256": runtime["agent_browser_sha256"],
                "playwright_browsers_json_sha256": runtime["playwright_browsers_json_sha256"],
                "tree_sha256": "",
                "file_count": len(files), "total_size": total, "files": files}
    combined_digest = hashlib.sha256()
    for item in files:
        combined_digest.update(f'{item["path"]}\0{item["size"]}\0{item["sha256"]}\n'.encode("utf-8"))
    manifest["tree_sha256"] = combined_digest.hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".youtab-combined-", dir=output.parent) as temp:
        staged = Path(temp) / "image"
        staged.mkdir()
        for source_root, records in ((desktop_root, desktop["files"]), (runtime_root, runtime_files),
                                     (producer_receipt.parent, [receipt_record])):
            for record in records:
                src = producer_receipt if record is receipt_record else source_root / record["path"]
                target = staged / record["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, target, follow_symlinks=False)
                if _digest(target) != (record["size"], record["sha256"]):
                    raise ValueError(f'combined image copy changed: {record["path"]}')
        (staged / "manifest.json").write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        staged.rename(output)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop-image", type=Path, required=True)
    parser.add_argument("--runtime-payload", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--producer-receipt", type=Path, required=True)
    args = parser.parse_args()
    result = assemble(args.desktop_image, args.runtime_payload, args.output,
                      args.producer_receipt)
    print(json.dumps({"output": str(args.output), "files": result["file_count"],
                      "total_size": result["total_size"]}, sort_keys=True))


if __name__ == "__main__":
    main()
