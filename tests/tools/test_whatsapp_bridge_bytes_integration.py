"""Actual Node route/auth contracts and managed namespace lifetime."""
import os
from pathlib import Path
import shutil
import subprocess
from unittest.mock import MagicMock, patch

from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
from plugins.platforms.whatsapp.adapter import _bridge_codec_matches, _bridge_content_hash
from plugins.platforms.whatsapp.managed_codec import FFMPEG_FILES


def test_node_bytes_route_and_authentication():
    node = shutil.which("node")
    assert node, "WhatsApp bridge behavior gates require Node.js"
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([node, "--experimental-vm-modules", "--test",
                             "scripts/whatsapp-bridge/media-route.test.js",
                             "scripts/whatsapp-bridge/bridge-identity.test.mjs",
                             "scripts/whatsapp-bridge/bridge.authorization.test.mjs"],
                            cwd=root, capture_output=True, encoding="utf-8", errors="replace", timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr


def test_private_namespace_is_retained_until_owned_process_exit():
    adapter = WhatsAppAdapter.__new__(WhatsAppAdapter)
    process = MagicMock()
    process.poll.return_value = None
    private = MagicMock()
    adapter._bridge_process = process
    adapter._bridge_private_temp = private
    adapter._cleanup_bridge_private_temp()
    private.close.assert_not_called()
    private.cleanup.assert_not_called()
    assert adapter._bridge_private_temp is private
    process.poll.return_value = 0
    adapter._cleanup_bridge_private_temp()
    if os.name == "nt":
        private.close.assert_called_once()
    else:
        private.cleanup.assert_called_once()
    assert adapter._bridge_private_temp is None
    adapter._cleanup_bridge_private_temp()


def test_private_namespace_is_released_after_spawn_failure():
    adapter = WhatsAppAdapter.__new__(WhatsAppAdapter)
    adapter._bridge_process = None
    private = MagicMock()
    adapter._bridge_private_temp = private
    adapter._cleanup_bridge_private_temp()
    assert adapter._bridge_private_temp is None
    assert (private.close if os.name == "nt" else private.cleanup).call_count == 1


def test_managed_bridge_adoption_requires_actual_ready_codec_identity(tmp_path):
    executable = tmp_path / "ffmpeg.exe"
    with patch("plugins.platforms.whatsapp.adapter.resolve_managed_ffmpeg", return_value=executable):
        assert not _bridge_codec_matches({})
        assert not _bridge_codec_matches({"managedCodec": {"ready": True}})
        health = {"managedCodec": {"ready": True, "version": "9.0.2",
                                  "sha256": FFMPEG_FILES["bin/ffmpeg.exe"][1], "executable": str(executable)}}
        assert _bridge_codec_matches(health)
        health["managedCodec"]["executable"] = str(tmp_path / "other.exe")
        assert not _bridge_codec_matches(health)


def test_helper_only_update_changes_bridge_identity_and_matches_node(tmp_path):
    (tmp_path / "bridge.js").write_text("// original main\n")
    helper = tmp_path / "media-route.js"
    helper.write_text("// original helper\n")
    before = _bridge_content_hash(tmp_path)
    helper.write_text("// repaired helper\n")
    after = _bridge_content_hash(tmp_path)
    assert before != after
    (tmp_path / "ignored.test.js").write_text("// tests are not shipped\n")
    assert _bridge_content_hash(tmp_path) == after
    node = shutil.which("node")
    assert node
    module = (Path(__file__).resolve().parents[2] / "scripts/whatsapp-bridge/bridge-identity.js").as_uri()
    script = "import { bridgeContentHash } from " + repr(module) + "; console.log(bridgeContentHash(process.argv[1]));"
    result = subprocess.run([node, "--input-type=module", "-e", script, str(tmp_path)], capture_output=True, encoding="utf-8", timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == after
