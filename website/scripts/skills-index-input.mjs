// Catalogs are build inputs, not arbitrary downloads. Keep remote bodies bounded
// and validate the existing v1 builder contract before publishing a local copy.
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_SKILLS = 200000;

export function validateSkillsIndex(text) {
  const index = JSON.parse(text);
  if (!index || typeof index !== 'object' || Array.isArray(index) || index.version !== 1 ||
      !Array.isArray(index.skills) || index.skills.length > MAX_SKILLS ||
      index.skill_count !== index.skills.length || typeof index.generated_at !== 'string' ||
      !Number.isFinite(Date.parse(index.generated_at))) throw new Error('Invalid v1 skills index');
  for (const skill of index.skills) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill) ||
        !['name', 'description', 'source', 'identifier'].every(key => typeof skill[key] === 'string') ||
        !skill.name || !skill.source || !skill.identifier ||
        !Array.isArray(skill.tags) || !skill.tags.every(tag => typeof tag === 'string')) {
      throw new Error('Invalid skills index item');
    }
  }
  return text;
}

export async function fetchSkillsIndex(url, fetchImpl = fetch) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.origin !== 'https://youtab-agent-runtime.youtab.io' ||
      endpoint.pathname !== '/docs/api/skills-index.json' || endpoint.search || endpoint.hash) {
    throw new Error('Untrusted skills index endpoint');
  }
  const response = await fetchImpl(endpoint.href, {
    headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Skills index HTTP ${response.status}`);
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_INDEX_BYTES)) {
    await response.body?.cancel();
    throw new Error('Skills index exceeds download limit');
  }
  if (!response.body) throw new Error('Skills index body missing');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INDEX_BYTES) throw new Error('Skills index exceeds download limit');
      chunks.push(value);
    }
    return validateSkillsIndex(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
