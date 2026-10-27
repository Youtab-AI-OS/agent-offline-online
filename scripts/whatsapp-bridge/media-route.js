import { MEDIA_CONTENT_TYPE, MAX_METADATA_BYTES, decodeMediaFrame } from './media-wire.js';
import { inputFormat } from './media-codec.js';
import { mediaPayloadForFile } from './bridge_helpers.js';

export async function buildMediaPayload(metadata, buffer, codec) {
  const { attachmentName, mediaType, caption, fileName } = metadata;
  if (mediaType === 'document') return mediaPayloadForFile({ buffer, filePath: attachmentName, mediaType, caption, fileName });
  let format = inputFormat(buffer, attachmentName);
  if (mediaType === 'image' && !['mjpeg', 'png_pipe', 'webp_pipe', 'gif'].includes(format)) throw new Error('Attachment bytes are not a supported image');
  if (mediaType === 'video' && !['mov', 'avi', 'matroska'].includes(format)) throw new Error('Attachment bytes are not a supported video');
  if (mediaType === 'audio') {
    // Ogg is a container, not proof of Opus: transcode even Ogg/Vorbis.
    try {
      const audio = await codec.voice(buffer, format);
      return { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true, ...await codec.audioDetails(audio, 'ogg') };
    } catch {
      // Preserve ordinary audio delivery when optional ffmpeg is unavailable.
      // Buffer-only isolated metadata prevents Baileys reopening plaintext for
      // duration parsing. A native voice bubble still requires controlled Opus.
      return { audio: buffer, mimetype: codec.mimeFor(format), ptt: false,
        ...await codec.originalAudioDetails(buffer) };
    }
  }
  if (mediaType === 'image' && format === 'gif') {
    let video;
    try { video = await codec.gifVideo(buffer); }
    catch {
      return { image: buffer, caption: caption || undefined, mimetype: 'image/gif',
        jpegThumbnail: await codec.thumbnail(buffer, 'gif') };
    }
    return { video, caption: caption || undefined, mimetype: 'video/mp4', gifPlayback: true,
      jpegThumbnail: await codec.thumbnail(video, 'mov') };
  }
  const payload = mediaPayloadForFile({ buffer, filePath: attachmentName, mediaType, caption, fileName });
  payload.mimetype = codec.mimeFor(format, mediaType);
  payload.jpegThumbnail = await codec.thumbnail(buffer, format);
  return payload;
}

// Register after authentication/Host validation and before any body parser.
// The permit remains owned until the actual upload promise settles, including
// when the HTTP deadline has already returned an error to the caller.
export function registerMediaRoute(app, { maxBytes, connected, codec, send, remember, privateTemp, collectionTimeoutMs = 30000, onIdle = () => {} }) {
  let admitted = false;
  let stopping = false;
  const idleWaiters = [];
  app.post('/send-media', async (req, res) => {
    if (stopping) return res.status(503).json({ error: 'Bridge is stopping' });
    if (admitted) { res.set('Retry-After', '1'); return res.status(429).json({ error: 'A media upload is still active' }); }
    if (!connected()) return res.status(503).json({ error: 'Not connected to WhatsApp' });
    if (req.headers['content-type'] !== MEDIA_CONTENT_TYPE) return res.status(415).json({ error: 'Use the versioned Runtime media bytes contract' });
    admitted = true;
    let settlement;
    const collectionTimer = setTimeout(() => {
      const error = new Error('Media frame collection deadline exceeded');
      error.status = 408;
      req.destroy(error);
    }, collectionTimeoutMs);
    try {
      privateTemp.assertOwned();
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes + MAX_METADATA_BYTES + 4) {
          res.status(413).json({ error: 'Media frame exceeds its byte limit' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      clearTimeout(collectionTimer);
      const frame = decodeMediaFrame(Buffer.concat(chunks, bytes), maxBytes);
      const payload = await buildMediaPayload(frame.metadata, frame.buffer, codec);
      privateTemp.assertOwned();
      const sent = await send(frame.metadata.chatId, payload, promise => { settlement = promise; });
      remember(sent);
      res.json({ success: true, messageId: sent?.key?.id });
    } catch (error) {
      if (!res.headersSent) res.status(error.status || 500).json({ error: error.message });
    } finally {
      clearTimeout(collectionTimer);
      if (settlement) await settlement.catch(() => {});
      admitted = false;
      onIdle();
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  });
  return {
    get busy() { return admitted; },
    async stop() {
      stopping = true;
      if (admitted) await new Promise(resolve => idleWaiters.push(resolve));
    },
  };
}
