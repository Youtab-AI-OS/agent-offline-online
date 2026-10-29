"""Signed webhook values retain dispatch bytes without forging physical log lines."""

import asyncio
import hashlib
import hmac
import io
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.base import SendResult
from gateway.platforms.webhook import WebhookAdapter, logger


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["event_type", "type"])
@pytest.mark.parametrize("branch", ["accepted", "ignored", "filter", "script", "direct"])
async def test_signed_event_log_is_one_bounded_line_with_original_handoff(
    tmp_path, monkeypatch, branch, field
):
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(tmp_path))
    event_type = "normal\nFORGED-WEBHOOK\ttrace\rsecond\x00" + "Z" * 256
    secret = "isolated-log-framing-test-secret"
    route = {"secret": secret, "prompt": "Event: {event_type}", "deliver": "log"}
    if branch == "ignored":
        route["events"] = ["push"]
    if branch == "script":
        route["script"] = "isolated-script-seam"
    if branch == "direct":
        route["deliver_only"] = True
    adapter = WebhookAdapter(PlatformConfig(enabled=True, extra={"routes": {"r": route}}))
    captured = []

    async def capture(event):
        captured.append(event)

    adapter.handle_message = capture
    delivery = AsyncMock(return_value=SendResult(success=True))
    monkeypatch.setattr(adapter, "_direct_deliver", delivery)
    if branch == "filter":
        monkeypatch.setattr(adapter._route_processor, "route_filters_match", lambda *args: False)
    if branch == "script":
        monkeypatch.setattr(adapter._route_processor, "run_route_script", lambda *args: (False, {}))
    payload = {field: event_type, "body": "untouched"}
    body = json.dumps(payload).encode()

    async def read():
        return body

    request = SimpleNamespace(
        match_info={"route_name": "r"},
        headers={
            "X-Hub-Signature-256": "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest(),
            "X-GitHub-Delivery": "isolated-delivery",
        },
        content_length=len(body),
        method="POST",
        read=read,
    )
    output = io.StringIO()
    handler = logging.StreamHandler(output)
    handler.setFormatter(logging.Formatter("%(levelname)s:%(message)s"))
    previous_level = logger.level
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        response = await adapter._handle_webhook(request)
        if adapter._background_tasks:
            await asyncio.gather(*list(adapter._background_tasks))
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
        handler.close()

    assert response.status == (202 if branch == "accepted" else 200)
    response_data = json.loads(response.text)
    if branch in {"accepted", "ignored"}:
        assert response_data["event"] == event_type
    if branch == "accepted":
        assert len(captured) == 1
        assert captured[0].text == "Event: " + event_type
        assert captured[0].raw_message == payload
    else:
        assert captured == []
    if branch == "direct":
        delivery.assert_awaited_once()
        assert delivery.call_args.args[0] == "Event: " + event_type
        assert delivery.call_args.args[1]["payload"] == payload
    else:
        delivery.assert_not_awaited()

    logged = output.getvalue()
    assert len(logged.splitlines()) == 1
    assert "\\nFORGED-WEBHOOK\\ttrace\\rsecond\\x00" in logged
    assert "Z" * 129 not in logged
    assert not any(value in logged for value in ("\r", "\t", "\x00"))
