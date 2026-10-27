"""Exercise actual child fd writes with disposable credentials and no network."""

import asyncio
import io
import json
import os
import subprocess
import sys
import threading
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from tools.mcp_stderr import MAX_STDERR_LINE_BYTES, RedactedStderrLog


def _child(capture, script, cwd):
    return subprocess.run(
        [sys.executable, "-c", script], stderr=capture, stdout=subprocess.PIPE,
        check=True, timeout=10, cwd=cwd,
    )


def test_child_stderr_redaction_keeps_stdout_jsonrpc_and_split_credentials(tmp_path, monkeypatch):
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", False)
    path = tmp_path / "mcp-stderr.log"
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    private_body_lines = private_key.decode("ascii").splitlines()[1:-1]
    capture = RedactedStderrLog(path)
    try:
        capture.write("starting server API_KEY=headerCanaryPrivate\n")
        result = _child(capture, """
import os, time
os.write(1, b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\\n')
os.write(2, b'diagnostic before\\nAuthorization: Bear')
time.sleep(0.02)
os.write(2, b'er opaqueCanaryPrivateValue\\n')
os.write(2, b'API_KEY=sk-proj-')
time.sleep(0.02)
os.write(2, b'prefixCanaryRandomBytes123456\\n')
os.write(2, b'GET /oauth?code=callbackCanaryPrivate HTTP/1.1\\n')
os.write(2, {private_key!r})
os.write(2, b'diagnostic after\\n')
os.write(2, 'utf8: caf\u00e9\\n'.encode())
os.write(2, b'final diagnostic without newline')
""".replace("{private_key!r}", repr(private_key)), tmp_path)
    finally:
        capture.close()
    assert json.loads(result.stdout) == {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    text = path.read_text(encoding="utf-8")
    for secret in (
        "headerCanaryPrivate", "opaqueCanaryPrivateValue", "prefixCanaryRandomBytes123456",
        "callbackCanaryPrivate", *private_body_lines,
    ):
        assert secret not in text
    assert "diagnostic before" in text
    assert "diagnostic after" in text
    assert "caf\u00e9" in text
    assert "[REDACTED PRIVATE KEY]" in text
    assert text.endswith("final diagnostic without newline")
    assert capture.error is None
    assert capture.closed and not capture._thread.is_alive()


def test_oversized_lines_omit_remaining_pipe(tmp_path):
    path = tmp_path / "mcp-stderr.log"
    capture = RedactedStderrLog(path)
    try:
        _child(capture, f"""
import os
os.write(2, b'oversized-head-canary ' + b'x' * {MAX_STDERR_LINE_BYTES})
os.write(2, b' oversized-tail-canary\\nordinary next diagnostic\\n')
""", tmp_path)
    finally:
        capture.close()
    text = path.read_text(encoding="utf-8")
    assert "oversized-head-canary" not in text
    assert "oversized-tail-canary" not in text
    assert "oversized line omitted" in text
    assert "ordinary next diagnostic" not in text
    assert len(text) < 200


def test_shared_capture_reconnects_do_not_grow_threads_and_close_is_idempotent(tmp_path):
    path = tmp_path / "mcp-stderr.log"
    baseline = set(threading.enumerate())
    capture = RedactedStderrLog(path)
    try:
        for index in range(4):
            _child(capture, f"import os; os.write(2, b'reconnect-{index}\\n')", tmp_path)
            assert set(threading.enumerate()) - baseline == {capture._thread}
    finally:
        start = time.monotonic()
        capture.close()
        capture.close()
    assert time.monotonic() - start < 2
    assert set(threading.enumerate()) == baseline
    assert path.read_text(encoding="utf-8").splitlines() == [f"reconnect-{i}" for i in range(4)]


@pytest.mark.parametrize("failure", ["sink", "redactor"])
def test_log_write_failure_drains_child_without_raw_fallback(tmp_path, monkeypatch, caplog, failure):
    class FailingSink(io.StringIO):
        name = str(tmp_path / "mcp-stderr.log")

        def write(self, _text):
            raise OSError("synthetic disk failure")

    if failure == "sink":
        sink = FailingSink()
        monkeypatch.setattr("tools.mcp_stderr._open_log", lambda _path: sink)
    else:
        def fail_redaction(*_args, **_kwargs):
            raise RuntimeError("synthetic redactor failure")

        monkeypatch.setattr("tools.mcp_stderr.redact_sensitive_text", fail_redaction)
    capture = RedactedStderrLog(tmp_path / "mcp-stderr.log")
    try:
        result = _child(capture, """
import os
for i in range(100):
    os.write(2, b'API_KEY=failedSinkCanaryPrivate\\n' + b'x' * 4096 + b'\\n')
os.write(1, b'{"jsonrpc":"2.0","id":1,"result":true}\\n')
""", tmp_path)
    finally:
        capture.close()
    assert json.loads(result.stdout)["result"] is True
    assert capture.error == "MCP stderr capture failed; output omitted"
    assert [record.message for record in caplog.records if record.name == "tools.mcp_stderr"] == [
        "MCP stderr capture failed; child diagnostics discarded",
    ]
    path = tmp_path / "mcp-stderr.log"
    assert not path.exists() or path.read_text(encoding="utf-8") == ""
    assert not capture._thread.is_alive()


@pytest.mark.skipif(os.name != "posix", reason="POSIX file mode / no-follow contract")
def test_sink_is_owner_only_and_does_not_follow_symlinks(tmp_path):
    path = tmp_path / "mcp-stderr.log"
    path.touch(mode=0o666)
    capture = RedactedStderrLog(path)
    try:
        assert path.stat().st_mode & 0o777 == 0o600
    finally:
        capture.close()
    target = tmp_path / "target"
    target.write_text("unchanged")
    link = tmp_path / "linked-log"
    link.symlink_to(target)
    candidate = None
    try:
        with pytest.raises(OSError, match="symlink"):
            candidate = RedactedStderrLog(link)
    finally:
        if candidate is not None:
            candidate.close()
    assert target.read_text() == "unchanged"


@pytest.mark.parametrize("close_failure", [False, True])
def test_shared_factory_closes_capture_if_fd_validation_fails(monkeypatch, close_failure):
    from tools import mcp_tool

    class FailingCapture:
        closed = False

        def fileno(self):
            raise OSError("synthetic descriptor failure")

        def close(self):
            self.closed = True
            if close_failure:
                raise OSError("synthetic cleanup failure")

    created = []

    def create(_path):
        capture = FailingCapture()
        created.append(capture)
        return capture

    previous = mcp_tool._mcp_stderr_log_fh
    with monkeypatch.context() as patch:
        patch.setattr(mcp_tool, "_mcp_stderr_log_fh", None)
        patch.setattr("tools.mcp_stderr.RedactedStderrLog", create)
        fallback = mcp_tool._get_mcp_stderr_log()
        try:
            assert len(created) == 1 and created[0].closed
            assert fallback.name == os.devnull
        finally:
            mcp_tool._close_mcp_stderr_log()
        assert fallback.closed
    assert mcp_tool._mcp_stderr_log_fh is previous


def test_shared_factory_fails_to_devnull_and_never_tty(tmp_path, monkeypatch):
    from tools import mcp_tool

    monkeypatch.setattr(mcp_tool, "_mcp_stderr_log_fh", None)
    monkeypatch.setattr("tools.mcp_stderr.RedactedStderrLog", lambda _path: (_ for _ in ()).throw(OSError()))
    capture = mcp_tool._get_mcp_stderr_log()
    try:
        assert capture is not sys.stderr
        assert capture.name == os.devnull
        assert isinstance(capture.fileno(), int)
    finally:
        mcp_tool._close_mcp_stderr_log()


def test_shared_factory_reuses_one_pump_and_redacts_server_headers(tmp_path, monkeypatch):
    from tools import mcp_tool
    from youtab_constants import get_youtab_home

    monkeypatch.setattr(mcp_tool, "_mcp_stderr_log_fh", None)
    capture = mcp_tool._get_mcp_stderr_log()
    path = get_youtab_home() / "logs" / "mcp-stderr.log"
    try:
        for _ in range(4):
            assert mcp_tool._get_mcp_stderr_log() is capture
            mcp_tool._write_stderr_log_header("API_KEY=serverHeaderCanaryPrivate")
        _child(capture, "import os; os.write(2,b'factory diagnostic\\n')", tmp_path)
    finally:
        mcp_tool._close_mcp_stderr_log()
    assert "serverHeaderCanaryPrivate" not in path.read_text(encoding="utf-8")
    assert "factory diagnostic" in path.read_text(encoding="utf-8")
    assert capture.closed and not capture._thread.is_alive()


def test_real_sdk_stdio_transport_preserves_frames_and_child_cleanup(tmp_path):
    pytest.importorskip("mcp")
    from mcp import StdioServerParameters
    from mcp.client.stdio import stdio_client

    path = tmp_path / "sdk-stderr.log"
    capture = RedactedStderrLog(path)
    script = """
import os, sys
os.write(2, b'sdk startup API_KEY=sdkCanaryPrivate\\n')
os.write(1, b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\\n')
sys.stdin.buffer.read()
os.write(2, b'sdk clean exit\\n')
"""

    async def drive():
        params = StdioServerParameters(command=sys.executable, args=["-c", script], cwd=str(tmp_path))
        async with stdio_client(params, errlog=capture) as (read, _write):
            packet = await asyncio.wait_for(read.receive(), timeout=5)
            assert packet.message.root.result == {"ok": True}

    try:
        asyncio.run(drive())
    finally:
        capture.close()
    text = path.read_text(encoding="utf-8")
    assert "sdkCanaryPrivate" not in text
    assert "sdk startup" in text
    assert "sdk clean exit" in text
    assert not capture._thread.is_alive()


@pytest.mark.parametrize("credential, expected", [
    (831427951, None),
    (True, None),
    ({"inner": "nestedObjectOpaqueCanary", "count": 724813},
     {"inner": "«redacted-secret»", "count": None}),
    (["listOpaqueCanary", {"nested": ["deepOpaqueCanary", False]}],
     ["«redacted-secret»", {"nested": ["«redacted-secret»", None]}]),
    ("os.environ.get('OPAQUE_CODE_LOOKUP_CANARY')", "«redacted-secret»"),
])
def test_child_and_header_json_credential_values_are_redacted_on_disk(
    tmp_path, monkeypatch, credential, expected,
):
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", False)
    path = tmp_path / "strict-json-stderr.log"
    diagnostic = {"password": credential, "message": "ordinary diagnostic", "attempt": 2}
    payload = json.dumps(diagnostic, ensure_ascii=False)
    capture = RedactedStderrLog(path)
    try:
        capture.write(payload + "\n")
        result = _child(capture, f"""
import os
os.write(1, b'{{"jsonrpc":"2.0","id":2,"result":true}}\\n')
os.write(2, {(payload + chr(10)).encode('utf-8')!r})
""", tmp_path)
    finally:
        capture.close()
    assert json.loads(result.stdout) == {"jsonrpc": "2.0", "id": 2, "result": True}
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    for line in lines:
        assert json.loads(line) == {
            "password": expected, "message": "ordinary diagnostic", "attempt": 2,
        }
    assert capture.error is None
    assert capture.closed and not capture._thread.is_alive()


def test_child_escaped_json_credential_key_and_value_are_redacted_on_disk(tmp_path, monkeypatch):
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", False)
    path = tmp_path / "escaped-json-stderr.log"
    payload = r'{"pass\u0077ord": ["escaped\u004fpaqueCanary", {"inner": "deepEscapedCanary"}], "message": "ordinary escaped diagnostic", "attempt": 3}'
    capture = RedactedStderrLog(path)
    try:
        result = _child(capture, f"""
import os
os.write(1, b'{{"jsonrpc":"2.0","id":3,"result":true}}\\n')
os.write(2, {(payload + chr(10)).encode('utf-8')!r})
""", tmp_path)
    finally:
        capture.close()
    assert json.loads(result.stdout) == {"jsonrpc": "2.0", "id": 3, "result": True}
    text = path.read_text(encoding="utf-8")
    assert "Canary" not in text
    assert json.loads(text) == {
        "password": ["«redacted-secret»", {"inner": "«redacted-secret»"}],
        "message": "ordinary escaped diagnostic", "attempt": 3,
    }
    assert capture.error is None
    assert capture.closed and not capture._thread.is_alive()


@pytest.mark.parametrize("opener", [
    'API_KEY=\n', 'password="\n', '{"password": {\n',
    '{"pass\\u0077ord": [\n', 'Authorization: Bearer\n',
    'password: |-\n', 'Proxy-Authorization: Basic\n',
    "'password': >-\n",
])
def test_partial_credentials_omit_remaining_pipe_without_changing_stdout(tmp_path, opener):
    path = tmp_path / "partial.log"
    capture = RedactedStderrLog(path)
    payload = ('public before\n' + opener + 'unnamedOpaqueCanary\npublic after\n').encode()
    try:
        result = _child(capture, f"import os; os.write(2, {payload!r}); os.write(1, b'{{\"result\":true}}\\n')", tmp_path)
    finally:
        capture.close()
    text = path.read_text(encoding="utf-8")
    assert "public before" in text
    assert "unnamedOpaqueCanary" not in text
    assert "public after" not in text
    assert "credential diagnostic omitted" in text
    assert json.loads(result.stdout) == {"result": True}


def test_oversized_discarded_tail_cannot_hide_private_key_opener(tmp_path):
    path = tmp_path / "oversized-key.log"
    capture = RedactedStderrLog(path)
    opener = b"-----BEGIN " + b"PRIVATE KEY-----"
    try:
        _child(capture, f"import os; os.write(2, b'x' * {MAX_STDERR_LINE_BYTES + 8192} + {opener!r} + b'\\nprivateBodyOpaqueCanary\\n')", tmp_path)
    finally:
        capture.close()
    assert "privateBodyOpaqueCanary" not in path.read_text(encoding="utf-8")


def test_capture_limit_preserves_existing_log_and_drains_child(tmp_path, monkeypatch):
    import tools.mcp_stderr as module

    monkeypatch.setattr(module, "MAX_STDERR_LOG_BYTES", 256)
    path = tmp_path / "bounded.log"
    original = "preserved previous diagnostic\n"
    path.write_text(original, encoding="utf-8")
    capture = RedactedStderrLog(path)
    try:
        result = _child(capture, "import os; os.write(2, b'ordinary line\\n' * 1000); os.write(1, b'{\"result\":true}\\n')", tmp_path)
    finally:
        capture.close()
    assert path.stat().st_size <= 256
    assert path.read_text(encoding="utf-8").startswith(original)
    assert "capture limit reached" in path.read_text(encoding="utf-8")
    assert json.loads(result.stdout) == {"result": True}
    assert not capture._thread.is_alive()


def test_partial_header_omits_following_child_and_preserves_public_metadata(tmp_path):
    path = tmp_path / "header.log"
    capture = RedactedStderrLog(path)
    try:
        capture.write('token_count=4 session_id=visible primary_key=visible require_auth=True\n')
        capture.write('password="\n')
        _child(capture, "import os; os.write(2, b'headerContinuationCanary\\n')", tmp_path)
    finally:
        capture.close()
    text = path.read_text(encoding="utf-8")
    assert "token_count=4 session_id=visible primary_key=visible require_auth=True" in text
    assert "headerContinuationCanary" not in text
    assert capture.error == "MCP stderr ambiguous credential record; output omitted"


def test_already_oversized_history_is_preserved_without_growth(tmp_path, monkeypatch):
    import tools.mcp_stderr as module

    monkeypatch.setattr(module, "MAX_STDERR_LOG_BYTES", 256)
    path = tmp_path / "old.log"
    original = b"preserved history " * 32
    path.write_bytes(original)
    capture = RedactedStderrLog(path)
    try:
        capture.write("new diagnostic\n")
        _child(capture, "import os; os.write(2, b'new child diagnostic\\n' * 100)", tmp_path)
    finally:
        capture.close()
    assert path.read_bytes() == original
    assert capture.error == "MCP stderr capture limit reached; output omitted"


def test_split_utf8_is_preserved_and_capture_limit_counts_bytes(tmp_path, monkeypatch):
    import tools.mcp_stderr as module

    monkeypatch.setattr(module, "MAX_STDERR_LOG_BYTES", 256)
    path = tmp_path / "utf8.log"
    capture = RedactedStderrLog(path)
    try:
        _child(capture, "import os, time; os.write(2, b'caf\\xc3'); time.sleep(.02); os.write(2, b'\\xa9\\n')", tmp_path)
    finally:
        capture.close()
    capture = RedactedStderrLog(path)
    try:
        capture.write("\u6f22\u5b57" * 100 + "\n")
    finally:
        capture.close()
    assert path.stat().st_size <= 256
    text = path.read_text(encoding="utf-8")
    assert "caf\u00e9" in text
    assert "\ufffd" not in text
    assert "capture limit reached" in text
