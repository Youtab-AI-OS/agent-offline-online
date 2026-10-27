"""Remote file guards must interpret paths on the backend, before dispatch."""
import json
from unittest.mock import MagicMock, Mock

import pytest

import tools.file_tools as ft


@pytest.mark.parametrize("backend", ["ssh", "docker"])
@pytest.mark.parametrize("operation", ["write", "update", "move"])
@pytest.mark.parametrize("target", ["/etc/crontab", "crontab"])
def test_remote_system_path_is_denied_before_dispatch(monkeypatch, backend, operation, target):
    monkeypatch.setattr(ft, "_terminal_env_type_for_task", lambda task_id: backend)
    monkeypatch.setattr(ft, "_authoritative_workspace_root", lambda task_id: "/etc")
    dispatch = Mock(side_effect=RuntimeError("UNEXPECTED_REMOTE_DISPATCH"))
    monkeypatch.setattr(ft, "_get_file_ops", dispatch)
    if operation == "write":
        result = json.loads(ft.write_file_tool(target, "synthetic data\n"))
    else:
        header = f"***Update File: {target}" if operation == "update" else f"*** Move File: /workspace/source.txt -> {target}"
        result = json.loads(ft.patch_tool(mode="patch", patch=f"*** Begin Patch\n{header}\n*** End Patch\n"))
    assert "sensitive system path" in result["error"]
    dispatch.assert_not_called()


@pytest.mark.parametrize("backend", ["ssh", "docker", "local"])
def test_safe_native_or_remote_path_reaches_dispatch(monkeypatch, tmp_path, backend):
    monkeypatch.setattr(ft, "_terminal_env_type_for_task", lambda task_id: backend)
    monkeypatch.setattr(ft, "_authoritative_workspace_root", lambda task_id: "/workspace" if backend != "local" else str(tmp_path))
    target = "src/report.txt" if backend != "local" else str(tmp_path / "report.txt")
    dispatch = Mock(side_effect=RuntimeError("SAFE_DISPATCH_BOUNDARY"))
    monkeypatch.setattr(ft, "_get_file_ops", dispatch)
    result = json.loads(ft.write_file_tool(target, "synthetic data\n"))
    assert result["error"] == "SAFE_DISPATCH_BOUNDARY"
    dispatch.assert_called_once()


@pytest.mark.parametrize("backend", ["ssh", "docker"])
def test_safe_remote_write_keeps_posix_operand(monkeypatch, backend):
    monkeypatch.setattr(ft, "_terminal_env_type_for_task", lambda task_id: backend)
    monkeypatch.setattr(ft, "_authoritative_workspace_root", lambda task_id: "/workspace")
    operations = MagicMock()
    operations.write_file.return_value.to_dict.return_value = {"status": "ok", "path": "/workspace/src/report.txt", "bytes": 5}
    monkeypatch.setattr(ft, "_get_file_ops", lambda task_id: operations)
    result = json.loads(ft.write_file_tool("src/report.txt", "data\n"))
    assert result["status"] == "ok"
    assert "_warning" not in result
    operations.write_file.assert_called_once_with("/workspace/src/report.txt", "data\n")


@pytest.mark.parametrize("backend", ["ssh", "docker"])
@pytest.mark.parametrize("target", ["/workspace/src/report.txt", "/workspace/src/literal\\name.txt"])
def test_remote_warning_uses_backend_path_semantics(monkeypatch, backend, target):
    monkeypatch.setattr(ft, "_terminal_env_type_for_task", lambda task_id: backend)
    monkeypatch.setattr(ft, "_authoritative_workspace_root", lambda task_id: "/workspace")
    assert ft._path_resolution_warning("src/report.txt", target) is None
    warning = ft._path_resolution_warning("../other/report.txt", "/other/report.txt")
    assert "OUTSIDE the active workspace" in warning
    assert "/other/report.txt" in warning
    assert ft._path_resolution_warning("/other/report.txt", "/other/report.txt") is None


@pytest.mark.parametrize("backend", ["ssh", "docker"])
@pytest.mark.parametrize("target", ["/etc\\archive/report.txt", "/var\\run/docker.sock"])
def test_safe_remote_literal_backslash_name_is_not_a_system_path(monkeypatch, backend, target):
    monkeypatch.setattr(ft, "_terminal_env_type_for_task", lambda task_id: backend)
    monkeypatch.setattr(ft, "_authoritative_workspace_root", lambda task_id: "/workspace")
    operations = MagicMock()
    operations.write_file.return_value.to_dict.return_value = {"status": "ok", "path": target}
    monkeypatch.setattr(ft, "_get_file_ops", lambda task_id: operations)
    result = json.loads(ft.write_file_tool(target, "data\n"))
    assert result["status"] == "ok"
    operations.write_file.assert_called_once_with(target, "data\n")
