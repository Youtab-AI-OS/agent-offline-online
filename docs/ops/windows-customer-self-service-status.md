# Windows customer Setup qualification (2026-10-13)

The target is one Windows x64 Setup and one source-pinned Runtime ZIP for the
owner's PC, laptop and a new customer test machine. A normal user must be able
to install and use About → Update without a device-specific build, local
compiler, administrator privilege, Youtab Owner action or routine IT action.
Corporate application-control, proxy and SmartScreen policy must be tested on
the actual managed device; this project does not bypass them.

## Current evidence

- The customer stage manifest runs verified repository extraction before uv and
  Python prerequisites. The native PowerShell behavior test checks that order.
- The packaged Node, Browser and TUI are selected ahead of global tools; a
  missing packaged member fails closed. The Desktop stage verifies its image
  and skips npm/packaging on the customer device.
- The customer Python path uses `uv sync --locked --no-build`. A fresh Windows
  venv on D: installed 121 packages with `--extra all --extra wake --extra voice`
  and then 10 messaging packages with `--extra messaging`; both commands exited
  zero. uv built the local pure-Python Youtab project, but no third-party source
  distribution was built. This is a dependency proof, not a Setup install.
- The combined focused assembler, release-package, installer-stage, Browser and
  TUI regression run passed 77 tests. The OWASP deterministic smoke passed 39
  tests with zero network calls. These are scoped gates, not full release
  security qualification.
- An offline candidate was built from clean commit
  `1da368416f15bc8e89f4855a908e3dd89ee3b521`: the shared Setup SHA-256 is
  `2a16450f4c2762ffadbc5f80b45f335a57c6c0e49493869d983870ef0ad1a5eb`;
  the source-pinned Runtime ZIP SHA-256 is
  `6fce561b7571b33fecf3953ff9daa9099b154f0697a4e86e75f3b92662b466c3`.
  The offline producer and package verification passed. Secret scanning found
  zero findings across 9,314 files; deterministic OWASP smoke passed 39 tests
  with zero network calls. The focused Windows regression run found 12 failures
  in a test file that still models on-device Desktop builds; that mismatch is
  being corrected and rerun. This candidate has not been installed on a device.
- The candidate ZIP contains readable Python source and JavaScript source maps.
  A subsequent source change excludes source maps, but the candidate above has
  not been rebuilt from that change and the Python source remains readable.
  Do not provide this ZIP to a customer who requires private core code.

## Still required before customer distribution

1. Finish the regression correction and rebuild one Setup and Runtime ZIP from
   the same new clean, reviewed commit. Recheck the actual packaged members,
   hashes, producer receipts and exact source binding. The `1da368` package
   above is an offline engineering candidate, not a customer release.
2. Run complete SAST, dependency, secret, native, E2E and smoke gates on those
   exact bytes. Strict full-source Semgrep and broad CodeQL remain unresolved;
   earlier focused successes do not override them. The native Setup lease is
   currently hashed and then loaded by path; same-user file replacement between
   those steps is a known local tampering risk and prevents a claim of complete
   tamper resistance for this unsigned user-owned install.
3. Use the same Setup on a clean non-admin Windows account, the owner's PC and
   laptop. Verify first startup, login, model response, tools/Skills/Plugins,
   browser/TUI, preserving migration, About → Update, interruption/rollback and
   account sync. Record the exact Setup and Runtime SHA-256 values.
4. Verify a new tester can register and sign in through the live Portal. Gateway
   API registration exists, but live SMTP, Portal login, hosted agent access and
   organization membership are separate acceptance checks.
5. Confirm self-service behavior on the intended managed company PC. The Setup
   is currently unsigned; a corporate policy or SmartScreen prompt requiring IT
   means the no-IT acceptance case has not passed.
6. Resolve private-core distribution before a company handoff. The current
   Runtime ZIP installs readable `.py` files. Removing source maps helps, but
   does not protect the Python core. Keep internal Pilot testing separate from
   customer distribution until the package and update trust model are reviewed.

No Pilot or Stable publication, device update or customer handoff is certified
by this document.
