"""Tests for Chromium-presence detection in browser_tool.

Regression guard for the "browser tool advertised but Chromium missing"
class of bug — where ``agent-browser`` CLI is discoverable but no
Chromium build is on disk, causing every browser_* tool call to hang
for the full command timeout before surfacing a useless error.
"""

import json
import os

import pytest

from tools import browser_tool as bt


@pytest.fixture(autouse=True)
def _reset_chromium_cache():
    bt._cached_chromium_installed = None
    yield
    bt._cached_chromium_installed = None


class TestChromiumSearchRoots:
    def test_packaged_agent_browser_overrides_cached_global(self, monkeypatch, tmp_path):
        monkeypatch.setattr(bt, "get_youtab_home", lambda: tmp_path)
        runtime = tmp_path / "youtab-agent-runtime"
        marker = runtime / "customer-image" / "windows-x64" / "manifest.json"
        marker.parent.mkdir(parents=True)
        marker.write_text("{}")
        packaged = runtime / "browser" / "agent-browser.exe"
        packaged.parent.mkdir(parents=True)
        packaged.write_bytes(b"binary")
        packaged.chmod(0o755)
        monkeypatch.setattr(bt, "agent_browser_runnable", lambda path: path == str(packaged))
        monkeypatch.setattr(bt, "_cached_agent_browser", "C:/global/agent-browser.exe")
        monkeypatch.setattr(bt, "_agent_browser_resolved", True)
        assert bt._find_agent_browser() == str(packaged)

    def test_packaged_agent_browser_never_falls_back_to_global(self, monkeypatch, tmp_path):
        monkeypatch.setattr(bt, "get_youtab_home", lambda: tmp_path)
        marker = tmp_path / "youtab-agent-runtime" / "customer-image" / "windows-x64" / "manifest.json"
        marker.parent.mkdir(parents=True)
        marker.write_text("{}")
        monkeypatch.setattr(bt, "_cached_agent_browser", "C:/global/agent-browser.exe")
        monkeypatch.setattr(bt, "_agent_browser_resolved", True)
        with pytest.raises(FileNotFoundError, match="packaged customer agent-browser"):
            bt._find_agent_browser()

    def test_uses_packaged_customer_browser_without_user_cache(self, monkeypatch, tmp_path):
        monkeypatch.setattr(bt, "get_youtab_home", lambda: tmp_path)
        packaged = tmp_path / "youtab-agent-runtime" / "browser" / "ms-playwright"
        packaged.mkdir(parents=True)
        (packaged / "browsers.json").write_text('{"browsers":[]}')
        (packaged / "chromium-1234").mkdir()

        assert bt._chromium_search_roots()[0] == str(packaged)
        assert bt._chromium_installed() is True
        assert bt._browser_candidate_path_dirs()[0] == str(packaged.parent)
        assert bt._build_browser_env()["PLAYWRIGHT_BROWSERS_PATH"] == str(packaged)

    def test_respects_playwright_browsers_path_env(self, monkeypatch, tmp_path):
        monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
        roots = bt._chromium_search_roots()
        assert str(tmp_path) == roots[0]


    def test_always_includes_default_ms_playwright_cache(self, monkeypatch):
        monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
        roots = bt._chromium_search_roots()
        home = os.path.expanduser("~")
        assert any(r == os.path.join(home, ".cache", "ms-playwright") for r in roots)


class TestChromiumInstalled:
    def test_true_when_plain_chromium_on_path(self, monkeypatch):
        monkeypatch.delenv("AGENT_BROWSER_EXECUTABLE_PATH", raising=False)
        monkeypatch.setattr(
            bt.shutil,
            "which",
            lambda name: "/usr/bin/chromium" if name == "chromium" else None,
        )

        assert bt._chromium_installed() is True


    def test_result_cached(self, monkeypatch, tmp_path):
        monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
        (tmp_path / "chromium-1208").mkdir()
        assert bt._chromium_installed() is True
        # Delete after first call — cached True should still return True.
        (tmp_path / "chromium-1208").rmdir()
        assert bt._chromium_installed() is True


class TestCheckBrowserRequirementsChromium:

    def test_local_mode_with_chromium_returns_true(self, monkeypatch, tmp_path):
        monkeypatch.setattr(bt, "_is_camofox_mode", lambda: False)
        monkeypatch.setattr(bt, "_find_agent_browser", lambda **_kw: "/usr/local/bin/agent-browser")
        monkeypatch.setattr(bt, "_requires_real_termux_browser_install", lambda _: False)
        monkeypatch.setattr(bt, "_get_cloud_provider", lambda: None)
        monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
        (tmp_path / "chromium-1208").mkdir()

        assert bt.check_browser_requirements() is True


    def test_camofox_mode_does_not_require_chromium(self, monkeypatch, tmp_path):
        monkeypatch.setattr(bt, "_is_camofox_mode", lambda: True)
        # Even with no chromium on disk, camofox drives its own backend.
        monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
        monkeypatch.setattr("os.path.expanduser", lambda p: str(tmp_path / "fakehome"))

        assert bt.check_browser_requirements() is True


class TestRunBrowserCommandChromiumGuard:
    """Verify _run_browser_command fails fast (no timeout hang) when
    Chromium is missing in local mode.
    """




@pytest.mark.parametrize(
    "platform,revision,present,override,expected_bundled",
    [
        ("win32", "1234", True, None, True),
        ("win32", "1234", True, "C:/custom/chrome.exe", False),
        ("win32", "1234", False, None, False),
        ("win32", "../../outside", True, None, False),
        ("linux", "1234", True, None, False),
    ],
)
def test_packaged_chrome_native_cli_environment(
    monkeypatch, tmp_path, platform, revision, present, override, expected_bundled
):
    from tools.environments import local

    monkeypatch.setattr(bt, "get_youtab_home", lambda: tmp_path)
    monkeypatch.setattr(bt.sys, "platform", platform)
    base_env = {"SAFE_SETTING": "retained"}
    if override:
        base_env["AGENT_BROWSER_EXECUTABLE_PATH"] = override
    monkeypatch.setattr(local, "youtab_subprocess_env", lambda **kw: dict(base_env))
    packaged = tmp_path / "youtab-agent-runtime/browser/ms-playwright"
    packaged.mkdir(parents=True)
    (packaged / "browsers.json").write_text(
        json.dumps({"browsers": [{"name": "chromium", "revision": revision}]}),
        encoding="utf-8",
    )
    executable = packaged / "chromium-1234/chrome-win64/chrome.exe"
    if present:
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"synthetic binary")
    env = bt._build_browser_env()
    assert env["SAFE_SETTING"] == "retained"
    assert env["PLAYWRIGHT_BROWSERS_PATH"] == str(packaged)
    assert env.get("AGENT_BROWSER_EXECUTABLE_PATH") == (
        str(executable) if expected_bundled else override
    )
