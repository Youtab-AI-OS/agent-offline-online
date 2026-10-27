"""The managed download protocol consumes a retained descriptor, never a path."""
import asyncio
import os
from pathlib import Path

import pytest

from youtab_agent_cli import web_server


@pytest.fixture
def isolated_runtime(tmp_path, monkeypatch):
    import youtab_constants

    home = tmp_path / "runtime"
    home.mkdir()
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(home))
    monkeypatch.setattr(youtab_constants, "_committed_relocation_override", lambda _home: None)
    monkeypatch.setattr(youtab_constants, "_get_platform_default_youtab_home", lambda: tmp_path / "default-runtime")
    return home


def _response(tmp_path):
    path = tmp_path / "report.txt"
    path.write_bytes(b"0123456789")
    opened = web_server._open_dashboard_file(path, 100)
    return web_server._DescriptorFileResponse(opened, media_type="text/plain", filename=path.name)


async def _consume(response, headers=(), method="GET", send_error=None, messages=None):
    if messages is None:
        messages = []
    async def send(message):
        if send_error and message["type"] == "http.response.body":
            raise send_error
        messages.append(message)
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    await response({"type": "http", "method": method, "headers": list(headers),
                    "extensions": {"http.response.pathsend": {}}}, receive, send)
    return messages


def _body(messages):
    return b"".join(message.get("body", b"") for message in messages)


@pytest.mark.parametrize("range_header,expected,status", [
    (None, b"0123456789", 200), (b"bytes=2-5", b"2345", 206),
    (b"bytes=-3", b"789", 206), (b"bytes=7-", b"789", 206),
    (b"bytes=100-200", b"", 416), (b"invalid", None, 400),
])
def test_range_protocol_closes_descriptor(isolated_runtime, tmp_path, range_header, expected, status):
    response = _response(tmp_path)
    headers = [] if range_header is None else [(b"range", range_header)]
    messages = asyncio.run(_consume(response, headers))
    assert messages[0]["status"] == status
    if expected is not None:
        assert _body(messages) == expected
    assert not any(message["type"] == "http.response.pathsend" for message in messages)
    assert response.opened.descriptor is None


@pytest.mark.parametrize("matches,status,expected", [(True, 206, b"12"), (False, 200, b"0123456789")])
def test_if_range_uses_retained_file_metadata(isolated_runtime, tmp_path, matches, status, expected):
    response = _response(tmp_path)
    validator = response.headers["etag"].encode() if matches else b"not-current"
    messages = asyncio.run(_consume(response, [(b"range", b"bytes=1-2"), (b"if-range", validator)]))
    assert messages[0]["status"] == status and _body(messages) == expected
    assert response.opened.descriptor is None


def test_multipart_range_and_head_never_use_pathsend(isolated_runtime, tmp_path):
    response = _response(tmp_path)
    messages = asyncio.run(_consume(response, [(b"range", b"bytes=0-1,8-9")]))
    headers = dict(messages[0]["headers"])
    body = _body(messages)
    assert messages[0]["status"] == 206
    assert headers[b"content-type"].startswith(b"multipart/byteranges;")
    assert b"bytes 0-1/10" in body and b"bytes 8-9/10" in body
    assert b"\r\n01\r\n" in body and b"\r\n89\r\n" in body
    assert int(headers[b"content-length"]) == len(body)
    assert response.opened.descriptor is None
    response = _response(tmp_path)
    messages = asyncio.run(_consume(response, method="HEAD"))
    assert messages[0]["status"] == 200 and _body(messages) == b""
    assert not any(message["type"] == "http.response.pathsend" for message in messages)
    assert response.opened.descriptor is None


def test_short_reads_fill_the_protocol_body(isolated_runtime, tmp_path, monkeypatch):
    response = _response(tmp_path)
    original_read = os.read
    monkeypatch.setattr(os, "read", lambda fd, count: original_read(fd, min(count, 2)))
    assert _body(asyncio.run(_consume(response))) == b"0123456789"
    assert response.opened.descriptor is None


@pytest.mark.parametrize("headers", [[], [(b"range", b"bytes=1-2")], [(b"range", b"bytes=0-1,8-9")]])
def test_permission_change_before_headers_sends_no_response(isolated_runtime, tmp_path, monkeypatch, headers):
    response = _response(tmp_path)
    original = response.opened.assert_bound
    calls = 0
    def revoked_after_initial_check():
        nonlocal calls
        calls += 1
        if calls == 2:
            raise PermissionError("read authority revoked before response headers")
        return original()
    monkeypatch.setattr(response.opened, "assert_bound", revoked_after_initial_check)
    messages = []
    with pytest.raises(web_server.HTTPException) as refused:
        asyncio.run(_consume(response, headers, messages=messages))
    assert refused.value.status_code == 403 and messages == []
    assert response.opened.descriptor is None


@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
def test_send_failure_and_cancellation_close_descriptor(isolated_runtime, tmp_path, error_type):
    response = _response(tmp_path)
    with pytest.raises(error_type):
        asyncio.run(_consume(response, send_error=error_type()))
    assert response.opened.descriptor is None


def test_file_replacement_never_sends_canary(isolated_runtime, tmp_path):
    response = _response(tmp_path)
    replacement = tmp_path / "replacement.txt"
    replacement.write_bytes(b"credential-canary")
    try:
        os.replace(replacement, response.opened.path)
    except PermissionError:
        # A native sharing denial is the stronger alternative to substitution.
        messages = asyncio.run(_consume(response))
        assert _body(messages) == b"0123456789"
        assert replacement.read_bytes() == b"credential-canary"
    else:
        with pytest.raises(web_server.HTTPException) as refused:
            asyncio.run(_consume(response))
        assert refused.value.status_code == 403
    assert response.opened.descriptor is None


def test_runtime_credential_hardlink_alias_is_not_readable(isolated_runtime, tmp_path):
    credential = isolated_runtime / "config.yaml"
    credential.write_bytes(b"credential-canary")
    alias = tmp_path / "innocent.txt"
    os.link(credential, alias)
    with pytest.raises(web_server.HTTPException) as refused:
        web_server._open_dashboard_file(alias, 100)
    assert refused.value.status_code == 403
    assert credential.read_bytes() == b"credential-canary"


def test_runtime_config_symlink_protects_innocent_external_name(isolated_runtime, tmp_path):
    external = tmp_path / "settings.txt"
    external.write_bytes(b"credential-canary")
    link = isolated_runtime / "config.yaml"
    try:
        link.symlink_to(external)
    except OSError as error:
        if os.name == "nt" and getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows file-symlink privilege unavailable; execute this case on Linux")
        raise
    with pytest.raises(web_server.HTTPException) as refused:
        web_server._open_dashboard_file(external, 100)
    assert refused.value.status_code == 403
    assert external.read_bytes() == b"credential-canary"
