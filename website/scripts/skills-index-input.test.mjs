import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fetchSkillsIndex, validateSkillsIndex, MAX_INDEX_BYTES } from './skills-index-input.mjs';

const url = 'https://youtab-agent-runtime.youtab.io/docs/api/skills-index.json';
const catalog = { version: 1, generated_at: '2026-10-06T00:00:00Z', skill_count: 1,
  skills: [{ name: 'Synthetic skill', description: 'سلام', source: 'official',
    identifier: 'synthetic/skill', tags: ['test'], extra: { retained: true } }] };

test('preserves a valid v1 catalog including Unicode and extra fields', async () => {
  const text = JSON.stringify(catalog);
  assert.equal(await fetchSkillsIndex(url, async (endpoint, options) => {
    assert.equal(endpoint, url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal.aborted, false);
    return new Response(text);
  }), text);
});

test('rejects endpoint substitution before making a request', async () => {
  let called = false;
  for (const endpoint of ['http://youtab-agent-runtime.youtab.io/docs/api/skills-index.json',
    'https://private.invalid/catalog', url + '?redirect=private',
    'https://user:password@youtab-agent-runtime.youtab.io/docs/api/skills-index.json']) {
    await assert.rejects(fetchSkillsIndex(endpoint, async () => { called = true; }), /Untrusted/);
  }
  assert.equal(called, false);
});

test('rejects missing, malformed and incompatible metadata/items', () => {
  for (const value of [null, [], { skills: [] }, { ...catalog, version: 2 },
    { ...catalog, generated_at: 'invalid' }, { ...catalog, skill_count: 0 },
    { ...catalog, skills: [{ ...catalog.skills[0], identifier: {} }] },
    { ...catalog, skills: [{ ...catalog.skills[0], tags: [null] }] }]) {
    assert.throws(() => validateSkillsIndex(JSON.stringify(value)), /Invalid/);
  }
  assert.throws(() => validateSkillsIndex('not json'));
});

test('rejects declared oversized input and cancels its unread body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(fetchSkillsIndex(url, async () => new Response(body, {
    headers: { 'content-length': String(MAX_INDEX_BYTES + 1) },
  })), /download limit/);
  assert.equal(cancelled, true);
});

test('enforces the actual streamed-byte limit without trusting content-length', async () => {
  let cancelled = false;
  let count = 0;
  const block = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({
    pull(controller) { count++; controller.enqueue(block); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchSkillsIndex(url, async () => new Response(body)), /download limit/);
  assert.equal(cancelled, true);
  assert.ok(count <= 67);
});

test('rejects failed HTTP and invalid UTF-8 rather than returning publishable bytes', async () => {
  await assert.rejects(fetchSkillsIndex(url, async () => new Response('error', { status: 503 })), /HTTP 503/);
  await assert.rejects(fetchSkillsIndex(url, async () => new Response(new Uint8Array([0xff]))));
});

test('real prebuild entrypoint preserves an older copy on invalid or failed download and publishes valid input', () => {
  const root = mkdtempSync(join(tmpdir(), 'youtab-index-fixture-'));
  try {
    const scripts = join(root, 'scripts');
    const api = join(root, 'static', 'api');
    mkdirSync(scripts); mkdirSync(api, { recursive: true });
    for (const name of ['prebuild.mjs', 'skills-index-input.mjs']) {
      copyFileSync(new URL(name, import.meta.url), join(scripts, name));
    }
    const output = join(api, 'skills-index.json');
    const injection = join(root, 'synthetic-fetch.mjs');
    const fixture = join(root, 'synthetic-fetch.json');
    // Keep executable test setup fixed; each case supplies only JSON data.
    writeFileSync(injection, `import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./synthetic-fetch.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => new Response(fixture.body, { status: fixture.status });
`, { mode: 0o600 });
    const old = JSON.stringify({ ...catalog, generated_at: '2025-01-01T00:00:00Z' });
    for (const [body, status, expected] of [
      ['invalid JSON', 200, old], ['failure', 503, old], [JSON.stringify(catalog), 200, JSON.stringify(catalog)],
    ]) {
      writeFileSync(output, old, { mode: 0o600 });
      utimesSync(output, new Date(0), new Date(0));
      writeFileSync(fixture, JSON.stringify({ body, status }), { mode: 0o600 });
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(injection).href, join(scripts, 'prebuild.mjs')], {
        encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, TEMP: root, TMP: root },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, 'utf8'), expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
