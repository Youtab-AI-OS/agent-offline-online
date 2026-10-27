import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Socket } from 'node:net'

import { powershellInlineInput } from './windows-powershell-input'
import type { SetupLease } from './setup-native-lease'

export interface WindowsMaintenanceHelperInput {
  installRoot: string
  handoffDirectory: string
  script: string
  acquireLease: (executable: string, sha256: string, size: number) => SetupLease
  removalRoots?: string[]
}

// PowerShell ignores piped commands with DETACHED_PROCESS. A direct
// non-detached child, meanwhile, belongs to libuv's KILL_ON_JOB_CLOSE job and
// dies with Desktop. This fixed Node broker is detached; its PowerShell child
// is not. The broker therefore survives Desktop and owns the worker's lifetime.
// No command, module or executable is selected through PATH or renderer input.
const BROKER = String.raw`'use strict';
const {spawn}=require('node:child_process');
const {Socket}=require('node:net');
const path=require('node:path');
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const chunks=[];let length=0;let worker;let output=true;let outputLength=0;let cancelled=false;let released=false;let controlInput='';
const control=new Socket({fd:3,readable:true,writable:true});
function cancel(){cancelled=true;if(worker)worker.kill();}
control.on('error',()=>{if(!released)cancel();});
control.on('end',()=>{if(!released)cancel();});
control.on('data',chunk=>{
  controlInput+=chunk.toString('ascii');
  if(controlInput.length>64){cancel();return;}
  let newline;
  while((newline=controlInput.indexOf('\n'))>=0){
    const command=controlInput.slice(0,newline);controlInput=controlInput.slice(newline+1);
    if(command==='release'&&!cancelled){released=true;control.write('released\n');}
    else cancel();
  }
});
process.stdout.on('error',()=>{output=false;if(worker&&worker.stdout)worker.stdout.resume();});
process.stdin.on('error',()=>{process.exitCode=1;});
process.stdin.on('data',chunk=>{length+=chunk.length;if(length>4194304){process.exit(1);}chunks.push(chunk);});
process.stdin.once('end',()=>{
  if(!length){process.exitCode=1;return;}
  if(cancelled){process.exitCode=1;control.destroy();return;}
  worker=spawn(powershell,['-NoProfile','-NonInteractive','-Command','-'],{detached:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
  worker.once('error',()=>{process.exitCode=1;});
  worker.stdout.on('data',chunk=>{outputLength+=chunk.length;if(output&&outputLength<=1048576)process.stdout.write(chunk);});
  worker.stdin.on('error',()=>{});
  worker.stdin.once('finish',()=>worker.stdin.destroy());
  worker.stdin.end(Buffer.concat(chunks,length));
  worker.once('close',(code)=>{control.destroy();process.exitCode=Number.isInteger(code)&&code>=0&&code<=255?code:1;});
});`

const helpers = new WeakMap<ChildProcess, { control: Socket; released: boolean; release?: Promise<void> }>()

/** Explicit, acknowledged lifetime release; it grants no transaction authority. */
export async function releaseWindowsMaintenanceHelper(child: ChildProcess): Promise<void> {
  const state=helpers.get(child)
  // Older and synthetic helper implementations retain their normal lifecycle.
  if (!state) {return}
  if (state.released) {return}
  if (state.release) {return state.release}
  if (child.exitCode!==null||state.control.destroyed) {throw new Error('Maintenance lifetime release is unavailable.')}
  state.release=new Promise<void>((resolve,reject)=>{
    let pending=''
    const cleanup=()=>{
      clearTimeout(timer);state.control.off('data',onData);state.control.off('error',onError);child.off('exit',onExit)
    }
    const fail=(message:string)=>{cleanup();reject(new Error(message))}
    const onData=(chunk:Buffer)=>{
      pending+=chunk.toString('ascii')
      if(pending==='released\n'){
        state.released=true;cleanup();state.control.end();state.control.destroy();resolve()
      } else if(pending.length>64||pending.includes('\n')) {fail('Invalid maintenance lifetime acknowledgement.')}
    }
    const onError=()=>fail('Maintenance lifetime release failed.')
    const onExit=()=>fail('Maintenance helper exited before lifetime release.')
    const timer=setTimeout(()=>fail('Maintenance lifetime acknowledgement was not received.'),5000)
    state.control.on('data',onData);state.control.once('error',onError);child.once('exit',onExit)
    state.control.write('release\n',error=>{if(error)onError()})
  })
  return state.release
}

function noReparseAncestors(value: string): void {
  let current = path.resolve(value)
  while (true) {
    const metadata = fs.lstatSync(current)
    if (metadata.isSymbolicLink()) { throw new Error('Maintenance helper path has a reparse ancestor.') }
    const parent = path.dirname(current)
    if (parent === current) { return }
    current = parent
  }
}

function hashFile(fd: number): string {
  const hash = createHash('sha256')
  const block = Buffer.allocUnsafe(65536)
  let offset = 0
  while (true) {
    const count = fs.readSync(fd, block, 0, block.length, offset)
    if (!count) { return hash.digest('hex') }
    hash.update(block.subarray(0, count)); offset += count
  }
}

/** The private runner cannot hold any program root open during its replacement. */
export function spawnWindowsMaintenanceHelper(input: WindowsMaintenanceHelperInput): ChildProcess {
  if (process.platform !== 'win32' || !path.isAbsolute(input.installRoot) || !path.isAbsolute(input.handoffDirectory)
    || typeof input.acquireLease !== 'function' || !input.script || Buffer.byteLength(powershellInlineInput(input.script), 'utf8') > 4194304) {
    throw new Error('The Windows maintenance helper is unavailable.')
  }
  const parentDirectory=path.dirname(input.handoffDirectory)
  for (const root of [input.installRoot,...input.removalRoots||[]]) {
    if (!path.isAbsolute(root)) {throw new Error('Maintenance removal boundaries must be absolute.')}
    for (const target of [parentDirectory,input.handoffDirectory]) {
      const relative=path.relative(path.resolve(root),path.resolve(target))
      if (!relative||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep))) {
        throw new Error('Maintenance runtime must be outside every program and data removal root.')
      }
    }
  }
  const source = path.join(input.installRoot, 'node', 'node.exe')
  noReparseAncestors(source)
  noReparseAncestors(input.handoffDirectory)
  const sourceMetadata = fs.lstatSync(source)
  if (!sourceMetadata.isFile() || sourceMetadata.size < 1024) { throw new Error('The bundled maintenance runtime is unavailable.') }

  // Keep this separate: full uninstall owns and removes the signal directory.
  const directory = fs.mkdtempSync(path.join(path.dirname(input.handoffDirectory), 'youtab-maintenance-runtime-'))
  const executable = path.join(directory, 'node.exe')
  let sourceFd: number | undefined
  let targetFd: number | undefined
  let sourceLease: SetupLease | undefined
  let runnerLease: SetupLease | undefined
  let copiedIdentity: {dev:number;ino:number} | undefined
  let launched = false
  const cleanupCopy=()=>{
    if(copiedIdentity){
      noReparseAncestors(executable)
      const named=fs.lstatSync(executable)
      if(!named.isFile()||named.dev!==copiedIdentity.dev||named.ino!==copiedIdentity.ino){return}
      fs.unlinkSync(executable)
    }
    fs.rmdirSync(directory)
  }
  try {
    sourceFd = fs.openSync(source, 'r')
    const opened = fs.fstatSync(sourceFd)
    if (!opened.isFile() || opened.dev !== sourceMetadata.dev || opened.ino !== sourceMetadata.ino || opened.size !== sourceMetadata.size) {
      throw new Error('The bundled maintenance runtime changed before admission.')
    }
    const sourceDigest=hashFile(sourceFd)
    sourceLease=input.acquireLease(source,sourceDigest,opened.size)
    targetFd = fs.openSync(executable, 'wx', 0o700)
    const created=fs.fstatSync(targetFd)
    copiedIdentity={dev:created.dev,ino:created.ino}
    const block = Buffer.allocUnsafe(65536)
    let offset = 0
    while (true) {
      const count = fs.readSync(sourceFd, block, 0, block.length, offset)
      if (!count) { break }
      let written = 0
      while (written < count) {
        const size=fs.writeSync(targetFd,block,written,count-written,offset+written)
        if(!size){throw new Error('The private maintenance runtime copy stopped before completion.')}
        written+=size
      }
      offset += count
    }
    fs.fsyncSync(targetFd)
    fs.closeSync(targetFd); targetFd = undefined
    targetFd = fs.openSync(executable, 'r')
    const after = fs.fstatSync(sourceFd)
    const named = fs.lstatSync(source)
    noReparseAncestors(source)
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size
      || fs.fstatSync(targetFd).size !== opened.size || sourceDigest !== hashFile(targetFd)) {
      throw new Error('The private maintenance runtime failed its source identity check.')
    }
    fs.closeSync(targetFd); targetFd = undefined
    fs.closeSync(sourceFd); sourceFd = undefined
    runnerLease=input.acquireLease(executable,sourceDigest,opened.size)
    sourceLease.close(); sourceLease=undefined
    const deniedEnvironment=new Set(['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!deniedEnvironment.has(key.toUpperCase())))
    const child = spawn(executable, ['--no-addons', '--no-global-search-paths', '-e', BROKER], {
      cwd: path.dirname(input.handoffDirectory), detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', 'pipe'], env
    })
    launched = true
    const control=child.stdio[3] as Socket
    helpers.set(child,{control,released:false})
    control.on('error',()=>{ /* A closed control pipe cannot acknowledge cancellation. */ })
    // A cancellation exits the broker only after its real worker has closed.
    // Terminating the broker itself would merely request asynchronous job kill.
    child.kill=()=>{
      if (child.exitCode!==null||control.destroyed) {return false}
      try {control.write('cancel\n');return true} catch {return false}
    }
    const cleanup = () => {
      control.destroy()
      runnerLease?.close();runnerLease=undefined
      // The only removable paths were just exclusively created by this call.
      try { cleanupCopy() } catch { /* Preserve a live runner or diagnostic temp directory. */ }
    }
    child.once('close', cleanup)
    child.stdin!.on('error', () => { /* Native ACK/exit reports the failure. */ })
    child.stdin!.once('finish', () => child.stdin!.destroy())
    child.stdin!.end(powershellInlineInput(input.script))
    return child
  } finally {
    if (sourceFd !== undefined) { fs.closeSync(sourceFd) }
    if (targetFd !== undefined) { fs.closeSync(targetFd) }
    sourceLease?.close()
    if (!launched) {
      runnerLease?.close()
      try { cleanupCopy() } catch { /* Never remove an unexpected file, alias or entry. */ }
    }
  }
}
