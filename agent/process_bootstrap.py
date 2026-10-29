"""Process-level bootstrap helpers for ``run_agent``.

Three concerns, all tied to ``AIAgent`` boot-time / runtime IO setup:

1. **Lazy OpenAI SDK import** — ``_load_openai_cls`` + ``_OpenAIProxy``
   defer the 240ms-ish ``from openai import OpenAI`` cost until first use,
   while preserving ``isinstance(client, OpenAI)`` checks and
   ``patch("run_agent.OpenAI", ...)`` test patterns.

2. **Crash-resistant stdio** — ``_SafeWriter`` wraps stdout/stderr so
   ``OSError: Input/output error`` from broken pipes (systemd, Docker,
   thread teardown races) cannot crash the agent.  ``_install_safe_stdio``
   applies the wrapper.

3. **HTTP proxy resolution** — ``_get_proxy_from_env`` reads
   ``HTTPS_PROXY`` / ``HTTP_PROXY`` / ``ALL_PROXY``;
   ``_get_proxy_for_base_url`` respects ``NO_PROXY`` for the given base URL.

``run_agent`` re-exports every name so existing
``from run_agent import _get_proxy_from_env`` imports keep working
unchanged.
"""

from __future__ import annotations

import os
import ipaddress
import sys
import urllib.request
from urllib.parse import urlsplit
from typing import Any, Optional

from utils import normalize_proxy_url


# Cached at module level so we only pay the OpenAI SDK import cost once
# per process (after the first lazy load).
_OPENAI_CLS_CACHE = None


def _load_openai_cls() -> type:
    """Import and cache ``openai.OpenAI``."""
    global _OPENAI_CLS_CACHE
    if _OPENAI_CLS_CACHE is None:
        from openai import OpenAI as _cls
        _OPENAI_CLS_CACHE = _cls
    return _OPENAI_CLS_CACHE


class _OpenAIProxy:
    """Module-level proxy that looks like ``openai.OpenAI`` but imports lazily."""

    __slots__ = ()

    def __call__(self, *args, **kwargs):
        return _load_openai_cls()(*args, **kwargs)

    def __instancecheck__(self, obj):
        return isinstance(obj, _load_openai_cls())

    def __repr__(self):
        return "<lazy openai.OpenAI proxy>"


class _SafeWriter:
    """Transparent stdio wrapper that catches OSError/ValueError from broken pipes.

    When youtab-agent-runtime runs as a systemd service, Docker container, or headless
    daemon, the stdout/stderr pipe can become unavailable (idle timeout, buffer
    exhaustion, socket reset). Any print() call then raises
    ``OSError: [Errno 5] Input/output error``, which can crash agent setup or
    run_conversation() — especially via double-fault when an except handler
    also tries to print.

    Additionally, when subagents run in ThreadPoolExecutor threads, the shared
    stdout handle can close between thread teardown and cleanup, raising
    ``ValueError: I/O operation on closed file`` instead of OSError.

    This wrapper delegates all writes to the underlying stream and silently
    catches both OSError and ValueError. It is transparent when the wrapped
    stream is healthy.
    """

    __slots__ = ("_inner",)

    def __init__(self, inner):
        object.__setattr__(self, "_inner", inner)

    def write(self, data):
        try:
            return self._inner.write(data)
        except (OSError, ValueError):
            return len(data) if isinstance(data, str) else 0

    def flush(self):
        try:
            self._inner.flush()
        except (OSError, ValueError):
            pass

    def fileno(self):
        return self._inner.fileno()

    def isatty(self):
        try:
            return self._inner.isatty()
        except (OSError, ValueError):
            return False

    def __getattr__(self, name):
        return getattr(self._inner, name)


def _get_proxy_from_env() -> Optional[str]:
    """Read proxy URL from environment variables.

    Checks HTTPS_PROXY, HTTP_PROXY, ALL_PROXY (and lowercase variants) in order.
    Returns the first valid proxy URL found, or None if no proxy is configured.
    """
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
                "https_proxy", "http_proxy", "all_proxy"):
        value = os.environ.get(key, "").strip()
        if value:
            return normalize_proxy_url(value)
    return None


def _proxy_env_for_base_url(base_url: Optional[str]) -> Optional[tuple[str, str]]:
    """Select only a target's consumed env proxy; never bypass a whole LAN."""
    try:
        parsed = urlsplit(str(base_url or ""))
        host = parsed.hostname or ""
        port = parsed.port
    except ValueError:
        parsed, host, port = None, "", None
    if parsed is None or parsed.scheme not in {"http", "https"} or not host:
        keys = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy")
    else:
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host.lower().removesuffix(".") == "localhost"
        if loopback:
            return None
        effective_port = port if port is not None else (443 if parsed.scheme == "https" else 80)
        authority = f"[{host}]:{effective_port}" if ":" in host else f"{host}:{effective_port}"
        no_proxy = os.environ.get("no_proxy", os.environ.get("NO_PROXY", ""))
        if urllib.request.proxy_bypass_environment(authority, proxies={"no": no_proxy}):
            return None
        # urllib's host:port parsing expects brackets for IPv6. Preserve the
        # customary exact bare-literal NO_PROXY spelling as well.
        if ":" in host and host.lower() in {item.strip().lower() for item in no_proxy.split(",")}:
            return None
        scheme_key = parsed.scheme.upper() + "_PROXY"
        actual_keys = set(os.environ)
        # Keep the established HTTPS corporate-proxy fallback. Only an HTTP
        # target must stop borrowing HTTPS_PROXY from an unrelated route.
        scheme_keys = (scheme_key, "HTTP_PROXY", "ALL_PROXY") if parsed.scheme == "https" else (scheme_key, "ALL_PROXY")
        keys = tuple(
            key.lower() if key.lower() in actual_keys else key
            for key in scheme_keys
        )
    for key in keys:
        value = os.environ.get(key, "").strip()
        if value:
            return key, normalize_proxy_url(value) or value
    return None


def _get_proxy_for_base_url(base_url: Optional[str]) -> Optional[str]:
    """Use scheme-specific env proxy, NO_PROXY authority matching and loopback bypass."""
    selected = _proxy_env_for_base_url(base_url)
    return selected[1] if selected else None


def build_keepalive_http_client(
    base_url: str = "",
    *,
    async_mode: bool = False,
    verify: Any = True,
) -> Optional[Any]:
    """Build an httpx client for OpenAI SDK calls with env-only proxy policy.

    Uses explicit ``HTTPS_PROXY`` / ``NO_PROXY`` env vars via
    ``_get_proxy_for_base_url``. Plain no-proxy mounts disable httpx's default
    ``trust_env`` proxy path, so macOS system proxy settings from
    ``urllib.request.getproxies()`` (which omit the ExceptionsList) are not
    applied. Mirrors ``AIAgent._build_keepalive_http_client``.

    Connection lifecycle is managed at the HTTP pool layer
    (``keepalive_expiry=20.0`` reaps idle connections before reverse proxies'
    typical 30-60 s timeouts) instead of the former custom
    ``socket_options`` transport, which broke streaming behind reverse
    proxies (#54049, #12952) and stalled TLS handshakes by stripping
    ``TCP_NODELAY``.

    ``verify`` is forwarded to httpx so auxiliary-client calls (compression,
    vision, web_extract, title generation, etc.) honor the same per-provider
    ``ssl_ca_cert`` / ``ssl_verify`` and ``YOUTAB_AGENT_CA_BUNDLE`` settings the main
    client uses. It is passed on the client AND on the plain no-proxy mounts
    (a mounted transport owns the SSL context for its scheme).
    """
    try:
        import httpx

        proxy = _get_proxy_for_base_url(base_url)

        limits = httpx.Limits(
            max_keepalive_connections=20,
            max_connections=100,
            keepalive_expiry=20.0,
        )
        # Generous read=None for SSE streaming endpoints.
        timeout = httpx.Timeout(connect=15.0, read=None, write=15.0, pool=10.0)

        transport_cls = httpx.AsyncHTTPTransport if async_mode else httpx.HTTPTransport
        client_cls = httpx.AsyncClient if async_mode else httpx.Client
        mounts = {}
        if proxy is None:
            mounts = {
                "http://": transport_cls(verify=verify),
                "https://": transport_cls(verify=verify),
            }
        return client_cls(
            limits=limits,
            timeout=timeout,
            proxy=proxy,
            # An explicit transport stops httpx from parsing unused env proxy
            # URLs; the transport still honors the normal TLS CA environment.
            transport=transport_cls(verify=verify, limits=limits),
            mounts=mounts or None,
            verify=verify,
        )
    except Exception:
        return None


def _install_safe_stdio() -> None:
    """Wrap stdout/stderr so best-effort console output cannot crash the agent."""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is not None and not isinstance(stream, _SafeWriter):
            setattr(sys, stream_name, _SafeWriter(stream))


# Module-level proxy instance — drops in for ``openai.OpenAI``.  Imported as
# ``from agent.process_bootstrap import OpenAI`` (or re-exported via
# ``run_agent`` for legacy tests).
OpenAI = _OpenAIProxy()


__all__ = [
    "OpenAI",
    "_OpenAIProxy",
    "_load_openai_cls",
    "_SafeWriter",
    "_install_safe_stdio",
    "_get_proxy_from_env",
    "_get_proxy_for_base_url",
    "build_keepalive_http_client",
]
