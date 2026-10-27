/**
 * Customer builds retain the GitNexus Explorer skill, but must not start its
 * unauthenticated web/API bridge. A commercial license alone is insufficient
 * to qualify the bridge's authorization and Windows asset-admission behavior.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GITNEXUS_LICENSE_URL = 'https://github.com/abhigyanpatwari/GitNexus#enterprise';
export const GITNEXUS_DISABLED_MESSAGE =
  `GitNexus integration is unavailable in this Youtab build. Obtain commercial rights from ${GITNEXUS_LICENSE_URL}; ` +
  'Youtab must separately qualify a pinned dependency and authenticated local bridge before enabling it.';

export function createGitNexusProxy() {
  throw new Error(GITNEXUS_DISABLED_MESSAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.error(GITNEXUS_DISABLED_MESSAGE);
  process.exitCode = 1;
}
