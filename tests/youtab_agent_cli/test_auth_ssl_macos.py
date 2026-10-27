"""Tests for youtab_agent_cli.auth._default_verify platform-aware fallback.

On macOS with Homebrew Python, the system OpenSSL cannot locate the
system trust store, so we explicitly load certifi's bundle. On other
platforms we defer to httpx's own default (which itself uses certifi).

Most tests use monkeypatching — no real SSL handshakes. A handful use
an openssl-generated self-signed cert via the `real_bundle_file`
fixture because `ssl.create_default_context(cafile=...)` parses the
bundle and refuses stubs.
"""

import shutil
import ssl
import subprocess
import sys
from pathlib import Path

import pytest


from youtab_agent_cli.auth import _default_verify, _resolve_verify


@pytest.fixture
def real_bundle_file(tmp_path: Path) -> str:
    """Return a path to a real openssl-generated self-signed cert.

    Skips the test when the `openssl` binary isn't on PATH, so CI images
    without it degrade gracefully instead of erroring out.
    """
    if shutil.which("openssl") is None:
        pytest.skip("openssl binary not available")
    cert = tmp_path / "ca.pem"
    key = tmp_path / "key.pem"
    result = subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(key), "-out", str(cert),
            "-sha256", "-days", "1", "-nodes",
            "-subj", "/CN=test",
        ],
        capture_output=True,
        timeout=10,
    )
    if result.returncode != 0:
        pytest.skip(f"openssl failed: {result.stderr.decode('utf-8', 'ignore')[:200]}")
    return str(cert)


class TestDefaultVerify:
    def test_returns_ssl_context_on_darwin(self, monkeypatch):
        monkeypatch.setattr(sys, "platform", "darwin")
        result = _default_verify()
        assert isinstance(result, ssl.SSLContext)


    def test_darwin_falls_back_to_true_when_certifi_missing(self, monkeypatch):
        monkeypatch.setattr(sys, "platform", "darwin")

        real_import = __import__

        def fake_import(name, *args, **kwargs):
            if name == "certifi":
                raise ImportError("simulated missing certifi")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr("builtins.__import__", fake_import)
        assert _default_verify() is True


class TestResolveVerifyIntegration:
    """_resolve_verify should defer to _default_verify in the no-CA path."""


    def test_no_ca_uses_default_verify_on_linux(self, monkeypatch):
        monkeypatch.setattr(sys, "platform", "linux")
        for var in ("YOUTAB_AGENT_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"):
            monkeypatch.delenv(var, raising=False)
        assert _resolve_verify() is True



    def test_insecure_cannot_disable_configured_ca(self, monkeypatch, real_bundle_file):
        monkeypatch.setenv("YOUTAB_AGENT_CA_BUNDLE", real_bundle_file)
        context = _resolve_verify(insecure=True)
        assert isinstance(context, ssl.SSLContext)
        assert context.verify_mode == ssl.CERT_REQUIRED
        assert context.check_hostname is True


@pytest.fixture
def account_tls_server(tmp_path):
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("openssl required for the real local TLS handshake")
    cert, key = tmp_path / "server.pem", tmp_path / "server-key.pem"
    subprocess.run(
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
         "-keyout", str(key), "-out", str(cert)],
        check=True, capture_output=True, timeout=10,
    )
    received = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append({
                "path": self.path,
                "refresh_token": self.headers.get("x-youtab-refresh-token"),
                "body": self.rfile.read(int(self.headers.get("Content-Length", "0"))),
            })
            payload = json.dumps({
                "access_token": "synthetic-new-access",
                "refresh_token": "synthetic-new-refresh",
                "expires_in": 3600,
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert), str(key))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield str(cert), server.server_port, received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize("saved_insecure", [False, True])
@pytest.mark.parametrize("trusted_ca", [False, True])
def test_real_account_tls_never_bypasses_peer_validation(
    account_tls_server, saved_insecure, trusted_ca,
):
    import httpx
    from youtab_agent_cli import auth

    cert, port, received = account_tls_server
    verify = auth._resolve_verify(
        insecure=None if saved_insecure else True,
        auth_state={"tls": {"insecure": True}} if saved_insecure else None,
        ca_bundle=cert if trusted_ca else None,
    )
    assert verify is not False
    with httpx.Client(verify=verify, trust_env=False) as client:
        def refresh():
            return auth._refresh_access_token(
                client=client, portal_base_url=f"https://localhost:{port}",
                client_id="synthetic-client", refresh_token="synthetic-refresh",
            )
        if trusted_ca:
            assert refresh()["refresh_token"] == "synthetic-new-refresh"
        else:
            with pytest.raises(httpx.ConnectError, match="CERTIFICATE_VERIFY_FAILED"):
                refresh()
    assert len(received) == (1 if trusted_ca else 0)
    if trusted_ca:
        assert received[0]["refresh_token"] == "synthetic-refresh"


def test_account_ca_cannot_bypass_hostname_validation(account_tls_server):
    import httpx
    from youtab_agent_cli import auth

    cert, port, received = account_tls_server
    verify = auth._resolve_verify(insecure=True, ca_bundle=cert)
    with httpx.Client(verify=verify, trust_env=False) as client:
        with pytest.raises(httpx.ConnectError, match="CERTIFICATE_VERIFY_FAILED"):
            auth._refresh_access_token(
                client=client, portal_base_url=f"https://127.0.0.1:{port}",
                client_id="synthetic-client", refresh_token="synthetic-refresh",
            )
    assert received == []
