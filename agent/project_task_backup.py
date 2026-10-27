"""Mandatory backup floor for project effects across native Runtime tools.

The floor does not replace approval or managed admission and is not an OS
sandbox. Plain chat and trusted read-only tools remain available. Arbitrary
commands/code and unknown MCP effects require a concrete project root. Browser
interaction and observable computer-use retain their existing governed admission.
"""
from __future__ import annotations

import threading
from contextlib import ExitStack, contextmanager
from pathlib import Path
import os

from tools.project_task_backup import ProjectBackupError, snapshot, verify, _lock

# Product-owned read surfaces only. Unknown/plugin/MCP names are not trusted
# because a server's readOnlyHint is not an enforcement boundary.
NO_PROJECT_FILE_EFFECT_TOOLS = frozenset({"read_file", "list_files", "search_files", "web_search", "web_extract", "skill_view", "session_search", "tool_search", "memory", "skill_manage", "project_list", "project_create", "project_switch", "delegate_task", "clarify", "todo", "cronjob", "send_message", "react_to_message", "vision_analyze", "video_analyze", "skills_list", "read_terminal", "close_terminal", "focus_pane", "open_preview", "feishu_doc_read", "feishu_drive_list_comments", "feishu_drive_list_comment_replies", "ha_list_entities", "ha_get_state", "ha_list_services"})


BROWSER_SURFACES = frozenset({"browser_navigate", "browser_snapshot", "browser_click", "browser_type",
    "browser_scroll", "browser_back", "browser_press", "browser_get_images", "browser_vision"})
COMPUTER_OBSERVE_ACTIONS = frozenset({"capture", "wait", "list_apps", "list_windows", "cua_browser_state"})


def _needs_project_backup(name, args):
    if name in NO_PROJECT_FILE_EFFECT_TOOLS or name in BROWSER_SURFACES:
        return False
    if name == "browser_console" and not (args or {}).get("expression"):
        return False
    if name == "text_to_speech" and not (args or {}).get("output_path"):
        return False
    if name == "computer_use" and (args or {}).get("action") in COMPUTER_OBSERVE_ACTIONS:
        return False
    return True


def begin_task(agent, effective_task_id: str, turn_id: str):
    if not getattr(agent, "_project_backup_required", False):
        return
    inherited = getattr(agent, "_project_backup_inherited_scope", None)
    agent._project_backup_state = {"task_id": effective_task_id, "turn_id": turn_id,
                                   "scope": inherited, "receipt": None, "lock": threading.RLock()}


def _scope(task_id: str) -> list[dict]:
    from tools.file_tools import _authoritative_workspace_root
    root = _authoritative_workspace_root(task_id)
    if not root:
        raise ProjectBackupError("Choose a project with + PROJECT or Settings > Workspace before running file-changing tools.")
    # These registered roots are execution context, not model-emitted workdir.
    path = str(Path(root).expanduser().absolute())
    roots = [{"path": path}]
    from youtab_agent_cli import projects_db as pdb
    db = pdb.projects_db_path()
    if db.exists():
        with pdb.connect_closing() as conn:
            policy = pdb.working_copy_policy_for_cwd(conn, path)
        if policy:
            roots = [{"path": policy["working_path"]}, {"path": policy["source_path"], "excluded": [Path(policy["working_path"]).relative_to(Path(policy["source_path"])).as_posix()]}]
    return roots


def _state_and_scope(agent, task_id):
    state = getattr(agent, "_project_backup_state", None)
    if state is None:
        begin_task(agent, task_id, str(getattr(agent, "_current_turn_id", "") or task_id))
        state = getattr(agent, "_project_backup_state", None)
    if state is None:
        raise ProjectBackupError("Project backup context is missing; select the intended project and retry.")
    with state["lock"]:
        if state["scope"] is None:
            state["scope"] = _scope(task_id)
        from tools.file_tools import _authoritative_workspace_root
        current = _authoritative_workspace_root(task_id)
        if not current or not Path(os.path.abspath(current)).is_relative_to(Path(state["scope"][0]["path"])):
            raise ProjectBackupError("The active workspace changed. Start a new task in the intended project so its files are backed up first.")
        return state, state["scope"]


def _scope_locks(roots):
    stack = ExitStack()
    try:
        for path in sorted({str(Path(root["path"]).absolute()) for root in roots}):
            stack.enter_context(_lock(path))
        return stack
    except BaseException:
        stack.close()
        raise


@contextmanager
def file_effect_lease(agent, function_name, task_id):
    """Held only after ordered start/policy, across actual native file dispatch."""
    if not getattr(agent, "_project_backup_required", False) or function_name not in {"write_file", "patch"}:
        yield
        return
    _, roots = _state_and_scope(agent, task_id)
    with _scope_locks(roots):
        yield


def _before_effect(agent, task_id: str):
    state, roots = _state_and_scope(agent, task_id)
    # Root locks precede state locks on every path, including concurrent calls.
    with _scope_locks(roots), state["lock"]:
        if state.get("failure"):
            raise ProjectBackupError(state["failure"])
        if state["receipt"] is None:
            try:
                from tools.interrupt import is_interrupted
                state["receipt"] = snapshot(roots, state["turn_id"],
                                            cancelled=lambda: bool(getattr(agent, "_interrupt_requested", False)) or is_interrupted())
            except Exception as error:
                state["failure"] = str(error)
                raise
        state["manifest"] = verify(state["receipt"])
        return state["receipt"]


def block_reason(agent, function_name: str, task_id: str, function_args: dict | None = None) -> str | None:
    if not getattr(agent, "_project_backup_required", False) or not _needs_project_backup(function_name, function_args):
        return None
    try:
        receipt = _before_effect(agent, task_id)
        from tools.interrupt import is_interrupted
        if getattr(agent, "_interrupt_requested", False) or is_interrupted():
            raise ProjectBackupError("Task was interrupted; no effect was dispatched after backup.")
        if function_name in {"write_file", "patch"} and function_args:
            from tools.file_tools import _resolve_path_for_task
            paths = [function_args["path"]] if function_args.get("path") else []
            if function_name == "patch" and function_args.get("mode") == "patch" and function_args.get("patch"):
                from tools.patch_parser import parse_v4a_patch
                operations, error = parse_v4a_patch(function_args["patch"])
                if error:
                    raise ProjectBackupError(f"Invalid patch: {error}")
                for operation in operations:
                    paths.append(operation.file_path)
                    if operation.new_path:
                        paths.append(operation.new_path)
            for value in paths:
                target = Path(os.path.abspath(_resolve_path_for_task(value, task_id)))
                if not target.is_relative_to(Path(receipt["workspace"])):
                    raise ProjectBackupError("The requested file is outside the backed-up project. Select its project explicitly before editing it.")
                manifest = agent._project_backup_state["manifest"]
                for excluded in manifest["roots"][0].get("excluded", []):
                    if target.is_relative_to(Path(receipt["workspace"]) / excluded):
                        raise ProjectBackupError("This target is a protected project backup subtree, excluded from task file effects.")
                # A still-existing ancestor cannot be a link/reparse escape,
                # including when the target itself will be newly created.
                ancestor = target
                while not ancestor.exists() and not ancestor.is_symlink():
                    ancestor = ancestor.parent
                from tools.project_task_backup import checked_path
                checked_path(ancestor, directory=ancestor.is_dir())
        if function_name == "terminal" and function_args and function_args.get("workdir"):
            target = Path(function_args["workdir"]).expanduser()
            if not target.is_absolute() or not target.absolute().is_relative_to(Path(receipt["workspace"])):
                raise ProjectBackupError("The requested terminal working folder is outside the backed-up project.")
        return None
    except Exception as error:
        # Failure is visible to the model/UI and prevents dispatch. Do not turn
        # missing permissions, malformed policy, missing storage or failed hash
        # verification into a best-effort success.
        return f"Project backup required: {error}. No tool effect was dispatched."


PROJECT_FILE_WORK_RULES = """<youtab-project-file-work>
Before modifying project files, read the complete current user request and every relevant source/configuration file; page through the full files rather than relying on excerpts. Identify callers, dependencies, tests and required behavior before choosing the smallest change. Preserve existing options and unrelated changes. Confirm a verified pre-task project backup exists before any modification; if the Runtime refuses backup coverage or verification, stop the effect and explain the actionable blocker. Work on the selected Youtab working copy when present; do not modify original source files. Recovery must restore explicitly selected project files only, retain chats/sessions, and require a current preview and separate confirmation. Never claim these instructions prove comprehension or provide OS containment; request additional project scope for uncovered locations.
</youtab-project-file-work>"""


def project_work_instructions(prompt: str) -> str:
    """Model work policy, separate from the enforced verified-backup floor."""
    return prompt if PROJECT_FILE_WORK_RULES in prompt else prompt + "\n\n" + PROJECT_FILE_WORK_RULES
