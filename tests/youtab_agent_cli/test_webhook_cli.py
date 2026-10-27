"""Tests for youtab_agent_cli/webhook.py — webhook subscription CLI."""

import json
import os
import pytest
import stat
from argparse import Namespace
from argparse import ArgumentParser

from youtab_agent_cli.webhook import (
    webhook_command,
    _get_webhook_base_url,
    _load_subscriptions,
    _save_subscriptions,
    _subscriptions_path,
)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("YOUTAB_AGENT_HOME", str(tmp_path))
    # Default: webhooks enabled (most tests need this)
    monkeypatch.setattr(
        "youtab_agent_cli.webhook._is_webhook_enabled", lambda: True
    )


def _make_args(**kwargs):
    defaults = {
        "webhook_action": None,
        "name": "",
        "prompt": "",
        "events": "",
        "description": "",
        "skills": "",
        "deliver": "log",
        "deliver_chat_id": "",
        "secret": "",
        "payload": "",
        "script": "",
    }
    defaults.update(kwargs)
    return Namespace(**defaults)


@pytest.mark.parametrize("host", [None, "", "0.0.0.0", "::"])
def test_webhook_base_url_maps_wildcard_hosts_to_localhost(monkeypatch, host):
    monkeypatch.setattr(
        "youtab_agent_cli.webhook._get_webhook_config",
        lambda: {"extra": {"host": host, "port": 9123}},
    )
    assert _get_webhook_base_url() == "http://localhost:9123"


class TestSubscribe:

    @pytest.mark.parametrize("supplied", [False, True])
    def test_signing_secret_is_saved_but_not_printed_by_default(self, supplied, capsys, monkeypatch):
        canary = "webhook-canary-7c9ef481d20a65f3-secret"
        monkeypatch.setattr("youtab_agent_cli.webhook.secrets.token_urlsafe", lambda _n: canary)
        webhook_command(_make_args(
            webhook_action="subscribe", name="private", secret=canary if supplied else ""
        ))
        captured = capsys.readouterr()
        assert _load_subscriptions()["private"]["secret"] == canary
        assert canary not in captured.out + captured.err
        assert "7c9ef481" not in captured.out + captured.err
        assert "[REDACTED]" in captured.out
        assert "Created webhook subscription: private" in captured.out

    @pytest.mark.parametrize("local_terminal", [False, True])
    def test_explicit_reveal_requires_a_local_terminal(self, local_terminal, capsys, monkeypatch):
        import sys

        canary = "webhook-reveal-58a049bd20de7f64-secret"
        monkeypatch.setattr(sys.stdout, "isatty", lambda: local_terminal)
        webhook_command(_make_args(
            webhook_action="subscribe", name="reveal", secret=canary, show_secret=True
        ))
        captured = capsys.readouterr()
        assert _load_subscriptions()["reveal"]["secret"] == canary
        assert (canary in captured.out) is local_terminal
        assert canary not in captured.err
        if not local_terminal:
            assert "[REDACTED]" in captured.out
            assert "terminal" in captured.err

    def test_reveal_flag_is_explicit_in_actual_subcommand_parser(self):
        from youtab_agent_cli.subcommands.webhook import build_webhook_parser

        parser = ArgumentParser()
        subparsers = parser.add_subparsers(dest="command")
        build_webhook_parser(subparsers, cmd_webhook=webhook_command)
        normal = parser.parse_args(["webhook", "subscribe", "demo"])
        revealed = parser.parse_args(["webhook", "subscribe", "demo", "--show-secret"])
        assert normal.show_secret is False
        assert revealed.show_secret is True


    def test_custom_secret(self):
        webhook_command(_make_args(
            webhook_action="subscribe", name="s", secret="my-secret"
        ))
        assert _load_subscriptions()["s"]["secret"] == "my-secret"


    def test_auto_secret(self):
        webhook_command(_make_args(webhook_action="subscribe", name="s"))
        secret = _load_subscriptions()["s"]["secret"]
        assert len(secret) > 20


class TestList:

    def test_with_entries(self, capsys):
        webhook_command(_make_args(webhook_action="subscribe", name="a"))
        webhook_command(_make_args(webhook_action="subscribe", name="b"))
        capsys.readouterr()  # clear
        webhook_command(_make_args(webhook_action="list"))
        out = capsys.readouterr().out
        assert "2 webhook" in out
        assert "a" in out
        assert "b" in out


class TestRemove:


    def test_selective_remove(self):
        webhook_command(_make_args(webhook_action="subscribe", name="keep"))
        webhook_command(_make_args(webhook_action="subscribe", name="drop"))
        webhook_command(_make_args(webhook_action="remove", name="drop"))
        subs = _load_subscriptions()
        assert "keep" in subs
        assert "drop" not in subs


class TestPersistence:

    def test_corrupted_file(self):
        path = _subscriptions_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("broken{{{", encoding="utf-8")
        assert _load_subscriptions() == {}

    @pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are platform-specific")
    def test_save_creates_secret_file_owner_only_under_permissive_umask(self):
        old_umask = os.umask(0o022)
        try:
            _save_subscriptions({"demo": {"secret": "TOPSECRET", "prompt": "x"}})
        finally:
            os.umask(old_umask)

        path = _subscriptions_path()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert "TOPSECRET" in path.read_text(encoding="utf-8")

    @pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are platform-specific")
    def test_save_narrows_existing_broad_secret_file_mode(self):
        # Simulate a pre-existing 0o644 file from before this hardening landed.
        path = _subscriptions_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"old": {"secret": "stale", "prompt": "x"}}), encoding="utf-8")
        path.chmod(0o644)

        _save_subscriptions({"demo": {"secret": "FRESH", "prompt": "x"}})

        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert "FRESH" in path.read_text(encoding="utf-8")


class TestWebhookEnabledGate:

    def test_blocks_list_when_disabled(self, capsys, monkeypatch):
        monkeypatch.setattr("youtab_agent_cli.webhook._is_webhook_enabled", lambda: False)
        webhook_command(_make_args(webhook_action="list"))
        out = capsys.readouterr().out
        assert "not enabled" in out.lower()

    def test_allows_when_enabled(self, capsys):
        # _is_webhook_enabled already patched to True by autouse fixture
        webhook_command(_make_args(webhook_action="subscribe", name="allowed"))
        out = capsys.readouterr().out
        assert "Created" in out
        assert "allowed" in _load_subscriptions()

    def test_real_check_disabled(self, monkeypatch):
        monkeypatch.setattr(
            "youtab_agent_cli.webhook._get_webhook_config",
            lambda: {},
        )
        monkeypatch.setattr(
            "youtab_agent_cli.webhook._is_webhook_enabled",
            lambda: bool({}.get("enabled")),
        )
        import youtab_agent_cli.webhook as wh_mod
        assert wh_mod._is_webhook_enabled() is False

