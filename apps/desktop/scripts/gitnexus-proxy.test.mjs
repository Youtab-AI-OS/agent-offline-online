import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createGitNexusProxy,
  GITNEXUS_DISABLED_MESSAGE,
  GITNEXUS_LICENSE_URL,
} from '../../../optional-skills/research/gitnexus-explorer/scripts/proxy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const proxy = path.join(repoRoot, 'optional-skills/research/gitnexus-explorer/scripts/proxy.mjs');
const documents = [
  'optional-skills/research/gitnexus-explorer/SKILL.md',
  'website/docs/user-guide/skills/optional/research/research-gitnexus-explorer.md',
  'website/i18n/zh-Hans/docusaurus-plugin-content-docs/current/user-guide/skills/optional/research/research-gitnexus-explorer.md',
];

describe('customer GitNexus activation gate', () => {
  it('keeps the optional Skill and points customers to upstream commercial licensing', () => {
    const skill = fs.readFileSync(path.join(repoRoot, documents[0]), 'utf8');
    expect(skill).toMatch(/^name: gitnexus-explorer$/m);
    expect(skill).toContain(GITNEXUS_LICENSE_URL);
    expect(skill).toContain('Other Skills, Plugins');
    expect(GITNEXUS_DISABLED_MESSAGE).toContain(GITNEXUS_LICENSE_URL);
    expect(fs.existsSync(path.join(repoRoot, 'skills/github/codebase-inspection/SKILL.md'))).toBe(true);
  });

  it.each(documents)('offers no auto-download or executable launch from %s', relative => {
    const document = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    expect(document).toContain(GITNEXUS_LICENSE_URL);
    expect(document).not.toMatch(/\b(?:git clone|npx gitnexus|node "\$GITNEXUS_PROXY"|npm install)\b/);
  });

  it('rejects direct API and static proxy construction regardless of flags or dist', () => {
    const old = process.env.YOUTAB_GITNEXUS_LICENSED;
    process.env.YOUTAB_GITNEXUS_LICENSED = 'true';
    try {
      for (const dist of ['.', '/tmp', 'C:\\Windows', undefined]) {
        expect(() => createGitNexusProxy(dist)).toThrow(GITNEXUS_DISABLED_MESSAGE);
      }
    } finally {
      if (old === undefined) delete process.env.YOUTAB_GITNEXUS_LICENSED;
      else process.env.YOUTAB_GITNEXUS_LICENSED = old;
    }
  });

  it('exits before listening or reading a supplied build', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtab-gitnexus-gate-'));
    const marker = path.join(root, 'private.txt');
    fs.writeFileSync(marker, 'SYNTHETIC_SECRET');
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    try {
      const result = spawnSync(process.execPath, [proxy, root, String(port)], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, YOUTAB_GITNEXUS_LICENSED: 'true' },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(GITNEXUS_LICENSE_URL);
      expect(result.stderr).not.toContain('SYNTHETIC_SECRET');
      const probe = net.createServer();
      await new Promise((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve));
      await new Promise(resolve => probe.close(resolve));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
