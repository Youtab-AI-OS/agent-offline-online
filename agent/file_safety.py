"""Shared file safety rules used by both tools and ACP shims."""

from __future__ import annotations

import os
import sys
import stat
import uuid
import ctypes
import threading
from ctypes import wintypes as W
from pathlib import Path
from typing import Optional


def _youtab_home_path() -> Path:
    """Resolve the active YOUTAB_AGENT_HOME (profile-aware) without circular imports."""
    try:
        from youtab_constants import get_youtab_home  # local import to avoid cycles
        return get_youtab_home()
    except Exception:
        return Path(os.path.expanduser("~/.youtab-agent-runtime"))


def _youtab_root_path() -> Path:
    """Resolve the Youtab root dir (always the parent of any profile, never per-profile)."""
    try:
        from youtab_constants import get_default_youtab_root  # local import to avoid cycles
        return get_default_youtab_root()
    except Exception:
        return Path(os.path.expanduser("~/.youtab-agent-runtime"))



_RUNTIME_MUTATION_FILES = frozenset({
    "auth.json", "auth.lock", "credentials", "config.yaml", ".env", ".envrc",
    ".anthropic_oauth.json", "google_token.json", "google_oauth_pending.json",
    "google_oauth.json", "webhook_subscriptions.json", ".git-credentials",
    "state.db", "state.db-wal", "state.db-shm",
    "auth/google_oauth.json", "cache/bws_cache.json", "cache/bws_cache.enc.json",
})
_RUNTIME_MUTATION_TREES = frozenset({"mcp-tokens", "pairing", "sessions"})


def runtime_mutation_denied(path: str, *, deleting: bool = False) -> bool:
    return _runtime_path_denied(path, deleting=deleting, reading=False)


def runtime_credential_read_denied(path: str) -> bool:
    return _runtime_path_denied(path, deleting=False, reading=True)


def _runtime_path_denied(path: str, *, deleting: bool, reading: bool) -> bool:
    """Reserve runtime credential/config/state mutations for dedicated APIs.

    Explicit runtime-relative identities preserve ordinary project config files.
    Both lexical and canonical identities are checked; removal of a protected
    object's parent is also refused before recursive filesystem mutation.
    """
    from youtab_constants import _get_platform_default_youtab_home

    def absolute(value):
        return Path(os.path.abspath(os.path.expanduser(str(value))))

    target = absolute(path)
    roots = {absolute(_youtab_root_path()), absolute(_get_platform_default_youtab_home())}
    homes = roots | {absolute(_youtab_home_path())}
    for root in roots:
        profiles = root / "profiles"
        if profiles.exists():
            homes.update(item for item in profiles.iterdir()
                         if item.is_dir() or item.is_symlink()
                         or getattr(item.lstat(), "st_file_attributes", 0)
                         & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))
        # Include a not-yet-created named profile addressed by this operation.
        for candidate, base in ((target, root), (target.resolve(), root.resolve())):
            try:
                parts = candidate.relative_to(base).parts
            except ValueError:
                continue
            if len(parts) >= 2 and parts[0].lower() == "profiles":
                homes.add(root / "profiles" / parts[1])

    targets = {target, target.resolve()}
    for home in homes:
        identities = {home, home.resolve()}
        for candidate in targets:
            for identity in identities:
                if deleting and (candidate == identity or candidate in identity.parents):
                    return True
        files = set(_RUNTIME_MUTATION_FILES)
        trees = set(_RUNTIME_MUTATION_TREES)
        if reading:
            files.difference_update({"state.db", "state.db-wal", "state.db-shm"})
            trees.discard("sessions")
        if home.exists():
            files.update(item.name for item in home.iterdir()
                         if item.name.lower().startswith(".env."))
        # Unknown future env variants are sensitive only directly in this home.
        for candidate in targets:
            for identity in identities:
                if candidate.parent == identity and candidate.name.lower().startswith(".env."):
                    return True
        for relative in files | trees:
            lexical = home / relative
            for protected in (lexical, lexical.resolve()):
                for candidate in targets:
                    if candidate == protected:
                        return True
                    if relative in trees and protected in candidate.parents:
                        return True
                    if deleting and candidate in protected.parents:
                        return True
    return False


def build_write_denied_paths(home: str) -> set[str]:
    """Return exact sensitive paths that must never be written."""
    youtab_home = _youtab_home_path()
    youtab_root = _youtab_root_path()
    return {
        os.path.realpath(p)
        for p in [
            os.path.join(home, ".ssh", "authorized_keys"),
            os.path.join(home, ".ssh", "id_rsa"),
            os.path.join(home, ".ssh", "id_ed25519"),
            os.path.join(home, ".ssh", "config"),
            # Active profile .env (or top-level .env when not in profile mode).
            str(youtab_home / ".env"),
            # Top-level .env, even when running under a profile — overwriting it
            # leaks credentials across every profile that inherits from root (#15981).
            str(youtab_root / ".env"),
            # Active profile Anthropic PKCE credential store.
            str(youtab_home / ".anthropic_oauth.json"),
            # Top-level Anthropic PKCE credential store remains sensitive even
            # when a profile is active; default/non-profile sessions still read it.
            str(youtab_root / ".anthropic_oauth.json"),
            # Bitwarden Secrets Manager encrypted disk cache.
            str(youtab_home / "cache" / "bws_cache.enc.json"),
            str(youtab_root / "cache" / "bws_cache.enc.json"),
            os.path.join(home, ".netrc"),
            os.path.join(home, ".pgpass"),
            os.path.join(home, ".npmrc"),
            os.path.join(home, ".pypirc"),
            os.path.join(home, ".git-credentials"),
            "/etc/sudoers",
            "/etc/passwd",
            "/etc/shadow",
        ]
    }


def build_write_denied_prefixes(home: str) -> list[str]:
    """Return sensitive directory prefixes that must never be written."""
    return [
        os.path.realpath(p) + os.sep
        for p in [
            os.path.join(home, ".ssh"),
            os.path.join(home, ".aws"),
            os.path.join(home, ".gnupg"),
            os.path.join(home, ".kube"),
            "/etc/sudoers.d",
            "/etc/systemd",
            os.path.join(home, ".docker"),
            os.path.join(home, ".azure"),
            os.path.join(home, ".config", "gh"),
            os.path.join(home, ".config", "gcloud"),
        ]
    ]


def get_safe_write_roots() -> set[str]:
    """Return resolved YOUTAB_AGENT_WRITE_SAFE_ROOT paths. Supports multiple directories
    separated by ``os.pathsep`` (``:`` on Unix, ``;`` on Windows).
    E.g., ``/opt/data:/var/www/html`` on Unix, ``C:\\data;D:\\www`` on Windows."""
    env = os.getenv("YOUTAB_AGENT_WRITE_SAFE_ROOT", "")
    if not env:
        return set()
    roots: set[str] = set()
    for path in env.split(os.pathsep):
        if path:
            try:
                resolved = os.path.realpath(os.path.expanduser(path))
                roots.add(resolved)
            except (OSError, ValueError):
                continue
    return roots


def _classify_write_denial(path: str) -> Optional[str]:
    """Return ``'credential'``, ``'safe_root'``, or ``None`` if writes are allowed."""
    home = os.path.realpath(os.path.expanduser("~"))
    resolved = os.path.realpath(os.path.expanduser(str(path)))

    if resolved in build_write_denied_paths(home):
        return "credential"
    for prefix in build_write_denied_prefixes(home):
        if resolved.startswith(prefix):
            return "credential"

    mcp_tokens_dir_name = "mcp-tokens"

    youtab_dirs = []
    for base in (_youtab_home_path(), _youtab_root_path()):
        try:
            real = os.path.realpath(base)
            if real not in youtab_dirs:
                youtab_dirs.append(real)
        except Exception:
            continue

    for base_real in youtab_dirs:
        # Session transcripts are application-owned state.  Letting the agent's
        # generic file tools rewrite state.db or legacy JSON snapshots can
        # falsify conversation history and invalidate resume/compression state.
        try:
            if resolved == os.path.realpath(os.path.join(base_real, "state.db")):
                return True
            sessions_real = os.path.realpath(os.path.join(base_real, "sessions"))
            if resolved == sessions_real or resolved.startswith(sessions_real + os.sep):
                return True
        except Exception:
            pass
        try:
            mcp_real = os.path.realpath(os.path.join(base_real, mcp_tokens_dir_name))
            if resolved == mcp_real or resolved.startswith(mcp_real + os.sep):
                return "credential"
        except Exception:
            pass
        try:
            pairing_real = os.path.realpath(os.path.join(base_real, "pairing"))
            if resolved == pairing_real or resolved.startswith(pairing_real + os.sep):
                return "credential"
        except Exception:
            pass

    safe_roots = get_safe_write_roots()
    if safe_roots:
        allowed = False
        for safe_root in safe_roots:
            if resolved == safe_root or resolved.startswith(safe_root + os.sep):
                allowed = True
                break
        if not allowed:
            return "safe_root"

    return None


def is_write_denied(path: str) -> bool:
    """Return True if path is blocked by the write denylist or safe root."""
    return _classify_write_denial(path) is not None


def get_write_denied_error(path: str, *, verb: str = "Write") -> Optional[str]:
    """Return a user/model-facing error when writes to ``path`` are blocked."""
    denial = _classify_write_denial(path)
    if denial is None:
        return None
    if denial == "safe_root":
        roots_display = os.pathsep.join(sorted(get_safe_write_roots()))
        return (
            f"{verb} denied: '{path}' is outside YOUTAB_AGENT_WRITE_SAFE_ROOT "
            f"({roots_display}). Unset the variable or add this path's directory prefix."
        )
    return f"{verb} denied: '{path}' is a protected system/credential file."


# Common secret-bearing project-local environment file basenames.
# These are blocked because .env files routinely contain API keys,
# database passwords, and other credentials.
_BLOCKED_PROJECT_ENV_BASENAMES: set[str] = {
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    ".env.staging",
    ".envrc",
}


def get_read_block_error(path: str) -> Optional[str]:
    """Return an error message when a read targets a denied Youtab path.

    Three categories are blocked:

      * Internal Youtab cache files under ``YOUTAB_AGENT_HOME/skills/.hub`` —
        readable metadata that an attacker could use as a prompt-injection
        carrier.
      * Credential / secret stores under YOUTAB_AGENT_HOME and the global Youtab
        root: ``auth.json``, ``auth.lock``, ``.anthropic_oauth.json``,
        ``.env``, ``webhook_subscriptions.json``, ``auth/google_oauth.json``,
        and anything under ``mcp-tokens/``. These hold plaintext provider keys,
        OAuth tokens, and HMAC secrets that the agent never needs to read
        directly — provider tools / gateway adapters consume them through
        internal channels.
      * Project-local environment files anywhere on disk: ``.env``,
        ``.env.local``, ``.env.development``, ``.env.production``,
        ``.env.test``, ``.env.staging``, ``.envrc``. These routinely hold
        API keys, database passwords, and other credentials for the user's
        own projects. The agent helping debug a project shouldn't normally
        need to read these — ``.env.example`` is the documented-shape
        substitute.

    **This is NOT a security boundary.** The terminal tool runs as the
    same OS user with shell access; the agent can still ``cat auth.json``
    or ``cat ~/.youtab-agent-runtime/.env`` and exfiltrate the file. The read-deny exists
    as defense-in-depth that:

      * Returns a clear error to models that respect tool denials, which
        empirically prompts most modern models to stop rather than reach
        for the shell.
      * Surfaces a visible audit trail when something tries to read
        credentials — easier to spot in logs than a generic ``cat``.

    Treat any user-visible framing around this as "may help" rather than
    "stops attackers." A determined model or malicious instruction can
    always shell out.

    Callers that resolve relative paths against a non-process cwd
    (e.g. ``TERMINAL_CWD`` in ``tools/file_tools.py``) MUST pre-resolve
    and pass the absolute path string.  This function's own ``resolve()``
    is anchored at the Python process cwd, so a relative input like
    ``"auth.json"`` would otherwise miss the denylist when the task's
    terminal cwd differs from the process cwd.
    """
    resolved = Path(path).expanduser().resolve()

    # Resolve BOTH the active YOUTAB_AGENT_HOME (profile-aware) AND the global
    # Youtab root so credential stores at <root>/auth.json etc. are also
    # blocked when running under a profile (YOUTAB_AGENT_HOME points at
    # <root>/profiles/<name> in profile mode). Same shape as the write
    # deny widening (#15981, #14157).
    youtab_dirs: list[Path] = []
    for base in (_youtab_home_path(), _youtab_root_path()):
        try:
            real = base.resolve()
            if real not in youtab_dirs:
                youtab_dirs.append(real)
        except Exception:
            continue

    # Skills .hub: prompt-injection carriers.
    for hd in youtab_dirs:
        blocked_dirs = [
            hd / "skills" / ".hub" / "index-cache",
            hd / "skills" / ".hub",
        ]
        for blocked in blocked_dirs:
            try:
                resolved.relative_to(blocked)
            except ValueError:
                continue
            return (
                f"Access denied: {path} is an internal Youtab cache file "
                "and cannot be read directly to prevent prompt injection. "
                "Use the skills_list or skill_view tools instead."
            )

    # Credential / secret stores. Exact-file matches under either
    # YOUTAB_AGENT_HOME or <root>.
    credential_file_names = (
        "auth.json",
        "auth.lock",
        ".anthropic_oauth.json",
        ".env",
        "webhook_subscriptions.json",
        os.path.join("auth", "google_oauth.json"),
        # Bitwarden Secrets Manager disk cache: stores plaintext secret values
        # to avoid re-fetching across back-to-back CLI invocations. The file
        # was introduced by #31968 but not added to this guard.
        os.path.join("cache", "bws_cache.json"),
    )
    for hd in youtab_dirs:
        for name in credential_file_names:
            try:
                blocked = (hd / name).resolve()
            except Exception:
                continue
            if resolved == blocked:
                return (
                    f"Access denied: {path} is a Youtab credential store "
                    "and cannot be read directly. Provider tools consume "
                    "these credentials through internal channels. "
                    "(Defense-in-depth — not a security boundary; the "
                    "terminal tool can still bypass.)"
                )

    # mcp-tokens/: directory prefix match — anything inside is OAuth
    # token material.
    for hd in youtab_dirs:
        try:
            mcp_tokens = (hd / "mcp-tokens").resolve()
        except Exception:
            continue
        if resolved == mcp_tokens:
            return (
                f"Access denied: {path} is the Youtab MCP token directory "
                "and cannot be read directly. (Defense-in-depth — not a "
                "security boundary; the terminal tool can still bypass.)"
            )
        try:
            resolved.relative_to(mcp_tokens)
        except ValueError:
            continue
        return (
            f"Access denied: {path} is a Youtab MCP token file "
            "and cannot be read directly. (Defense-in-depth — not a "
            "security boundary; the terminal tool can still bypass.)"
        )

    # Block common secret-bearing project-local .env files anywhere on disk.
    # The agent helping a user with their project rarely needs to read raw
    # .env contents — .env.example is the documented-shape substitute. The
    # terminal tool can still ``cat .env``; this is defense-in-depth, not a
    # boundary (see module docstring).
    if resolved.name.lower() in _BLOCKED_PROJECT_ENV_BASENAMES:
        return (
            f"Access denied: {path} is a secret-bearing environment file "
            "and cannot be read to prevent credential leakage. "
            "If you need to check the file structure, read .env.example instead. "
            "(Defense-in-depth — not a security boundary; the terminal tool can still bypass.)"
        )

    return None


def raise_if_read_blocked(path: str) -> None:
    """Raise ``ValueError`` if ``path`` is a denied Youtab read (see
    :func:`get_read_block_error`), else return.

    Shared chokepoint for provider input-loading sites that read a local
    file the model/tool supplied (e.g. image-gen ``image_url`` /
    ``reference_image_urls`` paths). Centralizes the guard so every provider
    enforces the same read boundary with identical semantics instead of each
    open-coding the try/except block (#57698).

    Best-effort by design: if ``agent.file_safety`` machinery is somehow
    unavailable at the call site the guard no-ops rather than breaking local
    image loading — consistent with the defense-in-depth (not security
    boundary) framing of the denylist itself. The blocking ``ValueError`` from
    a real hit still propagates; only unexpected internal errors are swallowed.
    """
    try:
        blocked = get_read_block_error(path)
    except Exception:  # noqa: BLE001 - guard must never break local-file loading
        return
    if blocked:
        raise ValueError(blocked)


# ---------------------------------------------------------------------------
# Cross-profile write guard (#TBD)
#
# Youtab profiles are separate YOUTAB_AGENT_HOME dirs under
# ``<root>/profiles/<name>/``. Each profile has its own skills/, plugins/,
# cron/, memories/. When an agent runs under one profile, writing into
# ANOTHER profile's directories is almost always wrong — those skills /
# plugins / cron jobs / memories affect a different session the user runs
# from a different shell.
#
# Soft guard, NOT a security boundary: the agent runs as the same OS user
# and has unrestricted terminal access, so this returns a warning the model
# can choose to honor or override with ``cross_profile=True``. Same shape
# as the dangerous-command approval flow — the agent is told the boundary
# exists, and explicit user direction is required to cross it.
#
# Reference: May 2026 incident where a youtab-security profile session
# edited skills under both ``~/.youtab-agent-runtime/profiles/youtab-security/skills/``
# AND ``~/.youtab-agent-runtime/skills/`` (the default profile's skills) without realizing
# the second path belonged to a different profile.
# ---------------------------------------------------------------------------

# Profile-scoped directories under YOUTAB_AGENT_HOME / <root> / <root>/profiles/<X>/
# that should be guarded. Adding a new area here extends the guard with no
# other code change.
PROFILE_SCOPED_AREAS = ("skills", "plugins", "cron", "memories")


def _resolve_active_profile_name() -> str:
    """Return the active profile name derived from YOUTAB_AGENT_HOME.

    ``~/.youtab-agent-runtime``              -> ``"default"``
    ``~/.youtab-agent-runtime/profiles/X``  -> ``"X"``

    Falls back to ``"default"`` on any resolution failure so the guard
    never raises into the tool path.
    """
    try:
        home_real = _youtab_home_path().resolve()
        root_real = _youtab_root_path().resolve()
    except (OSError, RuntimeError):
        return "default"
    profiles_dir = root_real / "profiles"
    try:
        rel = home_real.relative_to(profiles_dir)
        parts = rel.parts
        if len(parts) >= 1:
            return parts[0]
    except ValueError:
        pass
    return "default"


def classify_cross_profile_target(path: str) -> Optional[dict]:
    """Classify a write target as cross-profile if it lands in another
    profile's scoped area (skills/plugins/cron/memories).

    Returns ``None`` when the target is outside Youtab scope, or is inside
    the ACTIVE profile, or doesn't hit a profile-scoped area. Otherwise
    returns a dict with:

      * ``active_profile``: name of the profile the agent is running as
      * ``target_profile``: name of the profile the path belongs to
      * ``area``: which scoped area (``"skills"``, ``"plugins"``, etc.)
      * ``target_path``: the resolved path string

    The caller decides what to do with the result — surface a warning to
    the model, prompt the user, or (with explicit consent /
    ``cross_profile=True``) proceed anyway.
    """
    try:
        target = Path(os.path.expanduser(str(path))).resolve()
        root_real = _youtab_root_path().resolve()
    except (OSError, RuntimeError):
        return None

    target_profile: Optional[str] = None
    area: Optional[str] = None

    try:
        rel = target.relative_to(root_real)
    except ValueError:
        return None

    parts = rel.parts
    if not parts:
        return None

    if parts[0] in PROFILE_SCOPED_AREAS:
        # ``<root>/<area>/...`` → default profile.
        target_profile = "default"
        area = parts[0]
    elif (
        parts[0] == "profiles"
        and len(parts) >= 3
        and parts[2] in PROFILE_SCOPED_AREAS
    ):
        # ``<root>/profiles/<name>/<area>/...`` → named profile.
        target_profile = parts[1]
        area = parts[2]
    else:
        return None

    active_profile = _resolve_active_profile_name()
    if target_profile == active_profile:
        # In-profile write — not a cross-profile event.
        return None

    return {
        "active_profile": active_profile,
        "target_profile": target_profile,
        "area": area,
        "target_path": str(target),
    }


def get_cross_profile_warning(path: str) -> Optional[str]:
    """Return a model-facing warning string when ``path`` is cross-profile.

    Returns ``None`` when the write is in-scope (same profile) or outside
    Youtab entirely. Caller is expected to surface the warning to the
    agent as a tool-result error, NOT to silently allow the write — the
    agent must either get explicit user direction to proceed, or pass
    ``cross_profile=True`` to its write tool.

    This is defense-in-depth: the terminal tool runs as the same OS user
    and can write any of these paths without going through this guard.
    Treat the guard as a confusion-reducer, not a security boundary.
    """
    info = classify_cross_profile_target(path)
    if info is None:
        return None
    return (
        f"Cross-profile write blocked by soft guard: {info['target_path']} "
        f"belongs to Youtab profile {info['target_profile']!r}, but the "
        f"agent is running under profile {info['active_profile']!r}. "
        f"Editing another profile's {info['area']}/ will affect that "
        f"profile's future sessions, not the one you are currently in. "
        f"Confirm with the user before proceeding. To bypass this guard "
        f"after explicit user direction, retry the call with "
        f"``cross_profile=True``. (Defense-in-depth — not a security "
        f"boundary; the terminal tool can still bypass.)"
    )


# ---------------------------------------------------------------------------
# Sandbox-mirror write guard (#32049)
#
# Non-local terminal backends (Docker, Daytona, etc.) bind a sandbox-local
# directory to the container's ``$HOME``. The on-disk layout looks like
#
#   <YOUTAB_AGENT_HOME>/profiles/<name>/sandboxes/<backend>/<task>/home/.youtab-agent-runtime/...
#
# When the agent (running host-side) speculates that authoritative profile
# state lives at one of those sandbox-mirror paths, the write lands on the
# mirror — never read by the host process — while the host file is left
# untouched. The agent reports success, the user sees no change, and on
# disk two divergent copies accumulate. See #32049 for evidence.
#
# This guard is path-shape-only: it detects the
# ``…/sandboxes/<backend>/<task>/home/.youtab-agent-runtime/…`` segment and warns
# regardless of which Youtab profile is active. It does NOT cover the
# inner-container case where the bind mount strips the ``sandboxes/`` prefix
# (the agent's view inside the container is plain ``/root/.youtab-agent-runtime/...``);
# that case needs a separate dispatch-layer or host-side ``profile_state``
# tool.
# ---------------------------------------------------------------------------


def _find_sandbox_mirror_segments(parts: tuple) -> Optional[int]:
    """Return the index of the inner ``.youtab-agent-runtime`` part in a sandbox-mirror path.

    Matches ``…/sandboxes/<backend>/<task>/home/.youtab-agent-runtime/…`` and returns the
    index where the inner Youtab-state portion starts. Returns ``None`` for
    paths that do not contain the sandbox-mirror shape.
    """
    for i, part in enumerate(parts):
        if part != "sandboxes":
            continue
        # Need at least: sandboxes / <backend> / <task> / home / .youtab-agent-runtime / <thing>
        if i + 5 >= len(parts):
            continue
        if parts[i + 3] == "home" and parts[i + 4] == ".youtab-agent-runtime":
            return i + 4
    return None


def classify_sandbox_mirror_target(path: str) -> Optional[dict]:
    """Classify a write target as a sandbox-mirror of authoritative Youtab state.

    Returns ``None`` when the path does not match the sandbox-mirror shape.
    Otherwise returns a dict with:

      * ``target_path``: the resolved path string
      * ``mirror_root``: the ``…/sandboxes/<backend>/<task>/home/.youtab-agent-runtime``
        prefix (so callers can show users which sandbox owns the mirror)
      * ``inner_path``: the portion under the mirror's ``.youtab-agent-runtime`` (what the
        agent likely meant to address on the host)

    Detection is path-shape-only — does not require any Youtab resolver to
    succeed, so it works correctly even when called from contexts where
    YOUTAB_AGENT_HOME resolution would be ambiguous.
    """
    try:
        target = Path(os.path.expanduser(str(path))).resolve()
    except (OSError, RuntimeError):
        return None

    parts = target.parts
    inner_idx = _find_sandbox_mirror_segments(parts)
    if inner_idx is None:
        return None

    mirror_root = str(Path(*parts[: inner_idx + 1]))
    inner_path = str(Path(*parts[inner_idx + 1 :])) if inner_idx + 1 < len(parts) else ""

    return {
        "target_path": str(target),
        "mirror_root": mirror_root,
        "inner_path": inner_path,
    }


def get_sandbox_mirror_warning(path: str) -> Optional[str]:
    """Return a model-facing warning when ``path`` lands in a sandbox mirror.

    Returns ``None`` when the path is not a sandbox-mirror target. Caller
    is expected to surface the warning to the agent as a tool-result
    error. The bypass kwarg (``cross_profile=True``) is shared with the
    cross-profile guard: both are soft "I know what I'm doing" overrides
    a user can authorise.

    Defense-in-depth, NOT a security boundary: the terminal tool runs as
    the same OS user and can write the mirror path directly. The guard
    exists to surface the misclassification before the silent-success +
    divergent-copy footgun in #32049 fires.
    """
    info = classify_sandbox_mirror_target(path)
    if info is None:
        return None
    return (
        f"Sandbox-mirror write blocked by soft guard: {info['target_path']} "
        f"sits under {info['mirror_root']!r}, which is a per-task mirror "
        f"created by a non-local terminal backend (docker/daytona/etc.). "
        f"Writes here land on a copy that the host Youtab process never "
        f"reads — the authoritative file is likely {info['inner_path']!r} "
        f"under the real YOUTAB_AGENT_HOME. Use the host-side tool for "
        f"authoritative state (e.g. ``memory`` for memories), or address "
        f"the host path directly. To bypass this guard after explicit "
        f"user direction, retry the call with ``cross_profile=True``. "
        f"(Defense-in-depth — not a security boundary; the terminal tool "
        f"can still bypass.)"
    )


# ---------------------------------------------------------------------------
# Container-context mirror guard (inner-container case — #32049 follow-up)
#
# Brian's shape-based detector (#32213) catches paths that still carry the
# full ``…/sandboxes/<backend>/<task>/home/.youtab-agent-runtime/…`` prefix on the host.
# But when file tools execute *inside* the container the bind-mount strips
# that prefix: the agent sees plain ``/root/.youtab-agent-runtime/…``.  The root:root
# ownership on the divergent SOUL.md in #32049 confirms this is the primary
# failure mode.
#
# Fix: file_tools passes the active Docker mirror prefix when the terminal
# backend is docker + persistent. This catches the very first file-tool call,
# before a DockerEnvironment object necessarily exists.
# ---------------------------------------------------------------------------


def classify_container_mirror_target(
    path: str,
    mirror_prefix: str | None = None,
) -> Optional[dict]:
    """Classify a write target as a container-side sandbox mirror.

    ``mirror_prefix`` must be supplied by the caller after it has established
    that file tools are executing in a container whose home is a sandbox
    mirror. Returns ``None`` when no such context is active or the path is not
    under the mirror prefix. Otherwise returns:

      * ``target_path``: resolved path string
      * ``mirror_root``: the declared container mirror prefix
      * ``inner_path``: portion under the mirror root (what the agent
        likely meant to address in the host YOUTAB_AGENT_HOME)
    """
    if not mirror_prefix:
        return None
    try:
        target = Path(os.path.expanduser(str(path))).resolve()
        mirror = Path(os.path.expanduser(mirror_prefix)).resolve()
        inner = target.relative_to(mirror)
    except (OSError, RuntimeError, ValueError):
        return None
    return {
        "target_path": str(target),
        "mirror_root": str(mirror),
        "inner_path": inner.as_posix(),
    }


def get_container_mirror_warning(
    path: str,
    mirror_prefix: str | None = None,
) -> Optional[str]:
    """Return a model-facing warning when *path* lands in the container's
    sandbox mirror of authoritative Youtab state.

    The caller supplies ``mirror_prefix`` only when the current file-tool
    backend is known to execute inside a Docker sandbox. Same contract as
    ``get_cross_profile_warning``: soft guard, returns ``None`` for
    non-mirror paths, caller surfaces as a tool-result error. Bypass via
    ``cross_profile=True`` after explicit user direction.
    """
    info = classify_container_mirror_target(path, mirror_prefix)
    if info is None:
        return None
    return (
        f"Sandbox-mirror write blocked by soft guard: {info['target_path']} "
        f"sits under {info['mirror_root']!r}, which is the container's "
        f"bind-mounted home — a per-task mirror that the host Youtab "
        f"process never reads. The authoritative file is "
        f"{info['inner_path']!r} under the real YOUTAB_AGENT_HOME. Use the "
        f"host-side tool for authoritative state (e.g. ``memory`` for "
        f"memories), or address the host path directly. To bypass after "
        f"explicit user direction, retry with ``cross_profile=True``. "
        f"(Defense-in-depth — not a security boundary; the terminal tool "
        f"can still bypass.)"
    )


def _bound_file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def _bound_same_file(info):
    # ctime meanings differ across Windows stat APIs, not within one API.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _darwin_descriptor_path(descriptor):
    import fcntl

    # XNU F_GETPATH (50) fills MAXPATHLEN (1024) bytes, including its NUL.
    result = fcntl.fcntl(descriptor, getattr(fcntl, "F_GETPATH", 50), b"\0" * 1024)
    value, terminator, _padding = result.partition(b"\0")
    if not terminator or not value.startswith(b"/"):
        raise OSError("Unable to bind the Darwin descriptor path")
    return os.fsdecode(value)


def _bound_descriptor_path(descriptor, approved):
    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes

        query = ctypes.WinDLL("kernel32", use_last_error=True).GetFinalPathNameByHandleW
        query.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
        query.restype = wintypes.DWORD
        handle = msvcrt.get_osfhandle(descriptor)
        needed = query(handle, None, 0, 0)
        if not needed:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_unicode_buffer(needed + 1)
        written = query(handle, buffer, len(buffer), 0)
        if not written or written >= len(buffer):
            raise OSError("Unable to bind the file descriptor path")
        actual = buffer.value
        if actual.startswith("\\\\?\\UNC\\"):
            return "\\\\" + actual[8:]
        if actual.startswith("\\\\?\\"):
            return actual[4:]
        return actual
    if sys.platform == "darwin":
        return _darwin_descriptor_path(descriptor)
    descriptor_link = Path("/proc/self/fd") / str(descriptor)
    if descriptor_link.parent.is_dir():
        return os.readlink(descriptor_link)
    # Other POSIX systems retain nofollow, regular-file and inode checks below.
    return approved


class BoundReadFile:
    """A retained regular-file descriptor with repeated name/policy checks."""
    def __init__(self, path: Path, validate, maximum: int):
        self.path = Path(path)
        self.validate = validate
        self.maximum = maximum
        self.descriptor = None
        validate(self.path)
        self.named_before = self.path.lstat()
        if not stat.S_ISREG(self.named_before.st_mode) or self.named_before.st_nlink != 1:
            raise PermissionError("Only a single-link regular file may be read")
        if self.named_before.st_size > maximum:
            raise ValueError("File exceeds the read size limit")
        self.descriptor = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                                  | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
        try:
            self.before = os.fstat(self.descriptor)
            if _bound_same_file(self.before) != _bound_same_file(self.named_before):
                raise PermissionError("File changed before reading")
            self.assert_bound()
        except BaseException:
            self.close()
            raise

    def assert_bound(self):
        if self.descriptor is None:
            raise ValueError("File is closed")
        current = os.fstat(self.descriptor)
        if (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
                or _bound_file_identity(current) != _bound_file_identity(self.before)):
            raise PermissionError("File changed while reading")
        actual = _bound_descriptor_path(self.descriptor, str(self.path))
        if os.path.normcase(os.path.normpath(actual)) != os.path.normcase(os.path.normpath(str(self.path))):
            raise PermissionError("File descriptor changed its authorized path")
        self.validate(self.path)
        named = self.path.lstat()
        if (not stat.S_ISREG(named.st_mode) or named.st_nlink != 1
                or _bound_file_identity(named) != _bound_file_identity(self.named_before)
                or _bound_same_file(named) != _bound_same_file(current)):
            raise PermissionError("File entry changed while reading")

    def read(self, count: int):
        if not isinstance(count, int) or count < 0:
            raise ValueError("A bounded read size is required")
        chunks = []
        remaining = count
        while remaining:
            self.assert_bound()
            data = os.read(self.descriptor, remaining)
            self.assert_bound()
            if not data:
                break
            chunks.append(data)
            remaining -= len(data)
        return b"".join(chunks)

    def seek(self, offset: int):
        self.assert_bound()
        return os.lseek(self.descriptor, offset, os.SEEK_SET)

    def close(self):
        descriptor, self.descriptor = self.descriptor, None
        if descriptor is not None:
            os.close(descriptor)

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        self.close()


_mutation_lock = threading.RLock()
_active_mutations = {}
_active_deletes = {}


def _overlapping_mutation(left, right):
    return left == right or left in right.parents or right in left.parents


class MutationParentGuard:
    def __init__(self, target, validate, *, create_parents=False):
        self.target = Path(target)
        if not self.target.is_absolute() or self.target.name in ('', '.', '..') or '..' in self.target.parts:
            raise ValueError('Absolute normalized leaf target required')
        if '\0' in str(self.target) or (os.name == 'nt' and ':' in self.target.name):
            raise ValueError('Invalid or alternate-stream leaf refused')
        self.validate = validate
        self.handles = []
        self.parent_fd = None
        self.closed = False
        self.stages = {}
        try:
            with _mutation_lock:
                if any(_overlapping_mutation(self.target, path) for path in _active_deletes.values()):
                    raise PermissionError('Path has an active managed deletion')
                _active_mutations[id(self)] = self.target
            validate(self.target)
            if os.name == 'nt':
                self._windows_parents(create_parents)
            else:
                self._posix_parents(create_parents)
            self.assert_bound()
        except BaseException:
            self.close()
            raise

    def _windows_parents(self, create):
        for parent in (*reversed(self.target.parent.parents), self.target.parent):
            if not parent.exists() and create:
                self.validate(self.target)
                parent.mkdir()
            self._windows_hold(parent)

    def _windows_hold(self, path):
        import win32con
        import win32file
        if not path.exists():
            raise FileNotFoundError(path)
        if path.lstat().st_file_attributes & 0x400:
            raise PermissionError('Mutation parent is a reparse point')
        handle = _native_mutation_call(win32file.CreateFile, str(path), 0x0080 | 0x0001,  # FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY
                    win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE, None,
                    win32con.OPEN_EXISTING, win32con.FILE_FLAG_BACKUP_SEMANTICS | 0x00200000, None)
        try:
            attributes = _native_mutation_call(win32file.GetFileInformationByHandle, handle)[0]
            if attributes & 0x400 or not attributes & win32con.FILE_ATTRIBUTE_DIRECTORY:
                raise PermissionError('Mutation parent changed to a reparse point')
            actual = _native_mutation_call(win32file.GetFinalPathNameByHandle, handle, 0)
            if actual.startswith('\\\\?\\UNC\\'):
                actual = '\\\\' + actual[8:]
            elif actual.startswith('\\\\?\\'):
                actual = actual[4:]
            if os.path.normcase(os.path.normpath(actual)) != os.path.normcase(os.path.normpath(str(path))):
                raise PermissionError('Mutation directory handle has unexpected path')
            self.handles.append((path, handle))
        except BaseException:
            _native_mutation_call(handle.Close)
            raise

    def _posix_parents(self, create):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open(self.target.anchor, flags)
        prefix = Path(self.target.anchor)
        self.handles.append((prefix, fd))
        for part in self.target.parent.parts[1:]:
            self._assert_posix_prefix(prefix, fd)
            try:
                next_fd = os.open(part, flags, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                self._assert_posix_prefix(prefix, fd)
                self.validate(self.target)
                os.mkdir(part, dir_fd=fd)
                next_fd = os.open(part, flags, dir_fd=fd)
            try:
                if not stat.S_ISDIR(os.fstat(next_fd).st_mode):
                    raise PermissionError('Mutation parent is not a directory')
            except BaseException:
                os.close(next_fd)
                raise
            fd = next_fd
            prefix = prefix / part
            self.handles.append((prefix, fd))
        self.parent_fd = fd

    def assert_bound(self):
        if self.closed:
            raise RuntimeError('Mutation parent guard is closed')
        self.validate(self.target)
        if os.name == 'nt':
            for path, _handle in self.handles:
                if path.lstat().st_file_attributes & 0x400:
                    raise PermissionError('Mutation parent was substituted')
        else:
            for prefix, fd in self.handles:
                self._assert_posix_prefix(prefix, fd)

    def _assert_posix_prefix(self, prefix, fd):
        if sys.platform == 'darwin':
            actual = Path(_darwin_descriptor_path(fd))
        else:
            if not Path('/proc/self/fd').is_dir():
                raise OSError('Descriptor-path mutation binding unavailable on this platform')
            actual = Path(os.readlink(f'/proc/self/fd/{fd}'))
        if actual != prefix:
            raise PermissionError('Mutation parent no longer has its approved path')

    def mkdir_leaf(self):
        self.assert_bound()
        try:
            if os.name == 'nt':
                self.target.mkdir()
            else:
                os.mkdir(self.target.name, dir_fd=self.parent_fd)
        except FileExistsError:
            current = (self.target.lstat() if os.name == 'nt' else
                       os.stat(self.target.name, dir_fd=self.parent_fd, follow_symlinks=False))
            if not stat.S_ISDIR(current.st_mode) or getattr(current, 'st_file_attributes', 0) & 0x400:
                raise PermissionError('Directory target is not a regular directory')
        self.assert_bound()





    def close(self):
        if self.closed:
            return
        self.closed = True
        errors = []
        for _path, handle in reversed(self.handles):
            try:
                _native_mutation_call(handle.Close) if os.name == 'nt' else os.close(handle)
            except Exception as error:
                errors.append(error)
        self.handles.clear()
        with _mutation_lock:
            _active_mutations.pop(id(self), None)
            _active_deletes.pop(id(self), None)
        if errors:
            raise errors[0]

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        self.close()


def _native_mutation_call(function, *args):
    try:
        return function(*args)
    except Exception as error:
        import pywintypes
        if not isinstance(error, pywintypes.error):
            raise
        code = error.winerror if hasattr(error, "winerror") else error.args[0]
        converted = ctypes.WinError(code)
        raise converted from error


class WindowsStagedFile:
    def __init__(self, guard):
        import win32con
        import win32file
        self.guard = guard
        guard.assert_bound()
        self.path = guard.target.with_name(f'.{guard.target.name}.{uuid.uuid4().hex}.upload')
        self.handle = _native_mutation_call(win32file.CreateFile, str(self.path), win32con.GENERIC_WRITE | win32con.DELETE | 0x0080,
            0, None, win32con.CREATE_NEW, win32con.FILE_ATTRIBUTE_NORMAL | 0x00200000, None)
        self.committed = False

    def write(self, data):
        import win32file
        self.guard.assert_bound()
        error, count = _native_mutation_call(win32file.WriteFile, self.handle, data)
        if error or count != len(data):
            raise OSError('Incomplete staging write')

    def commit(self, overwrite):
        import win32file
        self.guard.assert_bound()
        _native_mutation_call(win32file.FlushFileBuffers, self.handle)
        class RenameInfo(ctypes.Structure):
            _fields_ = [('replace', W.BOOLEAN), ('root', W.HANDLE),
                        ('length', W.DWORD), ('name', W.WCHAR * 1)]
        encoded = str(self.guard.target).encode('utf-16-le')
        size = RenameInfo.name.offset + len(encoded) + ctypes.sizeof(W.WCHAR)
        storage = ctypes.create_string_buffer(size)
        info = RenameInfo.from_buffer(storage)
        info.replace = bool(overwrite)
        info.root = None
        info.length = len(encoded)
        ctypes.memmove(ctypes.addressof(storage) + RenameInfo.name.offset, encoded, len(encoded))
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        rename = kernel.SetFileInformationByHandle
        rename.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
        rename.restype = W.BOOL
        if not rename(int(self.handle), 3, storage, size):
            error = ctypes.get_last_error()
            if error in (80, 183):
                raise FileExistsError(error, 'Destination exists', str(self.guard.target))
            raise ctypes.WinError(error)
        actual = _native_mutation_call(win32file.GetFinalPathNameByHandle, self.handle, 0)
        if actual.startswith('\\\\?\\UNC\\'):
            actual = '\\\\' + actual[8:]
        elif actual.startswith('\\\\?\\'):
            actual = actual[4:]
        if os.path.normcase(os.path.normpath(actual)) != os.path.normcase(os.path.normpath(str(self.guard.target))):
            raise PermissionError('Native rename returned an unexpected destination')
        self.committed = True

    def discard_committed(self):
        """Delete this committed file by its retained handle, not its name."""
        if not self.committed or self.handle is None:
            raise RuntimeError('No committed staging handle to discard')
        self.guard.assert_bound()
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        dispose = kernel.SetFileInformationByHandle
        dispose.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
        dispose.restype = W.BOOL
        delete = W.BOOLEAN(True)
        if not dispose(int(self.handle), 4, ctypes.byref(delete), ctypes.sizeof(delete)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle is None:
            return
        try:
            if not self.committed:
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                dispose = kernel.SetFileInformationByHandle
                dispose.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
                dispose.restype = W.BOOL
                delete = W.BOOLEAN(True)
                if not dispose(int(self.handle), 4, ctypes.byref(delete), ctypes.sizeof(delete)):
                    raise ctypes.WinError(ctypes.get_last_error())
        finally:
            _native_mutation_call(self.handle.Close)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        self.close()


class PosixStagedFile:
    def __init__(self, guard):
        if os.name == 'nt':
            raise OSError('POSIX staging required')
        self.guard = guard
        guard.assert_bound()
        parent = os.fstat(guard.parent_fd)
        if parent.st_uid != os.getuid() or parent.st_mode & 0o022:
            raise PermissionError('Shared-writable mutation parent cannot protect staging ownership')
        self.directory_name = '.youtab-write-' + uuid.uuid4().hex
        self.directory_fd = None
        self.file_fd = None
        self.directory_identity = None
        self.payload_identity = None
        self.committed = False
        os.mkdir(self.directory_name, 0o700, dir_fd=guard.parent_fd)
        try:
            self.directory_fd = os.open(self.directory_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                        dir_fd=guard.parent_fd)
            info = os.fstat(self.directory_fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise PermissionError('Staging directory is not owner-only')
            self.directory_identity = (info.st_dev, info.st_ino)
            self.file_fd = os.open('payload', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                   0o600, dir_fd=self.directory_fd)
            payload = os.fstat(self.file_fd)
            self.payload_identity = (payload.st_dev, payload.st_ino)
        except BaseException:
            self.close()
            raise

    def _bound(self):
        self.guard.assert_bound()
        current = os.fstat(self.directory_fd)
        named = os.stat(self.directory_name, dir_fd=self.guard.parent_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != self.directory_identity or (named.st_dev, named.st_ino) != self.directory_identity:
            raise PermissionError('Private staging directory changed')
        parent = os.fstat(self.guard.parent_fd)
        if parent.st_uid != os.getuid() or parent.st_mode & 0o022:
            raise PermissionError('Mutation parent ownership became shared-writable')
        payload = os.fstat(self.file_fd)
        named_payload = os.stat('payload', dir_fd=self.directory_fd, follow_symlinks=False)
        if ((payload.st_dev, payload.st_ino) != self.payload_identity
                or (named_payload.st_dev, named_payload.st_ino) != self.payload_identity):
            raise PermissionError('Private staging payload was substituted')

    def write(self, data):
        self._bound()
        remaining = memoryview(data)
        while remaining:
            count = os.write(self.file_fd, remaining)
            if count <= 0:
                raise OSError('Incomplete staging write')
            remaining = remaining[count:]

    def commit(self, overwrite):
        self._bound()
        os.fsync(self.file_fd)
        if overwrite:
            os.replace('payload', self.guard.target.name, src_dir_fd=self.directory_fd,
                       dst_dir_fd=self.guard.parent_fd)
        else:
            os.link('payload', self.guard.target.name, src_dir_fd=self.directory_fd,
                    dst_dir_fd=self.guard.parent_fd, follow_symlinks=False)
            os.unlink('payload', dir_fd=self.directory_fd)
        self.committed = True
        os.fsync(self.guard.parent_fd)

    def discard_committed(self):
        """Unlink only the committed inode relative to the retained parent."""
        if not self.committed or self.file_fd is None:
            raise RuntimeError('No committed staging descriptor to discard')
        self.guard.assert_bound()
        parent = os.fstat(self.guard.parent_fd)
        if parent.st_uid != os.getuid() or parent.st_mode & 0o022:
            raise PermissionError('Shared-writable mutation parent cannot protect cleanup')
        held = os.fstat(self.file_fd)
        named = os.stat(self.guard.target.name, dir_fd=self.guard.parent_fd, follow_symlinks=False)
        if ((held.st_dev, held.st_ino) != self.payload_identity
                or (named.st_dev, named.st_ino) != self.payload_identity):
            raise PermissionError('Committed attachment was substituted before cleanup')
        os.unlink(self.guard.target.name, dir_fd=self.guard.parent_fd)
        os.fsync(self.guard.parent_fd)

    def close(self):
        errors = []
        if self.file_fd is not None:
            try:
                os.close(self.file_fd)
            except OSError as error:
                errors.append(error)
            self.file_fd = None
        if self.directory_fd is not None:
            try:
                if not self.committed:
                    named = os.stat('payload', dir_fd=self.directory_fd, follow_symlinks=False)
                    if self.payload_identity is None or (named.st_dev, named.st_ino) != self.payload_identity:
                        raise PermissionError('Foreign staging payload retained')
                    os.unlink('payload', dir_fd=self.directory_fd)
            except FileNotFoundError:
                pass
            except OSError as error:
                errors.append(error)
            finally:
                try:
                    os.close(self.directory_fd)
                except OSError as error:
                    errors.append(error)
                self.directory_fd = None
        try:
            named = os.stat(self.directory_name, dir_fd=self.guard.parent_fd, follow_symlinks=False)
            if self.directory_identity is None or (named.st_dev, named.st_ino) != self.directory_identity:
                raise PermissionError('Foreign staging directory retained')
            os.rmdir(self.directory_name, dir_fd=self.guard.parent_fd)
        except OSError as error:
            errors.append(error)
        if errors:
            raise errors[0]

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        self.close()


def staged_mutation_file(parent):
    return WindowsStagedFile(parent) if os.name == "nt" else PosixStagedFile(parent)


class ManagedDelete:
    """Preflight a retained no-follow tree, then delete its held objects.

    Windows sharing denies rename/replacement of every admitted object. POSIX
    effects are relative to retained directory FDs, with an in-process API
    reservation and rejection of shared-writable parents. POSIX does not isolate
    a hostile process running as the same UID between identity check and unlink.
    Recursive deletion is not a filesystem transaction: newly inserted objects
    are never admitted for removal and may prevent final directory removal.
    """
    def __init__(self, parent, validate, *, recursive=False):
        self.parent = parent
        self.validate = validate
        self.recursive = recursive
        self.nodes = []
        self.directories = []
        self.closed = False
        try:
            with _mutation_lock:
                if any(key != id(parent) and _overlapping_mutation(parent.target, path)
                       for key, path in _active_mutations.items()):
                    raise PermissionError('Path has an active managed mutation')
                _active_deletes[id(parent)] = parent.target
            parent.assert_bound()
            if os.name == 'nt':
                self._windows_open(parent.target)
            else:
                self._posix_directory_safe(parent.parent_fd)
                self._posix_open(parent.target, parent.parent_fd)
            self._preflight()
        except BaseException:
            self.close()
            raise

    def _windows_open(self, path):
        import win32con
        import win32file
        self.validate(path)
        handle = _native_mutation_call(win32file.CreateFile, str(path),
            win32con.DELETE | 0x0080,
            win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE, None,
            win32con.OPEN_EXISTING, win32con.FILE_FLAG_BACKUP_SEMANTICS | 0x00200000, None)
        node = {'path': path, 'handle': handle, 'parent_fd': None}
        self.nodes.append(node)
        attributes = _native_mutation_call(win32file.GetFileInformationByHandle, handle)[0]
        directory = bool(attributes & 0x10 and not attributes & 0x400)
        node['directory'] = directory
        if directory:
            with os.scandir(path) as entries:
                names = {entry.name for entry in entries}
            if names and not self.recursive:
                raise OSError(39, 'Directory is not empty', str(path))
            node['names'] = names
            self.directories.append(node)
            for name in sorted(names):
                self._windows_open(path / name)

    def _posix_directory_safe(self, descriptor):
        info = os.fstat(descriptor)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise PermissionError('Shared-writable deletion directory refused')

    def _posix_open(self, path, parent_fd):
        self.validate(path)
        # Both adapters retain the symlink inode, never its target.
        if sys.platform == 'darwin':
            if not all(hasattr(os, flag) for flag in ('O_EVTONLY', 'O_SYMLINK', 'O_NONBLOCK')):
                raise OSError('Darwin no-follow leaf identity retention unavailable')
            flags = os.O_EVTONLY | os.O_SYMLINK | os.O_NONBLOCK
        else:
            if not hasattr(os, 'O_PATH'):
                raise OSError('No-follow leaf identity retention unavailable')
            flags = os.O_PATH | os.O_NOFOLLOW
        descriptor = os.open(path.name, flags, dir_fd=parent_fd)
        node = {'path': path, 'handle': descriptor, 'parent_fd': parent_fd}
        self.nodes.append(node)
        info = os.fstat(descriptor)
        node['identity'] = (info.st_dev, info.st_ino)
        node['directory'] = stat.S_ISDIR(info.st_mode)
        if node['directory']:
            directory_fd = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            node['directory_fd'] = directory_fd
            actual = os.fstat(directory_fd)
            if (actual.st_dev, actual.st_ino) != node['identity']:
                raise PermissionError('Directory changed during deletion admission')
            self._posix_directory_safe(directory_fd)
            names = set(os.listdir(directory_fd))
            if names and not self.recursive:
                raise OSError(39, 'Directory is not empty', str(path))
            node['names'] = names
            self.directories.append(node)
            for name in sorted(names):
                self._posix_open(path / name, directory_fd)

    def _preflight(self):
        self.parent.assert_bound()
        for node in self.nodes:
            self.validate(node['path'])
            if os.name != 'nt':
                self._posix_bound(node)
        for node in self.directories:
            if os.name == 'nt':
                with os.scandir(node['path']) as entries:
                    names = {entry.name for entry in entries}
            else:
                self._posix_directory_safe(node['directory_fd'])
                names = set(os.listdir(node['directory_fd']))
            if names != node['names']:
                raise PermissionError('Deletion directory changed before effects')

    def _posix_bound(self, node):
        self._posix_directory_safe(node['parent_fd'])
        self.parent._assert_posix_prefix(node['path'].parent, node['parent_fd'])
        if node.get('directory_fd') is not None:
            self.parent._assert_posix_prefix(node['path'], node['directory_fd'])
        named = os.stat(node['path'].name, dir_fd=node['parent_fd'], follow_symlinks=False)
        if (named.st_dev, named.st_ino) != node['identity']:
            raise PermissionError('Deletion leaf identity was substituted')

    def apply(self):
        if self.closed:
            raise RuntimeError('Deletion admission is closed')
        self._preflight()  # Every protected descendant is refused before any removal.
        for node in reversed(self.nodes):
            self.parent.assert_bound()
            self.validate(node['path'])
            if os.name == 'nt':
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                dispose = kernel.SetFileInformationByHandle
                dispose.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
                dispose.restype = W.BOOL
                delete = W.BOOLEAN(True)
                if not dispose(int(node['handle']), 4, ctypes.byref(delete), ctypes.sizeof(delete)):
                    raise ctypes.WinError(ctypes.get_last_error())
                _native_mutation_call(node['handle'].Close)
            else:
                self._posix_bound(node)
                effect = os.rmdir if node['directory'] else os.unlink
                effect(node['path'].name, dir_fd=node['parent_fd'])
                os.close(node['handle'])
            node['handle'] = None

    def close(self):
        if self.closed:
            return
        self.closed = True
        errors = []
        for node in reversed(self.nodes):
            for key in ('handle', 'directory_fd'):
                handle = node.get(key)
                if handle is not None:
                    try:
                        _native_mutation_call(handle.Close) if os.name == 'nt' else os.close(handle)
                    except OSError as error:
                        errors.append(error)
                    node[key] = None
        with _mutation_lock:
            _active_deletes.pop(id(self.parent), None)
        if errors:
            raise errors[0]

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        self.close()
