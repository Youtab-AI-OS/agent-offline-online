"""Process-local cache fingerprints for credentials.

These values only distinguish in-memory cache entries. They are not password
verifiers and must not be persisted or used for authentication. A random key
prevents offline guesses of a credential from a leaked cache fingerprint.
"""

import hmac
import secrets


_CACHE_FINGERPRINT_KEY = secrets.token_bytes(32)


def credential_cache_digest(value: str, *, purpose: bytes) -> bytes:
    """Return a stable, purpose-separated digest within this process only."""
    return hmac.digest(
        _CACHE_FINGERPRINT_KEY,
        purpose + b"\0" + value.encode("utf-8"),
        "sha256",
    )
