"""Real disposable children exercise the host's native worker exit contract."""

from __future__ import annotations

import concurrent.futures
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from youtab_agent_cli import kanban_db as kb


@pytest.fixture
def workers(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(home))
    monkeypatch.setenv("YOUTAB_AGENT_KANBAN_HOME", str(home))
    monkeypatch.setenv("YOUTAB_AGENT_KANBAN_CRASH_GRACE_SECONDS", "0")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(kb, "_owned_windows_workers", {})
    monkeypatch.setattr(kb, "_recent_worker_exits", {})
    children = []
    gates = []
    parent_logs = []
    real_popen = subprocess.Popen

    def capture(*args, **kwargs):
        child = real_popen(*args, **kwargs)
        children.append(child)
        if hasattr(kwargs["stdout"], "closed"):
            parent_logs.append(kwargs["stdout"])
        return child

    monkeypatch.setattr(subprocess, "Popen", capture)

    def launch(conn, *, code=75, board=None, hold=False, tid=None):
        tid = tid or kb.create_task(conn, title="synthetic worker", assignee="coder")
        host = kb._claimer_id().split(":", 1)[0]
        assert kb.claim_task(conn, tid, claimer=f"{host}:synthetic") is not None
        gate = tmp_path / f"gate-{len(gates)}"
        gates.append(gate)
        if not hold:
            gate.touch()
        script = (
            "import pathlib,sys,time\n"
            f"gate=pathlib.Path({str(gate)!r})\n"
            "deadline=time.monotonic()+30\n"
            "while not gate.exists() and time.monotonic()<deadline: time.sleep(0.01)\n"
            f"sys.exit({code})\n"
        )
        monkeypatch.setattr(kb, "_resolve_youtab_argv", lambda: [sys.executable, "-c", script])
        pid = kb._default_spawn(kb.get_task(conn, tid), str(tmp_path), board=board)
        kb._set_worker_pid(conn, tid, pid)
        return tid, children[-1], gate

    yield launch, parent_logs
    for gate in gates:
        gate.touch()
    for child in children:
        child.wait(timeout=10)
    kb.reap_worker_zombies()
    assert not kb._owned_windows_workers
    assert all(log.closed for log in parent_logs)


def observe(child, code):
    if os.name == "nt":
        assert child.wait(timeout=10) == code
    deadline = time.monotonic() + 10
    while child.pid not in kb._recent_worker_exits:
        kb.reap_worker_zombies()
        assert time.monotonic() < deadline, "child completion was not observed"
        time.sleep(0.01)
    assert not kb._pid_alive(child.pid)
    assert child.pid not in kb._owned_windows_workers
    if os.name == "nt":
        assert child._handle.closed


def test_actual_rate_limit_children_never_consume_failure_budget(workers):
    launch, _ = workers
    with kb.connect_closing() as conn:
        tid = None
        for _ in range(6):
            tid, child, _ = launch(conn, tid=tid)
            observe(child, 75)
            assert kb._classify_worker_exit(child.pid) == ("rate_limited", 75)
            assert kb.detect_crashed_workers(conn) == []
            assert tid in kb.detect_crashed_workers._last_rate_limited
            task = kb.get_task(conn, tid)
            assert task.status == "ready"
            assert task.consecutive_failures == 0
            assert "rate-limited" in task.last_failure_error
        outcomes = [row[0] for row in conn.execute(
            "SELECT outcome FROM task_runs WHERE task_id=?", (tid,),
        )]
        assert outcomes == ["rate_limited"] * 6


@pytest.mark.parametrize("code,kind", [(0, "clean_exit"), (7, "nonzero_exit")])
def test_actual_other_exits_keep_crash_accounting(workers, code, kind):
    launch, _ = workers
    with kb.connect_closing() as conn:
        tid, child, _ = launch(conn, code=code)
        observe(child, code)
        assert kb._classify_worker_exit(child.pid) == (kind, code)
        assert kb.detect_crashed_workers(conn) == [tid]
        task = kb.get_task(conn, tid)
        assert task.status == "ready"
        assert task.consecutive_failures == (0 if code == 0 else 1)
        assert ("protocol violation" if code == 0 else f"pid {child.pid}") in task.last_failure_error
        run = conn.execute("SELECT outcome, metadata FROM task_runs WHERE task_id=?", (tid,)).fetchone()
        assert run["outcome"] == "crashed"


def test_live_child_is_observed_before_external_pid_probe(workers, monkeypatch):
    launch, _ = workers
    with kb.connect_closing() as conn:
        tid, child, gate = launch(conn, hold=True)
        # No arbitrary process lookup is needed for an owned Windows child.
        if os.name == "nt":
            monkeypatch.setattr("gateway.status._pid_exists", lambda pid: pytest.fail("external PID lookup"))
        assert kb._pid_alive(child.pid)
        assert kb.reap_worker_zombies() == []
        assert kb.detect_crashed_workers(conn) == []
        assert kb.get_task(conn, tid).status == "running"
        gate.touch()
        if os.name == "nt":
            assert child.wait(timeout=10) == 75
            # Direct crash detection must poll before cleanup, without a reap tick.
            assert kb.detect_crashed_workers(conn) == []
            assert kb.get_task(conn, tid).status == "ready"
            assert child.pid not in kb._owned_windows_workers
        else:
            observe(child, 75)
            assert kb.detect_crashed_workers(conn) == []


def test_two_boards_share_observation_without_consuming_other_exit(workers):
    launch, _ = workers
    with kb.connect_closing(board="alpha") as alpha, kb.connect_closing(board="beta") as beta:
        aid, achild, _ = launch(alpha, board="alpha")
        bid, bchild, _ = launch(beta, board="beta")
        if os.name == "nt":
            assert achild.wait(timeout=10) == bchild.wait(timeout=10) == 75
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: kb.reap_worker_zombies(), range(2)))
        observe(achild, 75)
        observe(bchild, 75)
        assert kb.detect_crashed_workers(alpha) == []
        assert kb.get_task(beta, bid).status == "running"
        assert kb._classify_worker_exit(bchild.pid) == ("rate_limited", 75)
        assert kb.detect_crashed_workers(beta) == []
        assert kb.get_task(alpha, aid).consecutive_failures == 0
        assert kb.get_task(beta, bid).consecutive_failures == 0


def test_capacity_does_not_abandon_a_live_child(workers, monkeypatch):
    launch, logs = workers
    monkeypatch.setattr(kb, "_OWNED_WINDOWS_WORKERS_MAX", 1)
    with kb.connect_closing() as conn:
        _, child, gate = launch(conn, hold=True)
        if os.name == "nt":
            assert list(kb._owned_windows_workers) == [child.pid]
            existing_logs = set(kb.worker_logs_dir().glob("*.log"))
            with pytest.raises(RuntimeError, match="observation capacity exhausted"):
                launch(conn)
            assert len(logs) == 1  # Rejection happened before Popen: no orphan.
            rejected_logs = set(kb.worker_logs_dir().glob("*.log")) - existing_logs
            assert len(rejected_logs) == 1
            rejected_logs.pop().unlink()  # The rejection closed the parent's log.
            assert list(kb._owned_windows_workers) == [child.pid]
            assert kb._pid_alive(child.pid)
        gate.touch()
        observe(child, 75)
        _, next_child, _ = launch(conn)
        observe(next_child, 75)


def test_unobserved_pid_classification_stays_unknown(workers):
    # No probe, process open, signal or fabricated Windows/POSIX wait helper.
    assert kb._classify_worker_exit(987654321) == ("unknown", None)


def test_unobserved_disposable_child_keeps_conservative_crash_accounting(workers):
    child = subprocess.Popen(
        [sys.executable, "-c", "import sys; sys.exit(75)"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    assert child.wait(timeout=10) == 75
    assert kb._classify_worker_exit(child.pid) == ("unknown", None)
    with kb.connect_closing() as conn:
        tid = kb.create_task(conn, title="unobserved synthetic child", assignee="coder")
        host = kb._claimer_id().split(":", 1)[0]
        assert kb.claim_task(conn, tid, claimer=f"{host}:synthetic") is not None
        kb._set_worker_pid(conn, tid, child.pid)
        assert kb.detect_crashed_workers(conn) == [tid]
        assert kb.get_task(conn, tid).consecutive_failures == 1


def test_spawn_failure_closes_parent_log(workers, monkeypatch):
    launch, _ = workers
    with kb.connect_closing() as conn:
        monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: (_ for _ in ()).throw(FileNotFoundError()))
        with pytest.raises(RuntimeError, match="executable not found"):
            launch(conn)
        assert not kb._owned_windows_workers
        # Opening for exclusive cleanup succeeds after the failed spawn.
        for log in kb.worker_logs_dir().glob("*.log"):
            log.unlink()
