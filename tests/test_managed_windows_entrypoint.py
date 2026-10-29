"""Behavior tests for customer and legacy Windows Runtime launches."""

import contextlib
import hashlib
import io
import json
import tempfile
import types
import unittest
import sys
import subprocess
from pathlib import Path
from unittest.mock import patch

from youtab_agent_cli.managed_windows_entrypoint import (
    ManagedRuntimeRepairRequired,
    windows_runtime_command,
)
from youtab_agent_cli import gateway_windows


class ManagedWindowsEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="youtab-managed-entrypoint-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "customer root"
        self.scripts = self.root / "venv" / "Scripts"
        self.scripts.mkdir(parents=True)
        self.python = self.scripts / "python.exe"
        self.python.write_bytes(b"python fixture")
        self.cli = self.scripts / "youtab.exe"
        self.args = ["--profile", "team", "gateway", "run"]
        self.probe_patch = patch(
            "youtab_agent_cli.managed_windows_entrypoint.subprocess.run",
            return_value=subprocess.CompletedProcess(
                [str(self.cli), "--version"], 0, "Youtab Agent Runtime v0.19.1\n", ""
            ),
        )
        self.probe = self.probe_patch.start()
        self.addCleanup(self.probe_patch.stop)

    def managed_artifact(self):
        source_sha = "a" * 40
        contract = {
            "schemaVersion": 1,
            "sourceSha": source_sha,
            "version": "0.19.2",
            "entrypoint": "venv/Scripts/youtab.exe",
            "capabilities": ["serve"],
        }
        content = json.dumps(contract).encode("utf-8")
        (self.root / "runtime-desktop.json").write_bytes(content)
        marker = {
            "schemaVersion": 1,
            "pinnedCommit": source_sha,
            "version": "0.19.2",
            "artifactSha256": "b" * 64,
            "runtimeContractSha256": hashlib.sha256(content).hexdigest(),
        }
        (self.root / ".youtab-agent-runtime-bootstrap-complete").write_text(
            json.dumps(marker), encoding="utf-8"
        )
        self.cli.write_bytes(b"cli fixture")

    def test_unmanaged_source_retains_module_launch(self):
        self.assertEqual(
            windows_runtime_command(str(self.python), self.args),
            [str(self.python), "-m", "youtab_agent_cli.main", *self.args],
        )

    def test_managed_launch_uses_same_root_cli_and_arguments(self):
        self.managed_artifact()
        self.assertEqual(windows_runtime_command(str(self.python), self.args), [str(self.cli), *self.args])
        self.probe.assert_called_once()
        self.assertEqual(self.probe.call_args.args[0], [str(self.cli), "--version"])

    def test_non_youtab_binary_is_rejected_even_when_receipt_is_valid(self):
        self.managed_artifact()
        self.probe.return_value = subprocess.CompletedProcess([str(self.cli), "--version"], 0, "Other tool\n", "")
        with self.assertRaises(ManagedRuntimeRepairRequired):
            windows_runtime_command(str(self.python), self.args)

    def test_missing_managed_cli_never_falls_back_to_source(self):
        self.managed_artifact()
        self.cli.unlink()
        with self.assertRaises(ManagedRuntimeRepairRequired):
            windows_runtime_command(str(self.python), self.args)

    def test_corrupt_managed_receipt_never_falls_back_to_source(self):
        self.managed_artifact()
        marker_path = self.root / ".youtab-agent-runtime-bootstrap-complete"
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["runtimeContractSha256"] = "0" * 64
        marker_path.write_text(json.dumps(marker), encoding="utf-8")
        with self.assertRaises(ManagedRuntimeRepairRequired):
            windows_runtime_command(str(self.python), self.args)

    def test_missing_managed_contract_never_falls_back_to_source(self):
        self.managed_artifact()
        (self.root / "runtime-desktop.json").unlink()
        with self.assertRaises(ManagedRuntimeRepairRequired):
            windows_runtime_command(str(self.python), self.args)

    def test_old_source_receipt_without_managed_evidence_remains_legacy(self):
        (self.root / ".youtab-agent-runtime-bootstrap-complete").write_text(
            json.dumps({"schemaVersion": 1, "pinnedCommit": "a" * 40}), encoding="utf-8"
        )
        self.assertEqual(
            windows_runtime_command(str(self.python), self.args),
            [str(self.python), "-m", "youtab_agent_cli.main", *self.args],
        )

    def test_windows_service_wrappers_use_managed_cli_with_stable_cwd(self):
        self.managed_artifact()
        home = self.root / "state"
        home.mkdir()
        with patch.object(gateway_windows, "_resolve_detached_python", return_value=(str(self.python), self.root / "venv", [])):
            cmd = gateway_windows._build_gateway_cmd_script(str(self.python), str(home), str(home), "--profile team")
            vbs = gateway_windows._build_gateway_vbs_script(str(self.python), str(home), str(home), "--profile team")
        self.assertIn(str(self.cli), cmd)
        self.assertIn(str(self.cli), vbs)
        self.assertNotIn("-m youtab_agent_cli.main", cmd)
        self.assertNotIn("-m youtab_agent_cli.main", vbs)
        self.assertIn("gateway run", cmd)
        self.assertIn(str(home), cmd)
        self.assertIn(str(home), vbs)

    def test_windows_service_wrapper_refuses_corrupt_managed_cli(self):
        self.managed_artifact()
        self.cli.unlink()
        with patch.object(gateway_windows, "_resolve_detached_python", return_value=(str(self.python), self.root / "venv", [])):
            with self.assertRaises(ManagedRuntimeRepairRequired):
                gateway_windows._build_gateway_cmd_script(str(self.python), str(self.root), str(self.root), "")

    def test_elevated_handoff_reports_managed_cli_repair(self):
        self.managed_artifact()
        self.cli.unlink()
        output = io.StringIO()
        with patch.object(gateway_windows, "_assert_windows"), patch.object(
            gateway_windows, "_current_profile_cli_args", return_value=[]
        ), patch.object(gateway_windows.sys, "executable", str(self.python)), contextlib.redirect_stdout(output):
            self.assertFalse(gateway_windows._launch_elevated_gateway_command("install"))
        self.assertIn("repair with Youtab Setup", output.getvalue())

    def test_direct_detached_gateway_uses_managed_cli(self):
        self.managed_artifact()
        home = self.root / "state"
        home.mkdir()
        gateway = types.ModuleType("youtab_agent_cli.gateway")
        gateway.PROJECT_ROOT = self.root
        gateway.get_python_path = lambda: str(self.python)
        gateway._profile_arg = lambda _home: "--profile team"
        config = types.ModuleType("youtab_agent_cli.config")
        config.get_youtab_home = lambda: home
        with patch.dict(sys.modules, {"youtab_agent_cli.gateway": gateway, "youtab_agent_cli.config": config}):
            with patch.object(gateway_windows, "_assert_windows"), patch.object(
                gateway_windows, "_resolve_detached_python", return_value=(str(self.python), self.root / "venv", [])
            ):
                argv, cwd, env = gateway_windows._build_gateway_argv()
        self.assertEqual(argv, [str(self.cli), "--profile", "team", "gateway", "run"])
        self.assertEqual(cwd, str(home))
        self.assertEqual(env["VIRTUAL_ENV"], str(self.root / "venv"))


if __name__ == "__main__":
    unittest.main()
