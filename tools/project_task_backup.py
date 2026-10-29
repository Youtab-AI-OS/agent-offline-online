"""Strict local project-task file snapshots. No network, Git, or chat mutation.

A READY receipt is produced only after every ordinary file has been copied and
verified. Unlike optional convenience checkpoints, coverage or storage failures
are errors. This is recovery infrastructure, not an operating-system sandbox.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from youtab_constants import get_youtab_home

VERSION = 1
MAX_ENTRIES = 100_000
MAX_BYTES = 8 * 1024 ** 3
MAX_DEPTH = 128
_ID = re.compile(r"^[a-f0-9]{32}$")
_locks: dict[str, threading.RLock] = {}
_locks_lock = threading.Lock()


class ProjectBackupError(RuntimeError):
    """No effect may rely on a failed or incomplete project snapshot."""


@contextmanager
def _lock(root: str, *, home: Path | None = None):
    """One reentrant, cross-process lease per profile family, including nested roots.

    Kept deliberately coarse: separate path locks would miss overlapping roots.
    Only native file handlers hold it across effects; delegated/terminal/code
    work must not hold a lease while waiting for a child Runtime process.
    """
    from youtab_agent_cli.auth_storage import _auth_lock_holder_for, _file_lock, fcntl, msvcrt
    if fcntl is None and msvcrt is None:
        raise ProjectBackupError("A cross-process backup lease is unavailable on this platform.")
    selected = Path(home or get_youtab_home()).resolve(strict=True)
    family = selected.parent.parent if selected.parent.name == "profiles" else selected
    checked_path(family)
    base = family / "backups"
    with _locks_lock:
        local = _locks.setdefault(str(family), threading.RLock())
    with local:
        _private_dir(base)
        path = base / "project-task-effects.lock"
        if not path.exists():
            with _new_file(path) as handle:
                handle.write(b" ")
        checked_path(path, directory=False)
        try:
            with _file_lock(path, _auth_lock_holder_for(path), 10.0,
                            "Another project operation is busy; wait for it to finish and retry."):
                yield
        except TimeoutError as error:
            raise ProjectBackupError(str(error)) from error


def checked_path(value: str | Path, *, directory: bool = True) -> Path:
    path = Path(os.path.abspath(os.path.expanduser(str(value))))
    if not Path(value).expanduser().is_absolute():
        raise ProjectBackupError("Choose an absolute project folder.")
    for component in (*reversed(path.parents), path):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ProjectBackupError(f"Linked/reparse paths are not covered: {component}")
        if component != path and not stat.S_ISDIR(info.st_mode):
            raise ProjectBackupError("A project path parent is not a directory.")
    if not directory and not stat.S_ISREG(path.lstat().st_mode):
        raise ProjectBackupError("A backup file must be an ordinary file.")
    if directory and not path.is_dir():
        raise ProjectBackupError("Choose an existing project folder.")
    if path.resolve(strict=True) != path:
        raise ProjectBackupError("Project path resolution changed.")
    return path


def validate_root(value: str | Path, base: Path) -> Path:
    path = checked_path(value)
    if path == Path(path.anchor) or Path.home().is_relative_to(path) or base.is_relative_to(path):
        raise ProjectBackupError("This folder is too broad or contains Youtab backups. Choose a specific project folder with + PROJECT or Settings > Workspace.")
    return path


def _private_dir(path: Path):
    if not path.exists():
        checked_path(path.parent)
        path.mkdir(mode=0o700)
    checked_path(path)
    if os.name == "nt":
        from youtab_agent_cli.secret_env import _restrict_windows_file
        _restrict_windows_file(path)
    else:
        os.chmod(path, 0o700)
        if stat.S_IMODE(path.stat().st_mode) != 0o700:
            raise ProjectBackupError("Private backup directory permissions could not be established.")


def _new_file(path: Path):
    from youtab_agent_cli.secret_env import _restrict_stage
    checked_path(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    try:
        _restrict_stage(path, fd)
        return os.fdopen(fd, "wb")
    except BaseException:
        os.close(fd)
        raise


def _write_json(path: Path, body: dict):
    data = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    with _new_file(path) as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    return hashlib.sha256(data).hexdigest()


def _hash(path: Path) -> str:
    checked_path(path, directory=False)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _relative(value: str) -> Path:
    path = Path(value)
    if not value or path.is_absolute() or any(piece in (".", "..") for piece in path.parts) or ":" in value or "\\" in value:
        raise ProjectBackupError("Invalid backup relative path.")
    return path


def _inventory(root: Path, excluded: tuple[str, ...] = (), cancelled=None) -> dict[str, dict]:
    result = {}
    total = 0
    def visit(directory: Path, depth: int):
        nonlocal total
        if depth > MAX_DEPTH:
            raise ProjectBackupError("Backup depth limit exceeded; no files were skipped.")
        checked_path(directory)
        for entry in sorted(directory.iterdir(), key=lambda item: item.name):
            if cancelled and cancelled():
                raise ProjectBackupError("Backup canceled before tool dispatch.")
            relative = entry.relative_to(root).as_posix()
            if relative in excluded:
                continue
            info = entry.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ProjectBackupError(f"Backup cannot cover a linked/reparse entry: {entry}")
            if len(result) >= MAX_ENTRIES:
                raise ProjectBackupError("Backup entry limit exceeded; no files were silently skipped.")
            if stat.S_ISDIR(info.st_mode):
                result[relative] = {"kind": "dir"}
                visit(entry, depth + 1)
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > MAX_BYTES:
                    raise ProjectBackupError("Backup exceeds 8 GiB; no partial coverage is accepted.")
                result[relative] = {"kind": "file", "size": info.st_size, "mtime_ns": info.st_mtime_ns,
                                    "dev": info.st_dev, "ino": info.st_ino, "mode": stat.S_IMODE(info.st_mode)}
            else:
                raise ProjectBackupError(f"Backup cannot cover a non-regular entry: {entry}")
    visit(root, 0)
    return result


_LOCAL_PREFIX = ".youtab-task-backups-v1-"


def _owned_local_stores(source: Path, *, create: bool = False) -> list[Path]:
    container = source / "Youtab"
    if not container.exists():
        if not create:
            return []
        checked_path(source)
        container.mkdir()
    checked_path(container)
    owned = []
    for child in container.iterdir():
        suffix = child.name.removeprefix(_LOCAL_PREFIX)
        if not child.name.startswith(_LOCAL_PREFIX) or not _ID.fullmatch(suffix):
            continue
        checked_path(child)
        marker = child / "youtab-backup-owner.json"
        checked_path(marker, directory=False)
        if marker.stat().st_size > 4096:
            raise ProjectBackupError("Project backup ownership marker is invalid.")
        body = json.loads(marker.read_text(encoding="utf-8"))
        if body != {"version": VERSION, "id": suffix, "source": str(source)}:
            raise ProjectBackupError("Project backup ownership marker does not match this folder.")
        owned.append(child)
    if not owned and create:
        identifier = uuid.uuid4().hex
        destination = container / (_LOCAL_PREFIX + identifier)
        # Exclusive ownership: never adopt/overwrite a pre-existing user folder.
        destination.mkdir(mode=0o700)
        _private_dir(destination)
        _write_json(destination / "youtab-backup-owner.json", {"version": VERSION, "id": identifier, "source": str(source)})
        owned.append(destination)
    return sorted(owned)


def _mirror_snapshot(directory: Path, destination: Path):
    destination.mkdir(mode=0o700)  # no existing-target merge or overwrite
    _private_dir(destination)
    inventory = _inventory(directory)
    for relative, metadata in inventory.items():
        source = directory / _relative(relative)
        target = destination / _relative(relative)
        if metadata["kind"] == "dir":
            _private_dir(target)
        else:
            with source.open("rb") as input_file, _new_file(target) as output_file:
                while chunk := input_file.read(1024 * 1024):
                    output_file.write(chunk)
                output_file.flush()
                os.fsync(output_file.fileno())
            if _hash(source) != _hash(target):
                raise ProjectBackupError("Retained project-local backup hash verification failed.")


def snapshot(roots: list[dict], task_id: str, *, home: Path | None = None, cancelled=None) -> dict:
    """Create a complete verified snapshot; failures never return READY."""
    home = checked_path(Path(home or get_youtab_home()).resolve(strict=True))
    base = home / "backups"
    _private_dir(base)
    base = base / "project-tasks-v1"
    _private_dir(base)
    if not roots:
        raise ProjectBackupError("Choose a project folder before running file-changing tools.")
    normalized = []
    for index, root in enumerate(roots):
        path = validate_root(root["path"], base)
        exclusions = tuple(root.get("excluded", ()))
        for excluded in exclusions:
            _relative(excluded)
        if exclusions and (index != 1 or len(roots) != 2 or exclusions != (Path(roots[0]["path"]).relative_to(path).as_posix(),)):
            raise ProjectBackupError("Only the separately backed working-copy subtree may be excluded from source coverage.")
        normalized.append({"path": str(path), "excluded": exclusions, "label": f"root-{index}"})
    workspace = normalized[0]["path"]
    with _lock(workspace, home=home):
        # Local originals remain recoverable even if the application profile is
        # later explicitly uninstalled. Exclude only our validated owned stores.
        local_source = Path(normalized[-1]["path"])
        stores = _owned_local_stores(local_source, create=True)
        for root in normalized:
            root_path = Path(root["path"])
            root_stores = set(stores) | set(_owned_local_stores(root_path))
            managed = [store.relative_to(root_path).as_posix() for store in root_stores if store.is_relative_to(root_path)]
            root["excluded"] = tuple(sorted(set(root["excluded"]) | set(managed)))
        identifier = uuid.uuid4().hex
        destination = base / identifier
        _private_dir(destination)
        captured = []
        for root in normalized:
            source = Path(root["path"])
            inventory = _inventory(source, root["excluded"], cancelled)
            target = destination / root["label"]
            _private_dir(target)
            entries = []
            for relative, metadata in inventory.items():
                if cancelled and cancelled():
                    raise ProjectBackupError("Backup canceled before tool dispatch.")
                rel = _relative(relative)
                original = source / rel
                copied = target / rel
                if metadata["kind"] == "dir":
                    _private_dir(copied)
                    entries.append({"path": relative, "kind": "dir"})
                    continue
                checked_path(original, directory=False)
                before = original.lstat()
                flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
                digest = hashlib.sha256()
                count = 0
                with os.fdopen(os.open(original, flags), "rb") as input_file:
                    if not os.path.samestat(before, os.fstat(input_file.fileno())):
                        raise ProjectBackupError("A source file changed before backup read.")
                    with _new_file(copied) as output_file:
                        while chunk := input_file.read(1024 * 1024):
                            if cancelled and cancelled():
                                raise ProjectBackupError("Backup canceled before tool dispatch.")
                            count += len(chunk)
                            if count > metadata["size"]:
                                raise ProjectBackupError("A source file grew while backing up.")
                            digest.update(chunk)
                            output_file.write(chunk)
                        output_file.flush()
                        os.fsync(output_file.fileno())
                    after = os.fstat(input_file.fileno())
                    if count != metadata["size"] or after.st_mtime_ns != metadata["mtime_ns"]:
                        raise ProjectBackupError("A source file changed while backing up.")
                sha = digest.hexdigest()
                if _hash(copied) != sha:
                    raise ProjectBackupError("Copied file hash verification failed.")
                entries.append({"path": relative, "kind": "file", "size": count, "sha256": sha, "mode": metadata["mode"]})
            if _inventory(source, root["excluded"], cancelled) != inventory:
                raise ProjectBackupError("Project changed during backup. Retry after other writers finish.")
            captured.append({**root, "excluded": list(root["excluded"]), "entries": entries})
        manifest = {"version": VERSION, "status": "READY", "id": identifier,
                    "task_sha256": hashlib.sha256(task_id.encode()).hexdigest(), "created_at": int(time.time()), "roots": captured,
                    "retained_directory": str(stores[0] / identifier)}
        manifest_hash = _write_json(destination / "manifest.json", manifest)
        receipt = {"version": VERSION, "status": "READY", "id": identifier, "manifest_sha256": manifest_hash,
                   "workspace": workspace, "directory": str(destination), "retained_directory": manifest["retained_directory"]}
        _mirror_snapshot(destination, Path(manifest["retained_directory"]))
        verify(receipt, home=home)
        return receipt


def _load(identifier: str, workspace: str, home: Path) -> tuple[Path, dict]:
    if not _ID.fullmatch(identifier):
        raise ProjectBackupError("Invalid project backup identifier.")
    directory = checked_path(home / "backups" / "project-tasks-v1" / identifier)
    path = directory / "manifest.json"
    checked_path(path, directory=False)
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ProjectBackupError("Backup manifest is too large.")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("version") != VERSION or manifest.get("status") != "READY" or manifest.get("id") != identifier:
        raise ProjectBackupError("No verified READY backup exists.")
    roots = manifest.get("roots")
    if not isinstance(roots, list) or not roots or roots[0].get("path") != str(checked_path(workspace)):
        raise ProjectBackupError("Backup does not belong to this project workspace.")
    return directory, manifest


def verify(receipt: dict, *, home: Path | None = None) -> dict:
    home = checked_path(Path(home or get_youtab_home()).resolve(strict=True))
    directory, manifest = _load(receipt["id"], receipt["workspace"], home)
    if _hash(directory / "manifest.json") != receipt["manifest_sha256"]:
        raise ProjectBackupError("Backup manifest changed after admission.")
    _verify_payload(directory, manifest)
    retained = Path(manifest["retained_directory"])
    source = checked_path(manifest["roots"][-1]["path"])
    if retained.name != receipt["id"] or retained.parent not in _owned_local_stores(source):
        raise ProjectBackupError("Retained project backup does not belong to this workspace.")
    checked_path(retained)
    if _hash(retained / "manifest.json") != receipt["manifest_sha256"]:
        raise ProjectBackupError("Retained project backup manifest verification failed.")
    _verify_payload(retained, manifest)
    return manifest


def _verify_payload(directory: Path, manifest: dict):
    for index, root in enumerate(manifest["roots"]):
        if root.get("label") != f"root-{index}" or len(root.get("entries", [])) > MAX_ENTRIES:
            raise ProjectBackupError("Invalid backup root coverage.")
        for entry in root["entries"]:
            relative = _relative(entry["path"])
            file = directory / root["label"] / relative
            if entry["kind"] == "dir":
                checked_path(file)
            elif entry["kind"] == "file":
                info = checked_path(file, directory=False).stat()
                if not stat.S_ISREG(info.st_mode) or info.st_size != entry["size"] or _hash(file) != entry["sha256"]:
                    raise ProjectBackupError("Backup file verification failed.")
            else:
                raise ProjectBackupError("Invalid backup entry type.")

def list_backups(workspace: str, *, home: Path | None = None) -> list[dict]:
    home = checked_path(Path(home or get_youtab_home()).resolve(strict=True))
    base = home / "backups" / "project-tasks-v1"
    if not base.exists():
        return []
    checked_path(base)
    result = []
    for entry in base.iterdir():
        if not _ID.fullmatch(entry.name):
            continue
        try:
            directory, manifest = _load(entry.name, workspace, home)
            receipt = {"id": entry.name, "workspace": workspace, "manifest_sha256": _hash(directory / "manifest.json")}
            verify(receipt, home=home)
            result.append({"id": entry.name, "created_at": manifest["created_at"],
                           "manifest_sha256": _hash(directory / "manifest.json"), "roots": len(manifest["roots"]),
                           "files": sum(item["kind"] == "file" for root in manifest["roots"] for item in root["entries"]),
                           "retained_directory": manifest["retained_directory"]})
        except (OSError, ValueError, ProjectBackupError):
            continue  # incomplete/other-project snapshots are never advertised READY
    return sorted(result, key=lambda item: item["created_at"], reverse=True)


def _restore_parent(root: Path, target: Path, entries: list[dict], *, create: bool = False):
    covered = {item["path"] for item in entries if item["kind"] == "dir"}
    current = root
    for part in target.parent.relative_to(root).parts:
        current = current / part
        if current.exists() or current.is_symlink():
            checked_path(current)
        elif current.relative_to(root).as_posix() not in covered:
            raise ProjectBackupError("A missing parent folder is not covered by this backup.")
        elif create:
            current.mkdir()
            checked_path(current)


def restore_files(receipt: dict, files: list[str], expected_current: dict[str, str | None], *, home: Path | None = None) -> dict:
    """Restore explicit workspace files only; no chat DB is opened or changed.

    Snapshot binding and expected current hashes are mandatory. New/unrelated
    files are not deleted. A pre-restore snapshot makes undo itself recoverable.
    """
    home = checked_path(Path(home or get_youtab_home()).resolve(strict=True))
    manifest = verify(receipt, home=home)
    root = checked_path(receipt["workspace"])
    allowed = {entry["path"]: entry for entry in manifest["roots"][0]["entries"] if entry["kind"] == "file"}
    if not files or len(set(files)) != len(files):
        raise ProjectBackupError("Choose distinct files to restore.")
    with _lock(str(root), home=home):
        for relative in files:
            if relative not in allowed or relative not in expected_current:
                raise ProjectBackupError("A requested restore file is not covered by this backup/confirmation.")
            target = root / _relative(relative)
            _restore_parent(root, target, manifest["roots"][0]["entries"])
            actual = _hash(target) if target.exists() else None
            if actual != expected_current[relative]:
                raise ProjectBackupError("A file changed since the restore preview. Review again; nothing was restored.")
        undo_roots = [{"path": item["path"]} for item in manifest["roots"]]
        if len(undo_roots) == 2:
            source = Path(undo_roots[1]["path"])
            if root.is_relative_to(source):
                undo_roots[1]["excluded"] = [root.relative_to(source).as_posix()]
        undo = snapshot(undo_roots, "before-files-only-restore", home=home)
        directory = home / "backups" / "project-tasks-v1" / receipt["id"]
        # Preflight every requested file before the first write. Atomic replace
        # per file; an OS failure during a multi-file restore remains recoverable.
        restored = []
        stage = None
        try:
            for relative in files:
                target = root / _relative(relative)
                if (_hash(target) if target.exists() else None) != expected_current[relative]:
                    raise ProjectBackupError("A file changed during restore; use the saved pre-restore backup.")
                _restore_parent(root, target, manifest["roots"][0]["entries"], create=True)
                stage = target.with_name(f".youtab-restore-{uuid.uuid4().hex}.tmp")
                source = directory / "root-0" / _relative(relative)
                with _new_file(stage) as output, source.open("rb") as input_file:
                    while chunk := input_file.read(1024 * 1024):
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if _hash(stage) != allowed[relative]["sha256"]:
                    raise ProjectBackupError("Restore staging hash verification failed; target untouched.")
                # Preserve current access policy rather than replacing a shared
                # project file with the backup store's owner-only staging ACL.
                if target.exists():
                    if os.name == "nt":
                        import win32security
                        security = win32security.GetFileSecurity(str(target), win32security.DACL_SECURITY_INFORMATION)
                        win32security.SetFileSecurity(str(stage), win32security.DACL_SECURITY_INFORMATION, security)
                    else:
                        os.chmod(stage, stat.S_IMODE(target.stat().st_mode))
                os.replace(stage, target)
                restored.append(relative)
        except Exception as error:
            if stage is not None and stage.exists():
                checked_path(stage, directory=False)
                stage.unlink()  # only the unique stage this operation owns
            return {"status": "PARTIAL" if restored else "FAILED", "files": restored,
                    "error": str(error), "undo_receipt": undo, "chats_changed": False}
        return {"status": "RESTORED", "files": restored, "undo_receipt": undo, "chats_changed": False}


_previews: dict[str, dict] = {}
_preview_lock = threading.Lock()


def receipt_for(workspace: str, identifier: str, *, home: Path | None = None) -> dict:
    home = checked_path(Path(home or get_youtab_home()).resolve(strict=True))
    directory, manifest = _load(identifier, workspace, home)
    receipt = {"version": VERSION, "status": "READY", "id": identifier, "workspace": workspace,
               "directory": str(directory), "manifest_sha256": _hash(directory / "manifest.json")}
    verify(receipt, home=home)
    return receipt


def file_page(workspace: str, identifier: str, offset: int = 0, *, home: Path | None = None) -> dict:
    receipt = receipt_for(workspace, identifier, home=home)
    manifest = verify(receipt, home=home)
    files = [item for item in manifest["roots"][0]["entries"] if item["kind"] == "file"]
    if not isinstance(offset, int) or offset < 0 or offset > len(files):
        raise ProjectBackupError("Invalid backup file page.")
    return {"files": [{"path": item["path"], "size": item["size"]} for item in files[offset:offset + 100]],
            "total": len(files), "offset": offset, "next_offset": offset + 100 if offset + 100 < len(files) else None}


def prepare_restore(workspace: str, identifier: str, files: list[str], *, home: Path | None = None) -> dict:
    if not isinstance(files, list) or not files or len(files) > 1000 or len(set(files)) != len(files):
        raise ProjectBackupError("Choose 1–1000 distinct files for this restore.")
    receipt = receipt_for(workspace, identifier, home=home)
    manifest = verify(receipt, home=home)
    covered = {item["path"]: item for item in manifest["roots"][0]["entries"] if item["kind"] == "file"}
    current = {}
    for relative in files:
        if relative not in covered:
            raise ProjectBackupError("A selected file is not part of this project backup.")
        target = Path(workspace) / _relative(relative)
        _restore_parent(Path(workspace), target, manifest["roots"][0]["entries"])
        current[relative] = _hash(target) if target.exists() else None
    token = uuid.uuid4().hex
    record = {"workspace": workspace, "id": identifier, "receipt": receipt, "files": files[:], "current": current,
              "expires": time.monotonic() + 300}
    with _preview_lock:
        for key in list(_previews):
            if _previews[key]["expires"] < time.monotonic():
                del _previews[key]
        if len(_previews) >= 100:
            raise ProjectBackupError("Too many pending restore previews; close old previews and retry later.")
        _previews[token] = record
    return {"token": token, "expires_in_seconds": 300, "files": [{"path": file, "changed": current[file] != covered[file]["sha256"],
                "current_sha256": current[file], "backup_sha256": covered[file]["sha256"]} for file in files], "chats_changed": False}


def commit_restore(workspace: str, identifier: str, token: str, confirmed: bool, *, home: Path | None = None) -> dict:
    if confirmed is not True or not isinstance(token, str) or not _ID.fullmatch(token):
        raise ProjectBackupError("Explicit confirmation of a current restore preview is required.")
    with _preview_lock:
        record = _previews.pop(token, None)
    if not record or record["expires"] < time.monotonic() or record["workspace"] != workspace or record["id"] != identifier:
        raise ProjectBackupError("Restore preview expired, was already used, or belongs to another project. Review again.")
    return restore_files(record["receipt"], record["files"], record["current"], home=home)
