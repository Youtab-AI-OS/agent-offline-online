"""Actual Windows PowerShell dependency guards; synthetic homes and no download."""
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


@pytest.mark.skipif(os.name != "nt", reason="Actual Windows PowerShell installer contract")
def test_managed_codec_installer_failure_and_directory_guards(tmp_path):
    root = Path(__file__).resolve().parents[2]
    helper = root / "scripts/install-managed-ffmpeg.ps1"
    command = r'''
$ErrorActionPreference='Stop'
. $args[0]
$root = $args[1]
$spec = [pscustomobject]@{version='9.0.2-essentials_build';url='https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip';archive_sha256='60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba';directory='native/managed-dependencies/ffmpeg';files=[pscustomobject]@{'bin/ffmpeg.exe'=[pscustomobject]@{size=1;sha256='synthetic'};LICENSE=[pscustomobject]@{size=1;sha256='synthetic'};'README.txt'=[pscustomobject]@{size=1;sha256='synthetic'}}}
function Get-YoutabManagedCodecSpec { param($RuntimeRoot); return $spec }
function Receive-YoutabManagedCodecArchive { param($Url,$Destination); [IO.File]::WriteAllText($Destination,'tampered-archive') }
$denied=$false
try { Install-YoutabManagedCodec -RuntimeRoot $root } catch { $denied=$_.Exception.Message -match 'archive integrity' }
if (-not $denied) { throw 'Tampered archive was not refused' }
$parent=Join-Path $root 'native/managed-dependencies'
if (Test-Path -LiteralPath (Join-Path $parent 'ffmpeg')) { throw 'Failed input was promoted' }
if (@(Get-ChildItem -LiteralPath $parent -Force | Where-Object Name -Like '.ffmpeg-acquire-*').Count) { throw 'Failed input leaked owned work' }
$outside=Join-Path (Split-Path -Parent $root) 'outside'
New-Item -ItemType Directory -Path $outside | Out-Null
$sentinel=Join-Path $outside 'sentinel'
[IO.File]::WriteAllText($sentinel,'keep')
New-Item -ItemType Junction -Path (Join-Path $parent 'ffmpeg') -Target $outside | Out-Null
$denied=$false
try { Install-YoutabManagedCodec -RuntimeRoot $root } catch { $denied=$_.Exception.Message -match 'redirect' }
if (-not $denied -or [IO.File]::ReadAllText($sentinel) -ne 'keep') { throw 'Directory redirect was not safely refused' }
'INSTALLER_FAILURE_GUARDS=PASS'
'''
    script = tmp_path / "failure-guards.ps1"
    script.write_text(command, encoding="utf-8")
    synthetic = tmp_path / "runtime"
    synthetic.mkdir()
    executable = Path(os.environ["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-File", str(script), str(helper), str(synthetic)], capture_output=True, encoding="utf-8", errors="replace", timeout=30, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "INSTALLER_FAILURE_GUARDS=PASS" in result.stdout


@pytest.mark.skipif(os.name != "nt", reason="Actual Windows .NET HTTP stream contract")
def test_codec_transport_refuses_redirect_size_and_stalled_body(tmp_path):
    completed = threading.Event()
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/followed")
            else:
                self.send_response(200)
                self.send_header("Content-Length", "134217729" if self.path == "/too-big" else "10")
            self.end_headers()
            self.wfile.flush()
            if self.path == "/stall":
                completed.wait(10)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = Path(__file__).resolve().parents[2]
    executable = Path(os.environ["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    script = tmp_path / "transport.ps1"
    script.write_text(r'''
param($Helper,$Base,$Destination)
$ErrorActionPreference='Stop'
. $Helper
foreach ($route in @('redirect','too-big','stall')) {
    $denied=$false
    try { Receive-YoutabManagedCodecArchive -Url ($Base+'/'+$route) -Destination (Join-Path $Destination ($route+'.part')) -DeadlineMs 500 }
    catch { $denied=$true }
    if (-not $denied) { throw ('Unsafe transport completed: '+$route) }
}
'TRANSPORT_GUARDS=PASS'
''', encoding="utf-8")
    try:
        result = subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-File", str(script), str(root / "scripts/install-managed-ffmpeg.ps1"), f"http://127.0.0.1:{server.server_port}", str(tmp_path)], capture_output=True, encoding="utf-8", errors="replace", timeout=20, check=False)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "TRANSPORT_GUARDS=PASS" in result.stdout
        assert requests == ["/redirect", "/too-big", "/stall"]
    finally:
        completed.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
