import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';
import { locationToSlug } from '../url.js';

/**
 * homes.com search-results are server-rendered at
 *   GET /<city-slug>-<state>/   (or /<zip>/)
 *
 * Every page embeds a Schema.org `<script type="application/ld+json">`
 * block whose `@graph` contains a `CollectionPage`. The interesting
 * payload lives at
 *   collectionPage.mainEntity.itemListElement[]
 * — each entry is a `[RealEstateListing, Product]` node with `name`,
 * `url`, `image`, `offers`, and a nested `mainEntity` carrying address,
 * size, and bed/bath counts.
 *
 * Detail-page items on the search page have NO `geo` block — lat/lng
 * is only present on the property detail page. The richer record from
 * `homes_get_property` is the right tool when you need coordinates.
 *
 * Verified live 2026-05-24 against:
 *   - https://www.homes.com/atlanta-ga/
 *   - https://www.homes.com/brooklyn-ny/
 */

interface JsonLdAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
}

interface JsonLdFloorSize {
  value?: number | string;
  unitCode?: string;
}

interface JsonLdAgent {
  name?: string;
  telephone?: string;
  jobTitle?: string;
  image?: string;
  memberOf?: { name?: string } | { name?: string }[];
}

interface JsonLdOffer {
  price?: number | string;
  priceCurrency?: string;
  availability?: string;
  seller?: { name?: string };
  offeredBy?: JsonLdAgent | JsonLdAgent[];
}

export interface JsonLdMainEntity {
  '@type'?: string | string[];
  numberOfBedrooms?: number | string;
  numberOfBathroomsTotal?: number | string;
  floorSize?: JsonLdFloorSize;
  address?: JsonLdAddress;
  url?: string;
  image?: string | string[];
  geo?: { latitude?: number | string; longitude?: number | string };
  yearBuilt?: number | string;
}

export interface JsonLdListingItem {
  '@type'?: string | string[];
  '@id'?: string;
  name?: string;
  description?: string;
  url?: string;
  image?: string | string[];
  position?: number;
  offers?: JsonLdOffer;
  mainEntity?: JsonLdMainEntity;
}

export interface FormattedHome {
  property_id: string;
  url: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  price?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  primary_photo_url?: string;
  listing_agent?: string;
  brokerage?: string;
  status?: string;
}

/** Coerce a number-or-string into a finite number, or undefined. */
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    // Strip any non-numeric punctuation (commas, $, etc.) before parsing.
    const cleaned = v.replace(/[^0-9.-]/g, '');
    if (cleaned === '') return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Pull the first image URL out of a string-or-string-array field. */
function firstImage(image: string | string[] | undefined): string | undefined {
  if (!image) return undefined;
  if (typeof image === 'string') return image;
  return image[0];
}

/**
 * Derive a homes.com "property id" from a listing's `@id` or `url`.
 *
 * Property detail URLs look like
 *   https://www.homes.com/property/<slug>/<propertyId>/
 * where <propertyId> is a short base36-ish token (e.g. `rxrzwg0kjnr32`).
 * We treat the last non-empty path segment as the id — this round-trips
 * the search results into a stable identifier callers can use.
 */
export function extractPropertyId(item: JsonLdListingItem): string {
  const source = item['@id'] ?? item.url ?? '';
  // Take the last non-empty segment of the path.
  const path = source.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  const segments = path.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? '';
}

/** Extract an agent record from an offeredBy field (object or array). */
function firstAgent(offeredBy: JsonLdOffer['offeredBy']): JsonLdAgent | undefined {
  if (!offeredBy) return undefined;
  if (Array.isArray(offeredBy)) return offeredBy[0];
  return offeredBy;
}

/** Extract the brokerage name from an agent's `memberOf` (object or array). */
function brokerageFrom(agent: JsonLdAgent | undefined): string | undefined {
  if (!agent?.memberOf) return undefined;
  if (Array.isArray(agent.memberOf)) return agent.memberOf[0]?.name;
  return agent.memberOf.name;
}

export function formatHome(item: JsonLdListingItem): FormattedHome | null {
  const id = extractPropertyId(item);
  if (!id) return null;
  const main = item.mainEntity ?? {};
  const addr = main.address ?? {};
  const offers = item.offers ?? {};
  const agent = firstAgent(offers.offeredBy);
  const sqft =
    main.floorSize && (main.floorSize.unitCode === 'FTK' || !main.floorSize.unitCode)
      ? toNumber(main.floorSize.value)
      : toNumber(main.floorSize?.value);
  // homes.com URL is normally fully-qualified in JSON-LD. Fall back to
  // the @id if `url` is missing.
  const url = item.url ?? item['@id'] ?? '';
  return {
    property_id: id,
    url,
    address: addr.streetAddress,
    city: addr.addressLocality,
    state: addr.addressRegion,
    zip: addr.postalCode,
    price: toNumber(offers.price),
    beds: toNumber(main.numberOfBedrooms),
    baths: toNumber(main.numberOfBathroomsTotal),
    sqft,
    primary_photo_url: firstImage(item.image) ?? firstImage(main.image),
    listing_agent: agent?.name,
    brokerage: brokerageFrom(agent) ?? offers.seller?.name,
    status: offers.availability,
  };
}

export interface SearchInput {
  location: string;
  limit?: number;
}

/**
 * Build the `/<location-slug>/` path for a search.
 *
 * homes.com routes locations like `/atlanta-ga/`, `/brooklyn-ny/`,
 * `/30311/` (ZIPs). v0.1 doesn't compose URL-path filters — the
 * site's own canonical URL shape for filters is `?…` query-string
 * facets that change frequently, and we can't probe them safely
 * without driving real WAF challenges. So we hand the location off to
 * homes.com and let the user re-rank client-side.
 */
export function buildSearchPath(input: SearchInput): string {
  const slug = locationToSlug(input.location);
  return `/${slug}/`;
}

interface CollectionPageMainEntity {
  numberOfItems?: number;
  itemListElement?: JsonLdListingItem[];
}

interface CollectionPage {
  '@type'?: string | string[];
  mainEntity?: CollectionPageMainEntity;
}

/**
 * Pull the listings array out of a parsed JSON-LD document. homes.com
 * search pages put it at `CollectionPage.mainEntity.itemListElement`.
 */
export function findListings(doc: ReturnType<typeof extractJsonLd>): {
  total?: number;
  items: JsonLdListingItem[];
} {
  const page = findGraphNode(doc, 'CollectionPage') as CollectionPage | null;
  const main = page?.mainEntity;
  return {
    total: main?.numberOfItems,
    items: main?.itemListElement ?? [],
  };
}

export function registerSearchTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_search_properties',
    {
      title: 'Search homes.com listings',
      description:
        "Search homes.com listings by free-text location (city, ZIP, neighborhood). Slugifies the input into homes.com's URL routing (e.g. 'Atlanta, GA' → /atlanta-ga/, '94110' → /94110/) and fetches the SSR search page. Parses the embedded Schema.org JSON-LD to return each listing's address, price, beds/baths, sqft, primary photo, listing agent + brokerage, and the homes.com property URL. v0.1 does not encode price/bed/home-type filters into the URL — pass the location and re-rank the results client-side. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Search homes.com listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        location: z
          .string()
          .describe(
            'Free-text location: city, ZIP, neighborhood (e.g. "Atlanta, GA", "Brooklyn, NY", "30311", "Park Slope")'
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max listings to return (default 40, the search-page size).'),
      },
    },
    async (input) => {
      const path = buildSearchPath(input);
      const html = await client.fetchHtml(path);
      const doc = extractJsonLd(html);
      if (!doc) {
        throw new Error(
          `homes_search_properties: could not locate JSON-LD on ${path}. ` +
            `homes.com may have changed their page structure.`
        );
      }
      const { total, items } = findListings(doc);
      const limit = input.limit ?? 40;
      const formatted = items
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null)
        .slice(0, limit);
      return textResult({
        search_path: path,
        total_items: total,
        count: formatted.length,
        results: formatted,
      });
    }
  );
}
