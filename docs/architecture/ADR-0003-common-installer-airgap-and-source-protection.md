# ADR 0003: Common Installer, organizational Air-gap and source protection

Status: proposed architecture; Owner requirements recorded; not implemented
offline delivery or release approval. Related: ADR-0001, ADR-0002 and
`YOUTAB_AGENT_RUNTIME_BOUNDARY.md`.

Owner sequencing update, 2026-10-05: first finish the existing common Installer
and About Update with all current technical/security and real acceptance gates.
Implement the compiled/offline/Enterprise capabilities in this ADR only after
that release is accepted. See `../roadmap/COMMON_INSTALLER_DELIVERY_ROADMAP.md`.
This proposal must not expand the first release into an Air-gap implementation.

Owner clarification, 2026-10-14: customer delivery of the common online Setup
must not contain readable private first-party core. This source-protection
requirement is now a Phase 1 customer handoff gate. The organization-only
Air-gap installer, internal Brain and local-model delivery remain later work.
The current source-layout ZIP fails the Phase 1 source-protection gate; a
small compiled-module proof does not authorize filtering files from it.

## Context

The Owner requires one common Installer/release for supported PCs and laptops,
organizational installation and operation without internet, use of the
organization's local model, no readable private first-party source in customer
delivery, and mandatory OWASP Top 10 and Smoke qualification.

Local source candidate 003178f4 is not an Air-gap package. Its install script
downloads Runtime/dependencies and builds Desktop; its Runtime ZIP carries
readable implementation. Local-model provider support does not close these gaps.

## Proposed decision

Keep one platform-specific Setup and identical qualified product binaries.
Pilot/Stable choose release maturity; online/organization-only deployment
policy chooses allowed services. Do not create a different product per device.
An offline delivery bundle includes the same product bytes plus verified
prebuilt dependencies. Installation must not need customer build tools or
public package managers. The organization may supply its own compatible model.

Keep the one governed Brain inside the organization in Air-gap deployments.
Runtime does not self-authorize effects or become a second Brain. Preserve
signed unexpired tenant/task envelopes, replay protection, shared budgets,
effect authorization and MemoryBus governance. Internal identity/sync require
their own qualification; public login, telemetry, entitlement renewal and
cloud history sync cannot be mandatory offline dependencies.

Compile private implementation and exclude readable private source, source
maps, private keys, internal build reports and debug material. Preserve approved
user configuration/instructions, user data, extensions and third-party notices.
Compilation does not make logic or embedded prompts unrecoverable by a host
administrator. Encryption at rest is for data protection, not a guarantee
that executable code cannot be inspected while running. Do not blanket-encrypt
user files or silently enable whole-disk encryption/change recovery keys.

Use existing OS-backed secret protection where applicable; do not embed a
shared decryption key in Setup. Organizational key backup/rotation/recovery
and device migration must be designed before extending secret formats.
Existing secrets and chats must remain recoverable through supported migration.

Offline transport can be approved removable media, a file copied before
isolation, or an organization's internal mirror/share. USB is not required.
Authenticate signed packages using independently provisioned trust, verify
hashes and source identity, and preserve the common Runtime/Setup transaction
and rollback. A supplied SHA alone is not publisher authentication.

## Qualification and current implementation boundary

Current Stable promotion additionally requires explicit Owner-reviewed
attestations bound to the same source/Runtime/Setup hashes for `owasp_top10`,
`smoke` and `full_security`. Missing/false or
non-boolean values reject promotion before changing discovery. These records
are not automated proof: preserve and inspect real reports before approving.
Synthetic promotion tests do not qualify the product itself.

The later compiled/offline release needs its own qualified source-exposure,
offline-install/update, local-model and package-signature evidence. The earlier
attempt to make those capabilities prerequisites of the first common-Installer
release is superseded by the Owner's explicit sequencing instruction.

Actual clean-host acceptance must deny external connectivity before starting
Setup, install all required dependencies without caches/downloads/builds, run
local inference and a governed tool call, reject invalid/expired/replayed tasks,
restart, review/download generated files, preserve all history/timestamps, and
update/rollback via authenticated offline media or internal delivery. Test
capability parity after compilation and confirm no mandatory public requests.

Current code only strengthens Stable qualification. Compiled delivery,
offline Setup/About integration, inside-organization Brain provisioning,
artifact exposure checks, signing and actual Air-gap acceptance remain work.
Current CodeQL failures are not waived. No publication or installed-device
change follows from this ADR.
