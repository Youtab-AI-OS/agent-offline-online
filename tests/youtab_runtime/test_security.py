from __future__ import annotations

from pathlib import Path

import pytest

from youtab_runtime.security import redact_secrets, resolve_within, validate_outbound_url


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",
        "https://localhost/admin",
        "https://127.0.0.1/admin",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.2/internal",
        "https://user@example.com/private",
        "https://@example.com/private",
        "https://:fixture-password@example.com/private",
        "https://:@example.com/private",
        "https://user:@example.com/private",
    ],
)
def test_ssrf_shapes_are_rejected(url: str) -> None:
    with pytest.raises(ValueError):
        validate_outbound_url(url)


def test_public_https_url_is_admitted() -> None:
    assert validate_outbound_url("https://example.com/evidence") == (
        "https://example.com/evidence"
    )


def test_traversal_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="escapes"):
        resolve_within(tmp_path, "../outside.txt")


def test_secret_values_are_redacted() -> None:
    text = "api_key=super-secret-value token:another-secret"
    redacted = redact_secrets(text)

    assert "super-secret-value" not in redacted
    assert "another-secret" not in redacted
    assert redacted.count("[REDACTED]") == 2


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com:8443/evidence",
        "https://example.com/users/user@example.com?email=user@example.com",
    ],
)
def test_at_characters_outside_authority_do_not_imply_credentials(url: str) -> None:
    assert validate_outbound_url(url) == url

@pytest.mark.parametrize("text", [
    '{"id_token": {"values": ["SYNTHETIC_WORKER_CREDENTIAL_20261011"]}}',
    "Authorization: Bearer SYNTHETIC_WORKER_CREDENTIAL_20261011",
    "https://user:SYNTHETIC_WORKER_CREDENTIAL_20261011@example.invalid/",
])
def test_managed_redaction_uses_strict_shared_policy_even_when_disabled(monkeypatch, text):
    from agent import redact

    monkeypatch.setattr(redact, "_REDACT_ENABLED", False)
    result = redact_secrets(text)
    assert "SYNTHETIC_WORKER_CREDENTIAL_20261011" not in result
    assert "«redacted-secret»" in result or "***" in result


def test_managed_redaction_failure_does_not_return_raw_details(monkeypatch):
    from agent import redact

    def unavailable(*args, **kwargs):
        raise RuntimeError("synthetic redactor failure")

    monkeypatch.setattr(redact, "redact_sensitive_text", unavailable)
    assert redact_secrets("password=synthetic-secret") == "error details unavailable"
