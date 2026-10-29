"""Synthetic final-sink regressions; no network, providers, or operator state."""
import asyncio
import copy
import io
import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest
from agent import auxiliary_client, curator, redact
from tools import mcp_tool

CANARY = "OPAQUE_ONLY_SYNTHETIC_CANARY_20261009"
CASES = [
    json.dumps({"password": CANARY}),
    "https://u:" + CANARY + "@example.invalid/",
    "github_pat_" + CANARY,
    "token=" + "a" * 255 + CANARY,
    "MYTOKEN=" + CANARY,
    'password="first ' + CANARY + '"',
    "password='first " + CANARY + "'",
    'password="first \\"escaped\\" ' + CANARY + '"',
    "passwd=" + CANARY,
    "db.password.value=" + CANARY,
    "db.password.token_count=" + CANARY,
    'password="first\t\n' + CANARY + '"',
    "clientSecret=" + CANARY,
    "secretKey=" + CANARY,
    "APIToken=" + CANARY,
    "Bearer\t" + CANARY,
    "bEaReR\n" + CANARY,
    "aUtHoRiZaTiOn: Bearer " + CANARY,
    'error: {"password":123' + CANARY + ',"public":7}',
    'error: {"password":true' + CANARY + ',"public":7}',
    r'error: {"pass\u0077ord":"' + CANARY + '\"}',
    r'error: {"client\u0053ecret":{"nested":["' + CANARY + '"]}}',
    "Bearer " + CANARY,
    "Error with key=" + CANARY,
    "operation failed; token=" + "a" * 255 + CANARY + " https://example.invalid/",
    json.dumps({"client_secret": 'os.getenv-' + CANARY + '\"\\tail'}),
    json.dumps({"id_token": {"values": [CANARY, 897263145, True, None]}}),
]
FIELDS = ["client_secret", "id_token", "authorization", "private_key", "password", "api_key"]


@pytest.fixture
def sink(monkeypatch):
    monkeypatch.setattr(redact, "_REDACT_ENABLED", False)
    stream = io.StringIO()
    logger = logging.Logger("synthetic-diagnostic", logging.DEBUG)
    handler = logging.StreamHandler(stream)
    handler.setFormatter(redact.RedactingFormatter("%(message)s"))
    logger.addHandler(handler)
    monkeypatch.setattr(mcp_tool, "logger", logger)
    monkeypatch.setattr(auxiliary_client, "logger", logger)
    return stream


def test_actual_import_origins():
    root = Path(__file__).resolve().parents[2]
    for module, relative in [(redact, "agent/redact.py"), (curator, "agent/curator.py"),
                             (auxiliary_client, "agent/auxiliary_client.py"), (mcp_tool, "tools/mcp_tool.py")]:
        assert Path(module.__file__).resolve() == root / relative
    import mcp.types
    assert mcp.types.__file__  # Real installed SDK, no local fake SDK module.


@pytest.mark.parametrize("payload", CASES + ["Project status remains on schedule."])
def test_final_mcp_tool_json_and_sampling_text(sink, monkeypatch, payload):
    calls = []
    async def call_tool(name, arguments):
        calls.append((name, arguments))
        return SimpleNamespace(isError=True, content=[SimpleNamespace(text=payload)])
    server = SimpleNamespace(session=SimpleNamespace(call_tool=call_tool), _rpc_lock=asyncio.Lock())
    monkeypatch.setattr(mcp_tool, "_server_error_counts", {})
    monkeypatch.setattr(mcp_tool, "_get_connected_server_for_call", lambda name: server)
    monkeypatch.setattr(mcp_tool, "_run_on_mcp_loop", lambda call, timeout: asyncio.run(call()))
    arguments = {"password": CANARY, "public_count": 7}
    result = json.loads(mcp_tool._make_tool_handler("synthetic", "synthetic", 1)(arguments))
    assert calls == [("synthetic", arguments)]  # Live tool inputs are untouched.
    assert "error" in result
    sampling = mcp_tool.SamplingHandler("synthetic", {})
    choice = SimpleNamespace(message=SimpleNamespace(content=payload), finish_reason="stop")
    response = SimpleNamespace(model="synthetic", usage=None)
    sampled = sampling._build_text_result(choice, response)
    assert sampled.role == "assistant" and sampled.model == "synthetic" and sampled.stopReason == "endTurn"
    assert CANARY not in json.dumps(result) and CANARY not in sampled.content.text
    if payload == "Project status remains on schedule.":
        assert result["error"] == payload and sampled.content.text == payload


@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("credential", [CANARY, "os.getenv-" + CANARY, {"nested": [CANARY, 897263145, True, None]}, "x" * 2100 + CANARY])
def test_final_mcp_callback_formatted_log(sink, field, credential):
    data = {field: credential, "public_count": 7}
    original = copy.deepcopy(data)
    callback = mcp_tool.MCPServerTask._make_logging_callback(SimpleNamespace(name="synthetic"))
    asyncio.run(callback(SimpleNamespace(level="info", data=data, logger="synthetic")))
    output = sink.getvalue()
    assert CANARY not in output and "897263145" not in output
    assert "public_count" in output and data == original
    assert "MCP server log [synthetic/synthetic]" in output


@pytest.mark.parametrize("field", FIELDS)
def test_actual_auxiliary_auth_fallback_log_and_none_result(sink, monkeypatch, field):
    messages = [{"role": "user", "content": CANARY}]
    observed = []
    monkeypatch.setattr(auxiliary_client, "_fallback_entry_timeout", lambda *a: None)
    def build(label, model, live_messages, **kwargs):
        assert live_messages is messages
        return {"messages": live_messages}
    monkeypatch.setattr(auxiliary_client, "_build_call_kwargs", build)
    def fail(client, kwargs, **rest):
        observed.append(kwargs["messages"])
        raise RuntimeError("Error code: 401 " + json.dumps({field: CANARY}))
    monkeypatch.setattr(auxiliary_client, "_relay_sync_completion", fail)
    monkeypatch.setattr(auxiliary_client, "_auth_refresh_provider_for_route", lambda *a: "synthetic")
    monkeypatch.setattr(auxiliary_client, "_refresh_provider_credentials", lambda *a: False)
    unhealthy = []
    monkeypatch.setattr(auxiliary_client, "_mark_provider_unhealthy", unhealthy.append)
    result = auxiliary_client._call_fallback_candidate_sync(
        SimpleNamespace(base_url="https://example.invalid/"), "synthetic", "synthetic",
        task="compression", messages=messages, temperature=None, max_tokens=None,
        tools=None, effective_timeout=1, effective_extra_body={}, reasoning_config=None,
    )
    assert result is None and observed == [messages] and unhealthy == ["synthetic"]
    assert CANARY not in sink.getvalue() and "next fallback" in sink.getvalue()


@pytest.mark.parametrize("prefix", ["os.getenv-", "os.environ-", "process.env-", "$ENV{", "os.getenv('"])
def test_curator_diagnostic_copy_never_exempts_explicit_credential_fields(prefix):
    secret = prefix + CANARY
    args = {"password": {"nested": [secret, 897263145, False, None, ""]}, "public_count": 7}
    payload = {"llm_final": "public summary", "llm_summary": "public summary", "llm_error": None,
               "tool_calls": [{"name": "synthetic", "arguments": json.dumps(args)}],
               "consolidated": [], "pruned": [], "cron_rewrites": {}}
    original = copy.deepcopy(payload)
    result = curator._diagnostic_report_copy(payload)
    masked = json.loads(result["tool_calls"][0]["arguments"])
    assert payload == original and set(masked) == set(args) and masked["public_count"] == 7
    assert CANARY not in json.dumps(result) and "897263145" not in json.dumps(result)
    assert masked["password"]["nested"][1:] == [None, None, None, ""]


@pytest.mark.parametrize("text", ["Project status remains on schedule.", "token_count=7; primary_key=2112",
                                  "api_key=os.getenv('KEY')", 'note: "api_key": "$ENV{AUTH_TOKEN}"'])
def test_ordinary_conversation_and_code_references_survive(text):
    assert curator._redact_report_value(text) == text
    assert redact.redact_sensitive_text(text, force=True, code_file=True) == text


def test_ordinary_file_code_and_navigation_remain_usable():
    code = 'MY_API_KEY=os.getenv("KEY"); MAX_TOKENS=100; fixture={"password":"test"}'
    assert redact.redact_sensitive_text(code, force=True, code_file=True) == code
    assert redact.redact_sensitive_text(code, force=True, file_read=True) == code
    url = "https://example.invalid/callback?token=roundtrip&topic=public"
    assert redact.redact_sensitive_text(url, force=True) == url


@pytest.mark.parametrize("field", FIELDS)
def test_formatter_masks_typed_and_escaped_json_credential_values(field):
    value = {field: {"values": ['os.getenv-' + CANARY + '\"\\tail', 897263145, True, None, ""]}, "public_count": 7}
    raw = json.dumps(value)
    record = logging.LogRecord("synthetic", logging.INFO, "synthetic", 1, "diagnostic: %s", (raw,), None)
    emitted = redact.RedactingFormatter("%(message)s").format(record)
    parsed = json.loads(emitted.removeprefix("diagnostic: "))
    assert CANARY not in emitted and "897263145" not in emitted
    assert parsed["public_count"] == 7 and parsed[field]["values"][1:] == [None, None, None, ""]
    assert record.getMessage() == "diagnostic: " + raw


def test_formatter_masks_truncated_credential_value():
    raw = 'error: {"private_key": "' + CANARY + '... [truncated]'
    record = logging.LogRecord("synthetic", logging.INFO, "synthetic", 1, raw, (), None)
    assert CANARY not in redact.RedactingFormatter("%(message)s").format(record)


@pytest.mark.parametrize("payload", CASES)
def test_reviewed_bypass_forms_reach_callback_and_auxiliary_final_logs(sink, monkeypatch, payload):
    callback = mcp_tool.MCPServerTask._make_logging_callback(SimpleNamespace(name="synthetic"))
    asyncio.run(callback(SimpleNamespace(level="info", data=payload, logger="synthetic")))
    assert CANARY not in sink.getvalue()
    sink.seek(0)
    sink.truncate(0)
    messages = [{"role": "user", "content": CANARY}]
    monkeypatch.setattr(auxiliary_client, "_fallback_entry_timeout", lambda *a: None)
    monkeypatch.setattr(auxiliary_client, "_build_call_kwargs", lambda *a, **kw: {"messages": messages})
    def fail(client, kwargs, **rest):
        assert kwargs["messages"] is messages
        raise RuntimeError("Error code: 401 " + payload)
    monkeypatch.setattr(auxiliary_client, "_relay_sync_completion", fail)
    monkeypatch.setattr(auxiliary_client, "_auth_refresh_provider_for_route", lambda *a: "synthetic")
    monkeypatch.setattr(auxiliary_client, "_refresh_provider_credentials", lambda *a: False)
    unhealthy = []
    monkeypatch.setattr(auxiliary_client, "_mark_provider_unhealthy", unhealthy.append)
    result = auxiliary_client._call_fallback_candidate_sync(
        SimpleNamespace(base_url="https://example.invalid/"), "synthetic", "synthetic",
        task="compression", messages=messages, temperature=None, max_tokens=None,
        tools=None, effective_timeout=1, effective_extra_body={}, reasoning_config=None,
    )
    assert result is None and unhealthy == ["synthetic"]
    assert CANARY not in sink.getvalue() and "next fallback" in sink.getvalue()


def test_long_secret_free_identifier_final_formatter_is_linear():
    import time
    text = "a" * 20000 + "=public"
    record = logging.LogRecord("synthetic", logging.INFO, "synthetic", 1, text, (), None)
    start = time.perf_counter()
    assert redact.RedactingFormatter("%(message)s").format(record) == text
    # The reviewed quadratic scan took ~0.7s at 4k and >10s at this size.
    assert time.perf_counter() - start < 1.0


@pytest.mark.parametrize("payload", [
    r'{"pass\u0077ord":{"nested":["' + CANARY + '",123]},"public":7}',
    r'{"client\u0053ecret":"' + CANARY + '","public":7}',
])
def test_decoded_json_keys_preserve_complete_public_boundaries(payload):
    record = logging.LogRecord("synthetic", logging.INFO, "synthetic", 1, payload, (), None)
    output = redact.RedactingFormatter("%(message)s").format(record)
    result = json.loads(output)
    assert result["public"] == 7 and CANARY not in output and "123" not in output


@pytest.mark.parametrize("payload", [
    'password="first ' + CANARY,
    "password='first " + CANARY,
    'password="first\\" ' + CANARY,
    'password="first"' + CANARY,
    'password=first" ' + CANARY,
])
def test_unterminated_and_ambiguous_assignment_quotes_fail_closed_at_actual_sinks(sink, monkeypatch, payload):
    test_final_mcp_tool_json_and_sampling_text(sink, monkeypatch, payload)
    callback = mcp_tool.MCPServerTask._make_logging_callback(SimpleNamespace(name="synthetic"))
    asyncio.run(callback(SimpleNamespace(level="info", data=payload, logger="synthetic")))
    assert CANARY not in sink.getvalue()
    sink.seek(0)
    sink.truncate(0)
    messages = [{"role": "user", "content": CANARY}]
    monkeypatch.setattr(auxiliary_client, "_fallback_entry_timeout", lambda *a: None)
    monkeypatch.setattr(auxiliary_client, "_build_call_kwargs", lambda *a, **kw: {"messages": messages})
    def fail(client, kwargs, **rest):
        assert kwargs["messages"] is messages
        raise RuntimeError("Error code: 401 " + payload)
    monkeypatch.setattr(auxiliary_client, "_relay_sync_completion", fail)
    monkeypatch.setattr(auxiliary_client, "_auth_refresh_provider_for_route", lambda *a: "synthetic")
    monkeypatch.setattr(auxiliary_client, "_refresh_provider_credentials", lambda *a: False)
    unhealthy = []
    monkeypatch.setattr(auxiliary_client, "_mark_provider_unhealthy", unhealthy.append)
    result = auxiliary_client._call_fallback_candidate_sync(
        SimpleNamespace(base_url="https://example.invalid/"), "synthetic", "synthetic",
        task="compression", messages=messages, temperature=None, max_tokens=None,
        tools=None, effective_timeout=1, effective_extra_body={}, reasoning_config=None,
    )
    assert result is None and unhealthy == ["synthetic"] and CANARY not in sink.getvalue()


@pytest.mark.parametrize("text", [
    'public="first public text"; token_count=7; primary_key=2112; require_auth=true',
    'Secretary="public value"; tokenizer=public; COUNT=7',
])
def test_quoted_public_values_and_operational_metadata_remain_intact(text):
    record = logging.LogRecord("synthetic", logging.INFO, "synthetic", 1, text, (), None)
    assert redact.RedactingFormatter("%(message)s").format(record) == text


def test_complete_quoted_assignment_preserves_public_suffix_and_log_record():
    text = 'password="first \\"escaped\\" ' + CANARY + '"; public_count=7'
    record = logging.LogRecord("synthetic", logging.INFO, "synthetic", 1, text, (), None)
    output = redact.RedactingFormatter("%(message)s").format(record)
    assert CANARY not in output and "public_count=7" in output and record.getMessage() == text
