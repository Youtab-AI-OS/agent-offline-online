import hashlib
import json

import pytest

from scripts.release_channels import digest, promote


@pytest.fixture
def release(tmp_path):
    sha = "a" * 40
    base = "https://api.youtab.io/pilot-runtime-" + "b" * 32 + "/releases"
    directory = tmp_path / sha
    directory.mkdir()
    manifest = dict(source_sha=sha, release_sequence=4, version="0.19.1", platform="windows", architecture="x64", format="zip", setup_source_sha=sha, updater_protocol=1, update_coordination_protocol=1)
    for name, url, checksum, payload in (
        (f"youtab-runtime-{sha}.zip", "artifact_url", "sha256", b"synthetic runtime"),
        (f"install-{sha}.ps1", "install_script_url", "install_script_sha256", b"synthetic script"),
        (f"Youtab-Setup-{sha}.exe", "setup_url", "setup_sha256", b"synthetic setup"),
    ):
        (directory / name).write_bytes(payload)
        manifest[url] = f"{base}/{sha}/{name}"
        manifest[checksum] = hashlib.sha256(payload).hexdigest()
    manifest["setup_size"] = len(b"synthetic setup")
    (directory / "manifest.json").write_text(json.dumps(manifest))
    return tmp_path, sha, base, manifest


def qualification(manifest):
    return {**{k: manifest[k] for k in ("source_sha", "sha256", "setup_sha256", "release_sequence")}, **dict.fromkeys(("fresh_install", "update", "login_inference", "restart", "preservation", "files_skills_plugins", "owner_approved", "owasp_top10", "smoke", "full_security"), True)}


@pytest.mark.parametrize("gate", [
    "owasp_top10", "smoke", "full_security",
])
@pytest.mark.parametrize("outcome", [None, False, 1, "passed"])
def test_missing_or_unproven_common_installer_gate_cannot_change_stable(release, gate, outcome):
    root, sha, base, manifest = release
    promote(root, "pilot", sha, base, None)
    accepted = qualification(manifest)
    promote(root, "stable", sha, base, None, accepted)
    pointer = root / "channels/stable/latest.json"
    before = pointer.read_bytes()
    expected = digest(pointer)
    if outcome is None:
        accepted.pop(gate)
    else:
        accepted[gate] = outcome
    with pytest.raises(ValueError, match=f"qualification incomplete: {gate}"):
        promote(root, "stable", sha, base, expected, accepted)
    assert pointer.read_bytes() == before
    assert not list(pointer.parent.glob(".latest-*.tmp"))


def test_promote_same_bytes_to_stable_without_rebuild(release):
    root, sha, base, manifest = release
    original = {p.name: p.read_bytes() for p in (root / sha).iterdir()}
    pilot = promote(root, "pilot", sha, base, None)
    stable = promote(root, "stable", sha, base, None, qualification(manifest))
    assert pilot == stable
    assert original == {p.name: p.read_bytes() for p in (root / sha).iterdir()}
    assert not (root / "latest.json").exists()


def test_channel_preserves_release_notes_and_rejects_invalid_text(release):
    root, sha, base, manifest = release
    manifest["release_notes"] = ["A verified update is available."]
    (root / sha / "manifest.json").write_text(json.dumps(manifest))
    promote(root, "pilot", sha, base, None)
    assert json.loads((root / "channels/pilot/latest.json").read_text())["release_notes"] == manifest["release_notes"]

    manifest["release_notes"] = ["bad\nline"]
    (root / sha / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="release notes"):
        promote(root, "stable", sha, base, None, qualification(manifest))
    assert not (root / "channels/stable/latest.json").exists()


@pytest.mark.parametrize("case", ["tampered_setup", "missing_setup", "wrong_qualification", "no_qualification", "unqualified_update", "reused_sequence", "changed_pointer", "bad_channel"])
def test_fail_closed_preserves_existing_pointer(release, case):
    root, sha, base, manifest = release
    promote(root, "pilot", sha, base, None)
    q = qualification(manifest)
    if case == "tampered_setup":
        (root / sha / f"Youtab-Setup-{sha}.exe").write_bytes(b"tampered")
    elif case == "missing_setup":
        (root / sha / f"Youtab-Setup-{sha}.exe").unlink()
    elif case == "wrong_qualification":
        q["setup_sha256"] = "c" * 64
    elif case == "no_qualification":
        q = None
    elif case == "unqualified_update":
        q["update"] = False
    channel = "stable"
    expected = None
    if case in ("reused_sequence", "changed_pointer"):
        promote(root, "stable", sha, base, None, q)
        expected = digest(root / "channels/stable/latest.json")
        if case == "changed_pointer":
            expected = "d" * 64
    if case == "bad_channel":
        channel = "../../other"
    pointer = root / "channels/stable/latest.json"
    before = pointer.read_bytes() if pointer.exists() else None
    with pytest.raises((ValueError, FileNotFoundError)):
        promote(root, channel, sha, base, expected, q)
    assert (pointer.read_bytes() if pointer.exists() else None) == before


@pytest.mark.parametrize("capability", [None, False, True, 0, 2, "1"])
def test_missing_or_invalid_coordination_capability_cannot_promote(release, capability):
    root, sha, base, manifest = release
    if capability is None:
        manifest.pop("update_coordination_protocol")
    else:
        manifest["update_coordination_protocol"] = capability
    (root / sha / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="coordination protocol"):
        promote(root, "pilot", sha, base, None)
    assert not (root / "channels").exists()


def test_stable_rejects_coordination_field_divergence_from_pilot(release):
    root, sha, base, manifest = release
    promote(root, "pilot", sha, base, None)
    pointer = root / "channels/pilot/latest.json"
    malformed = json.loads(pointer.read_text())
    malformed["update_coordination_protocol"] = 2
    pointer.write_text(json.dumps(malformed))
    before = pointer.read_bytes()
    with pytest.raises(ValueError, match="current Pilot package"):
        promote(root, "stable", sha, base, None, qualification(manifest))
    assert pointer.read_bytes() == before
    assert not (root / "channels/stable/latest.json").exists()


def test_existing_legacy_pointer_can_advance_to_qualified_new_common_setup(release):
    root, sha, base, manifest = release
    channel = root / "channels/pilot"
    channel.mkdir(parents=True)
    legacy = {**manifest, "release_sequence": 3}
    legacy.pop("update_coordination_protocol")
    pointer = channel / "latest.json"
    pointer.write_text(json.dumps(legacy))
    promote(root, "pilot", sha, base, digest(pointer))
    current = json.loads(pointer.read_text())
    assert current["update_coordination_protocol"] == 1
    assert current["setup_sha256"] == manifest["setup_sha256"]
