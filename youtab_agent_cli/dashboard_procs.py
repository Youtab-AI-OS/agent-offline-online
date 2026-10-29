"""Dashboard process-hygiene helpers — extracted from ``youtab_agent_cli/main.py``.

The three leaf process-hygiene helpers (``_scan_dashboard_processes``, ``_kill_stale_dashboard_processes``,
``_detect_concurrent_youtab_instances``) are exposed here. References to
helpers that STAY in ``youtab_agent_cli.main`` (``_find_stale_dashboard_pids``,
``_respawn_dashboard_processes``, ``_is_windows``, ...) are routed through a
lazy ``_m()`` main reference so existing test monkeypatches on
``youtab_agent_cli.main.<name>`` keep reaching this code path, and imports stay
one-way at import time (main.py imports this module, never the reverse).
``main.py`` re-exports all three names (``# noqa: F401``) so callers and test
patches on ``youtab_agent_cli.main`` resolve unchanged.
"""

import os
import sys
from pathlib import Path


def _m():
    """Lazy ``youtab_agent_cli.main`` reference (call-time; keeps patches working)."""
    from youtab_agent_cli import main

    return main


def _dashboard_identity(process):
    """Prove executable, argv role and installation before retaining identity.

    An argv mention is never ownership. Unknown/shared interpreters and module
    launches from another checkout are deliberately left to their owner.
    """
    import psutil

    if not process.is_running() or process.username() != psutil.Process().username():
        return None
    root = Path(__file__).resolve().parents[1]
    executable = Path(process.exe()).resolve(strict=True)
    argv = tuple(process.cmdline())
    if not argv or process.pid == os.getpid():
        return None
    shims = set()
    interpreters = set()
    private_interpreters = set()
    interpreter_argv = set()
    shim_argv = set()
    for directory in (root / ".venv", root / "venv"):
        private = directory.resolve().is_relative_to(root)
        for relative in ("Scripts/python.exe", "Scripts/pythonw.exe", "bin/python", "bin/python3"):
            candidate = directory / relative
            if candidate.is_file():
                interpreter_argv.add(candidate)
                interpreter = candidate.resolve(strict=True)
                interpreters.add(interpreter)
                if private:
                    private_interpreters.add(interpreter)
        for relative in ("Scripts/youtab.exe", "bin/youtab"):
            candidate = directory / relative
            if private and candidate.is_file():
                shim_argv.add(candidate)
                shims.add(candidate.resolve(strict=True))
    launcher = Path(argv[0])
    if not launcher.is_absolute():
        return None
    args = list(argv[1:])
    if executable in shims and launcher in shim_argv:
        owned = bool(args and args[0] in {"dashboard", "serve"})
    elif executable in interpreters and launcher in interpreter_argv:
        while args and args[0] in {"-u", "-B", "-E", "-s"}:
            args.pop(0)
        if args[:2] == ["-m", "youtab_agent_cli.main"]:
            owned = (len(args) > 2 and args[2] in {"dashboard", "serve"}
                     and Path(process.cwd()).resolve(strict=True) == root)
        elif len(args) > 1:
            script = Path(args[0])
            if not script.is_absolute():
                script = Path(process.cwd()) / script
            script_path = script.resolve(strict=True)
            owned = (script_path in shims or script_path == root / "youtab_agent_cli" / "main.py")
            owned = owned and executable in private_interpreters and args[1] in {"dashboard", "serve"}
        else:
            owned = False
    else:
        owned = False
    if not owned:
        return None
    environment = process.environ()
    if environment.get("PYTHONHOME"):
        return None
    pythonpath = environment.get("PYTHONPATH")
    if pythonpath:
        entries = pythonpath.split(os.pathsep)
        if any(not entry or not Path(entry).is_absolute()
               or Path(entry).resolve(strict=True) != root for entry in entries):
            return None
    return (process.pid, process.create_time(), str(executable), argv)


def _owned_dashboard_processes(*, exclude_pids=None):
    try:
        import psutil
    except ImportError:
        return []
    matches = []
    try:
        for process in psutil.process_iter():
            if process.pid in (exclude_pids or set()):
                continue
            try:
                identity = _dashboard_identity(process)
                if identity is not None:
                    matches.append((process, identity))
            except (psutil.Error, OSError, ValueError):
                continue
    except psutil.Error:
        return []
    return matches


def _scan_windows_dashboard_processes(patterns=None):
    """Compatibility entry point: patterns cannot confer process ownership."""
    return _scan_dashboard_processes()


def _scan_dashboard_processes(*, exclude_pids=None):
    """Return only installation-owned dashboard/server processes; never signal."""
    return [(identity[0], " ".join(identity[3]))
            for _process, identity in _owned_dashboard_processes(exclude_pids=exclude_pids)]


def _kill_stale_dashboard_processes(
    reason: str = "the running backend no longer matches the updated frontend",
    *,
    restart_managed: bool = False,
) -> dict[str, list]:
    """Kill running ``youtab dashboard`` / ``youtab serve`` processes.

    Called at the end of ``youtab update`` (default ``reason``) and also
    from ``youtab dashboard --stop`` (which overrides ``reason``).  The
    dashboard has no service manager, so after a code update the running
    process is guaranteed to be serving stale Python against a
    freshly-updated JS bundle.  Leaving it alive produces silent
    frontend/backend mismatches (new auth headers the old backend doesn't
    recognise → every API call 401s).

    POSIX: SIGTERM, wait up to ~3s for graceful exit, SIGKILL any survivors.
    Windows: psutil terminates the captured process through a process handle.
    Every signal revalidates the retained installation and creation identity.

    Manually-started dashboards are not auto-restarted because we don't know
    the original launch args (--host, --port, --insecure, --tui, --no-open).
    When ``restart_managed`` is true (the ``youtab update`` path), a detected
    ``youtab-dashboard.service`` is restarted through systemd; any OTHER
    killed PID that was supervised by a systemd unit (custom unit names —
    e.g. a remote backend's ``youtab-serve.service``) has its owning unit
    restarted after the kill, because systemd treats our SIGTERM as a clean
    stop and ``Restart=on-failure`` would never fire (#68934).
    """
    if restart_managed and _m()._restart_managed_dashboard_service(reason):
        return {"matched": [], "killed": [], "failed": []}

    # When the Youtab Desktop Electron app spawns this dashboard as a
    # backend child, it sets YOUTAB_AGENT_DESKTOP_CHILD_PID so that the update
    # path can skip killing the desktop-managed process.  (#37532)
    exclude: set[int] | None = None
    raw_pid = os.environ.get("YOUTAB_AGENT_DESKTOP_CHILD_PID")
    if raw_pid:
        # The desktop may manage several backends (one per active profile) and
        # passes them comma-separated; a lone int still parses for back-compat.
        parsed: set[int] = set()
        for part in raw_pid.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                parsed.add(int(part))
            except (ValueError, TypeError):
                pass
        if parsed:
            exclude = parsed

    owned = _owned_dashboard_processes(exclude_pids=exclude)
    pids = [identity[0] for _process, identity in owned]
    if not pids:
        return {"matched": [], "killed": [], "failed": []}

    print()
    print(f"⟲ Stopping {len(pids)} dashboard process(es) ({reason})")

    # Before killing, snapshot systemd cgroup info for each PID so we can
    # restart supervised services after the kill (the cgroup disappears
    # along with the process).  Only meaningful on Linux, and only when the
    # caller asked for restarts (the `youtab update` path) — `--stop` must
    # stay a stop, not a restart.
    pid_cgroup: dict[int, str | None] = {}
    pid_service: dict[int, str | None] = {}
    pid_cmdline: dict[int, list[str]] = {}
    if restart_managed and sys.platform != "win32":
        for pid in pids:
            cg_path = _m()._get_pid_cgroup_path(pid)
            pid_cgroup[pid] = cg_path
            pid_service[pid] = _m()._get_systemd_service_for_pid(pid)
            if not pid_service[pid]:
                # Manually-started process: preserve its exact argv so we
                # can respawn it after the update (#40449, #68934).
                cmdline = _m()._dashboard_cmdline_for_pid(pid)
                if cmdline:
                    pid_cmdline[pid] = cmdline

    killed: list[int] = []
    failed: list[tuple[int, str]] = []

    import psutil

    pending = []
    for process, identity in owned:
        pid = identity[0]
        try:
            # psutil also guards PID reuse in its signal implementation. Keep
            # the argv/executable/creation-time proof immediately before it.
            if _dashboard_identity(process) != identity:
                failed.append((pid, "process ownership changed before stop"))
                continue
            process.terminate()
            pending.append((process, identity))
        except psutil.NoSuchProcess:
            killed.append(pid)
        except (psutil.Error, OSError, ValueError) as error:
            failed.append((pid, str(error)))

    gone, alive = psutil.wait_procs([process for process, _identity in pending], timeout=3)
    killed.extend(process.pid for process in gone)
    for process, identity in pending:
        if process not in alive:
            continue
        pid = identity[0]
        try:
            if _dashboard_identity(process) != identity:
                failed.append((pid, "process ownership changed before forced stop"))
                continue
            process.kill()
            process.wait(timeout=3)
            killed.append(pid)
        except psutil.NoSuchProcess:
            killed.append(pid)
        except (psutil.Error, OSError, ValueError) as error:
            failed.append((pid, str(error)))

    for pid in killed:
        print(f"    ✓ stopped PID {pid}")
    for pid, err_msg in failed:
        print(f"    ✗ failed to stop PID {pid}: {err_msg}")

    # Restart what we just killed (update path only).  Two categories:
    #  - systemd-supervised PIDs: restart the owning unit.  Without this, a
    #    remote backend (youtab serve) under Restart=on-failure never comes
    #    back after our clean SIGTERM, and the Desktop can't reconnect (#68934).
    #  - manually-started PIDs: respawn the argv captured before the kill
    #    (#40449) — detached, headless, logged to logs/dashboard-restart.log.
    restarted_services: list[str] = []
    unrecovered: list[int] = []
    if killed and restart_managed:
        failed_restarts: list[tuple[str, str]] = []
        seen_services: set[str] = set()
        respawn_cmds: list[list[str]] = []
        for pid in killed:
            svc_name = pid_service.get(pid)
            if svc_name:
                if svc_name in seen_services:
                    continue
                seen_services.add(svc_name)
                if _m()._try_restart_systemd_service(svc_name, pid_cgroup.get(pid)):
                    restarted_services.append(svc_name)
                else:
                    failed_restarts.append((svc_name, "systemctl restart returned non-zero"))
                    unrecovered.append(pid)
            elif pid in pid_cmdline:
                respawn_cmds.append(pid_cmdline[pid])
            else:
                unrecovered.append(pid)

        for svc in restarted_services:
            print(f"    ✓ restarted systemd service {svc}")
        for svc, err in failed_restarts:
            print(f"    ⚠ {svc}: {err}")

        if respawn_cmds:
            failed_cmds = _m()._respawn_dashboard_processes(respawn_cmds)
            if failed_cmds:
                unrecovered.extend(p for p in killed if pid_cmdline.get(p) in failed_cmds)

        if failed_restarts or unrecovered:
            print("  Restart anything not auto-restarted when you're ready:")
            print("    youtab dashboard --port <port>")
    elif killed:
        unrecovered = list(killed)
        print("  Restart the dashboard when you're ready:")
        print("    youtab dashboard --port <port>")

    return {
        "matched": list(pids),
        "killed": list(killed),
        "failed": list(failed),
        "unrecovered": list(unrecovered),
    }

def _detect_concurrent_youtab_instances(
    scripts_dir: Path, *, exclude_pid: int | None = None
) -> list[tuple[int, str]]:
    """Find other live processes whose .exe is one of our entry-point shims.

    Windows blocks DELETE/REPLACE on a running .exe — and even RENAME on the
    same .exe when another process opened it without ``FILE_SHARE_DELETE``.
    The Youtab Desktop Electron app spawns ``youtab.EXE`` as a backend child,
    so during ``youtab update`` the user-invoked process and the desktop's
    child both hold the same file. The quarantine rename then fails with
    ``[WinError 32]`` and uv inherits the lock.

    This helper enumerates processes whose ``exe`` matches one of the venv's
    shims (``youtab.exe`` / ``youtab-gateway.exe``) and returns ``(pid,
    process_name)`` pairs. The caller's own PID and its entire ancestor
    chain are excluded so the running ``youtab update`` invocation never
    reports itself — this matters on Windows where the setuptools .exe
    launcher (``youtab.exe``) is a separate process from the Python
    interpreter it loads (``python.exe``).

    Returns an empty list off-Windows, on missing psutil, or when no other
    instances exist. Never raises — process enumeration is best-effort.
    """
    if not _m()._is_windows():
        return []

    try:
        import psutil
    except Exception:
        return []

    # Resolve every shim path to its canonical form once for cheap comparison.
    shim_paths: set[str] = set()
    for shim in _m()._youtab_exe_shims(scripts_dir):
        try:
            shim_paths.add(str(shim.resolve()).lower())
        except OSError:
            shim_paths.add(str(shim).lower())
    if not shim_paths:
        return []

    # Build a set of PIDs to exclude: the Python process itself plus every
    # ancestor whose executable is one of our shims. On Windows the
    # setuptools-generated youtab.exe launcher is a separate native process
    # that spawns python.exe (the interpreter that runs our code).
    # os.getpid() returns the Python PID, but the launcher (which holds the
    # file lock) is the parent. Without excluding it, every ``youtab update``
    # reports its own launcher as a concurrent instance — a false positive
    # (issues #29341, #34795).
    #
    # Two robustness points learned from the field:
    #   1. Use ``proc.parents()`` — it returns the WHOLE ancestor list in one
    #      call. The earlier per-hop ``current.parent()`` loop bailed on the
    #      first psutil error (AccessDenied/NoSuchProcess is common on Windows
    #      across session/elevation boundaries), leaving the launcher shim in
    #      the candidate set and re-triggering the false positive.
    #   2. Only exclude ancestors whose exe is itself a shim. A genuine second
    #      youtab.exe sitting *under* a non-Youtab parent (e.g. a Youtab
    #      Desktop backend child) must still be flagged, so we don't blanket-
    #      exclude unrelated ancestors like the shell or terminal.
    # Broad ``except Exception`` guards against partially-stubbed psutil in
    # unit tests; this helper is documented as "never raises".
    if exclude_pid is not None:
        exclude_pids: set[int] = {int(exclude_pid)}
    else:
        exclude_pids = {os.getpid()}
    try:
        seed = next(iter(exclude_pids))
        try:
            ancestors = psutil.Process(seed).parents()
        except Exception:
            ancestors = []
        for ancestor in ancestors:
            try:
                anc_exe = ancestor.exe()
            except Exception:
                continue
            if not anc_exe:
                continue
            try:
                anc_norm = str(Path(anc_exe).resolve()).lower()
            except (OSError, ValueError):
                anc_norm = str(anc_exe).lower()
            if anc_norm in shim_paths:
                try:
                    exclude_pids.add(int(ancestor.pid))
                except Exception:
                    continue
    except Exception:
        pass

    matches: list[tuple[int, str]] = []
    try:
        proc_iter = psutil.process_iter(["pid", "exe", "name"])
    except Exception:
        return []

    for proc in proc_iter:
        try:
            info = proc.info
        except Exception:
            continue
        pid = info.get("pid")
        exe = info.get("exe")
        if not exe or pid is None or pid in exclude_pids:
            continue
        try:
            exe_norm = str(Path(exe).resolve()).lower()
        except (OSError, ValueError):
            exe_norm = str(exe).lower()
        if exe_norm in shim_paths:
            name = info.get("name") or Path(exe).name
            matches.append((int(pid), str(name)))

    return matches
