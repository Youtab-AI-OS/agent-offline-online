import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { bridgeContentHash, codecIdentity } from './bridge-identity.js';

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-bridge-identity-'));
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('regular descriptor preserves canonical closure and excludes test files', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'bridge.js'), 'original bytes');
  const expected = createHash('sha256').update('youtab.whatsapp.bridge.v1\n').update('bridge.js\0original bytes\0').digest('hex').slice(0, 16);
  assert.equal(bridgeContentHash(root), expected);
  fs.writeFileSync(path.join(root, 'ignored.test.mjs'), 'not production');
  assert.equal(bridgeContentHash(root), expected);
  fs.writeFileSync(path.join(root, 'media-route.js'), 'new helper');
  assert.notEqual(bridgeContentHash(root), expected);
}));

test('descriptor authority rejects pathname replacement before any byte read', () => fixture(root => {
  const source = path.join(root, 'bridge.js');
  fs.writeFileSync(source, 'original');
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
  let reads = 0, opened, closed = false, swapped = false;
  try {
    fs.openSync = (name, flags, ...rest) => {
      const fd = open(name, flags, ...rest);
      if (name === source && !swapped) { swapped = true; opened = fd; fs.renameSync(source, path.join(root, 'saved-original')); fs.writeFileSync(source, 'replacement'); }
      return fd;
    };
    fs.readSync = (...args) => { reads++; return read(...args); };
    fs.closeSync = fd => { if (fd === opened) closed = true; return close(fd); };
    assert.throws(() => bridgeContentHash(root), /identity input changed/);
    assert.equal(reads, 0);
    assert.equal(closed, true);
  } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; }
}));

test('opened regular file growing beyond cap never reads above cap plus one', () => fixture(root => {
  const source = path.join(root, 'bridge.js'); fs.writeFileSync(source, 'initial');
  const read = fs.readSync;
  let total = 0, appended = false;
  try {
    fs.readSync = (...args) => {
      const bytes = read(...args); total += bytes;
      if (!appended) { appended = true; fs.appendFileSync(source, Buffer.alloc(2 * 1048576)); }
      return bytes;
    };
    assert.throws(() => bridgeContentHash(root), /exceeds its byte limit/);
    assert.equal(total, 1048577);
  } finally { fs.readSync = read; }
}));

test('entry replacement with hardlinked external canary is rejected without reading it', () => fixture(root => {
  const source = path.join(root, 'bridge.js'), canary = path.join(root, 'external-canary');
  fs.writeFileSync(source, 'original'); fs.writeFileSync(canary, 'DO-NOT-READ');
  const open = fs.openSync, read = fs.readSync;
  let reads = 0, swapped = false;
  try {
    fs.openSync = (name, flags, ...rest) => {
      const fd = open(name, flags, ...rest);
      if (name === source && !swapped) { swapped = true; fs.renameSync(source, path.join(root, 'saved')); fs.linkSync(canary, source); }
      return fd;
    };
    fs.readSync = (...args) => { reads++; return read(...args); };
    assert.throws(() => bridgeContentHash(root), /identity input changed/);
    assert.equal(reads, 0);
  } finally { fs.openSync = open; fs.readSync = read; }
  assert.equal(fs.readFileSync(canary, 'utf8'), 'DO-NOT-READ');
}));

test('in-place modification invalidates attestation after bounded descriptor read', () => fixture(root => {
  const source = path.join(root, 'bridge.js'); fs.writeFileSync(source, 'original');
  const read = fs.readSync; let mutated = false;
  try {
    fs.readSync = (...args) => { const bytes = read(...args); if (!mutated) { mutated = true; fs.writeFileSync(source, 'modified bytes'); } return bytes; };
    assert.throws(() => bridgeContentHash(root), /identity input changed/);
  } finally { fs.readSync = read; }
}));

test('codec identity uses verified bytes and rejects incorrect expected digest', () => fixture(root => {
  const file = path.join(root, 'synthetic-codec.exe'); const bytes = Buffer.from('public synthetic codec bytes'); fs.writeFileSync(file, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(codecIdentity(file, sha), { executable: fs.realpathSync(file), sha256: sha });
  assert.throws(() => codecIdentity(file, '0'.repeat(64)), /do not match/);
}));

test('POSIX regular pathname swapped to FIFO at open never blocks or reads', { skip: process.platform === 'win32' ? 'Native Windows does not provide POSIX FIFO files' : false }, () => fixture(root => {
  const file = path.join(root, 'bridge.js'); fs.writeFileSync(file, 'original regular file');
  const code = `
    import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; import path from 'node:path';
    const {bridgeContentHash}=await import(process.argv[1]); const root=process.argv[2],file=path.join(root,'bridge.js');
    const open=fs.openSync;let swapped=false;
    fs.openSync=(name,flags,...rest)=>{if(name===file&&!swapped){swapped=true;fs.renameSync(file,path.join(root,'saved-original'));execFileSync('mkfifo',[file]);}return open(name,flags,...rest);};
    try {bridgeContentHash(root);process.exit(2);} catch(error) {if(!error.message.includes('bounded regular file'))throw error;}
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', code, new URL('./bridge-identity.js', import.meta.url).href, root], { timeout: 3000, stdio: 'pipe' });
}));
