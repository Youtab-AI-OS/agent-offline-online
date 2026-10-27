# Common Windows customer prerequisites: local implementation evidence

This branch adds uv 0.12.24, CPython 3.11.17 and a reviewed 132-wheel
`all,wake,voice,messaging` closure to the **existing online Runtime ZIP**.
The same `Youtab-Setup.exe` downloads that exact ZIP. There is no second online
Setup or offline Enterprise installer in this change.

The producer compares the archive SHA-256 pins in
`config/windows-private-home-prerequisites.json`, the exact wheel inventory
in `config/windows-customer-wheelhouse.json`, and the hash-locked requirements
against the committed `uv.lock`. The Runtime release packager re-verifies each
file and records the prerequisite manifest SHA-256/count/size in the immutable
release manifest. Customer `install.ps1` validates those bytes before promotion,
uses a local `file:///` catalog for Python, and installs Python dependencies
from the bundled wheelhouse with `--offline --no-index --require-hashes`.
It installs the first-party CLI editable from the verified Runtime tree,
then runs `uv pip check`. Unsupported selected extras fail closed.

## Local evidence

- Pinned uv installed the exact CPython archive from a local `file:///` catalog.
- Fresh venv/cache: 132 dependency packages installed from the local wheelhouse
  with `--offline --no-index --require-hashes`; `uv pip check` passed.
- First-party editable install from a source-layout checkout passed offline;
  the resulting `youtab.exe --version` exited zero and `uv pip check` found
  133 compatible packages. This is **not** a clean customer installation.
- Four producer behavior tests passed: exact inventory, changed wheel refusal,
  unlisted member/source refusal, input hash refusal.
- PowerShell stage-protocol tests passed and the actual prerequisite verifier
  accepted the 135-file staged tree and rejected a wrong source SHA.

## Release blockers

- The managed FFmpeg 9.0.2 input currently obtained from gyan.dev is GPLv3.
  Redistribution notices and source obligations are not cleared. This branch
  does not embed FFmpeg; the current customer `node-deps` stage still downloads
  it, so a restricted network may fail. Playwright's bundled FFmpeg is a
  separate browser helper and is not substituted for the managed codec.
- Third-party notices for uv, standalone Python and all wheels require a
  complete redistribution audit. Hash verification proves bytes, not license
  compliance or source trust.
- The first-party Runtime still has readable source in the customer ZIP;
  compiled private-core packaging is separate work.
- No fresh Windows x64 non-admin Setup installation, About Update, rollback,
  two-device sync, or customer CLI E2E has passed on this branch.

Therefore this branch is a local prerequisite implementation, **not** a
customer-ready or Stable release qualification.
