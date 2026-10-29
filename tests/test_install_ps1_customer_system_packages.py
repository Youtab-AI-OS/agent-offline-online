"""Customer Setup must never invoke a system package manager for optional tools."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest


INSTALL_PS1 = Path(__file__).resolve().parent.parent / "scripts" / "install.ps1"


@pytest.mark.skipif(os.name != "nt", reason="Requires Windows PowerShell")
def test_customer_system_packages_skip_all_package_managers(tmp_path: Path) -> None:
    shell = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    script = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_INSTALL_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production installer parser errors' }
$definition = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Install-SystemPackages'
}, $true))
if ($definition.Count -ne 1) { throw 'Expected one production system-packages function' }
Invoke-Expression $definition[0].Extent.Text
function Write-Info { param($Message) }
function Write-Success { param($Message) }
function Write-Warn { param($Message) }
function Get-Command { param($Name) if ($Name -in @('winget','choco','scoop')) { $script:ManagerProbes++ }; return $null }
function winget { $script:ManagerCalls++; throw 'winget must not run' }
function choco { $script:ManagerCalls++; throw 'choco must not run' }
function scoop { $script:ManagerCalls++; throw 'scoop must not run' }
$script:CustomerReleaseMode = $true
$script:ManagerProbes = 0; $script:ManagerCalls = 0
Install-SystemPackages
[ordered]@{ managerProbes = $script:ManagerProbes; managerCalls = $script:ManagerCalls;
    hasRipgrep = $script:HasRipgrep; hasFfmpeg = $script:HasFfmpeg;
    skipped = $script:_StageSkippedReason } | ConvertTo-Json -Compress
'''
    env = os.environ.copy()
    env["YT_INSTALL_SCRIPT"] = str(INSTALL_PS1)
    env["HOME"] = str(tmp_path)
    env["USERPROFILE"] = str(tmp_path)
    result = subprocess.run(
        [str(shell), "-NoProfile", "-NonInteractive", "-Command", script],
        env=env, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    outcome = json.loads(result.stdout.strip())
    assert outcome["managerProbes"] == 0
    assert outcome["managerCalls"] == 0
    assert outcome["hasRipgrep"] is False
    assert outcome["hasFfmpeg"] is False
    assert outcome["skipped"] == "Optional system packages are not installed by customer Setup"


@pytest.mark.skipif(os.name != "nt", reason="Requires Windows PowerShell")
def test_customer_node_stage_fails_immediately_without_node() -> None:
    shell = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    script = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:YT_INSTALL_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production installer parser errors' }
$definition = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Stage-Node'
}, $true))
if ($definition.Count -ne 1) { throw 'Expected one production Node stage' }
Invoke-Expression $definition[0].Extent.Text
function Test-Node { $script:HasNode = $false; return $false }
$script:CustomerReleaseMode = $true
$failure = $null
try { Stage-Node } catch { $failure = $_.Exception.Message }
[ordered]@{ error = $failure; skipped = $script:_StageSkippedReason } | ConvertTo-Json -Compress
'''
    env = os.environ.copy()
    env["YT_INSTALL_SCRIPT"] = str(INSTALL_PS1)
    result = subprocess.run(
        [str(shell), "-NoProfile", "-NonInteractive", "-Command", script],
        env=env, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    outcome = json.loads(result.stdout.strip())
    assert "portable download" in outcome["error"]
    assert outcome["skipped"] is None
