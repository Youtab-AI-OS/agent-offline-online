"""The SDK verifier binds packaged inputs and the final interpreter, not OS CPU."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from tools import windows_pty_dependency as sdk


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "tools" / "windows_pty_dependency.py"


def test_packaged_wheel_api_is_complete_and_imports_no_sdk():
    before = set(sys.modules)
    result = sdk.validate_packaged_wheels(ROOT)
    assert result["version"] == sdk.SDK_VERSION
    assert [row["abi"] for row in result["wheels"]] == ["cp311", "cp312", "cp313"]
    assert not any(name.startswith("winpty") for name in set(sys.modules) - before)


@pytest.mark.parametrize("abi", ["cp311", "cp312", "cp313"])
@pytest.mark.parametrize("mutation", ["missing", "tampered"])
def test_every_wheel_is_mandatory_before_runtime_selection(tmp_path, abi, mutation):
    vendor = tmp_path / sdk.VENDOR_RELATIVE_DIR
    vendor.parent.mkdir(parents=True)
    shutil.copytree(ROOT / sdk.VENDOR_RELATIVE_DIR, vendor)
    path = tmp_path / sdk.EXPECTED_WHEELS[abi]["relative_path"]
    if mutation == "missing":
        path.unlink()
    else:
        content = bytearray(path.read_bytes())
        content[-1] ^= 1
        path.write_bytes(content)
    with pytest.raises((OSError, ValueError)):
        sdk.validate_packaged_wheels(tmp_path)


def runtime(version="3.11"):
    return {"implementation": "cpython", "version": version, "platform": "win32",
            "sysconfig_platform": "win-amd64", "pointer_bits": 64,
            "extension_suffix": f".cp{version.replace('.', '')}-win_amd64.pyd"}


@pytest.mark.parametrize("version", ["3.11", "3.12", "3.13"])
def test_supported_actual_runtime_metadata_selects_its_abi(version):
    assert sdk._runtime_abi(runtime(version)) == "cp" + version.replace(".", "")


@pytest.mark.parametrize("field,value", [
    ("implementation", "pypy"), ("version", "3.10"), ("version", "3.14"),
    ("platform", "linux"), ("sysconfig_platform", "win-arm64"),
    ("sysconfig_platform", "win32"), ("pointer_bits", 32),
    ("extension_suffix", ".cp313t-win_amd64.pyd"),
])
def test_unsupported_runtime_is_refused_without_os_cpu_guess(field, value):
    actual = runtime()
    actual[field] = value
    with pytest.raises(ValueError, match="64-bit CPython"):
        sdk._runtime_abi(actual)


def test_isolated_helper_rejects_missing_inputs_before_install(tmp_path):
    before = set(tmp_path.iterdir())
    result = subprocess.run([sys.executable, "-I", str(HELPER), "validate", "--root", str(tmp_path)],
                            capture_output=True, text=True, timeout=15, check=False)
    assert result.returncode == 1
    assert "verification failed" in result.stderr
    assert set(tmp_path.iterdir()) == before


def test_isolated_vendor_cli_matches_shared_release_manifest():
    result = subprocess.run([sys.executable, "-I", str(HELPER), "verify-vendor", "--root", str(ROOT)],
                            capture_output=True, text=True, timeout=15, check=False)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == sdk.validate_packaged_wheels(ROOT)


def test_actual_read_is_bounded_when_opened_input_grows(tmp_path, monkeypatch):
    path = tmp_path / "changing-input"
    path.write_bytes(b"a" * 100)
    original_open = Path.open
    original_fdopen = os.fdopen
    requested = []

    class GrowingReader:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.stream.close()

        def fileno(self):
            return self.stream.fileno()

        def read(self, limit):
            requested.append(limit)
            with original_open(path, "ab") as writer:
                writer.write(b"b" * 100)
            return self.stream.read(limit)

    def open_input(descriptor, *args, **kwargs):
        return GrowingReader(original_fdopen(descriptor, *args, **kwargs))

    monkeypatch.setattr(os, "fdopen", open_input)
    with pytest.raises(ValueError, match="changed during verification"):
        sdk._read_fixed(path, 100)
    assert requested == [101]


def directory_alias(link, target):
    if os.name == "nt":
        subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(target)],
                       capture_output=True, check=True)
    else:
        link.symlink_to(target, target_is_directory=True)


def test_explicit_root_alias_remains_supported(tmp_path):
    alias = tmp_path / "selected-root"
    directory_alias(alias, ROOT)
    assert sdk.validate_packaged_wheels(alias) == sdk.validate_packaged_wheels(ROOT)


def test_redirected_vendor_child_is_refused_even_with_correct_bytes(tmp_path):
    parent = tmp_path / "native/python-wheels"
    parent.mkdir(parents=True)
    directory_alias(parent / "pywinpty", ROOT / sdk.VENDOR_RELATIVE_DIR)
    with pytest.raises(ValueError, match="redirects"):
        sdk.validate_packaged_wheels(tmp_path)


@pytest.mark.skipif(os.name != "posix", reason="Native FIFO admission requires POSIX; separately executed in Linux proof")
@pytest.mark.parametrize("swap", [False, True])
def test_fifo_and_regular_to_fifo_swap_are_refused_within_deadline(tmp_path, swap):
    path = tmp_path / "fifo"
    path.touch() if swap else os.mkfifo(path)
    command = r'''
import importlib.util, os, pathlib, sys
spec = importlib.util.spec_from_file_location('sdk', sys.argv[1])
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)
path = pathlib.Path(sys.argv[2])
if sys.argv[3] == '1':
    original = os.open
    def swapped(candidate, *args, **kwargs):
        if pathlib.Path(candidate) == path:
            path.unlink()
            os.mkfifo(path)
        return original(candidate, *args, **kwargs)
    os.open = swapped
try:
    sdk._read_fixed(path, 0)
except (OSError, ValueError):
    raise SystemExit(23)
raise SystemExit(0)
'''
    result = subprocess.run([sys.executable, "-I", "-c", command, str(HELPER), str(path), str(int(swap))],
                            capture_output=True, text=True, timeout=2, check=False)
    assert result.returncode == 23, result.stdout + result.stderr
