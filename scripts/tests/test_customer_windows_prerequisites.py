"""Behavior checks for the common Setup's bundled prerequisite producer."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.youtab import customer_windows_prerequisites as bundle


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class CustomerPrerequisitesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        config = self.root / "config"
        config.mkdir()
        self.wheels = self.root / "wheelhouse"
        self.wheels.mkdir()
        self.uv = self.root / "uv.zip"
        self.uv.write_bytes(b"pinned uv archive")
        self.python = self.root / "python.tar.gz"
        self.python.write_bytes(b"pinned Python archive")
        self.requirements = self.root / "requirements.txt"
        self.requirements.write_bytes(b"hash-locked requirements\n")
        wheel_records = []
        for index in range(100):
            name = f"package_{index:03}-1.0-py3-none-any.whl"
            file = self.wheels / name
            file.write_bytes(f"wheel {index}".encode())
            wheel_records.append({"name": name, "size": file.stat().st_size, "sha256": sha(file)})
        self.lock_hash = "a" * 64
        self.pins = config / "windows-customer-wheelhouse.json"
        self.pins.write_text(json.dumps({"schema": 1, "uv_lock_sha256": self.lock_hash,
                                         "wheel_count": len(wheel_records),
                                         "requirements_sha256": sha(self.requirements),
                                         "files": wheel_records}), encoding="utf-8")
        (config / "windows-private-home-prerequisites.json").write_text(
            json.dumps({"uv": {"sha256": sha(self.uv)},
                        "python": {"sha256": sha(self.python)}}), encoding="utf-8")
        module_path = self.root / "scripts/youtab/customer_windows_prerequisites.py"
        module_path.parent.mkdir(parents=True)
        self.module_patch = patch.object(bundle, "__file__", str(module_path))
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)

    def make_bundle(self) -> Path:
        output = self.root / "image"
        bundle.build(output, "b" * 40, self.lock_hash, self.uv, self.python,
                     self.requirements, self.wheels, self.pins)
        return output

    def test_exact_reviewed_bytes_are_accepted(self) -> None:
        output = self.make_bundle()
        raw, records = bundle.verify(output, "b" * 40, self.lock_hash)
        self.assertEqual(len(records), 103)
        self.assertEqual(json.loads(raw)["file_count"], 103)

    def test_changed_wheel_is_rejected(self) -> None:
        output = self.make_bundle()
        (output / "wheelhouse/package_000-1.0-py3-none-any.whl").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "differs"):
            bundle.verify(output, "b" * 40, self.lock_hash)

    def test_unlisted_file_and_wrong_source_are_rejected(self) -> None:
        output = self.make_bundle()
        with self.assertRaisesRegex(ValueError, "identity"):
            bundle.verify(output, "c" * 40, self.lock_hash)
        (output / "wheelhouse/extra.whl").write_bytes(b"unexpected")
        with self.assertRaisesRegex(ValueError, "unlisted"):
            bundle.verify(output, "b" * 40, self.lock_hash)

    def test_input_wheel_hash_is_checked_before_copy(self) -> None:
        (self.wheels / "package_000-1.0-py3-none-any.whl").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "wheel differs"):
            self.make_bundle()

    def test_selected_wheel_must_match_exact_uv_lock_name_and_hash(self) -> None:
        first = json.loads(self.pins.read_text(encoding="utf-8"))["files"][0]
        lock = self.root / "uv.lock"
        lock.write_text("[[package]]\nname = 'package-000'\nversion = '1.0'\n"
                        "[[package.wheels]]\n"
                        f"filename = '{first['name']}'\n"
                        f"hash = 'sha256:{first['sha256']}'\n", encoding="utf-8")
        bundle.verify_lock_wheels(lock, {"files": [first]})
        with self.assertRaisesRegex(ValueError, "not pinned"):
            bundle.verify_lock_wheels(lock, {"files": [{**first, "sha256": "0" * 64}]})
        with self.assertRaisesRegex(ValueError, "not pinned"):
            bundle.verify_lock_wheels(lock, {"files": [{**first, "name": "other.whl"}]})


if __name__ == "__main__":
    unittest.main()
