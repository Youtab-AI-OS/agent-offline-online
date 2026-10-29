"""Conservative URL handling for the existing custom model endpoint seam."""

import ipaddress
from urllib.parse import urlsplit


def normalize_model_endpoint_url(value: str) -> str:
    """Add HTTP only to a literal IP/localhost with an explicit valid port.

    Explicit HTTP(S) URLs retain their host, scheme and API prefix. Never
    guess a port, rewrite a LAN/VM address or add a scheme to an arbitrary
    hostname. Credentials, query strings and fragments are not endpoint URLs.
    """
    candidate = str(value or "").strip()
    if (not candidate or any(character.isspace() for character in candidate)
            or "?" in candidate or "#" in candidate):
        raise ValueError("Enter a valid HTTP or HTTPS model server address.")
    if "://" not in candidate:
        bare = urlsplit("//" + candidate)
        host = bare.hostname or ""
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if (not (literal is not None or host.lower() == "localhost")
                or bare.port is None or not 1 <= bare.port <= 65535):
            raise ValueError("Enter an HTTP(S) address, or a local IP/localhost with its server port.")
        candidate = "http://" + candidate
    parsed = urlsplit(candidate)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment
            or (parsed.port is not None and not 1 <= parsed.port <= 65535)):
        raise ValueError("Enter a valid HTTP or HTTPS model server address without credentials, query or fragment.")
    return candidate.rstrip("/")
