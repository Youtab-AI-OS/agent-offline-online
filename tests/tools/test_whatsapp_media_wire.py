"""Run the actual internal bridge wire contracts in the canonical Python gate."""
from pathlib import Path
import shutil
import subprocess


def test_whatsapp_media_wire_contracts():
    node = shutil.which("node")
    assert node, "The common Runtime media wire gate requires Node.js"
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [node, "--test", str(root / "scripts/whatsapp-bridge/media-wire.test.js")],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
