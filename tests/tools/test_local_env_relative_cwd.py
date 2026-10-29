"""Regression tests for local terminal initial cwd normalization."""

from pathlib import Path

import pytest

from tools.environments.local import LocalEnvironment, _resolve_local_initial_cwd, _msys_to_windows_path


@pytest.fixture(autouse=True)
def _synthetic_cwd_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))


def test_relative_initial_cwd_resolves_from_parent(tmp_path, monkeypatch):
    project = tmp_path / "youtab-agent-runtime"
    project.mkdir()
    monkeypatch.chdir(tmp_path)

    assert _resolve_local_initial_cwd("youtab-agent-runtime") == str(project)


def test_local_environment_keeps_existing_relative_child_cwd(tmp_path, monkeypatch):
    project = tmp_path / "youtab-agent-runtime"
    project.mkdir()
    monkeypatch.chdir(tmp_path)

    env = LocalEnvironment(cwd="youtab-agent-runtime", timeout=5)
    try:
        result = env.execute("pwd", timeout=5)
    finally:
        env.cleanup()

    assert result["returncode"] == 0
    assert _msys_to_windows_path(result["output"].strip()) == str(project)
    assert env.cwd == str(project)
