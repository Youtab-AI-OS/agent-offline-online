import pytest


def test_tui_finds_bundled_entry_js(tmp_path):
    """_find_bundled_tui finds entry.js bundled in the package."""
    tui_dist = tmp_path / "youtab_agent_cli" / "tui_dist"
    tui_dist.mkdir(parents=True)
    entry = tui_dist / "entry.js"
    entry.write_text("// bundled TUI", encoding="utf-8")

    from youtab_agent_cli.main import _find_bundled_tui
    result = _find_bundled_tui(youtab_agent_cli_dir=tmp_path / "youtab_agent_cli")
    assert result is not None
    assert result.name == "entry.js"


def test_customer_tui_uses_packaged_node_and_entry_without_npm(tmp_path, monkeypatch):
    import youtab_agent_cli.main as main_mod

    runtime = tmp_path / "youtab-agent-runtime"
    marker = runtime / "customer-image" / "windows-x64" / "manifest.json"
    marker.parent.mkdir(parents=True)
    marker.write_text('{"components":["browser","desktop","node","tui"]}')
    node = runtime / "node" / "node.exe"
    node.parent.mkdir()
    node.write_bytes(b"synthetic Node")
    entry = runtime / "ui-tui" / "dist" / "entry.js"
    entry.parent.mkdir(parents=True)
    entry.write_text("console.log('Youtab')")
    monkeypatch.setattr(main_mod, "get_youtab_home", lambda: tmp_path)
    monkeypatch.delenv("YOUTAB_AGENT_TUI_DIR", raising=False)
    monkeypatch.setattr(main_mod.shutil, "which", lambda _name: None)
    monkeypatch.setattr(main_mod.subprocess, "run", lambda *_args, **_kwargs:
                        (_ for _ in ()).throw(AssertionError("customer TUI must not spawn npm or Git")))

    argv, cwd = main_mod._make_tui_argv(tmp_path / "missing-workspace", tui_dev=False)

    assert argv == [str(node), "--expose-gc", str(entry)]
    assert cwd == entry.parent


@pytest.mark.parametrize("missing", ["node", "entry"])
def test_customer_tui_missing_member_never_bootstraps(tmp_path, monkeypatch, missing):
    import youtab_agent_cli.main as main_mod

    runtime = tmp_path / "youtab-agent-runtime"
    marker = runtime / "customer-image" / "windows-x64" / "manifest.json"
    marker.parent.mkdir(parents=True)
    marker.write_text("{}")
    node = runtime / "node" / "node.exe"
    node.parent.mkdir()
    node.write_bytes(b"node")
    entry = runtime / "ui-tui" / "dist" / "entry.js"
    entry.parent.mkdir(parents=True)
    entry.write_text("console.log('Youtab')")
    (node if missing == "node" else entry).unlink()
    monkeypatch.setattr(main_mod, "get_youtab_home", lambda: tmp_path)
    monkeypatch.setattr(main_mod.subprocess, "run", lambda *_args, **_kwargs:
                        (_ for _ in ()).throw(AssertionError("must not bootstrap")))

    with pytest.raises(FileNotFoundError, match="customer TUI image is incomplete"):
        main_mod._make_tui_argv(tmp_path / "missing-workspace", tui_dev=False)

