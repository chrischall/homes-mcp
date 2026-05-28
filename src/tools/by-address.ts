import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@fetchproxy/server';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';
import { locationToSlug } from '../url.js';
import { SINGLE_RESOLVE_DEADLINE_MS, withDeadline } from './deadline.js';
import {
  buildSearchPath,
  findListings,
  extractPropertyId,
  type JsonLdListingItem,
} from './search.js';

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
   * Which rung resolved the address. `'slug'` — direct
   * `/<address-slug>/` hit. `'search_fallback'` — city/zip search-page
   * fuzzy match (#47). Lets callers see whether they got a precise
   * routing hit or a corpus-search guess.
   */
  matched_via: 'slug' | 'search_fallback';
}

export interface ByAddressUnresolved {
  resolved: false;
  error: string;
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
 * Run the single-address resolution rungs end-to-end. Two rungs in
 * sequence:
 *
 *   1. **Slug rung.** Slugify `{address, city, state, zip}` →
 *      `GET /<slug>/`. The common hit; routes to a collection or
 *      detail page on success.
 *   2. **Search-fallback rung (#47).** When the slug rung returns no
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
 * opt-in applies to both rungs — a bridge timeout in the slug rung
 * rethrows before the fallback rung fires, and a bridge timeout in
 * the fallback rung rethrows too.
 */
export interface ResolveOneAddressOpts {
  rethrowBridgeErrors?: boolean;
}

export async function resolveOneAddress(
  client: { fetchHtml: (path: string) => Promise<string> },
  input: ByAddressInput,
  opts: ResolveOneAddressOpts = {}
): Promise<ByAddressResult> {
  // Rung 1: slug.
  const slugPath = buildAddressSearchPath(input);
  try {
    const html = await client.fetchHtml(slugPath);
    const slug = resolveListing(html, 'slug');
    if (slug.resolved) return slug;
  } catch (err) {
    if (
      opts.rethrowBridgeErrors &&
      (err instanceof FetchproxyTimeoutError ||
        err instanceof FetchproxyBridgeDownError)
    ) {
      throw err;
    }
    // Fall through to the search rung.
  }

  // Rung 2: city / zip search fallback.
  const fallbackLocation = buildFallbackLocation(input);
  if (!fallbackLocation) return UNRESOLVED;
  const searchPath = buildSearchPath({ location: fallbackLocation });
  try {
    const html = await client.fetchHtml(searchPath);
    return resolveBySearchFallback(html, input);
  } catch (err) {
    if (
      opts.rethrowBridgeErrors &&
      (err instanceof FetchproxyTimeoutError ||
        err instanceof FetchproxyBridgeDownError)
    ) {
      throw err;
    }
    return UNRESOLVED;
  }
}

/** Canonical sentinel for a single-call that blew the overall deadline. */
const TIMED_OUT: ByAddressUnresolved = { resolved: false, error: 'timeout' };

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
  client: { fetchHtml: (path: string) => Promise<string> },
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
  matchedVia: 'slug' | 'search_fallback' = 'slug'
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

export function registerByAddressTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_by_address',
    {
      title: 'Resolve a street address to a homes.com property URL',
      description:
        "Resolve a US street address to its canonical homes.com property URL + opaque property hash. Pass `address` (street), `city`, `state`, and optional `zip`. Slugifies the parts into homes.com's location-routing format and parses the embedded Schema.org JSON-LD — handles both the search-results shape (CollectionPage with matching listings) and the detail-page redirect (single RealEstateListing). On a slug miss, falls back to a city/zip search page and fuzzy-matches street tokens (rural/locality-mismatched addresses). Returns `{ url, property_hash, street_address, matched_via, resolved: true }` on success — `matched_via` is `'slug'` for a direct routing hit, `'search_fallback'` for the search-page fuzzy match — or `{ resolved: false, error: 'no listing found' }` when homes.com has no match (so the higher-level unified canonical-URL lookup can degrade gracefully). KNOWN FAILURE MODES: (a) rural addresses and very-new construction often miss because homes.com hasn't indexed them yet, (b) the resolver picks the FIRST listing on a collection redirect — if homes.com returns multiple loose matches, you may get a wrong-but-plausible neighbour. Compare the returned `street_address` against your input to catch this. For larger batches (≥ 3 addresses), prefer `homes_resolve_addresses`. Read-only; safe to call repeatedly.",
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
