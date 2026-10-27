import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaCodec, runBoundedCodec, inputFormat } from './media-codec.js';

const ffmpeg = process.env.YOUTAB_TEST_FFMPEG_PATH || 'ffmpeg';
const generate = args => runBoundedCodec(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args, 'pipe:1'], Buffer.alloc(0), { maxOutputBytes: 1048576 });
const codec = createMediaCodec({ ffmpeg, maxBytes: 1048576 });
test('actual GIF/video/JPEG/PNG and voice converters produce valid decoded media', async () => {
  const gif = await generate(['-f', 'lavfi', '-i', 'color=c=blue:s=16x16:d=0.1', '-frames:v', '2', '-f', 'gif']);
  const video = await codec.gifVideo(gif);
  assert.ok(video.includes(Buffer.from('ftyp')));
  const thumbnail = await codec.thumbnail(video, 'mov');
  assert.equal(thumbnail.readUInt16BE(0), 0xffd8);
  const jpeg = await codec.thumbnail(gif, 'gif'); assert.equal(jpeg.readUInt16BE(0), 0xffd8);
  const wav = await generate(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-f', 'wav']);
  const voice = await codec.voice(wav, 'wav'); assert.ok(voice.includes(Buffer.from('OpusHead')));
  const original = await codec.originalAudioDetails(wav); assert.ok(original.seconds > 0);
  const details = await codec.audioDetails(voice, 'ogg'); assert.ok(details.seconds > 0); assert.equal(details.waveform.length, 64);
  const vorbis = await generate(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-c:a', 'libvorbis', '-f', 'ogg']);
  assert.equal(inputFormat(vorbis, 'sound.ogg'), 'ogg');
  assert.ok((await codec.voice(vorbis, 'ogg')).includes(Buffer.from('OpusHead')));
});
test('actual codec blocks playlists, excess pixels and bounded output', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>');
  assert.throws(() => inputFormat(svg, 'claimed.png'), /approved standalone/);
  await assert.rejects(codec.thumbnail(svg, 'png_pipe'), /approved standalone/);
  const { default: sharp } = await import('sharp');
  const tiff = await sharp({create:{width:16,height:16,channels:3,background:'#0000ff'}}).tiff().toBuffer();
  assert.throws(() => inputFormat(tiff, 'claimed.jpg'), /approved standalone/);
  await assert.rejects(codec.thumbnail(tiff, 'mjpeg'), /approved standalone/);
  const playlist = Buffer.from('#EXTM3U\n#EXTINF:1,\nfile:///synthetic/forbidden-canary\n');
  await assert.rejects(codec.gifVideo(playlist));
  // GIF logical screen declares 65535 squared pixels, before any valid frame.
  const oversized = Buffer.from('474946383961ffffffff800000000000ffffff2c00000000ffffffff0002024401003b', 'hex');
  await assert.rejects(codec.gifVideo(oversized));
  await assert.rejects(codec.thumbnail(oversized, 'gif'));
  const validOversized = await sharp({create:{width:9000,height:5000,channels:3,background:'#0000ff'}}).png().toBuffer();
  await assert.rejects(codec.thumbnail(validOversized, 'png_pipe'), /pixel limit/);
  const ordinary8K = await sharp({create:{width:7680,height:4320,channels:3,background:'#0000ff'}}).png().toBuffer();
  assert.equal((await codec.thumbnail(ordinary8K, 'png_pipe')).readUInt16BE(0), 0xffd8);
  const wav = await generate(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-f', 'wav']);
  const tiny = createMediaCodec({ ffmpeg, maxBytes: 1 });
  await assert.rejects(tiny.voice(wav, 'wav'), /byte limit/);
});
test('owned process deadline and diagnostic bounds reap the actual child', async () => {
  await assert.rejects(runBoundedCodec(process.execPath, ['-e', 'setInterval(()=>{},1000)'], Buffer.alloc(0),
    { maxOutputBytes: 1024, timeoutMs: 30 }), /deadline/);
  await assert.rejects(runBoundedCodec(process.execPath, ['-e', 'process.stderr.write("x".repeat(10000));setInterval(()=>{},1000)'], Buffer.alloc(0),
    { maxOutputBytes: 1024, maxErrorBytes: 100, timeoutMs: 1000 }), /diagnostics/);
});
