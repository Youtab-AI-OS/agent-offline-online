"""Resolve a Windows customer Runtime's versioned CLI launch contract.

Legacy source installs continue to use their interpreter and module entrypoint.
Once Setup has installed a managed artifact, a missing or damaged CLI is a
repair condition; launching source code from another checkout is not recovery.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path

_SHA40 = re.compile(r"[0-9a-f]{40}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_MARKER = ".youtab-agent-runtime-bootstrap-complete"
_CONTRACT = "runtime-desktop.json"


class ManagedRuntimeRepairRequired(RuntimeError):
    """The active managed installation needs Setup repair before launch."""


def windows_runtime_command(python_path: str, arguments: list[str]) -> list[str]:
    """Choose the managed ``youtab.exe`` or the legacy source module.

    ``python_path`` must be the active Runtime venv interpreter, not an
    arbitrary Python found on PATH. The contract and receipt are produced by
    the shared Setup and bind the CLI to that same installation root.
    """
    python = Path(python_path)
    legacy = [python_path, "-m", "youtab_agent_cli.main", *arguments]
    if python.name.lower() not in {"python.exe", "pythonw.exe"} or python.parent.name.lower() != "scripts":
        return legacy
    if python.parent.parent.name.lower() != "venv":
        return legacy

    root = python.parent.parent.parent
    contract_path = root / _CONTRACT
    marker_path = root / _MARKER
    if not contract_path.exists() and not marker_path.exists():
        return legacy

    try:
        if marker_path.is_symlink() or marker_path.stat().st_size > 4096:
            raise ValueError("receipt is not a bounded regular file")
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        if contract_path.exists():
            raise ManagedRuntimeRepairRequired("managed Runtime receipt is missing or unreadable") from exc
        return legacy
    if not isinstance(marker, dict):
        raise ManagedRuntimeRepairRequired("managed Runtime receipt is invalid")
    if not contract_path.exists() and "artifactSha256" not in marker and "runtimeContractSha256" not in marker:
        return legacy

    try:
        if contract_path.is_symlink() or not contract_path.is_file() or contract_path.stat().st_size > 4096:
            raise ValueError("contract is not a bounded regular file")
        content = contract_path.read_bytes()
        contract = json.loads(content)
        digest = hashlib.sha256(content).hexdigest()
    except (OSError, UnicodeError, ValueError) as exc:
        raise ManagedRuntimeRepairRequired("managed Runtime contract is missing or invalid") from exc
    if not isinstance(contract, dict) or set(contract) != {"schemaVersion", "sourceSha", "version", "entrypoint", "capabilities"}:
        raise ManagedRuntimeRepairRequired("managed Runtime contract has unsupported fields")
    if (
        not content
        or marker.get("schemaVersion") != 1
        or not isinstance(marker.get("artifactSha256"), str)
        or not _SHA256.fullmatch(marker["artifactSha256"])
        or marker.get("runtimeContractSha256") != digest
        or contract.get("schemaVersion") != 1
        or contract.get("entrypoint") != "venv/Scripts/youtab.exe"
        or contract.get("capabilities") != ["serve"]
        or not isinstance(contract.get("sourceSha"), str)
        or not _SHA40.fullmatch(contract["sourceSha"])
        or marker.get("pinnedCommit") != contract["sourceSha"]
        or not isinstance(contract.get("version"), str)
        or not _VERSION.fullmatch(contract["version"])
        or marker.get("version") != contract["version"]
    ):
        raise ManagedRuntimeRepairRequired("managed Runtime receipt and contract disagree")

    cli = root / "venv" / "Scripts" / "youtab.exe"
    if cli.is_symlink() or not cli.is_file():
        raise ManagedRuntimeRepairRequired("managed Runtime CLI is missing; repair with Youtab Setup")
    try:
        probe = subprocess.run(
            [str(cli), "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ManagedRuntimeRepairRequired("managed Runtime CLI did not start; repair with Youtab Setup") from exc
    if probe.returncode != 0 or "Youtab Agent Runtime v" not in probe.stdout[:4096]:
        raise ManagedRuntimeRepairRequired("managed Runtime CLI failed its identity probe; repair with Youtab Setup")
    return [str(cli), *arguments]
