"""Saved endpoint tests use synthetic credentials and never touch the network."""
import copy

import pytest


@pytest.fixture
def endpoint_client(monkeypatch, _isolate_youtab_home):
    from starlette.testclient import TestClient
    from youtab_agent_cli import web_server as ws
    cfg = {"providers": {"saved": {"name": "Saved", "base_url": "https://model.example/v1", "model": "model-a", "models": {"model-a": {"context_length": 1234}}, "key_env": "TEST_ENDPOINT_KEY"}}}
    monkeypatch.setattr(ws, "load_config", lambda: copy.deepcopy(cfg))
    monkeypatch.setattr(ws, "get_env_value", lambda name: "synthetic-private-key" if name == "TEST_ENDPOINT_KEY" else None)
    calls = []
    def probe(url, api_key=""):
        calls.append((url, api_key))
        return {"ok": True, "reachable": True, "models": ["model-b"], "base_url": url, "message": ""}
    monkeypatch.setattr(ws, "_probe_custom_endpoint", probe)
    client = TestClient(ws.app)
    client.headers[ws._SESSION_HEADER_NAME] = ws._SESSION_TOKEN
    return ws, client, cfg, calls


@pytest.mark.parametrize("url", ["https://model.example/v1", "https://MODEL.example:443/v1/"])
def test_validation_uses_saved_key_only_for_same_canonical_url(endpoint_client, url):
    _ws, client, _cfg, calls = endpoint_client
    response = client.post("/api/providers/custom-endpoints/validate", json={"id": "saved", "name": "Saved", "model": "model-a", "base_url": url})
    assert response.status_code == 200
    assert calls == [(url, "synthetic-private-key")]
    assert "synthetic-private-key" not in response.text


@pytest.mark.parametrize("url", ["https://other.example/v1", "http://model.example/v1", "https://model.example/v2", "https://model.example:444/v1", "https://user@model.example/v1", "https://model.example/v1?target=elsewhere"])
def test_validation_does_not_forward_saved_key_to_changed_target(endpoint_client, url):
    _ws, client, _cfg, calls = endpoint_client
    response = client.post("/api/providers/custom-endpoints/validate", json={"id": "saved", "name": "Saved", "model": "model-a", "base_url": url})
    assert response.status_code == 200
    assert calls == [(url, "")]
    assert "synthetic-private-key" not in response.text


def test_explicit_key_is_used_instead_of_saved_key(endpoint_client):
    _ws, client, _cfg, calls = endpoint_client
    response = client.post("/api/providers/custom-endpoints/validate", json={"id": "saved", "name": "Saved", "model": "model-a", "base_url": "https://other.example/v1", "api_key": "synthetic-new-key"})
    assert response.status_code == 200
    assert calls == [("https://other.example/v1", "synthetic-new-key")]


def test_saving_retarget_without_new_key_is_denied_without_changing_original(endpoint_client):
    ws, client, cfg, _calls = endpoint_client
    original = copy.deepcopy(cfg)
    response = client.post("/api/providers/custom-endpoints", json={"id": "saved", "name": "Saved", "base_url": "https://other.example/v1", "model": "model-b"})
    assert response.status_code == 400
    assert "address changed" in response.json()["detail"]
    assert cfg == original


@pytest.mark.parametrize("metadata", ["extra_headers", "request_overrides"])
def test_advanced_auth_metadata_cannot_be_carried_to_another_url(endpoint_client, metadata):
    _ws, client, cfg, _calls = endpoint_client
    cfg["providers"]["saved"][metadata] = {"Authorization": "synthetic-other-secret"}
    original = copy.deepcopy(cfg)
    response = client.post("/api/providers/custom-endpoints", json={"id": "saved", "name": "Saved", "base_url": "https://other.example/v1", "model": "model-b", "api_key": "new-key"})
    assert response.status_code == 400
    assert "Create a new endpoint" in response.json()["detail"]
    assert cfg == original
    assert "synthetic-other-secret" not in response.text


def test_retarget_with_explicit_new_key_drops_old_model_catalogue(endpoint_client, monkeypatch):
    ws, client, _cfg, _calls = endpoint_client
    saved = []
    monkeypatch.setattr(ws, "save_config", lambda value: saved.append(value))
    monkeypatch.setattr(ws, "save_env_value", lambda *_args: None)
    response = client.post("/api/providers/custom-endpoints", json={"id": "saved", "name": "Saved", "base_url": "https://other.example/v1", "model": "model-b", "models": ["model-b"], "api_key": "synthetic-new-key", "make_default": False})
    assert response.status_code == 200
    entry = saved[0]["providers"]["saved"]
    assert entry["models"] == {"model-b": {}}
    assert "api_key" not in entry


def test_active_retarget_cannot_replace_shared_key_while_leaving_old_model_url(endpoint_client, monkeypatch):
    ws, client, cfg, _calls = endpoint_client
    cfg["model"] = {"provider": "saved", "base_url": "https://model.example/v1", "key_env": "TEST_ENDPOINT_KEY"}
    written = []
    monkeypatch.setattr(ws, "save_env_value", lambda *args: written.append(args))
    response = client.post("/api/providers/custom-endpoints", json={"id": "saved", "name": "Saved", "base_url": "https://other.example/v1", "model": "model-b", "api_key": "synthetic-new-key", "make_default": False})
    assert response.status_code == 400
    assert written == []
    assert cfg["model"]["base_url"] == "https://model.example/v1"


@pytest.mark.parametrize("credential", ["api_key", "api", "key_env", "api_key_env"])
def test_direct_config_retarget_without_explicit_key_is_denied(endpoint_client, monkeypatch, credential):
    ws, client, cfg, _calls = endpoint_client
    cfg["providers"] = {}
    cfg["model"] = {"provider": "custom", "default": "model-a", "base_url": "https://model.example/v1", credential: "synthetic-old-credential"}
    original = copy.deepcopy(cfg)
    writes = []
    monkeypatch.setattr(ws, "save_config", lambda value: writes.append(value))
    monkeypatch.setattr(ws, "save_env_value", lambda *args: writes.append(args))
    response = client.post("/api/providers/custom-endpoints", json={"id": "custom", "name": "Custom", "base_url": "https://other.example/v1", "model": "model-b", "make_default": True})
    assert response.status_code == 400
    assert cfg == original
    assert writes == []
    assert "synthetic-old-credential" not in response.text


@pytest.mark.parametrize("new_url", ["https://model.example/v1", "https://other.example/v1"])
def test_explicit_key_clear_removes_all_old_main_aliases(endpoint_client, monkeypatch, new_url):
    ws, client, cfg, _calls = endpoint_client
    cfg["model"] = {"provider": "saved", "default": "model-a", "base_url": "https://model.example/v1", "api_key": "synthetic-old-key", "api": "synthetic-legacy-key", "key_env": "OLD_MODEL_KEY", "api_key_env": "OLD_MODEL_ALIAS"}
    saved = []
    removed = []
    monkeypatch.setattr(ws, "save_config", lambda value: saved.append(value))
    monkeypatch.setattr(ws, "remove_env_value", lambda value: removed.append(value))
    response = client.post("/api/providers/custom-endpoints", json={"id": "saved", "name": "Saved", "base_url": new_url, "model": "model-b", "api_key": "", "make_default": True})
    assert response.status_code == 200
    main = saved[0]["model"]
    assert main["base_url"] == new_url
    for field in ("api_key", "api", "key_env", "api_key_env"):
        assert field not in main
        assert field not in saved[0]["providers"]["saved"]
    assert removed
    assert "synthetic-old-key" not in response.text
    assert "synthetic-legacy-key" not in response.text


def test_retarget_replacement_key_binds_only_new_main_reference(endpoint_client, monkeypatch):
    ws, client, cfg, _calls = endpoint_client
    cfg["model"] = {"provider": "saved", "default": "model-a", "base_url": "https://model.example/v1", "api_key": "synthetic-old-key", "api": "synthetic-legacy-key", "key_env": "OLD_MODEL_KEY", "api_key_env": "OLD_MODEL_ALIAS"}
    saved = []
    written = []
    monkeypatch.setattr(ws, "save_config", lambda value: saved.append(value))
    monkeypatch.setattr(ws, "save_env_value", lambda *args: written.append(args))
    response = client.post("/api/providers/custom-endpoints", json={"id": "saved", "name": "Saved", "base_url": "https://other.example/v1", "model": "model-b", "api_key": "synthetic-new-key", "make_default": True})
    assert response.status_code == 200
    main = saved[0]["model"]
    assert main["base_url"] == "https://other.example/v1"
    assert main["key_env"] == saved[0]["providers"]["saved"]["key_env"]
    assert written == [(main["key_env"], "synthetic-new-key")]
    assert all(field not in main for field in ("api_key", "api", "api_key_env"))
    assert "OLD_MODEL_KEY" not in str(main)
    assert "synthetic-old-key" not in str(saved)


@pytest.mark.parametrize("replacement", ["", "synthetic-new-key"])
def test_active_key_edit_without_model_reapply_reconciles_only_credentials(endpoint_client, monkeypatch, replacement):
    ws, client, cfg, _calls = endpoint_client
    cfg["model"] = {"provider": "saved", "default": "keep-current-model", "base_url": "https://model.example/v1", "context_length": 12345, "temperature": 0.3, "api_key": "synthetic-old-key", "api": "synthetic-legacy-key", "key_env": "OLD_MODEL_KEY", "api_key_env": "OLD_MODEL_ALIAS"}
    saved = []
    monkeypatch.setattr(ws, "save_config", lambda value: saved.append(value))
    monkeypatch.setattr(ws, "remove_env_value", lambda *_args: None)
    monkeypatch.setattr(ws, "save_env_value", lambda *_args: None)
    response = client.post("/api/providers/custom-endpoints", json={"id": "saved", "name": "Saved", "base_url": "https://model.example/v1", "model": "not-applied-model", "api_key": replacement, "make_default": False})
    assert response.status_code == 200
    main = saved[0]["model"]
    assert {key: main[key] for key in ("provider", "default", "base_url", "context_length", "temperature")} == {key: cfg["model"][key] for key in ("provider", "default", "base_url", "context_length", "temperature")}
    assert all(field not in main for field in ("api_key", "api", "api_key_env"))
    if replacement:
        assert main["key_env"] == saved[0]["providers"]["saved"]["key_env"]
    else:
        assert "key_env" not in main


@pytest.mark.parametrize("location", ["direct-config", "main-mirror"])
@pytest.mark.parametrize("metadata", ["extra_headers", "request_overrides"])
def test_model_only_advanced_credentials_cannot_retarget(endpoint_client, monkeypatch, location, metadata):
    ws, client, cfg, _calls = endpoint_client
    provider = "custom" if location == "direct-config" else "saved"
    if location == "direct-config":
        cfg["providers"] = {}
    cfg["model"] = {"provider": provider, "default": "model-a", "base_url": "https://model.example/v1", metadata: {"Authorization": "synthetic-mirror-header"}}
    saved = []
    monkeypatch.setattr(ws, "save_config", lambda value: saved.append(value))
    response = client.post("/api/providers/custom-endpoints", json={"id": provider, "name": "Saved", "base_url": "https://other.example/v1", "model": "model-b", "api_key": "synthetic-new-key", "make_default": True})
    assert response.status_code == 400
    assert saved == []
    assert "synthetic-mirror-header" not in response.text


def test_activation_never_keeps_old_model_key_refs_or_headers(endpoint_client, monkeypatch):
    ws, client, cfg, _calls = endpoint_client
    cfg["providers"]["saved"].pop("key_env")
    cfg["model"] = {"provider": "other", "base_url": "https://old.example/v1", "api_key": "synthetic-old-key", "api": "synthetic-legacy-key", "key_env": "OLD_MODEL_KEY", "api_key_env": "OLD_MODEL_ALIAS", "extra_headers": {"Authorization": "synthetic-old-header"}, "request_overrides": {"headers": {"X-Key": "synthetic-old-header"}}}
    saved = []
    monkeypatch.setattr(ws, "save_config", lambda value: saved.append(value))
    response = client.post("/api/providers/custom-endpoints/saved/activate", json={})
    assert response.status_code == 200
    main = saved[0]["model"]
    assert main["base_url"] == "https://model.example/v1"
    assert all(field not in main for field in ("api_key", "api", "key_env", "api_key_env", "extra_headers", "request_overrides"))


def test_real_config_direct_retarget_denial_does_not_write_original(_isolate_youtab_home):
    from starlette.testclient import TestClient
    from youtab_agent_cli import web_server as ws
    from youtab_agent_cli.config import get_config_path, save_config
    save_config({"model": {"provider": "custom", "default": "model-a", "base_url": "https://model.example/v1", "api_key": "synthetic-direct-old-key"}}, strip_defaults=False)
    original = get_config_path().read_bytes()
    client = TestClient(ws.app)
    client.headers[ws._SESSION_HEADER_NAME] = ws._SESSION_TOKEN
    response = client.post("/api/providers/custom-endpoints", json={"id": "custom", "name": "Custom", "base_url": "https://other.example/v1", "model": "model-b", "make_default": True})
    assert response.status_code == 400
    assert get_config_path().read_bytes() == original
    assert "synthetic-direct-old-key" not in response.text


def test_real_config_clear_reloads_and_runtime_does_not_resolve_old_secret(_isolate_youtab_home, monkeypatch):
    from starlette.testclient import TestClient
    from youtab_agent_cli import runtime_provider as rp, web_server as ws
    from youtab_agent_cli.config import load_config, save_config
    save_config({"providers": {"saved": {"name": "Saved", "base_url": "https://model.example/v1", "model": "model-a", "api_key": "synthetic-provider-old-key"}}, "model": {"provider": "saved", "default": "model-a", "base_url": "https://model.example/v1", "api_key": "synthetic-main-old-key", "api": "synthetic-main-old-alias", "key_env": "OLD_MODEL_KEY", "api_key_env": "OLD_MODEL_ALIAS"}}, strip_defaults=False)
    client = TestClient(ws.app)
    client.headers[ws._SESSION_HEADER_NAME] = ws._SESSION_TOKEN
    response = client.post("/api/providers/custom-endpoints", json={"id": "saved", "name": "Saved", "base_url": "https://other.example/v1", "model": "model-b", "api_key": "", "make_default": True})
    assert response.status_code == 200
    reloaded = load_config()
    assert reloaded["model"]["base_url"] == "https://other.example/v1"
    assert all(field not in reloaded["model"] for field in ("api_key", "api", "key_env", "api_key_env"))
    # The real resolver consumes the reloaded config. Empty synthetic pools
    # and no unrelated host-derived env keys keep this deterministic/offline.
    monkeypatch.setattr(rp, "_try_resolve_from_custom_pool", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(rp, "_host_derived_api_key", lambda *_args: "")
    runtime = rp.resolve_runtime_provider(requested="saved", target_model="model-b")
    assert runtime["base_url"] == "https://other.example/v1"
    assert runtime["api_key"] == "no-key-required"
    assert "synthetic-main-old" not in str(runtime)
    assert "synthetic-provider-old-key" not in str(runtime)


def test_direct_same_url_preserves_env_reference_without_writing_secret_to_config(_isolate_youtab_home, monkeypatch):
    from starlette.testclient import TestClient
    from youtab_agent_cli import web_server as ws
    from youtab_agent_cli.config import get_config_path, load_config, save_config
    monkeypatch.setenv("SYNTHETIC_DIRECT_ENDPOINT_KEY", "synthetic-direct-env-secret")
    template = "${SYNTHETIC_DIRECT_ENDPOINT_KEY}"
    save_config({"model": {"provider": "custom", "default": "model-a", "base_url": "https://model.example/v1", "api_key": template}}, strip_defaults=False)
    client = TestClient(ws.app)
    client.headers[ws._SESSION_HEADER_NAME] = ws._SESSION_TOKEN
    response = client.post("/api/providers/custom-endpoints", json={"id": "custom", "name": "Custom", "base_url": "https://model.example/v1", "model": "model-b", "make_default": True})
    assert response.status_code == 200
    assert "synthetic-direct-env-secret" not in get_config_path().read_text(encoding="utf-8")
    assert template in get_config_path().read_text(encoding="utf-8")
    assert load_config()["model"]["api_key"] == "synthetic-direct-env-secret"
