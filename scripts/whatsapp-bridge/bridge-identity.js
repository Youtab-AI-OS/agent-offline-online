import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const identity = entry => `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`;
function readOwnedRegular(file, maxBytes) {
  // The opened descriptor is the authority. Nonblocking/no-follow prevents a
  // pathname replacement from turning a regular-file check into a FIFO wait.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(maxBytes)) throw new Error('Bridge identity input is not a bounded regular file');
    const named = fs.lstatSync(file, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || identity(named) !== identity(opened)) throw new Error('Bridge identity input changed');
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes - total + 1));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      total += read;
      if (total > maxBytes) throw new Error('Bridge identity input exceeds its byte limit');
      chunks.push(chunk.subarray(0, read));
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.length > maxBytes || identity(fs.fstatSync(fd, { bigint: true })) !== identity(opened) ||
        identity(fs.lstatSync(file, { bigint: true })) !== identity(opened)) throw new Error('Bridge identity input changed');
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function bridgeContentHash(directory) {
  const names = fs.readdirSync(directory).filter(name => /\.(js|mjs)$/.test(name) && !/\.test\.(js|mjs)$/.test(name));
  for (const name of ['package.json', 'package-lock.json']) if (fs.existsSync(path.join(directory, name))) names.push(name);
  names.sort();
  if (!names.length || names.length > 64) throw new Error('Bridge identity input count is invalid');
  const hash = createHash('sha256').update('youtab.whatsapp.bridge.v1\n');
  for (const name of names) hash.update(name).update('\0').update(readOwnedRegular(path.join(directory, name), 1048576)).update('\0');
  return hash.digest('hex').slice(0, 16);
}

export function codecIdentity(executable, expectedSha256) {
  if (!executable || !expectedSha256) return null;
  if (!path.isAbsolute(executable) || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Managed codec identity configuration is invalid');
  const bytes = readOwnedRegular(executable, 128 * 1024 * 1024);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('Managed codec bytes do not match the verified launcher identity');
  return { executable: fs.realpathSync(executable), sha256 };
}
