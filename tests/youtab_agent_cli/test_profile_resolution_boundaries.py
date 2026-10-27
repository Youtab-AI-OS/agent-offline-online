"""Profile selectors stay identifiers and resolve default independently of scope."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from youtab_agent_cli import profile_describer, profiles
from youtab_constants import (
    get_youtab_home,
    reset_youtab_home_override,
    set_youtab_home_override,
)


@pytest.fixture
def scoped_homes(tmp_path, monkeypatch):
    root = tmp_path / "installation-home"
    active = root / "profiles" / "coder"
    active.mkdir(parents=True)
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(active))
    for home, skill in [(root, "default-skill"), (active, "coder-skill")]:
        skill_dir = home / "skills" / skill
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("synthetic skill", encoding="utf-8")
        (home / "config.yaml").write_text(
            "model:\n  default: synthetic-model\n  provider: synthetic-provider\n",
            encoding="utf-8",
        )
    return root, active


@pytest.fixture
def description_client(scoped_homes, monkeypatch):
    plugin = (
        Path(__file__).resolve().parents[2]
        / "plugins" / "kanban" / "dashboard" / "plugin_api.py"
    )
    spec = importlib.util.spec_from_file_location("profile_boundary_plugin_test", plugin)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    import sys
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/kanban")
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize("name", ["../outside", r"..\outside", "/outside", r"D:\outside", "coder:stream", "has space", ""])
@pytest.mark.parametrize("helper", [profiles.get_profile_dir, profiles.profile_exists, profile_describer.describe_profile])
def test_invalid_selectors_are_rejected_before_profile_access(scoped_homes, name, helper):
    with pytest.raises(ValueError):
        helper(name)


@pytest.mark.parametrize("name", [r"..\outside", r"D:\outside", "coder:stream", "has space"])
@pytest.mark.parametrize("auto", [False, True])
def test_description_http_rejects_invalid_selectors_without_writes_or_llm(
    scoped_homes, description_client, monkeypatch, name, auto,
):
    root, active = scoped_homes
    outside = root / "outside"
    outside.mkdir()
    profiles.write_profile_meta(outside, description="outside must remain unchanged")
    before = (outside / "profile.yaml").read_bytes()

    def forbidden_llm(**kwargs):
        pytest.fail("invalid selector reached the LLM")

    monkeypatch.setattr("agent.auxiliary_client.call_llm", forbidden_llm)
    path = "/api/plugins/kanban/profiles/" + quote(name, safe="")
    if auto:
        response = description_client.post(path + "/describe-auto", json={})
    else:
        response = description_client.patch(path, json={"description": "untrusted"})
    assert response.status_code == 400
    assert (outside / "profile.yaml").read_bytes() == before
    assert not (root / "profile.yaml").exists()
    assert not (active / "profile.yaml").exists()


@pytest.mark.parametrize("profile_name", [" Default ", " CoDeR "])
def test_valid_profile_names_resolve_and_exist_with_active_named_home(scoped_homes, profile_name):
    root, active = scoped_homes
    expected = root if profile_name.strip().casefold() == "default" else active
    assert profiles.get_profile_dir(profile_name) == expected
    assert profiles.profile_exists(profile_name)
    assert profiles.profile_exists("missing") is False


def test_named_profile_directory_links_remain_supported(scoped_homes):
    root, _ = scoped_homes
    target = root / "linked-target"
    target.mkdir()
    link = root / "profiles" / "linked"
    if os.name == "nt":
        subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            check=True, capture_output=True,
        )
    else:
        link.symlink_to(target, target_is_directory=True)
    assert profiles.get_profile_dir("Linked") == link
    assert profiles.profile_exists("Linked")
    profiles.write_profile_meta(profiles.get_profile_dir("Linked"), description="linked profile")
    assert profiles.read_profile_meta(target)["description"] == "linked profile"


def test_default_auto_description_uses_canonical_home_preserving_auxiliary_scope(
    scoped_homes, monkeypatch,
):
    root, active = scoped_homes
    captured = {}

    def fake_llm(**kwargs):
        captured.update(kwargs)
        captured["home"] = get_youtab_home()
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
            content=json.dumps({"description": "default profile description"}),
        ))])

    monkeypatch.setattr("agent.auxiliary_client.call_llm", fake_llm)
    token = set_youtab_home_override(active)
    try:
        outcome = profile_describer.describe_profile("Default")
        assert get_youtab_home() == active
    finally:
        reset_youtab_home_override(token)
    assert outcome.ok, outcome.reason
    assert profiles.read_profile_meta(root) == {
        "description": "default profile description", "description_auto": True,
    }
    assert not (active / "profile.yaml").exists()
    assert "default-skill" in captured["messages"][1]["content"]
    assert "coder-skill" not in captured["messages"][1]["content"]
    assert captured["task"] == "profile_describer"
    assert captured["home"] == active


@pytest.mark.parametrize("auto", [False, True])
@pytest.mark.parametrize("profile_name", ["Default", "CoDeR"])
def test_description_http_writes_only_selected_canonical_home(
    scoped_homes, description_client, monkeypatch, auto, profile_name,
):
    root, active = scoped_homes
    expected, untouched = (root, active) if profile_name == "Default" else (active, root)

    def fake_llm(**kwargs):
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
            content='{"description": "generated description"}',
        ))])

    monkeypatch.setattr("agent.auxiliary_client.call_llm", fake_llm)
    path = "/api/plugins/kanban/profiles/" + profile_name
    if auto:
        response = description_client.post(path + "/describe-auto", json={})
    else:
        response = description_client.patch(path, json={"description": "curated description"})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["profile"] == profile_name.lower()
    assert profiles.read_profile_meta(expected) == {
        "description": "generated description" if auto else "curated description",
        "description_auto": auto,
    }
    assert not (untouched / "profile.yaml").exists()


@pytest.mark.parametrize("auto", [False, True])
def test_description_http_keeps_missing_profile_outcome(scoped_homes, description_client, auto):
    path = "/api/plugins/kanban/profiles/missing"
    if auto:
        response = description_client.post(path + "/describe-auto", json={})
        assert response.status_code == 200
        assert response.json()["ok"] is False
        assert response.json()["reason"] == "profile not found"
    else:
        response = description_client.patch(path, json={"description": "unused"})
        assert response.status_code == 404
