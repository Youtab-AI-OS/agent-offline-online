"""Windows gateway restart must stop when the managed Runtime needs repair."""

import hashlib
import json

import pytest


@pytest.mark.parametrize("damage", ["missing-cli", "corrupt-receipt"])
def test_windows_gateway_restart_does_not_spawn_from_damaged_managed_runtime(
    tmp_path, monkeypatch, capsys, damage
):
    import youtab_agent_cli.gateway as gateway_cli
    import youtab_agent_cli.gateway_windows as gateway_windows

    root = tmp_path / "customer root"
    scripts = root / "venv" / "Scripts"
    scripts.mkdir(parents=True)
    python = scripts / "python.exe"
    python.write_bytes(b"python fixture")
    contract = {
        "schemaVersion": 1,
        "sourceSha": "a" * 40,
        "version": "0.19.2",
        "entrypoint": "venv/Scripts/youtab.exe",
        "capabilities": ["serve"],
    }
    content = json.dumps(contract).encode("utf-8")
    (root / "runtime-desktop.json").write_bytes(content)
    (root / ".youtab-agent-runtime-bootstrap-complete").write_text(
        json.dumps({
            "schemaVersion": 1,
            "pinnedCommit": "a" * 40,
            "version": "0.19.2",
            "artifactSha256": "b" * 64,
            "runtimeContractSha256": "0" * 64 if damage == "corrupt-receipt" else hashlib.sha256(content).hexdigest(),
        }),
        encoding="utf-8",
    )
    if damage == "corrupt-receipt":
        (scripts / "youtab.exe").write_bytes(b"cli fixture")

    monkeypatch.setattr(gateway_cli.sys, "platform", "win32")
    monkeypatch.setattr(gateway_windows, "_resolve_detached_python", lambda _: (str(python), root / "venv", []))
    monkeypatch.setattr(gateway_cli.subprocess, "Popen", lambda *_a, **_k: pytest.fail("watcher must not spawn"))
    assert not gateway_cli._spawn_gateway_restart_watcher(
        123, [str(python), "-m", "youtab_agent_cli.main", "gateway", "run"]
    )
    assert "Gateway restart blocked" in capsys.readouterr().out
