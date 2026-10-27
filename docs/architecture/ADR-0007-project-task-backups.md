# ADR-0007: Verified project-task backups and files-only recovery

Status: Proposed candidate implementation; scoped review and source gates are recorded separately. No claim of Owner ratification, installer qualification, or full Workspace Canon implementation.

## Reason and authority

The user requires a + PROJECT entry beside Home before the existing +profile action, a separately selected working copy, mandatory original-file backups before changes, locally retained recoverable files, and recovery without deleting chats. Optional convenience checkpoints can skip excluded or oversized files and swallow failures; they cannot satisfy this requirement. Existing rollback.restore without a file_path rewinds conversation history and is deliberately not used here.

## Persistence and contract

The existing projects.db project_meta table stores an optional working-copy-v1:<project-id> JSON policy. No table/schema migration is introduced. New native working copies carry source_path, working_path and backup_required; backend validates their relationship and the renderer requires the confirmed policy. Legacy concrete authoritative workspaces receive the same strict snapshot floor without being silently retargeted. Existing projects, profile creation, folder navigation, shortcuts and chat rows retain their behavior.

A version1 local snapshot contains complete ordinary-file coverage within declared roots, empty directories, exact sizes and SHA-256 hashes, a READY manifest and a receipt pinned to its manifest hash. Bounds are 100000 entries, 8 GiB inventory size and depth128; links/reparse entries, special files, overbroad roots, changed sources, inaccessible files, storage/ACL/cancellation/verification failures refuse effects visibly. No .env/large-file/build-file exclusion list is inherited from convenience checkpoints.

Snapshots are stored under the selected profile/backups/project-tasks-v1/<snapshot-id>. The same verified manifest and independently copied payload are retained in a new exclusively owned <original-source-or-legacy-workspace>/Youtab/.youtab-task-backups-v1-<store-id>/<snapshot-id> directory. Existing customer Youtab content is not overwritten or broadly excluded. Only validated owned backup stores are excluded from later inventories; the mapped working-copy subtree is separately snapshotted instead of recursively included in original-source coverage. Both copies must verify before a file effect is admitted. Recovery lists show the retained path. No automatic backup pruning or source/history deletion occurs.

## Enforcement and preserved capabilities

A product-owned floor runs before shared Runtime tool request/execution middleware and rechecks rewritten arguments before native dispatch. Sequential/concurrent callers share it. Built-in write_file and patch targets (including every actual V4A parser source and Move destination) must stay within the pinned backed workspace and outside excluded backup stores. Live existing ancestors must not be symlink/reparse escapes. A changed authoritative project requires a new task; a child inherits pinned roots and obtains its own verified receipt before its first relevant tool. Native file dispatch takes a cross-process profile-family advisory lease only after ordered start/authorization. Snapshot and restore use the same lease; nested roots cannot acquire unrelated locks. The lease is not held over arbitrary terminal/code/delegation waits.

Ordinary chat, trusted delegate_task dispatch (child effects still gated), owned browser interaction/read tools, computer-use capture/list/wait/browser-state, clarification, reminders, image analysis, and explicit non-project product-state tools retain their existing governed admission. Unknown MCP tools and arbitrary terminal/code/desktop effect actions conservatively require a concrete project; a third-party readOnlyHint is not proof. Existing approval, managed admission, credentials, provider, model routing and Update checks are not weakened or redefined. The managed signed-admission worker is not connected to this local floor; no cross-Brain/tenant enforcement claim follows.

The provider system-message copy includes the requirement to read the complete request and relevant files and inspect callers/dependencies/tests before edits. This is model work policy, not a measurable proof of comprehension or mandatory read coverage.

## Files-only recovery

projects.backups.list/files/preview/restore derive workspace authority from the existing project record. Preview is bound to exact snapshot, current hashes and one-use token with 300-second expiry; restore requires separate explicit confirmation. It refuses a running project session, verifies both copies, creates a verified pre-restore snapshot, and restores only explicitly selected covered files. Covered deleted parent directories are reconstructed; linked/unknown parents are refused. Targets use private staging, hash verification and per-file atomic replacement while preserving existing access permissions. Partial/failed multi-file recovery reports actual restored files and retained undo receipt. No chat/session database or conversation rewind is invoked. New/unrelated files are preserved.

## Compatibility, migration and rollback

There is no DB schema downgrade or destructive migration. A prior runtime can ignore project_meta policy, so downgrading is not evidence of equivalent protection and must not silently claim it. New Desktop refuses to present an unconfirmed working-copy policy as protected. New modules and this dirty-source identity must enter the normal private producer/compiled-artifact receipt before packaging; source tests do not qualify that EXE. Update artifact/admission/rollback requirements remain owned by their existing implementation. No installer output is built or replaced by this scope.

## Explicit limits and unfinished acceptance

This is recovery infrastructure, not an OS sandbox. Arbitrary shell scripts, execute_code, GUI/computer-use actions, MCP servers, native filesystem IPC, trusted turn-level plugin hooks and independent/background processes can write outside declared roots; those effects are not contained or comprehensively recoverable here. Terminal explicit workdir is checked, command contents are not treated as a sound effect classifier. Advisory locks coordinate participating Runtime processes in one profile family; unrelated profile families and external processes are outside that lease. Same-user/admin tampering after restart is not cryptographically prevented. Owner-only backup ACLs are not encryption at rest or IT-admin secrecy.

Recovery is per file, not atomic whole-tree rollback. Wholly deleted roots are not automatically reconstructed. Both profile and retained copies are currently required by the UI recovery service; surviving-copy-only disaster recovery is not UI-qualified, although retained directories contain independent manifest and file bytes. Copies and deep verification add disk/time costs; large-project performance and retention UX are not qualified. Full Windows/EXE/VM/chat/API/local-model acceptance, arbitrary MCP reads, comprehensive OWASP/CodeQL/tenant tests and real-model child-tool execution remain separate gates. Unit/middleware/RPC tests are scoped source evidence, not customer-readiness PASS.
