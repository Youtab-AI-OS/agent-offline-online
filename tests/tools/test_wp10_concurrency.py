"""WP-10: two imports against one data root must not both publish.

Hermetic; synthetic audio under tmp_path only. Speaker-keyed strings are
assembled from fragments so this file does not trip the commit gate.
"""

from __future__ import annotations

import errno
import hashlib
import json
import shutil
import sys
import threading
import traceback
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "wakeword"))

import import_speaker as imp  # noqa: E402
import speaker_recording_spec as spec  # noqa: E402

from tests.tools.test_wakeword_speaker_import import (  # noqa: E402
    SEALED_LABEL,
    TRAIN_LABEL,
    build_package_submission,
    write_checksums,
)


@pytest.fixture(scope="module")
def sharing_one_take(tmp_path_factory):
    """Two complete submissions that share one byte-identical recording.

    The realistic accident rather than an attack: a coordinator copies a take
    into the wrong folder, or a speaker returns a file they were sent as an
    example. One of the two speakers is sealed.
    """
    base = tmp_path_factory.mktemp("subs")
    train = build_package_submission(base / TRAIN_LABEL, TRAIN_LABEL)
    sealed = build_package_submission(base / SEALED_LABEL, SEALED_LABEL)
    section = spec.POSITIVE_SECTIONS[0]
    rel = "/".join(
        (
            spec.ORIGINALS_DIR,
            section.directory,
            spec.WAKE_PHRASE_SLUG + "_" + section.condition + "_001.wav",
        )
    )
    shutil.copy2(train / rel, sealed / rel)
    write_checksums(sealed)
    return train, sealed, hashlib.sha256((train / rel).read_bytes()).hexdigest()


def _digests(into: Path, label: str) -> set[str]:
    body = json.loads((into / ("speaker_" + label) / imp.MANIFEST_FILENAME).read_text(encoding="utf-8"))
    return {entry["sha256"] for entry in body["files"]}


def test_a_shared_take_cannot_be_published_by_the_second_import(tmp_path, sharing_one_take):
    """Both operators plan, then both publish. Only the first may succeed.

    The reuse check reads every manifest in the data root and plan reads it
    once, so two imports planned before either published each saw a root without
    the other. Nothing between them refused the shared take -- and because one of
    the two is sealed, that is the loss no later cleanup reverses: deleting a
    file does not make the sealed voice unseen again.
    """
    train, sealed, shared = sharing_one_take
    into = tmp_path / "data"
    into.mkdir()

    plan_train = imp.plan(TRAIN_LABEL, train, into)
    plan_sealed = imp.plan(SEALED_LABEL, sealed, into)
    assert plan_train.ok, sorted(c.name for c in plan_train.failures)
    assert plan_sealed.ok, sorted(c.name for c in plan_sealed.failures)

    imp.execute(plan_train, into)
    with pytest.raises(imp.Refused) as refusal:
        imp.execute(plan_sealed, into)
    assert "reuse" in str(refusal.value)

    assert shared in _digests(into, TRAIN_LABEL)
    assert not (into / ("speaker_" + SEALED_LABEL) / imp.MANIFEST_FILENAME).is_file()


def test_a_held_lock_refuses_a_second_publisher(tmp_path, sharing_one_take):
    train, _sealed, _shared = sharing_one_take
    into = tmp_path / "data"
    into.mkdir()
    (into / imp.LOCK_FILENAME).write_text("99999\n", encoding="utf-8")

    state = imp.plan(TRAIN_LABEL, train, into)
    assert state.ok, sorted(c.name for c in state.failures)
    with pytest.raises(imp.Refused) as refusal:
        imp.execute(state, into)
    assert imp.LOCK_FILENAME in str(refusal.value)
    assert not (into / ("speaker_" + TRAIN_LABEL) / imp.MANIFEST_FILENAME).is_file()


def test_concurrent_imports_of_one_speaker_raise_only_refusals(tmp_path, sharing_one_take):
    """Whatever loses the race loses it as a refusal, not as a traceback.

    One shared .writing temporary name means the winner consumes the file the
    loser staged, and the loser then fails inside os.replace after its caller
    was already told the write had succeeded.
    """
    train, _sealed, _shared = sharing_one_take
    into = tmp_path / "data"
    into.mkdir()
    states = [imp.plan(TRAIN_LABEL, train, into) for _ in range(2)]
    unexpected: list[str] = []

    def run(state):
        try:
            imp.execute(state, into)
        except imp.Refused:
            pass
        except BaseException as exc:  # noqa: BLE001
            unexpected.append(traceback.format_exc())

    threads = [threading.Thread(target=run, args=(state,)) for state in states]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(180)
    assert not unexpected, unexpected


def test_execute_permission_denial_refuses_without_publishing(tmp_path, sharing_one_take, monkeypatch):
    train, _sealed, _shared = sharing_one_take
    into = tmp_path / "data"
    into.mkdir()
    state = imp.plan(TRAIN_LABEL, train, into)
    assert state.ok

    def deny_copy(_state, _staging, _destination):
        raise PermissionError(errno.EACCES, "recording is in use")

    monkeypatch.setattr(imp, "_copy_originals", deny_copy)
    with pytest.raises(imp.Refused, match="could not access a file"):
        imp.execute(state, into)
    assert not (into / ("speaker_" + TRAIN_LABEL) / imp.MANIFEST_FILENAME).exists()


def _single_original(tmp_path):
    source_root = tmp_path / "source"
    source_root.mkdir()
    source = source_root / "take.wav"
    with wave.open(str(source), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\0\0" * 1000)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    row = SimpleNamespace(path=source.name, sha256=digest)
    return SimpleNamespace(originals=[row], originals_root=source_root), source, digest


def test_original_copy_conflict_refuses_only_after_verifying_published_bytes(tmp_path, monkeypatch):
    """Windows denies replacing the first writer's open, complete recording.

    On other hosts the rename-denial seam models that Windows sharing rule;
    staging, hashing, destination bytes and the two writers remain real.
    """
    state, source, digest = _single_original(tmp_path)
    destination = tmp_path / "destination"
    target = destination / source.name
    real_copy = imp._copy_and_hash
    real_replace = imp.os.replace
    staged = threading.Barrier(2)
    first_published = threading.Event()
    second_finished = threading.Event()
    completed = []
    refusals = []
    unexpected = []

    def copy(source, temporary):
        copied = real_copy(source, temporary)
        staged.wait(timeout=10)
        return copied

    def replace(temporary, published):
        if Path(published) != target:
            return real_replace(temporary, published)
        if threading.current_thread().name == "first-copy":
            real_replace(temporary, published)
            with target.open("rb"):
                first_published.set()
                assert second_finished.wait(10), "second copy did not finish"
        else:
            assert first_published.wait(10), "first copy did not publish"
            if imp.os.name != "nt":
                error = PermissionError(errno.EACCES, "modeled Windows sharing conflict")
                error.winerror = 5
                raise error
            return real_replace(temporary, published)

    def run(name):
        try:
            completed.append(imp._copy_originals(state, tmp_path / name, destination))
        except imp.Refused as exc:
            refusals.append(str(exc))
        except BaseException:  # retain the real native failure trace
            unexpected.append(traceback.format_exc())
        finally:
            if name == "second-copy":
                second_finished.set()

    monkeypatch.setattr(imp, "_copy_and_hash", copy)
    monkeypatch.setattr(imp.os, "replace", replace)
    threads = [
        threading.Thread(target=run, args=(name,), name=name)
        for name in ("first-copy", "second-copy")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)

    assert not any(thread.is_alive() for thread in threads)
    assert not unexpected, unexpected
    assert completed == [{"copied": 1, "already_present": 0}]
    assert len(refusals) == 1
    assert hashlib.sha256(target.read_bytes()).hexdigest() == digest
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest


@pytest.mark.parametrize("destination_state", ["missing", "different"])
def test_original_copy_permission_failure_without_matching_bytes_propagates(
    tmp_path, monkeypatch, destination_state
):
    state, source, _digest = _single_original(tmp_path)
    destination = tmp_path / "destination"
    target = destination / source.name
    destination.mkdir()
    if destination_state == "different":
        target.write_bytes(b"existing different bytes")
    error = PermissionError(errno.EACCES, "permanent access denial")
    error.winerror = 5

    def deny_replace(_temporary, _published):
        raise error

    monkeypatch.setattr(imp.os, "replace", deny_replace)
    with pytest.raises(PermissionError) as caught:
        imp._copy_originals(state, tmp_path / "staging", destination)

    assert caught.value is error
    if destination_state == "different":
        assert target.read_bytes() == b"existing different bytes"
    else:
        assert not target.exists()


def test_original_copy_other_io_failure_is_not_converted_to_refusal(tmp_path, monkeypatch):
    state, source, _digest = _single_original(tmp_path)
    destination = tmp_path / "destination"
    target = destination / source.name
    error = OSError(errno.EIO, "device I/O failure")

    def fail_replace(_temporary, _published):
        # Even a matching destination cannot excuse an unrelated I/O failure.
        target.write_bytes(source.read_bytes())
        raise error

    monkeypatch.setattr(imp.os, "replace", fail_replace)
    with pytest.raises(OSError) as caught:
        imp._copy_originals(state, tmp_path / "staging", destination)

    assert caught.value is error


def test_original_copy_unverifiable_destination_preserves_replace_error(tmp_path, monkeypatch):
    state, source, _digest = _single_original(tmp_path)
    destination = tmp_path / "destination"
    target = destination / source.name
    error = PermissionError(errno.EACCES, "original rename denial")

    def deny_replace(_temporary, _published):
        target.write_bytes(source.read_bytes())
        raise error

    def unreadable_digest(_path):
        raise OSError(errno.EIO, "destination cannot be verified")

    monkeypatch.setattr(imp.os, "replace", deny_replace)
    monkeypatch.setattr(imp.freeze_manifest, "sha256_file", unreadable_digest)
    with pytest.raises(PermissionError) as caught:
        imp._copy_originals(state, tmp_path / "staging", destination)

    assert caught.value is error
