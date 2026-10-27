// Log fields remain one physical line; control bytes cannot forge records or
// terminal commands. This is framing, not a substitute for secret redaction.
export function logField(value) {
  let text;
  try {
    text = value instanceof Error ? value.stack || value.message
      : typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = '[unserializable log field]';
  }
  // Limit source text to 16K code units; escaping can expand this to 96K.
  text = text.slice(0, 16384).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return text.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function logLine(...args) {
  // Joining before emission also prevents console's format-string substitution.
  return args.map(logField).join(' ');
}
