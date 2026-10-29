"""Tests for youtab_logging — centralized logging setup."""
import io
import logging
import os
import stat
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from unittest.mock import patch

import pytest

import youtab_logging
# Use whatever RotatingFileHandler class youtab_logging actually resolved so
# the autouse fixture's isinstance checks (which strip rotating handlers
# between tests) match the real handlers on every platform. youtab_logging
# aliases concurrent-log-handler's ConcurrentRotatingFileHandler on Windows
# (the #44873 fix) but keeps stdlib RotatingFileHandler on POSIX, so importing
# the name from the module under test keeps the two in lockstep.
from youtab_logging import RotatingFileHandler


@pytest.fixture(autouse=True)
def _reset_logging_state():
    """Reset the module-level sentinel and clean up root logger handlers
    added by setup_logging() so tests don't leak state.

    Under xdist (-n auto) other test modules may have called setup_logging()
    in the same worker process, leaving RotatingFileHandlers on the root
    logger.  We strip ALL RotatingFileHandlers before each test so the count
    assertions are stable regardless of test ordering.
    """
    youtab_logging._logging_initialized = False
    # File handlers now live behind the async QueueListener, not on the root
    # logger; tear down any leaked from other xdist tests in this worker.
    youtab_logging._reset_queued_handlers()
    root = logging.getLogger()
    prev_root_level = root.level
    root.setLevel(logging.NOTSET)
    # Snapshot the remaining (non-file) handlers so we can strip whatever the
    # test adds.
    pre_existing = list(root.handlers)
    # Ensure the record factory is installed (it's idempotent).
    youtab_logging._install_session_record_factory()
    yield
    # Restore — tear down async file logging + remove handlers added by the test.
    youtab_logging._reset_queued_handlers()
    for h in list(root.handlers):
        if h not in pre_existing:
            root.removeHandler(h)
            h.close()
    root.setLevel(prev_root_level)
    youtab_logging._logging_initialized = False
    youtab_logging.clear_session_context()


@pytest.fixture
def youtab_home(tmp_path, monkeypatch):
    """Provide an isolated YOUTAB_AGENT_HOME for logging tests.

    Uses the same tmp_path as the autouse _isolate_youtab_home from conftest,
    reading it back from the env var to avoid double-mkdir conflicts.
    """
    home = Path(os.environ["YOUTAB_AGENT_HOME"])
    return home


class TestSetupLogging:
    """setup_logging() creates agent.log + errors.log with RotatingFileHandler."""

    def test_creates_log_directory(self, youtab_home):
        log_dir = youtab_logging.setup_logging(youtab_home=youtab_home)
        assert log_dir == youtab_home / "logs"
        assert log_dir.is_dir()

    def test_creates_agent_log_handler(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home)
        root = logging.getLogger()

        agent_handlers = [
            h for h in youtab_logging.rotating_file_handlers()
            if isinstance(h, RotatingFileHandler)
            and "agent.log" in getattr(h, "baseFilename", "")
        ]
        assert len(agent_handlers) == 1
        assert agent_handlers[0].level == logging.INFO


    def test_idempotent_no_duplicate_handlers(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home)
        youtab_logging.setup_logging(youtab_home=youtab_home)  # second call — should be no-op

        root = logging.getLogger()
        agent_handlers = [
            h for h in youtab_logging.rotating_file_handlers()
            if isinstance(h, RotatingFileHandler)
            and "agent.log" in getattr(h, "baseFilename", "")
        ]
        assert len(agent_handlers) == 1





    def test_writes_to_agent_log(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home)

        test_logger = logging.getLogger("test_youtab_logging.write_test")
        test_logger.info("test message for agent.log")

        # Flush handlers
        youtab_logging.flush_log_queue()

        agent_log = youtab_home / "logs" / "agent.log"
        assert agent_log.exists()
        content = agent_log.read_text(encoding="utf-8")
        assert "test message for agent.log" in content




    def test_explicit_params_override_config(self, youtab_home):
        """Explicit function params take precedence over config.yaml."""
        import yaml
        config = {"logging": {"level": "DEBUG"}}
        (youtab_home / "config.yaml").write_text(yaml.dump(config), encoding="utf-8")

        youtab_logging.setup_logging(youtab_home=youtab_home, log_level="WARNING")

        root = logging.getLogger()
        agent_handlers = [
            h for h in youtab_logging.rotating_file_handlers()
            if isinstance(h, RotatingFileHandler)
            and "agent.log" in getattr(h, "baseFilename", "")
        ]
        assert agent_handlers[0].level == logging.WARNING



class TestGatewayMode:
    """setup_logging(mode='gateway') creates a filtered gateway.log."""

    def test_gateway_log_created(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home, mode="gateway")
        root = logging.getLogger()

        gw_handlers = [
            h for h in youtab_logging.rotating_file_handlers()
            if isinstance(h, RotatingFileHandler)
            and "gateway.log" in getattr(h, "baseFilename", "")
        ]
        assert len(gw_handlers) == 1

    def test_gateway_log_not_created_in_cli_mode(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home, mode="cli")
        root = logging.getLogger()

        gw_handlers = [
            h for h in youtab_logging.rotating_file_handlers()
            if isinstance(h, RotatingFileHandler)
            and "gateway.log" in getattr(h, "baseFilename", "")
        ]
        assert len(gw_handlers) == 0



    def test_gateway_log_receives_gateway_records(self, youtab_home):
        """gateway.log captures records from gateway.* loggers."""
        youtab_logging.setup_logging(youtab_home=youtab_home, mode="gateway")

        gw_logger = logging.getLogger("plugins.platforms.telegram.adapter")
        gw_logger.info("telegram connected")

        youtab_logging.flush_log_queue()

        gw_log = youtab_home / "logs" / "gateway.log"
        assert gw_log.exists()
        assert "telegram connected" in gw_log.read_text(encoding="utf-8")

    def test_gateway_log_rejects_non_gateway_records(self, youtab_home):
        """gateway.log does NOT capture records from tools.*, agent.*, etc."""
        youtab_logging.setup_logging(youtab_home=youtab_home, mode="gateway")

        tool_logger = logging.getLogger("tools.terminal_tool")
        tool_logger.info("running command")

        agent_logger = logging.getLogger("agent.context_compressor")
        agent_logger.info("compressing context")

        youtab_logging.flush_log_queue()

        gw_log = youtab_home / "logs" / "gateway.log"
        if gw_log.exists():
            content = gw_log.read_text(encoding="utf-8")
            assert "running command" not in content
            assert "compressing context" not in content



class TestGuiMode:
    """setup_logging(mode='gui') creates a filtered gui.log."""

    def test_gui_log_created(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home, mode="gui")
        root = logging.getLogger()

        gui_handlers = [
            h for h in youtab_logging.rotating_file_handlers()
            if isinstance(h, RotatingFileHandler)
            and "gui.log" in getattr(h, "baseFilename", "")
        ]
        assert len(gui_handlers) == 1


    def test_gui_log_receives_only_gui_components(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home, mode="gui")

        logging.getLogger("youtab_agent_cli.web_server").info("dashboard online")
        logging.getLogger("tui_gateway.ws").info("ws connected")
        logging.getLogger("gateway.run").info("gateway event")

        youtab_logging.flush_log_queue()

        gui_log = youtab_home / "logs" / "gui.log"
        assert gui_log.exists()
        content = gui_log.read_text(encoding="utf-8")
        assert "dashboard online" in content
        assert "ws connected" in content
        assert "gateway event" not in content


class TestSessionContext:
    """set_session_context / clear_session_context + _SessionFilter."""

    def test_session_tag_in_log_output(self, youtab_home):
        """When session context is set, log lines include [session_id]."""
        youtab_logging.setup_logging(youtab_home=youtab_home)
        youtab_logging.set_session_context("abc123")

        test_logger = logging.getLogger("test.session_tag")
        test_logger.info("tagged message")

        youtab_logging.flush_log_queue()

        agent_log = youtab_home / "logs" / "agent.log"
        content = agent_log.read_text(encoding="utf-8")
        assert "[abc123]" in content
        assert "tagged message" in content







class TestComponentFilter:
    """Unit tests for _ComponentFilter."""

    def test_passes_matching_prefix(self):
        f = youtab_logging._ComponentFilter(("gateway",))
        record = logging.LogRecord(
            "gateway.run", logging.INFO, "", 0, "msg", (), None
        )
        assert f.filter(record) is True


    def test_blocks_non_matching(self):
        f = youtab_logging._ComponentFilter(("gateway",))
        record = logging.LogRecord(
            "tools.terminal_tool", logging.INFO, "", 0, "msg", (), None
        )
        assert f.filter(record) is False





class TestSetupVerboseLogging:
    """setup_verbose_logging() adds a DEBUG-level console handler."""

    def test_adds_stream_handler(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home)
        youtab_logging.setup_verbose_logging()

        root = logging.getLogger()
        verbose_handlers = [
            h for h in root.handlers
            if isinstance(h, logging.StreamHandler)
            and not isinstance(h, RotatingFileHandler)
            and getattr(h, "_youtab_verbose", False)
        ]
        assert len(verbose_handlers) == 1
        assert verbose_handlers[0].level == logging.DEBUG



class TestAddRotatingHandler:
    """_add_rotating_handler() is idempotent and creates the directory."""


    def test_no_duplicate_for_same_path(self, tmp_path):
        log_path = tmp_path / "test.log"
        logger = logging.getLogger("_test_rotating_dup")
        formatter = logging.Formatter("%(message)s")

        youtab_logging._add_rotating_handler(
            logger, log_path,
            level=logging.INFO, max_bytes=1024, backup_count=1,
            formatter=formatter,
        )
        youtab_logging._add_rotating_handler(
            logger, log_path,
            level=logging.INFO, max_bytes=1024, backup_count=1,
            formatter=formatter,
        )

        rotating_handlers = [
            h for h in youtab_logging.rotating_file_handlers()
            if isinstance(h, RotatingFileHandler)
        ]
        assert len(rotating_handlers) == 1
        # Clean up
        for h in list(logger.handlers):
            if isinstance(h, RotatingFileHandler):
                logger.removeHandler(h)
                h.close()


    def test_no_session_filter_on_handler(self, tmp_path):
        """Handlers rely on record factory, not per-handler _SessionFilter."""
        log_path = tmp_path / "no_session_filter.log"
        logger = logging.getLogger("_test_no_session_filter")
        formatter = logging.Formatter("%(session_tag)s%(message)s")

        youtab_logging._add_rotating_handler(
            logger, log_path,
            level=logging.INFO, max_bytes=1024, backup_count=1,
            formatter=formatter,
        )

        handlers = [h for h in youtab_logging.rotating_file_handlers() if isinstance(h, RotatingFileHandler)]
        assert len(handlers) == 1
        # No _SessionFilter on the handler — record factory handles it
        assert len(handlers[0].filters) == 0

        # But session_tag still works (via record factory)
        youtab_logging.set_session_context("factory_test")
        logger.info("test msg")
        youtab_logging.flush_log_queue()
        content = log_path.read_text(encoding="utf-8")
        assert "[factory_test]" in content

        # Clean up
        for h in list(logger.handlers):
            if isinstance(h, RotatingFileHandler):
                logger.removeHandler(h)
                h.close()

    def test_managed_mode_initial_open_sets_group_writable(self, tmp_path):
        log_path = tmp_path / "managed-open.log"
        logger = logging.getLogger("_test_rotating_managed_open")
        formatter = logging.Formatter("%(message)s")

        old_umask = os.umask(0o022)
        try:
            with patch("youtab_agent_cli.config.is_managed", return_value=True):
                youtab_logging._add_rotating_handler(
                    logger, log_path,
                    level=logging.INFO, max_bytes=1024, backup_count=1,
                    formatter=formatter,
                )
        finally:
            os.umask(old_umask)

        if os.name == "nt":
            # concurrent-log-handler opens lazily on Windows. Verify the file
            # is created and receives a record; POSIX group bits do not map to
            # Windows file ACLs.
            logger.warning("managed log record")
            youtab_logging.flush_log_queue()
            assert "managed log record" in log_path.read_text(encoding="utf-8")
        else:
            assert log_path.exists()
            assert stat.S_IMODE(log_path.stat().st_mode) == 0o660

        for h in list(logger.handlers):
            if isinstance(h, RotatingFileHandler):
                logger.removeHandler(h)
                h.close()



class TestWindowsConcurrentLogLockTimeout:
    """Windows concurrent-log-handler lock timeouts stay inside logging."""

    def _make_logger_and_handler(self, log_path: Path):
        logger = logging.getLogger(f"_test_concurrent_lock_timeout_{log_path.stem}")
        logger.handlers.clear()
        logger.propagate = False
        logger.setLevel(logging.INFO)

        handler = youtab_logging._ManagedRotatingFileHandler(
            str(log_path), maxBytes=1, backupCount=1, encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        return logger, handler

    def test_helper_only_matches_windows_concurrent_lock_timeout(self):
        with patch.object(youtab_logging.sys, "platform", "win32"):
            assert youtab_logging._is_windows_concurrent_log_lock_timeout(
                RuntimeError("Cannot acquire lock after 20 attempts")
            )
            assert not youtab_logging._is_windows_concurrent_log_lock_timeout(
                RuntimeError("some other logging failure")
            )

        with patch.object(youtab_logging.sys, "platform", "linux"):
            assert not youtab_logging._is_windows_concurrent_log_lock_timeout(
                RuntimeError("Cannot acquire lock after 20 attempts")
            )

    def test_lock_timeout_routed_to_handle_error_is_suppressed(self, tmp_path, capsys):
        """Mirror CLH's real control flow.

        ``concurrent-log-handler``'s ``emit()`` wraps its whole body in
        ``try/except Exception: self.handleError(record)``, so the lock
        RuntimeError raised in ``_do_lock()`` is caught *inside* CLH and routed
        to ``handleError`` with the exception live in ``sys.exc_info()``.  We
        invoke ``handleError`` the same way CLH would and assert no traceback
        reaches stderr (the slash-worker surface)."""
        logger, handler = self._make_logger_and_handler(tmp_path / "agent.log")
        record = logger.makeRecord(
            logger.name, logging.INFO, __file__, 0, "force rollover", (), None,
        )
        try:
            with patch.object(youtab_logging.sys, "platform", "win32"):
                try:
                    raise RuntimeError("Cannot acquire lock after 20 attempts")
                except RuntimeError:
                    handler.handleError(record)

            captured = capsys.readouterr()
            assert "Cannot acquire lock after 20 attempts" not in captured.err
            assert "--- Logging error ---" not in captured.err
        finally:
            logger.removeHandler(handler)
            handler.close()



class TestReadLoggingConfig:
    """_read_logging_config() reads from config.yaml."""

    def test_returns_none_when_no_config(self, youtab_home):
        level, max_size, backup = youtab_logging._read_logging_config()
        assert level is None
        assert max_size is None
        assert backup is None

    def test_reads_logging_section(self, youtab_home):
        import yaml
        config = {"logging": {"level": "DEBUG", "max_size_mb": 10, "backup_count": 5}}
        (youtab_home / "config.yaml").write_text(yaml.dump(config), encoding="utf-8")

        level, max_size, backup = youtab_logging._read_logging_config()
        assert level == "DEBUG"
        assert max_size == 10
        assert backup == 5



class TestExternalRotationRecovery:
    """_ManagedRotatingFileHandler recovers from external rotation.

    External rotation = anything that renames, unlinks, or replaces the
    log file without going through ``doRollover()``: logrotate, manual
    ``mv``, another process rotating under us, or a transient ``rm``.
    Before this fix the open file descriptor stayed pinned to the old
    inode forever, so every subsequent write went to the rotated backup
    instead of the file the operator expects to read.
    """

    def _make_handler(self, log_path: Path) -> youtab_logging._ManagedRotatingFileHandler:
        handler = youtab_logging._ManagedRotatingFileHandler(
            str(log_path), maxBytes=10 * 1024 * 1024, backupCount=3,
            encoding="utf-8",
        )
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter("%(message)s"))
        return handler

    def _emit(self, handler: logging.Handler, msg: str) -> None:
        record = logging.LogRecord(
            name="gateway.run", level=logging.INFO, pathname="", lineno=0,
            msg=msg, args=(), exc_info=None,
        )
        # Match the record factory that youtab_logging installs at import time.
        record.session_tag = ""
        handler.emit(record)
        youtab_logging.flush_log_queue()

    def test_recovers_after_external_rename(self, tmp_path):
        """logrotate-style external rename: ``mv gateway.log gateway.log.1``.

        Handler's fd was pinned to the renamed inode; new writes used to
        go to ``gateway.log.1`` forever.  After fix, the handler reopens
        ``gateway.log`` at the original path.
        """
        log_path = tmp_path / "gateway.log"
        rotated = tmp_path / "gateway.log.1"
        handler = self._make_handler(log_path)
        try:
            self._emit(handler, "before rotation")
            assert log_path.read_text(encoding="utf-8") == "before rotation\n"

            # External rotation (NOT via handler.doRollover()).
            os.rename(log_path, rotated)
            assert not log_path.exists()

            self._emit(handler, "after rotation")

            # The new write should land in a freshly recreated gateway.log,
            # not appended to the rotated backup.
            assert log_path.exists(), "handler did not recreate gateway.log"
            assert log_path.read_text(encoding="utf-8") == "after rotation\n"
            assert rotated.read_text(encoding="utf-8") == "before rotation\n"
        finally:
            handler.close()


    def test_external_truncate_does_not_force_reopen(self, tmp_path):
        """``: > gateway.log`` keeps the same inode — no reopen needed.

        Truncation in place preserves the inode, so subsequent writes
        continue to the same file descriptor.  We assert the post-truncate
        content reflects the truncate (size shrinks) and then grows with
        new writes — i.e. the handler correctly does NOT detect this as
        an inode change.
        """
        log_path = tmp_path / "gateway.log"
        handler = self._make_handler(log_path)
        try:
            self._emit(handler, "AAAA" * 32)
            assert log_path.stat().st_size > 0

            with open(log_path, "w", encoding="utf-8"):
                pass  # truncate to zero
            assert log_path.stat().st_size == 0

            self._emit(handler, "after truncate")
            assert log_path.read_text(encoding="utf-8") == "after truncate\n"
        finally:
            handler.close()


    def test_gateway_log_attached_after_external_rotation_then_re_setup(
        self, youtab_home,
    ):
        """End-to-end Allen-reproduction: gateway.log gets externally rotated,
        ``setup_logging(mode='gateway')`` is re-called, the handler keeps
        working.

        Reproduces Allen's symptom (gateway.log frozen mid-write, all gateway
        records leaking to agent.log) when something external rotates the
        file between setup_logging() calls.
        """
        youtab_logging.setup_logging(youtab_home=youtab_home, mode="gateway")
        gw_path = youtab_home / "logs" / "gateway.log"
        rotated = youtab_home / "logs" / "gateway.log.1"

        logging.getLogger("gateway.run").info("line BEFORE rotation")
        youtab_logging.flush_log_queue()
        assert "BEFORE rotation" in gw_path.read_text(encoding="utf-8")

        # External actor renames the file out from under us.
        os.rename(gw_path, rotated)
        assert not gw_path.exists()

        # Caller (or some restart path) re-enters setup_logging.  This used
        # to silently no-op due to the per-path dedup check, leaving the
        # stale fd in place.
        youtab_logging.setup_logging(youtab_home=youtab_home, mode="gateway")

        logging.getLogger("gateway.run").info("line AFTER rotation")
        youtab_logging.flush_log_queue()

        # The new record must reach the live gateway.log, not the rotated
        # backup.  Allen's logs had everything past the rotation point
        # going into agent.log only, never gateway.log.
        assert gw_path.exists(), "gateway.log was never recreated"
        assert "AFTER rotation" in gw_path.read_text(encoding="utf-8")
        assert "AFTER rotation" not in rotated.read_text(encoding="utf-8")


class TestSafeStderr:
    """Tests for _safe_stderr() — Unicode tolerance on Windows console."""


    def test_wraps_non_utf8_stderr(self, monkeypatch):
        """On non-UTF-8 systems (e.g. Windows cp949), wraps stderr with UTF-8."""
        import io

        class FakeStderr:
            """Simulates a Windows stderr with legacy encoding."""
            encoding = "cp949"
            buffer = io.BytesIO()

            def write(self, s):
                pass

            def flush(self):
                pass

        fake = FakeStderr()
        monkeypatch.setattr(sys, "stderr", fake)
        result = youtab_logging._safe_stderr()
        # Should be a TextIOWrapper, not the original FakeStderr
        assert isinstance(result, io.TextIOWrapper)
        assert result.encoding == "utf-8"
        assert result.errors == "replace"

    def test_handler_emits_unicode_without_crash(self, tmp_path):
        """StreamHandler with _safe_stderr can emit Unicode messages."""
        import io

        # Create a stderr-like stream with ASCII encoding
        class AsciiStream:
            encoding = "ascii"
            buffer = io.BytesIO()

            def write(self, s):
                self.buffer.write(s.encode("ascii", errors="replace"))

            def flush(self):
                pass

        # Without the fix, this would crash on cp949/ASCII stderr.
        # With the wrapper, the em-dash is replaced with '?'
        handler = logging.StreamHandler(
            io.TextIOWrapper(
                io.BytesIO(),
                encoding="utf-8",
                errors="replace",
            )
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger = logging.getLogger("_test_unicode")
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        try:
            # Em-dash U+2014 — the exact character from the bug report
            logger.info("Session hygiene: 400 messages — auto-compressing")
        finally:
            logger.removeHandler(handler)


class TestAsyncQueueLogging:
    """File logging runs through a QueueListener so emits never block on the
    cross-process rotation lock (Windows event-loop-stall fix)."""

    def test_file_handlers_not_on_root(self, youtab_home):
        youtab_logging.setup_logging(youtab_home=youtab_home)
        root = logging.getLogger()
        # Rotating file handlers live on the async listener, never on root.
        assert not any(isinstance(h, RotatingFileHandler) for h in root.handlers)
        # Exactly one queue handler funnels records to the listener.
        queue_handlers = [
            h for h in root.handlers if getattr(h, "_youtab_queue", False)
        ]
        assert len(queue_handlers) == 1
        # The real file handlers are discoverable via the accessor.
        assert any(
            "agent.log" in getattr(h, "baseFilename", "")
            for h in youtab_logging.rotating_file_handlers()
        )


@pytest.mark.parametrize("separator", ["\n", "\r", "\r\n"])
def test_production_rotating_logs_frame_untrusted_records(youtab_home, monkeypatch, separator):
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", False)
    youtab_logging.setup_logging(youtab_home=youtab_home)
    youtab_logging.set_session_context("synthetic" + separator + "FORGED_SESSION")
    logger = logging.getLogger("gateway.synthetic")
    secret = "opaqueSyntheticException987654321"
    try:
        raise RuntimeError('خطا' + separator + 'FORGED_EXCEPTION {"apiKey": "' + secret + '"}')
    except RuntimeError:
        logger.exception("attachment %s", "سلام" + separator + "2099-01-01 WARNING gateway: FORGED_RECORD\x1b[2J\x00\u2028")
    youtab_logging.clear_session_context()
    logger.warning("ADJACENT_RECORD")
    youtab_logging.flush_log_queue()
    text = (youtab_home / "logs" / "agent.log").read_text(encoding="utf-8")
    assert secret not in text
    assert "سلام" in text and "خطا" in text
    assert "Traceback" in text and "RuntimeError" in text
    assert "test_production_rotating_logs_frame_untrusted_records" in text
    assert "\r" not in text and "\x1b" not in text and "\x00" not in text and "\u2028" not in text
    assert r"\u001b" in text and r"\u0000" in text and r"\u2028" in text
    assert any("ADJACENT_RECORD" in line and not line.startswith("| ") for line in text.splitlines())
    assert not any(line.startswith(("2099-", "FORGED_")) for line in text.splitlines())


def test_redacting_formatter_leaves_shared_record_unchanged():
    from agent.redact import RedactingFormatter
    try:
        raise RuntimeError("synthetic\nFORGED_EXCEPTION")
    except RuntimeError:
        record = logging.LogRecord("synthetic", logging.ERROR, __file__, 1, "value %s", ("שלום\nFORGED",), sys.exc_info())
    before = vars(record).copy()
    formatted = RedactingFormatter("%(message)s").format(record)
    assert vars(record) == before
    assert "\n| FORGED" in formatted
    assert "\n| Traceback" in formatted


@pytest.mark.parametrize("surface", ["acp", "plugin_debug"])
def test_auxiliary_stderr_handlers_redact_and_frame(surface, monkeypatch, capsys):
    import io
    from agent import redact
    monkeypatch.setattr(redact, "_REDACT_ENABLED", False)
    stream = io.StringIO()
    monkeypatch.setattr(sys, "stderr", stream)
    if surface == "acp":
        from acp_adapter import entry
        entry._setup_logging()
        logger = logging.getLogger("synthetic.acp")
        cleanup = lambda: None
    else:
        from youtab_agent_cli import plugins
        monkeypatch.setenv("YOUTAB_AGENT_PLUGINS_DEBUG", "1")
        monkeypatch.setattr(plugins, "_DEBUG_HANDLER_INSTALLED", False)
        previous = list(plugins.logger.handlers)
        plugins._install_plugin_debug_handler(force=True)
        logger = plugins.logger
        def cleanup():
            for handler in list(logger.handlers):
                if handler not in previous:
                    logger.removeHandler(handler)
                    handler.close()
    try:
        logger.warning('سلام\n2099-01-01 ERROR forged {"apiKey": "opaqueSyntheticAuxiliary987654321"}')
        text = stream.getvalue()
        assert "opaqueSyntheticAuxiliary987654321" not in text
        assert "سلام" in text
        assert "\n| 2099-" in text
        assert not any(line.startswith("2099-") for line in text.splitlines())
        assert not capsys.readouterr().out  # ACP stdout is reserved for protocol.
    finally:
        cleanup()


@pytest.mark.parametrize("value", [
    "", "123E4567-E89B-42D3-A456-426614174000", "123e4567-e89b-12d3-a456-426614174000",
    "00000000-0000-0000-0000-000000000000", "password=synthetic", "123e4567-e89b-42d3-a456-426614174000\n",
])
def test_operation_correlation_rejects_noncanonical_metadata(value):
    assert youtab_logging.diagnostic_operation_id(value) is None


def test_operation_correlation_keeps_session_context_and_formats_safely(monkeypatch):
    from agent.redact import RedactingFormatter

    operation = "123e4567-e89b-42d3-a456-426614174000"
    monkeypatch.setenv("YOUTAB_AGENT_DIAGNOSTIC_OPERATION_ID", operation)
    youtab_logging.set_session_context("synthetic-session")
    try:
        record = logging.getLogRecordFactory()("synthetic", logging.ERROR, "synthetic", 1, "password=SYNTHETIC_OPERATION_CREDENTIAL", (), None)
        assert record.operation_id == operation
        assert record.session_tag == " [synthetic-session]"
        rendered = RedactingFormatter(youtab_logging._LOG_FORMAT).format(record)
        assert "[operation=" + operation + "]" in rendered
        assert "SYNTHETIC_OPERATION_CREDENTIAL" not in rendered
        assert record.msg == "password=SYNTHETIC_OPERATION_CREDENTIAL"
        factory = logging.getLogRecordFactory()
        youtab_logging._install_session_record_factory()
        assert logging.getLogRecordFactory() is factory
    finally:
        youtab_logging.clear_session_context()


def test_operation_correlation_invalid_env_never_reaches_log(monkeypatch):
    monkeypatch.setenv("YOUTAB_AGENT_DIAGNOSTIC_OPERATION_ID", "password=SYNTHETIC_OPERATION_CREDENTIAL")
    record = logging.getLogRecordFactory()("synthetic", logging.INFO, "synthetic", 1, "benign", (), None)
    assert record.operation_id is None
    assert record.operation_tag == ""


def test_actual_runtime_child_observes_same_operation_without_task_identity(tmp_path):
    import json
    import subprocess

    operation = "123e4567-e89b-42d3-a456-426614174000"
    env = os.environ.copy()  # canonical test environment is already synthetic
    env["YOUTAB_AGENT_DIAGNOSTIC_OPERATION_ID"] = operation
    completed = subprocess.run([sys.executable, "-c",
        "import json,logging,youtab_logging; "
        "r=logging.getLogRecordFactory()('synthetic',20,'synthetic',1,'benign',(),None); "
        "print(json.dumps({'operation_id':r.operation_id,'session_tag':r.session_tag}))"],
        env=env, capture_output=True, text=True, timeout=10, check=False)
    assert completed.returncode == 0
    assert json.loads(completed.stdout) == {"operation_id": operation, "session_tag": ""}



def test_actual_configured_formatters_accept_direct_log_records(youtab_home):
    youtab_logging.setup_logging(youtab_home=youtab_home)
    record = logging.LogRecord("synthetic", logging.ERROR, "synthetic", 1,
        "password=SYNTHETIC_MANUAL_RECORD_CREDENTIAL", (), None)
    for handler in youtab_logging.rotating_file_handlers():
        output = handler.format(record)
        assert "SYNTHETIC_MANUAL_RECORD_CREDENTIAL" not in output
        assert "synthetic" in output
    assert not hasattr(record, "operation_tag")


def test_transport_credentials_redacted_before_plain_root_handler(youtab_home):
    """Real concurrent HTTPX records and bridge diagnostics reach no raw handler."""
    httpx = pytest.importorskip("httpx")
    youtab_logging.setup_logging(youtab_home=youtab_home)
    output = io.StringIO()
    plain = logging.StreamHandler(output)
    plain.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.addHandler(plain)
    loggers = [logging.getLogger(name) for name in (
        "httpx", "httpcore.connection", "gateway.platforms.bluebubbles"
    )]
    levels = [logger.level for logger in loggers]
    for logger in loggers:
        logger.setLevel(logging.DEBUG)

    passwords = ("bbPrivate#42!", "bbPrivate#43!")

    def request(password):
        encoded = quote(password, safe="")
        url = (
            f"https://owner:{encoded}@example.test/api?password={encoded}"
            "&token=syntheticQueryToken42&operation=health"
        )
        with httpx.Client(
            transport=httpx.MockTransport(lambda _request: httpx.Response(204)),
            trust_env=False,
        ) as client:
            assert client.get(url).status_code == 204
        logging.getLogger("gateway.platforms.bluebubbles").debug(
            "BlueBubbles health status=204 url=%s", url
        )
        logging.getLogger("httpcore.connection").debug(
            "connect status=204 url=%s", url
        )

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(request, passwords))
        youtab_logging.flush_log_queue()
        plain_text = output.getvalue()
        agent_text = (youtab_home / "logs" / "agent.log").read_text(encoding="utf-8")
        for text in (plain_text, agent_text):
            for password in passwords:
                assert password not in text
                assert quote(password, safe="") not in text
            assert "syntheticQueryToken42" not in text
            assert "204 No Content" in text
            assert "operation=health" in text
        assert "status=204" in plain_text
        assert 'HTTP/1.1 204' in plain_text
    finally:
        for logger, level in zip(loggers, levels):
            logger.setLevel(level)
        root.removeHandler(plain)
        plain.close()


def test_transport_redactor_failure_is_closed_for_plain_handler(monkeypatch):
    output = io.StringIO()
    plain = logging.StreamHandler(output)
    plain.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    root.addHandler(plain)
    try:
        monkeypatch.setattr("agent.redact.redact_sensitive_text", lambda *a, **k: 1 / 0)
        logging.getLogger("httpx").warning("password=%s", "synthetic-secret")
        assert output.getvalue().strip() == "[transport log redaction failed]"
    finally:
        root.removeHandler(plain)
        plain.close()


def test_transport_exception_and_stack_are_sanitized_before_handler():
    output = io.StringIO()
    plain = logging.StreamHandler(output)
    plain.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    root.addHandler(plain)
    logger = logging.getLogger("httpcore.connection")
    old_level = logger.level
    logger.setLevel(logging.ERROR)
    try:
        try:
            raise ValueError("https://owner:secretInException@example.test/?token=exceptionToken42")
        except ValueError:
            logger.exception("HTTP operation failed status=502", stack_info=True)
        text = output.getvalue()
        assert "secretInException" not in text
        assert "exceptionToken42" not in text
        assert "ValueError" in text
        assert "status=502" in text
    finally:
        logger.setLevel(old_level)
        root.removeHandler(plain)
        plain.close()


def test_reconstituted_transport_record_is_redacted_before_handler():
    youtab_logging._install_session_record_factory()  # repeated install is safe
    output = io.StringIO()
    plain = logging.StreamHandler(output)
    plain.setFormatter(logging.Formatter("%(name)s %(message)s"))
    url = "https://owner:reconstitutedPass42@example.test/api?token=reconstitutedToken42&operation=health"
    record = logging.makeLogRecord({
        "name": "httpx",
        "levelno": logging.INFO,
        "levelname": "INFO",
        "msg": "GET %s status=200",
        "args": (url,),
        "message": f"GET {url} status=200",
    })
    plain.handle(record)
    text = output.getvalue()
    assert "reconstitutedPass42" not in text
    assert "reconstitutedToken42" not in text
    assert "operation=health" in text
    assert "status=200" in text
    assert record.args == ()
    assert "reconstitutedPass42" not in record.message
    assert "reconstitutedToken42" not in record.message
    assert hasattr(record, "session_tag")

    ordinary = logging.makeLogRecord({"name": "ordinary", "msg": "ready"})
    assert ordinary.getMessage() == "ready"
