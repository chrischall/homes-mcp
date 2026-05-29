/**
 * Community-vocabulary resolution for server-side feature extraction.
 *
 * The extraction itself — `extractFeatures` + the `ExtractedFeatures`
 * shape — now lives in `@chrischall/realty-core` (realty-mcp#1, round-4
 * candidate J), reconciling the five cohort copies (zillow / redfin /
 * compass / homes / onehome) into one canonical, I/O-free helper. We
 * re-export it here so existing imports (`../features.js`) keep working.
 *
 * What stays local is `loadCommunities`: it does filesystem I/O (reads a
 * JSON file named by `HOMES_COMMUNITIES_FILE`), and realty-core is
 * dependency- and I/O-free by invariant. It produces the
 * `communities: string[]` vocabulary that callers pass to
 * `extractFeatures` as its second argument.
 *
 * Behavior note (canonical basement detector): realty-core uses
 * onehome's tighter `BASEMENT_CONNECTOR` conjunct class rather than the
 * loose `[^.!?]{0,30}?` window homes previously shipped. The connector
 * must directly follow `basement` (modulo whitespace), so prose like
 * "basement with finished oak shelving" no longer false-positives to
 * `basement: 'finished'` — the preposition "with" is rejected and the
 * result is `'unknown'`. See `tests/features.test.ts` for the pins.
 */

import { existsSync, readFileSync } from 'node:fs';

export { extractFeatures } from '@chrischall/realty-core';
export type { ExtractedFeatures } from '@chrischall/realty-core';

/**
 * Default community vocabulary for the Lake Lure / mountain-NC market.
 * Users in other markets can override via the `HOMES_COMMUNITIES_FILE`
 * env var (JSON file containing a string array) — see `loadCommunities`.
 */
export const DEFAULT_COMMUNITIES: string[] = [
  'Rumbling Bald',
  'Riverbend at Lake Lure',
  'The Lodges at Eagles Nest',
  'Hunters Ridge',
  'Beech Mountain Club',
  'The Cliffs',
  'Pinnacle Ridge',
  'Highland Heights',
  'Shelter Rock',
  'Charter Hills',
];

let cachedCommunities: string[] | null = null;
let cachedPath: string | null = null;
// Remembers paths we've already failed to load (missing / malformed /
// non-array) so we don't re-stat + re-warn on every `format()` call when
// a user has `HOMES_COMMUNITIES_FILE` pointed at a bad path. Cleared
// whenever the env var changes or is unset, mirroring the positive cache.
let cachedFallbackForPath: string | null = null;

/**
 * Resolve the active community vocabulary. Reads `HOMES_COMMUNITIES_FILE`
 * (expects a JSON string array). Falls back to `DEFAULT_COMMUNITIES` when
 * unset, the file is missing, or the JSON is malformed (with a stderr
 * warning so misconfiguration is visible). Cached per process keyed by
 * the env-var value — including the negative case, so a misconfigured
 * path doesn't re-stat the filesystem on every call.
 */
export function loadCommunities(): string[] {
  const path = process.env.HOMES_COMMUNITIES_FILE?.trim();
  if (!path) {
    cachedCommunities = null;
    cachedPath = null;
    cachedFallbackForPath = null;
    return DEFAULT_COMMUNITIES;
  }
  if (cachedCommunities && cachedPath === path) {
    return cachedCommunities;
  }
  if (cachedFallbackForPath === path) {
    return DEFAULT_COMMUNITIES;
  }
  if (!existsSync(path)) {
    console.error(
      `[homes-mcp] HOMES_COMMUNITIES_FILE="${path}" not found — falling back to DEFAULT_COMMUNITIES.`
    );
    cachedFallbackForPath = path;
    return DEFAULT_COMMUNITIES;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
      console.error(
        `[homes-mcp] HOMES_COMMUNITIES_FILE="${path}" must be a JSON string array — falling back to DEFAULT_COMMUNITIES.`
      );
      cachedFallbackForPath = path;
      return DEFAULT_COMMUNITIES;
    }
    cachedCommunities = parsed;
    cachedPath = path;
    cachedFallbackForPath = null;
    return cachedCommunities;
  } catch (err) {
    console.error(
      `[homes-mcp] failed to load HOMES_COMMUNITIES_FILE="${path}": ${
        err instanceof Error ? err.message : String(err)
      } — falling back to DEFAULT_COMMUNITIES.`
    );
    cachedFallbackForPath = path;
    return DEFAULT_COMMUNITIES;
  }
}
