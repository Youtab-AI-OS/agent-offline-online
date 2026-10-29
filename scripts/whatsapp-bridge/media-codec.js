// Controlled attachment-derived media. All decoders receive bytes on stdin and
// fixed demuxers/pipe-only protocols; display names never become host arguments.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class MediaCodecError extends Error {
  constructor(message) { super(message); this.name = 'MediaCodecError'; }
}

const formats = new Set(['mjpeg', 'png_pipe', 'webp_pipe', 'gif', 'mov', 'avi', 'matroska', 'ogg', 'wav', 'mp3', 'aac', 'flac', 'amr']);
const extensions = { jpg: 'mjpeg', jpeg: 'mjpeg', png: 'png_pipe', webp: 'webp_pipe', gif: 'gif', mp4: 'mov', mov: 'mov', m4a: 'mov', '3gp': 'mov', avi: 'avi', mkv: 'matroska', webm: 'matroska', ogg: 'ogg', opus: 'ogg', wav: 'wav', mp3: 'mp3', aac: 'aac', flac: 'flac', amr: 'amr' };
const mime = { mjpeg: 'image/jpeg', png_pipe: 'image/png', webp_pipe: 'image/webp', gif: 'image/gif', mov: 'video/mp4', avi: 'video/x-msvideo', matroska: 'video/x-matroska', ogg: 'audio/ogg; codecs=opus', wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac', flac: 'audio/flac', amr: 'audio/amr' };

export function inputFormat(buffer, attachmentName) {
  const head = buffer.subarray(0, 16);
  if (head.subarray(0, 6).toString() === 'GIF87a' || head.subarray(0, 6).toString() === 'GIF89a') return 'gif';
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png_pipe';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'mjpeg';
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return 'webp_pipe';
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'AVI ') return 'avi';
  if (head.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (head.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (head.subarray(0, 3).toString() === 'ID3') return 'mp3';
  if (['ftyp', 'moov', 'mdat'].includes(head.subarray(4, 8).toString())) return 'mov';
  if (head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'matroska';
  const format = extensions[attachmentName.toLowerCase().split('.').pop()];
  if (!formats.has(format)) throw new MediaCodecError('No safe standalone input demuxer for this attachment');
  if (['mjpeg', 'png_pipe', 'webp_pipe', 'gif'].includes(format)) throw new MediaCodecError('Image bytes do not match an approved standalone image format');
  return format;
}

export function runBoundedCodec(executable, args, input, { maxOutputBytes, timeoutMs = 30000, maxErrorBytes = 65536, spawnImpl = spawn } = {}) {
  if (!Buffer.isBuffer(input) || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new MediaCodecError('Invalid bounded codec input');
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { reject(new MediaCodecError('Media codec is unavailable')); return; }
    const chunks = [];
    let outputBytes = 0, errorBytes = 0, failure;
    const fail = message => {
      failure ||= new MediaCodecError(message);
      child.stdin.destroy();
      if (child.pid && child.exitCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail('Media codec deadline exceeded'), timeoutMs);
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { fail('Media codec output exceeds its byte limit'); return; }
      if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > maxErrorBytes) fail('Media codec diagnostics exceed their byte limit'); });
    child.on('error', () => { failure ||= new MediaCodecError('Media codec is unavailable'); });
    child.stdin.on('error', () => { failure ||= new MediaCodecError('Media codec input was rejected'); });
    // Resolve/reject only on close: an owned terminated decoder and its pipes
    // must be reaped before request admission or its input buffer is released.
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) { reject(failure || new MediaCodecError('Media codec rejected the attachment')); return; }
      resolve(Buffer.concat(chunks, outputBytes));
    });
    child.stdin.end(input);
  });
}

function decoderArgs(format) {
  if (!formats.has(format)) throw new MediaCodecError('Unsupported internal demuxer');
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '67108864', '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2',
    '-protocol_whitelist', 'pipe', '-format_whitelist', format, '-max_pixels', '41943040', '-f', format, ...(format === 'mov' ? ['-enable_drefs', '0'] : []), '-i', 'pipe:0'];
}

export function createMediaCodec({ ffmpeg = 'ffmpeg', maxBytes, run = runBoundedCodec } = {}) {
  const convert = (buffer, format, output, maxOutputBytes = maxBytes) => run(ffmpeg, [...decoderArgs(format), ...output, 'pipe:1'], buffer, { maxOutputBytes });
  return {
    async gifVideo(buffer) {
      return convert(buffer, 'gif', ['-map', '0:v:0', '-an', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']);
    },
    async voice(buffer, format) {
      return convert(buffer, format, ['-map', '0:a:0', '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-threads', '2', '-f', 'ogg']);
    },
    async thumbnail(buffer, format) {
      if (['mjpeg', 'png_pipe', 'webp_pipe', 'gif'].includes(format)) {
        // Baileys already pins Sharp. Decode only the supplied bytes, never a
        // filename/URL, and bound image pixels before native allocation.
        const display = { mjpeg: 'image.jpg', png_pipe: 'image.png', webp_pipe: 'image.webp', gif: 'image.gif' }[format];
        if (inputFormat(buffer, display) !== format) throw new MediaCodecError('Image decoder format differs from its approved bytes');
        const { default: sharp } = await import('sharp');
        const image = sharp(buffer, { limitInputPixels: 41943040, sequentialRead: true, pages: 1 });
        const metadata = await image.metadata();
        const expected = { mjpeg: 'jpeg', png_pipe: 'png', webp_pipe: 'webp', gif: 'gif' }[format];
        if (metadata.format !== expected) throw new MediaCodecError('Image decoder format differs from the approved attachment bytes');
        const thumbnail = await image.resize(32, 32, { fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer();
        if (thumbnail.length > 65536) throw new MediaCodecError('Generated thumbnail exceeds its byte limit');
        return thumbnail;
      }
      const thumbnail = await convert(buffer, format, ['-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=32:-1', '-c:v', 'mjpeg', '-f', 'image2pipe'], 65536);
      if (thumbnail.length < 4 || thumbnail[0] !== 255 || thumbnail[1] !== 216 || thumbnail.at(-2) !== 255 || thumbnail.at(-1) !== 217) throw new MediaCodecError('Invalid generated JPEG thumbnail');
      return thumbnail;
    },
    async audioDetails(buffer, format) {
      const pcm = await convert(buffer, format, ['-map', '0:a:0', '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le'], Math.min(maxBytes, 32 * 1024 * 1024));
      if (!pcm.length || pcm.length % 4) throw new MediaCodecError('Invalid decoded audio metadata');
      const count = pcm.length / 4;
      const bars = Array(64).fill(0);
      for (let i = 0; i < count; i++) {
        const sample = pcm.readFloatLE(i * 4);
        if (!Number.isFinite(sample)) throw new MediaCodecError('Invalid decoded audio sample');
        bars[Math.min(63, Math.floor(i * 64 / count))] += Math.abs(sample);
      }
      const peak = Math.max(...bars);
      const waveform = Buffer.from(bars.map(value => peak ? Math.round(value / peak * 100) : 0));
      return { seconds: count / 8000, waveform };
    },
    async originalAudioDetails(buffer) {
      const output = await run(process.execPath, ['--max-old-space-size=128', fileURLToPath(new URL('./audio-metadata.js', import.meta.url))],
        buffer, { maxOutputBytes: 1024 });
      const details = JSON.parse(output.toString('utf8'));
      if (!Number.isFinite(details.seconds) || details.seconds <= 0) throw new MediaCodecError('Audio duration is unavailable');
      return details;
    },
    mimeFor(format, mediaType = 'audio') {
      if (mediaType === 'audio' && format === 'ogg') return 'audio/ogg';
      if (mediaType === 'audio' && format === 'mov') return 'audio/mp4';
      if (mediaType === 'audio' && format === 'matroska') return 'audio/webm';
      return mime[format] || 'application/octet-stream';
    },
  };
}
