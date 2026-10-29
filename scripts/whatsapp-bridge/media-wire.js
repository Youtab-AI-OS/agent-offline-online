// Internal attachment-content contract. No metadata field authorizes host IO.
export const MEDIA_CONTENT_TYPE = 'application/vnd.youtab.whatsapp-media.v1';
export const MEDIA_CONTRACT = 'youtab.whatsapp.media';
export const MEDIA_VERSION = 1;
export const MAX_METADATA_BYTES = 65536;
export const DEFAULT_MEDIA_MAX_BYTES = 128 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

const fields = new Set([
  'contract', 'version', 'chatId', 'byteLength', 'attachmentName', 'mediaType',
  'caption', 'fileName',
]);
const types = new Set(['image', 'video', 'audio', 'document']);

export class MediaWireError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MediaWireError';
    this.status = status;
  }
}

function validateLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MEDIA_BYTES) {
    throw new MediaWireError('Media byte limit must be an integer between 1 and 536870912');
  }
  return value;
}

export function getMediaMaxBytes(env = process.env) {
  const raw = env.YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES;
  if (raw === undefined) return DEFAULT_MEDIA_MAX_BYTES;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
    throw new MediaWireError('YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES must be a positive decimal integer');
  }
  return validateLimit(Number(raw));
}

function validateName(value, field) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
      || /[\\/\u0000]/.test(value)) {
    throw new MediaWireError(`${field} must be a nonempty basename`);
  }
}

function validateMetadata(metadata, maxBytes) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new MediaWireError('Media metadata must be a flat object');
  }
  if (Object.keys(metadata).some(key => !fields.has(key))) {
    throw new MediaWireError('Unsupported media metadata fields; host paths and decoder options are not accepted');
  }
  if (metadata.contract !== MEDIA_CONTRACT || metadata.version !== MEDIA_VERSION) {
    throw new MediaWireError('Unsupported internal media contract; use attachment content version 1');
  }
  if (typeof metadata.chatId !== 'string' || !metadata.chatId) {
    throw new MediaWireError('chatId must be a nonempty string');
  }
  if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0) {
    throw new MediaWireError('byteLength must be a nonnegative integer');
  }
  if (metadata.byteLength > maxBytes) {
    throw new MediaWireError('Attachment exceeds the configured media byte limit', 413);
  }
  validateName(metadata.attachmentName, 'attachmentName');
  if (typeof metadata.mediaType !== 'string' || !types.has(metadata.mediaType)) {
    throw new MediaWireError('Unsupported mediaType');
  }
  if (Object.hasOwn(metadata, 'caption') && typeof metadata.caption !== 'string') {
    throw new MediaWireError('caption must be a string');
  }
  if (Object.hasOwn(metadata, 'fileName')) validateName(metadata.fileName, 'fileName');
}

export function decodeMediaFrame(body, maxBytes) {
  validateLimit(maxBytes);
  if (!Buffer.isBuffer(body) || body.length < 4) {
    throw new MediaWireError('Expected an internal binary media frame');
  }
  if (body.length > 4 + MAX_METADATA_BYTES + maxBytes) {
    throw new MediaWireError('Media frame exceeds the configured byte limit', 413);
  }
  const metadataLength = body.readUInt32BE(0);
  if (metadataLength === 0 || metadataLength > MAX_METADATA_BYTES) {
    throw new MediaWireError('Media metadata length must be between 1 and 65536 bytes');
  }
  const contentOffset = 4 + metadataLength;
  if (contentOffset > body.length) {
    throw new MediaWireError('Truncated media metadata');
  }
  let metadata;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(body.subarray(4, contentOffset));
    metadata = JSON.parse(text);
  } catch {
    throw new MediaWireError('Media metadata must be valid UTF-8 JSON');
  }
  validateMetadata(metadata, maxBytes);
  if (body.length - contentOffset !== metadata.byteLength) {
    throw new MediaWireError('Media content length does not match byteLength');
  }
  // No second attachment allocation; request admission must hold this backing buffer.
  return { metadata: Object.freeze(metadata), buffer: body.subarray(contentOffset) };
}
