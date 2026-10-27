"""Ownership and actual stop-boundary regressions, with no operator signals."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import psutil
import pytest


@pytest.fixture
def module(tmp_path, monkeypatch):
    path = Path(__file__).parents[2] / 'youtab_agent_cli' / 'dashboard_procs.py'
    spec = importlib.util.spec_from_file_location('dashboard_ownership_draft', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    root = tmp_path / 'installation'
    (root / 'youtab_agent_cli').mkdir(parents=True)
    (root / 'youtab_agent_cli' / 'main.py').touch()
    (root / '.venv' / 'Scripts').mkdir(parents=True)
    for name in ('python.exe', 'youtab.exe'):
        (root / '.venv' / 'Scripts' / name).touch()
    monkeypatch.setattr(mod, '__file__', str(root / 'youtab_agent_cli' / 'dashboard_procs.py'))
    monkeypatch.setattr(mod, '_m', lambda: SimpleNamespace())
    monkeypatch.delenv('YOUTAB_AGENT_DESKTOP_CHILD_PID', raising=False)
    return mod, root


def process(root, argv=None, executable=None):
    exe = executable or str(root / '.venv' / 'Scripts' / 'python.exe')
    proc = Mock()
    proc.pid = 999999
    proc.exe.return_value = exe
    proc.cmdline.return_value = argv or [exe, '-m', 'youtab_agent_cli.main', 'dashboard']
    proc.cwd.return_value = str(root)
    proc.create_time.return_value = 100.0
    proc.environ.return_value = {}
    proc.is_running.return_value = True
    proc.username.return_value = psutil.Process().username()
    return proc


@pytest.mark.parametrize('role', ['dashboard', 'serve'])
@pytest.mark.parametrize('launch', ['module', 'script', 'shim', 'shim_child'])
def test_owned_roles(module, role, launch):
    mod, root = module
    proc = process(root)
    exe = proc.exe()
    if launch == 'module':
        proc.cmdline.return_value = [exe, '-u', '-m', 'youtab_agent_cli.main', role, '--port', '9120']
    elif launch == 'shim_child':
        proc.cmdline.return_value = [exe, str(root / '.venv' / 'Scripts' / 'youtab.exe'), role]
    elif launch == 'script':
        proc.cmdline.return_value = [exe, str(root / 'youtab_agent_cli' / 'main.py'), role]
    else:
        exe = str(root / '.venv' / 'Scripts' / 'youtab.exe')
        proc.exe.return_value = exe
        proc.cmdline.return_value = [exe, role]
    assert mod._dashboard_identity(proc) is not None


@pytest.mark.parametrize('case', ['shell', 'comment', 'other_install', 'shared_python', 'pythonpath', 'pythonhome', 'other_cwd'])
def test_unknown_authority_is_not_stopped(module, monkeypatch, tmp_path, case):
    mod, root = module
    proc = process(root)
    if case in ('shell', 'shared_python', 'other_install'):
        exe = tmp_path / ('powershell.exe' if case == 'shell' else 'python.exe')
        exe.touch()
        proc.exe.return_value = str(exe)
    if case == 'shell':
        proc.cmdline.return_value = ['powershell.exe', '-Command', "Write-Output 'youtab dashboard'"]
    elif case == 'comment':
        proc.cmdline.return_value = [proc.exe(), '-c', "print('youtab_agent_cli.main serve')"]
    elif case in ('pythonpath', 'pythonhome'):
        proc.environ.return_value = {case.upper(): str(tmp_path)}
    elif case == 'other_cwd':
        proc.cwd.return_value = str(tmp_path)
    monkeypatch.setattr(psutil, 'process_iter', lambda: [proc])
    assert mod._scan_windows_dashboard_processes(['youtab dashboard']) == []
    assert mod._kill_stale_dashboard_processes()['matched'] == []
    proc.terminate.assert_not_called()
    proc.kill.assert_not_called()
    if case not in ("pythonpath", "pythonhome"):
        proc.environ.assert_not_called()


@pytest.mark.parametrize('changed', ['creation', 'argv', 'exe'])
@pytest.mark.parametrize('stage', ['terminate', 'force'])
def test_revalidate_before_each_effect(module, monkeypatch, tmp_path, changed, stage):
    mod, root = module
    proc = process(root)
    monkeypatch.setattr(psutil, 'process_iter', lambda: [proc])
    monkeypatch.setattr(psutil, 'wait_procs', lambda processes, timeout: ([], processes))
    before, after = 100.0, 101.0
    target = proc.create_time
    if changed == 'argv':
        target = proc.cmdline
        before, after = proc.cmdline(), [proc.exe(), '-c', "print('youtab dashboard')"]
    elif changed == 'exe':
        target = proc.exe
        other = tmp_path / 'other-python.exe'
        other.touch()
        before, after = proc.exe(), str(other)
    target.side_effect = ([before, after] if stage == 'terminate' else [before, before, after])
    result = mod._kill_stale_dashboard_processes()
    assert result['killed'] == []
    assert result['failed'][0][0] == proc.pid
    assert proc.terminate.call_count == (0 if stage == 'terminate' else 1)
    proc.kill.assert_not_called()


def test_owned_termination_and_desktop_exclusion(module, monkeypatch):
    mod, root = module
    proc = process(root)
    monkeypatch.setattr(psutil, 'process_iter', lambda: [proc])
    monkeypatch.setattr(psutil, 'wait_procs', lambda processes, timeout: (processes, []))
    monkeypatch.setenv('YOUTAB_AGENT_DESKTOP_CHILD_PID', str(proc.pid))
    assert mod._kill_stale_dashboard_processes()['matched'] == []
    proc.terminate.assert_not_called()
    monkeypatch.delenv('YOUTAB_AGENT_DESKTOP_CHILD_PID')
    assert mod._kill_stale_dashboard_processes()['killed'] == [proc.pid]
    proc.terminate.assert_called_once()
    proc.kill.assert_not_called()


def test_pid_reuse_detected_by_process_handle(module, monkeypatch):
    mod, root = module
    proc = process(root)
    proc.is_running.side_effect = [True, False]
    monkeypatch.setattr(psutil, 'process_iter', lambda: [proc])
    monkeypatch.setattr(psutil, 'wait_procs', lambda processes, timeout: ([], []))
    assert mod._kill_stale_dashboard_processes()['killed'] == []
    proc.terminate.assert_not_called()


def test_foreign_user_is_not_owned(module):
    mod, root = module
    proc = process(root)
    proc.username.return_value = 'different-user'
    assert mod._dashboard_identity(proc) is None


def test_owned_survivor_forced_stop_waits_for_exit(module, monkeypatch):
    mod, root = module
    proc = process(root)
    monkeypatch.setattr(psutil, 'process_iter', lambda: [proc])
    monkeypatch.setattr(psutil, 'wait_procs', lambda processes, timeout: ([], processes))
    assert mod._kill_stale_dashboard_processes()['killed'] == [proc.pid]
    proc.terminate.assert_called_once()
    proc.kill.assert_called_once()
    proc.wait.assert_called_once_with(timeout=3)


@pytest.mark.parametrize("launch", ["module", "shim_child"])
def test_actual_owned_child_is_stopped_without_signalling_shell(module, monkeypatch, tmp_path, launch):
    import os
    import subprocess
    import sys
    import time

    mod, _mock_root = module
    root = tmp_path / "real-installation"
    (root / "youtab_agent_cli").mkdir(parents=True)
    (root / "youtab_agent_cli" / "main.py").write_text("import time; time.sleep(60)")
    venv = root / ".venv"
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    environment.pop("PYTHONHOME", None)
    result = subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(venv)], capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    child_python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    monkeypatch.setattr(mod, "__file__", str(root / "youtab_agent_cli" / "dashboard_procs.py"))
    argv = [str(child_python), "-m", "youtab_agent_cli.main", "serve"]
    if launch == "shim_child":
        # Execute a synthetic console-script operand with the actual owned
        # interpreter; no mutation of the shared real venv/launcher occurs.
        shim = root / "venv" / "bin" / "youtab"
        shim.parent.mkdir(parents=True)
        shim.write_text("import time; time.sleep(60)")
        argv = [str(child_python), str(shim), "serve"]
    child = subprocess.Popen(argv, cwd=root, env=environment)
    handle = psutil.Process(child.pid)
    creation = handle.create_time()
    try:
        time.sleep(0.2)
        assert child.poll() is None
        assert mod._dashboard_identity(handle) is not None
        result = mod._kill_stale_dashboard_processes()
        assert result["matched"] == [child.pid]
        assert result["killed"] == [child.pid]
        assert child.wait(timeout=5) is not None
    finally:
        if child.poll() is None and handle.is_running() and handle.create_time() == creation:
            handle.kill()
            child.wait(timeout=5)


def test_exact_current_root_pythonpath_is_owned(module):
    mod, root = module
    proc = process(root)
    proc.environ.return_value = {"PYTHONPATH": str(root)}
    assert mod._dashboard_identity(proc) is not None


@pytest.mark.parametrize("launch", ["shim", "shim_child"])
def test_shared_venv_shim_from_other_installation_is_not_owned(module, tmp_path, launch):
    import os
    import subprocess

    mod, root = module
    foreign = tmp_path / "foreign-venv"
    (foreign / "Scripts").mkdir(parents=True)
    shim = foreign / "Scripts" / "youtab.exe"
    shim.touch()
    shared = root / "venv"
    if os.name == "nt":
        environment = os.environ.copy()
        environment["YOUTAB_TEST_VENV_LINK"] = str(shared)
        environment["YOUTAB_TEST_VENV_TARGET"] = str(foreign)
        result = subprocess.run([
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:YOUTAB_TEST_VENV_LINK -Target $env:YOUTAB_TEST_VENV_TARGET | Out-Null",
        ], env=environment, capture_output=True, timeout=20)
        assert result.returncode == 0, result.stderr
    else:
        shared.symlink_to(foreign, target_is_directory=True)
    proc = process(root)
    if launch == "shim":
        proc.exe.return_value = str(shim)
        proc.cmdline.return_value = [str(shim), "dashboard"]
    else:
        proc.cmdline.return_value = [proc.exe(), str(shim), "serve"]
    proc.cwd.return_value = str(tmp_path)
    assert mod._dashboard_identity(proc) is None
    proc.environ.assert_not_called()


def test_global_interpreter_argv_cannot_borrow_venv_file_symlink(module):
    mod, root = module
    proc = process(root)
    proc.cmdline.return_value = ["/usr/bin/python3", "-m", "youtab_agent_cli.main", "serve"]
    assert mod._dashboard_identity(proc) is None
    proc.environ.assert_not_called()
