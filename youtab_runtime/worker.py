"""Stdin/stdout admission worker; deliberately exposes no public listener."""

from __future__ import annotations

import argparse
import json
import sys

from pydantic import ValidationError

from .contracts import BrainCommandEnvelope
from .policy import AuthorityBoundary


def main() -> int:
    parser = argparse.ArgumentParser(description="Youtab managed task admission worker")
    parser.add_argument("--public-key", required=True)
    args = parser.parse_args()
    boundary = AuthorityBoundary()
    line = sys.stdin.readline()
    if not line:
        print(json.dumps({"accepted": False, "error": "missing command envelope"}))
        return 2
    try:
        envelope = BrainCommandEnvelope.model_validate_json(line)
        boundary.admit(envelope, args.public_key)
    except ValidationError as exc:
        # Pydantic renders rejected inputs, arbitrary field names and validator
        # context in its default string. None is needed to explain rejection.
        print(json.dumps({
            "accepted": False,
            "error": f"invalid command envelope ({exc.error_count()} validation errors)",
        }))
        return 2
    except ValueError:
        # Policy/verification messages can contain arbitrary caller-supplied
        # tool names and values. Keep the wire response independent of them.
        print(json.dumps({"accepted": False, "error": "command rejected"}))
        return 2
    print(
        json.dumps(
            {
                "accepted": True,
                "schema_version": envelope.schema_version,
                "command_id": envelope.command_id,
                "task_id": envelope.task_id,
                "tenant_id": envelope.tenant_id,
                "trace_id": envelope.trace_id,
                "runtime_authority": False,
                "public_listener": False,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
