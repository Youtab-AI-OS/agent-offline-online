from __future__ import annotations

import json
import io
import subprocess
import sys

import pytest

from .helpers import keypair, signed_envelope


def test_worker_accepts_signed_command_without_public_listener() -> None:
    private, public = keypair()
    envelope = signed_envelope(private)

    completed = subprocess.run(
        [sys.executable, "-m", "youtab_runtime.worker", "--public-key", public],
        input=envelope.model_dump_json() + "\n",
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    result = json.loads(completed.stdout)
    assert completed.returncode == 0
    assert result["accepted"] is True
    assert result["runtime_authority"] is False
    assert result["public_listener"] is False


def test_worker_rejects_tampered_command() -> None:
    private, public = keypair()
    envelope = signed_envelope(private).model_copy(update={"objective": "tampered"})

    completed = subprocess.run(
        [sys.executable, "-m", "youtab_runtime.worker", "--public-key", public],
        input=envelope.model_dump_json() + "\n",
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    result = json.loads(completed.stdout)
    assert completed.returncode == 2
    assert result["accepted"] is False
    assert result["error"] == "command rejected"


def test_worker_policy_rejection_does_not_echo_unlabeled_tool_name() -> None:
    private, public = keypair()
    canary = "OPAQUE_WORKER_POLICY_CANARY_20261013"
    envelope = signed_envelope(private, allowed_toolsets=("effect_authority", canary))
    completed = subprocess.run(
        [sys.executable, "-m", "youtab_runtime.worker", "--public-key", public],
        input=envelope.model_dump_json() + "\n", text=True,
        capture_output=True, check=False, timeout=10,
    )
    assert completed.returncode == 2
    assert json.loads(completed.stdout) == {"accepted": False, "error": "command rejected"}
    assert canary not in completed.stdout + completed.stderr


def test_worker_opaque_policy_exception_stays_off_wire(monkeypatch) -> None:
    from youtab_runtime import worker

    private, public = keypair()
    canary = "OPAQUE_WORKER_EXCEPTION_CANARY_20261013"
    monkeypatch.setattr(worker.sys, "argv", ["worker", "--public-key", public])
    monkeypatch.setattr(worker.sys, "stdin", io.StringIO(
        signed_envelope(private).model_dump_json() + "\n"
    ))
    output = io.StringIO()
    monkeypatch.setattr(worker.sys, "stdout", output)
    def reject(_self, _envelope, _public_key):
        raise ValueError(canary)
    monkeypatch.setattr(worker.AuthorityBoundary, "admit", reject)
    assert worker.main() == 2
    assert json.loads(output.getvalue()) == {"accepted": False, "error": "command rejected"}
    assert canary not in output.getvalue()


@pytest.mark.parametrize("rejected_input", [
    {"id_token": {"values": ["SYNTHETIC_WORKER_CREDENTIAL_20261011"]}},
    {"authorization": "Bearer SYNTHETIC_WORKER_CREDENTIAL_20261011"},
    {"endpoint": "https://user:SYNTHETIC_WORKER_CREDENTIAL_20261011@example.invalid/"},
    {"SYNTHETIC_WORKER_CREDENTIAL_20261011": "untrusted extra field name"},
])
def test_worker_validation_rejection_does_not_echo_nested_input(rejected_input):
    private, public = keypair()
    payload = signed_envelope(private).model_dump(mode="json")
    payload.update(rejected_input)
    completed = subprocess.run(
        [sys.executable, "-m", "youtab_runtime.worker", "--public-key", public],
        input=json.dumps(payload) + "\n", text=True, capture_output=True,
        check=False, timeout=10,
    )
    assert completed.returncode == 2
    result = json.loads(completed.stdout)
    assert result["accepted"] is False
    assert "invalid command envelope" in result["error"]
    assert "validation errors" in result["error"]
    assert "SYNTHETIC_WORKER_CREDENTIAL_20261011" not in completed.stdout + completed.stderr
