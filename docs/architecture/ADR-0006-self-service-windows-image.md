# ADR-0006: Producer-built image for the common Windows Setup

Status: Superseded for Windows update ownership by Owner direction on 2026-10-15; image packaging remains proposed.

## Context

Phase 1 requires one Windows x64 Setup that an ordinary PC, laptop or company
tester can install and update without a per-device Youtab Owner or IT build.
The current artifact path verifies one Runtime ZIP and runs `install.ps1`, but
customer stages still execute `npm ci`, build Electron and may rebuild native
modules. `node-pty` can fall back to `node-gyp`; a clean user machine may lack
MSVC and cannot be treated as a build host. Python, browser and other online
prerequisites also need explicit verification. ADR-0003 reserves fully offline
Enterprise delivery for a later phase.

## Decision

Keep the existing common `Youtab-Setup-<source-sha>.exe`, immutable
`youtab-runtime-<source-sha>.zip`, release sequence and Pilot/Stable channel
pointers. The producer builds and tests the Windows x64 Desktop image and the
Node/browser/TUI runtime payload against the exact committed source and locked
dependencies. Include these explicit payloads in the same Runtime ZIP. The ZIP
hash binds all payload bytes to its immutable manifest; an internal file
manifest binds the extracted image and required native binaries. Do not copy
developer caches, credentials, source maps or unreviewed `node_modules` trees.

The customer artifact path downloads and validates the ZIP, rejects unsafe
entries and incomplete or mismatched image files, and stages the complete code
and application image in the existing sibling install directory. Its Node and
Desktop stages verify the staged payload and create user shortcuts; they do
not run npm, Electron packaging, `electron-rebuild`, `node-gyp` or a global
`agent-browser` install. Development and CLI-only paths may retain their
existing build behavior. The customer Python stage may use the locked online
repository only after complete Windows x64 wheel coverage is proven and source
builds are refused. Portable Node, browser engine and other online inputs must
have fixed versions and independently checked hashes before execution or use.

The existing `InstallSwap` promotes the verified staged directory, retains the
previous install for rollback and preserves user homes, chats, credentials,
configuration, Skills and Plugins. About Update uses the same Setup handoff,
release-sequence check and transaction. Pilot tests the exact bytes later
promoted to Stable; neither channel builds a device-specific app. An immutable
Runtime hash detects modified bytes, but a hash served beside its payload does
not establish publisher authenticity. Signing and release trust remain a
separate qualification gate.

## Consequences and acceptance

The Runtime ZIP becomes larger and producer builds become more expensive.
Customer installation is simpler and does not require MSVC, admin privileges,
winget or an npm build. The producer must prove the packaged Node and Electron
native ABI, browser engine, Python wheels and installed image at a relocated
ordinary-user path; a successful source build alone is insufficient.

Required Pilot evidence includes a clean non-admin install with no customer
compile/npm invocation; actual CLI/Desktop startup, browser, terminal, voice,
tools, agents, Skills, Plugins and MCP behavior; first login and model response;
preservation of all chats and timestamps through migration; About Update,
interruption, rollback and restart. A managed device that requires IT action
because of SmartScreen, proxy, TLS or application-control policy fails the
self-service acceptance case. The current Setup is unsigned and online; this
decision neither bypasses corporate policy nor implements Air-gap operation.

## Alternatives considered

- Build on each customer device: keeps downloads smaller but retains native
  compiler and network failure modes, so it does not meet self-service.
- Embed all product bytes in Setup: removes a download, but forces a new large
  Setup for every update and duplicates the existing Runtime transaction.
- Publish separate Desktop/browser sidecars: can reduce unnecessary downloads,
  but expands manifest, publication and update contracts. Reconsider if the
  combined ZIP exceeds its bounded extraction limits or is operationally too
  large.

This ADR changes the artifact build boundary, not the product's offline or
private-source posture. Implementation, review, security gates and real
installed-device tests remain pending; this ADR authorizes no publication.

2026-10-14 Phase 1 clarification: the Owner also requires the common online
customer ZIP to exclude readable private first-party core. The producer-built
image alone does not achieve this: the current release producer copies source
and the installer performs an editable project install. A supported native
first-party package, replacement of filename-based launches/discovery and a
negative source inventory are additional handoff gates. Air-gap delivery is
still a separate later phase.

## 2026-10-15 Owner revision: installer and updater are separate

The common customer Setup performs installation only. Desktop startup must not require a Setup update or a release-specific Setup helper. About -> Update must use an app-owned updater that checks immutable release metadata and integrity, coordinates with the running backend, preserves user data, and reports rollback/recovery truthfully. A missing or unsafe updater may block an update, but must not by itself block ordinary Desktop startup. This supersedes the Setup handoff decision above; it does not authorize bypassing an active update lock or weakening package authenticity, path admission, rollback, or data preservation. The current Inno 0.19.2 package does not implement this decision and is not customer-qualified.
