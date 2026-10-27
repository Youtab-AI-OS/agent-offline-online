import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildCommonWindowsFullUninstallScript, cancelUninstallHelper, type CommonWindowsUninstallInput, commonWindowsUninstallPlan, powershellInlineInput, waitForUninstallReady, WINDOWS_OWNED_TREE_FUNCTIONS } from './windows-full-uninstall'
import { WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS } from './windows-uninstall-gateway-processes'
import { WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS } from './windows-uninstall-resources'

const installation: CommonWindowsUninstallInput = {
  packaged: true, managedContract: true,
  agentRoot: 'C:\\Users\\Tester\\Youtab\\youtab-agent-runtime',
  youtabHome: 'C:\\Users\\Tester\\Youtab',
  executable: 'C:\\Users\\Tester\\Youtab\\youtab-agent-runtime\\apps\\desktop\\release\\win-unpacked\\Youtab.exe',
  userData: 'C:\\Users\\Tester\\AppData\\Roaming\\Youtab',
  appData: 'C:\\Users\\Tester\\AppData\\Roaming', userProfile: 'C:\\Users\\Tester', windowsDirectory: 'C:\\Windows', desktopPid: 123
}
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const encoded = (value: string) => Buffer.from(value, 'utf16le').toString('base64')
const runPowerShell = (script: string) => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '-'], {input:powershellInlineInput(script),encoding:'utf8', windowsHide:true, timeout:10000})

describe('common Windows full-uninstall scope', () => {
  it.runIf(process.platform==='win32')('executes the composed native function bundle through the actual stdin framing', () => {
    expect(runPowerShell(WINDOWS_OWNED_TREE_FUNCTIONS + '\n' + WINDOWS_UNINSTALL_RESOURCE_FUNCTIONS + '\n' +
      WINDOWS_UNINSTALL_GATEWAY_FUNCTIONS + "\nInitialize-YoutabGatewayNative\n'COMPOSED_FUNCTIONS_OK'")).toContain('COMPOSED_FUNCTIONS_OK')
  })
  it('binds the verified common layout and scoped Desktop data to its registered uninstaller', () => {
    expect(commonWindowsUninstallPlan(installation)).toMatchObject({installRoot:installation.youtabHome, userData:installation.userData, uninstaller:'C:\\Users\\Tester\\Youtab\\unins000.exe',desktopPid:123})
  })
  it.each([{packaged:false},{managedContract:false},{agentRoot:'C:\\other\\runtime'}, {executable:'C:\\other\\Youtab.exe'}, {userData:'C:\\Users\\Tester\\Documents'}, {desktopPid:0}, {youtabHome:'\\\\server\\share'}])('refuses unverified or out-of-scope removal %j', override => {
    expect(()=>commonWindowsUninstallPlan({...installation,...override})).toThrow()
  })
  it('refuses shared user/system roots even when an apparent layout exists there', () => {
    for (const root of ['C:\\Users\\Tester','C:\\Windows','C:\\Users\\Tester\\Desktop','C:\\Users','C:\\Program Files','C:\\Windows\\synthetic-app']) {
      expect(()=>commonWindowsUninstallPlan({...installation,youtabHome:root,agentRoot:path.win32.join(root,'youtab-agent-runtime'),executable:path.win32.join(root,'youtab-agent-runtime/apps/desktop/release/win-unpacked/Youtab.exe')})).toThrow(/shared|system/)
    }
  })
  it('accepts install-scoped custom userdata without widening to arbitrary directories', () => {
    expect(commonWindowsUninstallPlan({...installation,userData:installation.youtabHome+'\\desktop-data'}).userData).toContain('desktop-data')
    expect(()=>commonWindowsUninstallPlan({...installation,userData:installation.youtabHome+'-neighbor'})).toThrow()
  })
  it.runIf(process.platform==='win32')('generates valid PowerShell without executing the uninstall plan', () => {
    const plan=commonWindowsUninstallPlan(installation)
    const text=buildCommonWindowsFullUninstallScript(plan, {directory:'C:\\Temp\\youtab-synthetic-handoff',token:'synthetic'})
    const source=Buffer.from(text,'utf8').toString('base64')
    const output=runPowerShell(`$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'));$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};'PARSE_OK'`)
    expect(output).toContain('PARSE_OK')
  })
  it.runIf(process.platform==='win32')('removes every synthetic owned file while preserving outside files and junction targets', () => {
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'youtab-full-uninstall-test-'))
    const temp=path.resolve(os.tmpdir())+path.sep
    expect(path.resolve(fixture).startsWith(temp)).toBe(true)
    expect(path.basename(fixture).startsWith('youtab-full-uninstall-test-')).toBe(true)
    const owned=path.join(fixture,'owned'),outside=path.join(fixture,'outside')
    fs.mkdirSync(path.join(owned,'nested'),{recursive:true});fs.mkdirSync(outside)
    fs.writeFileSync(path.join(owned,'nested','state.db'),'synthetic')
    fs.writeFileSync(path.join(owned,'readonly.txt'),'synthetic');fs.chmodSync(path.join(owned,'readonly.txt'),0o444)
    fs.writeFileSync(path.join(outside,'must-remain.txt'),'outside synthetic fixture')
    fs.symlinkSync(outside,path.join(owned,'outside-link'),'junction')
    try {
      const values=Buffer.from(JSON.stringify({owned,outside}),'utf8').toString('base64')
      const output=runPowerShell(`$ErrorActionPreference='Stop';${WINDOWS_OWNED_TREE_FUNCTIONS};$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${values}'))|ConvertFrom-Json;Assert-NoReparseAncestors $v.owned;Remove-YoutabOwnedTree -Target $v.owned -Boundary $v.owned;if(Test-Path -LiteralPath $v.owned){throw 'Owned root remains'};'CLEAN_OK'`)
      expect(output).toContain('CLEAN_OK');expect(fs.existsSync(owned)).toBe(false)
      expect(fs.readFileSync(path.join(outside,'must-remain.txt'),'utf8')).toBe('outside synthetic fixture')
    } finally {
      // This test-created absolute root was checked above; no real install/home.
      fs.rmSync(fixture,{recursive:true,force:true})
    }
  })
  it.runIf(process.platform==='win32')('refuses a reparse root and an outside-boundary deletion before touching data', () => {
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'youtab-full-uninstall-test-'))
    expect(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true)
    const outside=path.join(fixture,'owned-neighbor'),link=path.join(fixture,'link'),owned=path.join(fixture,'owned')
    fs.mkdirSync(outside);fs.mkdirSync(owned);fs.writeFileSync(path.join(outside,'keep.txt'),'keep')
    fs.symlinkSync(outside,link,'junction')
    try {
      const values=Buffer.from(JSON.stringify({outside,link,owned}),'utf8').toString('base64')
      const output=runPowerShell(`$ErrorActionPreference='Stop';${WINDOWS_OWNED_TREE_FUNCTIONS};$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${values}'))|ConvertFrom-Json;$denied=0;try{Assert-NoReparseAncestors $v.link}catch{$denied++};try{Remove-YoutabOwnedTree -Target $v.outside -Boundary $v.owned}catch{$denied++};if($denied-ne 2){throw 'Expected both removals denied'};'DENIED_OK'`)
      expect(output).toContain('DENIED_OK');expect(fs.readFileSync(path.join(outside,'keep.txt'),'utf8')).toBe('keep')
    } finally {fs.rmSync(fixture,{recursive:true,force:true})}
  })
  it.runIf(process.platform==='win32')('accepts only the exact current registered location and uninstaller command', () => {
    const values=Buffer.from(JSON.stringify({root:installation.youtabHome,exe:commonWindowsUninstallPlan(installation).uninstaller}),'utf8').toString('base64')
    const script = "$ErrorActionPreference='Stop';" + WINDOWS_OWNED_TREE_FUNCTIONS +
      ";$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + values + "'))|ConvertFrom-Json;" +
      "Assert-YoutabUninstallRegistration $v.root $v.exe ($v.root+[char]92) ('\"'+$v.exe+'\"');" +
      "$denied=0;foreach($location in @('',($v.root+'-neighbor'))){try{Assert-YoutabUninstallRegistration $v.root $v.exe $location $v.exe}catch{$denied++}};" +
      "foreach($command in @('',($v.exe+' /fake'),($v.exe+'-other'))){try{Assert-YoutabUninstallRegistration $v.root $v.exe $v.root $command}catch{$denied++}};" +
      "if($denied-ne 5){throw 'Expected all mismatched registrations denied'};'REGISTRATION_OK'"
    expect(runPowerShell(script)).toContain('REGISTRATION_OK')
  })
  it.runIf(process.platform==='win32')('accepts a long inline command through stdin without changing execution policy', () => {
    expect(runPowerShell("$unused='" + 'synthetic'.repeat(5000) + "';'STDIN_OK'")).toContain('STDIN_OK')
  })
  it('waits for the matching helper acknowledgement, not just a successful process spawn', async () => {
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'youtab-full-uninstall-test-'))
    expect(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true)
    const handoff={directory:fixture,token:'synthetic-ready'}
    const child=spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],process.argv[2]),75);setTimeout(()=>{},3000)",path.join(fixture,'ready'),handoff.token],{windowsHide:true,stdio:'ignore'})
    try {await expect(waitForUninstallReady(child,handoff,2000)).resolves.toBeUndefined()}
    finally {child.kill();fs.rmSync(fixture,{recursive:true,force:true})}
  })
  it('refuses a process that exits without acknowledgement', async () => {
    const child=spawn(process.execPath,['-e','process.exit(1)'],{windowsHide:true,stdio:'ignore'})
    await expect(waitForUninstallReady(child,{directory:os.tmpdir(),token:'synthetic-never-ready'},2000)).rejects.toThrow(/exited/)
  })
  it('waits for the stopped acknowledgement separately from read-only readiness', async () => {
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'youtab-full-uninstall-test-'))
    expect(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true)
    const handoff={directory:fixture,token:'two-phase-synthetic'}
    const child=spawn(process.execPath,['-e',"const fs=require('node:fs'),p=require('node:path'),d=process.argv[1],t=process.argv[2];fs.writeFileSync(p.join(d,'ready'),t);setTimeout(()=>fs.writeFileSync(p.join(d,'stopped'),t),150);setTimeout(()=>{},3000)",fixture,handoff.token],{windowsHide:true,stdio:'ignore'})
    try {
      await waitForUninstallReady(child,handoff,2000)
      await waitForUninstallReady(child,handoff,2000,'stopped')
      expect(fs.readFileSync(path.join(fixture,'stopped'),'utf8')).toBe(handoff.token)
    } finally {child.kill();fs.rmSync(fixture,{recursive:true,force:true})}
  })
  it('allows an aborted helper to restore its synthetic state before it is closed', async () => {
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'youtab-full-uninstall-test-'))
    expect(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true)
    const handoff={directory:fixture,token:'synthetic-cancel'}
    const child=spawn(process.execPath,['-e',"const fs=require('node:fs'),p=require('node:path'),d=process.argv[1],t=process.argv[2];setInterval(()=>{try{if(fs.readFileSync(p.join(d,'cancel'),'utf8')===t){fs.writeFileSync(p.join(d,'restored'),'yes');process.exit(0)}}catch{}},25)",fixture,handoff.token],{windowsHide:true,stdio:'ignore'})
    try {
      await cancelUninstallHelper(child,handoff)
      expect(child.exitCode).toBe(0)
      expect(fs.readFileSync(path.join(fixture,'restored'),'utf8')).toBe('yes')
    } finally {child.kill();fs.rmSync(fixture,{recursive:true,force:true})}
  })
  it('retains the actual preflight failure when the helper exits before acknowledgement', async () => {
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'youtab-full-uninstall-test-'))
    expect(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true)
    const reason='Named Youtab profiles require explicit service/alias cleanup before full removal.'
    const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],process.argv[2]);process.exit(1)",path.join(fixture,'failure.log'),reason],{windowsHide:true,stdio:'ignore'})
    try {await expect(waitForUninstallReady(child,{directory:fixture,token:'never-ready'},2000)).rejects.toThrow(reason)}
    finally {child.kill();fs.rmSync(fixture,{recursive:true,force:true})}
  })
  it('keeps a ready helper alive to finish rollback after the bounded acknowledgement wait', async () => {
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'youtab-full-uninstall-test-'))
    expect(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true)
    const handoff={directory:fixture,token:'synthetic-slow-rollback'}
    const script="const fs=require('node:fs'),p=require('node:path'),d=process.argv[1],t=process.argv[2];fs.writeFileSync(p.join(d,'ready'),t);const timer=setInterval(()=>{try{if(fs.readFileSync(p.join(d,'cancel'),'utf8')===t){clearInterval(timer);setTimeout(()=>{fs.writeFileSync(p.join(d,'restored'),'yes');process.exit(0)},250)}}catch{}},25)"
    const child=spawn(process.execPath,['-e',script,fixture,handoff.token],{windowsHide:true,stdio:'ignore'})
    try {
      await waitForUninstallReady(child,handoff,2000)
      expect(await cancelUninstallHelper(child,handoff,30)).toBe(false)
      expect(child.exitCode).toBeNull()
      await new Promise<void>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Synthetic rollback did not finish')),2000)
        child.once('exit',()=>{clearTimeout(timeout);resolve()})
      })
      expect(child.exitCode).toBe(0)
      expect(fs.readFileSync(path.join(fixture,'restored'),'utf8')).toBe('yes')
    } finally {child.kill();fs.rmSync(fixture,{recursive:true,force:true})}
  })
})
