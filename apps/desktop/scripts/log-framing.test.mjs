import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { logField, logLine } from './log-framing.mjs';
import * as photon from '../../../plugins/platforms/photon/sidecar/log-framing.mjs';

for (const [name, framing] of [['desktop', { logField, logLine }], ['photon', photon]]) {
  test(`${name}: terminal and record controls cannot escape a field`, () => {
    const input = 'real\r\nFAKE: success\x1b[2J\x00\x85\u2028\u2029\u202e\u061c\u200e\u200f';
    const output = framing.logField(input);
    assert.equal(output, 'real\\r\\nFAKE: success\\u001b[2J\\u0000\\u0085\\u2028\\u2029\\u202e\\u061c\\u200e\\u200f');
    assert.doesNotMatch(output, /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  });
  test(`${name}: useful labels, metrics, Unicode and error context survive`, () => {
    assert.equal(framing.logLine('Settings', 15, { wasted: 2 }, 'روز'), 'Settings 15 {"wasted":2} روز');
    const error = new Error('provider\nfailed');
    assert.match(framing.logLine('Error:', error), /^Error: Error: provider\\nfailed\\n/);
    assert.equal(framing.logField('x'.repeat(20000)).length, 16384);
    assert.equal(framing.logField('\x1b'.repeat(20000)).length, 98304);
    const circular = {}; circular.self = circular;
    assert.equal(framing.logField(circular), '[unserializable log field]');
  });
  test(`${name}: actual console output stays one record and leaves format tokens literal`, () => {
    const moduleUrl = new URL(name === 'desktop' ? './log-framing.mjs'
      : '../../../plugins/platforms/photon/sidecar/log-framing.mjs', import.meta.url).href;
    const script = `import { logLine } from ${JSON.stringify(moduleUrl)};
      console.log(logLine('%s\\nFORGED', 'real\\u001b[2J'));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '%s\\nFORGED real\\u001b[2J\n');
  });
}
