import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';
import { locationToSlug } from '../url.js';
import {
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

export function resolveListing(html: string): ByAddressResult {
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
    };
  }

  return UNRESOLVED;
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
        "Resolve a US street address to its canonical homes.com property URL + opaque property hash. Pass `address` (street), `city`, `state`, and optional `zip`. Slugifies the parts into homes.com's location-routing format and parses the embedded Schema.org JSON-LD — handles both the search-results shape (CollectionPage with matching listings) and the detail-page redirect (single RealEstateListing). Returns `{ url, property_hash, street_address, resolved: true }` on success, or `{ resolved: false, error: 'no listing found' }` when homes.com has no match (so the higher-level unified canonical-URL lookup can degrade gracefully). Read-only; safe to call repeatedly.",
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
    async (input) => {
      const path = buildAddressSearchPath(input);
      let html: string;
      try {
        html = await client.fetchHtml(path);
      } catch {
        // Transport / non-2xx / sign-in interstitial — surface as the
        // graceful "not resolved" outcome rather than propagating to the
        // unified caller as a fatal error.
        return textResult(UNRESOLVED);
      }
      return textResult(resolveListing(html));
    }
  );
}
