import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMediaFrame, getMediaMaxBytes, MediaWireError, MEDIA_CONTRACT,
  MEDIA_VERSION, MAX_METADATA_BYTES, MAX_MEDIA_BYTES, DEFAULT_MEDIA_MAX_BYTES,
} from './media-wire.js';

const metadata = (patch = {}) => ({
  contract: MEDIA_CONTRACT, version: MEDIA_VERSION, chatId: '123@s.whatsapp.net',
  byteLength: 3, attachmentName: 'photo.gif', mediaType: 'image', ...patch,
});
function frame(value = metadata(), content = Buffer.from([0, 127, 255])) {
  const json = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  return Buffer.concat([prefix, json, content]);
}
function deny(body, cap = 16, status = 400) {
  assert.throws(() => decodeMediaFrame(body, cap), error =>
    error instanceof MediaWireError && error.status === status);
}

test('preserves binary bytes, Unicode labels/caption, and zero-copy storage', () => {
  const body = frame(metadata({ caption: 'سلام\ntext', fileName: 'گزارش.gif' }));
  const parsed = decodeMediaFrame(body, 3);
  assert.equal(parsed.metadata.caption, 'سلام\ntext');
  assert.equal(parsed.metadata.fileName, 'گزارش.gif');
  assert.deepEqual(parsed.buffer, Buffer.from([0, 127, 255]));
  assert.equal(parsed.buffer.buffer, body.buffer);
  assert.equal(Object.isFrozen(parsed.metadata), true);
});

test('preserves each existing media type and empty regular documents', () => {
  for (const mediaType of ['image', 'video', 'audio', 'document']) {
    assert.equal(decodeMediaFrame(frame(metadata({ mediaType })), 3).metadata.mediaType, mediaType);
  }
  assert.equal(decodeMediaFrame(frame(metadata({ byteLength: 0, mediaType: 'document' }), Buffer.alloc(0)), 1).buffer.length, 0);
});

test('configuration has explicit default, lower limit, hard ceiling, and errors', () => {
  assert.equal(getMediaMaxBytes({}), DEFAULT_MEDIA_MAX_BYTES);
  assert.equal(getMediaMaxBytes({ YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES: '1' }), 1);
  assert.equal(getMediaMaxBytes({ YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES: String(MAX_MEDIA_BYTES) }), MAX_MEDIA_BYTES);
  for (const raw of ['', '0', '-1', '+1', '1.5', '1e3', ' 1', '01', 'Infinity', String(MAX_MEDIA_BYTES + 1), '9007199254740993', 128]) {
    assert.throws(() => getMediaMaxBytes({ YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES: raw }), MediaWireError);
  }
  for (const cap of [undefined, 0, -1, 1.5, Infinity, MAX_MEDIA_BYTES + 1]) {
    assert.throws(() => decodeMediaFrame(frame(), cap), MediaWireError);
  }
});

test('does not accept old pathname or caller decoder/thumbnail/MIME authority', () => {
  for (const key of ['filePath', 'path', 'url', 'mimetype', 'mimeType', 'jpegThumbnail', 'ffmpegOptions', '__proto__']) {
    const value = metadata();
    Object.defineProperty(value, key, { value: 'synthetic-untrusted', enumerable: true });
    deny(frame(value));
  }
  assert.equal({}.syntheticUntrusted, undefined);
  deny(Buffer.from(JSON.stringify({ chatId: '123', filePath: 'C:\\synthetic\\secret' })));
});

test('rejects unknown versions, structured values, absent required keys, and paths', () => {
  for (const patch of [
    { contract: 'other' }, { version: 2 }, { version: '1' }, { chatId: '' },
    { chatId: [] }, { byteLength: -1 }, { byteLength: 1.5 }, { byteLength: '3' },
    { caption: null }, { caption: {} }, { mediaType: 'unknown' },
    { attachmentName: '../victim' }, { attachmentName: 'C:\\victim' },
    { attachmentName: '.' }, { attachmentName: '..' }, { attachmentName: 'a\u0000b' },
    { fileName: '../label' }, { fileName: '' },
  ]) deny(frame(metadata(patch)));
  for (const key of ['contract', 'version', 'chatId', 'byteLength', 'attachmentName', 'mediaType']) {
    const value = metadata(); delete value[key]; deny(frame(value));
  }
  for (const value of [null, [], 'text', 1]) deny(frame(value));
});

test('checks actual trailing bytes, metadata length, and configured attachment cap', () => {
  deny(frame(metadata({ byteLength: 4 })));
  deny(frame(metadata({ byteLength: 2 })));
  deny(frame(), 2, 413);
  deny(Buffer.alloc(3));
  deny({});
  deny(Buffer.alloc(4));
  const oversizedPrefix = Buffer.alloc(4); oversizedPrefix.writeUInt32BE(MAX_METADATA_BYTES + 1);
  deny(oversizedPrefix);
  const truncatedPrefix = Buffer.alloc(4); truncatedPrefix.writeUInt32BE(4);
  deny(Buffer.concat([truncatedPrefix, Buffer.from('{}')]));
  deny(Buffer.alloc(4 + MAX_METADATA_BYTES + 2), 1, 413);
});

test('rejects malformed UTF-8, BOM JSON, malformed JSON, and nested field data', () => {
  for (const json of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), Buffer.from('{'), Buffer.from('{}')]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(json.length);
    deny(Buffer.concat([prefix, json]));
  }
  deny(frame(metadata({ caption: { nested: [{ content: 'not text' }] } })));
});

test('metadata bound includes exact UTF-8 bytes and permits the boundary', () => {
  const value = metadata({ caption: '' });
  const base = Buffer.byteLength(JSON.stringify(value));
  value.caption = 'a'.repeat(MAX_METADATA_BYTES - base);
  assert.equal(Buffer.byteLength(JSON.stringify(value)), MAX_METADATA_BYTES);
  assert.equal(decodeMediaFrame(frame(value), 3).metadata.caption.length, MAX_METADATA_BYTES - base);
  value.caption += 'é';
  deny(frame(value));
});
