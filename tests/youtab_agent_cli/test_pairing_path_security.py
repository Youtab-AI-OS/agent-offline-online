"""Invalid dashboard pairing platforms produce an HTTP 400 refusal."""

from unittest.mock import patch
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from gateway.pairing import PairingStore
from youtab_agent_cli import web_server as ws


@pytest.mark.asyncio
@pytest.mark.parametrize("platform", ["../../victim", r"..\..\victim", "C:victim", "victim\x00"])
@pytest.mark.parametrize("route", ["approve", "revoke"])
async def test_invalid_platform_http_400_before_storage(tmp_path, platform, route):
    home = tmp_path / "home"
    with patch("gateway.pairing.PAIRING_DIR", home / "pairing"), patch(
        "gateway.pairing.get_youtab_home", return_value=home
    ):
        store = PairingStore()
    with patch.object(ws, "_pairing_store", return_value=store), patch.object(
        store, "_load_json"
    ) as load, patch.object(store, "_save_json") as save:
        with pytest.raises(ws.HTTPException) as exc:
            if route == "approve":
                await ws.approve_pairing(Request({"type": "http"}),
                                         ws.PairingApprove(platform=platform, code="ABCDEFGH"))
            else:
                await ws.revoke_pairing(ws.PairingRevoke(platform=platform, user_id="synthetic-user"))
        assert exc.value.status_code == 400
        load.assert_not_called()
        save.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("target_field", ["request_id", "code"])
async def test_request_id_scope_refusal_precedes_platform_store_access(tmp_path, target_field):
    home = tmp_path / "home"
    with patch("gateway.pairing.PAIRING_DIR", home / "pairing"), patch(
        "gateway.pairing.get_youtab_home", return_value=home
    ):
        store = PairingStore()
    with patch.object(ws, "_pairing_store", return_value=store), patch.object(
        ws, "_principal_for_request", return_value=SimpleNamespace(has=lambda scope: False)
    ), patch.object(store, "approve_request") as approve, patch.object(store, "_load_json") as load, patch.object(
        store, "_save_json"
    ) as save:
        response = await ws.approve_pairing(Request({"type": "http"}), ws.PairingApprove(
            platform="../../victim", **{target_field: "a" * 16}
        ))
        assert response.status_code == 403
        approve.assert_not_called()
        load.assert_not_called()
        save.assert_not_called()
