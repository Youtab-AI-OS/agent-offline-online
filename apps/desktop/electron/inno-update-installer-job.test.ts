import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { INNO_UPDATE_INSTALLER_JOB_FUNCTIONS } from './inno-update-installer-job'

const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

const commandShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64')
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-installer-job-'))

  const verify = () => {
    if (
      !path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(base).startsWith('youtab-installer-job-')
    )
      {throw new Error('Fixture escaped temporary boundary')}
  }

  return {
    base,
    dispose() {
      verify()
      fs.rmSync(base, { recursive: true, force: true })
    }
  }
}

function run(base: string, body: string) {
  const source = `$ErrorActionPreference='Stop'\n$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')\n${INNO_UPDATE_INSTALLER_JOB_FUNCTIONS}\n$base=${literal(base)}\n$testPowerShell=${literal(powershell)}\n${body}\nif(-not (Test-YoutabInstallerJobsDrained)) {throw 'Synthetic fixture left an uncertain private job.'}\n'INSTALLER_JOB_FIXTURE_OK'`

  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: `& {\ntry {\n${source}\n} catch {[Console]::Error.WriteLine($_.Exception.ToString());exit 1}\n}\n\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 45000,
    maxBuffer: 1024 * 1024
  })

  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stdout, result.stderr).toContain('INSTALLER_JOB_FIXTURE_OK')
}

describe.runIf(process.platform === 'win32')(
  'bounded native private Installer Job (system fixture processes only)',
  () => {
    it('returns exactly one Int32 exit code and preserves a copied system EXE path containing spaces', () => {
      const f = fixture()

      try {
        const spaced = path.join(f.base, 'fixture executable with spaces.exe')
        fs.copyFileSync(commandShell, spaced)
        run(
          f.base,
          String.raw`
$result=@(Invoke-YoutabBoundedInstaller ${literal(spaced)} @('/d','/c','exit 9') 5000)
if($result.Count -ne 1 -or $result[0] -isnot [int] -or $result[0] -ne 9) {throw ('Native exit code was not exact: '+($result|ConvertTo-Json -Compress))}
`
        )
      } finally {
        f.dispose()
      }
    })

    it('preserves quoted text/backslashes in an actual system PowerShell command argument', () => {
      const f = fixture()

      try {
        const marker = path.join(f.base, 'quoted marker with spaces.txt')
        const value = 'a "quoted" text \\ trailing\\'
        const script = `[IO.File]::WriteAllText(${literal(marker)},${literal(value)});exit 7`
        run(
          f.base,
          String.raw`
$result=@(Invoke-YoutabBoundedInstaller $testPowerShell @('-NoProfile','-NonInteractive','-Command',${literal(script)}) 5000)
if($result.Count -ne 1 -or $result[0] -ne 7) {throw 'Quoted command failed.'}
if([IO.File]::ReadAllText(${literal(marker)}) -cne ${literal(value)}) {throw 'Windows native quoting changed arguments.'}
`
        )
      } finally {
        f.dispose()
      }
    })

    it('roundtrips empty, tab, quote and trailing-slash logical arguments through Windows argv parsing', () => {
      const f = fixture()

      try {
        run(
          f.base,
          String.raw`
Initialize-YoutabInstallerJobNative
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class YoutabJobFixtureArgv {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CommandLineToArgvW(string value,out int count);
 [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr memory);
 public static string[] Parse(string value) {int count;IntPtr pointer=CommandLineToArgvW(value,out count);if(pointer==IntPtr.Zero)throw new Exception("argv parse failed");try{var result=new string[count];for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size));return result;}finally{LocalFree(pointer);}}
}
'@ -ErrorAction Stop
$logical=@('fixture.exe','','with space',("with"+[char]9+" tab"),'with"quote','trailing\','both\"quote\')
$line=($logical|ForEach-Object {[YoutabInstallerJobNative]::QuoteArgument($_)})-join ' '
$actual=[YoutabJobFixtureArgv]::Parse($line)
if($actual.Count -ne $logical.Count) {throw 'Argument count changed.'}
for($i=0;$i -lt $logical.Count;$i++) {if($actual[$i] -cne $logical[$i]) {throw 'Argument bytes changed.'}}
`
        )
      } finally {
        f.dispose()
      }
    })

    it('waits for a descendant after its parent exits instead of acknowledging early', () => {
      const f = fixture()

      try {
        const marker = path.join(f.base, 'descendant-finished.txt')
        const childScript = `Start-Sleep -Milliseconds 900;[IO.File]::WriteAllText(${literal(marker)},'finished')`
        const parentScript = `$info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=${literal(powershell)};$info.Arguments='-NoProfile -NonInteractive -EncodedCommand ${encoded(childScript)}';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$child=[Diagnostics.Process]::Start($info);$child.Dispose();exit 0`
        run(
          f.base,
          String.raw`
$watch=[Diagnostics.Stopwatch]::StartNew()
$result=Invoke-YoutabBoundedInstaller $testPowerShell @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded(parentScript)}') 10000
if($result -ne 0 -or -not [IO.File]::Exists(${literal(marker)}) -or $watch.ElapsedMilliseconds -lt 800) {throw 'Descendant was acknowledged before it drained.'}
`
        )
      } finally {
        f.dispose()
      }
    })

    it('timeout drains all owned descendants while an independent owned neighbor survives', async () => {
      const f = fixture()

      const neighbor = spawn(
        powershell,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded('Start-Sleep -Seconds 30')],
        { windowsHide: true, stdio: 'ignore' }
      )

      const neighborDone = new Promise<void>(resolve => neighbor.once('exit', () => resolve()))

      try {
        const childPid = path.join(f.base, 'child.pid')
        const marker = path.join(f.base, 'must-not-finish.txt')
        const childScript = `[IO.File]::WriteAllText(${literal(childPid)},[string]$PID);Start-Sleep -Seconds 20;[IO.File]::WriteAllText(${literal(marker)},'incorrect')`
        const parentScript = `$info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=${literal(powershell)};$info.Arguments='-NoProfile -NonInteractive -EncodedCommand ${encoded(childScript)}';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$child=[Diagnostics.Process]::Start($info);$child.Dispose();Start-Sleep -Seconds 20`
        run(
          f.base,
          String.raw`
$timedOut=$false
try {[void](Invoke-YoutabBoundedInstaller $testPowerShell @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded(parentScript)}') 2500)}catch{$timedOut=$_.Exception.ToString().Contains('YOUTAB_INSTALLER_TIMEOUT')}
if(-not $timedOut) {throw 'Timed out fixture was not refused after draining.'}
if(-not [IO.File]::Exists(${literal(childPid)})) {throw 'Descendant fixture never started.'}
$ownedPid=[int][IO.File]::ReadAllText(${literal(childPid)})
if(Get-Process -Id $ownedPid -ErrorAction SilentlyContinue) {throw 'Private-job descendant was still running after timeout returned.'}
if([IO.File]::Exists(${literal(marker)})) {throw 'Killed descendant continued writing.'}
`
        )
        expect(neighbor.exitCode).toBeNull()
        expect(neighbor.signalCode).toBeNull()
      } finally {
        if (neighbor.exitCode === null) {neighbor.kill()}
        await neighborDone
        f.dispose()
      }
    })

    it.each([0, -1, 600001])('rejects invalid timeout %s before launching any process', timeout => {
      const f = fixture()

      try {
        run(
          f.base,
          String.raw`
$denied=$false
try {[void](Invoke-YoutabBoundedInstaller $testPowerShell @('-NoProfile','-NonInteractive','-Command','exit 0') ${timeout})}catch{$denied=$true}
if(-not $denied) {throw 'Invalid timeout was accepted.'}
`
        )
      } finally {
        f.dispose()
      }
    })

    it('rejects missing/relative executable, NUL argument and oversized native argv', () => {
      const f = fixture()

      try {
        run(
          f.base,
          String.raw`
foreach($case in @(
  {Invoke-YoutabBoundedInstaller ([IO.Path]::Combine($base,'absent.exe')) @() 1000},
  {Invoke-YoutabBoundedInstaller 'powershell.exe' @() 1000},
  {Invoke-YoutabBoundedInstaller 'C:relative.exe' @() 1000},
  {Invoke-YoutabBoundedInstaller $testPowerShell @("bad$([char]0)argument") 1000},
  {Invoke-YoutabBoundedInstaller $testPowerShell @(('x'*33000)) 1000}
)) {
  $denied=$false;try {[void](& $case)}catch{$denied=$true}
  if(-not $denied) {throw 'Unsafe native process input was accepted.'}
}
`
        )
      } finally {
        f.dispose()
      }
    })
  }
)
