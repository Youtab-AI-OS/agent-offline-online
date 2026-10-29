"""Local static Runtime release package contract tests (no network)."""

import hashlib
import os
import re
import json
import subprocess
import shutil
import zipfile
from pathlib import Path

import pytest

from scripts import release
from scripts.youtab.customer_windows_producer_receipt import BUILD_STEPS, NODE_SHA256, _tree_digest


def _setup_image(source_sha, base):
    image = bytearray(1024)
    image[:2] = b"MZ"
    image[60:64] = (64).to_bytes(4, "little")
    image[64:68] = b"PE\0\0"
    image[68:70] = (0x8664).to_bytes(2, "little")
    image[86:88] = (2).to_bytes(2, "little")
    image[88:90] = (0x20b).to_bytes(2, "little")
    image[70:72] = (1).to_bytes(2, "little")
    image[84:86] = (240).to_bytes(2, "little")
    table = 64 + 24 + 240
    payload = source_sha.encode() + base.encode() + release.UPDATE_COORDINATION_PE_MARKER
    image[table:table + 8] = b".rdata\0\0"
    image[table + 16:table + 20] = len(payload).to_bytes(4, "little")
    image[table + 20:table + 24] = (512).to_bytes(4, "little")
    image[table + 36:table + 40] = (0x40000040).to_bytes(4, "little")
    image[512:512 + len(payload)] = payload
    return bytes(image)


def _addon_image():
    image = bytearray(1024)
    image[:2] = b"MZ"
    image[60:64] = (64).to_bytes(4, "little")
    image[64:68] = b"PE\0\0"
    image[68:70] = (0x8664).to_bytes(2, "little")
    image[70:72] = (1).to_bytes(2, "little")
    image[84:86] = (240).to_bytes(2, "little")
    image[86:88] = (0x2002).to_bytes(2, "little")
    image[88:90] = (0x20b).to_bytes(2, "little")
    table = 64 + 24 + 240
    marker = release.SETUP_LEASE_NAPI_MARKER
    image[table + 16:table + 20] = len(marker).to_bytes(4, "little")
    image[table + 20:table + 24] = (512).to_bytes(4, "little")
    image[table + 36:table + 40] = (0x40000040).to_bytes(4, "little")
    image[512:512 + len(marker)] = marker
    return bytes(image)


def _producer_addon(tmp_path):
    addon = tmp_path / "setup_lease.node"
    addon.write_bytes(_addon_image())
    source = release.REPO_ROOT
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    hashes = {}
    for relative in release.SETUP_LEASE_SOURCE_PATHS:
        committed = subprocess.run(["git", "show", f"{sha}:{relative}"], cwd=source,
                                   capture_output=True, check=True).stdout
        hashes[relative] = hashlib.sha256(committed).hexdigest()
    (tmp_path / "setup_lease.provenance.json").write_text(json.dumps({
        "schema": 1,
        "source_sha": sha,
        "source_files_sha256": hashes,
        "electron_target": "42.11.12",
        "build_tool": "node-gyp",
        "build_command": "node-gyp rebuild --target=42.11.12 --dist-url=https://electronjs.org/headers",
        "build_result": 0,
        "addon_sha256": hashlib.sha256(addon.read_bytes()).hexdigest(),
        "addon_size": addon.stat().st_size,
    }), encoding="utf-8")
    return addon


def _customer_image(tmp_path, sha):
    root = tmp_path / "customer-image"
    common_setup = _setup_image(sha, BASE)
    revision = "1234"
    registry = json.dumps({"browsers": [
        {"name": "chromium", "revision": revision},
        {"name": "chromium-headless-shell", "revision": revision},
        {"name": "ffmpeg", "revision": "1011"},
        {"name": "winldd", "revision": "1007"},
    ]}).encode()
    paths = {
        "apps/desktop/release/win-unpacked/Youtab.exe": _setup_image(sha, BASE),
        "apps/desktop/release/win-unpacked/resources/app.asar": b"synthetic packaged app",
        "apps/desktop/release/win-unpacked/resources/update-coordination/Youtab-Setup.exe": common_setup,
        "apps/desktop/release/win-unpacked/resources/install-stamp.json": json.dumps({
            "commit": sha, "dirty": False,
            "releaseBaseUrl": BASE,
            "updateCoordination": {"protocol": 1, "sourceSha": sha,
                                   "sha256": hashlib.sha256(common_setup).hexdigest(),
                                   "size": len(common_setup), "handoffProtocol": 2},
            "setupLease": {"sha256": hashlib.sha256(_addon_image()).hexdigest(),
                           "size": len(_addon_image())},
        }).encode(),
        "apps/desktop/release/win-unpacked/resources/app.asar.unpacked/dist/native/setup_lease.node": _addon_image(),
        "node/node.exe": _setup_image(sha, BASE),
        "browser/agent-browser.exe": _setup_image(sha, BASE),
        "browser/ms-playwright/browsers.json": registry,
        f"browser/ms-playwright/chromium-{revision}/chrome-win64/chrome.exe": _setup_image(sha, BASE),
        f"browser/ms-playwright/chromium-{revision}/INSTALLATION_COMPLETE": b"",
        f"browser/ms-playwright/chromium_headless_shell-{revision}/chrome-headless-shell-win64/chrome-headless-shell.exe": _setup_image(sha, BASE),
        "browser/ms-playwright/ffmpeg-1011/ffmpeg-win64.exe": _setup_image(sha, BASE),
        "browser/ms-playwright/winldd-1007/PrintDeps.exe": _setup_image(sha, BASE),
        "ui-tui/dist/entry.js": b"console.log('Youtab');\n",
        "youtab_agent_cli/web_dist/index.html": b"<main>Youtab dashboard</main>",
    }
    for relative, content in paths.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    desktop_count, desktop_size, desktop_digest = _tree_digest(root / "apps/desktop/release/win-unpacked")
    web_count, web_size, web_digest = _tree_digest(root / "youtab_agent_cli/web_dist")
    receipt = {
        "schema_version": 1, "source_sha": sha,
        "lock_sha256": hashlib.sha256(subprocess.run(
            ["git", "show", f"{sha}:package-lock.json"], cwd=release.REPO_ROOT,
            capture_output=True, check=True,
        ).stdout).hexdigest(),
        "node_sha256": NODE_SHA256, "npm_version": "10.9.2",
        "release_base_url": BASE,
        "common_setup": {"sha256": hashlib.sha256(common_setup).hexdigest(),
                         "size": len(common_setup)},
        "steps": [{"command": step, "exit_code": 0} for step in BUILD_STEPS],
        "desktop": {"file_count": desktop_count, "total_size": desktop_size,
                    "tree_sha256": desktop_digest},
        "web": {"file_count": web_count, "total_size": web_size,
                "tree_sha256": web_digest},
        "tui_sha256": hashlib.sha256(paths["ui-tui/dist/entry.js"]).hexdigest(),
        "lease_sha256": hashlib.sha256(_addon_image()).hexdigest(),
    }
    receipt_bytes = json.dumps(receipt, sort_keys=True).encode()
    paths["producer-receipt.json"] = receipt_bytes
    (root / "producer-receipt.json").write_bytes(receipt_bytes)
    records = [
        {"path": name, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        for name, content in sorted(paths.items(), key=lambda item: item[0].casefold())
    ]
    def digest(items):
        value = hashlib.sha256()
        for item in items:
            value.update(f'{item["path"]}\0{item["size"]}\0{item["sha256"]}\n'.encode())
        return value.hexdigest()
    lock = subprocess.run(["git", "show", f"{sha}:package-lock.json"], cwd=release.REPO_ROOT,
                          capture_output=True, check=True).stdout
    manifest = {
        "schema_version": 1, "platform": "windows", "architecture": "x64",
        "source_sha": sha, "source_qualified": True,
        "producer_receipt_sha256": hashlib.sha256(receipt_bytes).hexdigest(),
        "lock_sha256": hashlib.sha256(lock).hexdigest(),
        "components": release.CUSTOMER_IMAGE_COMPONENTS,
        "agent_browser_version": "0.26.0",
        "playwright_chromium_revision": revision,
        "playwright_ffmpeg_revision": "1011", "playwright_winldd_revision": "1007",
        "browser_tree_sha256": digest([item for item in records if item["path"].startswith((
            f"browser/ms-playwright/chromium-{revision}/",
            f"browser/ms-playwright/chromium_headless_shell-{revision}/",
            "browser/ms-playwright/ffmpeg-1011/",
            "browser/ms-playwright/winldd-1007/",
        ))]),
        "dashboard_tree_sha256": digest([item for item in records if item["path"].startswith(
            "youtab_agent_cli/web_dist/")]),
        "node_sha256": hashlib.sha256(paths["node/node.exe"]).hexdigest(),
        "agent_browser_sha256": hashlib.sha256(paths["browser/agent-browser.exe"]).hexdigest(),
        "playwright_browsers_json_sha256": hashlib.sha256(registry).hexdigest(),
        "tree_sha256": digest(records),
        "file_count": len(records), "total_size": sum(item["size"] for item in records),
        "files": records,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
    return root


def test_common_setup_is_included_with_source_and_hash_binding(committed_source, tmp_path):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    setup = tmp_path / "setup.exe"
    setup.write_bytes(_setup_image(sha, BASE))
    notes = ["Setup and Runtime are updated together."]
    manifest = release.package_runtime_artifact(tmp_path / "releases", "0.19.2", 4, BASE, setup,
                                                _producer_addon(tmp_path), _customer_image(tmp_path, sha), notes)
    packaged = tmp_path / "releases" / sha / f"Youtab-Setup-{sha}.exe"
    assert packaged.read_bytes() == setup.read_bytes()
    assert manifest["setup_sha256"] == hashlib.sha256(setup.read_bytes()).hexdigest()
    assert manifest["setup_source_sha"] == sha
    assert manifest["setup_size"] == len(setup.read_bytes())
    assert manifest["updater_protocol"] == 1
    assert manifest["update_coordination_protocol"] == 1
    assert manifest["release_notes"] == notes
    assert manifest["setup_lease_sha256"] == hashlib.sha256(_addon_image()).hexdigest()
    assert manifest["setup_lease_size"] == len(_addon_image())
    assert manifest["customer_image_file_count"] == 16
    with zipfile.ZipFile(tmp_path / "releases" / sha / f"youtab-runtime-{sha}.zip") as archive:
        assert archive.read(f"youtab-runtime-{sha}/{release.SETUP_LEASE_ZIP_PATH}") == _addon_image()
        assert archive.read(f"youtab-runtime-{sha}/node/node.exe") == _setup_image(sha, BASE)
        assert release.CUSTOMER_IMAGE_MANIFEST_PATH in {
            name.removeprefix(f"youtab-runtime-{sha}/") for name in archive.namelist()
        }
    latest = json.loads((tmp_path / "releases" / "latest.json").read_text())
    immutable = json.loads((tmp_path / "releases" / sha / "manifest.json").read_text())
    assert latest["update_coordination_protocol"] == immutable["update_coordination_protocol"] == 1
    assert latest["release_notes"] == immutable["release_notes"] == notes


def test_customer_setup_requires_release_notes(committed_source, tmp_path):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    setup = tmp_path / "setup.exe"
    setup.write_bytes(_setup_image(sha, BASE))
    with pytest.raises(ValueError, match="customer release notes are required"):
        release.package_runtime_artifact(tmp_path / "releases", "0.19.2", 4, BASE, setup,
                                         _producer_addon(tmp_path), _customer_image(tmp_path, sha))


def test_customer_release_rejects_different_setup_with_same_source_and_base(committed_source, tmp_path):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    image = _customer_image(tmp_path, sha)
    changed = bytearray(_setup_image(sha, BASE))
    changed[-1] = 1
    setup = tmp_path / "alternate-setup.exe"
    setup.write_bytes(changed)
    output = tmp_path / "releases"

    with pytest.raises(ValueError, match="published Setup differs"):
        release.package_runtime_artifact(output, "0.19.2", 4, BASE, setup,
                                         _producer_addon(tmp_path), image, ["Setup and Runtime are updated together."])
    assert not (output / sha).exists()


def test_customer_image_runtime_zip_is_deterministic(committed_source, tmp_path):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    setup = tmp_path / "setup.exe"
    setup.write_bytes(_setup_image(sha, BASE))
    addon = _producer_addon(tmp_path)
    image = _customer_image(tmp_path, sha)
    archives = []
    for output in (tmp_path / "first", tmp_path / "second"):
        release.package_runtime_artifact(output, "0.19.2", 4, BASE, setup, addon, image,
                                         ["Setup and Runtime are updated together."])
        archives.append((output / sha / f"youtab-runtime-{sha}.zip").read_bytes())
    assert hashlib.sha256(archives[0]).digest() == hashlib.sha256(archives[1]).digest()


@pytest.mark.parametrize("case", ["wrong_source", "wrong_base", "not_executable"])
def test_common_setup_rejects_mismatched_or_invalid_binary(committed_source, tmp_path, case):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    setup = tmp_path / "setup.exe"
    setup.write_bytes(_setup_image("b" * 40 if case == "wrong_source" else sha,
                                  "https://wrong.invalid" if case == "wrong_base" else BASE)
                     if case != "not_executable" else b"not executable")
    with pytest.raises(ValueError):
        release.package_runtime_artifact(tmp_path / "releases", "0.19.2", 4, BASE, setup,
                                         _producer_addon(tmp_path), _customer_image(tmp_path, sha),
                                         ["Setup and Runtime are updated together."])
    assert not (tmp_path / "releases" / sha).exists()


def test_customer_release_requires_producer_addon(committed_source, tmp_path):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    setup = tmp_path / "setup.exe"
    setup.write_bytes(_setup_image(sha, BASE))
    out = tmp_path / "releases"
    with pytest.raises(ValueError, match="supplied together"):
        release.package_runtime_artifact(out, "0.19.2", 4, BASE, setup)
    assert not out.exists()


@pytest.mark.parametrize("defect", ["missing", "wrong_source", "wrong_hash", "wrong_target", "wrong_binary"])
def test_customer_release_rejects_bad_producer_receipt(committed_source, tmp_path, defect):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    setup = tmp_path / "setup.exe"
    setup.write_bytes(_setup_image(sha, BASE))
    addon = _producer_addon(tmp_path)
    path = tmp_path / "setup_lease.provenance.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if defect == "missing":
        path.unlink()
    elif defect == "wrong_source":
        data["source_sha"] = "f" * 40
    elif defect == "wrong_hash":
        data["source_files_sha256"]["apps/desktop/native/setup-lease/setup_lease.cc"] = "0" * 64
    elif defect == "wrong_target":
        data["electron_target"] = "42.0.0"
    else:
        data["addon_sha256"] = "0" * 64
    if defect != "missing":
        path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="producer|Electron target"):
        release.package_runtime_artifact(tmp_path / "releases", "0.19.2", 4, BASE, setup, addon,
                                         _customer_image(tmp_path, sha), ["Setup and Runtime are updated together."])


@pytest.mark.parametrize("defect", ["missing", "wrong_arch", "writable", "overlay_only", "tampered"])
def test_customer_release_rejects_unqualified_addon(committed_source, tmp_path, defect):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    setup = tmp_path / "setup.exe"
    setup.write_bytes(_setup_image(sha, BASE))
    addon = _producer_addon(tmp_path)
    image = bytearray(addon.read_bytes())
    if defect == "missing":
        addon.unlink()
    elif defect == "wrong_arch":
        image[68:70] = (0xaa64).to_bytes(2, "little")
    elif defect == "writable":
        image[364:368] = (0xc0000040).to_bytes(4, "little")
    elif defect == "overlay_only":
        image[512:512 + len(release.SETUP_LEASE_NAPI_MARKER)] = b"x" * len(release.SETUP_LEASE_NAPI_MARKER)
        image.extend(release.SETUP_LEASE_NAPI_MARKER)
    else:
        image[:] = b"invalid"
    if defect != "missing":
        addon.write_bytes(image)
    out = tmp_path / "releases"
    with pytest.raises(ValueError):
        release.package_runtime_artifact(out, "0.19.2", 4, BASE, setup, addon,
                                         _customer_image(tmp_path, sha), ["Setup and Runtime are updated together."])
    assert not out.exists()


@pytest.mark.parametrize("defect", ["missing", "incomplete", "tampered", "unsafe_path", "unlisted_map", "hardlink",
                                    "receipt_missing", "receipt_stale_desktop", "receipt_stale_tui"])
def test_customer_release_rejects_incomplete_or_changed_image(committed_source, tmp_path, defect):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    setup = tmp_path / "setup.exe"
    setup.write_bytes(_setup_image(sha, BASE))
    addon = _producer_addon(tmp_path)
    image = _customer_image(tmp_path, sha)
    manifest_path = image / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if defect == "missing":
        shutil.rmtree(image)
    elif defect == "incomplete":
        manifest["components"] = ["desktop"]
    elif defect == "tampered":
        (image / "node/node.exe").write_bytes(b"changed")
    elif defect == "unsafe_path":
        manifest["files"][0]["path"] = "../escape.exe"
    elif defect == "unlisted_map":
        (image / "ui-tui/dist/entry.js.map").write_bytes(b"source map")
    elif defect == "receipt_missing":
        (image / "producer-receipt.json").unlink()
    elif defect in {"receipt_stale_desktop", "receipt_stale_tui"}:
        name = ("apps/desktop/release/win-unpacked/resources/app.asar"
                if defect == "receipt_stale_desktop" else "ui-tui/dist/entry.js")
        changed = b"x" * (image / name).stat().st_size
        (image / name).write_bytes(changed)
        entry = next(item for item in manifest["files"] if item["path"] == name)
        entry["sha256"] = hashlib.sha256(changed).hexdigest()
        digest = hashlib.sha256()
        for item in manifest["files"]:
            digest.update(f'{item["path"]}\0{item["size"]}\0{item["sha256"]}\n'.encode())
        manifest["tree_sha256"] = digest.hexdigest()
    else:
        os.link(image / "node/node.exe", image / "node/node-copy.exe")
    if defect in {"incomplete", "unsafe_path", "receipt_stale_desktop", "receipt_stale_tui"}:
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    out = tmp_path / "releases"
    with pytest.raises((ValueError, FileNotFoundError)):
        release.package_runtime_artifact(out, "0.19.2", 4, BASE, setup, addon, image,
                                         ["Setup and Runtime are updated together."])
    assert not out.exists()


@pytest.mark.parametrize("case", ["old_setup", "flags_only", "overlay_only", "writable", "truncated_table"])
def test_common_setup_cannot_advertise_uncompiled_coordination(committed_source, tmp_path, case):
    sha = release.git_result("rev-parse", "HEAD").stdout.strip()
    data = bytearray(_setup_image(sha, BASE))
    marker = release.UPDATE_COORDINATION_PE_MARKER
    start = data.index(marker)
    data[start:start + len(marker)] = b"x" * len(marker)
    if case == "flags_only":
        data.extend(b"--update-coordination-v1")
    elif case == "overlay_only":
        data.extend(marker)
    elif case == "writable":
        data[start:start + len(marker)] = marker
        data[364:368] = (0xc0000040).to_bytes(4, "little")
    elif case == "truncated_table":
        data[70:72] = (96).to_bytes(2, "little")
    setup = tmp_path / "setup.exe"
    setup.write_bytes(data)
    out = tmp_path / "no-release"
    with pytest.raises(ValueError, match="compiled update coordination"):
        release.package_runtime_artifact(out, "0.19.2", 4, BASE, setup,
                                         _producer_addon(tmp_path), _customer_image(tmp_path, sha),
                                         ["Setup and Runtime are updated together."])
    assert not out.exists()


BASE = "https://api.youtab.io/pilot-runtime-" + "a" * 32 + "/releases"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def committed_source(tmp_path, monkeypatch, request):
    repo = tmp_path / "repo"
    repo.mkdir()
    for name, content in {
        "scripts/install.ps1": "Write-Host Youtab\n",
        "scripts/install-managed-ffmpeg.ps1": "# synthetic managed dependency layout\n",
        "pyproject.toml": "[project]\nname = 'youtab-agent-runtime'\n",
        "apps/desktop/package.json": '{"name":"youtab","devDependencies":{"electron":"42.11.12"},"build":{"electronVersion":"42.11.12"}}\n',
        "apps/desktop/native/setup-lease/binding.gyp": '{"targets":[]}\n',
        "apps/desktop/native/setup-lease/setup_lease.cc": '// synthetic producer source\n',
        "package-lock.json": '{"packages":{"node_modules/electron":{"version":"42.11.12"},"node_modules/agent-browser":{"version":"0.26.0"}}}\n',
        "agent/runtime.py": "print('runtime')\n",
        "agent/runtime.py.map": '{"sourcesContent":["private source"]}\n',
        "agent/runtime.py.MAP": '{"sourcesContent":["private source"]}\n',
        "packages/youtab-ui-desktop/dist/fonts.js.map": '{"sourcesContent":["private source"]}\n',
        "scripts/whatsapp-bridge/bridge.js": "export {};\n",
        "scripts/whatsapp-bridge/package.json": '{"type":"module"}\n',
        "scripts/whatsapp-bridge/package-lock.json": '{}\n',
        "scripts/whatsapp-bridge/media-wire.js": "export {};\n",
        "scripts/whatsapp-bridge/media-route.js": "export {};\n",
        "scripts/whatsapp-bridge/media-codec.js": "export {};\n",
        "scripts/whatsapp-bridge/private-temp.js": "export {};\n",
        "scripts/whatsapp-bridge/media-route.test.js": "throw new Error('test-only');\n",
        "plugins/platforms/whatsapp/managed_codec.py": "# synthetic dependency resolver layout\n",
        "native/managed-dependencies/ffmpeg/bin/ffmpeg.exe": "synthetic producer binary must not be repackaged\n",
        "native/managed-dependencies/ffmpeg/LICENSE": "synthetic producer notice\n",
        "skills/testing/base/SKILL.md": "---\nname: base\ndescription: Base skill\n---\nBase instructions.\n",
        "tests/ignored.py": "test-only\n",
        ".github/workflows/ignored.yml": "dev-only\n",
    }.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
    product_root = Path(release.__file__).resolve().parent.parent
    for relative in (
        "scripts/private-home-publication.ps1",
        "scripts/private-home-launchers.py",
        "scripts/youtab/relocation_seed.py",
    ):
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(product_root / relative, target)
    for relative in (
        "scripts/private-home-publication-extra.ps1",
        "scripts/private-home-launchers.py.bak",
        "scripts/youtab/other.py",
        "scripts/release.py",
    ):
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"synthetic excluded development script\n")
    for item in release.EXPECTED_WHEELS.values():
        target = repo / item["relative_path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(product_root / item["relative_path"], target)
    for name, content in {
        "tools/windows_pty_dependency.py": "# synthetic helper layout\n",
        "native/python-wheels/pywinpty/PROVENANCE.json": "{}\n",
        "native/python-wheels/pywinpty/SDK.patch": "# synthetic patch layout\n",
        "native/python-wheels/pywinpty/UPSTREAM_LICENSE.txt": "# synthetic notice layout\n",
    }.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
    _git(repo, "init")
    autocrlf = getattr(request, "param", False)
    assert type(autocrlf) is bool
    _git(repo, "config", "core.autocrlf", "true" if autocrlf else "false")
    _git(repo, "config", "user.name", "Release Test")
    _git(repo, "config", "user.email", "release@example.invalid")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "source")
    monkeypatch.setattr(release, "REPO_ROOT", repo)
    fixture_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                                 capture_output=True, check=True, text=True).stdout.strip()
    synthetic_pe_digest = hashlib.sha256(_setup_image(fixture_sha, BASE)).hexdigest()
    monkeypatch.setattr(release, "OFFICIAL_NODE_X64_SHA256", synthetic_pe_digest)
    monkeypatch.setattr(release, "OFFICIAL_AGENT_BROWSER_X64_SHA256", synthetic_pe_digest)
    return repo


@pytest.mark.parametrize("version", ["0.19.1", "0.19.2.1"])
def test_static_release_is_sha_bound_and_immutable(committed_source, tmp_path, version):
    out = tmp_path / "static-releases"
    manifest = release.package_runtime_artifact(out, version, 1, BASE)
    sha = manifest["source_sha"]
    immutable = out / sha
    archive = immutable / f"youtab-runtime-{sha}.zip"
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest["sha256"]
    assert (immutable / f"install-{sha}.ps1").read_bytes() == b"Write-Host Youtab\n"
    assert manifest["install_script_sha256"] == hashlib.sha256(b"Write-Host Youtab\n").hexdigest()
    assert json.loads((immutable / "manifest.json").read_text()) == manifest
    latest = json.loads((out / "latest.json").read_text())
    assert latest["manifest_url"] == f"{BASE}/{sha}/manifest.json"
    assert latest["release_sequence"] == 1
    with zipfile.ZipFile(archive) as package:
        names = set(package.namelist())
        contract = json.loads(package.read(f"youtab-runtime-{sha}/runtime-desktop.json"))
    assert contract == {
        "schemaVersion": 1, "sourceSha": sha, "version": version,
        "entrypoint": "venv/Scripts/youtab.exe", "capabilities": ["serve"],
    }
    assert f"youtab-runtime-{sha}/agent/runtime.py" in names
    assert not any("tests/" in name or ".github/" in name for name in names)

    before = (out / "latest.json").read_bytes()
    with pytest.raises(FileExistsError):
        release.package_runtime_artifact(out, "0.19.2", 2, BASE)
    assert (out / "latest.json").read_bytes() == before


def test_shared_payload_has_all_qualified_abis_and_bound_metadata(committed_source, tmp_path):
    out = tmp_path / "releases"
    manifest = release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    spec = json.loads(manifest["native_dependencies_json"])
    assert spec["version"] == "2.0.15+youtab.1"
    assert {entry["abi"] for entry in spec["wheels"]} == {"cp311", "cp312", "cp313"}
    archive = out / manifest["source_sha"] / f"youtab-runtime-{manifest['source_sha']}.zip"
    with zipfile.ZipFile(archive) as package:
        for item in release.EXPECTED_WHEELS.values():
            data = package.read(f"youtab-runtime-{manifest['source_sha']}/{item['relative_path']}")
            assert hashlib.sha256(data).hexdigest() == item["wheel_sha256"]


def test_changed_committed_sdk_wheel_cannot_promote_latest(committed_source, tmp_path):
    item = release.EXPECTED_WHEELS["cp312"]
    (committed_source / item["relative_path"]).write_bytes(b"not the qualified SDK")
    _git(committed_source, "add", ".")
    _git(committed_source, "commit", "-m", "synthetic tampered SDK input")
    out = tmp_path / "releases"
    with pytest.raises((ValueError, RuntimeError)):
        release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    assert not (out / "latest.json").exists()


def test_missing_capability_instructions_prevents_publication(committed_source, tmp_path, monkeypatch):
    original_filter = release._runtime_artifact_path_allowed
    monkeypatch.setattr(
        release, "_runtime_artifact_path_allowed",
        lambda name: original_filter(name) and not name.endswith("SKILL.md"),
    )
    out = tmp_path / "releases"
    with pytest.raises(RuntimeError, match="lacks capability instructions"):
        release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    assert not (out / "latest.json").exists()


def test_runtime_zip_includes_optional_gitnexus_gate_with_other_capabilities(
    committed_source, tmp_path,
):
    _git(committed_source, "config", "core.autocrlf", "false")
    gitnexus_dir = (
        Path(__file__).resolve().parents[1]
        / "optional-skills/research/gitnexus-explorer"
    )
    capabilities = {
        "skills/engineering/planner/SKILL.md": b"Plan work safely.\n",
        "optional-skills/research/gitnexus-explorer/SKILL.md":
            (gitnexus_dir / "SKILL.md").read_bytes(),
        "optional-skills/research/gitnexus-explorer/scripts/proxy.mjs":
            (gitnexus_dir / "scripts/proxy.mjs").read_bytes(),
        "plugins/example/SKILL.md": b"Use the example plugin.\n",
    }
    for name, content in capabilities.items():
        path = committed_source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    _git(committed_source, "add", ".")
    _git(committed_source, "commit", "-m", "capability fixtures")

    out = tmp_path / "releases"
    sha = release.package_runtime_artifact(out, "0.19.1", 1, BASE)["source_sha"]
    with zipfile.ZipFile(out / sha / f"youtab-runtime-{sha}.zip") as archive:
        for name, content in capabilities.items():
            assert archive.read(f"youtab-runtime-{sha}/{name}") == content


def test_extracted_artifact_seeds_skills_and_preserves_user_customizations(
    committed_source, tmp_path, monkeypatch,
):
    from tools import skills_sync

    payloads = {
        "skills/engineering/planner/SKILL.md":
            "---\nname: planner\ndescription: Plan work\n---\nRead references/steps.md.\n",
        "skills/engineering/planner/references/steps.md": "Plan, verify, report.\n",
        "optional-skills/engineering/reviewer/SKILL.md":
            "---\nname: reviewer\ndescription: Review changes\n---\nReview safely.\n",
        "plugins/example/SKILL.md": "---\nname: example-plugin\n---\nPlugin instructions.\n",
        "docs/NOT_SHIPPED.md": "Developer documentation.\n",
    }
    for name, content in payloads.items():
        path = committed_source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    _git(committed_source, "add", ".")
    _git(committed_source, "commit", "-m", "capability fixtures")
    out = tmp_path / "releases"
    manifest = release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    sha = manifest["source_sha"]
    extracted = tmp_path / "extracted"
    with zipfile.ZipFile(out / sha / f"youtab-runtime-{sha}.zip") as archive:
        archive.extractall(extracted)
    runtime = extracted / f"youtab-runtime-{sha}"
    for name, content in payloads.items():
        if name.startswith("docs/"):
            assert not (runtime / name).exists()
        else:
            assert (runtime / name).read_text(encoding="utf-8") == content
    home = tmp_path / "isolated-user-home"
    active = home / "skills"
    monkeypatch.setattr(skills_sync, "YOUTAB_AGENT_HOME", home)
    monkeypatch.setattr(skills_sync, "SKILLS_DIR", active)
    monkeypatch.setattr(skills_sync, "MANIFEST_FILE", active / ".bundled_manifest")
    monkeypatch.setattr(skills_sync, "_get_bundled_dir", lambda: runtime / "skills")
    monkeypatch.setattr(skills_sync, "_get_optional_dir", lambda: runtime / "optional-skills")
    monkeypatch.setattr(skills_sync, "_build_external_skill_index", set)
    result = skills_sync.sync_skills(quiet=True)
    assert "planner" in result["copied"]
    installed = active / "engineering/planner"
    assert (installed / "references/steps.md").read_text() == payloads[
        "skills/engineering/planner/references/steps.md"
    ]
    (installed / "SKILL.md").write_text("User-customized instructions.\n")
    skills_sync.sync_skills(quiet=True)
    assert (installed / "SKILL.md").read_text() == "User-customized instructions.\n"


def test_dirty_checkout_and_secret_file_fail_closed(committed_source, tmp_path):
    out = tmp_path / "releases"
    (committed_source / "agent/runtime.py").write_text("dirty\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="clean checkout"):
        release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    assert not (out / "latest.json").exists()

    _git(committed_source, "restore", "agent/runtime.py")
    (committed_source / "agent/private.pem").write_text("secret", encoding="utf-8")
    _git(committed_source, "add", "agent/private.pem")
    _git(committed_source, "commit", "-m", "bad source")
    with pytest.raises(RuntimeError, match="credential-like file"):
        release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    assert not (out / "latest.json").exists()


def test_private_key_material_after_first_megabyte_is_rejected(committed_source, tmp_path):
    payload = committed_source / "agent" / "large.txt"
    payload.write_bytes(b"x" * (1024 * 1024 + 3) + b"\n-----BEGIN PRIVATE KEY-----\n")
    _git(committed_source, "add", "agent/large.txt")
    _git(committed_source, "commit", "-m", "late secret")
    out = tmp_path / "releases"
    with pytest.raises(RuntimeError, match="private-key material"):
        release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    assert not (out / "latest.json").exists()

def test_release_url_and_sequence_are_strict(committed_source, tmp_path):
    out = tmp_path / "releases"
    for invalid in ("http://api.youtab.io/pilot-runtime-" + "a" * 32 + "/releases",
                    "https://evil.example/pilot-runtime-" + "a" * 32 + "/releases",
                    "https://api.youtab.io/release"):
        with pytest.raises(ValueError):
            release.package_runtime_artifact(out, "0.19.1", 1, invalid)
    with pytest.raises(ValueError, match="positive"):
        release.package_runtime_artifact(out, "0.19.1", 0, BASE)


def test_existing_latest_cannot_be_downgraded(committed_source, tmp_path):
    out = tmp_path / "releases"
    out.mkdir()
    latest = out / "latest.json"
    latest.write_text('{"release_sequence": 5}\n', encoding="utf-8")
    with pytest.raises(RuntimeError, match="must increase"):
        release.package_runtime_artifact(out, "0.19.1", 4, BASE)
    assert latest.read_text(encoding="utf-8") == '{"release_sequence": 5}\n'


def test_real_checkout_filter_preserves_workspace_build_inputs():
    environment = None
    commit = "HEAD"
    receipt_path = os.environ.get("YOUTAB_TEST_SOURCE_GIT_RECEIPT")
    if receipt_path:
        # Only this actual Source query uses external metadata; fixture Git stays local.
        raw = Path(receipt_path).read_bytes()
        expected = os.environ.get("YOUTAB_TEST_SOURCE_GIT_RECEIPT_SHA256", "")
        assert re.fullmatch(r"[0-9a-f]{64}", expected)
        assert hashlib.sha256(raw).hexdigest() == expected
        receipt = json.loads(raw)
        assert receipt["status"] == "OFFLINE_EXACT_RAW_SOURCE_COMMIT_NOT_RELEASE_QUALIFIED"
        assert receipt["raw_tree_and_archive_verified"] is True and receipt["source_postguard"] is True
        assert receipt["published"] is False
        commit = receipt["commit"]
        assert re.fullmatch(r"[0-9a-f]{40}", commit)
        binding = receipt["build_environment"]
        assert Path(binding["GIT_WORK_TREE"]).resolve() == release.REPO_ROOT.resolve()
        assert binding["YOUTAB_AGENT_BUILD_PIN_COMMIT"] == commit
        assert Path(binding["GIT_DIR"]).is_absolute() and Path(binding["GIT_DIR"]).is_dir()
        assert Path(binding["GIT_INDEX_FILE"]).is_absolute()
        environment = dict(os.environ)
        environment.update({key: binding[key] for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE")})
        # A stale original pin cannot stand in for the newly corrected candidate.
        for relative in ("scripts/release.py", "youtab_constants.py", "tests/test_release_runtime_artifact.py"):
            committed = subprocess.run(
                ["git", "show", f"{commit}:{relative}"], cwd=release.REPO_ROOT,
                env=environment, capture_output=True, check=True,
            ).stdout
            assert committed == (release.REPO_ROOT / relative).read_bytes()
    names = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", commit], cwd=release.REPO_ROOT,
        env=environment, text=True, capture_output=True, check=True,
    ).stdout.splitlines()
    included = {name for name in names if release._runtime_artifact_path_allowed(name)}
    required = {
        "package.json", "package-lock.json", "pyproject.toml", "uv.lock",
        "scripts/install.ps1", "apps/bootstrap-installer/package.json",
        "apps/desktop/package.json", "apps/desktop/vite.config.ts",
        "apps/desktop/scripts/write-build-stamp.mjs", "apps/desktop/electron/main.ts",
        "apps/shared/package.json", "ui-tui/package.json", "web/package.json",
        "tests-js/package.json", "packages/youtab-ui-desktop/package.json",
    }
    assert required <= included
    assert any(name.startswith("apps/desktop/src/") for name in included)
    assert any(name.startswith("packages/youtab-ui-desktop/") for name in included)
    assert "apps/bootstrap-installer/src-tauri/src/bootstrap.rs" not in included
    assert "tests-js/assistant-ui-tap-compat.test.ts" not in included
    assert "scripts/release.py" not in included
    assert not any(name.casefold().endswith(".map") for name in included)
    assert not any(name.endswith(".pem") or "/e2e/" in name for name in included)


def _retired_header():
    block, corner = chr(0x2588), chr(0x2557)
    return block * 2 + corner + "  " + block * 2 + corner + block * 7 + corner + block * 6 + corner + " " + block * 3 + corner

@pytest.mark.parametrize("name", ["cli.py", "youtab_agent_cli/banner.py", "ui-tui/src/banner.ts", "assets/renamed-title.txt"])
def test_retired_banner_cannot_be_published(committed_source, tmp_path, name):
    path = committed_source / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('BANNER = "' + _retired_header() + '"\n', encoding="utf-8")
    _git(committed_source, "add", ".")
    _git(committed_source, "commit", "-m", "retired banner fixture")
    out = tmp_path / "releases"
    out.mkdir()
    previous = '{"release_sequence": 1}\n'
    (out / "latest.json").write_text(previous, encoding="utf-8")
    with pytest.raises(RuntimeError, match="retired CLI banner"):
        release.package_runtime_artifact(out, "0.19.2", 2, BASE)
    assert (out / "latest.json").read_text(encoding="utf-8") == previous
    assert not any(p.is_dir() for p in out.iterdir())


def test_whatsapp_runtime_closure_and_managed_codec_are_in_actual_zip(committed_source, tmp_path):
    out = tmp_path / "closure-release"
    manifest = release.package_runtime_artifact(out, "0.19.2", 7, BASE)
    sha = manifest["source_sha"]
    prefix = f"youtab-runtime-{sha}/"
    with zipfile.ZipFile(out / sha / f"youtab-runtime-{sha}.zip") as archive:
        names = {name.removeprefix(prefix) for name in archive.namelist()}
        assert {"scripts/whatsapp-bridge/bridge.js", "scripts/whatsapp-bridge/package.json",
                "scripts/whatsapp-bridge/package-lock.json", "scripts/whatsapp-bridge/media-wire.js",
                "scripts/whatsapp-bridge/media-route.js", "scripts/whatsapp-bridge/media-codec.js",
                "scripts/whatsapp-bridge/private-temp.js", "plugins/platforms/whatsapp/managed_codec.py"} <= names
        assert "scripts/whatsapp-bridge/media-route.test.js" not in names
        assert "agent/runtime.py.map" not in names
        assert "agent/runtime.py.MAP" not in names
        assert "packages/youtab-ui-desktop/dist/fonts.js.map" not in names
        descriptor = json.loads(manifest["managed_dependencies_json"])["ffmpeg"]
        assert descriptor["acquisition"] == "installer-direct-origin"
        assert isinstance(manifest["managed_dependencies_json"], str)
        # Existing About consumers compare each JSON descriptor value strictly.
        assert all(not isinstance(value, (dict, list)) for value in manifest.values())
        assert not any(name.startswith(release.MANAGED_FFMPEG_DIRECTORY + "/") for name in names)
        assert "scripts/install-managed-ffmpeg.ps1" in names


_PRIVATE_HOME_ARTIFACT_HELPERS = (
    "scripts/private-home-publication.ps1",
    "scripts/private-home-launchers.py",
    "scripts/youtab/relocation_seed.py",
)


@pytest.mark.parametrize("committed_source", [False, True], indirect=True)
def test_runtime_zip_contains_exact_committed_private_home_helpers(committed_source, tmp_path):
    out = tmp_path / "migration-helper-release"
    manifest = release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    source_sha = manifest["source_sha"]
    archive = out / source_sha / f"youtab-runtime-{source_sha}.zip"
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest["sha256"]
    with zipfile.ZipFile(archive) as package:
        for relative in _PRIVATE_HOME_ARTIFACT_HELPERS:
            committed = subprocess.run(
                ["git", "show", f"{source_sha}:{relative}"], cwd=committed_source,
                check=True, capture_output=True,
            ).stdout
            packaged = package.read(f"youtab-runtime-{source_sha}/{relative}")
            assert packaged == committed
            assert hashlib.sha256(packaged).hexdigest() == hashlib.sha256(committed).hexdigest()
        for excluded in (
            "scripts/private-home-publication-extra.ps1",
            "scripts/private-home-launchers.py.bak",
            "scripts/youtab/other.py",
            "scripts/release.py",
        ):
            assert not release._runtime_artifact_path_allowed(excluded)
            assert f"youtab-runtime-{source_sha}/{excluded}" not in package.namelist()


@pytest.mark.parametrize("relative", _PRIVATE_HOME_ARTIFACT_HELPERS)
def test_runtime_zip_requires_each_private_home_helper(committed_source, tmp_path, relative):
    _git(committed_source, "rm", relative)
    _git(committed_source, "commit", "-m", "synthetic missing migration helper")
    out = tmp_path / "missing-helper-release"
    with pytest.raises(RuntimeError, match="release package lacks required files"):
        release.package_runtime_artifact(out, "0.19.1", 1, BASE)
    assert not (out / "latest.json").exists()
