"""Target-aware proxy policy: synthetic env, no external network requests."""
import ssl

import certifi
import httpx
import pytest

from agent.auxiliary_client import _validate_proxy_env_urls
from agent.process_bootstrap import _get_proxy_for_base_url, build_keepalive_http_client


@pytest.fixture(autouse=True)
def clean_proxy_env(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("target", ["http://localhost:16731/v1", "https://LOCALHOST:16731/v1", "http://127.0.0.2:16731/v1", "http://[::1]:16731/v1"])
def test_loopback_probe_and_inference_are_direct_even_with_proxy_env(monkeypatch, target):
    monkeypatch.setenv("HTTP_PROXY", "http://synthetic-proxy:3128")
    monkeypatch.setenv("HTTPS_PROXY", "http://synthetic-proxy:3129")
    assert _get_proxy_for_base_url(target) is None


def test_http_lan_does_not_inherit_https_proxy_or_bypass_explicit_http_proxy(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://secure-proxy:3128")
    target = "http://192.0.2.15:16731/v1"
    assert _get_proxy_for_base_url(target) is None
    monkeypatch.setenv("HTTP_PROXY", "http://plain-proxy:3129")
    assert _get_proxy_for_base_url(target) == "http://plain-proxy:3129"
    assert _get_proxy_for_base_url("https://192.0.2.15:16731/v1") == "http://secure-proxy:3128"
    assert _get_proxy_for_base_url("http://10.44.0.2:16731/v1") == "http://plain-proxy:3129"


def test_https_keeps_http_only_corporate_fallback_and_https_precedence(monkeypatch):
    target = "https://api.example/v1"
    monkeypatch.setenv("ALL_PROXY", "http://all-proxy:3130")
    monkeypatch.setenv("HTTP_PROXY", "http://plain-proxy:3129")
    assert _get_proxy_for_base_url(target) == "http://plain-proxy:3129"
    monkeypatch.setenv("HTTPS_PROXY", "http://secure-proxy:3128")
    assert _get_proxy_for_base_url(target) == "http://secure-proxy:3128"


@pytest.mark.parametrize("pattern,target,bypass", [
    ("192.0.2.15:16731", "http://192.0.2.15:16731/v1", True),
    ("192.0.2.15:16731", "http://192.0.2.15:16732/v1", False),
    ("internal.example:443", "https://internal.example/v1", True),
    ("internal.example:443", "http://internal.example/v1", False),
    (".internal.example", "https://model.internal.example/v1", True),
    ("internal.example", "https://internal.example.attacker.invalid/v1", False),
    ("[2001:db8::5]:16731", "http://[2001:db8::5]:16731/v1", True),
    ("[2001:db8::5]:16731", "http://[2001:db8::5]:16732/v1", False),
    ("2001:db8::5", "http://[2001:db8::5]:16731/v1", True),
    ("*", "https://public.example/v1", True),
])
def test_no_proxy_preserves_authority_port_domain_and_wildcard_contract(monkeypatch, pattern, target, bypass):
    monkeypatch.setenv("ALL_PROXY", "http://synthetic-proxy:3128")
    monkeypatch.setenv("NO_PROXY", pattern)
    assert (_get_proxy_for_base_url(target) is None) is bypass


def test_lowercase_proxy_and_no_proxy_override_uppercase(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://upper-proxy:3128")
    monkeypatch.setenv("http_proxy", "http://lower-proxy:3129")
    monkeypatch.setenv("NO_PROXY", "192.0.2.15")
    monkeypatch.setenv("no_proxy", "")
    assert _get_proxy_for_base_url("http://192.0.2.15:16731/v1") == "http://lower-proxy:3129"


def test_selected_malformed_online_proxy_is_rejected_without_printing_credentials(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://private-user:private-password@proxy.invalid:bad-port")
    with pytest.raises(RuntimeError) as error:
        _validate_proxy_env_urls("https://api.example/v1")
    assert "HTTPS_PROXY" in str(error.value)
    assert "private-user" not in str(error.value)
    assert "private-password" not in str(error.value)
    assert "proxy.invalid" not in str(error.value)


def test_unknown_target_keeps_full_proxy_validation(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:bad-port")
    with pytest.raises(RuntimeError, match="HTTPS_PROXY"):
        _validate_proxy_env_urls()


@pytest.mark.parametrize("provider", ["custom", "auto"])
def test_auxiliary_entry_reuses_a_known_local_target_without_consuming_unrelated_proxy(monkeypatch, provider):
    from agent.auxiliary_client import resolve_provider_client
    monkeypatch.setenv("HTTP_PROXY", "http://unused-secret@proxy.invalid:bad-port")
    monkeypatch.setenv("HTTPS_PROXY", "http://unused-secret@proxy.invalid:bad-port")
    target = "http://127.0.0.1:16731/v1"
    arguments = {"explicit_base_url": target, "explicit_api_key": "no-key-required"} if provider == "custom" else {"main_runtime": {"provider": "custom", "model": "synthetic-local", "base_url": target, "api_key": "no-key-required"}}
    client, model = resolve_provider_client(provider, model="synthetic-local", **arguments)
    try:
        assert client is not None
        assert model == "synthetic-local"
        assert str(client.base_url).rstrip("/") == target
    finally:
        if client is not None:
            client.close()


def test_unused_malformed_proxy_does_not_break_http_or_loopback_client_construction(monkeypatch):
    from run_agent import AIAgent
    monkeypatch.setenv("HTTPS_PROXY", "http://unused-secret@proxy.invalid:bad-port")
    target = "http://192.0.2.15:16731/v1"
    _validate_proxy_env_urls(target)
    for client in (build_keepalive_http_client(target), AIAgent._build_keepalive_http_client(target)):
        assert isinstance(client, httpx.Client)
        client.close()
    monkeypatch.setenv("HTTP_PROXY", "http://unused-secret@proxy.invalid:bad-port")
    _validate_proxy_env_urls("http://127.0.0.1:16731/v1")
    client = build_keepalive_http_client("http://127.0.0.1:16731/v1")
    assert isinstance(client, httpx.Client)
    client.close()


def test_explicit_ssl_context_identity_is_preserved_in_main_and_auxiliary_clients():
    from run_agent import AIAgent
    context = ssl.create_default_context(cafile=certifi.where())
    for client in (build_keepalive_http_client("https://api.example/v1", verify=context), AIAgent._build_keepalive_http_client("https://api.example/v1", verify=context)):
        assert isinstance(client, httpx.Client)
        assert client._transport._pool._ssl_context is context
        assert context.verify_mode == ssl.CERT_REQUIRED
        assert context.check_hostname is True
        client.close()


@pytest.mark.parametrize("variable", ["SSL_CERT_FILE", "SSL_CERT_DIR"])
def test_explicit_transport_preserves_ca_environment(monkeypatch, tmp_path, variable):
    from run_agent import AIAgent
    monkeypatch.setenv(variable, certifi.where() if variable == "SSL_CERT_FILE" else str(tmp_path))
    for client in (build_keepalive_http_client("https://api.example/v1"), AIAgent._build_keepalive_http_client("https://api.example/v1")):
        assert isinstance(client, httpx.Client)
        context = client._transport._pool._ssl_context
        assert context.verify_mode == ssl.CERT_REQUIRED
        assert context.check_hostname is True
        assert bool(context.get_ca_certs()) is (variable == "SSL_CERT_FILE")
        client.close()
