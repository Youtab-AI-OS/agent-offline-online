# Windows pilot Runtime artifact channel

This is a temporary public static delivery channel for approved Windows pilot
packages. It is **not live** until the `api.youtab.io` systemd Nginx vhost and
document root are read back, configured, and independently qualified. It does
not provide customer authorization; its high-entropy path only limits casual
discovery. The authenticated, IP-protected channel is deferred to Milestone 2.

The release operator chooses one fixed HTTPS base of the form
`https://api.youtab.io/pilot-runtime-<at-least-32-lowercase-hex>/releases`.
Keep the same value in the Nginx route, release command, and Setup build. Never
put a GitHub credential or customer secret in the installer or package.

From a clean checkout at the exact approved Runtime commit, with `$releaseBase`
set to that fixed base and `$stagingRoot` set to an offline directory outside
the checkout and outside the Nginx document root, prepare the static files
locally and build Setup:

```powershell
$sha = (git rev-parse HEAD).Trim()
$env:YOUTAB_AGENT_BUILD_PIN_COMMIT = $sha
$env:YOUTAB_AGENT_RELEASE_BASE_URL = $releaseBase
npm --prefix apps/bootstrap-installer run tauri:build
$builtSetup = "apps/bootstrap-installer/src-tauri/target/release/Youtab-Setup.exe"
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
$setupExecutable = Join-Path $stagingRoot "Youtab-Setup-$sha.exe"
if (Test-Path -LiteralPath $setupExecutable) { throw 'Immutable Setup input already exists' }
Copy-Item -LiteralPath $builtSetup -Destination $setupExecutable -ErrorAction Stop
if ((Get-FileHash -LiteralPath $builtSetup -Algorithm SHA256).Hash -cne
    (Get-FileHash -LiteralPath $setupExecutable -Algorithm SHA256).Hash) {
    throw 'Staged Setup differs from the built executable'
}
# First produce and verify the exact-source Desktop/Node/browser/TUI image
# and native Setup lease. See scripts/youtab/customer_windows_producer_receipt.py,
# build_customer_windows_image.py, build_customer_windows_runtime_payload.py,
# and assemble_customer_windows_image.py. Set the two paths below only to
# verified outputs from this same $sha and package-lock.json.
if (-not $leaseAddon -or -not $customerImage) { throw 'Exact-source producer inputs are required' }
python -B scripts/release.py --package-runtime --artifact-output-dir $stagingRoot --artifact-version 0.19.1 --release-sequence 1 --artifact-base-url $releaseBase --setup-executable $setupExecutable --setup-lease-addon $leaseAddon --customer-image $customerImage --artifact-release-notes-file docs/roadmap/windows-candidate-notes.json
```

The version and sequence above are examples; the approved release process must
set them explicitly. `$builtSetup` assumes the default Cargo output path;
use the actual built executable path if `CARGO_TARGET_DIR` is overridden.
Cargo may hardlink its output, while the release producer requires a single-link
Setup input. The verified copy in the staging directory satisfies that contract
without changing executable bytes. The Setup and all producer inputs must be
Windows x64 outputs bound to this same source SHA, lockfile and release base.
Qualify the built Setup and the staged package before publishing.
The command refuses dirty source, an output directory inside the checkout, and
an existing immutable SHA directory. It creates `<stagingRoot>/<sha>/manifest.json`,
`youtab-runtime-<sha>.zip`, `install-<sha>.ps1`, and `Youtab-Setup-<sha>.exe`.
It also advances the offline staging root's `latest.json`; it does not create
`channels/pilot/latest.json` or `channels/stable/latest.json`. Never run this
preparation command against a live document root.

After qualification and separate publication authorization, use the existing
`scripts/publish_release_channel.py` publication path described in
[Account sync and release channels](account-sync-and-release-channels.md).
It holds the publication lock, installs and verifies immutable files before
promoting the selected channel pointer, checks the expected current pointer,
and verifies public hashes and mutable-pointer cache behavior. Pilot publication
advances `channels/pilot/latest.json` and preserves legacy root `latest.json`.
Stable publication promotes the exact current Pilot bytes after hash-bound
Owner-reviewed qualification, advances `channels/stable/latest.json`, and then
advances legacy root `latest.json`. Publication failure attempts to restore the
previous discovery pointers; immutable files are retained. The offline packager's
root pointer alone does not qualify or publish the selected-channel indexes.
This publisher is implemented locally; this runbook does not claim it has run
on or qualified the VPS.

Sequences must increase per channel; Stable also preserves legacy sequence
ordering. The document root must be writable only by the authorized release
process; Nginx must deny dotfiles and must not expose temporary staging files.
Do not overwrite a published SHA directory or repoint discovery to older content.

The ZIP and standalone script are checked against the manifest SHA256 values.
Setup executes its built-in script and installs the exact manifest SHA. It
stages the ZIP beside the current install, then verifies/builds at the final
path before retiring the backup. A legacy Git install without a release
sequence has no automatic ordering in this channel and requires a separately
qualified migration. A new Setup is needed when an old Setup's script protocol
cannot read a later manifest.

Publishing to or changing the actual Nginx host, switching traffic, and
handing an installer to a customer require separate authorization and live
qualification. This runbook does not assert that the route or clean-PC flow
currently passes.

## PR #87 Setup transaction and Python CodeQL adjudication (2026-10-01)

Compared base `92f59ae67153dd9e0432d737fe58d26337a8986a` with reviewed head `c3610b2631cf32ac9019fd1754a2c39c347f121d`. Evidence:
Python SARIF from Actions run `36884759851`, job `110445111623` (35 findings
reported as new; 7,704 total). The baseline and scanner were not changed.

| Rule / source | Candidate lines → base lines | Classification / proof |
| --- | --- | --- |
| `py/unused-local-variable` / `scripts/release.py` | 127 → new, 128 → new | Candidate-created unused assignments; removed. No behavior change. |
| `py/import-and-import-from` / `tests/youtab_agent_cli/test_auth_profile_fallback.py` | 78 → 78, 231 → 231, 256 → 256, 339 → 339, 384 → 384 | Historical source: identical Git blob `9773180e67a26e8876ca3a7b81444faae8b436fe`. |
| `py/import-and-import-from` / `tests/youtab_agent_cli/test_billing_scope_stepup.py` | 7 → 7 | Historical source: identical Git blob `357dd9bbde340352ed1a3e419f1dd0f2269bae4e`. |
| `py/cyclic-import` / `youtab_agent_cli/update_cmd.py` | 1949 → 1931, 1956 → 1938, 2085 → 2067, 2104 → 2086 | Line displacement (+18): statements identical; complete AST import inventory identical. Base blob `27f9c497d00c9707f89dab515cb7b45b0234030b`; reviewed blob `266dd461cad478e5b8518c3212fc6c331f3b160f`. |
| `py/cyclic-import` / `youtab_agent_cli/web_server.py` | 6896 → 6896, 10404 → 10404 | Historical source: identical Git blob `d6e80db80865990f2d03250f756b03f96fec44fc`. |
| `py/cyclic-import` / `youtab_agent_cli/youtab_subscription.py` | 1230 → 1230 | Historical source: identical Git blob `3c1d6da5338064df2db25a55689b09e2c22acbf0`. |
| `py/cyclic-import` / `agent/auxiliary_client.py` | 1867 → 1867, 1923 → 1923, 1941 → 1941, 2226 → 2226, 2254 → 2254, 2322 → 2322, 3861 → 3861 | Historical source: identical Git blob `81833700b84c27752610534cb3990a82955119f4`. |
| `py/cyclic-import` / `youtab_agent_cli/model_setup_flows.py` | 416 → 416, 418 → 418, 424 → 424 | Historical source: identical Git blob `ffcbc0912b72c8db1125f967ad67a030c72b12c1`. |
| `py/cyclic-import` / `youtab_agent_cli/model_switch.py` | 2175 → 2175 | Historical source: identical Git blob `569a2912b186229146270e130d39ebe3f1326655`. |
| `py/cyclic-import` / `youtab_agent_cli/models.py` | 1950 → 1950, 2819 → 2819 | Historical source: identical Git blob `3e847bc2160ff253b609c2f3153fe15600d332fd`. |
| `py/cyclic-import` / `youtab_agent_cli/providers.py` | 620 → 620 | Historical source: identical Git blob `70bffdd968df2ccc879c2d01dd7b842d52b1db48`. |
| `py/cyclic-import` / `youtab_agent_cli/runtime_provider.py` | 1482 → 1482 | Historical source: identical Git blob `3a2eb402f2ca57cb641da29fb843299fbb1b5bd3`. |
| `py/unused-import` / `tests/youtab_agent_cli/test_auth_profile_fallback.py` | 15 → 15 | Historical source: identical Git blob `9773180e67a26e8876ca3a7b81444faae8b436fe`. |
| `py/unused-import` / `tests/youtab_agent_cli/test_youtab_billing_request.py` | 13 → 13 | Historical source: identical Git blob `3ffcc52901a8b4d231157b9fea44a111dbc03a3b`. |
| `py/unnecessary-lambda` / `tests/youtab_agent_cli/test_youtab_billing_request.py` | 27 → 27 | Historical source: identical Git blob `3ffcc52901a8b4d231157b9fea44a111dbc03a3b`. |
| `py/empty-except` / `agent/auxiliary_client.py` | 2223 → 2223 | Historical source: identical Git blob `81833700b84c27752610534cb3990a82955119f4`. |
| `py/empty-except` / `youtab_agent_cli/models.py` | 3115 → 3115 | Historical source: identical Git blob `3e847bc2160ff253b609c2f3153fe15600d332fd`. |

The 29 findings in identical blobs and four displaced import findings are
historical quality debt, not new Track A behavior. The changed Python production
files are release.py and update_cmd.py; the latter adds guarded artifact handoff
before the existing updater and does not change its import graph. The cyclic-import
participants are unchanged. Fingerprint/baseline reporting is not proof of new source
behavior. No candidate-created pilot-reachable security finding was identified in
this SARIF. Python CodeQL is advisory under current branch protection; its baseline
has not been edited to manufacture a green result.

### Required Setup entrypoint and recovery

Customer artifact install extends the existing InstallSwap journal to cover the
out-of-tree Setup file as well as Runtime. Setup is copied into a create-new sibling,
flushed, and SHA-256 checked against the running executable before Runtime promotion.
Existing Setup is backed up by rename, never truncated. Setup promotion and final
verification are required before commit/Complete. Updates running from the stable
Setup path verify and reuse that executable without attempting to replace it.

Before the verified commit latch, failure or cancellation restores both previous
paths; a fresh failed install removes both unverified paths. Process restart replays
the journal. If a lock or unverifiable backup prevents recovery, the journal/backups
remain and recovery fails closed. After the verified commit latch, interruption
retries cleanup of the committed pair rather than rolling it back. Completion is
not emitted when verification or cleanup fails. Legacy Runtime-only journal records
remain readable. Development/legacy best-effort copy behavior is unchanged.

This checks file identity against the already-running Setup, not code-signing trust
or a newly launched GUI. Real Windows locks, power-loss durability, customer Setup
launch, and the complete second-PC install/login/DeepSeek/restart/update cycle remain
qualification requirements. No clean-PC readiness is claimed.
