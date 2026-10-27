# ADR: preserving Windows private-home relocation (conditional draft)

Status: conditionally approved by Owner on 2026-10-09; implementation and regression evidence pending.

Decision: extend the SAME shared Windows x64 common Setup. Do not restart the project or make machine-specific releases. Unsafe current homes remain intact. Install fresh verified product code in an admitted private user-profile target; snapshot existing data without executing source CLI, plugins, skills or source product code. Publish the selected home only after package, data and startup validation.

Source: phase1-common-integrated-candidate-20261008/source; Owner supplied manifest c669c426... (this draft does not infer a complete SHA from that abbreviation).

The existing PrivateCodeNamespace is the target admission authority. Source data need readable retained native handles, not private ACL admission. Source links, hardlinks, aliases, collisions, mutation or active writers are refusal conditions. No source ACL or data is rewritten.

SQLite needs no new dependency: after fresh target venv provisioning, admit venv as a code tree and use its python.exe with -I -S -c importing only stdlib sqlite3. No source Python code, PYTHONPATH or plugin loader participates.

Publication integration must defer install.ps1 path/shortcut effects. Existing registry and shortcut mutation is NOT covered by InstallSwap and must be journaled with previous values and idempotent recovery before enabling relocation. This draft does not perform any real registry, ACL, install, user-data, push or publication operation.

Acceptance requires synthetic transaction/recovery tests, native source/target handle tests, complete consumer discovery tests, unchanged Electron userData and credentials, regression checks of ordinary install/update and independent review. Do not claim regression safety from module tests alone.
