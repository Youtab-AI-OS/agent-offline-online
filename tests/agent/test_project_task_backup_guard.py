from __future__ import annotations
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor

import pytest

from agent import project_task_backup as gate
from tools import project_task_backup as backup


@pytest.fixture
def context(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    (root / "original.txt").write_text("before")
    home = tmp_path / "synthetic-home"
    home.mkdir()
    monkeypatch.setattr(backup, "get_youtab_home", lambda: home)
    monkeypatch.setattr(gate, "_scope", lambda task: [{"path": str(root)}])
    monkeypatch.setattr("tools.file_tools._authoritative_workspace_root", lambda task: str(root))
    agent = SimpleNamespace(_project_backup_required=True, _current_turn_id="synthetic-turn")
    gate.begin_task(agent, "synthetic-task", "synthetic-turn")
    return agent, root, home


@pytest.mark.parametrize("tool", ["terminal", "execute_code", "write_file", "patch", "mcp_synthetic_write", "computer_use"])
def test_relevant_tools_get_real_ready_snapshot_without_command_heuristic(context, tool):
    agent, root, home = context
    assert gate.block_reason(agent, tool, "synthetic-task", {"command": "python arbitrary_script.py"}) is None
    receipt = agent._project_backup_state["receipt"]
    assert receipt["status"] == "READY"
    assert backup.verify(receipt, home=home)["roots"][0]["path"] == str(root)


def test_read_only_surface_and_plain_chat_need_no_backup(context, monkeypatch):
    agent, root, home = context
    monkeypatch.setattr(gate, "snapshot", lambda *a, **k: pytest.fail("read-only tool tried to create backup"))
    assert gate.block_reason(agent, "read_file", "task") is None
    assert agent._project_backup_state["receipt"] is None


def test_file_creation_without_required_backup_does_not_need_project(context, monkeypatch):
    agent, _, _ = context
    agent._project_backup_required = False
    monkeypatch.setattr(gate, "_scope", lambda task: pytest.fail("file creation required a project"))
    monkeypatch.setattr(gate, "snapshot", lambda *a, **k: pytest.fail("file creation forced a backup"))
    assert gate.block_reason(agent, "write_file", "task", {"path": "new.txt"}) is None
    assert agent._project_backup_state["receipt"] is None


def test_failure_is_pinned_and_never_treated_as_success(context, monkeypatch):
    agent, root, home = context
    calls = []
    def fail(*args, **kwargs):
        calls.append(1)
        raise OSError("synthetic storage failure")
    monkeypatch.setattr(gate, "snapshot", fail)
    for _ in range(2):
        assert "synthetic storage failure" in gate.block_reason(agent, "terminal", "task", {"force": True})
    assert len(calls) == 1
    assert agent._project_backup_state["receipt"] is None


def test_parallel_tools_share_one_verified_before_effect_snapshot(context, monkeypatch):
    agent, root, home = context
    real = gate.snapshot
    calls = []
    def capture(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)
    monkeypatch.setattr(gate, "snapshot", capture)
    with ThreadPoolExecutor(max_workers=3) as pool:
        reasons = list(pool.map(lambda _: gate.block_reason(agent, "terminal", "task"), range(3)))
    assert reasons == [None, None, None]
    assert len(calls) == 1


def test_no_workspace_fails_with_actionable_choose_project_message(context, monkeypatch):
    agent, root, home = context
    def no_root(task):
        raise backup.ProjectBackupError("Choose a project with + PROJECT")
    monkeypatch.setattr(gate, "_scope", no_root)
    assert "+ PROJECT" in gate.block_reason(agent, "terminal", "task")
    assert agent._project_backup_state["receipt"] is None


def test_backup_tampering_blocks_subsequent_dispatch(context):
    agent, root, home = context
    assert gate.block_reason(agent, "terminal", "task") is None
    receipt = agent._project_backup_state["receipt"]
    copied = __import__("pathlib").Path(receipt["directory"]) / "root-0" / "original.txt"
    copied.write_text("tampered")
    assert "verification" in gate.block_reason(agent, "terminal", "task")


def test_explicit_outside_terminal_workdir_is_not_silently_backed_as_current_project(context):
    agent, root, home = context
    assert "outside" in gate.block_reason(agent, "terminal", "task", {"workdir": str(root.parent)})


@pytest.mark.parametrize("name,args", [("clarify", {}), ("todo", {}), ("cronjob", {"action": "list"}), ("send_message", {}), ("vision_analyze", {}), ("text_to_speech", {}), ("browser_navigate", {"url": "https://example.invalid"}), ("browser_snapshot", {}), ("browser_vision", {}), ("computer_use", {"action": "capture"}), ("computer_use", {"action": "list_apps"})])
def test_owned_non_project_tools_keep_existing_governed_admission(context, monkeypatch, name, args):
    agent, root, home = context
    monkeypatch.setattr(gate, "snapshot", lambda *a, **k: pytest.fail("non-project surface forced a snapshot"))
    assert gate.block_reason(agent, name, "task", args) is None


def test_pinned_backup_cannot_be_reused_after_authoritative_project_switch(context, monkeypatch):
    agent, root, home = context
    assert gate.block_reason(agent, "terminal", "task") is None
    other = root.parent / "other"
    other.mkdir()
    monkeypatch.setattr("tools.file_tools._authoritative_workspace_root", lambda task: str(other))
    assert "workspace changed" in gate.block_reason(agent, "terminal", "task")


@pytest.mark.parametrize("header", ["*** Add File: {outside}\n+new", "*** Delete File: {outside}", "*** Move File: original.txt -> {outside}"])
def test_v4a_all_actual_parser_targets_must_be_inside_backed_project(context, monkeypatch, header):
    agent, root, home = context
    monkeypatch.setattr("tools.file_tools._resolve_path_for_task", lambda path, task: str(root / path) if not __import__("pathlib").Path(path).is_absolute() else path)
    patch = "*** Begin Patch\n" + header.format(outside=str(root.parent / "outside.txt")) + "\n*** End Patch"
    assert "outside" in gate.block_reason(agent, "patch", "task", {"mode": "patch", "patch": patch})
    assert not (root.parent / "outside.txt").exists()


def test_v4a_multiple_add_delete_move_inside_project_retains_functionality(context, monkeypatch):
    agent, root, home = context
    monkeypatch.setattr("tools.file_tools._resolve_path_for_task", lambda path, task: str(root / path))
    patch = "*** Begin Patch\n*** Add File: new.txt\n+new\n*** Move File: original.txt -> moved.txt\n*** Delete File: old.txt\n*** End Patch"
    assert gate.block_reason(agent, "patch", "task", {"mode": "patch", "patch": patch}) is None


@pytest.fixture
def dispatch(context, monkeypatch):
    from agent import tool_executor as executor
    from agent import relay_tools
    from youtab_agent_cli import middleware, plugins
    agent, root, home = context
    agent._tool_guardrails = SimpleNamespace(before_call=lambda *a: SimpleNamespace(allows_execution=True))
    monkeypatch.setattr(executor, "_begin_tool_execution", lambda *a, **k: None)
    monkeypatch.setattr(executor, "_emit_terminal_post_tool_call", lambda *a, **k: None)
    monkeypatch.setattr(relay_tools, "execute", lambda name, args, callback, **kw: (callback(args), args))
    monkeypatch.setattr(middleware, "apply_tool_request_middleware", lambda name, args, **kw: SimpleNamespace(payload=args, trace=[]))
    monkeypatch.setattr(middleware, "run_tool_execution_middleware", lambda name, args, callback, **kw: callback(args))
    monkeypatch.setattr(plugins, "resolve_pre_tool_block", lambda *a, **kw: None)
    monkeypatch.setattr("tools.file_tools._resolve_path_for_task", lambda path, task: str(root / path))
    def call(name, args, execute, begin=None):
        return executor._run_agent_tool_execution_middleware(agent, function_name=name, function_args=args,
            effective_task_id="synthetic-task", tool_call_id="synthetic-tool", execute=execute, begin_execution=begin)
    return call


def test_actual_shared_dispatch_refuses_before_effect_when_snapshot_fails(context, dispatch, monkeypatch):
    agent, root, home = context
    monkeypatch.setattr(gate, "snapshot", lambda *a, **k: (_ for _ in ()).throw(OSError("synthetic disk failure")))
    calls = []
    result = dispatch("write_file", {"path": "new.txt"}, lambda args: calls.append(args))
    assert result.blocked
    assert "synthetic disk failure" in result.result
    assert calls == []
    assert not (root / "new.txt").exists()


def test_actual_shared_dispatch_writes_only_after_verified_backup(context, dispatch):
    agent, root, home = context
    def effect(args):
        receipt = agent._project_backup_state["receipt"]
        backup.verify(receipt, home=home)
        (root / "original.txt").write_text("after")
        return "written"
    result = dispatch("write_file", {"path": "original.txt"}, effect)
    assert not result.blocked and result.result == "written"
    assert (root / "original.txt").read_text() == "after"
    manifest = backup.verify(agent._project_backup_state["receipt"], home=home)
    assert next(item for item in manifest["roots"][0]["entries"] if item["path"] == "original.txt")["sha256"] != backup._hash(root / "original.txt")


def test_reverse_concurrent_start_does_not_hold_file_lease_while_waiting_order(context, dispatch):
    import threading
    condition = threading.Condition()
    waiting = threading.Event()
    order = []
    failures = []
    def run(index):
        def begin(callback=None):
            if index == 1:
                waiting.set()
            with condition:
                if not condition.wait_for(lambda: len(order) == index, timeout=3):
                    raise AssertionError("ordered-start deadlock")
                if callback:
                    callback()
                order.append(index)
                condition.notify_all()
        try:
            outcome = dispatch("write_file", {"path": f"{index}.txt"}, lambda args: "ok", begin)
            assert not outcome.blocked
        except BaseException as error:
            failures.append(error)
    second = threading.Thread(target=run, args=(1,), daemon=True)
    first = threading.Thread(target=run, args=(0,), daemon=True)
    second.start()
    assert waiting.wait(3)
    first.start()
    first.join(5); second.join(5)
    assert not first.is_alive() and not second.is_alive()
    assert failures == []
    assert order == [0, 1]


def test_legacy_authoritative_workspace_without_project_row_still_gets_backup(context, monkeypatch):
    agent, root, home = context
    monkeypatch.undo()
    monkeypatch.setattr(backup, "get_youtab_home", lambda: home)
    monkeypatch.setattr("tools.file_tools._authoritative_workspace_root", lambda task: str(root))
    monkeypatch.setattr("youtab_agent_cli.projects_db.projects_db_path", lambda: home / "missing-projects.db")
    gate.begin_task(agent, "legacy-task", "new-turn")
    assert gate.block_reason(agent, "terminal", "legacy-task") is None
    assert backup.verify(agent._project_backup_state["receipt"], home=home)["roots"][0]["path"] == str(root)


def test_file_work_instructions_are_actual_nonduplicated_policy_not_comprehension_proof():
    prompt = gate.project_work_instructions("Existing provider/system rules")
    assert prompt.startswith("Existing provider/system rules")
    assert "complete current user request" in prompt
    assert "dependencies" in prompt and "retain chats/sessions" in prompt
    assert gate.project_work_instructions(prompt) == prompt


def test_native_tools_cannot_write_into_excluded_retained_backup_store(context, monkeypatch):
    agent, root, home = context
    monkeypatch.setattr("tools.file_tools._resolve_path_for_task", lambda path, task: str(root / path))
    assert gate.block_reason(agent, "terminal", "task") is None
    retained = __import__("pathlib").Path(agent._project_backup_state["receipt"]["retained_directory"])
    assert "protected project backup" in gate.block_reason(agent, "write_file", "task", {"path": str(retained / "manifest.json")})


def test_actual_delegate_constructor_pins_parent_scope_and_child_first_dispatch_gets_own_backup(context, dispatch, monkeypatch):
    from unittest.mock import MagicMock
    from tools import delegate_tool
    from agent import tool_executor
    import run_agent
    agent, root, home = context
    assert gate.block_reason(agent, "terminal", "task") is None
    parent = MagicMock()
    parent.base_url = "https://example.invalid/v1"
    parent.api_key = "synthetic-not-a-key"
    parent.provider = "openrouter"
    parent.api_mode = "chat_completions"
    parent.model = "synthetic-model"
    parent.platform = "cli"
    parent.providers_allowed = parent.providers_ignored = parent.providers_order = parent.provider_sort = None
    parent._session_db = None
    parent._delegate_depth = 0
    parent._active_children = []
    parent._print_fn = parent.tool_progress_callback = parent.thinking_callback = None
    parent.enabled_toolsets = ["file"]
    parent.disabled_toolsets = []
    parent._project_backup_state = agent._project_backup_state
    child = MagicMock()
    child._project_backup_required = True
    child._interrupt_requested = False
    monkeypatch.setattr(run_agent, "AIAgent", lambda **kwargs: child)
    monkeypatch.setattr(delegate_tool, "_load_config", lambda: {})
    actual = delegate_tool._build_child_agent(task_index=0, goal="Synthetic task", context=None,
        toolsets=None, model=None, max_iterations=2, task_count=1, parent_agent=parent)
    assert actual is child
    assert child._project_backup_inherited_scope == agent._project_backup_state["scope"]
    gate.begin_task(child, "child-task", "child-turn")
    child._tool_guardrails = agent._tool_guardrails
    calls = []
    result = tool_executor._run_agent_tool_execution_middleware(child, function_name="write_file", function_args={"path": "child.txt"}, effective_task_id="child-task", tool_call_id="child-call", execute=lambda args: calls.append(args))
    assert not result.blocked and len(calls) == 1
    receipt = child._project_backup_state["receipt"]
    assert receipt["id"] != agent._project_backup_state["receipt"]["id"]
    assert backup.verify(receipt, home=home)["roots"][0]["path"] == str(root)


def test_junction_created_after_ready_is_denied_at_actual_native_dispatch(context, dispatch):
    import subprocess
    agent, root, home = context
    assert gate.block_reason(agent, "terminal", "task") is None
    outside = root.parent / "outside"
    outside.mkdir()
    sentinel = outside / "original.txt"
    sentinel.write_text("outside original")
    link = root / "alias"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True)
        assert result.returncode == 0, result.stderr
    try:
        outcome = dispatch("write_file", {"path": "alias/original.txt"}, lambda args: sentinel.write_text("must not execute"))
        assert outcome.blocked and "reparse" in outcome.result
        assert sentinel.read_text() == "outside original"
    finally:
        if link.is_symlink():
            link.unlink()
        else:
            link.rmdir()


def test_real_failover_system_message_retains_project_work_policy_without_rewriting_stored_prompt():
    from agent.conversation_loop import _sync_failover_system_message
    agent = SimpleNamespace(_cached_system_prompt="Original provider identity", ephemeral_system_prompt="Existing ephemeral rules", _project_backup_required=True)
    messages = [{"role": "system", "content": "Old provider identity"}]
    assert _sync_failover_system_message(agent, messages, "Old") == "Original provider identity"
    assert gate.PROJECT_FILE_WORK_RULES in messages[0]["content"]
    assert "Existing ephemeral rules" in messages[0]["content"]
    assert agent._cached_system_prompt == "Original provider identity"


def test_no_project_research_dispatcher_and_readonly_child_work_but_child_write_refuses(context, dispatch, monkeypatch):
    from agent import tool_executor
    agent, root, home = context
    monkeypatch.setattr("tools.file_tools._authoritative_workspace_root", lambda task: None)
    def no_scope(task):
        raise backup.ProjectBackupError("Choose a project with + PROJECT")
    monkeypatch.setattr(gate, "_scope", no_scope)
    child = SimpleNamespace(_project_backup_required=True, _interrupt_requested=False)
    gate.begin_task(child, "child-no-project", "child-turn")
    def research(args):
        assert gate.block_reason(child, "browser_navigate", "child-no-project", {"url": "https://example.invalid"}) is None
        assert child._project_backup_state["receipt"] is None
        return "read-only child dispatch admitted"
    outcome = dispatch("delegate_task", {}, research)
    assert not outcome.blocked and outcome.result == "read-only child dispatch admitted"
    executed = []
    denied = tool_executor._run_agent_tool_execution_middleware(child, function_name="write_file", function_args={"path": "outside.txt"}, effective_task_id="child-no-project", tool_call_id="child-write", execute=lambda args: executed.append(args))
    assert denied.blocked and "+ PROJECT" in denied.result
    assert executed == []
    assert child._project_backup_state["receipt"] is None
