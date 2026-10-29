import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable, PassThrough } from 'node:stream';
import { registerMediaRoute, buildMediaPayload } from './media-route.js';
import { MEDIA_CONTENT_TYPE } from './media-wire.js';

function frame(metadata = {}, bytes = Buffer.from('authorized bytes')) {
  const header = Buffer.from(JSON.stringify({ contract: 'youtab.whatsapp.media', version: 1,
    chatId: 'synthetic@s.whatsapp.net', byteLength: bytes.length, attachmentName: 'report.txt', mediaType: 'document', ...metadata }));
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, bytes]);
}
function response() {
  return { statusCode: 200, headersSent: false, headers: {}, set(key, value) { this.headers[key] = value; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; this.headersSent = true; return this; } };
}
function request(body) { const req = Readable.from([body]); req.headers = { 'content-type': MEDIA_CONTENT_TYPE }; return req; }
function route(options = {}) {
  let handler;
  const sent = [];
  registerMediaRoute({ post(path, fn) { assert.equal(path, '/send-media'); handler = fn; } }, {
    maxBytes: 1024, connected: () => true, codec: {}, privateTemp: { assertOwned() {} }, remember() {},
    send: async (chatId, payload) => { sent.push({ chatId, payload }); return { key: { id: 'proof' } }; }, ...options,
  });
  return { handler, sent };
}
test('bytes route sends document, rejects legacy paths and length mismatch without effects', async () => {
  const { handler, sent } = route();
  const res = response(); await handler(request(frame()), res);
  assert.equal(res.statusCode, 200); assert.equal(sent[0].payload.document.toString(), 'authorized bytes');
  for (const body of [frame({ filePath: 'C:\\private' }), frame({ byteLength: 1 })]) {
    const rejected = response(); await handler(request(body), rejected); assert.equal(rejected.statusCode, 400);
  }
  assert.equal(sent.length, 1);
});
test('admission remains occupied after HTTP deadline until real upload settles', async () => {
  let resolve;
  const actual = new Promise(done => { resolve = done; });
  const { handler } = route({ send: async (_id, _body, capture) => { capture(actual); throw new Error('HTTP deadline'); } });
  const first = response(); const pending = handler(request(frame()), first);
  await new Promise(done => setImmediate(done));
  assert.equal(first.statusCode, 500);
  const next = response(); await handler(request(frame()), next); assert.equal(next.statusCode, 429);
  resolve(); await pending;
  const third = response(); const again = handler(request(frame()), third); await again; assert.equal(third.statusCode, 500);
});
test('incomplete body deadline destroys collector and frees admission', async () => {
  const { handler, sent } = route({ collectionTimeoutMs: 20 });
  const stalled = new PassThrough(); stalled.headers = { 'content-type': MEDIA_CONTENT_TYPE }; stalled.write(Buffer.from([0]));
  const res = response(); await handler(stalled, res); assert.equal(res.statusCode, 408); assert.equal(sent.length, 0);
  const next = response(); await handler(request(frame()), next); assert.equal(next.statusCode, 200);
});
test('GIF fallback preserves truthful bytes and internally derived thumbnail; Ogg is transcoded', async () => {
  const codec = { gifVideo: async () => { throw new Error('Unavailable'); }, thumbnail: async () => Buffer.from('derived'),
    voice: async () => Buffer.from('Opus'), audioDetails: async () => ({ seconds: 1, waveform: Buffer.alloc(64) }) };
  const gif = Buffer.from('GIF89a proof');
  const image = await buildMediaPayload({ attachmentName: 'x.gif', mediaType: 'image' }, gif, codec);
  assert.equal(image.mimetype, 'image/gif'); assert.equal(image.image, gif);
  const audio = await buildMediaPayload({ attachmentName: 'x.ogg', mediaType: 'audio' }, Buffer.from('OggS Vorbis'), codec);
  assert.equal(audio.audio.toString(), 'Opus'); assert.equal(audio.ptt, true);
});
