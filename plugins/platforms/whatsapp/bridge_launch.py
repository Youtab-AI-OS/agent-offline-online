"""One verified codec/private-parent contract for all managed bridge launchers."""
import os
from pathlib import Path
import subprocess
import tempfile
from threading import RLock

from .managed_codec import FFMPEG_FILES, resolve_managed_ffmpeg
from tools.environments.windows_private_directory import WindowsPrivateDirectory

_release_lock = RLock()


def prepare_bridge_environment(environment, repo_root):
    executable = resolve_managed_ffmpeg(repo_root)
    if executable is not None:
        environment["YOUTAB_AGENT_WHATSAPP_FFMPEG_EXE"] = str(executable)
        environment["YOUTAB_AGENT_WHATSAPP_FFMPEG_SHA256"] = FFMPEG_FILES["bin/ffmpeg.exe"][1]
    if os.name == "nt":
        private = WindowsPrivateDirectory(Path(tempfile.gettempdir()), prefix="youtab-whatsapp-")
        directory = private.path
    else:
        private = tempfile.TemporaryDirectory(prefix="youtab-whatsapp-")
        directory = private.name
    try:
        environment["YOUTAB_AGENT_WHATSAPP_PRIVATE_TMP_PARENT"] = str(directory)
    except BaseException:
        close_bridge_parent(private)
        raise
    return private


def close_bridge_parent(private):
    with _release_lock:
        if os.name == "nt":
            private.close()
        else:
            private.cleanup()


def spawn_managed_bridge(command, *, repo_root, env, stdin=subprocess.DEVNULL, **kwargs):
    environment = dict(env)
    private = prepare_bridge_environment(environment, repo_root)
    try:
        process = subprocess.Popen(command, env=environment, stdin=stdin, **kwargs)
    except BaseException:
        close_bridge_parent(private)
        raise
    process._youtab_bridge_private_temp = private
    return process


def release_managed_bridge_parent(process):
    """Release only our attached parent after the actual owned child exits."""
    with _release_lock:
        private = getattr(process, "_youtab_bridge_private_temp", None)
        if not isinstance(private, (WindowsPrivateDirectory, tempfile.TemporaryDirectory)):
            return True
        if process.poll() is None:
            return False
        close_bridge_parent(private)
        process._youtab_bridge_private_temp = None
        return True
