import asyncio
import concurrent.futures
import json
import logging
import threading
import time
from types import SimpleNamespace

import pytest

from youtab_agent_cli import mcp_startup
from tui_gateway import server
from tui_gateway import ws as ws_mod


@pytest.mark.parametrize("method,params", [
    ("config.set", {"key": "model", "value": "private-engine"}),
    ("session.create", {"model": "private-engine"}),
    ("session.create", {"provider": "private-provider"}),
    ("model.save_key", {"slug": "provider", "api_key": "synthetic-key"}),
    ("model.disconnect", {"slug": "provider"}),
    ("reload.env", {}),
    ("model.options", {}),
    ("config.show", {}),
    ("config.get", {"key": "provider"}),
    ("config.get", {"key": "full"}),
    ("slash.exec", {"command": "/MODEL private-engine"}),
    ("slash.exec", {"command": "/codex_runtime on"}),
    ("command.dispatch", {"name": "moa", "arg": "synthetic prompt"}),
    ("command.dispatch", {"name": "config"}),
    ("command.dispatch", {"name": "reload"}),
])
def test_hosted_rpc_private_operations_keep_http_scope(monkeypatch, method, params):
    from youtab_agent_cli import web_server
    from youtab_agent_cli.authz import ROLE_SCOPES, Principal, Role

    user = Principal("synthetic-user", "synthetic-org", scopes=ROLE_SCOPES[Role.NORMAL_USER])
    owner = Principal("synthetic-owner", "", Role.YOUTAB_OWNER, ROLE_SCOPES[Role.YOUTAB_OWNER])
    assert not web_server._gateway_rpc_allowed(user, method, params)
    assert web_server._gateway_rpc_allowed(owner, method, params)


@pytest.mark.parametrize("method,params", [
    ("session.list", {}),
    ("session.create", {}),
    ("prompt.submit", {"text": "synthetic prompt"}),
    ("skills.manage", {"action": "list"}),
    ("plugins.list", {}),
    ("tools.configure", {"action": "enable", "names": ["browser"]}),
    ("config.set", {"key": "skin", "value": "default"}),
    # Existing HTTP policy permits approvals under config:write. The repair
    # does not invent a new operator-only permission for this setting.
    ("config.set", {"key": "approvals.mode", "value": "manual"}),
    ("command.dispatch", {"name": "help"}),
])
def test_hosted_rpc_preserves_ordinary_user_capabilities(method, params):
    from youtab_agent_cli import web_server
    from youtab_agent_cli.authz import ROLE_SCOPES, Principal, Role

    user = Principal("synthetic-user", "synthetic-org", scopes=ROLE_SCOPES[Role.NORMAL_USER])
    assert web_server._gateway_rpc_allowed(user, method, params)


def test_hosted_rpc_engine_scope_matches_http_for_scoped_operator():
    from youtab_agent_cli import web_server
    from youtab_agent_cli.authz import ENGINE_SELECT, WS_SCOPE, Principal, Role

    operator = Principal("synthetic-operator", "", Role.YOUTAB_OPERATOR,
                         frozenset({WS_SCOPE, ENGINE_SELECT}))
    assert web_server._gateway_rpc_allowed(operator, "config.set", {"key": "model"})
    assert not web_server._gateway_rpc_allowed(operator, "model.save_key", {})
    assert not web_server._gateway_rpc_allowed(operator, "unregistered.operation", {})


@pytest.mark.parametrize("gated", [False, True])
def test_gateway_route_binds_rpc_policy_only_for_gated_socket(monkeypatch, gated):
    from youtab_agent_cli import web_server
    from youtab_agent_cli.authz import ROLE_SCOPES, Principal, Role

    user = Principal("synthetic-user", "synthetic-org", scopes=ROLE_SCOPES[Role.NORMAL_USER])
    captured = []

    async def handle(ws, **kwargs):
        captured.append(kwargs.get("authorize_rpc"))

    monkeypatch.setattr(web_server, "_DASHBOARD_EMBEDDED_CHAT_ENABLED", True)
    monkeypatch.setattr(web_server, "_ws_auth_ok", lambda ws: True)
    monkeypatch.setattr(web_server, "_ws_request_is_allowed", lambda ws: True)
    monkeypatch.setattr(web_server, "resolve_principal", lambda **kwargs: user)
    monkeypatch.setattr(ws_mod, "handle_ws", handle)
    socket = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(auth_required=gated)),
        state=SimpleNamespace(ws_user_id=user.user_id),
    )
    asyncio.run(web_server.gateway_ws(socket))
    assert len(captured) == 1
    if gated:
        assert not captured[0]("config.set", {"key": "model"})
        assert captured[0]("session.list", {})
    else:
        assert captured[0] is None


def test_ws_refuses_rpc_before_dispatch_and_keeps_connection(monkeypatch):
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_ensure_skin_watcher", lambda: None)
    frames = []
    dispatched = []
    pending = iter([
        {"id": 1, "method": "config.set", "params": {"key": "model"}},
        {"id": 2, "method": "session.list"},
        {"id": 3, "method": "session.list", "params": []},
    ])

    def dispatch(req, transport):
        dispatched.append(req)
        return {"jsonrpc": "2.0", "id": req["id"], "result": {"sessions": []}}

    class Socket:
        async def accept(self):
            pass

        async def send_text(self, line):
            frames.append(json.loads(line))

        async def receive_text(self):
            try:
                return json.dumps(next(pending))
            except StopIteration:
                raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    monkeypatch.setattr(server, "dispatch", dispatch)
    asyncio.run(ws_mod.handle_ws(
        Socket(), authorize_rpc=lambda method, params: method == "session.list",
    ))
    assert [request["id"] for request in dispatched] == [2]
    replies = {frame["id"]: frame for frame in frames if "id" in frame}
    assert replies[1]["error"]["code"] == -32003
    assert replies[2]["result"] == {"sessions": []}
    assert replies[3]["error"]["code"] == -32602


def test_ws_authorizer_failure_is_denied_not_dispatched(monkeypatch):
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_ensure_skin_watcher", lambda: None)
    frames = []
    received = False

    def refuse(method, params):
        raise ValueError("synthetic unusable authority")

    def dispatch(req, transport):
        raise AssertionError("denied request reached a handler")

    class Socket:
        async def accept(self):
            pass

        async def send_text(self, line):
            frames.append(json.loads(line))

        async def receive_text(self):
            nonlocal received
            if received:
                raise ws_mod._WebSocketDisconnect()
            received = True
            return json.dumps({"id": 1, "method": "config.set", "params": {}})

        async def close(self):
            pass

    monkeypatch.setattr(server, "dispatch", dispatch)
    asyncio.run(ws_mod.handle_ws(Socket(), authorize_rpc=refuse))
    assert frames[-1]["error"]["code"] == -32003


def test_ws_malformed_payload_is_not_logged(monkeypatch, caplog):
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_ensure_skin_watcher", lambda: None)
    received = False
    private = 'sk-synthetic-secret private customer prompt'
    frames = []

    class Socket:
        async def accept(self):
            pass

        async def send_text(self, line):
            frames.append(json.loads(line))

        async def receive_text(self):
            nonlocal received
            if received:
                raise ws_mod._WebSocketDisconnect()
            received = True
            return '{"api_key":"' + private + '",invalid}'

        async def close(self):
            pass

    with caplog.at_level(logging.WARNING, logger=ws_mod.__name__):
        asyncio.run(ws_mod.handle_ws(Socket()))
    assert frames[-1]["error"]["code"] == -32700
    assert "ws parse error" in caplog.text
    assert "chars=" in caplog.text and "position=" in caplog.text
    assert private not in caplog.text
    assert '"api_key"' not in caplog.text




def _run_disconnect(monkeypatch, seed):
    """Drive handle_ws to its disconnect `finally`, seeding sessions against the
    live WSTransport the moment it exists. Returns nothing; inspect _sessions."""
    # Disable the grace-reap Timer: detached sessions normally schedule a
    # threading.Timer via _schedule_ws_orphan_reap, which would outlive the test
    # and fire _reap during interpreter teardown — touching _sessions/DB and
    # producing spurious post-run errors under the per-file CI runner. Grace=0
    # short-circuits the Timer (see _schedule_ws_orphan_reap) so the test leaves
    # no lingering thread.
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0)

    # Mirror the real _finalize_session chokepoint: it is the single place that
    # closes the slash-worker (#38095). Stub it but keep that behavior so the
    # disconnect-reap path still exercises worker teardown.
    def _fake_finalize(s, end_reason="tui_close"):
        w = s.get("slash_worker")
        if w:
            w.close()

    monkeypatch.setattr(server, "_finalize_session", _fake_finalize)

    created = []
    real_transport = ws_mod.WSTransport
    monkeypatch.setattr(
        ws_mod, "WSTransport",
        lambda ws, loop, **kw: created.append(real_transport(ws, loop, **kw)) or created[-1],
    )

    class FakeWS:
        async def accept(self):
            pass

        async def send_text(self, line):
            pass

        async def receive_text(self):
            seed(created[0])  # transport now exists; attach it to sessions
            raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    asyncio.run(ws_mod.handle_ws(FakeWS()))


def test_ws_disconnect_reaps_flagged_session_and_closes_worker(monkeypatch):
    closed = []

    class FakeWorker:
        def close(self):
            closed.append(True)

    server._sessions.clear()
    try:
        _run_disconnect(
            monkeypatch,
            lambda t: server._sessions.update(
                flagged={
                    "transport": t,
                    "close_on_disconnect": True,
                    "slash_worker": FakeWorker(),
                    "session_key": "k",
                }
            ),
        )
        assert "flagged" not in server._sessions
        assert closed == [True]
    finally:
        server._sessions.clear()




def test_ws_connection_registers_then_disconnect_unregisters_live_transport(monkeypatch):
    """A connected client must be tracked in the live-transport registry so a
    session-less global broadcast (skin.changed from the background watcher)
    reaches it, and dropped on disconnect so no stale write targets a dead peer.
    This is the WS half of the cross-surface live-theme fix."""
    server._sessions.clear()
    server._live_transports.clear()
    seen = {}
    try:
        _run_disconnect(
            monkeypatch,
            lambda t: seen.__setitem__("registered", t in server._live_transports),
        )
        # Seeded at receive_text time — i.e. after gateway.ready registered it.
        assert seen["registered"] is True
        # handle_ws's finally must have unregistered it.
        assert not server._live_transports
    finally:
        server._sessions.clear()
        server._live_transports.clear()


def test_ws_disconnect_releases_wake_word_owner(monkeypatch):
    released = []
    created = []
    monkeypatch.setattr(
        server,
        "_release_wake_for_transport",
        lambda transport: released.append(transport) or True,
    )

    _run_disconnect(monkeypatch, lambda transport: created.append(transport))

    assert released == created




def test_ws_starts_mcp_discovery_before_ready(monkeypatch):
    import tui_gateway.entry as entry

    calls = []
    events = []

    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0)
    monkeypatch.setattr(entry, "ensure_mcp_discovery_started", lambda: calls.append("mcp"))

    class FakeWS:
        async def accept(self):
            events.append("accept")

        async def send_text(self, line):
            if '"gateway.ready"' in line:
                events.append(f"ready_after_{len(calls)}")

        async def receive_text(self):
            raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    asyncio.run(ws_mod.handle_ws(FakeWS()))

    # Discovery moved to profile-aware agent construction. WebSocket transport
    # should not start MCP discovery before a profile has been bound.
    assert calls == []
    assert events == ["accept", "ready_after_0"]


def test_ws_transport_serializes_concurrent_sends():
    active_sends = 0
    max_active_sends = 0
    sent = []

    class FakeWS:
        async def send_text(self, line):
            nonlocal active_sends, max_active_sends
            active_sends += 1
            max_active_sends = max(max_active_sends, active_sends)
            try:
                await asyncio.sleep(0.05)
                sent.append(line)
            finally:
                active_sends -= 1

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        transport = ws_mod.WSTransport(FakeWS(), loop, peer="serialize-test")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(transport.write, {"idx": 1}),
                pool.submit(transport.write, {"idx": 2}),
            ]
            assert [f.result(timeout=2) for f in futures] == [True, True]

        assert len(sent) == 2
        assert max_active_sends == 1
        assert transport._closed is False
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()


def test_ws_transport_preserves_cross_batch_order():
    async def scenario():
        entered = []
        first_entered = asyncio.Event()
        release_first = asyncio.Event()
        second_started = asyncio.Event()

        class FakeWS:
            async def send_text(self, line):
                entered.append(line)
                if line == "A1":
                    first_entered.set()
                    await release_first.wait()

        transport = ws_mod.WSTransport(
            FakeWS(), asyncio.get_running_loop(), peer="batch-order-test"
        )
        first = asyncio.create_task(transport._safe_send_many(["A1", "A2"]))
        await first_entered.wait()

        async def send_second():
            second_started.set()
            await transport._safe_send_many(["B1", "B2"])

        second = asyncio.create_task(send_second())
        await second_started.wait()

        # The second task has reached the transport. Without whole-batch
        # serialization it runs B1/B2 before this task can resume.
        assert entered == ["A1"]

        release_first.set()
        await asyncio.gather(first, second)
        assert entered == ["A1", "A2", "B1", "B2"]

    asyncio.run(scenario())


