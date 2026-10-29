"""Pinned codec inputs for the common Windows Runtime artifact.

This validates distribution inputs, not executable signing or host-admin trust.
The bridge receives a resolved executable from its managed launcher, never from
an attachment request. Source/manual installations may lack this component.
"""

import hashlib
import json
import os
import stat
from pathlib import Path

FFMPEG_VERSION = "9.0.2-essentials_build"
FFMPEG_ARCHIVE_SHA256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"
FFMPEG_SOURCE_URL = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip"
FFMPEG_SOURCE_COMMIT_URL = "https://github.com/FFmpeg/FFmpeg/commit/946fcce07b"
FFMPEG_FILES = {
    "bin/ffmpeg.exe": (105423872, "3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec"),
    "LICENSE": (35147, "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"),
    "README.txt": (41577, "0342de6bb39dd421cbec2c00d89ad274b640d75ad3f2cab09ffd647ce2d8f949"),
}
MANAGED_FFMPEG_DIRECTORY = "native/managed-dependencies/ffmpeg"


def verify_ffmpeg_bundle(directory: Path) -> dict[str, Path]:
    """Verify every fixed input using bounded reads before accepting a bundle."""
    root = Path(directory).resolve(strict=True)
    result = {}
    for relative, (size, expected) in FFMPEG_FILES.items():
        target = root / relative
        before = target.lstat()
        if not stat.S_ISREG(before.st_mode) or not target.resolve(strict=True).is_relative_to(root):
            raise ValueError("Managed FFmpeg input must be a regular file inside its bundle")
        if before.st_size != size:
            raise ValueError("Managed FFmpeg input size does not match its pinned version")
        descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(descriptor)
            identity = lambda entry: (entry.st_dev, entry.st_ino, entry.st_size, entry.st_mtime_ns, entry.st_ctime_ns)
            # Windows 3.12+ path stat and fstat use different ctime meanings.
            same_file = lambda entry: (entry.st_dev, entry.st_ino, entry.st_size, entry.st_mtime_ns)
            if not stat.S_ISREG(opened.st_mode) or same_file(opened) != same_file(before):
                raise ValueError("Managed FFmpeg input changed before verification")
            digest = hashlib.sha256()
            total = 0
            while chunk := os.read(descriptor, min(1024 * 1024, size - total + 1)):
                total += len(chunk)
                if total > size:
                    raise ValueError("Managed FFmpeg input exceeds its pinned size")
                digest.update(chunk)
            after = os.fstat(descriptor)
            named = target.lstat()
            if (identity(after) != identity(opened) or identity(named) != identity(before)
                    or same_file(after) != same_file(named)):
                raise ValueError("Managed FFmpeg input changed during verification")
            if total != size or digest.hexdigest() != expected:
                raise ValueError("Managed FFmpeg input hash does not match its pinned version")
        finally:
            os.close(descriptor)
        result[relative] = target
    return result


def resolve_managed_ffmpeg(repo_root: Path) -> Path | None:
    """Return the validated common-artifact codec, or None for a source install.

    A present but invalid component always fails; it never falls back to PATH.
    Common release packaging separately requires this component to be present.
    """
    root = Path(repo_root).resolve(strict=True)
    bundle = root / MANAGED_FFMPEG_DIRECTORY
    if not bundle.exists():
        marker = root / ".youtab-agent-runtime-bootstrap-complete"
        if marker.is_file():
            with marker.open("rb") as reader:
                body = reader.read(65537)
            if len(body) > 65536:
                raise ValueError("Installed Runtime identity exceeds its metadata limit")
            try:
                identity = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                identity = None  # Legacy markers can be empty/non-JSON.
            if isinstance(identity, dict) and "artifactSha256" in identity:
                raise ValueError("Installed common Runtime is missing its managed FFmpeg component")
        return None
    if not bundle.resolve(strict=True).is_relative_to(root):
        raise ValueError("Managed FFmpeg component escapes the installed Runtime")
    return verify_ffmpeg_bundle(bundle)["bin/ffmpeg.exe"]
