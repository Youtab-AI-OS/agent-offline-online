# ADR-0005: Maintain the Windows PTY output-drain correction

Status: Proposed; local integration and release qualification are pending.

## Context

Phase 1 requires the existing common Windows Installer and runtime to work
before release. Actual cold Windows PTY tests failed because the official
pywinpty 2.0.15 Python transport stopped on process/pipe `iseof` while native
cached output remained unread. A controlled actual-SDK experiment delivered
4096 characters through the original transport, then recovered another 6040
characters including the final marker from the stopped transport's native
cache. Reading until the native read EOF preserved the complete output.

The installed native extension was verified against the official wheel;
embedded build paths identify winpty-rs 0.4.1. No native binary correction is
claimed or introduced. The runtime's process registry also stopped reading
when the child exited and requires its own drain-until-EOF correction.

## Proposed decision

Maintain an explicitly identified `pywinpty==2.0.15+youtab.1` distribution.
Repackage verified official cp311/cp312/cp313 Windows x64 wheels with only the
small reviewed Python transport correction, updated distribution metadata and
regenerated RECORD. Preserve the original native extension and license bytes.
Use the single guarded multi-ABI build recipe and record official input,
patch, output wheel, source, native extension and license hashes.

One common runtime payload includes all supported ABI wheels. Select by the
actual final interpreter, not device identity or the host's CPU label.
Supported interpreters remain CPython 3.11 through 3.13 on Windows x64.
Unsupported interpreters must be refused before dependency installation.

The project pin, universal lock and installer dependency paths must resolve
the same qualified distribution. Explicit relative wheel sources cover
`uv sync`; ordinary pip-compatible paths need the corresponding local wheel
directory and exact pin. Verify the actual installed distribution, module
origin/source and native extension against the selected ABI manifest.
Missing or changed inputs and failed attestation are installation failures.

The process registry drains queued output until actual EOF while retaining
existing output limits, callbacks, cancellation and completion semantics.
Do not replace the original cold I/O tests with easier lifetime fixtures.

## Alternatives

Do not patch global SDK internals at runtime, rewrite source during startup,
silently overwrite an unpatched installation, or duplicate the SDK class.
Switching to the existing alternate backend failed a short-output test.
A major SDK upgrade has not been qualified as a correction.

## Maintenance and exit

Keep the patch, recipe, upstream license, source provenance and regressions
reviewable. An upstream submission requires separate authorization; none has
been made. Replace the local distribution with a reviewed upstream correction
after the same cold, queued-output, Unicode, resize, shutdown, descendant and
shared-consumer tests pass. Remove the local wheels and source mapping in that
same reviewed change, without modifying security baselines.

This narrowly fixes an existing dependency defect. Compiled first-party core,
general prebuilt dependency delivery and Enterprise Air-gap work remain
deferred until Phase 1 acceptance.

## Qualification boundaries

Prototype ABI tests and wheel provenance do not establish installer, complete
security, signing, actual PC/laptop acceptance or release readiness. Final
source review, all required gates and separately authorized Pilot/Stable
acceptance remain required. This ADR does not authorize publication or updates.
