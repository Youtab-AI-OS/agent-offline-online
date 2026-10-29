// Isolated, bounded-duration buffer parsing for truthful unconverted audio.
// No request-selected path, URL, format option, or decoder executable.
import { parseBuffer } from 'music-metadata';

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 536870912) throw new Error('Audio metadata input exceeds the media ceiling');
  chunks.push(chunk);
}
const { format } = await parseBuffer(Buffer.concat(chunks, bytes), undefined, { duration: true, skipCovers: true });
if (!Number.isFinite(format.duration) || format.duration <= 0) throw new Error('Audio duration is unavailable');
process.stdout.write(JSON.stringify({ seconds: format.duration }));
