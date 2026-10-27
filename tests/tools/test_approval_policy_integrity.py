"""Approval bypasses require one readable, valid effective policy generation."""
import pytest

from tools import approval as mod
from youtab_agent_cli import config, managed_scope

CANARY = "PRIVATE_POLICY_CANARY_20261008"
GUARDS = [mod.check_dangerous_command, mod.check_all_command_guards]


@pytest.fixture
def policy_files(tmp_path, monkeypatch):
    user = tmp_path / "config.yaml"
    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setattr(config, "ensure_youtab_home", lambda: None)
    monkeypatch.setattr(config, "get_config_path", lambda: user)
    monkeypatch.setattr(managed_scope, "get_managed_dir", lambda **kwargs: managed)
    config._LOAD_CONFIG_CACHE.clear()
    config._LAST_EXPANDED_CONFIG_BY_PATH.clear()
    managed_scope.invalidate_managed_cache()
    monkeypatch.setattr(mod, "_YOLO_MODE_FROZEN", False)
    monkeypatch.setattr(mod, "is_current_session_yolo_enabled", lambda: False)
    monkeypatch.setattr(mod, "_command_matches_permanent_allowlist", lambda _: False)
    monkeypatch.setattr(mod, "_is_interactive_cli", lambda: False)
    monkeypatch.setattr(mod, "_is_gateway_approval_context", lambda: False)
    monkeypatch.delenv("YOUTAB_AGENT_EXEC_ASK", raising=False)
    monkeypatch.delenv("YOUTAB_AGENT_CRON_SESSION", raising=False)
    yield user, managed / "config.yaml"
    config._LOAD_CONFIG_CACHE.clear()
    config._LAST_EXPANDED_CONFIG_BY_PATH.clear()
    managed_scope.invalidate_managed_cache()


def bypass(monkeypatch, kind):
    if kind == "frozen":
        monkeypatch.setattr(mod, "_YOLO_MODE_FROZEN", True)
    elif kind == "session":
        monkeypatch.setattr(mod, "is_current_session_yolo_enabled", lambda: True)
    elif kind == "permanent":
        monkeypatch.setattr(mod, "_command_matches_permanent_allowlist", lambda _: True)


INVALID = [
    "approvals: [" + CANARY,
    "- " + CANARY,
    "false",
    "[]",
    "approvals: " + CANARY,
    "approvals: []",
    "approvals:\n  deny: " + CANARY,
    "approvals:\n  deny: [false]",
    "approvals:\n  deny: [{}]",
]


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
@pytest.mark.parametrize("kind", ["frozen", "session", "permanent", "default"])
@pytest.mark.parametrize("layer", [0, 1], ids=["user", "managed"])
@pytest.mark.parametrize("contents", INVALID, ids=["yaml", "root-list", "root-bool", "root-empty-list", "block-string", "block-list", "deny-string", "deny-bool", "deny-object"])
def test_invalid_policy_blocks_every_shortcut(policy_files, monkeypatch, caplog,
                                               guard, kind, layer, contents):
    policy_files[layer].write_text(contents, encoding="utf-8")
    bypass(monkeypatch, kind)
    result = guard("echo allowed", "local")
    assert result["approved"] is False
    assert result["policy_error"] is True
    assert "repair" in result["message"]
    assert CANARY not in str(result)
    assert CANARY not in caplog.text


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
@pytest.mark.parametrize("kind", ["frozen", "session", "permanent", "default"])
def test_loader_exception_blocks_every_shortcut(policy_files, monkeypatch, caplog, guard, kind):
    def unreadable(**kwargs):
        raise OSError(CANARY)
    monkeypatch.setattr(config, "load_config", unreadable)
    bypass(monkeypatch, kind)
    result = guard("echo allowed", "local")
    assert result["approved"] is False
    assert result["policy_error"] is True
    assert CANARY not in str(result) + caplog.text


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
@pytest.mark.parametrize("contents", [None, "", "null", "{}", "approvals: null", "approvals:\n  deny: []", "approvals:\n  deny: null", "approvals:\n  deny: ['other *']"])
def test_absent_empty_and_valid_nonmatching_policy_preserves_yolo(policy_files, monkeypatch, guard, contents):
    if contents is not None:
        policy_files[0].write_text(contents, encoding="utf-8")
    bypass(monkeypatch, "frozen")
    assert guard("echo allowed", "local")["approved"] is True


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
@pytest.mark.parametrize("kind", ["frozen", "session", "permanent", "default"])
def test_valid_user_deny_still_wins(policy_files, monkeypatch, guard, kind):
    policy_files[0].write_text("approvals:\n  deny: ['echo *']", encoding="utf-8")
    bypass(monkeypatch, kind)
    result = guard("echo forbidden", "local")
    assert result["approved"] is False
    assert result["user_deny"] is True


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
def test_managed_overlay_and_environment_expansion_remain_effective(policy_files, monkeypatch, guard):
    policy_files[0].write_text("approvals:\n  mode: off\n  deny: ['other *']", encoding="utf-8")
    policy_files[1].write_text("approvals:\n  deny: ['echo ${BLOCKED_COMMAND}']", encoding="utf-8")
    monkeypatch.setenv("BLOCKED_COMMAND", "forbidden")
    assert guard("echo forbidden", "local")["user_deny"] is True
    assert guard("echo allowed", "local")["approved"] is True


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
def test_hardline_priority_and_isolation_contract_remain(policy_files, guard):
    policy_files[0].write_text("approvals: [", encoding="utf-8")
    assert guard("rm -rf /", "local")["hardline"] is True
    assert guard("echo allowed", "docker")["approved"] is True
    result = guard("echo allowed", "docker", has_host_access=True)
    assert result["approved"] is False
    assert result["policy_error"] is True


@pytest.mark.parametrize("layer", [0, 1], ids=["user", "managed"])
def test_strict_read_rejects_cached_corrupt_fallback(policy_files, layer):
    policy_files[layer].write_text("approvals:\n  deny: ['echo *']", encoding="utf-8")
    assert config.load_config()["approvals"]["deny"] == ["echo *"]
    policy_files[layer].write_text("approvals: [", encoding="utf-8")
    config.load_config()  # Compatibility startup may cache a fallback result.
    with pytest.raises(ValueError):
        config.load_config(strict_security=True)
    policy_files[layer].write_text("approvals:\n  deny: ['repaired *']", encoding="utf-8")
    assert config.load_config(strict_security=True)["approvals"]["deny"] == ["repaired *"]


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
def test_one_decision_uses_one_generation_and_resets_snapshot(policy_files, monkeypatch, guard):
    policy_files[0].write_text("approvals:\n  mode: off\n  deny: ['other *']", encoding="utf-8")
    load = config.load_config
    calls = []
    def counted(**kwargs):
        calls.append(kwargs)
        return load(**kwargs)
    monkeypatch.setattr(config, "load_config", counted)
    match = mod._match_user_deny_rule
    def changed_after_match(command):
        result = match(command)
        policy_files[0].write_text("approvals: [", encoding="utf-8")
        return result
    monkeypatch.setattr(mod, "_match_user_deny_rule", changed_after_match)
    assert guard("echo allowed", "local")["approved"] is True
    assert calls == [{"strict_security": True}]
    assert mod._approval_policy_snapshot.get() is None
    assert guard("echo allowed", "local")["policy_error"] is True
    assert mod._approval_policy_snapshot.get() is None


def test_invalid_user_deny_cannot_be_masked_by_valid_managed_policy(policy_files, monkeypatch):
    policy_files[0].write_text("approvals:\n  deny: 'not-a-list'", encoding="utf-8")
    policy_files[1].write_text("approvals:\n  deny: []\n  mode: off", encoding="utf-8")
    bypass(monkeypatch, "frozen")
    assert mod.check_all_command_guards("echo allowed", "local")["policy_error"] is True


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
def test_user_stat_access_error_is_sanitized(policy_files, monkeypatch, caplog, guard):
    from pathlib import Path
    real_stat = Path.stat
    def blocked(path, *args, **kwargs):
        if path == policy_files[0]:
            raise PermissionError(CANARY)
        return real_stat(path, *args, **kwargs)
    monkeypatch.setattr(Path, "stat", blocked)
    result = guard("echo allowed", "local")
    assert result["policy_error"] is True
    assert CANARY not in str(result) + caplog.text


@pytest.mark.parametrize("kind", ["missing", "file", "unreadable"])
def test_declared_managed_authority_cannot_disappear(tmp_path, monkeypatch, kind):
    from pathlib import Path
    path = tmp_path / "declared-managed"
    if kind == "file":
        path.write_text("not-a-directory", encoding="utf-8")
    elif kind == "unreadable":
        path.mkdir()
        real_stat = Path.stat
        def blocked(target, *args, **kwargs):
            if target == path:
                raise PermissionError(CANARY)
            return real_stat(target, *args, **kwargs)
        monkeypatch.setattr(Path, "stat", blocked)
    monkeypatch.setenv("YOUTAB_AGENT_MANAGED_DIR", str(path))
    with pytest.raises(ValueError) as error:
        managed_scope.get_managed_dir(strict_security=True)
    assert CANARY not in str(error.value)


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
def test_nested_command_loads_fresh_policy_and_restores_outer(policy_files, monkeypatch, guard):
    policy_files[0].write_text("approvals:\n  mode: off\n  deny: []", encoding="utf-8")
    match = mod._match_user_deny_rule
    observations = []
    nested = False
    def reentrant(command):
        nonlocal nested
        if not nested:
            nested = True
            outer = mod._approval_policy_snapshot.get()
            policy_files[0].write_text("approvals:\n  mode: off\n  deny: ['echo inner']", encoding="utf-8")
            observations.append(guard("echo inner", "local"))
            assert mod._approval_policy_snapshot.get() is outer
        return match(command)
    monkeypatch.setattr(mod, "_match_user_deny_rule", reentrant)
    assert guard("echo outer", "local")["approved"] is True
    assert observations[0]["user_deny"] is True
    assert mod._approval_policy_snapshot.get() is None


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
@pytest.mark.parametrize("threaded", [False, True], ids=["copied-context", "copied-thread-context"])
def test_copied_context_profile_switch_loads_actual_new_profile(policy_files, monkeypatch, tmp_path, guard, threaded):
    import contextvars
    from concurrent.futures import ThreadPoolExecutor
    from pathlib import Path
    import os
    old_home = tmp_path / "old-profile"
    new_home = tmp_path / "new-profile"
    old_home.mkdir()
    new_home.mkdir()
    (old_home / "config.yaml").write_text("approvals:\n  mode: off\n  deny: []", encoding="utf-8")
    (new_home / "config.yaml").write_text("approvals:\n  mode: off\n  deny: ['echo forbidden']", encoding="utf-8")
    monkeypatch.setattr(config, "get_config_path", lambda: Path(os.environ["YOUTAB_AGENT_HOME"]) / "config.yaml")
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(old_home))
    old_policy = config.load_config(strict_security=True)
    token = mod._approval_policy_snapshot.set(old_policy)
    try:
        copied = contextvars.copy_context()
        monkeypatch.setenv("YOUTAB_AGENT_HOME", str(new_home))
        if threaded:
            with ThreadPoolExecutor(max_workers=1) as executor:
                result = executor.submit(copied.run, guard, "echo forbidden", "local").result(timeout=10)
        else:
            result = copied.run(guard, "echo forbidden", "local")
        assert result["user_deny"] is True
        assert copied.run(mod._approval_policy_snapshot.get) is old_policy
        assert mod._approval_policy_snapshot.get() is old_policy
    finally:
        mod._approval_policy_snapshot.reset(token)


@pytest.mark.parametrize("guard", GUARDS, ids=lambda g: g.__name__)
def test_downstream_failure_is_not_misreported_as_policy_failure(policy_files, monkeypatch, guard):
    policy_files[0].write_text("approvals:\n  deny: []", encoding="utf-8")
    def failed_check(command):
        raise RuntimeError("downstream guard error")
    monkeypatch.setattr(mod, "_match_user_deny_rule", failed_check)
    outer = {"approvals": {"mode": "off"}}
    token = mod._approval_policy_snapshot.set(outer)
    try:
        with pytest.raises(RuntimeError, match="downstream guard error"):
            guard(command="echo allowed", env_type="local", has_host_access=True)
        assert mod._approval_policy_snapshot.get() is outer
    finally:
        mod._approval_policy_snapshot.reset(token)


@pytest.mark.parametrize("kind", ["frozen", "session", "permanent", "default"])
def test_execute_code_policy_failure_denies_without_manual_fallback(policy_files, monkeypatch, kind):
    policy_files[0].write_text("approvals: [", encoding="utf-8")
    bypass(monkeypatch, kind)
    result = mod.check_execute_code_guard(code="print('not executed')", env_type="local")
    assert result["approved"] is False
    assert result["policy_error"] is True
    assert mod._approval_policy_snapshot.get() is None


def test_execute_code_copied_policy_is_not_reused(policy_files, monkeypatch):
    policy_files[0].write_text("approvals: [", encoding="utf-8")
    token = mod._approval_policy_snapshot.set({"approvals": {"mode": "off"}})
    try:
        result = mod.check_execute_code_guard("print('not executed')", "local")
        assert result["policy_error"] is True
    finally:
        mod._approval_policy_snapshot.reset(token)


def test_display_command_reports_unavailable_without_secrets_or_save(policy_files, monkeypatch, caplog):
    from youtab_agent_cli.approval_mode import run_approval_mode_command
    policy_files[0].write_text("approvals: [" + CANARY, encoding="utf-8")
    writes = []
    monkeypatch.setattr(config, "set_config_value", lambda *args: writes.append(args))
    for requested in (None, "off"):
        result = run_approval_mode_command(requested)
        assert result.ok is False
        assert result.mode == "unavailable"
        assert result.changed is False
        assert CANARY not in result.message + caplog.text
    assert writes == []
