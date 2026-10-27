"""Runtime policy and retained-object mutation effects in owned temporary files."""
import os
from pathlib import Path
import subprocess
import sys

import pytest

from agent import file_safety as safety


@pytest.fixture
def runtime_homes(tmp_path, monkeypatch):
    import youtab_constants

    root = tmp_path / "runtime"
    active = root / "profiles" / "active"
    inactive = root / "profiles" / "inactive"
    active.mkdir(parents=True)
    inactive.mkdir()
    default = tmp_path / "default-runtime"
    default.mkdir()
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(active))
    monkeypatch.setattr(youtab_constants, "_committed_relocation_override", lambda _home: None)
    monkeypatch.setattr(youtab_constants, "_get_platform_default_youtab_home", lambda: default)
    return root, active, inactive, default


def _directory_alias(link, target):
    if os.name == "nt":
        executable = str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe")
        assert not any(character in str(link) + str(target) for character in '"&|<>^%!\r\n')
        command = f'"{executable}" /d /s /c "mklink /J "{link}" "{target}""'
        made = subprocess.run(command, executable=executable, capture_output=True, timeout=10)
        assert made.returncode == 0, made.stderr
        assert link.lstat().st_file_attributes & 0x400
    else:
        link.symlink_to(target, target_is_directory=True)


@pytest.fixture
def mutation_platform():
    if os.name != "nt" and sys.platform != "darwin" and (not hasattr(os, "O_PATH") or not Path("/proc/self/fd").is_dir()):
        pytest.skip("Current POSIX retained mutation adapter requires O_PATH and /proc/self/fd")


@pytest.mark.parametrize("relative", ["config.yaml", ".env.production", "auth.json", "cache/bws_cache.enc.json",
                                      "mcp-tokens/server.json", "state.db-wal", "sessions/chat.json"])
def test_runtime_profiles_and_ancestors_preserve_bytes(runtime_homes, relative):
    for home in runtime_homes:
        target = home / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"synthetic-runtime-canary")
        assert safety.runtime_mutation_denied(str(target))
        assert safety.runtime_mutation_denied(str(target), deleting=True)
        assert target.read_bytes() == b"synthetic-runtime-canary"
    root, active, inactive, default = runtime_homes
    for ancestor in (root.parent, root, root / "profiles", active, inactive, default):
        assert safety.runtime_mutation_denied(str(ancestor), deleting=True)


def test_runtime_directory_alias_refused_and_project_config_allowed(runtime_homes, tmp_path):
    root, _active, _inactive, _default = runtime_homes
    (root / "config.yaml").write_bytes(b"runtime-canary")
    alias = tmp_path / "runtime-alias"
    _directory_alias(alias, root)
    assert safety.runtime_mutation_denied(str(alias / "config.yaml"))
    assert safety.runtime_mutation_denied(str(alias), deleting=True)
    assert (root / "config.yaml").read_bytes() == b"runtime-canary"
    project = tmp_path / "project"
    project.mkdir()
    config = project / "config.yaml"
    config.write_bytes(b"ordinary-project-config")
    assert not safety.runtime_mutation_denied(str(config))
    assert not safety.runtime_mutation_denied(str(project), deleting=True)


def test_runtime_directory_alias_protects_innocent_external_mutation_target(runtime_homes, tmp_path, mutation_platform):
    _root, active, _inactive, _default = runtime_homes
    external = tmp_path / "external"
    external.mkdir()
    victim = external / "innocent.txt"
    victim.write_bytes(b"external-credential-canary")
    _directory_alias(active / "mcp-tokens", external)
    assert safety.runtime_mutation_denied(str(victim))
    assert safety.runtime_mutation_denied(str(victim), deleting=True)
    def validate(path):
        if safety.runtime_mutation_denied(str(path)):
            raise PermissionError("runtime credential alias")
    with pytest.raises(PermissionError, match="runtime credential alias"):
        safety.MutationParentGuard(victim, validate)
    assert victim.read_bytes() == b"external-credential-canary"


def test_staged_mutation_conflict_overwrite_and_abort(tmp_path, mutation_platform):
    mutation_directory = tmp_path / "mutation"
    mutation_directory.mkdir()
    target = mutation_directory / "report.txt"
    with safety.MutationParentGuard(target, lambda _path: None) as parent:
        with safety.staged_mutation_file(parent) as staged:
            staged.write(b"new-report")
            target.write_bytes(b"concurrent-report")
            with pytest.raises(FileExistsError):
                staged.commit(overwrite=False)
        assert target.read_bytes() == b"concurrent-report"
        assert set(mutation_directory.iterdir()) == {target}
        with safety.staged_mutation_file(parent) as staged:
            staged.write(b"authorized-replacement")
            staged.commit(overwrite=True)
        assert target.read_bytes() == b"authorized-replacement"
        with pytest.raises(RuntimeError, match="synthetic abort"):
            with safety.staged_mutation_file(parent) as staged:
                staged.write(b"uncommitted")
                raise RuntimeError("synthetic abort")
        assert target.read_bytes() == b"authorized-replacement"
        assert set(mutation_directory.iterdir()) == {target}
    assert parent.closed and not parent.handles
    assert id(parent) not in safety._active_mutations


def test_staging_substitution_never_promotes_foreign_bytes(tmp_path, mutation_platform):
    target = tmp_path / "report.txt"
    target.write_bytes(b"before")
    with safety.MutationParentGuard(target, lambda _path: None) as parent:
        staged = safety.staged_mutation_file(parent)
        foreign = None
        try:
            staged.write(b"owned-staging")
            if os.name == "nt":
                with pytest.raises(PermissionError):
                    staged.path.rename(tmp_path / "foreign-stage-name")
                staged.commit(overwrite=True)
            else:
                original = tmp_path / staged.directory_name
                retained = tmp_path / "original-stage-retained"
                original.rename(retained)
                original.mkdir(mode=0o700)
                foreign = original / "payload"
                foreign.write_bytes(b"foreign-canary")
                with pytest.raises(PermissionError):
                    staged.commit(overwrite=True)
                assert target.read_bytes() == b"before"
        finally:
            original_error = sys.exc_info()[1]
            try:
                if foreign is None:
                    staged.close()
                else:
                    with pytest.raises(PermissionError):
                        staged.close()
            except BaseException:
                if original_error is None:
                    raise
        if os.name == "nt":
            assert staged.handle is None
            assert target.read_bytes() == b"owned-staging"
        else:
            assert staged.file_fd is None and staged.directory_fd is None
            assert foreign.read_bytes() == b"foreign-canary"


@pytest.mark.skipif(os.name != "nt", reason="Windows retained handle final destination check")
def test_unexpected_windows_final_destination_does_not_mark_committed(tmp_path, monkeypatch):
    import win32file

    target = tmp_path / "report.txt"
    with safety.MutationParentGuard(target, lambda _path: None) as parent:
        with safety.staged_mutation_file(parent) as staged:
            staged.write(b"owned-stage")
            original = safety._native_mutation_call
            def unexpected(function, *args):
                if function == win32file.GetFinalPathNameByHandle and args[0] == staged.handle:
                    return str(tmp_path / "unexpected-destination.txt")
                return original(function, *args)
            monkeypatch.setattr(safety, "_native_mutation_call", unexpected)
            with pytest.raises(PermissionError, match="unexpected destination"):
                staged.commit(overwrite=True)
            assert staged.committed is False
        assert staged.handle is None and not target.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode/FD owner contract; no Windows ACL changes")
def test_posix_shared_writable_parent_refuses_staging_and_delete(tmp_path, mutation_platform):
    directory = tmp_path / "shared"
    directory.mkdir(mode=0o700)
    target = directory / "keep.txt"
    target.write_bytes(b"shared-parent-canary")
    directory.chmod(0o777)  # Only an owned synthetic directory, never operator ACLs.
    try:
        with safety.MutationParentGuard(target, lambda _path: None) as parent:
            with pytest.raises(PermissionError, match="Shared-writable"):
                safety.staged_mutation_file(parent)
            with pytest.raises(PermissionError, match="Shared-writable"):
                safety.ManagedDelete(parent, lambda _path: None)
        assert target.read_bytes() == b"shared-parent-canary"
        assert set(directory.iterdir()) == {target}
    finally:
        directory.chmod(0o700)


def test_delete_rechecks_all_permissions_before_first_removal(tmp_path, mutation_platform):
    tree = tmp_path / "project"
    tree.mkdir()
    first = tree / "a.txt"
    protected = tree / "z.txt"
    first.write_bytes(b"ordinary-canary")
    protected.write_bytes(b"protected-canary")
    denied = set()
    def validate(path):
        if path in denied:
            raise PermissionError("scope changed before effect")
    with safety.MutationParentGuard(tree, validate) as parent:
        with safety.ManagedDelete(parent, validate, recursive=True) as deletion:
            denied.add(protected)
            with pytest.raises(PermissionError, match="scope changed"):
                deletion.apply()
        assert all(node["handle"] is None for node in deletion.nodes)
    assert first.read_bytes() == b"ordinary-canary"
    assert protected.read_bytes() == b"protected-canary"
    tree.rename(tmp_path / "refused-tree-handles-closed")


def test_delete_insertion_and_overlapping_mutations_are_refused(tmp_path, mutation_platform):
    tree = tmp_path / "project"
    tree.mkdir()
    original = tree / "keep.txt"
    original.write_bytes(b"before")
    with safety.MutationParentGuard(tree / "upload.txt", lambda _path: None) as upload:
        with safety.MutationParentGuard(tree, lambda _path: None) as parent:
            with pytest.raises(PermissionError):
                safety.ManagedDelete(parent, lambda _path: None, recursive=True)
        upload.assert_bound()
    with safety.MutationParentGuard(tree, lambda _path: None) as parent:
        with safety.ManagedDelete(parent, lambda _path: None, recursive=True) as deletion:
            with pytest.raises(PermissionError):
                safety.MutationParentGuard(tree / "upload.txt", lambda _path: None)
            inserted = tree / "inserted.txt"
            inserted.write_bytes(b"never-admitted")
            with pytest.raises(PermissionError):
                deletion.apply()
    assert original.read_bytes() == b"before" and inserted.read_bytes() == b"never-admitted"
    assert id(parent) not in safety._active_mutations and id(parent) not in safety._active_deletes


def test_recursive_delete_removes_owned_links_not_external_canaries(tmp_path, mutation_platform):
    tree = tmp_path / "project"
    (tree / "nested").mkdir(parents=True)
    leaf = tree / "nested" / "report.txt"
    leaf.write_bytes(b"ordinary-hardlink-canary")
    second = tree / "second-report.txt"
    external_file = tmp_path / "external-report.txt"
    os.link(leaf, second)
    os.link(leaf, external_file)
    assert leaf.stat().st_nlink == 3
    external_directory = tmp_path / "external-directory"
    external_directory.mkdir()
    canary = external_directory / "canary.txt"
    canary.write_bytes(b"junction-target-canary")
    _directory_alias(tree / "directory-link", external_directory)
    with safety.MutationParentGuard(tree, lambda _path: None) as parent:
        with safety.ManagedDelete(parent, lambda _path: None, recursive=True) as deletion:
            deletion.apply()
        assert all(node["handle"] is None for node in deletion.nodes)
    assert not tree.exists()
    assert external_file.read_bytes() == b"ordinary-hardlink-canary" and external_file.stat().st_nlink == 1
    assert canary.read_bytes() == b"junction-target-canary"
    assert not parent.handles and parent.closed


@pytest.mark.skipif(os.name != "nt", reason="Windows sharing; POSIX substitution is detected rather than isolated")
def test_paused_delete_prevents_windows_leaf_and_directory_replacement(tmp_path):
    tree = tmp_path / "project"
    tree.mkdir()
    leaf = tree / "report.txt"
    leaf.write_bytes(b"owned")
    with safety.MutationParentGuard(tree, lambda _path: None) as parent:
        with safety.ManagedDelete(parent, lambda _path: None, recursive=True) as deletion:
            with pytest.raises(PermissionError):
                leaf.rename(tree / "replaced.txt")
            with pytest.raises(PermissionError):
                tree.rename(tmp_path / "replaced-directory")
            deletion.apply()
    assert not tree.exists()
