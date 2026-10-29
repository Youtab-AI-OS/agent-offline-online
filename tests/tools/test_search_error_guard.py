"""Regression tests for the rg/grep error guard in content search.

The guard in ``_search_with_rg`` / ``_search_with_grep`` had two defects on
``origin/main`` (see PR replacing #39710):

1. **Unreachable on a hard error.** Both methods pipe the search through
   ``| head`` with no ``pipefail``, so the pipeline reported head's exit code
   (0), masking rg/grep's error code (2). The guard never fired, and the
   error text — merged into stdout by ``_exec`` (``stderr=subprocess.STDOUT``)
   — was parsed as bogus match lines instead of being surfaced.

2. **Would have nuked partial results if it ever did fire.** A broad
   ``exit_code == 2`` check discards real matches whenever rg/grep also hit a
   non-fatal error (e.g. one unreadable file in a tree that otherwise
   matched), which both tools signal with exit 2.

The fix adds ``set -o pipefail`` so the real exit code propagates, splits
tool diagnostics from match output by *shape*, and only surfaces an error
when exit==2 AND no usable match payload remains.

These tests drive the real methods through the real local terminal backend.
"""

import os
import shutil
from pathlib import Path

import pytest

from tools.file_operations import (
    ShellFileOperations,
    _pattern_has_regex_newline,
    _split_tool_diagnostics,
)
from tools.environments.local import LocalEnvironment, _bash_safe_path, _msys_to_windows_path


def _ops(root, request):
    env = LocalEnvironment(cwd=str(root))
    request.addfinalizer(env.cleanup)
    return ShellFileOperations(env, cwd=str(root))


@pytest.fixture
def match_tree(tmp_path):
    """A tree with several files all containing 'needle'."""
    root = tmp_path / "native folder"
    root.mkdir()
    for i in range(5):
        (root / f"file {i}.txt").write_bytes(f"needle line {i}\n".encode("utf-8"))
    return root


@pytest.fixture
def partial_error_tree(tmp_path):
    """A tree with matches plus one unreadable file (forces exit 2 + matches)."""
    root = tmp_path / "data"
    root.mkdir()
    for i in range(4):
        (root / f"f{i}.txt").write_bytes(f"needle line {i}\n".encode("utf-8"))
    sub = root / "sub"
    sub.mkdir()
    locked = sub / "locked.txt"
    locked.write_text("needle in locked\n", encoding="utf-8")
    os.chmod(locked, 0o000)
    yield root
    os.chmod(locked, 0o755)  # let pytest clean up tmp_path


# Run every test once per available backend method.
_METHODS = ["_search_with_grep"]
if shutil.which("rg"):
    _METHODS.append("_search_with_rg")


def _search(ops, method, pattern, path, **kw):
    fn = getattr(ops, method)
    return fn(pattern, str(path), kw.get("file_glob"), kw.get("limit", 50),
              kw.get("offset", 0), kw.get("output_mode", "content"),
              kw.get("context", 0))


@pytest.mark.parametrize("method", _METHODS)
class TestSearchErrorGuard:
    def test_relative_space_filename_is_preserved(self, method, match_tree, request):
        result = _search(
            _ops(match_tree, request), method, "needle", "file 0.txt", output_mode="files_only",
        )
        assert result.error is None
        assert result.total_count == 1
        assert result.files == ["file 0.txt"]

    @pytest.mark.parametrize("path_form", ["native", "shell"])
    @pytest.mark.parametrize("output_mode", ["content", "files_only", "count"])
    def test_local_absolute_paths_preserve_results(
        self, method, match_tree, request, path_form, output_mode,
    ):
        path = str(match_tree) if path_form == "native" else _bash_safe_path(str(match_tree))
        result = _search(_ops(match_tree, request), method, "needle", path, output_mode=output_mode)
        assert result.error is None
        assert result.total_count == 5
        expected = {match_tree / f"file {i}.txt" for i in range(5)}
        if output_mode == "content":
            assert {Path(_msys_to_windows_path(m.path)) for m in result.matches} == expected
            assert {m.content for m in result.matches} == {f"needle line {i}" for i in range(5)}
            assert {m.line_number for m in result.matches} == {1}
        elif output_mode == "files_only":
            assert {Path(_msys_to_windows_path(p)) for p in result.files} == expected
        else:
            assert {Path(_msys_to_windows_path(p)) for p in result.counts} == expected
            assert set(result.counts.values()) == {1}

    def test_happy_path_returns_matches(self, method, match_tree, request):
        res = _search(_ops(match_tree, request), method, "needle", match_tree)
        assert res.error is None
        assert len(res.matches) == 5

    @pytest.mark.parametrize("output_mode", ["content", "files_only", "count"])
    def test_hard_error_is_surfaced(self, method, match_tree, request, output_mode):
        # An invalid regex makes rg/grep exit 2 with only diagnostics in
        # stdout. The guard MUST surface it — not return empty matches.
        res = _search(_ops(match_tree, request), method, "[", match_tree, output_mode=output_mode)
        assert res.error is not None, "search error was silently swallowed"
        assert "Search failed" in res.error
        assert not res.matches


    def test_count_mode_with_partial_error(self, method, partial_error_tree, request):
        res = _search(_ops(partial_error_tree, request), method, "needle",
                      partial_error_tree, output_mode="count")
        assert res.error is None
        assert res.total_count >= 4


class TestSearchContentNewlineWarning:
    def test_odd_backslash_n_is_detected_as_regex_newline(self):
        assert _pattern_has_regex_newline(r"needle\n")
        assert _pattern_has_regex_newline(r"needle\\\n")


    def test_literal_backslash_n_pattern_does_not_warn(self, match_tree, request):
        res = _ops(match_tree, request).search(
            r"absent\\npattern",
            path=str(match_tree),
            target="content",
        )

        assert res.error is None
        assert res.total_count == 0
        assert res.warning is None


class TestSplitToolDiagnostics:
    """Unit coverage for the shape-based diagnostic/payload splitter."""

    def test_pure_error_has_empty_payload(self):
        out = "rg: regex parse error:\n    (?:[)\n       ^\nerror: unclosed character class\n"
        diagnostics, payload = _split_tool_diagnostics(out)
        assert payload.strip() == ""
        assert "regex parse error" in diagnostics


    def test_context_lines_and_separator_are_payload(self):
        out = "a.py:5:hit\na.py-6-after\n--\nb.py:9:hit\n"
        diagnostics, payload = _split_tool_diagnostics(out)
        assert diagnostics == ""
        assert "--" in payload
        assert "a.py-6-after" in payload

    @pytest.mark.parametrize("root,path", [
        ("C:/native folder", r"C:/native folder\file name.txt"),
        ("/tmp/native folder", "/tmp/native folder/file name.txt"),
        ("native folder", "native folder/file name.txt"),
        (".", "./file name.txt"),
        ("file name.txt", "file name.txt"),
    ])
    def test_files_only_spaces_remain_paths_with_partial_error(self, root, path):
        out = f"{path}\nrg: {root}/locked.txt: Permission denied\n"
        diagnostics, payload = _split_tool_diagnostics(out, files_only_root=root)
        assert payload == path
        assert "Permission denied" in diagnostics

    @pytest.mark.parametrize("out", [
        "rg: /tmp/native folder: IO error: No such file\n",
        "grep: /tmp/native folder: Permission denied\n",
        "rg: regex parse error:\n    (?:[)\n       ^\nerror: unclosed character class\n",
        "a generic diagnostic message with spaces\n",
    ])
    def test_files_only_diagnostics_never_become_paths(self, out):
        diagnostics, payload = _split_tool_diagnostics(out, files_only_root="/tmp/native folder")
        assert payload == ""
        assert diagnostics
