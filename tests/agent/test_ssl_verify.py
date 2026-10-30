"""Tests for agent.ssl_verify.resolve_httpx_verify."""

import ssl
import logging

import certifi
import pytest

from agent.ssl_verify import resolve_httpx_verify

_CA_ENV_VARS = ("YOUTAB_AGENT_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")


@pytest.fixture
def clean_ca_env(monkeypatch):
    for var in _CA_ENV_VARS:
        monkeypatch.delenv(var, raising=False)




def test_youtab_ca_bundle_returns_ssl_context(clean_ca_env, monkeypatch):
    monkeypatch.setenv("YOUTAB_AGENT_CA_BUNDLE", certifi.where())
    result = resolve_httpx_verify()
    assert isinstance(result, ssl.SSLContext)






def test_default_without_env_is_true(clean_ca_env):
    assert resolve_httpx_verify() is True


def test_insecure_warning_does_not_log_provider_url(clean_ca_env, caplog):
    secret = "synthetic-token-for-log-test"
    with caplog.at_level(logging.WARNING, logger="agent.ssl_verify"):
        assert resolve_httpx_verify(
            ssl_verify=False,
            base_url=f"https://user:{secret}@example.invalid/v1?api_key={secret}",
        ) is False
    assert "TLS certificate verification DISABLED" in caplog.text
    assert secret not in caplog.text
