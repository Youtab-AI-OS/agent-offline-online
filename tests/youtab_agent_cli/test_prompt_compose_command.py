"""Tests for the CLI `/prompt` editor-compose command.

`/prompt` opens `$VISUAL`/`$EDITOR` on a temp markdown file so the user can
hand-edit a multi-line prompt, then queues the saved buffer as the next
agent turn via the one-shot `_pending_agent_seed` (same path `/blueprint`
uses). These drive a fake editor subprocess to verify read-back, header
stripping, seeding, and the empty-buffer cancel path.
"""

import shlex
import sys
from pathlib import Path

import pytest

from youtab_agent_cli.cli_commands_mixin import CLICommandsMixin
from youtab_agent_cli.commands import resolve_command


class _Stub(CLICommandsMixin):
    def __init__(self):
        self._pending_agent_seed = None


def _fake_editor(tmp_path, body: str, mode: str = "append") -> str:
    """Run an isolated Python editor on either native platform."""
    editor = tmp_path / "synthetic editor.py"
    editor.write_text(
        "import sys\nfrom pathlib import Path\np = Path(sys.argv[1])\n"
        + (f"p.write_text(p.read_text(encoding='utf-8') + {body!r}, encoding='utf-8')\n"
           if mode == "append" else "p.write_text('', encoding='utf-8')\n"),
        encoding="utf-8",
    )
    return shlex.join([Path(sys.executable).as_posix(), editor.as_posix()])


@pytest.fixture(autouse=True)
def _no_visual(monkeypatch):
    monkeypatch.delenv("VISUAL", raising=False)


def test_command_registered():
    cd = resolve_command("prompt")
    assert cd and cd.name == "prompt"
    assert resolve_command("compose").name == "prompt"


def test_compose_reads_and_strips_header(monkeypatch, tmp_path):
    monkeypatch.setenv("EDITOR", _fake_editor(tmp_path, "Refactor the auth module.\nUse pytest."))
    out = _Stub()._compose_in_editor("")
    assert "Refactor the auth module." in out
    assert "Use pytest." in out
    assert "#!" not in out  # the instructional header is stripped


def test_empty_buffer_does_not_seed(monkeypatch, tmp_path):
    monkeypatch.setenv("EDITOR", _fake_editor(tmp_path, "", mode="clear"))
    s = _Stub()
    s._handle_prompt_compose_command("/prompt")
    assert s._pending_agent_seed is None
