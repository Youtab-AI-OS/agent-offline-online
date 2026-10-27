"""Windows behavior checks for the customer's reviewed uv acquisition path."""

import json
import os
from pathlib import Path
import subprocess

import pytest


INSTALL_PS1 = Path(__file__).resolve().parents[1] / "scripts" / "install.ps1"


@pytest.mark.skipif(os.name != "nt", reason="Needs native Windows PowerShell")
@pytest.mark.parametrize("mode", ["fresh", "legacy", "tamper", "legacy-tamper", "cached-forgery", "legacy-receipt-failure", "legacy-installed-hash-failure", "retry", "partial-retry"])
def test_customer_uv_uses_reviewed_archive_before_extraction(tmp_path, mode):
    shell = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    home = tmp_path / "isolated-home"
    home.mkdir()
    if mode.startswith("legacy"):
        (home / "bin").mkdir()
        (home / "bin" / "uv.exe").write_bytes(b"old managed uv")
    if mode == "legacy-receipt-failure":
        (home / "bootstrap-cache" / "private-prerequisites" / "uv-receipt.json").mkdir(parents=True)
    events = tmp_path / "events.txt"
    events.write_text("", encoding="ascii")
    script = r'''
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:YT_INSTALL_SCRIPT,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'production parser error' }
foreach ($name in @('Install-PrivateHomeUv','Stage-Uv','Resolve-UvCmd')) {
  $definitions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))
  if ($definitions.Count -ne 1) { throw "missing function: $name" }
  Invoke-Expression $definitions[0].Extent.Text
}
function Get-PrivateHomePrerequisites {
  $approved=Join-Path $env:YT_TEST_ROOT 'approved.zip'
  [IO.File]::WriteAllText($approved,'approved archive')
  $approvedExe=Join-Path $env:YT_TEST_ROOT 'approved-uv.exe'
  [IO.File]::WriteAllText($approvedExe,'new reviewed uv')
  @{ uv=@{ url='https://example.invalid/reviewed-uv.zip'; sha256=(Get-FileHash -LiteralPath $approved -Algorithm SHA256).Hash.ToLowerInvariant();
      executableSha256=(Get-FileHash -LiteralPath $approvedExe -Algorithm SHA256).Hash.ToLowerInvariant() } }
}
function Invoke-WebRequest {
  param($Uri,$OutFile,[switch]$UseBasicParsing)
  if ($Uri -ne 'https://example.invalid/reviewed-uv.zip') { throw 'unreviewed URL' }
  [IO.File]::AppendAllText($env:YT_TEST_EVENTS,"download`n")
  if ($env:YT_TEST_MODE -like '*tamper') { [IO.File]::WriteAllText($OutFile,'altered archive') }
  else { [IO.File]::Copy((Join-Path $env:YT_TEST_ROOT 'approved.zip'),$OutFile,$true) }
}
function Expand-Archive {
  param($LiteralPath,$DestinationPath)
  [IO.File]::AppendAllText($env:YT_TEST_EVENTS,"extract`n")
  [IO.Directory]::CreateDirectory($DestinationPath) | Out-Null
  if ($env:YT_TEST_MODE -eq 'partial-retry' -and -not $script:PartialExtractFailed) {
    $script:PartialExtractFailed=$true
    [IO.File]::WriteAllText((Join-Path $DestinationPath 'incomplete'),'partial')
    throw 'simulated interrupted extraction'
  }
  [IO.File]::WriteAllText((Join-Path $DestinationPath 'uv.exe'),'new reviewed uv')
}
function Get-FileHash {
  param($LiteralPath,$Algorithm)
  if ($env:YT_TEST_MODE -eq 'legacy-installed-hash-failure' -and $LiteralPath -eq (Join-Path $env:YT_TEST_HOME 'bin\uv.exe')) {
    return [pscustomobject]@{ Hash=('0' * 64) }
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $hash=$sha.ComputeHash([IO.File]::ReadAllBytes($LiteralPath)) }
  finally { $sha.Dispose() }
  [pscustomobject]@{ Hash=([BitConverter]::ToString($hash).Replace('-','')) }
}
$YoutabHome=$env:YT_TEST_HOME
$script:CustomerReleaseMode=$true
$PrivateHomeRelocation=$false
$errorText=$null
try { Stage-Uv } catch { $errorText=$_.Exception.Message }
$uv=Join-Path $YoutabHome 'bin\uv.exe'
if ($env:YT_TEST_MODE -eq 'retry' -and -not $errorText) {
  [IO.File]::WriteAllText($uv,'corrupted after successful install')
  try { Stage-Uv } catch { $errorText=$_.Exception.Message }
}
if ($env:YT_TEST_MODE -eq 'partial-retry' -and $errorText -eq 'simulated interrupted extraction') {
  $errorText=$null
  try { Stage-Uv } catch { $errorText=$_.Exception.Message }
}
$resolve=$null
if (-not $errorText) {
  try { Resolve-UvCmd; $resolve='accepted' } catch { $resolve=$_.Exception.Message }
  if ($env:YT_TEST_MODE -eq 'cached-forgery') {
    [IO.File]::WriteAllText($uv,'malicious replacement')
    $receiptPath=Join-Path $YoutabHome 'bootstrap-cache\private-prerequisites\uv-receipt.json'
    $forged=@{ archiveSha256=(Get-PrivateHomePrerequisites).uv.sha256;
       executableSha256=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText($receiptPath,($forged | ConvertTo-Json))
    try { Resolve-UvCmd; $resolve='forgery accepted' } catch { $resolve=$_.Exception.Message }
  }
}
$legacy=@(Get-ChildItem -LiteralPath (Join-Path $YoutabHome 'bootstrap-cache\private-prerequisites') -Filter 'uv-legacy-*.exe' -ErrorAction SilentlyContinue)
$staging=@(Get-ChildItem -LiteralPath (Join-Path $YoutabHome 'bootstrap-cache\private-prerequisites') -Filter 'uv-extracted-*' -Directory -ErrorAction SilentlyContinue)
@{ error=$errorText; uvContent=$(if ([IO.File]::Exists($uv)) { [IO.File]::ReadAllText($uv) } else { $null });
   backupCount=$legacy.Count; stagingCount=$staging.Count; resolve=$resolve; receipt=([IO.File]::Exists((Join-Path $YoutabHome 'bootstrap-cache\private-prerequisites\uv-receipt.json'))) } | ConvertTo-Json -Compress
'''
    env = os.environ.copy()
    env.update(YT_INSTALL_SCRIPT=str(INSTALL_PS1), YT_TEST_ROOT=str(tmp_path),
               YT_TEST_HOME=str(home), YT_TEST_EVENTS=str(events), YT_TEST_MODE=mode,
               TEMP=str(tmp_path), TMP=str(tmp_path), HOME=str(home), USERPROFILE=str(home))
    result = subprocess.run([str(shell), "-NoProfile", "-NonInteractive", "-Command", script],
                            env=env, capture_output=True, text=True, timeout=20, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    frame = json.loads(result.stdout.strip())
    assert frame["stagingCount"] == 0
    if mode.endswith("tamper") or mode.endswith("failure"):
        if mode.endswith("tamper"):
            assert "checksum mismatch" in frame["error"]
        else:
            assert frame["error"]
        assert frame["uvContent"] == ("old managed uv" if mode.startswith("legacy") else None)
        assert frame["receipt"] is False
        assert frame["backupCount"] == 0
        assert events.read_text(encoding="ascii").splitlines() == (["download"] if mode.endswith("tamper") else ["download", "extract"])
    else:
        assert frame["error"] is None
        if mode == "cached-forgery":
            assert "differs from reviewed executable" in frame["resolve"]
            assert frame["uvContent"] == "malicious replacement"
        else:
            assert frame["resolve"] == "accepted"
            assert frame["uvContent"] == "new reviewed uv"
        assert frame["receipt"] is True
        assert frame["backupCount"] == (1 if mode in ("legacy", "retry") else 0)
        assert events.read_text(encoding="ascii").splitlines() == (["download", "extract"] * 2 if mode in ("retry", "partial-retry") else ["download", "extract"])


@pytest.mark.skipif(os.name != "nt", reason="Needs native Windows PowerShell")
def test_customer_arm64_refused_before_unreviewed_uv_download(tmp_path):
    shell = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    script = r'''
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:YT_INSTALL_SCRIPT,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'production parser error' }
$definition=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-PrivateHomePrerequisites'},$true))
if ($definition.Count -ne 1) { throw 'missing lock function' }
Invoke-Expression $definition[0].Extent.Text
function Get-WindowsArch { 'arm64' }
$script:CustomerReleaseMode=$true
$InstallDir=$env:YT_TEST_ROOT
try { Get-PrivateHomePrerequisites | Out-Null; 'UNSAFE_ACCEPTED' }
catch { $_.Exception.Message }
'''
    env = os.environ.copy()
    env.update(YT_INSTALL_SCRIPT=str(INSTALL_PS1), YT_TEST_ROOT=str(tmp_path),
               HOME=str(tmp_path), USERPROFILE=str(tmp_path), TEMP=str(tmp_path), TMP=str(tmp_path))
    result = subprocess.run([str(shell), "-NoProfile", "-NonInteractive", "-Command", script],
                            env=env, capture_output=True, text=True, timeout=20, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "Reviewed customer prerequisites are available only for Windows x64"
