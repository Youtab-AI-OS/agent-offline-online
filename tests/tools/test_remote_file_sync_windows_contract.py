"""Actual remote file transfer, cleanup and tree-link boundaries on the host OS."""

import io
import os
import subprocess
import tarfile
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tools.credential_files import get_skills_directory_mount, iter_skills_files
from tools.environments.file_sync import FileSyncManager


@pytest.mark.parametrize("error", [FileNotFoundError, NotADirectoryError])
def test_disappearing_tree_entries_are_pruned(tmp_path, monkeypatch, error):
    from tools import credential_files

    root = tmp_path / "tree"
    root.mkdir()
    stale_dir = root / "removed-dir"
    stale_file = root / "removed-file"
    live = root / "SKILL.md"
    live.write_text("live", encoding="utf-8")
    real_lstat = Path.lstat
    real_is_symlink = Path.is_symlink

    def stale_lstat(path):
        if path in (stale_dir, stale_file):
            raise error("entry disappeared")
        return real_lstat(path)

    def walk(*args, **kwargs):
        dirs = [stale_dir.name]
        yield str(root), dirs, [stale_file.name, live.name]
        assert dirs == []  # The removed directory must never be descended into.

    monkeypatch.setattr(Path, "lstat", stale_lstat)
    monkeypatch.setattr(Path, "is_symlink", lambda path: False if path in (stale_dir, stale_file) else real_is_symlink(path))
    monkeypatch.setattr(credential_files.os, "walk", walk)
    entries = list(credential_files._iter_tree_entries(root))
    assert [path for path in entries if not credential_files._is_tree_link(path)] == [live]
    sanitized = Path(credential_files._safe_skills_path(root))
    assert (sanitized / "SKILL.md").read_text(encoding="utf-8") == "live"
    assert not (sanitized / stale_dir.name).exists()
    assert not (sanitized / stale_file.name).exists()


@pytest.fixture(autouse=True)
def synthetic_state(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setattr("tools.environments.file_sync._credential_host_paths", lambda: set())


def test_skill_directory_links_do_not_export_external_bytes(tmp_path, monkeypatch):
    home = tmp_path / "home"
    skills = home / "skills"
    skills.mkdir()
    (skills / "SKILL.md").write_text("public skill", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "private-token.txt"
    secret.write_text("synthetic-private-token", encoding="utf-8")
    link = skills / "foreign"
    if os.name == "nt":
        # Junctions require no symlink privilege and exercise real NTFS metadata.
        env = dict(os.environ, YOUTAB_TEST_LINK_DIR=str(link), YOUTAB_TEST_LINK_TARGET=str(outside))
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:YOUTAB_TEST_LINK_DIR -Value $env:YOUTAB_TEST_LINK_TARGET | Out-Null"],
            env=env, capture_output=True, text=True, check=False,
        )
        assert result.returncode == 0, result.stderr
        assert link.lstat().st_reparse_tag == 0xA0000003
    else:
        link.symlink_to(outside, target_is_directory=True)
    try:
        entries = iter_skills_files()
        assert {entry["container_path"] for entry in entries} == {"/root/.youtab-agent-runtime/skills/SKILL.md"}
        mount = get_skills_directory_mount()[0]
        sanitized = Path(mount["host_path"])
        assert sanitized != skills
        assert (sanitized / "SKILL.md").read_text(encoding="utf-8") == "public skill"
        assert not (sanitized / "foreign").exists()
        assert not any("synthetic-private-token" in p.read_text(encoding="utf-8") for p in sanitized.rglob("*") if p.is_file())
        assert secret.read_text(encoding="utf-8") == "synthetic-private-token"
    finally:
        link.rmdir() if os.name == "nt" else link.unlink()
    assert secret.read_text(encoding="utf-8") == "synthetic-private-token"


@pytest.mark.parametrize("outcome", ["success", "download-failure", "oversized", "traversal"])
def test_download_path_is_closed_private_and_cleaned(tmp_path, monkeypatch, outcome):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    host = tmp_path / "skill.py"
    host.write_bytes(b"original")
    observed = []

    def download(destination):
        observed.append(destination)
        assert not destination.exists()
        if os.name == "nt":
            import win32security
            descriptor = win32security.GetNamedSecurityInfo(str(destination.parent), win32security.SE_FILE_OBJECT, win32security.DACL_SECURITY_INFORMATION)
            acl = descriptor.GetSecurityDescriptorDacl()
            sids = {win32security.ConvertSidToStringSid(acl.GetAce(i)[2]) for i in range(acl.GetAceCount())}
            assert not sids.intersection({"S-1-1-0", "S-1-5-11", "S-1-5-32-545"})
        if outcome == "download-failure":
            destination.write_bytes(b"partial")
            raise RuntimeError("synthetic download failure")
        with tarfile.open(destination, "w") as archive:
            member = tarfile.TarInfo("../outside.txt" if outcome == "traversal" else "root/.youtab-agent-runtime/skills/skill.py")
            member.size = len(b"remote")
            archive.addfile(member, io.BytesIO(b"remote"))

    manager = FileSyncManager(
        get_files_fn=lambda: [(str(host), "/root/.youtab-agent-runtime/skills/skill.py")],
        upload_fn=MagicMock(), delete_fn=MagicMock(), bulk_download_fn=download,
    )
    if outcome == "oversized":
        monkeypatch.setattr("tools.environments.file_sync._SYNC_BACK_MAX_BYTES", 1)
    if outcome == "download-failure":
        with pytest.raises(RuntimeError, match="synthetic download failure"):
            manager._sync_back_impl()
    elif outcome == "traversal":
        with pytest.raises(tarfile.FilterError):
            manager._sync_back_impl()
    else:
        manager._sync_back_impl()
    assert len(observed) == 1
    assert not observed[0].parent.exists()
    assert list(scratch.iterdir()) == []
    assert host.read_bytes() == (b"remote" if outcome == "success" else b"original")
    assert not (scratch / "outside.txt").exists()
