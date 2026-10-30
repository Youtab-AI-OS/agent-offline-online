"""Credential cache fingerprints are process-local and purpose-separated."""

import subprocess
import sys

from agent.credential_cache import credential_cache_digest


def test_cache_fingerprint_is_stable_and_separates_tokens_and_purposes():
    first = credential_cache_digest("synthetic-token-a", purpose=b"gateway-agent")
    assert first == credential_cache_digest("synthetic-token-a", purpose=b"gateway-agent")
    assert first != credential_cache_digest("synthetic-token-b", purpose=b"gateway-agent")
    assert first != credential_cache_digest("synthetic-token-a", purpose=b"aux-client")
    assert b"synthetic-token-a" not in first


def test_cache_fingerprint_changes_across_processes():
    code = (
        "from agent.credential_cache import credential_cache_digest; "
        "print(credential_cache_digest('synthetic-token', "
        "purpose=b'gateway-agent').hex())"
    )
    first = subprocess.check_output([sys.executable, "-c", code], text=True).strip()
    second = subprocess.check_output([sys.executable, "-c", code], text=True).strip()
    assert first != second
