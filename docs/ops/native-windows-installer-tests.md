# Native Windows Installer test prerequisites

Run the repository-owned fixture harness before qualifying a Windows candidate.
First stage the exact Microsoft WebView2 standalone build input on the build
machine; this verifies its pinned SHA-256 and Microsoft Authenticode signature:

~~~powershell
node .\apps\bootstrap-installer\scripts\prepare-webview2.mjs
& .\scripts\test-native-windows.ps1 -Python 'C:\qualified-python\python.exe' -PythonSha256 '<reviewed SHA-256>' -PrivateQaRoot 'C:\owned-disposable-qa' -CargoTargetDir 'D:\owned-cargo-target' -CargoHome 'C:\existing-cargo-home' -RustupHome 'C:\existing-rustup-home'
~~~

The Python executable and both external directories are explicit inputs.
Python must be an approved Windows x64 CPython 3.11, 3.12 or 3.13. An executable
hash and a stdlib-only metadata probe verify that input; this does not qualify
application dependencies or a fresh managed Python distribution.

Prerequisites: Windows 11 or a supported Windows CI runner, Windows PowerShell
5.1, Rust/MSVC C++ build tools and SDK, the bootstrap application's existing
frontend assets, and the Cargo.lock dependency closure already fetched.
The wrapper runs serial offline locked library tests. It never fetches
dependencies or executes the production installer. Development dependency
fetching, including the pinned WebView2 standalone input, belongs to the caller's
reviewed environment. The Microsoft binary is ignored by Git and may be removed
after testing; a future build or test must rerun the preparation command.

The wrapper creates one fresh UUID directory beneath the supplied QA parent
and protects only that new directory for the current identity. It binds
YOUTAB_NATIVE_PRIVATE_QA_ROOT, the explicit test Python, the actual Source,
the two committed PowerShell fixtures, a synthetic home and an absolute
PSModuleAnalysisCachePath. Cargo output stays in the supplied external target.
All process environment values are restored afterwards. Fixture state and its
result are preserved for inspection; this wrapper does not recursively delete.

The stage fixture compares the complete actual installer parameter schema and
executes its real stage decision with synthetic acquisition/registry seams.
The managed-Git fixture keeps its exact admitted-root/UUID/reparse validation.
Its normal seam cases neither download nor execute a production dependency,
and attempted User environment writes fail.

Existing ignored fresh-Python/fresh-PortableGit provisioning tests remain
separate release acceptance gates requiring reviewed locked archives and a
fresh private home. This wrapper does not run or waive them, does not add skips,
and does not turn ordinary unit success into clean-install/Update acceptance.
Record exact commands, source commit, runtime/toolchain inputs, test counts,
existing ignored cases and the preserved fixture result in the qualification
report. Missing prerequisites or test failures must fail the caller's gate.

The existing Windows CI matrix leg calls this wrapper with its setup-python
input and runner-owned directories. Its Cargo dependency prefetch is explicit;
no customer installation, User registry update or production download occurs.

Existing CARGO_HOME and RUSTUP_HOME are explicit admitted inputs captured before
synthetic-home isolation; they are bound and restored with the other process
variables. CI prefetch and test execution use these same roots. Missing cached
toolchain/dependencies fails; this wrapper does not repair it by downloading.
The Python platform must be win-amd64, not merely a 64-bit pointer width.
