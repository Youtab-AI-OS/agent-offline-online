// Private process-wide namespace for known Baileys upload files. Media requests
// carry bytes only; no request field selects this directory or any host path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function directoryIdentity(directory) {
  const current = fs.lstatSync(directory, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Private bridge temp directory is not a regular directory');
  return current;
}

function verifyWindowsPrivateDirectory(directory, protectedParent) {
  const script = `
$ErrorActionPreference = 'Stop'
$directory = [Environment]::GetEnvironmentVariable('YOUTAB_AGENT_WHATSAPP_VERIFY_DIR')
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$item = Get-Item -LiteralPath $directory -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Private temp directory is a redirect' }
$acl = Get-Acl -LiteralPath $directory
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $current) { throw 'Private temp directory has another owner' }
if ([Environment]::GetEnvironmentVariable('YOUTAB_AGENT_WHATSAPP_VERIFY_PROTECTED') -eq '1' -and -not $acl.AreAccessRulesProtected) { throw 'Private temp parent must have a protected DACL' }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -eq 0) { throw 'Private temp directory has no owner permissions' }
foreach ($rule in $rules) {
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -ne $current) { throw 'Private temp directory permits another identity' }
  if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Private temp directory owner permissions are incomplete' }
  if (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -eq 0 -or ($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -eq 0) { throw 'Private temp directory inheritance is incomplete' }
}
@{ verified = $true; owner = $owner; protected = $acl.AreAccessRulesProtected; rules = $rules.Count } | ConvertTo-Json -Compress
`;
  const executable = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true,
    env: { ...process.env, YOUTAB_AGENT_WHATSAPP_VERIFY_DIR: directory, YOUTAB_AGENT_WHATSAPP_VERIFY_PROTECTED: protectedParent ? '1' : '0' },
  });
  const proof = JSON.parse(output);
  if (proof.verified !== true || !proof.owner || !Number.isInteger(proof.rules) || proof.rules < 1) throw new Error('Private bridge temp DACL could not be verified');
}

function removeOwnedChildren(directory, root) {
  for (const name of fs.readdirSync(directory)) {
    const child = path.join(directory, name);
    const current = fs.lstatSync(child);
    if (current.isSymbolicLink()) { fs.unlinkSync(child); continue; }
    const relative = path.relative(root, fs.realpathSync(child));
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Private bridge temp cleanup escaped its namespace');
    if (current.isDirectory()) { removeOwnedChildren(child, root); fs.rmdirSync(child); }
    else if (current.isFile()) fs.unlinkSync(child);
    else throw new Error('Private bridge temp contains an unsupported object');
  }
}

export function initializePrivateBridgeTemp() {
  let parent;
  if (process.platform === 'win32') {
    const selected = process.env.YOUTAB_AGENT_WHATSAPP_PRIVATE_TMP_PARENT;
    if (!selected) throw new Error('WhatsApp on Windows requires a verified owner-private temp parent. Start the bridge with the Runtime managed launcher.');
    parent = path.resolve(selected);
    directoryIdentity(parent);
    if (fs.realpathSync(parent).toLowerCase() !== parent.toLowerCase()) throw new Error('Private bridge temp parent must be canonical');
    verifyWindowsPrivateDirectory(parent, true);
  } else {
    const selected = process.env.YOUTAB_AGENT_WHATSAPP_PRIVATE_TMP_PARENT;
    parent = fs.realpathSync(selected || os.tmpdir());
    if (selected) {
      const info = directoryIdentity(parent);
      if (info.uid !== BigInt(process.getuid()) || (info.mode & 0o777n) !== 0o700n) throw new Error('Private bridge temp parent mode or owner is invalid');
    }
  }
  const parentIdentity = directoryIdentity(parent);
  const directory = fs.mkdtempSync(path.join(parent, 'youtab-whatsapp-'));
  const owned = directoryIdentity(directory);
  try {
    if (process.platform === 'win32') verifyWindowsPrivateDirectory(directory, false);
    else if (owned.uid !== BigInt(process.getuid()) || (owned.mode & 0o777n) !== 0o700n) throw new Error('Private bridge temp mode or owner is invalid');
  } catch (error) {
    if (same(owned, directoryIdentity(directory))) fs.rmdirSync(directory);
    throw error;
  }
  // Assign once before Baileys import/effects; never temporarily retarget async uploads.
  process.env.TEMP = directory; process.env.TMP = directory; process.env.TMPDIR = directory;
  let cleaned = false;
  return {
    path: directory,
    assertOwned() {
      if (cleaned || !same(parentIdentity, directoryIdentity(parent)) || !same(owned, directoryIdentity(directory))) throw new Error('Private bridge temp namespace changed');
    },
    clearOwnedFiles() {
      this.assertOwned();
      removeOwnedChildren(directory, directory);
    },
    cleanup() {
      if (cleaned) return;
      this.assertOwned();
      removeOwnedChildren(directory, directory);
      fs.rmdirSync(directory);
      cleaned = true;
    },
  };
}
