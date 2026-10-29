"""Untrusted RPC diagnostics are escaped without changing dispatch or wire IDs."""

import asyncio
import json
import logging

import pytest

from tui_gateway import server
from tui_gateway import ws as ws_mod


@pytest.mark.parametrize("branch", ["response_failed", "crash_failed", "crash_replied"])
@pytest.mark.parametrize("structured_id", [False, True])
def test_rpc_diagnostics_escape_and_bound_client_fields(monkeypatch, branch, structured_id):
    private_display = "normal\nFORGED-RPC\ttrace\rsecond\x00" + "Z" * 256
    req_id = {"nested": private_display} if structured_id else private_display
    request = {"jsonrpc": "2.0", "id": req_id, "method": private_display}
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0)
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_live_transports", set())
    monkeypatch.setattr(server, "_ensure_skin_watcher", lambda: None)
    monkeypatch.setattr(server, "_release_wake_for_transport", lambda transport: False)
    actual_dispatch = server.dispatch
    dispatched = []

    def dispatch(req, transport):
        dispatched.append(req)
        if branch.startswith("crash"):
            raise RuntimeError("isolated dispatch failure")
        return actual_dispatch(req, transport)

    monkeypatch.setattr(server, "dispatch", dispatch)
    wire = []

    class LocalSocket:
        async def accept(self):
            pass

        async def send_text(self, line):
            frame = json.loads(line)
            wire.append(frame)
            if "error" in frame and branch != "crash_replied":
                raise ConnectionError("isolated closed peer")

        async def receive_text(self):
            if dispatched:
                raise ws_mod._WebSocketDisconnect()
            return json.dumps(request)

        async def close(self):
            pass

    messages = []

    class Capture(logging.Handler):
        def emit(self, record):
            message = record.getMessage()
            if "id=" in message and "method=" in message:
                messages.append(message)

    capture = Capture()
    ws_mod._log.addHandler(capture)
    try:
        asyncio.run(ws_mod.handle_ws(LocalSocket()))
    finally:
        ws_mod._log.removeHandler(capture)
        capture.close()
    assert dispatched == [request]
    replies = [frame for frame in wire if "error" in frame]
    assert len(replies) == 1
    assert replies[0]["id"] == req_id
    if branch == "response_failed":
        assert replies[0]["error"]["code"] == -32601
        assert private_display in replies[0]["error"]["message"]
    else:
        assert replies[0]["error"]["code"] == -32603
    assert len(messages) == (2 if branch == "crash_failed" else 1)
    for message in messages:
        assert len(message.splitlines()) == 1
        assert "FORGED-RPC" in message
        assert not any(control in message for control in ("\r", "\t", "\x00"))
        assert "Z" * 129 not in message


def test_normal_close_reason_cannot_forge_diagnostic_line(monkeypatch):
    reason = "normal\nFORGED-CLOSE\ttrace\rsecond\x00"
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0)
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_live_transports", set())
    monkeypatch.setattr(server, "_ensure_skin_watcher", lambda: None)
    released = []
    monkeypatch.setattr(server, "_release_wake_for_transport", lambda transport: released.append(transport))
    closed = []

    class LocalSocket:
        async def accept(self):
            pass

        async def send_text(self, line):
            assert json.loads(line)["params"]["type"] == "gateway.ready"

        async def receive_text(self):
            raise ws_mod._WebSocketDisconnect(code=1000, reason=reason)

        async def close(self):
            closed.append(True)

    messages = []

    class Capture(logging.Handler):
        def emit(self, record):
            if record.getMessage().startswith("ws closed"):
                messages.append(record.getMessage())

    capture = Capture()
    previous_level = ws_mod._log.level
    ws_mod._log.setLevel(logging.INFO)
    ws_mod._log.addHandler(capture)
    try:
        asyncio.run(ws_mod.handle_ws(LocalSocket()))
    finally:
        ws_mod._log.removeHandler(capture)
        ws_mod._log.setLevel(previous_level)
        capture.close()
    assert closed == [True]
    assert len(released) == 1
    assert not server._live_transports
    assert len(messages) == 1
    assert len(messages[0].splitlines()) == 1
    assert "\\nFORGED-CLOSE\\ttrace\\rsecond\\x00" in messages[0]
    assert not any(control in messages[0] for control in ("\r", "\t", "\x00"))
