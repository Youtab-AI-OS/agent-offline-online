# Common Installer delivery roadmap

Owner sequencing instruction: 2026-10-05. This is the active delivery order.
First complete the existing common Installer and About Update; only after its
acceptance implement compiled delivery, Air-gap and organizational deployment.
UI changes remain deferred to a subsequent update.

## 2026-10-12 — Owner-required Safety and data isolation options

Status: PLANNED, not implemented or qualified. Data confidentiality is the
Owner's highest-priority acceptance requirement. Record these additions now;
continue Phase 1 Installer/Update closure first. Implement shared product
Safety policy in later privacy/offline/Enterprise phases. The Owner's later
decision requires a separate Offline Setup executable; it must not be folded
into the Phase 1 online common Installer.
An enabled switch or hidden UI is not evidence of enforced isolation.

### Settings → Safety → HardCore Options

- Provide an On/Off master control and explicit Sync On/Off, Login
  Active/Deactivated, Telemetry On/Off/Deactivated and HTTP Yes/No controls.
  Show the effective policy and explain which existing functions it disables.
- Sync Off stops uploads/downloads, retry workers and queued transfers without
  deleting local chats. Re-enabling must not silently flush previously blocked
  history; require explicit consent for its scope.
- Login Deactivated stops authorization flows, refresh, identity/entitlement
  polling and remote session traffic. Local cached identity must not initiate
  requests. Explicit activation is required before any reconnection.
- Telemetry Deactivated stops collection, exporters and retry queues, including
  third-party telemetry; disabling upload alone is insufficient. Local security
  diagnostics may remain only under a clearly separate, documented local policy.
- HTTP No means zero outbound HTTP/HTTPS requests, including loopback model
  endpoints, WebSockets, redirects, proxies and background/update/login calls.
  Other transports must not bypass a selected data-transfer prohibition.
  Explain that a local HTTP model server requires an explicit local-only policy
  instead of HTTP No, or a supported non-network model transport.
- Enforce selected restrictions at effect boundaries shared by Desktop, CLI,
  workers, agents, plugins, MCP, browser and child processes. No tool, model
  instruction, reconnect, environment override or fallback may silently relax
  them. Deny unsupported capabilities rather than claim isolation.

### Settings → Safety → Local-Only / Air-gapped

- Local-Only permits only explicitly approved on-device model/service endpoints;
  deny all external destinations, including Youtab. Organizational internal
  endpoints require a separate administrator-controlled allowlist.
- Air-gapped disables public login, cloud sync, telemetry, online update checks,
  external models/tools and all external communication. It must remain effective
  when a network connection becomes available; never reconnect automatically.
- Preserve local chats, credentials and settings. No chat, file, prompt, tool
  result, device identifier, usage record, crash report or queued payload may
  leave for Youtab or another external service while the policy prohibits it.
- Bind organizational policy to tenant/device authority; user toggles cannot
  weaken administrator restrictions. Use supported OS/network containment for
  arbitrary subprocesses and extensions, not only application HTTP wrappers.
- Air-gapped is not a synonym for using a local model. Qualify self-contained
  installation and authenticated offline update under Phase 3, with no mandatory
  public login, entitlement renewal, dependency fetch or external fallback.

### Settings → Safety → File System Permissions

- Let users select allowed folders and Read/Write/Create/Delete permissions;
  default-deny outside approved roots. Enterprise policy can restrict these
  grants and must not be overridden by model output or an extension.
- Enforce permissions for file tools, shell/child processes, plugins/MCP,
  generated files, review/download, memory and background tasks. Declare any
  unsupported sandbox boundary and disable that capability until enforced.
- Resolve canonical paths and Windows junctions/symlinks/reparse points;
  prevent traversal, alternate path forms, alias/hardlink escapes and races
  between authorization and access. Explicitly define cross-platform behavior.
- Separate minimal private application-state access from user workspace grants;
  disclose its purpose and never expose credential stores through workspace tools.

### Required acceptance evidence

- Map implementation and negative behavior tests to OWASP Top 10:2025,
  OWASP LLM Top 10:2025 and OWASP Agentic Top 10:2026; retain the existing
  authorization, tenant, least-privilege and untrusted-input requirements.
- Observe actual network egress (including DNS and non-HTTP transports) during
  startup, inference, tools, login, sync, telemetry, crash, restart and update.
  Test both disconnected and connected hosts, policy transitions, pending queues,
  redirects/proxies, subprocesses/extensions and attempted policy bypasses.
- HTTP No acceptance: zero outbound HTTP/HTTPS attempts. Air-gapped acceptance:
  zero external communication/data transfer, including after connectivity returns.
  Local-Only acceptance: only the explicit local/internal allowlist is reachable.
- Verify file-boundary denial with malicious paths, links, races, shell tools and
  prompt-injection attempts; include real clean-host E2E and Smoke tests.
- Record exact source, artifact hashes, effective policy, network/OS enforcement
  and observed results. Do not advertise these modes as safe or available until
  independent review and real installed-artifact acceptance pass.

## 2026-10-11 — Active Error Handling closure

Owner resumed the existing Goal and required security and Error Handling closure
before final real installation, About Update and account-sync acceptance. Stable
publication requires final Owner approval. This supersedes the earlier proposal
to defer these fixes; the delivered af354 bundle remains unchanged and unqualified.

- ERR01/ERR02: crash/client/worker redaction implemented in the isolated branch.
  Canonical focused Python verification: 31 passed, zero failed; independent
  current-diff review is pending. Report: `tmp/error-hardening-python-qa-r5/REPORT.md`
  in the platform workspace (outside this repository).
- Desktop: central diagnostic sanitization, per-pipe bounded UTF-8 framing,
  private-key/multiline-secret omission, renderer last-chance logging, and bounded
  FIFO recovery after failed log writes implemented. Focused new/crash tests:
  21 passed after final stream corrections; combined SSH/redaction/crash run: 81 passed before the last bounded-tail correction. These counts overlap.
  Current Electron and renderer source typechecks with existing TypeScript 6.0.3 passed via an
  explicit source/dependency resolver; this is not a full Desktop build.
- Setup: safe tracing/events, panic/UI boundary and bounded log retention are
  verified with five standalone Rust diagnostics tests (including native panic), two React behavior tests, TypeScript 6.0.3 and scoped lint. Standalone diagnostics tests do not prove Tauri,
  installed-host, panic-abort or update transaction acceptance.
- ERR03 is implemented as optional diagnostic v1 metadata and a separate canonical
  process-chain UUID. Current focused Node tests: 31 passed; canonical Python:
  72 passed; Electron and renderer TypeScript 6.0.3 passed. Counts overlap earlier
  results. Actual receipt: `tmp/error-operation-context-adoption-r4/REPORT.md` in
  the platform workspace. Current Rust and installed-chain acceptance remain OPEN.
- Full current-source CodeQL/Semgrep, dependency/secret checks, OWASP mapping,
  remote Gateway service/schema binding and real two-device sync remain OPEN.
  No baseline/rule weakening, new publication or installed-device change occurred.

Next: independent review of the actual changes; close its findings; complete
current-source required security/integration gates; rebuild the same common
Installer; perform authorized Pilot clean install/migration/next About Update,
recovery and sync acceptance; request final Stable approval for the tested hashes.
## Phase 1 — Finish the current common Installer and Update

### 2026-10-13 qualification checkpoint

Latest continuation on 2026-10-13: local online source commit
`061f7b73750cbee2df283bbcbf1ab90116cd2613` extends native Windows
admission to the final packaged Desktop resource tree before the install
completion marker. The reviewed Windows native library run passed 198 tests,
failed 0, ignored 2 fresh-provisioning cases. These are synthetic tests, not
a clean installed-artifact acceptance. The older `bbee418f` Setup/ZIP must
not be relabelled as this source. Docker Desktop was restored after the
resource-bounded test; the local model server remains off by Owner choice.
Evidence:
`F:\Youtab_AI_COS_Platform\tmp\phase1-native-desktop-admission-20261013.md`.

Runtime PR #96 remains red/unqualified. Its isolated, unpublished fixes cover
Python security test fixtures and a bounded GitNexus proxy snapshot, but
Windows GitNexus `dist` admission and direct unauthenticated upstream API
access remain open. A Kanban same-user rename race defeated a proposed
parent-handle check; the incomplete experimental helper was reverted. The
existing task-ID validator alone does not close file I/O races. No PR push,
merge, customer install, or Stable publication follows from these scoped
results. Full strict Semgrep still has parser errors; full current-source
CodeQL and real clean install, legacy migration, About Update/recovery, and
two-device sync remain required. Commercial GitNexus upstream rights are
unestablished. Owner rejected removing any Skill or Plugin from the customer
archive, so the proposed GitNexus quarantine was fully reverted. Retain the
capability and qualify its commercial rights, pinned dependency and security
boundary before claiming customer readiness. The old broad Windows Python
run reported nine failures without retained node IDs; a separate bounded
reproduction found eight `requests` import failures only in a global Python
missing that declared dependency, while the same changed file passed 16/16
in the qualified QA venv. These eight cannot be equated to the original nine;
the latter remain unclassified without their log.

GitNexus decision update: the optional Skill remains packaged and discoverable,
including in the release ZIP regression test. Its current customer bridge is
locked fail-closed without opening an API port; the Skill links to upstream
commercial-license contact. A Youtab account email, including the Owner's
personal email, is not proof of a noncommercial use entitlement. The upstream
PolyForm Noncommercial terms permit personal study without anticipated
commercial application; use for Youtab product work needs rights from the
licensor. Even with rights, activation requires a pinned dependency and an
authenticated, race-safe bridge. The isolated PR #96 change and ZIP test are
not yet pushed or fully security-qualified; no Skills or Plugins are removed.
Fresh private-home provisioning assertions passed on a synthetic source-pinned
QA home with locked Python and PortableGit hashes. The two ignored native
fresh-provisioning tests remain UNRUN because free host RAM stayed below the
reviewed 12 GiB preflight after stopping idle Docker/WSL; Docker was restored.
Evidence: `F:\Youtab_AI_COS_Platform\tmp\phase1-fresh-provisioning-qa-20261013.md`.

- Owner acceptance now also requires ordinary supported Windows x64 users to
  install and later update the same published Setup without per-device Youtab
  Owner or company IT intervention. Setup is per-user (`asInvoker`) and the
  first-run home is selected under the user's profile; publication is a single
  central release action, not an action for each tester. In current working
  source, customer mode no longer falls back to `winget` when portable Node
  acquisition fails and skips optional system-package managers for ripgrep
  and ffmpeg; the Desktop stage fails closed if required Node is unavailable.
  The stage-protocol smoke and isolated behavioral no-manager tests passed.
  This remains a source-level result, not clean-install proof.
- The 2026-10-13 native Windows suite on the protected private QA fixture
  passed 189 tests, failed 0 and ignored 2 environment-specific cases after
  the installer diagnostics change. Focused customer Node/browser-stage
  behavior passed 39 cases. The post-review Sync-Off marker fix passed 27
  Electron service tests with one skip; it still needs real two-device Pilot
  acceptance. Gateway/Worker opaque-error remediation passed 523 focused
  Gateway/Worker tests and Ruff, but does not establish whole-product privacy
  qualification. An independent full-diff review approved the earlier source
  snapshot; newer cache and lock changes require a fresh exact-source review.
  Customer browser-stage and Setup raw-output fixes
  passed focused tests. The OWASP smoke passed 39 cases, and current-source
  secret and dependency gates passed. The source SAST blocking profile,
  router-policy, nine container-isolation controls and OCR branding gate
  (65 images read) also passed. Strict full-source Semgrep and final
  security qualification remain open. No final Installer has been built from
  these working-tree changes or installed on a clean tester device.
- The current Bootstrap downloads Runtime and dependencies online. A company
  proxy, TLS policy, application control or blocked dependency host may still
  require its IT administrator; do not promise bypass of those policies.
  Gateway already has a public email/OTP registration path, but PR #919 does
  not add it and Desktop native login does not accept that credential flow.
  Desktop first-run Youtab login uses native Google OAuth; on the current
  Gateway code, a new verified Google identity creates a personal tenant and
  private workspace without Owner provisioning. Its separate Settings > Gateway
  > Youtab Cloud connection uses portal/Privy hosted-agent login. Portal signup,
  email delivery and hosted-agent provisioning have no end-to-end evidence
  here. Actual first login/inference and About Update on an
  independent non-admin tester account remain required Pilot acceptance.
  The air-gapped enterprise bundle remains the later Phase 2 scope.
- Consent-Off was integrated into this local Installer source: it aborts active
  sync, persists a profile-local disabled marker before fallible journal work,
  keeps chats/timestamps on disk, and never returns prior-account chats after
  sign-out. A deterministic Enable/Off race and injected journal-save failure
  were fixed after independent review. The focused Electron suite passed
  40 tests with one Windows POSIX skip; UI tests passed 3, scoped TypeScript
  and lint passed, and independent source re-review approved. Real two-device
  sync and final-source security gates are still open; no push or merge occurred.

- The replacement D SSD is usable for isolated build output (about 164 GiB
  free at readback); F remains near capacity, so new heavy artifacts belong on
  D. Existing evidence and user files are preserved.
- The full 1,010-file canonical Python attempt R9 **failed** at batch 09:
  164 assertions passed in that batch, but an owned `bash.exe` remained live
  after the native Job closure wait. A bounded, fail-closed Windows shell
  termination correction received independent review; 63 focused tests and a
  26-file/166-test rerun passed. Neither result replaces the failed R9 Job-zero
  receipt or the unfinished whole-suite run.
- Current-source Secret Gate passed 8,910 files with zero findings and zero
  policy errors. Installer frontend build and lint passed. Native Rust
  `cargo check --locked --offline` passed; library tests with the qualified
  private QA fixture passed 165, failed 0, ignored 2. A direct run without the
  required fixture failed 31 and remains recorded as an invalid-harness run.
- The Installer production-lock `npm audit` initially reported 6 advisories.
  A lockfile-only compatible update of `colord`, `nanoid` and `source-map-js`
  reduced the actual Installer audit to **3** (2 moderate, 1 low); these new
  lock entries still need an isolated install/build. The remaining KaTeX and
  Tailwind Typography dependencies are required through the Installer's full
  Desktop stylesheet import. Removing them from the Installer manifest produced
  a misleading zero-audit result and was reverted. Desktop's separate
  production audit has **13** findings, including `simple-git` critical and
  `undici` high. A lock-only automatic Desktop fix failed on the existing
  `@assistant-ui/react` peer mismatch and left the lock unchanged. Resolve
  these paths without a forced downgrade or an audit exclusion.
- A subsequent clean dependency trial copied the current source to
  `D:\Youtab-test-work\phase1-clean-node-20261013-a` without `.git` or prior
  `node_modules`. Source and copied lock hashes matched, and `npm ci
  --ignore-scripts` installed 1,605 packages. Desktop now resolves
  `simple-git` 4.0.2 / argv-parser 2.0.1, a compatible assistant-ui 0.15.28 /
  react-streamdown 0.3.20 pair, and `undici` 6.29.0. The exact Desktop
  production audit fell from 13 to **10** (8 low, 2 moderate, no high or
  critical); the Installer's three advisories remain unresolved. A trial
  selector-parser override in the disposable copy still resolved Typography
  to 6.0.10, so that override was not applied to source. Upstream Typography
  pins parser 6.0.10 and the current math packages require KaTeX 0.16.x;
  forcing incompatible majors is not a verified fix.
- Code signing is unresolved. Microsoft Artifact Signing Basic advertises
  USD 9.99/month for 5,000 signatures, but it requires a paid Azure
  subscription and usage above that allowance is billed separately; an
  Azure budget is an alert, not a hard spending cap. The Owner previously
  rejected uncontrolled Azure cost. No subscription, signing resource,
  certificate or key was purchased or created. The offline Pilot candidate
  therefore remains unsigned and must be labelled as such; Stable trust
  qualification needs a separately approved, predictable-cost signing path.
- In that clean copy, Desktop typecheck, Desktop and Installer frontend builds,
  3,193 UI tests and 1,256 Electron tests passed (seven Electron skips). One
  Electron test expectation was aligned with the existing HTTPS-only denial;
  the other initially failed because the test copy excluded a tracked Kanban
  `dist/index.js` fixture, which was restored before the complete rerun.
  Desktop lint passed with zero errors and 741 warnings after 19 import-order
  errors were corrected. These warnings and remaining advisories are still
  visible debt; no release qualification is claimed. The D copy lacks `.git`,
  so its Desktop build stamp is a test-only placeholder, never candidate bytes.
- On current source, the secret gate passed 8,918 files with zero findings or
  policy errors; dependency integrity passed (2,032 Python artifacts, 3,583
  npm registry entries and nine pinned Actions). Branding passed with actual
  OCR of all 65 tracked images and zero retired-brand images. Ruff blocking
  SAST, container isolation (nine controls), router-policy agreement and
  Python compileall passed. The managed OWASP/API/LLM smoke passed 37 tests
  using the qualified Python 3.11 SDK with Windows loopback access. The
  sandboxed attempt stalled in Windows asyncio socketpair before its first
  assertion; it is not counted as a test pass. This focused smoke does not
  replace the full OWASP/Agentic review or full-suite/installed-artifact tests.
- Full strict Semgrep/parser qualification and full current-source CodeQL are
  still open. The cached Debian diagnostic verified attestation metadata only;
  it did not establish image authority or complete a scanner run. Real Pilot
  installation, About Update, rollback and two-device sync are still open.
- On 2026-10-13, the native Windows Installer library suite passed 180 tests,
  failed zero and left two provisioning tests explicitly ignored for their
  separately controlled run. It used a synthetic home under the protected
  `C:\Users\eiman\youtab-native-coordination-qa-20261008` parent and a D:
  Cargo target; it did not read the actual customer home. The first run exposed
  a missing fixture parent and a `timeout.exe` process-holder test that exited
  under redirected input. Both test fixtures were corrected; product ACL and
  update-lock rules were unchanged. Native pass is not a real clean install.
- The focused customer Setup PowerShell regressions passed 26/26 after the
  Node PATH test was changed to inspect the function body instead of a fixed
  900-character window. The underlying `Install-NodeDeps` order was already
  correct; this test edit did not change product install behavior.
- Before the two Rust test-fixture edits above, secret and dependency gates
  passed (8,925 scanned files,
  zero secret/policy findings; 2,032 Python artifacts, 3,583 npm entries and
  nine pinned Actions). Blocking Ruff SAST passed. The 37-case OWASP smoke
  passed with zero recorded network calls/external effects. Strict Semgrep
  remains unqualified: six current valid locale YAML files are byte-identical
  to the previously failing parser corpus; official 1.180.0 also failed that
  corpus. No
  rules, exclusions or baselines were changed to report a false green.
- Local CodeQL 2.26.4 security-and-quality scans of a SHA-verified 9,103-file
  source snapshot completed: JavaScript had 85 unsuppressed results / 21 outside
  the unchanged baseline; Python had 7,870 / 1,146 outside. A second 9,104-file
  snapshot after the diagnostic-redaction and relocation-journal fixes produced
  83 JavaScript results / 19 outside, with exactly two old fingerprints removed
  and zero added. Focused tests passed 16/16, Electron typecheck passed, and
  focused lint passed with zero errors/warnings. These local outputs lack the
  GitHub workflow metadata and do not qualify the final source or release.
- A selector-parser 7.1.6 lock transplant reduced a scratch audit by two
  moderate findings, but `npm ls` proved the resulting Typography dependency
  invalid. It was not applied to source. The real production audit findings
  and shared Installer qualification remain open.
- A separate 9,104-file hash-verified D QA copy installed the exact unchanged
  source npm lock (`npm ci` succeeded, 1,605 packages, valid actual dependency
  tree). Its Installer frontend and Desktop builds passed. That copy has no
  Git commit identity, produces a placeholder Desktop build stamp and is not a
  source-pinned or distributable Setup. Native packaging, installed-device
  acceptance and final-source gates remain open.
- The current-source canonical Python runner rechecked the six files that
  contained eight red secret/redaction assertions on the older PR #96 head:
  **255/255 tests passed, zero retries**. The isolated, hash-verified R2 QA
  copy also passed **70/70** focused Desktop update-marker, native Windows
  coordination, updater-process and relocation tests. These focused passes do
  not turn the older PR head green or prove a real installed About Update.
- A read-only Installer audit found accumulating verified Setup copies in
  `update-cache` after repeated About attempts. A sequential cache-pruning
  trial passed **23/23** tests and typecheck, but independent review found a
  real cross-instance race: pruning before handoff could delete another
  Desktop's verified, not-yet-launched Setup. The trial was removed from
  working source. Implement cleanup only after ownership/transaction completion
  is proven, and cover concurrent handoffs; do not silently delete by a
  mutable pathname. This remains an open Installer issue.
- A second cache-reuse trial passed 24 focused tests and Electron typecheck,
  but independent review rejected it: the retained cached pathname could be
  changed after verification and before updater launch, and scanning all
  retained stages had no latency bound. That trial was also removed from
  working source. A safe fix must bind validation to handoff and bound cache
  work without deleting another Desktop's pending Setup.
- The common Setup input read in `write-build-stamp.mjs` was changed to a
  bounded single-link file-descriptor read with before/after identity checks.
  The copied Setup is still checked against its four-field identity before
  the stamp is written. The focused Vitest suite passed **13/13**, including
  hard-link rejection; focused ESLint and syntax checks passed. An independent
  Codex review found no blocking or should-fix issue. This is a local source
  correction and still requires final-source CodeQL and packaged acceptance.
- The packaged About path now downloads the matching Setup while its backend
  is still running, verifies its hash and PE format before backend shutdown,
  and writes the verified bytes to `update-cache` only after the venv blocker
  preflight succeeds. Staging verifies the bytes again. Failure to stage
  requests backend restart. Focused Update tests passed **91/91**, Electron
  TypeScript and focused lint passed, and independent Codex re-review found
  no blocking or should-fix issue. Actual installed About Update remains
  untested; this reduces failed-preflight cache buildup but does not safely
  prune older failed or obsolete stages.
- Independent full-diff Codex review requests a cache-retention fix before
  release readiness. Desktop's reservation is process-local, while Rust's
  install lock begins only after Setup starts. The reviewed design is a
  versioned native Setup stage-and-launch handoff under a per-home OS lock:
  validate immutable bytes again, keep a lease for each staged image until
  its child exits, and reclaim only identity-checked, unowned entries under
  that lock. Include crash/unconfirmed-spawn, three-Desktop concurrency,
  malicious reparse/link changes, and old-cache migration tests. A simple
  age/count prune, cached-path reuse, or pathname-only unlink is rejected.
- The native v2 handoff and bounded reap are now in the working source. Legacy
  cache files are preserved and do not consume the v2 lease quota. An actual
  Windows exit-code-259 child exposed a liveness bug; the two affected paths
  now use a process-handle wait and a regression test. The protected native
  suite passed 189/189 with two environment-specific ignores, and Desktop
  handoff tests passed 5/5. Real reparse creation was denied in this QA
  environment, and a clean installed About Update is still required.
- Independent review found a separate installed-Setup verification-to-spawn
  gap: Desktop closes the verified packaged executable handle before launching
  it by pathname. A concurrent replacement in the per-user code tree could
  run different bytes. Node's current file API cannot hold the needed Windows
  no-write/no-delete lease through CreateProcess; a trusted native launch
  boundary and adversarial Windows test are required before release approval.
- A producer-built Windows x64 native lease is now in the working tree. Its
  focused Windows tests passed 23/23, including hard-link rejection and
  mutation denial while two leases are held. Exact addon stamp/staging checks
  also passed. Independent review, a clean current-lock Desktop bundle on D,
  packaged launch and actual installed About Update remain open; no customer
  readiness follows from the focused tests.
- Customer prerequisite inspection found that ordinary artifact installation
  still invoked an unpinned online uv installer, while its portable Node ZIP
  was selected from a mutable release index and executed before verification.
  The exact-version/hash corrections are under test. Do not distribute a new
  customer Setup until the verified prerequisite path and clean install pass.
- MCP security inspection found that interactive tool probing could connect
  after environment interpolation without revalidating the expanded command.
  The shared spawn boundary now fails closed in the working tree; focused and
  broader MCP tests passed, and scoped independent review approved the change.
  This is not a full Agentic or installed-product security qualification.
- An exact-current-lock production audit recorded Desktop 9 advisories
  (7 low, 2 moderate) and Installer 3 (1 low, 2 moderate), with zero high or
  critical. A compatible lock-only update reduced Desktop by one. The
  remaining advisories require reachability/remediation review; do not call
  dependency security green. Both audit receipts are in `tmp/phase1-*-audit-20261013.json`.

Goal: one supported Windows x64 release and one common Setup on PC/laptop,
with working About Update and preserved user data. No per-device build.

Architecture decision [ADR-0006](../architecture/ADR-0006-self-service-windows-image.md)
records the pending Phase 1 self-service packaging change: producer-built x64
Desktop and Node/browser payloads in the same immutable Runtime ZIP, with
customer Node/Desktop stages limited to verification and installation. Before
Pilot, prove no npm/native build on a clean non-admin device, complete locked
Python wheel coverage, fixed and verified online prerequisites, capability
parity and rollback. This remains an online, unsigned candidate until separate
trust and real-device gates pass; Enterprise offline delivery remains deferred.

### 1.1 Resolve existing qualification failures

- Triage and fix remaining native test/security failures, including CodeQL.
  Keep existing rules, baselines, integration bindings and genuine outcomes.
- Run required gates on final source, including OWASP Top 10 and Smoke;
  focused passing tests do not qualify the whole release.
- Keep independent exact-source Codex review and local pinned Semgrep before
  any separately authorized push. Rebind review after source/base changes.
- Resolve existing package authenticity/signing limitations according to current
  release requirements; do not call an unsigned candidate signed or trusted.

Exit: required tests/security genuinely pass on the intended release source,
independent review approves, and reports record exact source/tool/artifact scope.

### 1.2 Finalize the common release candidate

- Confirm Runtime/Setup source identity and channel/update protocol compatibility.
- Rebuild after final source changes; existing 003178 artifacts do not include
  uncommitted roadmap/qualification changes.
- Verify Setup replacement, transaction rollback, legacy migration and recovery.
- Verify capability parity: required agents, Skills, Plugins, tools and MCP
  discovery/configuration; inclusion alone is not functional acceptance.
- Retain originals, credentials and all old/new chats with their timestamps.

Exit: reproducible reviewed candidate and hash manifest, rollback plan and
resolved capability/configuration gaps. No customer-ready claim yet.

### 1.3 Pilot and real installed-device acceptance

- After required exact Owner authorizations, merge/roll out the necessary sync
  schema and delivery services, and publish the final candidate only to Pilot.
- Test clean installation under an ordinary non-admin Windows account on a
  supported clean device: the tester downloads and runs the one Setup,
  completes first-run Google login, and later updates from About without
  Youtab Owner provisioning or company IT intervention. Record any UAC,
  SmartScreen, proxy, TLS or application-control barrier as a failed
  self-service acceptance case; do not bypass organization policy.
- Migrate the laptop to the same common Setup through the supported preserved
  flow; verify both Runtime and stored Setup identity.
- Test a real subsequent About Update, interruption/locks, rollback and restart.
- Test actual login/model inference, agents/Skills/Plugins/tools, generated-file
  preview/review/download and consented real two-device history sync.
- Record PC/laptop installation source/hash/sequence/channel; account identity
  must not depend on machine identity or install location.

Exit: actual device evidence for all acceptance items, no silent chat loss,
and Owner acceptance of the exact candidate. Pilot is not Stable authorization.

### 1.4 Stable promotion — complete Phase 1

- Promote the accepted Pilot package and hashes unchanged, without rebuilding.
- PC and other supported users receive that release through About Update.
- Verify discovery pointers, cache behavior and real post-update identities.
- Report exact installer/download identity and remaining limitations.

Exit: required technical gates, review, real acceptance and separately authorized
Stable rollout completed. Only then mark the common Installer/Update complete.

## Phase 2 — Compiled delivery and prebuilt dependencies

Start only after Phase 1 acceptance. Initial estimate: 5–10 working days.

- Classify private first-party implementation and approved user-facing files.
- Compile/package core and Desktop; exclude readable private source, debug
  material and source maps; preserve third-party notices and user extensions.
- Bundle locked prebuilt dependencies and validate dynamic imports.
- Test full agents/Skills/Plugins/tool parity and inspect shipped, installed and
  temporarily extracted contents. Preserve the common Setup/update transaction.

Exit: exposure checks and functional/security/OWASP/Smoke acceptance on actual
compiled artifacts. Do not promise impossible protection from a host admin.

## Phase 3 — Separate Offline Setup and verified local Update

Depends on Phase 2. Initial estimate: 5–10 working days.

- Build a separate Offline Setup executable and authenticated self-contained
  bundles; share only explicitly reviewed product/runtime contracts with the
  online Installer. Use approved local or internal update sources.
- No installation-time internet downloads, dependency builds or external fallback.
- Keep an exact source and payload manifest for each channel; offline transport
  can be local files, approved media or an internal mirror/share. USB is optional.
- Test fresh installation, local inference, About Update, restart and rollback
  with external connectivity denied before Setup starts.

Exit: real clean-host offline acceptance, trusted package verification and no
feature/data loss. All mandatory security/OWASP/Smoke gates still apply.

## Phase 4 — Organizational Brain, identity and internal sync

Depends on Phase 3. Initial estimate: 10–20 working days.

- Provision the one governed Brain inside the organization. Keep signed task,
  tenant/effect/replay/budget/memory boundaries intact.
- Qualify the organization's own local model and internal endpoints.
- Implement/qualify internal identity and optional account sync without mandatory
  public login, telemetry, entitlement renewal or public data upload.
- Test two devices, permissions/revocation, history preservation, offline trust
  and authorized key recovery/rotation in an isolated organizational environment.

Exit: actual Air-gap Enterprise qualification, deployment/recovery documentation
and independently approved Pilot before unchanged Stable promotion.

## Estimates and current state

The estimates for Phases 2–4 sum to 20–40 working days (approximately 4–8 weeks)
AFTER Phase 1 is accepted. They are preliminary, not a deadline or percentage.
Security remediation, signing/provisioning, model compatibility and actual
organizational integration can extend them. No reliable Phase 1 completion
estimate exists until remaining failures are classified and acceptance scheduled.

Current checkpoint: common source implementation and local candidate exist;
targeted contracts passed, but full-security/native qualification, final build
binding and actual Pilot/device acceptance remain incomplete. Current candidate
is not a qualified Air-gap package. No release/publication/device update is
authorized by creating this roadmap.

2026-10-13 recovery checkpoint: local Phase 1 branch commit
`4086053ee29a933241155863092bd5f37935e94a` adds native v2 repair handoff,
safe admission for interrupted fresh/update transactions, and preservation of
uncommitted Runtime trees. Independent Codex review approved a *local candidate
build only*. The repository's official isolated Windows native harness on this
source passed 195 tests, failed zero, and left two fresh-provisioning cases
explicitly ignored; fixture `C:\Users\eiman\.codex\YtNativeQA\4cc50f8d-c221-4bbf-ad60-25be5388f568`.
Focused Desktop handoff tests passed 23/23, Setup UI tests 2/2, Electron
typecheck passed, and changed-file lint had zero errors with existing warnings.
No real clean install, About Update, rollback or two-device sync acceptance has
run on this commit. Preserved recovery directories require owner-visible
discovery and content review before any cleanup.

Security remains open: official Semgrep 1.180.0 rejected all 11 original
parser-corpus inputs, so no full strict scan has qualified this source. The
existing full CodeQL evidence has findings outside unchanged baselines and
does not cover this commit. The native addon hash-then-load race remains a
same-user tamper qualification limit in the unsigned per-user build. Do not
turn focused tests or a diff-informed PR check into full release-security PASS.

OWASP/Smoke/full-security remain current Stable qualification requirements.
Future Air-gap/source-protection capabilities are deferred deliverables, not
prerequisites that block completion of the Phase 1 scope. Historical gate
results are retained and never relabeled by this sequencing change.

2026-10-14 customer-install checkpoint: the reviewed local branch contains Setup
component fixes at `e34a65c65bc0d7b5c8c09e7f73521f61d70da68b` and a fail-closed npm
advisory inventory gate at `e1ce78c92cf4c240f4677607cdaa7170188cab1f`.
The e34 Setup EXE is a local, unsigned component smoke candidate only. Its
matching Runtime ZIP/image was not built or published; it cannot be given to a
new customer machine as a working one-click installer. Focused integrated
checks passed (174 tests, 5 platform skips; UI check; changed-Python Semgrep
6 paths, 0 findings/errors). These do not prove a fresh install or update.

Exact-lock npm advisory scans on 2026-10-14 found root full 37 and production
9; WhatsApp bridge production 6 (1 high, 1 critical); Photon sidecar
production 19 (2 high); website production 61 (28 high, 20 critical).
The gate remains red. Classify packaged reachability and remediate supported
versions without removing agents, Skills or Plugins. Do not silently exclude
standalone lockfiles or lower the audit threshold. Full product security,
source-exposure qualification, signing, fresh non-admin Windows installation,
About Update, rollback and two-device sync are not yet accepted. The online
Installer remains a customer handoff NO-GO until the exact matching package,
security gates and real clean-host installation pass. Customer distribution
also requires verifying that private first-party source is absent from the
artifact, as requested by the Owner; a Phase 1 internal UI smoke is not that
qualification.

2026-10-14 remediation update: compatible exact-lock updates were committed
locally. WhatsApp bridge production audit is now zero after patched Express,
sharp and music-metadata dependencies; media-codec tests 3/3 and authorization
tests 7/7 passed. Photon sidecar high findings are zero; 17 moderate remain
under the current Spectrum/OpenTelemetry chain. Root full audit is 28
(7 high, 0 critical); root production is 9 (0 high/critical). A website
lockfile experiment was reverted after independent review found mixed
Docusaurus versions and a Node contract regression; website remains at the
original 61 advisories, including 20 critical. No audit was waived.

Clean root npm ci installed 1583 packages with scripts disabled. Setup check
and UI build passed, Desktop typecheck passed, and Desktop Vite/Electron
bundles built. The full Desktop build stopped at the expected exact-source
Setup-lease mismatch: no matching Setup/component lease has been rebuilt for
this new head. Available RAM was 11.34 GiB versus the reviewed 12 GiB
preflight for the full producer. Matching Runtime image, full release gates,
clean customer install and About Update are still not proven.

2026-10-14 update-notes checkpoint: local reviewed source at
`58dcd3027df23efdc9962036d3aec2d384925306` requires tracked customer
release notes when packaging a common Setup, copies them into the immutable
manifest and channel pointer, rejects malformed or mismatched notes, and shows
them before the Desktop update is applied from About. About explicitly targets
the local Desktop even when a remote backend is selected. Focused Python
release/package/channel tests passed 83/83; Electron discovery tests passed
17/17; Desktop TypeScript checks and changed-file ESLint errors passed. These
are code-level results, not an installed-device Update acceptance. The release
notes source is `docs/roadmap/windows-candidate-notes.json`; each future
candidate needs reviewed, source-tracked notes of its own.

The nine root production npm audit entries are seven low and two moderate,
originating from two packages. KaTeX 0.16.47 is present in packaged Desktop
renderer assets; its fixed 0.18.2+ line conflicts with the currently declared
math-rendering dependency ranges. `postcss-selector-parser` 6.0.10 is used by
Tailwind Typography during CSS build and its current parent pins that exact
version; it is not a customer runtime module. No dependency override, feature
removal, advisory suppression or audit baseline change was accepted. Website
and Photon independent advisories remain as reported above. Full security is
still NOT QUALIFIED. The new exact-source matching Setup/Runtime package has
not been produced; observed available RAM 11.13 GiB is below the reviewed
12 GiB build preflight. Fresh ordinary-user install, About Update, recovery,
privacy/source-exposure and two-device sync remain NOT PROVEN. Do not hand the
earlier Setup-only EXE to a customer as a working one-click installer.

2026-10-14 bundled-prerequisite checkpoint: the common online Setup now embeds
the pinned Microsoft WebView2 standalone installer after build-machine
SHA-256 and Authenticode verification. Customer installation no longer fetches
WebView2 separately. The Setup and About update metadata/admission limits were
raised coherently to 256 MiB; the Desktop downloader uses one exact-size buffer,
rejects short/oversized bodies and memory-allocation failure, and retains the
release hash and PE checks. Independent Codex review found no blocking code
issue. Focused Electron tests passed 43/43, Rust WebView/Setup tests 3/3,
Python checks 9 passed with one platform skip, and TypeScript checks passed.
A local Windows x64 release EXE built and passed the product's source/hash/
handoff admission check plus a headless native capability probe. Cargo's
hardlinked build output required a hash-identical single-link staging copy;
the release runbook now records that step. This remains a component build,
not a customer handoff: no matching source-pinned Runtime ZIP/customer image,
clean non-admin Windows installation, About update, or low-memory host test
has passed. The EXE is unsigned. The nine root production npm findings remain
open, and full SAST/OWASP/source-exposure qualification is not green. Do not
publish or distribute this component as a complete customer installer.

2026-10-14 exact-source customer-package checkpoint: a clean local candidate at
`107e7e2a9df2749d1a06f126d8060dc64e8e7f19` now has a matching common
Setup, Desktop/customer image and source-pinned Runtime ZIP. Setup SHA-256 is
`2ae66e25021a32c51946a59e7718f1a9a69f4274d0f9f5e5beb2108d1357cb6a`;
ZIP SHA-256 is `d2a0b54c2cd9b7c9c97ae9569d4e60bcfab9a4c42ed1203c54fcb3bb66c6c490`.
The local producer, ZIP integrity, 103 focused release tests, 44 About delivery
tests and 31 update UI tests passed. The scoped managed OWASP smoke passed 39,
secret gate scanned 14,730 files with zero unapproved findings, and blocking
Ruff SAST found zero issues. These are not a clean installation or complete
product security pass. The package has not been published even to Pilot;
About Update, data migration, rollback and two-device sync remain unproven.

The current ZIP still contains 1,083 readable Python files. The Owner's
customer requirement that private core source not be distributed makes source
protection a prerequisite for customer handoff, even though broader Enterprise
hardening remains a later phase. Filtering `.py` files alone breaks the local
`uv sync` install and Desktop/plugin source-file probes. An isolated CPython
3.11 native-wheel proof compiled six managed-runtime modules without `.py`
members and imported successfully after an experimental Pydantic adaptation,
but 12 of 39 copied OWASP cases failed due to uncompiled `agent.redact` and
`python -m` extension entrypoint incompatibility. No native-wheel changes
were integrated. A separate audit override experiment reached zero production
npm findings and 3,196 Desktop UI tests passed, but independent review rejected
it: `npm ls` reports incompatible parent ranges and the regenerated lockfile
changes hundreds of unrelated versions. The original nine root production
findings remain open. The Setup is unsigned. Customer handoff is still NO-GO;
full evidence is in the local qualification report under
`D:\Youtab-test-work\phase1-customer-setup-stage-20261014`.

2026-10-14 clean-customer checkpoint: local source `f59b37bed24593962feb130d6622dd7ffe3de31e`
adds a reviewed fail-closed customer Setup path when its diagnostic log cannot
be opened. Native `cargo check --locked --lib` passed; the release EXE failure
path still needs an isolated Windows smoke. The installer sets explicit working
directories for its PowerShell stages, CLI health probe and Desktop launcher.
Its CLI registration test passed with a synthetic home and mocked registry, but
the CLI has not run after an actual clean customer installation. The current
online package includes prebuilt Desktop, Node, browser, TUI and WebView2; it
downloads uv, managed Python, locked Python dependencies and FFmpeg during
installation. A customer network or proxy may block those endpoints. The
current Setup is pinned to an unpublished Pilot release and cannot complete a
fresh install from the local ZIP alone. Ordinary-user installation, About
Update, recovery and two-device sync remain NOT PROVEN.

A separately reviewed, compatible dependency cleanup reduced the live root
production npm audit from nine findings to four low KaTeX-chain findings.
Customer Setup uses the prebuilt Node/Desktop branches and does not execute the
development `npm ci` branches. The four findings are still present in the
renderer dependency graph; the available upstream math packages do not yet
offer a compatible all-green upgrade. No override or waiver was applied.
A full-source-free customer Runtime remains blocked: a six-module native-wheel
proof fails the `python -m` worker entry point, and Desktop, Installer and
Plugin discovery still use first-party `.py` paths. Exact new customer bytes
have not been built from this head. The previous candidate's 1,083 readable
Python files and unsigned Setup remain customer handoff blockers. See the
private-core audit at `D:\Youtab-test-work\phase1-private-core-packaging-20261014\docs\ops\windows-private-core-packaging-audit-20261014.md`.

2026-10-14 clean-host qualification continuation: the customer Setup location,
channel and one-click Install controls passed a focused browser behavior test;
Setup typecheck and lint passed. A real native chooser/menu on a clean PC is
still unproven. The native private-home test failure under D: and Temp was
traced to broad ACLs on ancestor directories, not relaxed as a product policy;
4/4 tests passed under a disposable private profile root. The matching
customer prerequisite bundle (uv, managed Python, complete locked Windows
wheelhouse, FFmpeg) has not been produced, so the current online installer
still depends on external downloads. The live production npm audit remains
4 low KaTeX-chain findings and exits nonzero. Full requirements, evidence,
and clean-host blockers are recorded in
`docs/ops/windows-customer-install-readiness-20261014.md`. Customer handoff
remains NO-GO until exact bytes, private-core packaging, real install/CLI,
About Update and security checks are qualified.

2026-10-14 dependency/CLI continuation: the integrated branch now binds the
versioned packaged CLI identity from release producer through Setup's completed
marker to Desktop launch. Twenty focused Electron tests, the Electron typecheck
and the native artifact-marker test passed; these do not replace a customer CLI
run. The customer installer now runs `uv pip check` against its exact venv after
every locked sync and fails closed on inconsistent dependencies. Forty-one
Windows PowerShell behavior tests passed with a synthetic uv runner; an
independent Codex review approved this limited change. The missing exact
`sherpa-onnx-core==1.13.4` wake dependency is now in the lock, independently
reviewed; the integrated `uv lock --check` and 38 focused wake/metadata tests
passed. A separate 122-wheel Windows x64 hash-locked, fresh-cache install and
`pip check` passed. The universal offline `uv sync` path still fails from an
empty cache, and no prerequisite bytes have been incorporated into the common
Setup. The first-party wheel is blocked by `setup.py` policy; source-free CLI,
real clean-PC install, update/recovery and two-device sync remain NOT PROVEN.
The verified FFmpeg archive is GPLv3; redistribution obligations and all
transitive wheel notices require review. Root production npm audit still has
four low KaTeX-chain findings and exits nonzero. No matching new package has
been built or published; customer handoff remains NO-GO.


## 2026-10-15 — Customer model connection repair

Artifact: existing single-file Inno Youtab-Setup.exe, 803983863 bytes.
SHA-256: 00F7567B5F832F39F3C11BDB4C5D92253FD49FD78E99E22FA94FA9248195820B.
Path: C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe.
Same staged image and checkout reused; three private native modules rebuilt.

Implemented:
- Local/custom discovery no longer treats HTTP 401/403/404 or an empty model list
  as a successful connection. A bare server address retries /v1/models only
  after a missing root /models route; the successful base URL is persisted
  by both onboarding and Settings.
- Local discovery stays on the selected origin, does not follow redirects, and
  bypasses environment proxies for loopback. API keys remain endpoint scoped.
- Native Youtab model discovery requests tool calling and semantic streaming
  requirements, excludes explicit incompatible capability declarations, and
  invalidates the older model catalog cache.
- Gateway catalog adds truthful capability metadata and optional requirements
  using the same Engine flags as execution admission. Existing unrestricted
  model listing remains available. Local Gateway commit:
  9fce0f828386417d9a928a87bba64ef56f80a61e.

Evidence:
- Existing canonical Python runner: 4 selected catalog/auth tests PASS.
- Existing Desktop onboarding test file: 3 selected tests PASS; 24 unrelated
  tests deselected, not counted as passed.
- Packaged native module against a synthetic loopback server: root-to-v1
  discovery, authentication rejection, empty models and redirect refusal PASS.
  This was a transport regression check, not real local-model inference.
- Native three-module build, Desktop package and Inno compilation PASS.
- Independent bounded Codex review initially requested one Settings correction;
  corrected source was then APPROVED with no remaining scoped findings.
- Gateway focused static checks and diff whitespace PASS. Its route tests were
  updated but were not executed: the available Runtime test environment lacks
  Gateway dependencies. No additional environment was installed.

Still pending:
- Owner-authorized Gateway deployment and required CI. Current live cloud
  behavior is not repaired by rebuilding an EXE. Already saved unsupported
  model assignments are not silently switched to another model/provider.
- Real local-model inference, clean Windows install/startup, installed About
  Update/rollback and two-device sync remain NOT PROVEN by this repair.
- Authenticode is NotSigned. Stable remains unpublished.

### Current bounded Gateway PR and packaged native initialization

- Gateway repair is isolated on PR #1204, branch
  codex/installer-model-capabilities-20261015. Current reviewed head:
  7d9995143f28eca74e0715ff2f6bc5495d3e52f3; merge base:
  a1247c9933153c3be7218e4a93ef47f0b57ec78d.
- Independent full-PR Codex approval for this exact head is published at
  https://github.com/eimanghazaei/youtab-ai-os/pull/1204#issuecomment-6193081357.
- Original CI 38741865050: lint/type-check and model registration guards PASS;
  Backend tests still running at this checkpoint. Deterministic harness and
  SCALE evidence checks PASS. Required remaining CI is not counted as passed.
- The first attempt failed formatting in the newly added test; only that
  formatting was corrected, independently reviewed and pushed on the same
  branch. No baseline, rule, timeout or capability flag was relaxed.
- Bundled private Python imported the packaged native AIAgent and initialized
  it with provider=custom and a synthetic loopback model endpoint successfully.
  External network was denied by an audit hook; cloud login and inference
  were not performed. This is native initialization evidence, not real-model
  inference or clean Windows installation acceptance.
- Auto-merge Barrier remains blocked by Draft status and exact Owner merge
  authorization. No server deployment or installation was performed.
### Final inspected Gateway CI outcome (2026-10-15 13:48 UTC)

PR #1204 remains at reviewed head
7d9995143f28eca74e0715ff2f6bc5495d3e52f3, base
 a1247c9933153c3be7218e4a93ef47f0b57ec78d.
Original CI 38741865050 COMPLETED SUCCESS, including Backend tests,
lint/type-check, model guards, migration sandbox, memory claims evidence,
frontend build, pip-audit, security scans, database role separation/ACL,
and gateway container build validation. Youtab Merge Gate 38741865034,
deterministic harness 38741865144, SCALE 38741865389 and the exact-head
Codex Review also succeeded. No workflow was rerun in this follow-up.

Auto-merge Barrier 38742022742 remains FAILURE. Its inspected historical log
includes then-pending technical checks, plus Draft status and no valid
Owner governance approval for this exact head. Technical checks have now
completed successfully; Draft/Owner conditions remain unresolved. The
barrier was not rerun to conceal those conditions.

Required next action is exact-head Owner authorization for normal merge and
bounded server deployment of this reviewed repair. Neither has occurred.
This Gateway result does not qualify the unsigned Installer, real local-model
inference, clean Windows installation, About Update/recovery, two-device sync,
full Runtime security or air-gap privacy. Earlier limitations remain in force.
Scheduled monitoring is paused after this final inspected outcome; resume
only for an authorized next action or changed evidence.
### Repeated 422 root cause, observed customer run (2026-10-15)

The installed application actually runs from K:\test\Youtab. Its three repaired
native modules have SHA-256 identities identical to the current QA/package
inputs; this occurrence is not explained by launching the older native build.
The installed config selects provider=youtab, model=deepseek.v4_pro,
base_url=https://api.youtab.io/v1. errors.log records the actual 16:03 request
rejected with HTTP422 inference/tools-unsupported. Gateway admission rejects
nonempty tool proposals when the resolved Engine tool_calling flag is false,
before upstream inference. The repository DeepSeek engine also records
unverified capability evidence; no flag is enabled or waived by this analysis.

PR1204 is MERGED as a9c93c9dfada543f2685ec13198b8a53836ca1b6. Its change
exposes/filters existing capability declarations; it does not qualify or enable
DeepSeek tool calling. Live /openapi.json still declares no require_tools or
require_streaming parameters for /v1/models. The repository variable
YOUTAB_AUTO_DEPLOY_ARMED was read as false. Publish images38747102887 succeeded,
but image publication is not production activation. Main CI38747102720 was
still running. No manual deployment was initiated and auto-deploy arming was
not changed. Validated exact-head deployment authorization is still required.

The preserved saved model is not silently replaced. After server activation,
a user must choose an actually admitted tools/streaming-capable model; retaining
a previously rejected model does not repair its capability. This exact 422 is
not fixed by rebuilding or reinstalling identical Setup bytes. The catalog fix
must not be described as qualifying the rejected DeepSeek engine or proving
local inference/clean Windows/update acceptance. No new package, source copy,
VM operation, full scan, account mutation or user-data deletion was performed
for this diagnosis.
Additional routing evidence: the preserved v0.19.1 G: config has provider=deepseek,
default=deepseek-v4-pro and no custom base_url, whereas the observed K: install
uses provider=youtab and engine ID deepseek.v4_pro at api.youtab.io/v1. These
are distinct inference routes. The older direct-provider behavior does not
establish admission/capability qualification of the native Youtab Engine route.
No API key was read, copied or printed during this comparison.

## 2026-10-15 — Clean-PC CRT and Browser Vision image fixes

Rebuilt the SAME existing Inno project and output path after Owner reported
python.exe VCRUNTIME140.dll missing on clean Windows and repeated Vision400.

Root causes and bounded corrections:
- dumpbin confirms the private venv/Scripts/python.exe imports VCRUNTIME140.dll.
  python311.dll was present there; CRT DLLs were only in the base Python folder.
  The existing producer now packages the matching base-Python vcruntime140.dll
  and vcruntime140_1.dll beside the private venv interpreter; missing/conflicting
  dependencies fail packaging. Both source DLLs have valid Microsoft signatures.
  No System32 file or global Redistributable installation was modified.
- Browser Vision bypassed the existing image embed limits for full-page PNGs.
  The observed screenshot was valid RGB PNG1249x12977, beyond the documented
  DeepSeek8192px-per-side limit (https://api-docs.deepseek.com/guides/vision/).
  Both native and auxiliary paths now use the existing7900px/4MiB resizer.
  Returned payload size, decoded dimensions and image integrity are verified
  before native embedding/auxiliary inference. Unverified/oversized fallback
  returns the existing structured tool error and preserves the screenshot.

Evidence:
- Canonical scripts/run_tests.sh, existing test_vision_native_fast_path.py:
 3 selected tests PASS,0FAIL: tall PNG through native AND auxiliary routes,
 unbounded resize fallback refusal, and existing native envelope contract.
- Independent bounded Codex review initially requested output verification;
 final corrected diff was APPROVED,0blocking/should-fix/nit findings.
- One changed native module tools._native_browser_tool compiled successfully;
 complete private inventory remains940. No Desktop rebuild or source copy.
- Staged PRIVATE venv/Scripts/python.exe startup PASS; Windows module lookup
 confirmed VCRUNTIME140.dll loaded from the private executable's directory.
 Repaired native Browser module import PASS, all network denied for this check.
- Existing exact input producer PASS:18103files,940private modules (two new
 app-local CRT DLL destinations); existing Inno compiler exited0.

Artifact:
Path: C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes: 804063060
SHA-256: A6BE6B48E41909DA87ADC9EE6BC0497C9F8817F22C0ED3A2A8DDE755BD4B85BF
Modified: 2026-10-15T16:52:43.6431004+02:00
File-tree SHA-256: 25eb1d5210d8d62156d23c94120e46e06d4ff68b1fdf37a978ac16c6d37e4adb
Authenticode: NotSigned

Owner will repeat clean-Windows installation and real Vision acceptance.
These scoped checks do not prove clean-PC E2E, real provider inference,
About Update, full release security or signature trust. Previous Gateway
activation and Engine qualification work is separate and was not changed.
No user installation, saved account, chat history, VM or server was modified
while applying these two fixes. Restart the installed app to load new binaries;
already rejected oversized history images were not silently deleted.


## 2026-10-15 — Clean-VM Git dependency and native command-contract repair

Observed VM evidence: G:\Telegram Desktop\youtab-desktop-log.md, exported from
C:\Users\Tester\Youtab\logs\desktop.log, stops in ensureRuntime with the explicit
Git for Windows / Git Bash required error. The previous Inno image did not
include PortableGit. The customer's screenshot is a startup failure after
installation, not proof of a successful clean-PC acceptance run.

Bounded fixes in the SAME existing Inno producer and QA image:
- Include the full official PortableGit 2.54.0 Windows x64 distribution at
  HOME/git, with its upstream licenses. The existing prerequisite lock pins
  https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/PortableGit-2.54.0-64-bit.7z.exe
  to 58995352 bytes and SHA-256
  bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311.
  Downloaded size/hash matched; Authenticode was Valid (Johannes Schindelin).
  Extraction finally succeeded with the existing install.ps1 -o target / -y
  arguments; earlier extraction attempts without the required output were NOT
  counted as success. Required Bash, Git and MSYS true files are now present.
- Persist YOUTAB_AGENT_GIT_BASH_PATH to the app's private Git, set the Setup
  process environment, and run the bundled Bash/Git/MSYS check before accepting
  installation. No system Git installation or administrator privilege required.
- Correct managed Node's package destination to HOME/node, matching Desktop
  and CLI discovery. Reuse the existing Node payload; no new Node download.
- Extend Setup's native import preflight to youtab_runtime and its worker.
- Fix the confirmed Cython/Pydantic namespace incompatibility in contracts:
  Pydantic mistook compiled canonical_payload/verify methods for fields.
  ignored_types now includes the actual Python/native method descriptor type.
  extra=forbid, signatures, expiry and authority checks remain enforced.
  All six runtime modules stay native; no private .py fallback is distributed.

Verification performed once for this bounded repair:
- Bundled Git Bash ran with host Git removed from PATH: git 2.54.0.windows.1,
  /usr/bin/true and readiness marker PASS, actual process exit 0.
- Existing bundled Node executes --version: v22.23.3, exit 0.
- Canonical scripts/run_tests.sh: existing contract/policy files, 12 PASS/0FAIL.
- Actual QA private Python imported all six native youtab_runtime modules.
  Native contracts came from .pyd. Method names are not fields and an injected
  canonical_payload input was rejected by extra-field validation.
- Actual QA youtab-agent-worker.exe: valid signed command accepted (exit 0),
  tampered command rejected (exit 2), expired command rejected (exit 2).
  Valid acceptance retained runtime_authority=false and public_listener=false.
- Independent Codex review of the three changed files: APPROVE,
  0 blocking/should-fix/nit. Review did not claim clean-VM E2E.
- Existing producer: 27608 files, 940 private native modules; exit 0.
  Same existing Inno compiler/project/output: exit 0. Prior CRT and bounded
  Browser Vision payload corrections remain included.

Artifact (replaces the previous bytes at the SAME output path):
Path: C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes: 940275513
SHA-256: 81AD0543BBD462D5BD324FB3188917985F87A37C2258657A875A945EA5A982A6
Modified: 2026-10-15T17:39:47.9117971+02:00
File-tree SHA-256: deb24e58eabaf0dc8a7515b769141de2c04ed116b4372832e612380be0da595e
Authenticode: NotSigned

No real user installation, K: recovery, VM, model service, server, saved account
or chat was changed. No new checkout/test environment/source copy or full scan
was created. Automatic review rejected broad application closure; that change
was not applied and CloseApplications=no remains. Close Youtab before retrying
Setup; do not skip locked-file errors or delete customer data.

Acceptance still pending: user repeats installation and startup on the existing
clean Windows VM, followed by real account/local-model/Vision use. This is a
built and scoped-verified repair, not a blanket clean-PC, inference, OWASP,
release-security, air-gap, About Update/rollback or two-device-sync PASS.
Gateway activation/tool-admission work is unchanged. No Stable/release,
installation update, source push or deployment was performed.

## 2026-10-15 — Host-independence dependency inspection and missing ONNX CRT repair

Owner requested explicit evidence that the single EXE does not depend on this
PC's developer installations. One bounded inspection used the exact Inno inputs
and the existing QA image; no new checkout or test environment was created.

Observed evidence:
- PE import and delay-import inventory: 2186 original packaged binaries,
  313 distinct import names, zero parse errors. API-set/Windows imports are
  operating-system dependencies, not an assertion that every Windows optional
  feature or edition is qualified. Global filename presence alone does not
  prove Windows DLL search resolution.
- Found a REAL missing dependency: ONNX Runtime capi DLLs require
  msvcp140_1.dll, absent from the old EXE. msvcp140.dll existed only in
  sklearn/.libs, which did not establish ONNX/shared-loader availability.
- Network-disabled private Python -I check, host Python/Git/Node removed from
  PATH: CLI, gateway, browser, TTS, command worker and selected native standard
  modules imported from the QA image. sys.prefix/base_prefix stayed inside QA;
  no foreign sys.path entry; user site disabled. All 133 installed distributions'
  active base requirements were present and version-compatible. Actual bundled
  CLI --help exited 0. These are bounded startup/dependency checks, not inference
  or full UI acceptance.
- .pth inventory uses relative package paths/initializers; Setup rebases the
  shipped pyvenv.cfg home to the target {app}/python path. CLI launcher uses its
  own sibling private Python, sets runtime cwd/PYTHONPATH, disables user site,
  and removes inherited PYTHONHOME.

Correction:
- Downloaded official https://aka.ms/vc14/vc_redist.x64.exe, version14.51.36247.0,
  18731856bytes, SHA-256
  843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C.
  Authenticode Valid, signer Microsoft Corporation. No shared runtime installed.
- /layout only copied its self-contained EXE. Instead, read its attached CAB
  bounds, expanded with Windows expand.exe, and queried MSI File/Media tables
  read-only. Extracted only the12 x64 Minimum CRT DLLs; each signature Valid
  Microsoft, each PE machine AMD64. No ARM64 payload entered the product.
- Bundle that matching complete set beside venv/Scripts/python.exe, replacing
  the older two app-local VCRUNTIME DLLs there. Base Python retains its own
  original matching CRT in its separate directory. Archive/DLL hashes are
  pinned in prepare_inno_files.py and recorded in existing inno-inputs.json.
  Missing/conflicting CRT input fails packaging. This follows Microsoft's
  supported app-local deployment method:
  https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
- Inno's before-success import preflight now includes onnxruntime.
- Real network-disabled private process imported ONNX1.27.0, CTranslate2 4.7.1,
  AV18.1.0 and native CLI/gateway/worker. GetModuleHandleW/GetModuleFileNameW
  confirmed python311.dll, VCRUNTIME140/140_1 and MSVCP140/140_1 loaded from
  QA venv/Scripts, not host System32/developer directories. PASS, exit0.
- The12 new CRT files' imports reference other bundled CRT DLLs and Windows
  APIs. Independent Codex review APPROVED the two-file producer/Inno repair,
  0blocking/should-fix/nit. No additional full scans or test loops.
- Exact required file-list entries confirmed Python, Git Bash/Git, Node,
  Chromium, FFmpeg and ONNX's new CRT. The existing producer exited0 with
  27618files and940private modules. The same Inno compiler exited0.
Artifact: C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes: 941101336
SHA-256: D4CEAB67E23BE2C6CAC5241B859EC204DE991A8DEB94A86D19F91A9A209F5033
Modified: 2026-10-15T18:26:02.1336406+02:00
File-tree SHA-256: d9d44476c55c022e356c1a6e9c49f3d2728e24c32aea876711de95baeb0ddfe6
Authenticode: NotSigned

This replaces the preceding 81AD0543... output at the SAME file path.
No user installation, VM, shared Windows runtime, account, chat, server,
publication or deployment was changed. Existing signing/security/release
limitations remain. Bundled runtime checks do not prove a complete clean-VM UI
installation or every optional tool. Model weights/local model servers,
user-selected third-party MCP services, account connectivity and OS optional
features are separate prerequisites; this report does not pretend they are
all contained in the EXE. Owner's actual clean-Windows VM install/startup and
real account/local-model/Vision acceptance are still pending.

## 2026-10-15 — Startup readiness, Inno repair and local VM handoff

Owner supplied VM screenshots of port-announcement timeout90000ms,
HTTP-reachable/WS-open timeout10000ms, and Repair failing native update
coordination. These screenshots do not expose the underlying VM backend log.
Exact cause of the VM's90000ms timeout remains unproven; no timeout was raised.

Bounded repairs in existing source/build paths:
- _warm_gateway_module now also imports the actual tui_gateway.ws transport
  before lifespan yields. Its RPC-handler/native-module import previously
  occurred inside the first WebSocket upgrade. Import failure now prevents
  readiness instead of presenting an HTTP-live/chat-unready backend.
- Strictly recognized Inno install-only mode now exits both native recovery
  entry paths before updater lookup/admission, with an instruction to rerun
  the same Youtab-Setup.exe in the same folder. Native update admission,
  credentials, data, marker validation, auth/origin/scope gates are preserved.
- WS failure text reports an unestablished connection rather than claiming a
  timeout proves token rejection. Setup preflight now imports the actual
  native web_server module as well as the existing dependency checks.

Evidence:
- Canonical existing boot-handshake tests:4PASS/0FAIL, including a new
  fail-before-ready regression for an uninitializable chat transport.
- Existing Desktop WS/strict-marker tests:53PASS/0FAIL.
- Only native youtab_agent_cli.web_server rebuilt, exit0; complete940 module
  inventory retained. Desktop main/preload bundled and same Desktop packed,
  exit0; final packed main hash matches repaired source bundle.
- Actual QA native CLI serve: READY in2.454s, authenticated /api/status200;
  real bundled Node WebSocket client received gateway.ready; invalid token
  rejected403. Probe's exact owned process tree stopped successfully.
- Native atomic Desktop ready-file publication PASS, owned temporary file
  removed. This covers the file-based port gate, not just stdout imports.
- Independent scoped Codex review APPROVED,0blocking/should-fix/nit.
- Earlier diagnostic asyncio NameError was secondary to OUR probe omitting
  SYSTEMROOT via a case-sensitive whitelist, causing Windows socket provider
  WinError10106. Corrected OS environment resolved it. It is NOT evidence of a
  VM/runtime/Cython defect; no product asyncio/std-lib change was made.

Existing producer27618files/940private native modules and Inno compile exited0.
SAME artifact path:
C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes:941101928
SHA-256:6244B6B0DC7AE35DFA1478FD09BEC0733DE9A816F76D6A3E0141A5757D3B0058
Modified:2026-10-15T19:37:40.8545469+02:00
File-tree SHA-256:4862bb005c94615854abf499875e459d4e42b5ddc47957e5e88b2a7ce5835035
Authenticode:NotSigned

Owner requested opening the VM on this PC for their test. Existing registered
Windows11-AppTest UUID9a486d6b-e253-4d88-b0ce-df895d17a286 was already running
from I:\VM-Test\Windows11-AppTest\Windows11-AppTest.vbox. Its online snapshot
completed without intervention. Starting extra/separate GUI was rejected as
already locked; official VirtualBox ShowConsoleWindow returned its window ID,
then AppActivate succeeded. No reset, shutdown, restore, new snapshot or guest
installation was executed. A transient READ-ONLY YoutabSetup share exposes only
the existing outputs folder (EXE and ISS), without duplicating files:
\\VBOXSVR\YoutabSetup\Youtab-Setup.exe
User will execute this version in that VM. This handoff is NOT a clean-VM E2E
PASS; source-free/air-gap/security/update/sync/signing limits remain explicit.
No Stable/release/deploy or host/user installation changes were performed.

### 2026-10-15 — actual VM late readiness and visible first-launch initialization

Actual owned Windows11-AppTest VM (9a486d6b-e253-4d88-b0ce-df895d17a286)
logs showed the backend announced READY on127.0.0.1:52677 after Desktop had
already failed its90000ms port-announcement deadline. Python was created
19:44:30.947; READY logged19:47:49.186. No process-crash root cause was proved.
Synchronous first-use plugin discovery and web/chat imports consumed much of
the observed interval. Initial Inno dependency/CLI preflight was also silent
for roughly253s. Antivirus/network attribution is NOT PROVEN.

A bounded diagnostic using the SAME installed VM/native modules completed
main/FastAPI/skills/plugins/web/chat initialization in5.203s on a subsequent
run. That result proves only warmed initialization, not clean startup.
No .update-incomplete or .lazy-refresh-incomplete recovery marker existed.

Minimal existing Inno script correction:
- Preserve dependencies, all bundled tools, auth checks and startup timeouts.
- Initialize skill sync, plugin discovery and actual chat-library warmup in
  one private-Python process before completion marker and offered Launch.
- Match headless serve mode before either import preflight; do not start a
  server, enter lifespan, bind a port or start schedulers from Setup.
- Show current setup stage and record stage duration/failure in Setup log.
- Discovery completion does not claim every optional plugin is healthy.
Independent scoped review APPROVE,0blocking/should-fix/nit after fixing the
status-prefix length and environment ordering. One owned compiler attempt
was stopped for those review fixes; corrected Inno compile exited0.
No new source checkout/copy, source modules, test environment or scanner run.

Same artifact path:
C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes:941102578
SHA-256:8DB5AFFBF6AC7A95F4F4ABC8FCB28EBAFBB32813D6B8DB179AEFED4C338D3E84
Modified:2026-10-15T20:04:30.8182240+02:00
Runtime file-tree unchanged:4862bb005c94615854abf499875e459d4e42b5ddc47957e5e88b2a7ce5835035
Unsigned. Clean-start acceptance pending below; no full security/model/update/sync PASS.

For the requested real clean-VM acceptance, gracefully closed only VM Youtab
and shut down the owned VM. Preserved its installed state/logs in offline
snapshotc7e70734-4c9e-4233-92b2-27c4ce0bd726, then restored its EXISTING clean
USB snapshot63e33ca3-e6bb-442f-882e-edd86185cee3 and booted the same VM.
Verified accountvmtest, prior Youtab home absent, user HOME binding absent,
Git/Node absent from PATH; Python PATH entry was only Windows Store alias.
Started one actual installation from transient READ-ONLY output share,
20:05:12local, with visible silent-mode progress and explicit Setup log.
No host/user installation or recovery copy was modified; no Stable/deploy.
### 2026-10-15 — confirmed READY-channel root cause; VM restored clean

The 8DB5AFFB candidate's real clean-VM Inno installation exited0 at20:14:03
(20:05:12 start; approximately8m52s total). Dependency initialization completed,
plugin discovery4.766s, chat libraries2.031s, installed CLI check succeeded.
However its actual first Desktop launch STILL FAILED the90000ms port gate.
This is an installation-only PASS and Desktop acceptance FAIL, not readiness.

Decisive diagnosis used the same VM's real bundled Node -> native Rust
launcher -> private Python serve command, separately capturing its two pipes:
READY_PIPE=stderr; raw line YOUTAB_AGENT_BACKEND_READY port=56525\r;
READY received after4039ms. The backend was ready; the stdout-only Desktop
waiter did not receive its signal. Exact source mechanism:
tui_gateway/server.py317-318 reserves stdio RPC stdout and unconditionally
sets sys.stdout=sys.stderr when imported by the eager chat-transport warmup.
No Rust stdio reroute, antivirus, DeepSeek or cloud-failure attribution is made.

Bounded ROOT correction in web_server's existing readiness publisher:
print the READY sentinel to sys.__stdout__ or sys.stdout explicitly. Preserve
RPC redirection for other output, the existing stdout waiter, ready-file path,
all90s/10s timeouts and HTTP/token/WS authentication. No Desktop rebuild,
new source file, extra environment, clone or scanner loop was needed.
Independent actual3line implementation review APPROVE,0blocking/should-fix/nit.
One regression added to EXISTING tests/test_web_server.py; canonical selected
run passed1test/0failed. Native build compiled onlyweb_server, exit0, preserving
complete940module inventory; staged only that pyd in the existing QA image.

Real packaged native launcher check against existing synthetic QA home:
READY_PIPE=stdout after8932ms; authenticated /api/status200; real WebSocket
received JSON-RPC method=event,params.type=gateway.ready. Exact owned process
tree stopped with exit0. First diagnostic incorrectly looked for method=
gateway.ready, so it timed out despite the actual event shape; corrected only
the probe expectation and reran that bounded transport check successfully.
These are native transport checks, NOT a completed final clean-VM UI E2E,
real model inference, customer update/rollback/sync or complete security PASS.

User explicitly requested diagnosis then clean snapshot restoration. After
capturing the decisive result, shut down only the owned test VM gracefully,
restored EXISTING cleanUSB snapshot63e33ca3-e6bb-442f-882e-edd86185cee3 and
booted that same VM. Confirmed C:\Users\vmtest\Youtab absent, user
YOUTAB_AGENT_HOME binding empty, no Youtab process. No further guest install
was run after this restoration. Earlier diagnostic snapshotc7e70734 remains
preserved. No host/user installations/data were changed.
Existing installer input hashes/receipt are being refreshed for this one pyd;
final artifact identity and compiler result follow below.
Final corrected SAME Inno EXE compiled successfully, exit0 (2026-10-15):
C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes:941102964
Modified:2026-10-15T20:31:29.5686143+02:00
SHA-256:48D0E0F06165C0531B4CDB6D520EC84EB1B8EBADE494E94582189C861191F442
ArtifactTreeSHA256:aa33e0e1e78d76d381f27537d8ae8a6620fc22a300c7085e89d91b36c09bbbd8
Inputs:27618files,940private native modules. Authenticode:NotSigned.
Final regression + implementation independent review APPROVE, no findings.
This48D0E0F0 package contains the compiled original-stdout READY fix. The
previous8DB5AFFB package failed clean-VM Desktop acceptance and is superseded.
At user's explicit request, leave the VM clean; this final EXE has NOT been
reinstalled into it. Do not claim final clean-VM UI/model E2E acceptance.
No Stable, release, merge, deployment, host/user install or update performed.
### 2026-10-15 — preceding-stage delay and first-run provider responsiveness

Actual current VM run of 48D0E0F0 completed extraction at20:42:37; private
Python preflight ran20:42:38-20:50:20 (~7m42s), then skills9.859s,
plugin discovery69.297s, chat warmup39.937s and another CLI process~63s.
The20:53:34-20:59:15 Finish-screen user wait is NOT counted as install work.
READY original-stdout correction worked. Desktop connected but onboarding
showed setup.runtime_check30s timeout and provider-list failure; observed
loop stalls included116.5s. Guest~4GiB free/8GiB, PagesInput/sec0 at sample;
no RAM, antivirus or network causal attribution has been established.

Same existing producer/QA/worktree only, no new environment/source copy:
- Consolidate the three private-Python launches into one initialization;
  retain imports/CLI entry check, stage timings, nonzero-failure gating,
  completion marker ordering and existing90s/10s/30s app timeouts.
- OAuth listing uses FastAPI's existing sync-thread dispatch and config-only
  profile scope; authentication and provider credential checks remain intact.
- Nine SDK additions pinned from existing pyproject/uv.lock: lark-oapi1.6.8,
  pycryptodome3.23.0, requests-toolbelt1.0.0, fal-client0.13.1, msgpack1.2.1,
  exa-py2.10.2, parallel-web0.4.2, firecrawl-py4.17.0, nest-asyncio1.6.0.
  uv resolved40, installed9, no preexisting versions changed; uv pip check
  reports142compatible distributions. All nine actual imports passed.
  Producer now rejects missing, duplicated or version-mismatched SDK metadata.
- Telegram22.6 and Discord2.7.1 including voice were ALREADY bundled.
  Current privatePython3.11.17/SQLite3.53.1 verified. User's pasted Doctor
  resolved an older F: CLI through PATH; its3.11.9/SQLite3.45 inventory is
  not the current installer inventory.
- Bundle official MIT CuaDriver0.35.4 (8files including LICENSE/notices).
  Official archive SHA256823ca4b340ca85301dd65f116cfb26282c40a66f1fc465a225ee103b6b74af5b;
  producer enforces archive/component hashes. Installed HOME/bin driver wins
  over host PATH; explicit configured overrides remain authoritative.
  Actual driver MCP initialize/tools-list passed:61tools in0.234s,
  telemetry disabled, no desktop action or service account used.

Adding the bundled Feishu SDK exposed a concrete eager-load stall: a bounded
Python stack trace during /api/status showed adapter import loading thousands
of lark_oapi/corehr modules on the event loop although Feishu was unconfigured.
Fix: preserve Feishu registration/dependencies; use existing requirements gate
only at SDK-use entry points. Async connect/send run that gate in a thread;
probe preserves absent-SDK HTTP fallback. Existing compiled globals rebinding
verified: initialAVAILABLEFalse -> requirementsTrue and SDK globals bound in
31.187s. Live Feishu connectivity is NOT PROVEN (no account configured).
Credentialed Feishu config can still incur first SDK import cost; no universal
zero-latency promise is made.

Focused canonical results:
- OAuth profile isolation/concurrent readiness:2PASS. Initial new regression
  incorrectly requested nonexistent /api/version (default-deny403); corrected
  only the regression to existing /api/status. No auth rule changed.
- Packaged CUA preference/explicit override:2PASS.
- Feishu onboarding + no-SDK-on-discovery regression:12PASS.
- Existing test_feishu.py:36PASS/18SKIP/22FAIL with Windows Path.home unable
  to resolve home inside tests clearing os.environ. These failures remain
  recorded, were not waived or relabeled PASS; no broad rerun loop performed.
Native builder:only changed web_server/cua_backend/Feishu adapter compiled;
complete940module inventory retained. Exact consolidated Inno init program
executed from installed QA image with synthetic home:exit0,3.922s (warm QA,
NOT cold-VM install proof). Actual native launcher:stdoutREADY2516ms,
authenticatedHTTP200,8OAuth providers184ms, realWS runtime_check93ms;
owned probe tree stopped. Independent scoped implementation reviews approved,
including saved SDK metadata guard; no scanner/security/release-wide PASS.

Configuration/service requirements are retained: model/provider credentials,
Vision-capable model, optional BrowserCDP session, paid service accounts and
user authorization remain necessary. GitNexus stays locked. No real host
installation, Stable/release publication, deployment or customer update occurs.
Final rebuilt EXE identity and cold-VM outcome follow below.
Final SAME Inno EXE compiled exit0 in91.657s,2026-10-15T21:37:07+02:00:
C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes972885562; SHA256A6EE2659690B6C027CBB8DE2D22305EA6000FC64F63242C25630AA191C85C6B5.
ArtifactTree07075ec362b26e98be286da95349e25617a13c646851fb78800e2fbd7c2897bb;
39336files,940private native modules; NotSigned. Saved SDK admission function
verified actual nine versions immediately before compile; independent guard
review APPROVE. The native/MCP results above are not this EXE's cold-VM proof.
Graceful owned VM shutdown completed19:37:09UTC; preserved its actual failed
48D0E0F0 state in OFFLINE snapshotcc147896-04f8-459b-a928-075e793516d9.
Restoring existing cleanUSB snapshot63e33ca3-e6bb-442f-882e-edd86185cee3
for one real installation of A6EE2659. No host/user install changed.
Actual clean-VM A6EE2659 installation completed21:48:39local, after launch
21:40:46 (~7m53s). Extraction/registry ended21:43:33. Native CLI import
alone took282.7s cold; remaining single-process initialization~16s. This
cold delay is STILL NOT fully explained or fixed. A bounded helper trace
showed CPython loading a native extension (create_module); no proven RAM,
Defender, network, or model attribution. First trace attempt was stopped by
PowerShell treating stderr as an error; stdout-only trace completed, exit0.
A6EE2659 first Desktop launch FAILED WebSocket-open10s despite HTTP/READY:
loop stalls14.8s/12s, then ready-frame send failed. No PASS was claimed.

Bounded follow-up correction in existing web_server only:
- _warm_gateway_module materializes deferred platform registration/imports
  via existing discover_plugins()+platform_registry.plugin_entries BEFORE
  accepting probes. No check_fn, SDK installation or adapter construction.
- Embedded chat also resolves its first skin payload before readiness.
- /api/status config/platform inspection uses existing run_in_threadpool,
  preserving contextvar profile scope rather than blocking the event loop.
- Optional registry/skin helpers already swallow some errors; warming does
  NOT prove all optional integrations healthy. Critical WS import stays strict.
- Existing Inno Python invocation adds -X importtime to existing Setup log
  for the unresolved cold-import delay; no new diagnostic environment/files.
Canonical selected startup cases:2PASS, including real deferred registry
materialization during lifespan and forbidden dependency/factory activation.
Independent actual implementation review APPROVE,0blocking/should-fix.
Onlyweb_server recompiled, complete940module set retained. QA native stdout
READY13714ms; HTTP200; OAuth8providers75ms; WSruntime_check39ms, owned tree
stopped. This is transport evidence, not a final cold-VM EXE acceptance.

To verify without another full installation, gracefully closed ONLY the
identified VM Youtab app (PID2968); subsequent owned-process check empty.
Transferred ONLY reviewed web_server pyd using Guest Control (no share of
source/credentials), guest SHA25681F565E705F3F1BBBC72EBB353D4887A6B3165D61C6284A83CFF7834AC8F86DA.
This installed VM is now explicitly a PATCHED QA image; its original Inno
completion receipt belongs to A6EE2659, so it is not proof of final EXE
installation identity. Do not reuse that receipt as release qualification.
A shortcut launch produced no persistent new Youtab process/header; repeated
through existing Explorer at22:00:35 to decouple interactive app from Guest
Control lifetime. Its actual final outcome follows below.
At Owner's explicit correction, PATCHED VM startup is NOT accepted as final:
restored existing cleanUSB snapshot63e33ca3-e6bb-442f-882e-edd86185cee3 again.
No new VM/environment or source tree. Old test install discarded as requested;
cc147896 preserves the earlier failed48D0state. One restore-to-start attempt
hit VirtualBox's transient session-release lock; after release the already
restored SAME VM started, CurrentSnapshotUUID confirmed63e33ca3.

Final revised SAME EXE compile exit0,88.047s:
C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Modified2026-10-15T22:04:41.3927851+02:00; bytes972887011;
SHA2564E8FD0E3165D1C3EF69CA31E1343391E815EC6975DC12E9EFBB86A6ED187D295;
Tree504aee052cec396503267310fd952c364dabbbc11bfabcebb81643dd8fa92e43.
Inputs39336files/940private native modules;NotSigned.
This supersedesA6EE2659. One EXE is transferred to the clean guest Desktop
and installed locally (no shared-folder execution) for the requested acceptance.
The previously observed VirtualBox share error64 is test transport evidence,
not an installer root-cause finding. Final clean-execution result remains pending.
### 2026-10-15 — exact final EXE actually installed from clean snapshot

Owner explicitly required clean-snapshot execution, not a patched installation.
Restored snapshot63e33ca3, verified C:\Users\vmtest\Youtab absent and User
YOUTAB_AGENT_HOME empty. Copied ONE final EXE to guest Desktop; actual guest
SHA2564E8FD0E3165D1C3EF69CA31E1343391E815EC6975DC12E9EFBB86A6ED187D295
matched host bytes. Installed locally via normal Explorer shell, visible
/SILENT progress, explicit existing Setup log, no developer PATH or credentials.
Start22:06:30.997; Setup closed22:17:36.912local (~11m06s). Git Bash passed,
private CLI/command verification/browser/speech/ONNX/skills/plugin discovery/
chat transport initialization completed, bootstrap marker written; no restart.
This final run DID NOT patch installed files after installation.

Cold timing remains OPEN: CLI import294.6s; local chat import50.6s;
browser/speech1.2s; command verification0.9s; ONNX1.3s; skills1.2s;
plugin discovery2.2s; then prewarming platform/skin metadata. Import diagnostics
reported config88.748s self/118.534s cumulative, web_server46.061s self,
package init27.065s, youtab_logging16.046s, tiny version parser16.024s,
telegram_ids11.714s, cron parser10.405s, native_ssl8.950s. These timings
locate cold native-import cost; they do NOT prove RAM, Defender or network
causality. Fast warm-QA results were not substituted for these measurements.

Before Desktop launch, verified installed completion tree exactly
504aee052cec396503267310fd952c364dabbbc11bfabcebb81643dd8fa92e43
and installed web_server pyd SHA256
81F565E705F3F1BBBC72EBB353D4887A6B3165D61C6284A83CFF7834AC8F86DA.
Launched INSTALLED Start Menu shortcut via Explorer at22:18:29.072local.
Actual desktop.log: READYstdout port61050, HTTP reachability, successful
WebSocket gate, 'Youtab backend is ready. Finalizing desktop startup'. Actual
VM screenshot shows provider selection (Youtab Portal / Fireworks AI / Other
providers) without the prior startup or setup.runtime_check error.
Screenshot: C:\Users\eiman\.codex\visualizations\2026\10\01\01a0f786-3d02-7003-8a08-16bc2b087ee5\vm-installer-current.png

PASS (scoped): exact EXE clean-snapshot installation + initial Desktop/backend/
WebSocket/onboarding provider-list flow. NO manual module replacement in this
accepted run. Leave SAME VM running for Owner account/model testing.
OPEN/NOT PROVEN: slow cold installation (~11m);8.0s/10.2s event-loop stall
warnings still recorded; real Youtab login/inference, local-model inference,
Vision, actual Computer Use actions, full customer E2E, About Update, rollback,
two-device sync and full release/security/source-protection/air-gap acceptance.
Existing22Windows Feishu fixture failures remain explicit; NotSigned persists.
No blanket customer-readiness/security PASS, Stable/release/deployment or host
installation/update. GitNexus remains locked; no accounts/credentials copied.

## 2026-10-15 - Actual first-chat delay after clean installation

Owner sent five greeting messages in the accepted clean VM. Read-only actual
VM screenshot/log inspection showed responses eventually visible, not a
permanent provider failure. Agent build loaded environment22:24:48.500;
client built22:25:35.539; deferred tool availability installed edge-tts7.2.7
22:25:39.440-22:26:01.329. Event-loop stalls reached21.3s. A pending model
switch completed22:27:23.742, first conversation began22:27:27.646;
provider API16.6s, turn ended22:28:16.883. Next actual API1.3s, turn ended
22:28:19.970. Actual execution was direct DeepSeek after a user model switch;
this does not qualify Youtab Portal or local inference.

Confirmed additional history defect: turn captured history/version before its
own pending/config model switch appended a marker and incremented the version.
Completion rejected its own history update (expected0/current1). This did NOT
suppress message.complete: it explains dropped active-session history, not all
cold-start latency. Minimal shared fix snapshots BOTH history and version after
turn-start model synchronization, retaining the subsequent external-edit guard.
Four canonical behavior checks PASS (pending/config switch x external edit/
no external edit), 8.1s, runner exit0. Actual independent Codex review APPROVE.
No current guest files, accounts, sessions or installation were changed.

Producer now bundles canonical edge-tts7.2.7 plus its absent transitive tabulate
0.9.0 (repository uv.lock), with exact-version admission and receipt recording.
Only those two distributions added to existing QA image; existing versions
preserved. uv pip check:144distributions compatible; both imports PASS. This
removes the observed first-chat SDK installation, not a claim of zero latency
or live speech qualification. Rebuilding same artifact, no new checkout/image.
Remaining cold native import/GIL latency and stale activity indication are OPEN;
root cause of all startup delay not yet proven. No timeout increase, auth
weakening, scanner change, publication, live deployment or host install.


### Same-EXE bounded chat correction rebuilt22:42local

Inno compiler exit0. Existing output replaced:
C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes973016023; SHA256
30402F05918C2B91C85C466364D0CA393ED813BF9750C33636B9E1A86695FC0C
NotSigned. File-tree7e967dbcb681d8826fc8b989a5c56603874d1934629ca435b9020b4d2e62dbd4,
39376files/940private native modules. Only native tui_gateway.server rebuilt;
producer pins edge-tts7.2.7/tabulate0.9.0 independently APPROVED after saved edits.
Focused4behavior checks passed;144distribution compatibility/import checks passed.
No fresh installation/E2E on this changed EXE: current logged-in VM preserved
on earlier4E8F candidate. Do not carry its installation proof to30402F.
Actual live chat responses were observed on4E8F; full first-cold-turn latency,
UI pending indicator and remaining original release gates are not closed.
No claim of customer readiness, complete security, real local inference,
Update, rollback or sync acceptance; no publication or customer/host installation.


## 2026-10-16 - B7BA8A exact candidate: bounded security and installed capability evidence

Candidate tested: outputs/Youtab-Setup.exe,974889684bytes,
SHA256B7BA8AABE70192B3B22814CEC9D2218CEA77B39B3AB5FB6CB575572AA1A037BA,
NotSigned. This superseded30402F and is not a blanket release PASS.

Bounded product corrections already built: canonical SessionDB initialization in
Inno warmup preserving asynchronous delegation tables; WebSocket sensitive RPC
authorization via existing HTTP permission policy and raw malformed-frame log
redaction; Desktop KaTeX0.18.10 with compatible Mermaid12.2.0, explicit existing
diagram layout/look and strict sanitization.43focused WS tests and48focused
renderer tests passed with independent approval. Root lock still has other
KaTeX0.16.47 consumers; complete repository advisory removal is NOT claimed.

The exact EXE hash matched the guest copy and was installed from clean snapshot
63e33ca3-e6bb-442f-882e-edd86185cee3 into C:\Users\vmtest\Youtab.
Actual setup15:34:52-15:58:27local,~24min under host resource pressure;
completed marker and PATH written, no restart. No installed-module patch.
Native runtime imports including all6youtab_runtime modules, canonical DB schema
and persistence, compiled WS denial/allow/redaction, fresh PowerShell bare
youtab resolution, original user/machine PATH preservation, doctor exit0 without
the targeted missing-Git/Node/rg/browser/Hub/.env/state warnings passed.
Actual bundled rg search and61Skills with a real claude-code skill read passed.
Actual installed MCP stdio initialized, listed10tools and executed synthetic
conversations_list. Computer Use listed apps/captured desktop; auxiliary vision
failed because no vision provider was configured. Full Vision remains NOT PROVEN.

Cold public browser_navigate(about:blank) FAILED after33.45s with
Failed to read ... (os error10060), despite the120s outer first-open budget.
close succeeded. Preserve this failure; warmed repetition is not repair evidence.

Initial local-chat harness used deprecated OPENAI_BASE_URL and unintentionally
reached OpenRouter with a synthetic prompt, returning401; NOT local inference
evidence. Corrected VM-only saved custom/ECO config and provider preflight then
reached http://10.0.2.2:8081/v1 but real CLI/tool chat timed out360s with only
the synthetic user message persisted and no tool calls. The single exact owned
child was terminated using PID/creation-time/command identity. Direct host ECO
chat-completions diagnostic also timed out30s; models GET succeeded. No local
model service changed. Real inference/tool chat remains NOT PROVEN.

## 2026-10-16 - Narrow first-browser-open repair and signing preparation

Official pinned agent-browser0.26 cli/src/connection.rs has a30s IPC read timeout;
its transient list omits Windows10060. Keep the existing120s first-open budget.
Windows first local non-CDP navigation with that exact IPC error now gets one
read-only current-page URL/title/readyState probe within the remaining budget.
Accept only the exact requested ready page (HTTP root slash canonicalized);
never repeat open, restart the browser, weaken sandbox/SSRF, or broaden access.
Null/malformed probe data preserves the original error. Existing vision fix kept.
Canonical focused runner:40passed across timeout/race/local-SSRF files; after
independent review correction18timeout cases passed again. Independent reviewer
APPROVE. Compiled only actual producer module tools._native_browser_tool.
The first build invocation used its public name and was correctly rejected by
the unchanged inventory guard before compilation; no gate bypass.

Signing: both Windows My stores have zero usable Code Signing certificates.
SDK SignTool exists. Owner confirms only Microsoft Store company verification,
no certificate purchased. Official Microsoft guidance says EXE/MSI is NOT
re-signed by Store; standalone EXE requires publisher Authenticode certificate.
Azure billing rejection retained. Certum Standard cloud advertised fromEUR209
but currently shows out-of-stock; no final checkout quote. SSL.com OV1yearUSD129
plus eSigner annual tier1USD180 gives advertisedUSD309before taxes, not a final
purchase quote. Annual budget requested. No purchase, cert/key export, Store
submission or signing performed. Private keys/credentials must not enter docs.

This browser change invalidates B7BA8A acceptance for the replacement binary.
Replacement hash and fresh VM browser result pending. Full security, customer
readiness, source protection, air-gap, real cloud/local inference, Update,
rollback and two-device sync remain unqualified. No Stable/public release,
server deployment, or real host/customer installation changes.



### 2026-10-16 - Browser-only replacement EXE built

Inno compiler exit 0. Same output: C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes: 974892637.
SHA-256: 95AA3E5830DE3877462E4AAABC17885DA0F69C5D64A06E8C0B95978BC82708E8.
Signature: NotSigned.
Tree: 8b6ea6e84e72d7aaa6496e207e73cccadfc21ed69f0666e7550386ca4f14d8fd.
Inputs: unchanged count of 39380 files / 940 private native modules.
Only replaced native browser blob:
tools/_native_browser_tool.cp311-win_amd64.pyd
SHA-256: 2B3BCC1AAEEE8B41F1DB86528F9C1C60E74DE3C2A0C1C7F3EBEA3F1872E97CD8.
Clean snapshot restored; original PATH and absent install/home/CLI confirmed
before copying this one EXE. Fresh final-byte install/browser acceptance pending.

Owner declined the expensive signing quotes and asked about Microsoft Basic.
Fresh official sources confirm $9.99/month including 5000 signatures, $0.005
per extra signature, taxes/currency separate; full monthly SKU billing begins
when an Artifact Signing account is created. Public Trust supports EU
organizations, but separate identity validation and paid Azure subscription
are required. Store verification alone is insufficient. Basic has enough
features for our Setup/Desktop signing; quota counts signings, not customer
downloads/installs. No guaranteed hard spending cap or automatic SmartScreen
reputation was promised. No Azure resource, payment or purchase was created.
Owner's suitability question is not authorization to activate Azure billing.



### 2026-10-16 - 95AA exact clean installation PASS; native browser discovery FAIL

Exact guest SHA-256 matched95AA3E58. Clean Setup started17:11:39.356 and
closed17:31:57.792local (~20m18s). Log: single-process Runtime initialization
and CLI entry-point check completed, CLI user PATH registered, no restart.
Local SessionDB prepared at17:26:55.469. This is genuine installation proof
for95AA, not browser/full-feature acceptance.

The planned fresh Explorer/System32 acceptance resolved bare youtab to the
installed private CLI and confirmed no external Git/Node/rg/agent-browser on
PATH. It verified the exact installed native browser2B3BCC1A and tree8b6ea6e8.
Actual first navigation failed in1.11s:
"Auto-launch failed: Chrome not found. Checked: agent-browser cache ...
System Chrome installations ... Puppeteer browser cache ... Playwright browser cache.
Run agent-browser install to download Chrome, or use --executable-path."
close succeeded. BrowserExit1. Started17:34:01.778; ended17:34:35.234.
Doctor was not reached in this failed combined run. Preserve this failure.

Root cause: Python detects bundled Chromium and sets PLAYWRIGHT_BROWSERS_PATH,
but agent-browser0.26 native Windows discovery does not use this custom cache.
Earlier B7 harness explicitly supplied AGENT_BROWSER_EXECUTABLE_PATH, so it
did not establish automatic customer discovery. No missing Chrome download;
the included binary is browser/ms-playwright/chromium-1234/chrome-win64/chrome.exe.

Narrow product fix: _build_browser_env reads the bundled manifest's numeric
Chromium revision and passes its exact existing installation-relative executable
through upstream's supported AGENT_BROWSER_EXECUTABLE_PATH. Explicit custom
override is retained. No cache/host glob, sandbox relaxation, download, credential
scrubber change or timeout increase. Added5cases to existing discovery test.
Canonical affected discovery/startup tests32PASS; independent reviewer APPROVE.
Only tools._native_browser_tool is being rebuilt.

One intermediate native verification in the OWN synthetic VM is planned before
another expensive final packaging/install pass. It is explicitly not a fresh
EXE acceptance. No host/customer installation or actual data is modified.
Fresh final-byte acceptance remains required; no readiness/security/signature PASS.



### 2026-10-16 - Intermediate repaired native browser and bare doctor PASS

Repaired native browser SHA-256:
EB6F1F1661F3474FFCAC7392C382F4C4F8EF0A1C6B6EF250D95B2F733DE3EB25.
Copied only this module into the OWN synthetic VM; this was NOT a fresh
replacement-EXE acceptance. No host/customer installation was changed.

Fresh Explorer PowerShell at C:\Windows\System32, no manual dependency PATH.
Started17:40:49.848; ended17:42:44.267local. Native module hash verified.
The product's own environment selected the exact bundled Chromium executable.
Actual public browser_navigate opened the unique synthetic loopback page
in30.45s, returned its exact title/URL and real accessibility snapshot with
heading/button. Exactly one root navigation request was observed. Actual
read-only eval returned the same page and readyState complete. close succeeded.
Browser process exit0. Bare youtab doctor exit0: Git, Node.js, rg, agent-browser,
Chromium detected; state.db0sessions with no missing-table warning; Hub initialized.
Fresh-user model/account configuration warnings remain expected; no keys or
accounts were copied. Doctor's "No active security advisories" line is NOT
complete security/SAST/privacy qualification. No inference/vision claim.

Reusing the same producer payload and regenerating exact inputs once for the
new native module; next EXE hash and fresh-final-byte acceptance pending.
The95AA clean-install proof remains separate from this module-level repair.


### 2026-10-16 - Final browser-repair EXE built; exact clean VM acceptance started

Reused the same source checkout, QA payload, native output and Inno script.
ISCC exit0. No new checkout or payload copy. Final single EXE:
C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
Bytes: 974894147
SHA-256: CA4D81086604E6ED54A707419B7D3D7234BB042BB40D8CFEE09D9B3863373E1C
Authenticode: NotSigned.
Payload tree: 7ce715b99c67ecc3f0d9b5daeac05720d66cca2e531ed06a727ca970c1d9e25e
Private native browser: EB6F1F1661F3474FFCAC7392C382F4C4F8EF0A1C6B6EF250D95B2F733DE3EB25.
Inputs: 39380 files and 940 private native modules.

Same Windows11-AppTest VM was powered off and restored to the existing
Ready for app testing - USB snapshot. Before installation: no Youtab directory,
no registered home and no youtab command; original PATH recorded. Transferred
only the final EXE and verified its exact SHA-256 in the guest. Fresh installation
and final cold browser/bare-doctor acceptance pending; intermediate repaired
module PASS above is not substituted for this acceptance. No host installation,
real user data, publication or Azure resource changed.

### 2026-10-16 - Exact final EXE clean installation, cold browser and bare doctor PASS

Candidate CA4D81086604E6ED54A707419B7D3D7234BB042BB40D8CFEE09D9B3863373E1C
was copied as one EXE to the same restored clean Windows11-AppTest snapshot;
guest SHA-256 matched before launch. No installed file was patched for this
final acceptance. Fresh Setup started17:57:59.850 and closed18:22:28.263local:
24m28.413s. This slow actual VM installation is recorded, not hidden or blamed
on RAM/antivirus without evidence. Local session DB prepared18:14:51.818.
The same install completed Runtime warmup and the CLI entry-point check,
registered the private CLI in user PATH and required no Windows restart.

One final acceptance ran18:23:08.397 to18:24:34.887local from a fresh Explorer
PowerShell at C:\Windows\System32. Scope: Final EXE cold bundled browser.
Original machine PATH remained identical and all original user entries were
preserved; private CLI entry exactly once. Bare youtab resolved to the installed
venv\Scripts\youtab.exe. No external Git/Node/rg/agent-browser on PATH;
ManualPathChanges=false. Verified the exact marker tree7ce715b9 and native
browser EB6F1F16; product environment chose its bundled Chromium executable.

Actual public browser_navigate opened a unique synthetic loopback page in14.83s,
returned its exact title/URL and real accessibility snapshot (heading/button).
Exactly one root navigation request was observed. Actual read-only eval returned
the same page and readyState complete. Actual close succeeded. BrowserExit0.
This exercises installed native transport/Chromium discovery and preserves the
previous failed95AA evidence; it is not cloud-model Vision/inference proof.

Bare youtab doctor exit0: bundled Git, Node.js, ripgrep, agent-browser and
Chromium found; state.db0sessions with no missing sessions-table warning;
Skills Hub directory/lock OK. Fresh-user API-key/login/config warnings remain:
no credentials/model were copied. Optional Docker/Spotify warnings remain.
Doctor's advisory summary is not a comprehensive security audit.

Build-local source regression32PASS and independent reviewer APPROVE are
supporting evidence. This final exact-byte install/browser/doctor acceptance
is genuine; clean chat with Youtab/local inference, cloud Vision, About Update,
rollback, two-device sync, air-gap/privacy and full security are NOT PROVEN by
this bounded check. Existing broad release blockers stay open. Still NotSigned.
No Stable/release publication, server deployment, host/customer installation,
real user data modification or paid Azure activation occurred. Same EXE path.

### 2026-10-16 - Owner-reported VM chat success; signing/MSIX and settings clarification

Owner reports that chat was manually tested successfully in their VM. This is
owner-reported functional chat evidence. Model/provider, session trace and exact
artifact checksum were not supplied with this report; do not expand it into
all-model/Vision/update/sync/security acceptance. No further test or install ran
for the present explanatory request. Current EXE was not modified.

MSIX Packaging Tool supports conversion of existing EXE installers in a clean
VM. Existing VirtualBox guest can run the tool inside the VM; the integrated
local-VM option supports Hyper-V only. This is a second distribution format of
the same Runtime/product, not a new codebase. Store signs approved MSIX/AppX
submissions without a separate CA certificate purchase. It does not sign our
standalone Inno EXE. Current Setup registers a user home/PATH and uses a shortcut
working directory; MSIX writable-data location, CLI alias/discovery and the
package-managed update path need compatibility work before claiming a working
Store package. No MSIX package or Store submission was created here.

Cost clarification: Microsoft Artifact Signing Basic is USD9.99/month with5000
signatures; USD0.005/additional signature. Earlier USD129/year referred to SSL.com
OV certificate base price, with separate key-storage/signing costs as applicable.
Official Microsoft initial identity validation estimate is1-20business days,
possibly longer for additional documents. Billing begins on account creation,
full SKU amount, not prorated. Taxes/FX/overage can affect the final bill; Azure
budget alerts do not stop consumption. Owner approval is conditional on no more
than USD9.99/month and quick issuance; these conditions cannot currently be
guaranteed. No paid resource/purchase was activated.

Settings source confirmed:
Settings -> Providers -> Accounts -> Account sync -> Enable sync for all chats.
The disabled/unavailable state offers Turn sync off on this device.
Sources: providers-settings.tsx519; account-sync-settings.tsx81-92;
account-sync-copy.ts9-10,27-28; settings/index.tsx174-180.

Confirmed current Desktop UX gap: telemetry.shared_metrics.enabled and
computer_use.cua_telemetry exist in Runtime, both default false, but neither is
listed in Desktop SECTIONS.keys. sectionFieldEntries renders only those listed
keys, so backend category mapping alone does not surface telemetry toggles in
the current Desktop. There is no honest Desktop menu path to report for them.
Existing CLI command youtab setup telemetry configures local shared metrics.
It is not an all-network/air-gap switch. Track visible telemetry controls with
the existing Safety roadmap work; no product settings/code changed here.
Sources: settings/constants.ts673-686; settings/helpers.ts117-130;
youtab_agent_cli/config_defaults.py2629-2634,2871-2877; setup.py2362-2387.


## 2026-10-16 - Owner priority: post-customer-test confidentiality hardening

Owner decision: all three items below are mandatory. Protecting customer and
organization data against unauthorized interception, tampering, surveillance and
disclosure is the highest priority. This is an acceptance requirement, not a
claim that the current artifact has complete security or proven air-gap isolation.

Status for all three: PLANNED - DEFERRED BY OWNER UNTIL CUSTOMER-DEVICE TEST
RESULTS ARE RECORDED. This entry authorizes documentation now; implementation
must wait for that condition. No code, EXE, installed application, configuration,
VM, credential, deployment or release is changed by this roadmap entry.
Evidence and scope: security/customer-exe-audit-20261016/CODEQL_PRIORITY_REVIEW.md.
The raw CodeQL count is not a count of confirmed exploitable vulnerabilities;
this entry does not mark the remaining findings reviewed or resolved.

### SEC-POST-CUSTOMER-01 - Enforce validated TLS for remote account traffic

Evidence: the authentication transport can disable certificate verification
through explicit or persisted insecure settings; verification is on by default.
The bypass creates a conditional interception/tampering risk for remote HTTPS
credentials and data. It does not prove that a customer currently uses the
bypass or that data has been intercepted.

After customer testing: require certificate verification for credential-bearing
remote Youtab login, refresh and inference. Retain supported organization CA
configuration and existing loopback HTTP local-model support. Do not silently
fall back to insecure transport, delete account credentials on certificate
errors, or change token formats, scopes or the Update trust policy.

Acceptance before closure:
- Valid TLS login, refresh and inference continue to work.
- Invalid/untrusted certificates are rejected before credentials or application
  data are sent to the unverified peer; no silent bypass is available.
- Approved organization CAs work; loopback local-model discovery, tools and
  streaming remain functional.
- Update manifest/signature/hash checks and installation coordination remain
  intact.

### SEC-POST-CUSTOMER-02 - Keep chat content out of ordinary diagnostic logs

Evidence: ordinary INFO diagnostics include an 80-character user-message
preview. Credential redaction does not necessarily remove business-sensitive
text. This duplicates customer content in local logs and may expose it through
log access, backups or support exports. Logging alone is not proof of upload.

After customer testing: remove user content from the ordinary diagnostic record;
retain operation/session identifiers, counts and error codes. Any optional
content diagnostics require explicit, limited consent and default to off.
Preserve the original chats, history, model requests, memory and trajectories;
do not globally alter the shared summarization helper or suppress stdout frames.

Acceptance before closure:
- A synthetic confidential marker is absent from ordinary diagnostics and
  ordinary support-log exports while useful identifiers/error codes remain.
- Chat content still reaches the user-selected model as intended.
- Backend port announcements, JSON frames, streaming, local models, Youtab
  account flows and Update remain functional.
- No customer content or credentials are added to the verification report.

### SEC-POST-CUSTOMER-03 - Authenticate users of the owner-credential proxy

Evidence: the optional proxy defaults to loopback but accepts consumers without
independent authentication and substitutes the owner's upstream bearer token.
An explicitly reachable non-loopback binding can expose owner service rights
and quota; local processes can also reach loopback. This is not proof of a
public default listener, theft of prior chats or a demonstrated arbitrary SSRF.

After customer testing: authenticate proxy consumers before resolving,
refreshing or using owner credentials. Use a separate consumer identity/secret,
never the owner's refresh token, and never put secrets in URLs or logs. Retain
loopback as the default. Reject non-loopback operation without an authenticated
secure policy; an organization LAN deployment requires TLS and scoped access.
Preserve upstream route restrictions, credential adapters, tools and streaming.
Existing users of this proxy need an explicit migration to its consumer key.
Do not impose this proxy key on unrelated local-model servers.

Acceptance before closure:
- Unauthenticated consumers are rejected before owner credential resolution,
  refresh or upstream use.
- Authorized consumers can use the supported tool and streaming routes.
- A non-loopback listener cannot start unprotected.
- Direct local models, normal Youtab login/refresh/logout and Update retain
  their existing supported behavior.

### Execution order and closure evidence

1. Complete the current customer-device test and record the exact EXE SHA-256,
   device/test context and actual outcomes. Record install/startup, local-model
   and Youtab account results when exercised; distinguish Update observations
   from untested behavior. Do not collect customer chats, files or secrets.
2. Only after those results are recorded, start the three bounded fixes above.
   Preserve the existing Installer, features, plugins, skills, browser/MCP and
   customer data. Keep unrelated changes out of these fixes.
3. Close each item only with evidence for its security denial and compatibility
   criteria; a build or source edit alone is not acceptance.
4. These three fixes do not establish global no-egress or complete air-gap
   isolation. The existing Safety/HardCore/Local-Only/Air-gapped work still needs
   its own enforcement and process-tree evidence. Account-cloud processing and
   owner-selected model processing must remain accurately disclosed.
5. Publication, Stable promotion and live-server deployment retain their
   separate approval requirements. No installation, release or deployment is
   authorized by this documentation entry.

Current outcome: three mandatory security items recorded; implementation
deferred pending customer-device test evidence. No blanket interception,
exfiltration, OWASP or overall security PASS is issued.


## 2026-10-18 - Turn diagnostic privacy fix; TLS/proxy dependency review only

Owner explicitly advanced SEC-POST-CUSTOMER-02 for implementation now.
This supersedes the earlier deferral for item 02 only; it does not assume that
customer-device acceptance has completed. Items 01 and 03 remain analysis-only.

Implemented scope: agent/turn_context.py, the ordinary turn-start INFO record.
Removed the 80-character user-message preview; retained session, model,
provider, platform and history count, and added the existing turn ID.
No shared summarization helper, message/model payload, chat history, CLI
display, error handler, account transport, proxy or Update logic was changed.
Historical logs were not deleted or rewritten.

Regression evidence:
- scripts/run_tests.sh tests/agent/test_turn_context.py
  tests/agent/test_api_content_sidecar.py -j 1, file retries disabled:
  37 PASS / 0 FAIL. Existing development Python and isolated test home were used.
  An initial invocation with native-tools stopped before collection because
  that interpreter lacked pytest; no test outcome was counted from it.
- Four new behavior cases cover text/multimodal input and quiet/visible CLI;
  a synthetic private marker is absent from the INFO record, metadata remains,
  and conversation content is preserved.
- Rebuilt only agent.turn_context through the existing native producer.
  The producer retained its full 940-module inventory and rejected unselected
  source drift; no new checkout, source tree or environment was created.
- Four zero-network checks against the actual QA .pyd and bundled Python
  passed: content omitted from captured diagnostics, IDs retained, payloads
  preserved. Fake agents reused a session ID and emitted the existing
  overlapping-turn tripwire warnings; these are not evidence of a real
  customer session failure or a full chat E2E PASS.
- Existing Inno project/compiler finished with exit 0. Same output filename,
  same 39380 package inputs and 940 private modules. The existing QA image was
  reused; no user/customer installation was run or altered.

Artifact identity:
- EXE: C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\Youtab-Setup.exe
- Bytes: 974894682
- SHA-256: 99CE41C3C15373D7885ED972C76E6D44F9120080EC90E246FDE04C9743143A8C
- Payload tree SHA-256: 3effb106505ae26a663fb38f30b7258d9dcc4a4741ec122476f0efb2d8f0ee95
- agent/turn_context.py SHA-256: E1066337F55677D743BD865155A3DF6AFACEDD76745F717E6401A16B9164B3A6
- Bundled agent.turn_context .pyd SHA-256: D14432079D2D38185E661070C878E9B05066611BFA98FDC539DA02A552EAD382

Signing was not performed. A fresh clean-Windows install, real inference,
About Update, rollback, sync and support-export E2E were not run in this
bounded change. The reported INFO-preview defect is fixed; these results do
not establish content-free logging across every component or full security.

Items 01 and 03: code/dependency review only, no implementation.
Detailed evidence, compatibility risks and estimates were appended to
security/customer-exe-audit-20261016/CODEQL_PRIORITY_REVIEW.md.
- 01: legacy account refresh, managed access tokens, auth/shared stores,
  CA persistence and trusted endpoint overrides; native Desktop OAuth uses
  its own transport. Estimate 2-4 engineering hours for the bounded fix and
  selected verification; real organization infrastructure can add time.
- 03: optional owner-credential proxy, CLI parser, adapter refresh/rotation,
  upstream forwarding and external consumers. Estimate half to one working
  day for loopback authentication/client migration; organization LAN TLS may
  extend the scope to about 1-2 working days.
Neither item requires redesigning Inno or changing installation/PATH/Update.
Existing insecure trust settings or clients without the future proxy key may
lose connectivity intentionally; zero compatibility impact is not promised.
No TLS/proxy behavior tests or edits were performed in this review.

## 2026-10-18 — approved visual build, exact clean-VM qualification

- Original common Installer preserved: SHA256 `ACC4720199E3E43165EC8ECB09AABDB8822AD1070905BBBB07F751A5ADA9FD79`.
- Verified full backup/checkpoint: `D:/Youtab-backups/visual-redesign-20261018T055450Z`, checkpoint `checkpoint-20261018T080835Z`.
- New separate EXE: `C:/Users/eiman/Documents/Codex/2026-10-14/bi/outputs/visual-approved-20261018T085133Z/Youtab-Setup.exe`; 976111096 bytes; SHA256 `EFF8A5B7641764082A8CD5B7A29420F1433EDBBB7692B8B50E8298602FB5D4AA`; NotSigned.
- Desktop source: HEAD `a3e8a7dbf4ed0ee9c397f1233144b493a49219cd`, branch `codex/online-installer-20261015`, dirty. Full patch/status, per-file hashes, verified changed-source ZIP and build/staging scripts accompany the output. Native Runtime reused from existing payload plus separately approved native discovery fix; no claim that all dirty Python source was recompiled.
- Applied the approved shared visual system to existing pages/Settings destinations, added requested existing-backed Settings destinations, preserved original controls/handlers, theme state and continuous stream rendering. Settings-only supplied image is right-aligned at 4% opacity, outside scrolling content. Work/Chat tabs remain Coming soon. About removal choices remain inside a collapsed static disclosure.
- Source verification PASS: production type check, renderer build, 134 selected existing UI tests, 2 Safety behavior tests. 50 Desktop protected files and 1347 native-file hashes preserved; 39006 non-Desktop mappings retained. No preview mock bridge shipped.
- Exact EXE clean Windows snapshot install PASS: disconnected NIC, install root absent beforehand, exit0, 315.09 seconds. Fresh PowerShell resolves installed youtab; doctor exit0 finds bundled Python, Git, Node, ripgrep, agent-browser and Chromium.
- Installed native API inventories: 61 skills, 27 toolsets, 309 environment metadata entries, 8 OAuth providers, 87 bundled Runtime plugins, 2 dashboard plugin entries. MCP server list is empty until configured; actual MCP stdio handshake and native registry echo dispatch PASS using an owned synthetic fixture.
- Native Safety save/read-back/model-preservation/original-restore PASS. Selected UI tests separately cover successful toggle persistence and rejected saves.
- Real LAN ECO test PASS with endpoint supplied only at test time via normal config API: CLI real assistant marker persisted (130.97s); synthetic file task returned unpredictable file marker, status complete, 1 tool.start, 1 tool.complete and 20 message.delta events (75.36s). Public TCP443 probes were blocked during test; no full air-gap/exfiltration claim. Temporary guest firewall rule was removed afterward, with public connectivity restored.
- Online read-only checks: bundled HTTPX TLS validation succeeded, API root HTTPS404; Windows example.com HTTPS200 and Microsoft connectivity HTTP200. Skills Hub search HTTP200/5 results; github/clawhub sources timed out. Separate stdlib HTTPS trust-store probe failed and is retained as scoped evidence, not misreported as native account failure. TLS verification was never disabled and no additional root certificate was trusted.
- Native browser navigate/snapshot returned success, but compact snapshot did not confirm expected page text. Initial untargeted computer capture refused Cua Driver's own authorization process. These are not full browser/computer-use E2E PASS; authority guards remain intact.
- Owner reported VM Internet unavailable. Live VM checks confirmed NIC on, public Windows HTTP/HTTPS successful and Google login page loaded. Owner is completing test-account login; no credentials copied or printed. Online account inference/refresh remains pending.
- Existing QA disk preserved as VirtualBox snapshot `195de104-9476-49b9-9fc1-d3135db99b1b` after a failed live snapshot/stuck shutdown. Clean baseline `63e33ca3-e6bb-442f-882e-edd86185cee3` restored; guest6GB RAM. Only the verified QA VM process was recovered; no host installation changed.
- Evidence/report: new output `DELIVERY_REPORT.md`, `INSTALLER_IDENTITY.json`, `INSTALL_RESULT.json`, `DOCTOR_RESULT.json`, `INSTALLED_IDENTITY.json`, `APPROVED_RUNTIME_RESULT.json`, `APPROVED_LOCAL_CHAT_RESULT.json`, `APPROVED_ONLINE_READ_RESULT.json`, `APPROVED_NATIVE_TOOLS_RESULT.json`.
- Remaining: account login/API/refresh, browser interaction/content confirmation, ordinary-window computer-use approval/actions, native UI interaction/restart/RTL completion, Update/rollback/uninstall E2E on exact EXE. No global 100% readiness or new full security certification. No merge/push/deploy/publication/customer or host install.


Follow-up browser diagnosis: the compact snapshot correctly contained only the page link. A single full-snapshot and DOM title/body read confirmed the real public page; native browser navigation/content read PASS (BROWSER_CONTENT_RESULT.json). No browser code or security setting changed. Owner account login and ordinary-window computer-use E2E remain pending.

## 2026-10-18 — final Pin / Simorgh / Computer Use Settings follow-up

- Separate final single EXE: `C:/Users/eiman/Documents/Codex/2026-10-14/bi/outputs/approved-ui-final-20261018T1050Z/Youtab-Setup.exe`; 976110640 bytes; SHA256 `C23F69EB55344F878DF8115AD73F4FA601EEB12F5FC6B64F1B2CAB62AF9FDA80`; NotSigned.
- Verified before-edit backup `D:/Youtab-backups/chat-pin-simorgh-20261018T101303Z`, including the additional 11-file Computer Use Settings checkpoint. Original ACC472 and prior EFF8 EXEs re-hashed unchanged. Full rebuild-input backup retained.
- Fixed local pin intent being overwritten by the cached server row before PATCH. Two new regressions reproduced against old code; local push and guarded remote adoption now preserve intent. Real packaged UI context-menu Pin moved a synthetic session into Pinned, and an independent native DB read confirmed persisted true. Native API pin/unpin/pin and fresh DB reads also passed.
- Running tools/delegation, thinking and stalled-stream indicators reuse shared Simorgh Loader. No stream order, timing, tool content or approval changes.
- Added Settings -> Application -> Computer Use in rail/dropdown, reusing existing driver status/permissions/provider/install controls and existing Tools destination; no auto-grant or new permission/toggle system. Actual installed page opened offline and captured; driver 0.35.4 status Ready, config/status HTTP200. Existing first-run driver-home warning is preserved.
- Focused source checks PASS: 56 Pin/sidebar/stream/tool UI cases + 28 shared Settings control cases, no skipped cases; production TypeScript and renderer build pass. An earlier root test invocation lacked jsdom and was invalid; correct existing UI project passed. No scanner rules, test timeouts or baselines changed.
- Exact final EXE clean VM install PASS: original baseline 63e33ca3-e6bb-442f-882e-edd86185cee3 restored, no install root before, disconnected NIC, exit0, 357.28s. Fresh PowerShell resolves youtab and doctor exits0 with bundled Python/Git/Node/rg/agent-browser/Chromium. Native tests and UI checks completed disconnected; NIC then restored on.
- Owner reported prior online account/chat success. Prior QA account/chat state preserved before reset in offline snapshot bdae7af9-57df-47d6-87df-ce838fbf8f5c. Exact final run used the normal choose-provider-later option and synthetic QA data only; no credentials copied/read.
- Build HEAD a3e8a7dbf4ed0ee9c397f1233144b493a49219cd on codex/online-installer-20261015, dirty. Source patch SHA256 53CBDD65CBAC57CDE05418257C1BD51CA8176FCD70FD5066C61823E8397126A7; verified CURRENT_SOURCE.zip SHA256 9D9167D70EBF6AD81B98FCCC855A57FD61B95301CA3378F4051DAFF3416A4082, 12749 files. Source archive predates this evidence-only roadmap append. Installed app.asar hash matches staged 1B602F049C4AB121BF36EA8DDD6B44D43054B9649EF6724DC39CC2DE4BF11456.
- 50 protected Desktop files and 1347 native-file hashes unchanged; 39006 non-Desktop mappings retained; prior approved native discovery fix retained. No new native Runtime/auth/model/API/Update changes or preview mocks shipped.
- Evidence and remaining limits: final output DELIVERY_REPORT.md, SOURCE_IDENTITY.json, FINAL_INSTALLER.json, SOURCE_VALIDATION.json, INSTALL_RESULT.json, DOCTOR_RESULT.json, FINAL_PIN_COMPUTER_USE_RESULT.json, PIN_UI_RESULT.json, INSTALLED_IDENTITY.json, VM_FINAL_COMPUTER_USE.png, VM_FINAL_PIN.png.
- Actual inference/live thinking under model load, account refresh, complete process restart/theme/RTL suite, all tool/providers, Update/rollback/uninstall and comprehensive security/air-gap certification were not repeated on this renderer follow-up. Prior-package results remain explicitly separate. No merge/push/deploy/publication or host/customer install.


## 2026-10-20 — common Inno Update v1 candidate (Owner authorized)

The Owner requested Update before final delivery, persistent active/inactive controls, online and air-gapped/offline acquisition, smoke and OWASP checks. No publication, merge, deployment or real user-profile installation is authorized by this candidate work.

- The protected prior EXE remains `C:/Users/eiman/Documents/Codex/2026-10-14/bi/outputs/approved-ui-final-20261018T1050Z/Youtab-Setup.exe`, SHA256 `c23f69eb55344f878df8115ad73f4fa601eeb12f5fc6b64f1b2cab62af9fda80`.
- Full source before Update was archived separately; every subsequent candidate has its own source archive, dirty diff, exact payload and external producer identity. The current isolated output is selected by `youtab-visual-approval-20261018/UPDATE_BUILD_PLAN.json` under the task evidence folder. A built artifact is not clean-PC qualification.
- Master update permission and automatic online checks both default off. Electron owns the permission; controller entry points enforce it again. Offline signed descriptor import has no login, discovery or online fallback. No public feed has been published.
- The full EXE remains the fresh-install and update artifact. P256/SHA256 publisher metadata binds exact EXE bytes and program manifest. The non-exportable CurrentUser CNG publisher key is not in source or payload. Metadata signing is separate from Authenticode; customer EXEs remain unsigned unless separately signed.
- Only bin/git/node/python/youtab-agent-runtime are promoted. Chats, profiles, credentials and SQLite/WAL remain outside the moved roots. Version1 refuses changed byte identities of64 conservative state/auth/config/ABI contracts. This is not a semantic guarantee about arbitrary future signed code or a schema-migration mechanism.
- Native jobs bound child lifetimes, retain the verified EXE lease, and require explicit health/registration ACK. Uncertain writers prevent rollback. Durable root IDs and registration snapshots support failure rollback; interrupted-helper recovery fails closed until a different kernel boot, exclusive lock and no program writers. Enterprise policy may prevent running the manual recovery script; no ExecutionPolicy override is introduced.
- Separate headless Gateways and active/detached Desktop sessions block Update. Existing session.active_list is a read-only observed idle check, not a new atomic runtime quiesce API. Keep my data remains; separately confirmed Uninstall everything still removes chats/data. Legacy install-only apps need one preserving manual enrollment with this new full Setup.
- Normal Setup has exact admitted binary in-use probes before copy; they reject already-open binaries but cannot atomically prevent a later legacy launch. New Uninstall takes the same exclusion as Update. Real concurrent Install/Update/Uninstall acceptance still needs VM checks.
- Actual scoped evidence so far: native Update138/138 serial PASS (same timeouts; initial parallel137/138 retained); existing managed OWASP39PASS; existing Python SAST profilePASS; local idle RPC12PASS; UI52PASS; strict Electron/renderer TypeScriptPASS. Scoped lint has no introduced findings; untouched main17errors/201warnings and preload1warning remain. No scanner rule/baseline was weakened. No full CodeQL, whole-application OWASP/Agentic or air-gap privacy certification is claimed.
- Exact final EXE installation, online feed, real account/model inference, real full update/restart/rollback and Keep-data reinstall remain NOT PROVEN until executed. The Owner requested personal clean-VM acceptance. Existing runtime PR96/CodeQL, unsigned release, private-source and air-gap qualification limitations remain in force.

## 2026-10-20 — actual r2 Update failure and bounded maintenance / Workspace follow-up

- Verified before-edit backup: `D:/Youtab-backups/workspace-update-r2-20261020T162538Z`, including the exact r2 EXE, frozen source/build inputs, dirty diff and receipts. Protected r2 SHA256: `460ab65279eeb706c1010abdf8b95c4e9b9a4ef2fe5129577c85860a6f035b55`. Previous outputs are preserved; the new sequence2026102003 build has a separate directory.
- Actual VM began empty. The unmodified baseline sequence2026102001 Setup completed its program/runtime initialization in about19minutes; the outer10minute wait expired, so its final process exit was not captured. Cold-install performance is not PASS. Ordinary Desktop close/relaunch after Setup completed recovered normal startup; no installed file, marker, PATH, ACL or authentication patch was used.
- Actual offline Update admitted and consented to exact r2, then failed before replacement: `Uninstall helper exited before it was ready.` Installed sequence remains2026102001. The two existing sessions and all five messages were independently checked unchanged after the failure. Evidence: `vm-r2-update-acceptance-20261020T151700Z/CHAT_PRESERVED_AFTER_FAILED_UPDATE.json` under the task evidence folder.
- Host and guest output-only probes reproduced detached Windows PowerShell exiting0 without executing input. Removing detached alone failed a real parent-exit survival regression. The bounded fix uses a leased, exclusive private copy of bundled Node as a detached broker, non-detached PowerShell, explicit release ACK before Desktop exit, exact exit forwarding and cancellation that waits for actual PowerShell close. Existing native transaction tokens, rollback, signature admission and reservations remain authoritative. No installed VM patch was performed.
- Final helper source tests:42passed,0failed,1skipped; the existing symlink/reparse test needs unavailable permission and is not PASS. Electron TypeScript6 check passed. Temporary broker bytes may remain after Desktop exits; full Uninstall cleanliness remains unproven. Current result and exact source hashes: `NATIVE_HELPER_LIFECYCLE_FINAL.json` and `NATIVE_HELPER_SOURCE_HASHES.json` in that VM evidence directory.
- Customer labels now read Recommended / Early access (Persian: پیشنهادی / دسترسی زودهنگام), with clear descriptions, while the stable/pilot IDs and selection/policy behavior are preserved.17focused UI tests passed.
- Workspace now selects a source folder and project name through the native folder picker, creates `<source>/Youtab/<name>`, copies ordinary files without modifying originals, initializes an independent Git repository without original history/remotes/hooks, and registers the actual copy through existing project APIs. Existing destinations, unsafe paths/links and stale gateway/profile results fail visibly.53focused filesystem/Git/store/UI tests passed; renderer and actual composite Electron TypeScript checks passed. This is a working-copy workflow, not an OS sandbox: other explicitly authorized absolute-path tools can still reach outside it. No existing project/session was retargeted.
- Actual baseline VM, without Portal login, completed real ECO chat and generated an HTML artifact with Copy/Download. The model was host-loopback ECO reached using a test-only VBox NAT endpoint, not a model running in the guest or public zero-egress proof. Actual Reply populated a draft without sending; Report required sign-in, defaulted excerpt off and sent nothing. These are baseline observations, not redesigned r3 installation PASS or authenticated report-receipt proof.
- Existing managed OWASP contract/policy/security/worker suite passed39tests through the canonical runner with isolated synthetic data. No complete CodeQL/dependency/OWASP/Agentic/air-gap certification is claimed. Final Installer identity, native signature/admission and actual installation/Update outcomes must be recorded separately after building. No merge/push/deploy/publication or owner/customer host installation.


### Post-build r3 outcome — documentation appended after the frozen build

- New separate EXE: `C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\approved-maintenance-workspace-r3-20261020T171041Z\Youtab-Setup.exe`; SHA256 `9D23A491BEC36B835D1119F30AE81FA12EA5D3938A5B7783A181451F1E777348`; 977500357bytes; AuthenticodeNotSigned. Sequence2026102003; buildId `8755340e1f435b05bd7934767616e03a62158b3f6d71f1046d273a9ee8e145a5`; source archive SHA256 `53fc1eba2018b4defa17c3c45dd90ac05c63cfcb819c9e921a2af72ba6404398`. The exact frozen source/dirty patch remains in the output; this paragraph was appended after compilation and is not part of that source archive.
- Production build and full Inno compile passed.48protected native/support Desktop files unchanged; retained non-Desktop payload hashes admitted. Exact final EXE passed production offline signature/length/hash admission plus tamper/expiry/downgrade denial checks, and independent Windows P256/SHA256 verification. No Installer was executed by those admission checks.
- Final real helper tests passed42/0failed/1skipped with developer Node and again with the exact bundled Node; the first bundled-Node attempt used the wrong fixture cwd and failed, retained separately. Actual About focused source suite passed10/10. Workspace suite passed53/53. Managed OWASP boundary suite passed39. These source/transport results do not establish full product security or actual r3 installation.
- Exact r3 installed VM Update, new Workspace native picker/live project registration and authenticated API/report receipt remain pending. The existing baseline updater failed before replacement, with both sessions and all5messages unchanged. No installed-file, marker, PATH, ACL, authentication or update-journal patch was used. Owner permission was requested for a one-time ordinary Keep-my-data recovery because the requested Update route cannot repair its old launcher; no program removal or data deletion has been performed while that answer is pending.
- Delivery/evidence: `C:\Users\eiman\Documents\Codex\2026-10-14\bi\outputs\approved-maintenance-workspace-r3-20261020T171041Z\DELIVERY_REPORT.md` and its validation-evidence directory. Before-edit backup and previous EXEs remain unchanged. No merge/push/deploy/publication or owner/customer host installation. The maintenance Temp residue, skipped symlink test, unsigned release, unqualified key recovery/rotation, unpublished feed and full security/airgap qualification limits remain explicit.

### Corrected clean VM handoff after Owner clarification

The first handoff only took a preservation snapshot; it did not restore clean Windows. Following the Owner correction, clean snapshot `63e33ca3-e6bb-442f-882e-edd86185cee3` was actually restored. Read-only guest checks before owner installation confirmed no Youtab install root, no uninstall registration and zero Youtab processes. Exact r3 EXE SHA256 `9D23A491BEC36B835D1119F30AE81FA12EA5D3938A5B7783A181451F1E777348` and signed descriptor were copied to guest `C:/Users/vmtest/Desktop/Youtab-USB-r3`; hashes matched. The Owner will install and test; the agent did not execute this Installer. Prior chats remain in preservation snapshot `8e620fed-b0d7-474c-835e-a8d4a8764fd3` and the verified independent two-session/five-message backup. This is a clean handoff, not installation/Update PASS. Delivery evidence: `post-build-evidence/CLEAN_VM_OWNER_HANDOFF_R3.json` and `VM_CLEAN_OWNER_R3_USB_READY.png`. This roadmap update is post-build documentation, outside the frozen source archive.
