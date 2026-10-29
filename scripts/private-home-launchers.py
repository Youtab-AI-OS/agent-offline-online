"""Render current gateway launchers for relocation; never invoke a gateway."""
import base64
import json
import re
import sys
from pathlib import Path


def render(runtime: Path, source_home: Path, target_home: Path, task: str, profile: str) -> dict:
    if profile == '-':
        profile = ''
    if not re.fullmatch(r"Youtab_Gateway(?:_[a-z0-9][a-z0-9_-]{0,63})?", task):
        raise ValueError("invalid existing gateway task identity")
    if profile and not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", profile):
        raise ValueError("invalid named profile")
    sys.path.insert(0, str(runtime))
    from youtab_agent_cli import gateway_windows as gateway
    python = runtime / "venv" / "Scripts" / "python.exe"
    if not python.is_file():
        raise ValueError("fresh target interpreter absent")
    old_script = source_home / "gateway-service" / (task + ".cmd")
    new_script = target_home / "gateway-service" / (task + ".cmd")
    profile_arg = "--profile " + profile if profile else ""
    encode = lambda text: base64.b64encode(text.encode("utf-8")).decode("ascii")
    return {
        "cmd": encode(gateway._build_gateway_cmd_script(str(python), str(target_home), str(target_home), profile_arg)),
        "vbs": encode(gateway._build_gateway_vbs_script(str(python), str(target_home), str(target_home), profile_arg)),
        "previousStartup": encode(gateway._build_startup_launcher(old_script)),
        "desiredStartup": encode(gateway._build_startup_launcher(new_script)),
    }


if __name__ == "__main__":
    if len(sys.argv) != 6:
        raise SystemExit("runtime source_home target_home task profile required")
    print(json.dumps(render(*map(Path, sys.argv[1:4]), *sys.argv[4:6])))
