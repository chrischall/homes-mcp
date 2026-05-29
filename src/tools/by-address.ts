import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  withDeadline,
} from '@fetchproxy/server';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';
import { locationToSlug } from '../url.js';
import {
  buildSearchPath,
  findListings,
  extractPropertyId,
  type JsonLdListingItem,
} from './search.js';
import {
  SMARTSEARCH_AUTOCOMPLETE_PATH,
  buildAutocompleteBody,
  extractAddressCandidates,
  type SmartsearchCandidate,
  type SmartsearchResponse,
} from './typeahead.js';

/**
 * `homes_get_by_address` — resolve a free-text address into a canonical
 * homes.com property URL + property hash.
 *
 * homes.com indexes properties under an opaque base36-ish hash in the URL
 * (e.g. `/property/<address-slug>/rxrzwg0kjnr32/`), so an agent can't
 * construct a property URL from an address alone — it needs a server-side
 * resolution step. This tool is the resolution step for the cross-site
 * `get_property_canonical_links` unified caller (see compass-mcp,
 * zillow-mcp, redfin-mcp for the matching siblings).
 *
 * Implementation: slugify `{address, city, state, zip}` into a single
 * homes.com location slug and `GET /<slug>/`. homes.com routes this to
 * one of two SSR shapes — same JSON-LD-only contract every other tool
 * uses:
 *
 *   - **Collection redirect.** A `CollectionPage.mainEntity.itemListElement[]`
 *     where the first listing is the address match. This is the common
 *     case — `homes_search_properties` parses the same shape.
 *   - **Detail redirect.** When the address is unambiguous homes.com
 *     skips the search-results step and serves the detail page directly
 *     (single `RealEstateListing` graph node). Same shape as
 *     `homes_get_property`.
 *
 * **Graceful degradation.** When no listing is found — empty results,
 * missing JSON-LD (404-style page), or any error from the transport
 * (non-2xx, sign-in interstitial, transport failure) — we return
 * `{ resolved: false, error: 'no listing found' }` instead of throwing.
 * The unified caller fans out to multiple sites in parallel and needs
 * per-site failures to be partial, not fatal.
 */

export interface ByAddressInput {
  address: string;
  city: string;
  state: string;
  zip?: string;
}

export interface ByAddressResolved {
  url: string;
  property_hash: string;
  street_address: string;
  resolved: true;
  /**
   * Which rung resolved the address. `'typeahead'` — structured
   * smartsearch autocomplete hit (#55, the primary rung). `'slug'` —
   * direct `/<address-slug>/` routing hit. `'search_fallback'` —
   * city/zip search-page fuzzy match (#47). Lets callers see whether
   * they got the structured-API match, a precise routing hit, or a
   * corpus-search guess.
   */
  matched_via: 'typeahead' | 'slug' | 'search_fallback';
}

export interface ByAddressUnresolved {
  resolved: false;
  error: string;
  /**
   * Transport-timeout taxonomy (#64). Present (and `'timeout'`) only when
   * the resolution failed because a fetchproxy transport call timed out /
   * the bridge was down — NOT when homes.com genuinely had no match. A
   * cold-bridge timeout is indistinguishable from a real miss without
   * this discriminator, which is exactly what produced the false
   * "homes.com zero coverage" conclusion. Absent on a genuine miss.
   */
  status?: 'timeout';
  /** True alongside `status: 'timeout'` — the caller should retry. */
  retryable?: boolean;
}

export type ByAddressResult = ByAddressResolved | ByAddressUnresolved;

/**
 * Build the homes.com address-search path from address parts. Reuses
 * `locationToSlug` so slugification matches every other location-based
 * tool exactly — diacritics stripped, punctuation collapsed to `-`,
 * leading/trailing dashes trimmed.
 *
 * Example: `{ "126 Sleeping Bear Ln", "Lake Lure", "NC", "28746" }` →
 * `/126-sleeping-bear-ln-lake-lure-nc-28746/`.
 */
export function buildAddressSearchPath(input: ByAddressInput): string {
  const joined = [input.address, input.city, input.state, input.zip ?? '']
    .filter((s) => s && s.trim().length > 0)
    .join(' ');
  const slug = locationToSlug(joined);
  return `/${slug}/`;
}

const UNRESOLVED: ByAddressUnresolved = {
  resolved: false,
  error: 'no listing found',
};

/**
 * Transport-timeout outcome for the single path (#64). A cold-bridge
 * fetchproxy timeout / SW eviction in any rung means we genuinely don't
 * know whether homes.com has the listing — distinct from a confirmed
 * miss. Surfaced as a retryable `status: 'timeout'` so a caller (and the
 * unified canonical-URL fan-out) can tell "retry me" from "not on this
 * site", instead of recording a false hard miss.
 */
const BRIDGE_TIMED_OUT: ByAddressUnresolved = {
  resolved: false,
  status: 'timeout',
  retryable: true,
  error: 'bridge timeout — homes.com did not respond; retry',
};

/**
 * True for the two fetchproxy transport-failure errors that mean
 * "we never got an answer" (vs. a genuine empty result): a per-request
 * timeout or a service-worker eviction. Both are retryable and must NOT
 * collapse onto the `'no listing found'` miss sentinel (#64).
 */
function isBridgeTimeout(err: unknown): boolean {
  return (
    err instanceof FetchproxyTimeoutError ||
    err instanceof FetchproxyBridgeDownError
  );
}

/**
 * Pull a `RealEstateListing` directly off the JSON-LD graph. homes.com
 * emits this when an address-search slug resolves unambiguously to a
 * single property — homes.com SSRs the detail page in-place rather than
 * a one-item collection wrapper.
 */
interface DirectListing {
  url?: string;
  '@id'?: string;
  mainEntity?: {
    address?: { streetAddress?: string };
  };
}

function asListingItem(listing: DirectListing): JsonLdListingItem {
  return {
    url: listing.url,
    '@id': listing['@id'],
    mainEntity: listing.mainEntity,
  };
}

/**
 * Minimal client surface the resolver needs: `fetchHtml` for the SSR
 * slug/search rungs and `fetchJson` for the structured typeahead rung.
 * `fetchJson` is optional so a `{ fetchHtml }`-only test double still
 * type-checks — a missing method simply skips the typeahead rung.
 */
export interface ResolveClient {
  fetchHtml: (path: string) => Promise<string>;
  fetchJson?: <T>(
    path: string,
    init?: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    }
  ) => Promise<T>;
}

/**
 * Run the single-address resolution rungs end-to-end. Three rungs in
 * sequence:
 *
 *   0. **Typeahead rung (#55, PRIMARY).** POST the joined address to the
 *      structured smartsearch autocomplete endpoint
 *      (`/routes/res/consumer/smartsearch/autocomplete/`) and verify
 *      each candidate's street (+ unit) against the input with the
 *      whole-token matcher. The candidates carry the REAL detail URL
 *      (`/property/<slug>/<hash>/`) + opaque hash, so a verified match
 *      resolves precisely. This replaces the slug rung's URL guessing,
 *      which 404s for many real listings → false "no listing found".
 *      A throw / empty / unverifiable result falls through to the SSR
 *      rungs cleanly.
 *   1. **Slug rung.** Slugify `{address, city, state, zip}` →
 *      `GET /<slug>/`. Retained as fallback; routes to a collection or
 *      detail page on success.
 *   2. **Search-fallback rung (#47).** When the rungs above return no
 *      listing (404, empty collection, no JSON-LD), fall through to
 *      the city/zip search page (the same path shape `search.ts`
 *      builds via `buildSearchPath`), then address-fuzzy-match the
 *      results. Load-bearing for rural / locality-mismatched
 *      addresses that the slug routing misses.
 *
 * Single- and bulk-address tools MUST go through this helper so a
 * future change to the resolution strategy lands in both at once.
 * Transport / non-2xx / sign-in interstitials at any rung are caught
 * and surfaced as the graceful `'no listing found'` outcome (#45).
 *
 * Bulk callers can opt into `rethrowBridgeErrors: true` to surface
 * `FetchproxyTimeoutError` / `FetchproxyBridgeDownError` distinctly
 * (round-3 zillow #78: bridge timeouts must NEVER be reported as
 * "no listing found" in a 60-row batch summary). The single-call
 * default keeps swallowing every transport error so the unified
 * canonical-URL caller can treat the row as "not on this site"
 * rather than a system failure — the existing parity contract for
 * generic `Error('network down')`-style failures is preserved. The
 * opt-in applies to every rung — a bridge timeout in any rung rethrows
 * before the next rung fires.
 */
export interface ResolveOneAddressOpts {
  rethrowBridgeErrors?: boolean;
}

export async function resolveOneAddress(
  client: ResolveClient,
  input: ByAddressInput,
  opts: ResolveOneAddressOpts = {}
): Promise<ByAddressResult> {
  // Track whether ANY rung failed with a fetchproxy transport timeout /
  // bridge-down error (#64). If every rung fails to resolve and at least
  // one failed because the bridge never answered, we surface a retryable
  // `status: 'timeout'` rather than the genuine-miss `'no listing found'`
  // sentinel — a cold-bridge timeout is not a confirmed coverage gap.
  let sawBridgeTimeout = false;

  // Rung 0: structured smartsearch typeahead (#55) — the primary rung.
  // Routes around the slug rung's URL guessing that 404s real listings.
  if (typeof client.fetchJson === 'function') {
    try {
      const resp = await client.fetchJson<SmartsearchResponse>(
        SMARTSEARCH_AUTOCOMPLETE_PATH,
        { method: 'POST', body: buildAutocompleteBody(input) }
      );
      const match = resolveByTypeahead(resp, input);
      if (match.resolved) return match;
    } catch (err) {
      if (opts.rethrowBridgeErrors && isBridgeTimeout(err)) throw err;
      if (isBridgeTimeout(err)) sawBridgeTimeout = true;
      // Fall through to the slug rung.
    }
  }

  // Rung 1: slug.
  const slugPath = buildAddressSearchPath(input);
  try {
    const html = await client.fetchHtml(slugPath);
    const slug = resolveListing(html, 'slug');
    if (slug.resolved) return slug;
  } catch (err) {
    if (opts.rethrowBridgeErrors && isBridgeTimeout(err)) throw err;
    if (isBridgeTimeout(err)) sawBridgeTimeout = true;
    // Fall through to the search rung.
  }

  // Rung 2: city / zip search fallback.
  const fallbackLocation = buildFallbackLocation(input);
  if (!fallbackLocation) return sawBridgeTimeout ? BRIDGE_TIMED_OUT : UNRESOLVED;
  const searchPath = buildSearchPath({ location: fallbackLocation });
  try {
    const html = await client.fetchHtml(searchPath);
    const fallback = resolveBySearchFallback(html, input);
    if (fallback.resolved) return fallback;
    // Search page came back but had no fuzzy match. If an EARLIER rung
    // timed out on the bridge, this "empty" search page can't downgrade
    // a genuine-unknown to a confirmed miss — keep the timeout taxonomy.
    return sawBridgeTimeout ? BRIDGE_TIMED_OUT : fallback;
  } catch (err) {
    if (opts.rethrowBridgeErrors && isBridgeTimeout(err)) throw err;
    if (isBridgeTimeout(err)) sawBridgeTimeout = true;
    return sawBridgeTimeout ? BRIDGE_TIMED_OUT : UNRESOLVED;
  }
}

/**
 * Hard overall deadline for a single `homes_get_by_address` call (#54).
 * A single address runs at most two fetch rungs, each bounded by the
 * transport's ~30s `fetchTimeoutMs`; without a wrapper that's up to ~60s,
 * which races the MCP client's own deadline. Cap it below that so a hung
 * fetch returns a clean `{ resolved: false, error: 'timeout' }` instead
 * of an infinite hang.
 *
 * `withDeadline` itself now lives in `@fetchproxy/server` (promoted from
 * homes-mcp's local `src/tools/deadline.ts` in fetchproxy#86); only this
 * homes-specific deadline value stays here.
 */
const SINGLE_RESOLVE_DEADLINE_MS = 45_000;

/**
 * Canonical sentinel for a single-call that blew the overall deadline.
 * Carries the same retryable `status: 'timeout'` taxonomy as a per-rung
 * bridge timeout (#64) so callers branch on one shape regardless of
 * whether an individual rung timed out or the whole call ran long.
 */
const TIMED_OUT: ByAddressUnresolved = {
  resolved: false,
  status: 'timeout',
  retryable: true,
  error: 'timeout',
};

/**
 * `resolveOneAddress` wrapped in a hard overall deadline (#54).
 *
 * Both fetch rungs are individually bounded by the transport's ~30s
 * `fetchTimeoutMs`, but back-to-back that's ~60s — right at the MCP
 * client's request deadline, which is how a single hung
 * `homes_get_by_address` ended up wedging the connection with a
 * `-32001`. Cap the whole resolution below that and return a clean
 * `{ resolved: false, error: 'timeout' }` instead of hanging. The
 * underlying fetch is left to settle in the background; we just stop
 * waiting on it.
 */
export async function resolveOneAddressDeadlined(
  client: ResolveClient,
  input: ByAddressInput,
  deadlineMs: number = SINGLE_RESOLVE_DEADLINE_MS,
  opts: ResolveOneAddressOpts = {}
): Promise<ByAddressResult> {
  const outcome = await withDeadline(
    resolveOneAddress(client, input, opts),
    deadlineMs
  );
  return outcome.timedOut ? TIMED_OUT : outcome.value;
}

/**
 * Pick the location string handed to `buildSearchPath` for the fallback
 * rung. Prefer `"city, state"` (matches every other location-based
 * tool); fall back to `zip` if `city + state` are absent.
 *
 * City-only or state-only locality shapes are intentionally rejected —
 * a bare `"NC"` or `"Springfield"` produces a state-wide / ambiguous
 * search whose results are too broad for the fuzzy matcher to safely
 * pick from. ZIP-only stays (narrow enough to be useful).
 */
function buildFallbackLocation(input: ByAddressInput): string | null {
  const city = input.city?.trim();
  const state = input.state?.trim();
  if (city && state) return `${city}, ${state}`;
  if (input.zip?.trim()) return input.zip.trim();
  return null;
}

export function resolveListing(
  html: string,
  matchedVia: 'typeahead' | 'slug' | 'search_fallback' = 'slug'
): ByAddressResult {
  const doc = extractJsonLd(html);
  if (!doc) return UNRESOLVED;

  // Detail-page shape: a single RealEstateListing node in the graph.
  const direct = findGraphNode(doc, 'RealEstateListing') as DirectListing | null;
  if (direct) {
    const item = asListingItem(direct);
    const hash = extractPropertyId(item);
    if (hash) {
      return {
        url: item.url ?? item['@id']?.replace(/[?#].*$/, '') ?? '',
        property_hash: hash,
        street_address: item.mainEntity?.address?.streetAddress ?? '',
        resolved: true,
        matched_via: matchedVia,
      };
    }
  }

  // Collection-page shape: take the first listing.
  const { items } = findListings(doc);
  for (const item of items) {
    const hash = extractPropertyId(item);
    if (!hash) continue;
    return {
      url: item.url ?? item['@id']?.replace(/[?#].*$/, '') ?? '',
      property_hash: hash,
      street_address: item.mainEntity?.address?.streetAddress ?? '',
      resolved: true,
      matched_via: matchedVia,
    };
  }

  return UNRESOLVED;
}

/**
 * Parse a city/zip search-fallback page and pick the listing whose
 * street address fuzzy-matches `input.address`. Token-set comparison
 * keyed on normalized alphanumeric segments (street number + name).
 */
function resolveBySearchFallback(
  html: string,
  input: ByAddressInput
): ByAddressResult {
  const doc = extractJsonLd(html);
  if (!doc) return UNRESOLVED;
  const { items } = findListings(doc);
  if (items.length === 0) return UNRESOLVED;

  const wanted = streetTokens(input.address);
  if (wanted.size === 0) return UNRESOLVED;

  let best: { item: JsonLdListingItem; score: number } | null = null;
  for (const item of items) {
    const street = item.mainEntity?.address?.streetAddress;
    if (!street) continue;
    const got = streetTokens(street);
    if (got.size === 0) continue;
    // Require the street number (first numeric token, if present)
    // to match — guards against same-name streets at different
    // numbers in the same city.
    const wantNum = firstNumericToken(input.address);
    const gotNum = firstNumericToken(street);
    if (wantNum && gotNum && wantNum !== gotNum) continue;
    let overlap = 0;
    for (const t of wanted) if (got.has(t)) overlap += 1;
    const score = overlap / wanted.size;
    if (!best || score > best.score) best = { item, score };
  }

  // Require a strict majority of the input's street tokens to match.
  // `<= 0.5` rejects exact-half overlap — for 2-token input like
  // "Main St", a single common token (e.g. "st") would clear a `< 0.5`
  // bar and pick an unrelated listing.
  if (!best || best.score <= 0.5) return UNRESOLVED;
  const hash = extractPropertyId(best.item);
  if (!hash) return UNRESOLVED;
  return {
    url: best.item.url ?? best.item['@id']?.replace(/[?#].*$/, '') ?? '',
    property_hash: hash,
    street_address: best.item.mainEntity?.address?.streetAddress ?? '',
    resolved: true,
    matched_via: 'search_fallback',
  };
}

/**
 * Verify the structured smartsearch candidates against the input and
 * pick the matching one (#55). Reuses the same whole-token street
 * matcher the search-fallback rung uses (street-number guard + strict-
 * majority token overlap), then layers a UNIT guard on top: if the
 * input names a unit (`Unit 1601`, `#1601`, `Apt 1601`, …), the chosen
 * candidate MUST carry that exact unit — multi-unit buildings return
 * one candidate per unit, and accepting a neighbour unit would point a
 * tracker at the wrong condo. Returns the canonical `'no listing found'`
 * sentinel when nothing verifies (no URL leak).
 */
function resolveByTypeahead(
  resp: SmartsearchResponse | null | undefined,
  input: ByAddressInput
): ByAddressResult {
  const candidates = extractAddressCandidates(resp);
  if (candidates.length === 0) return UNRESOLVED;

  const wanted = streetTokens(input.address);
  if (wanted.size === 0) return UNRESOLVED;
  const wantNum = firstNumericToken(input.address);
  const wantUnit = unitToken(input.address);

  let best: { candidate: SmartsearchCandidate; score: number } | null = null;
  for (const c of candidates) {
    // The candidate's street line for token comparison: prefer the
    // structured `street` (+ explicit `unit`), falling back to the
    // display name. The display already folds in the unit.
    const candidateLine = c.street
      ? `${c.street} ${c.unit ?? ''}`.trim()
      : c.display;
    const got = streetTokens(candidateLine);
    if (got.size === 0) continue;

    // Street-number guard — same as the search-fallback rung.
    const gotNum = firstNumericToken(c.street ?? c.display);
    if (wantNum && gotNum && wantNum !== gotNum) continue;

    // Unit guard. If the input names a unit, the candidate must carry
    // the same one (from the structured `unit` field or its display).
    if (wantUnit) {
      const gotUnit = c.unit ? c.unit.toLowerCase() : unitToken(c.display);
      if (!gotUnit || gotUnit !== wantUnit) continue;
    }

    let overlap = 0;
    for (const t of wanted) if (got.has(t)) overlap += 1;
    const score = overlap / wanted.size;
    if (!best || score > best.score) best = { candidate: c, score };
  }

  // Strict-majority overlap, same bar as the search-fallback rung.
  if (!best || best.score <= 0.5) return UNRESOLVED;
  const c = best.candidate;
  const street = c.street ?? c.display.split(',')[0] ?? '';
  return {
    url: c.url.startsWith('http')
      ? c.url.replace(/[?#].*$/, '')
      : `https://www.homes.com${c.url.replace(/[?#].*$/, '')}`,
    property_hash: c.property_hash,
    street_address: street,
    resolved: true,
    matched_via: 'typeahead',
  };
}

function streetTokens(street: string): Set<string> {
  return new Set(
    street
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0)
  );
}

function firstNumericToken(street: string): string | null {
  const m = street.match(/\d+/);
  return m ? m[0] : null;
}

/**
 * Extract the unit/apt designator from an address line, lowercased, or
 * null. Matches `Unit 1601`, `Apt 4B`, `Ste 200`, `# 3`, `#1601`. Used
 * by the typeahead verifier to keep multi-unit candidates from
 * collapsing onto the wrong unit.
 */
function unitToken(line: string): string | null {
  const m = line.match(/(?:\b(?:unit|apt|apartment|ste|suite|no)\b\.?\s*|#\s*)([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function registerByAddressTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_by_address',
    {
      title: 'Resolve a street address to a homes.com property URL',
      description:
        "Resolve a US street address to its canonical homes.com property URL + opaque property hash. Pass `address` (street), `city`, `state`, and optional `zip`. Walks three rungs: first the structured smartsearch typeahead (POST /routes/res/consumer/smartsearch/autocomplete/ — the primary rung, the same address-suggest API homes.com's search box fires, returning the real /property/<slug>/<hash>/ URL directly), then a slug-routed page (parsing the embedded Schema.org JSON-LD — both the CollectionPage search-results shape and the single-RealEstateListing detail redirect), and finally a city/zip search page with street-token fuzzy match. Every candidate is verified against the input with a whole-token street match (plus a unit guard so a multi-unit building resolves to the exact unit, not a neighbour). Returns `{ url, property_hash, street_address, matched_via, resolved: true }` on success — `matched_via` is `'typeahead'` for the structured-API hit, `'slug'` for a direct routing hit, `'search_fallback'` for the search-page fuzzy match — or `{ resolved: false, error: 'no listing found' }` when homes.com has no match (so the higher-level unified canonical-URL lookup can degrade gracefully). KNOWN FAILURE MODE: rural addresses and very-new construction can still miss because homes.com hasn't indexed them yet. Compare the returned `street_address` against your input to confirm. For larger batches (≥ 3 addresses), prefer `homes_resolve_addresses`. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Resolve a street address to a homes.com property URL',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        address: z
          .string()
          .describe('Street address (e.g. "126 Sleeping Bear Ln").'),
        city: z.string().describe('City (e.g. "Lake Lure").'),
        state: z
          .string()
          .describe('2-letter US state code (e.g. "NC").'),
        zip: z
          .string()
          .optional()
          .describe('ZIP code (optional; improves precision when present).'),
      },
    },
    async (input) =>
      // #54: cap the whole single-address resolution (slug rung +
      // search-fallback rung, each bounded by the transport's ~30s
      // fetchTimeoutMs) below the MCP client's request deadline. A hung
      // homes.com fetch returns a clean { resolved: false, error:
      // 'timeout' } instead of wedging the connection until the client
      // tears it down with a -32001.
      textResult(await resolveOneAddressDeadlined(client, input))
  );
}
