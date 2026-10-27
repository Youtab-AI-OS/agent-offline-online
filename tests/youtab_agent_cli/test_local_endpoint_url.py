"""Custom endpoint normalization and anonymous synthetic transport integration."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from youtab_agent_cli.endpoint_url import normalize_model_endpoint_url


@pytest.mark.parametrize("value,expected", [
    ("192.0.2.15:16731", "http://192.0.2.15:16731"),
    ("192.0.2.15:16731/v1", "http://192.0.2.15:16731/v1"),
    ("localhost:16731/api/v1", "http://localhost:16731/api/v1"),
    ("[2001:db8::5]:16731/v1", "http://[2001:db8::5]:16731/v1"),
    (" https://Model.Internal.Example/prefix/v1/ ", "https://Model.Internal.Example/prefix/v1"),
])
def test_normalize_only_explicit_literal_local_addresses(value, expected):
    assert normalize_model_endpoint_url(value) == expected


@pytest.mark.parametrize("value", ["192.0.2.15", "localhost", "model.example:16731/v1", "192.0.2.15:0/v1", "192.0.2.15:65536/v1", "http://user:secret@model.example/v1", "localhost:16731/v1?token=secret", "https://model.example/v1#fragment", "https://model.example/with space", "ftp://model.example/v1", "localhost:16731/v1?", "https://model.example/v1#"])
def test_do_not_guess_hostname_ports_or_accept_credential_urls(value):
    with pytest.raises(ValueError):
        normalize_model_endpoint_url(value)


def test_saved_key_url_identity_uses_the_same_normalization():
    from youtab_agent_cli.web_server import _custom_endpoint_url_matches
    assert _custom_endpoint_url_matches("192.0.2.15:16731/v1", "http://192.0.2.15:16731/v1/")
    assert not _custom_endpoint_url_matches("192.0.2.15:16731/v1", "https://192.0.2.15:16731/v1")
    assert not _custom_endpoint_url_matches("192.0.2.15:16731/v1", "192.0.2.15:16732/v1")


def test_server_403_without_a_key_is_access_policy_not_invalid_key(monkeypatch):
    import httpx
    from youtab_agent_cli import web_server as ws
    real_client = httpx.Client
    transport = httpx.MockTransport(lambda request: httpx.Response(403, json={"detail": "private upstream detail"}))
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: real_client(transport=transport, trust_env=False))
    result = ws._probe_custom_endpoint("http://127.0.0.1:16731/v1")
    assert result["ok"] is False
    assert result["reachable"] is True
    assert "access policy" in result["message"]
    assert "API key" not in result["message"]
    assert "private upstream detail" not in result["message"]


def test_unsupported_selected_proxy_returns_safe_configuration_error(monkeypatch, _isolate_youtab_home):
    import httpx
    from starlette.testclient import TestClient
    from youtab_agent_cli import web_server as ws
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTP_PROXY", "ftp://synthetic-user:synthetic-password@proxy.invalid:3128")
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", lambda *_args: pytest.fail("No model or proxy network request is permitted"))
    client = TestClient(ws.app)
    client.headers[ws._SESSION_HEADER_NAME] = ws._SESSION_TOKEN
    response = client.post("/api/providers/custom-endpoints/validate", json={"name": "Synthetic local", "base_url": "http://192.0.2.15:16731/v1", "model": ""})
    assert response.status_code == 200
    result = response.json()
    assert result["ok"] is False
    assert result["reachable"] is False
    assert "configuration" in result["message"]
    assert "proxy" in result["message"]
    assert "synthetic-user" not in result["message"]
    assert "synthetic-password" not in result["message"]
    assert "proxy.invalid" not in result["message"]


def test_anonymous_probe_save_and_main_aux_sdk_requests_share_a_synthetic_local_server(monkeypatch, _isolate_youtab_home):
    import httpx
    from openai import OpenAI
    from starlette.testclient import TestClient
    from agent.auxiliary_client import _create_openai_client
    from run_agent import AIAgent
    from youtab_agent_cli import web_server as ws
    from youtab_agent_cli.config import load_config
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTP_PROXY", "http://unused-user:unused-password@proxy.invalid:bad-port")
    monkeypatch.setenv("HTTPS_PROXY", "http://unused-user:unused-password@proxy.invalid:bad-port")
    seen = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            seen.append(("GET", self.path, self.headers.get("Authorization")))
            if self.path == "/v1/models":
                body, status = {"data": [{"id": "synthetic-local"}]}, 200
            else:
                body, status = {}, 404
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            seen.append(("POST", self.path, self.headers.get("Authorization")))
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            raw = json.dumps({"id": "transport-test", "object": "chat.completion", "created": 1, "model": "synthetic-local", "choices": [{"index": 0, "message": {"role": "assistant", "content": "transport-only"}, "finish_reason": "stop"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    clients = []
    try:
        bare_address = f"127.0.0.1:{server.server_port}"
        probe = ws._probe_custom_endpoint(bare_address)
        assert probe["ok"] is True
        assert probe["base_url"] == f"http://{bare_address}/v1"
        test_client = TestClient(ws.app)
        test_client.headers[ws._SESSION_HEADER_NAME] = ws._SESSION_TOKEN
        response = test_client.post("/api/providers/custom-endpoints", json={"id": "synthetic-local", "name": "Synthetic local", "base_url": bare_address + "/v1", "model": "synthetic-local", "make_default": True})
        assert response.status_code == 200
        assert load_config()["model"]["base_url"] == probe["base_url"]
        assert response.json()["endpoints"][0]["has_api_key"] is False
        main_http = AIAgent._build_keepalive_http_client(probe["base_url"])
        assert isinstance(main_http, httpx.Client)
        clients.append(OpenAI(api_key="no-key-required", base_url=probe["base_url"], http_client=main_http))
        clients.append(_create_openai_client(api_key="no-key-required", base_url=probe["base_url"]))
        for client in clients:
            completion = client.chat.completions.create(model="synthetic-local", messages=[{"role": "user", "content": "Synthetic transport check"}])
            assert completion.choices[0].message.content == "transport-only"
        assert seen[0] == ("GET", "/models", None)
        assert seen[1] == ("GET", "/v1/models", None)
        assert sum(method == "POST" and path == "/v1/chat/completions" for method, path, _auth in seen) == 2
    finally:
        for client in clients:
            client.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
