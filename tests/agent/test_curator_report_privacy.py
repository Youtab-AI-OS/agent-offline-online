"""Real diagnostic exports preserve live state and verify private output."""
import copy
import json
import os
import stat
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest
from agent import curator


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(curator, "get_youtab_home", lambda: home)
    assert Path(curator.__file__).resolve() == Path(__file__).resolve().parents[2] / "agent" / "curator.py"
    return home


def _write(meta):
    return curator._write_run_report(
        started_at=datetime(2099, 1, 1, tzinfo=timezone.utc), elapsed_seconds=1.25,
        auto_counts={"checked": 1, "marked_stale": 1, "archived": 0, "reactivated": 0},
        auto_summary="1 marked stale", before_report=[{"name": "proof-skill", "state": "active"}],
        before_names={"proof-skill"}, after_report=[{"name": "proof-skill", "state": "stale"}],
        llm_meta=meta,
    )


def _meta(**overrides):
    result = {"final": "public summary فارسی 🙂", "summary": "public summary", "error": None,
              "model": "proof-model", "provider": "proof-provider", "tool_calls": []}
    result.update(overrides)
    return result


def _assert_private(path):
    if os.name == "nt":
        import win32api
        import win32con
        import win32security
        token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try:
            sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        finally:
            token.Close()
        security = win32security.GetFileSecurity(str(path), win32security.DACL_SECURITY_INFORMATION)
        assert security.GetSecurityDescriptorControl()[0] & win32security.SE_DACL_PROTECTED
        acl = security.GetSecurityDescriptorDacl()
        assert acl is not None and acl.GetAceCount() == 1
        assert win32security.ConvertSidToStringSid(acl.GetAce(0)[-1]) == win32security.ConvertSidToStringSid(sid)
    else:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_real_report_masks_secrets_preserves_inputs_schema_and_private_acl(home):
    secret = 'qa-opaque-secret-with-"quotes"-and-\\slashes'
    vendor = "sk-proj-" + "S" * 48
    args = {"action": "patch", "name": "proof-skill", "api_key": secret,
            "nested": [{"password": secret, "public": 7}], "enabled": True,
            "empty": None, "token": "", "reference": {"api_key": "os.getenv('KEY')"}}
    meta = _meta(final="OPENAI_API_KEY=" + vendor + "; public summary فارسی 🙂",
                 error="Authorization: Bearer " + vendor,
                 tool_calls=[{"name": "skill_manage", "arguments": json.dumps(args)}])
    original = copy.deepcopy(meta)
    path = _write(meta)
    assert path is not None and meta == original
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    text = (path / "run.json").read_text(encoding="utf-8") + (path / "REPORT.md").read_text(encoding="utf-8")
    assert vendor not in text and secret not in text
    assert "فارسی 🙂" in text and "public summary" in text
    assert payload["model"] == "proof-model" and payload["provider"] == "proof-provider"
    assert payload["added"] == [] and payload["archived"] == []
    assert payload["state_transitions"] == [{"name": "proof-skill", "from": "active", "to": "stale"}]
    exported_args = json.loads(payload["tool_calls"][0]["arguments"])
    assert set(exported_args) == set(args)
    assert exported_args["name"] == args["name"] and exported_args["action"] == args["action"]
    assert exported_args["nested"][0]["public"] == 7 and exported_args["enabled"] is True
    assert exported_args["empty"] is None and exported_args["token"] == ""
    assert "os.getenv" not in exported_args["reference"]["api_key"]
    for filename in ("run.json", "REPORT.md"):
        _assert_private(path / filename)


@pytest.mark.parametrize("arguments", ["{  \"action\": \"patch\", \"name\": \"proof-skill\" }", {"action": "patch", "name": "proof-skill"}])
def test_nonsecret_export_values_and_prior_runs_are_preserved(home, arguments):
    meta = _meta(tool_calls=[{"name": "skill_manage", "arguments": arguments}])
    first = _write(meta)
    assert first is not None
    old_json = (first / "run.json").read_bytes()
    old_md = (first / "REPORT.md").read_bytes()
    second = _write(meta)
    assert second is not None and first != second
    assert (first / "run.json").read_bytes() == old_json
    assert (first / "REPORT.md").read_bytes() == old_md
    payload = json.loads((second / "run.json").read_text(encoding="utf-8"))
    assert payload["tool_calls"] == meta["tool_calls"]
    assert payload["llm_final"] == meta["final"] and payload["llm_error"] is None


def test_structured_arguments_url_credentials_and_disabled_preference(home, monkeypatch):
    import agent.redact as redact
    monkeypatch.setattr(redact, "_REDACT_ENABLED", False)
    url = "https://operator:qa-password@api.example.invalid/path?api_key=qa-query-secret&topic=public"
    meta = _meta(final=url, tool_calls=[{"name": "skill_manage", "arguments": {"api_key": "qa-opaque-secret", "public": url}}])
    path = _write(meta)
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    text = json.dumps(payload)
    assert all(secret not in text for secret in ("qa-password", "qa-query-secret", "qa-opaque-secret"))
    assert "topic=public" in text


def test_protection_failure_does_not_stage_data_or_overwrite_prior_report(home, monkeypatch):
    from youtab_agent_cli import secret_env
    first = _write(_meta())
    old = (first / "run.json").read_bytes()
    def denied(*args):
        raise PermissionError("synthetic denied private access")
    monkeypatch.setattr(secret_env, "_restrict_stage", denied)
    assert _write(_meta(final="sk-proj-" + "S" * 48)) is None
    assert (first / "run.json").read_bytes() == old
    assert not list(home.rglob(".secret_bytes_*.tmp"))


def test_selected_profile_directory_link_remains_supported(home, monkeypatch):
    link = home.parent / "linked-home"
    if os.name == "nt":
        result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(home)], capture_output=True)
        assert result.returncode == 0, result.stderr
    else:
        link.symlink_to(home, target_is_directory=True)
    monkeypatch.setattr(curator, "get_youtab_home", lambda: link)
    path = _write(_meta())
    assert path is not None and (path / "run.json").is_file()
    assert path.resolve().is_relative_to(home)
    _assert_private(path / "run.json")



def _state(secret):
    state = curator._default_state()
    state.update(last_run_at="2099-01-01T00:00:00+00:00", last_run_duration_seconds=1.25,
                 last_run_summary="llm: OPENAI_API_KEY=" + secret + "; public summary فارسی 🙂",
                 last_run_summary_shown_at="2099-01-01T00:01:00+00:00",
                 last_report_path="public-report/REPORT.md", paused=False, run_count=7,
                 _identity={"tenant": "proof-tenant", "run": "proof-run"},
                 _classification={"consolidated": ["proof-skill"], "pruned": []})
    return state


def test_real_state_writer_redacts_copy_preserves_schema_identity_and_times(home):
    (home / "skills").mkdir()
    secret = "sk-proj-" + "S" * 48
    state = _state(secret)
    original = copy.deepcopy(state)
    curator.save_state(state)
    raw = (home / "skills" / ".curator_state").read_text(encoding="utf-8")
    assert secret not in raw and "public summary" in raw and "فارسی 🙂" in raw
    saved = json.loads(raw)
    assert state == original and set(saved) == set(original)
    for key in original:
        if key != "last_run_summary":
            assert saved[key] == original[key]


def test_real_status_masks_legacy_summary_without_rewriting_history(home, monkeypatch, capsys):
    from types import SimpleNamespace
    from youtab_agent_cli import curator as cli
    from tools import skill_usage
    (home / "skills").mkdir()
    secret = "sk-proj-" + "S" * 48
    state = _state(secret)
    path = home / "skills" / ".curator_state"
    raw = json.dumps(state, ensure_ascii=False).encode("utf-8")
    path.write_bytes(raw)
    monkeypatch.setattr(curator, "is_enabled", lambda: True)
    monkeypatch.setattr(curator, "get_interval_hours", lambda: 168)
    monkeypatch.setattr(curator, "get_stale_after_days", lambda: 30)
    monkeypatch.setattr(curator, "get_archive_after_days", lambda: 90)
    monkeypatch.setattr(curator, "get_consolidate", lambda: False)
    monkeypatch.setattr(skill_usage, "curated_report", lambda: [])
    monkeypatch.setattr(skill_usage, "unmanaged_report", lambda: [])
    loaded = curator.load_state()
    assert set(loaded) == set(state)
    assert all(loaded[key] == value for key, value in state.items() if key != "last_run_summary")
    assert cli._cmd_status(SimpleNamespace()) == 0
    output = capsys.readouterr().out
    assert secret not in output and "public summary" in output and "فارسی 🙂" in output
    assert path.read_bytes() == raw


def test_real_review_callback_and_state_report_exports_redact_original_meta_copy(home, monkeypatch):
    from tools import skill_usage
    (home / "skills").mkdir()
    secret = "sk-proj-" + "S" * 48
    meta = _meta(final="OPENAI_API_KEY=" + secret,
                 summary="OPENAI_API_KEY=" + secret + "; public summary فارسی 🙂")
    original = copy.deepcopy(meta)
    monkeypatch.setattr(skill_usage, "curated_report", lambda: [{"name": "proof-skill", "state": "active"}])
    monkeypatch.setattr(curator, "_render_candidate_list", lambda: "proof-skill")
    monkeypatch.setattr(curator, "get_prune_builtins", lambda: False)
    monkeypatch.setattr(curator, "_run_llm_review", lambda prompt: meta)
    summaries = []
    curator.run_curator_review(on_summary=summaries.append, synchroyoutab=True, dry_run=True, consolidate=True)
    assert summaries and all(secret not in value for value in summaries)
    assert "public summary" in summaries[-1] and "فارسی 🙂" in summaries[-1]
    assert meta == original
    for path in home.rglob("*"):
        if path.is_file():
            assert secret not in path.read_text(encoding="utf-8")


@pytest.mark.parametrize("summary", [None, "public summary فارسی 🙂"])
def test_nonsecret_or_absent_state_summary_is_unchanged(home, summary):
    (home / "skills").mkdir()
    state = curator._default_state()
    state["last_run_summary"] = summary
    original = copy.deepcopy(state)
    curator.save_state(state)
    assert curator.load_state() == original and state == original


@pytest.mark.parametrize("serialized", [False, True])
@pytest.mark.parametrize("shape", ["list", "object", "nested"])
def test_real_writer_inherits_known_credential_context_through_containers(home, serialized, shape):
    secret = "qa-opaque-review-secret-123"
    lookup = "os.getenv('KEY')"
    template = "$ENV{AUTH_TOKEN}"
    if shape == "list":
        credential = [secret, lookup, template, "", None, 7, False]
    elif shape == "object":
        credential = {"value": secret, "lookup": lookup, "template": template,
                      "empty": "", "none": None, "number": 7, "enabled": False}
    else:
        credential = [{"inner": {"values": [secret, lookup, template, "", None, 7, False]}}]
    args = {"name": "proof-skill", "id": "proof-call", "public": 7, "enabled": True,
            "none": None, "api_key": credential, "wrapper": [{"password": secret}]}
    arguments = json.dumps(args) if serialized else args
    meta = _meta(tool_calls=[{"name": "skill_manage", "arguments": arguments}])
    original = copy.deepcopy(meta)
    path = _write(meta)
    assert path is not None and meta == original
    raw = (path / "run.json").read_text(encoding="utf-8")
    payload = json.loads(raw)
    assert secret not in raw
    exported = payload["tool_calls"][0]["arguments"]
    assert isinstance(exported, str) is serialized
    exported = json.loads(exported) if serialized else exported
    for key in ("name", "id", "public", "enabled", "none"):
        assert exported[key] == args[key]
    def check_shape(before, after):
        if before is not None and not isinstance(before, (str, dict, list)):
            assert after is None  # Secret scalar leaves are diagnostic-nullable.
            return
        assert type(after) is type(before)
        if isinstance(before, dict):
            assert set(before) == set(after)
            for key in before:
                check_shape(before[key], after[key])
        elif isinstance(before, list):
            assert len(before) == len(after)
            for a, b in zip(before, after):
                check_shape(a, b)
        elif before in (secret, lookup, template):
            assert after != before
        else:
            assert after == before
    check_shape(credential, exported["api_key"])
    assert payload["model"] == "proof-model" and payload["provider"] == "proof-provider"
    assert payload["state_transitions"] == [{"name": "proof-skill", "from": "active", "to": "stale"}]
    _assert_private(path / "run.json")


@pytest.mark.parametrize("serialized", [False, True])
@pytest.mark.parametrize("credential_key", ["password", "api_key"])
@pytest.mark.parametrize("shape", ["direct", "object", "list"])
def test_real_writer_numeric_secret_leaves_are_null_without_changing_operational_metadata(
    home, serialized, credential_key, shape,
):
    secret = 897263145
    leaves = [secret, 2.5, True, False, None]
    if shape == "direct":
        args = {credential_key: secret, "secret": 2.5, "token": True, "raw_secret": False, "key_material": None}
    elif shape == "object":
        args = {credential_key: {"value": secret, "nested": {"leaves": leaves}}}
    else:
        args = {credential_key: [secret, {"leaves": leaves}]}
    args.update(public_count=7, id=2112, enabled=True, disabled=False, absent=None,
                timestamp="2099-01-01T00:00:00+00:00", name="proof-skill")
    meta = _meta(tool_calls=[{"name": "skill_manage", "arguments": json.dumps(args) if serialized else args}])
    original = copy.deepcopy(meta)
    path = _write(meta)
    assert path is not None and meta == original
    raw = (path / "run.json").read_text(encoding="utf-8")
    assert str(secret) not in raw
    payload = json.loads(raw)
    export = payload["tool_calls"][0]["arguments"]
    assert isinstance(export, str) is serialized
    export = json.loads(export) if serialized else export
    assert set(export) == set(args)
    for key in ("public_count", "id", "enabled", "disabled", "absent", "timestamp", "name"):
        assert type(export[key]) is type(args[key]) and export[key] == args[key]
    if shape == "direct":
        assert all(export[key] is None for key in (credential_key, "secret", "token", "raw_secret", "key_material"))
    elif shape == "object":
        assert set(export[credential_key]) == {"value", "nested"}
        assert export[credential_key] == {"value": None, "nested": {"leaves": [None] * len(leaves)}}
    else:
        assert export[credential_key] == [None, {"leaves": [None] * len(leaves)}]
    assert payload["counts"]["before"] == 1 and payload["counts"]["after"] == 1
    assert payload["model"] == "proof-model" and payload["provider"] == "proof-provider"
    assert payload["state_transitions"] == [{"name": "proof-skill", "from": "active", "to": "stale"}]
    _assert_private(path / "run.json")


@pytest.mark.parametrize("serialized", [False, True])
@pytest.mark.parametrize("credential_key", ["password", "api_key"])
@pytest.mark.parametrize("leaf", [897263145, 2.5, True, False, None])
def test_real_writer_direct_known_credential_scalar_contract(home, serialized, credential_key, leaf):
    args = {credential_key: leaf, "public_count": 7, "id": 2112, "enabled": True,
            "disabled": False, "absent": None, "timestamp": "2099-01-01T00:00:00+00:00"}
    meta = _meta(tool_calls=[{"name": "skill_manage", "arguments": json.dumps(args) if serialized else args}])
    original = copy.deepcopy(meta)
    path = _write(meta)
    assert path is not None and meta == original
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    export = payload["tool_calls"][0]["arguments"]
    export = json.loads(export) if serialized else export
    assert set(export) == set(args) and export[credential_key] is None
    for key in args:
        if key != credential_key:
            assert type(export[key]) is type(args[key]) and export[key] == args[key]


@pytest.mark.parametrize("shape", ["direct", "list", "object", "numeric"])
def test_actual_collector_clip_then_writer_omits_invalid_arguments(home, monkeypatch, shape):
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(home))
    import run_agent
    secret = "qa-opaque-review-secret-123"
    value = secret if shape == "direct" else [secret] if shape == "list" else {"value": secret} if shape == "object" else 897263145
    arguments = json.dumps({"api_key": value, "padding": "x" * 700})
    messages = [{"role": "assistant", "tool_calls": [{"function": {"name": "skill_manage", "arguments": arguments}}]}]
    original_messages = copy.deepcopy(messages)
    class FakeReview:
        def __init__(self, **kwargs):
            self._session_messages = messages
        def run_conversation(self, **kwargs):
            return {"final_response": "public summary"}
        def close(self):
            pass
    monkeypatch.setattr(run_agent, "AIAgent", FakeReview)
    monkeypatch.setattr(curator, "_resolve_review_runtime", lambda cfg: curator._ReviewRuntimeBinding("proof-provider", "proof-model", None, None, {}))
    monkeypatch.setattr("youtab_agent_cli.config.load_config_readonly", lambda: {})
    monkeypatch.setattr("youtab_agent_cli.runtime_provider.resolve_runtime_provider", lambda **kw: {"provider": "proof-provider", "model": "proof-model"})
    meta = curator._run_llm_review("synthetic prompt")
    assert meta["tool_calls"][0]["arguments"] == arguments[:400] + "…"
    original_meta = copy.deepcopy(meta)
    path = _write(meta)
    assert path is not None and messages == original_messages and meta == original_meta
    raw = (path / "run.json").read_text(encoding="utf-8")
    payload = json.loads(raw)
    assert payload["tool_calls"][0]["arguments"] == "[invalid/truncated arguments omitted for privacy]"
    assert secret not in raw and "897263145" not in raw
    assert payload["tool_calls"][0]["name"] == "skill_manage"
    assert payload["model"] == "proof-model" and payload["provider"] == "proof-provider"
    assert payload["state_transitions"] == [{"name": "proof-skill", "from": "active", "to": "stale"}]


@pytest.mark.parametrize("arguments", ["plain prose", "--token=qa-opaque", "", "{broken", '{"api_key": ["qa-opaque"]…'])
def test_invalid_tool_arguments_omitted_without_omitting_other_prose(home, arguments):
    meta = _meta(final="public final prose", summary="public summary prose",
                 tool_calls=[{"name": "skill_manage", "arguments": arguments}])
    original = copy.deepcopy(meta)
    path = _write(meta)
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert meta == original
    assert payload["tool_calls"][0]["arguments"] == "[invalid/truncated arguments omitted for privacy]"
    assert payload["llm_final"] == meta["final"] and payload["llm_summary"] == meta["summary"]


@pytest.mark.parametrize("arguments", [{"name": "proof-skill", "public": "x" * 700}, ["public", 7], 7, True, None, '{"name":"proof-skill","public":"' + "x" * 700 + '"}', '"public string"', "null"])
def test_supported_native_and_long_valid_JSON_arguments_keep_nonsecret_values(home, arguments):
    meta = _meta(tool_calls=[{"name": "skill_manage", "arguments": arguments}])
    original = copy.deepcopy(meta)
    path = _write(meta)
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert meta == original and payload["tool_calls"] == original["tool_calls"]


@pytest.mark.parametrize("text", ['{"api_key": ["qa-opaque-prose-secret-123"]}', '{"password": {"value": "qa-opaque-prose-secret-123"}}', '{"api_key": 897263145, "public_count": 7}'])
def test_whole_JSON_diagnostic_prose_uses_structured_policy(home, text):
    meta = _meta(final=text, summary=text, error=text)
    original = copy.deepcopy(meta)
    path = _write(meta)
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert meta == original
    for field in ("llm_final", "llm_summary", "llm_error"):
        parsed = json.loads(payload[field])
        assert "qa-opaque-prose-secret-123" not in json.dumps(parsed) and "897263145" not in json.dumps(parsed)
        assert set(parsed) == set(json.loads(text))
        if "public_count" in parsed:
            assert parsed["public_count"] == 7


@pytest.mark.parametrize("text", ['llm: {"api_key": ["qa-opaque-prose-secret-123"]}', 'error: password={"value":"qa-opaque-prose-secret-123"}', 'api_key: 897263145', 'error: {"api_key": [897263145]…'])
def test_ambiguous_known_assignments_omit_diagnostic_copy_and_legacy_read_only(home, monkeypatch, text):
    (home / "skills").mkdir()
    meta = _meta(final=text, summary=text, error=text)
    original = copy.deepcopy(meta)
    path = _write(meta)
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    placeholder = "[credential-bearing diagnostic text omitted for privacy]"
    assert meta == original and all(payload[f] == placeholder for f in ("llm_final", "llm_summary", "llm_error"))
    state = _state("public")
    state["last_run_summary"] = text
    original_state = copy.deepcopy(state)
    curator.save_state(state)
    saved = json.loads((home / "skills" / ".curator_state").read_text(encoding="utf-8"))
    assert saved["last_run_summary"] == placeholder and state == original_state
    assert all(saved[k] == state[k] for k in state if k != "last_run_summary")
    raw = json.dumps(state, ensure_ascii=False).encode("utf-8")
    (home / "skills" / ".curator_state").write_bytes(raw)
    assert curator.load_state()["last_run_summary"] == placeholder
    assert (home / "skills" / ".curator_state").read_bytes() == raw
    from tools import skill_usage
    monkeypatch.setattr(skill_usage, "curated_report", lambda: [{"name": "proof-skill", "state": "active"}])
    monkeypatch.setattr(curator, "_render_candidate_list", lambda: "proof-skill")
    monkeypatch.setattr(curator, "get_prune_builtins", lambda: False)
    monkeypatch.setattr(curator, "_run_llm_review", lambda prompt: meta)
    summaries = []
    curator.run_curator_review(on_summary=summaries.append, synchroyoutab=True, dry_run=True, consolidate=True)
    assert summaries[-1] == placeholder and meta == original


@pytest.mark.parametrize("text", ["public prose about api_key and password without assignment", "token_count=7; id=2112; enabled=true", "api_key=os.getenv('KEY')", 'note: "api_key": "$ENV{AUTH_TOKEN}"', "public summary فارسی 🙂"])
def test_harmless_prose_metadata_and_existing_lookup_references_are_preserved(home, text):
    meta = _meta(final=text, summary=text, error=text)
    path = _write(meta)
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert all(payload[field] == text for field in ("llm_final", "llm_summary", "llm_error"))


@pytest.mark.parametrize("text", [
    "api_key=os.getenv('PUBLIC_ENV') + 'curatorOpaqueSyntheticCanary'",
    "api_key=os.getenv('PUBLIC_ENV')\ncuratorOpaqueSyntheticCanary",
    '{"password": "os.getenv(\'PUBLIC_ENV\')\ncuratorOpaqueSyntheticCanary',
])
def test_environment_reference_prefix_never_exempts_credential_tails(home, text):
    meta = _meta(final=text, summary=text, error=text)
    original = copy.deepcopy(meta)
    path = _write(meta)
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    markdown = (path / "REPORT.md").read_text(encoding="utf-8")
    assert "curatorOpaqueSyntheticCanary" not in json.dumps(payload)
    assert "curatorOpaqueSyntheticCanary" not in markdown
    assert all(payload[field] == "[credential-bearing diagnostic text omitted for privacy]"
               for field in ("llm_final", "llm_summary", "llm_error"))
    assert meta == original


@pytest.mark.parametrize("reference", [
    "os.getenv('KEY')", 'os.getenv("KEY")', "os.environ['KEY']",
    "os.environ.get('KEY')", "process.env.KEY", 'process.env["KEY"]', "$ENV{KEY}",
    "os.getenv ( 'KEY.WITH-DASH' )", "os.environ [ 'KEY_WITH_\u6f22\u5b57' ]",
])
def test_complete_environment_references_remain_readable_in_reports(home, reference):
    text = "api_key=" + reference
    path = _write(_meta(final=text, summary=text, error=text))
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert all(payload[field] == text for field in ("llm_final", "llm_summary", "llm_error"))


def test_unlabelled_known_vendor_regex_control_and_unknown_residual(home):
    vendor = "sk-proj-" + "S" * 48
    meta = _meta(final="public prefix " + vendor + " public suffix", summary="qa-unlabelled-opaque-value")
    path = _write(meta)
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert vendor not in payload["llm_final"] and "public prefix" in payload["llm_final"] and "public suffix" in payload["llm_final"]
    assert payload["llm_summary"] == meta["summary"]


@pytest.mark.parametrize("text", ['OPENAI_API_KEY=["qa-opaque-prose-secret-123", "second"]', 'prefix db.password={"value":"qa-opaque-prose-secret-123"}', 'OPENAI_API_KEY=' + "sk-proj-" + "S" * 48 + '; api_key=["qa-opaque-prose-secret-123"]'])
def test_environment_namespaced_and_mixed_assignments_fail_closed(home, text):
    path = _write(_meta(final=text, summary=text))
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert payload["llm_final"] == "[credential-bearing diagnostic text omitted for privacy]"
    assert payload["llm_summary"] == payload["llm_final"]


def test_operational_primary_key_prose_is_not_a_credential_assignment(home):
    text = "primary_key=2112; token_count=7; id=2112"
    path = _write(_meta(final=text))
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert payload["llm_final"] == text


@pytest.mark.parametrize("serialized", [False, True])
def test_credential_name_detection_preserves_operational_auth_and_key_metadata(home, serialized):
    args = {"require_auth": True, "primary_key": 2112, "token_count": 7, "public": "require_auth=true; primary_key=2112"}
    path = _write(_meta(tool_calls=[{"name": "skill_manage", "arguments": json.dumps(args) if serialized else args}]))
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert payload["tool_calls"][0]["arguments"] == (json.dumps(args) if serialized else args)


@pytest.mark.parametrize("text", [
    "clientSecret=SYNTHETIC_REVIEW_CANARY",
    "Bearer\tSYNTHETIC_REVIEW_CANARY",
    "bEaReR\nSYNTHETIC_REVIEW_CANARY",
    "aUtHoRiZaTiOn: Bearer SYNTHETIC_REVIEW_CANARY",
    'error: {"password":123SYNTHETIC_REVIEW_CANARY,"public":7}',
    r'error: {"pass\u0077ord":"SYNTHETIC_REVIEW_CANARY"}',
    r'error: {"client\u0053ecret":{"nested":["SYNTHETIC_REVIEW_CANARY"]}}',
    "password=sk-" + "A" * 30 + '\"SYNTHETIC_REVIEW_CANARY',
])
def test_reviewed_bypasses_are_absent_from_actual_report_files(home, text):
    meta = _meta(final=text, summary=text, error=text)
    original = copy.deepcopy(meta)
    path = _write(meta)
    assert path is not None and meta == original
    for filename in ("run.json", "REPORT.md"):
        assert "SYNTHETIC_REVIEW_CANARY" not in (path / filename).read_text(encoding="utf-8")
    payload = json.loads((path / "run.json").read_text(encoding="utf-8"))
    assert payload["model"] == "proof-model" and payload["provider"] == "proof-provider"


@pytest.mark.parametrize("text", [
    'password="first SYNTHETIC_REVIEW_CANARY"',
    "passwd=SYNTHETIC_REVIEW_CANARY",
    "db.password.value=SYNTHETIC_REVIEW_CANARY",
    'password="first SYNTHETIC_REVIEW_CANARY',
])
def test_quoted_and_legacy_credential_assignments_are_absent_from_actual_reports(home, text):
    meta = _meta(final=text, summary=text, error=text)
    original = copy.deepcopy(meta)
    path = _write(meta)
    assert path is not None and meta == original
    for filename in ("run.json", "REPORT.md"):
        assert "SYNTHETIC_REVIEW_CANARY" not in (path / filename).read_text(encoding="utf-8")
