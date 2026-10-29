"""Distribution-input contracts using synthetic bytes, not codec acceptance."""
import hashlib
import os
from pathlib import Path

import pytest

from plugins.platforms.whatsapp import managed_codec as codec


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    root = tmp_path / "runtime"
    directory = root / codec.MANAGED_FFMPEG_DIRECTORY
    pins = {}
    for name, data in {"bin/ffmpeg.exe": b"synthetic-executable", "LICENSE": b"synthetic-license", "README.txt": b"synthetic-provenance"}.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        pins[name] = (len(data), hashlib.sha256(data).hexdigest())
    monkeypatch.setattr(codec, "FFMPEG_FILES", pins)
    return root, directory


def test_managed_resolution_does_not_depend_on_path(bundle, monkeypatch):
    root, directory = bundle
    monkeypatch.setenv("PATH", "")
    assert codec.resolve_managed_ffmpeg(root) == directory / "bin/ffmpeg.exe"


def test_tampered_component_never_falls_back_to_path(bundle, monkeypatch):
    root, directory = bundle
    binary = directory / "bin/ffmpeg.exe"
    binary.write_bytes(b"X" * binary.stat().st_size)
    monkeypatch.setenv("PATH", "untrusted-fallback")
    with pytest.raises(ValueError, match="hash"):
        codec.resolve_managed_ffmpeg(root)


def test_missing_license_rejects_component(bundle):
    root, directory = bundle
    (directory / "LICENSE").unlink()
    with pytest.raises(FileNotFoundError):
        codec.resolve_managed_ffmpeg(root)


def test_source_install_without_component_is_explicit(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    assert codec.resolve_managed_ffmpeg(root) is None


def test_common_artifact_missing_component_never_falls_back(tmp_path):
    root = tmp_path / "artifact"
    root.mkdir()
    (root / ".youtab-agent-runtime-bootstrap-complete").write_text('{"artifactSha256":"synthetic"}', encoding="utf-8")
    with pytest.raises(ValueError, match="missing its managed"):
        codec.resolve_managed_ffmpeg(root)


def test_opened_object_replacement_is_detected_before_read(bundle, monkeypatch):
    _root, directory = bundle
    outside = directory.parent / "outside"
    outside.write_bytes(b"synthetic-executable")
    original = codec.os.open
    reads = []
    monkeypatch.setattr(codec.os, "open", lambda _path, flags: original(outside, flags))
    monkeypatch.setattr(codec.os, "read", lambda *_args: reads.append(True))
    with pytest.raises(ValueError, match="changed"):
        codec.verify_ffmpeg_bundle(directory)
    assert reads == []


def test_in_place_growth_is_bounded_and_rejected(bundle, monkeypatch):
    _root, directory = bundle
    binary = directory / "bin/ffmpeg.exe"
    original = codec.os.read
    grew = False
    def growing_read(fd, count):
        nonlocal grew
        if not grew:
            with binary.open("ab") as target:
                target.write(b"growing-input")
            grew = True
        return original(fd, count)
    monkeypatch.setattr(codec.os, "read", growing_read)
    with pytest.raises(ValueError, match="exceeds"):
        codec.verify_ffmpeg_bundle(directory)
