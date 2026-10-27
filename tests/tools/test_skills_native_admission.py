"""Admission must refuse pre-existing directory redirects on native Windows and POSIX."""

import os
from unittest.mock import patch

import pytest

import tools.skills_hub as hub
from tools.skills_guard import ScanResult


@pytest.mark.parametrize("existing_installation", [False, True])
def test_tampered_quarantine_directory_redirect_is_refused(tmp_path, monkeypatch, existing_installation):
    skills = tmp_path / "skills"
    quarantine = skills / ".hub" / "quarantine"
    pending = quarantine / "pending"
    pending.mkdir(parents=True)
    (pending / "SKILL.md").write_text("# synthetic skill", encoding="utf-8")
    (pending / ".skillignore").write_text("redirect/\n", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel.txt"
    sentinel.write_text("DO NOT ADMIT SYNTHETIC SECRET", encoding="utf-8")
    redirect = pending / "redirect"
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(outside), str(redirect))
    else:
        redirect.symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(hub, "SKILLS_DIR", skills)
    monkeypatch.setattr(hub, "QUARANTINE_DIR", quarantine)
    installed = skills / "synthetic"
    if existing_installation:
        installed.mkdir()
        (installed / "SKILL.md").write_text("# existing valid skill", encoding="utf-8")
        (installed / "sentinel.txt").write_text("PRESERVE INSTALLED SKILL", encoding="utf-8")
    bundle = hub.SkillBundle("synthetic", {"SKILL.md": "# synthetic skill"}, "community", "synthetic", "community")
    # A stale safe verdict cannot replace validation of the actual tree.
    safe = ScanResult("synthetic", "community", "community", "safe")
    with patch.object(hub.shutil, "move", side_effect=AssertionError("unsafe admission")) as move, \
         patch.object(hub.shutil, "rmtree", side_effect=AssertionError("must preserve old installation")) as remove:
        with pytest.raises(ValueError, match="symlink"):
            hub.install_from_quarantine(pending, "synthetic", "", bundle, safe)
    move.assert_not_called()
    remove.assert_not_called()
    assert pending.exists()
    if existing_installation:
        assert (installed / "SKILL.md").read_text(encoding="utf-8") == "# existing valid skill"
        assert (installed / "sentinel.txt").read_text(encoding="utf-8") == "PRESERVE INSTALLED SKILL"
    else:
        assert not installed.exists()
    assert sentinel.read_text(encoding="utf-8") == "DO NOT ADMIT SYNTHETIC SECRET"
