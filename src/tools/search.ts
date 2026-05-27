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
  // Prefer `url` over `@id` because homes.com's @id now includes a
  // `#realestatelisting` fragment — if @id is "…/abc123/#realestatelisting"
  // and we take the last path segment, we get the fragment, not the id.
  // The `url` field is the canonical, fragment-free property URL.
  const source = item.url ?? item['@id'] ?? '';
  const path = source
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '');
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

export type PropertyType =
  | 'single_family'
  | 'condo'
  | 'townhouse'
  | 'land'
  | 'mobile'
  | 'multi_family';

export type ListingType =
  | 'for_sale'
  | 'sold'
  | 'for_rent'
  | 'open_houses'
  | 'new_construction';

export type SortOption = 'newest';

export interface SearchInput {
  location: string;
  limit?: number;
  property_type?: PropertyType;
  listing_type?: ListingType;
  sort?: SortOption;
}

const TYPE_TO_SLUG_SALE: Record<PropertyType, string> = {
  single_family: 'houses',
  condo: 'condos',
  townhouse: 'townhouses',
  land: 'land',
  mobile: 'mobile-homes',
  multi_family: 'multi-family',
};

const TYPE_TO_SLUG_RENT: Record<PropertyType, string> = {
  single_family: 'houses',
  condo: 'condos',
  townhouse: 'townhouses',
  land: 'land', // not a real homes.com rent path; falls back to /homes-for-rent/
  mobile: 'mobile-homes', // same
  multi_family: 'multi-family', // same
};

/**
 * Build the `/<location>/[<segment>/[<sort>/]]` path for a search.
 *
 * homes.com routes locations like `/atlanta-ga/`, `/brooklyn-ny/`,
 * `/30311/` (ZIPs), with filter facets baked into the URL path:
 *
 *   /<city>/houses-for-sale/          property_type=single_family
 *   /<city>/condos-for-sale/          property_type=condo
 *   /<city>/townhouses-for-sale/      property_type=townhouse
 *   /<city>/land-for-sale/            property_type=land
 *   /<city>/mobile-homes-for-sale/    property_type=mobile
 *   /<city>/multi-family-for-sale/    property_type=multi_family
 *   /<city>/sold/                     listing_type=sold
 *   /<city>/homes-for-rent/           listing_type=for_rent (untyped)
 *   /<city>/condos-for-rent/          property_type=condo + listing_type=for_rent
 *   /<city>/open-houses/              listing_type=open_houses
 *   /new-homes/for-sale/<city>/       listing_type=new_construction
 *   /<city>/<segment>/newest/         sort=newest (appended)
 *
 * Verified by inspecting homes.com nav links on /brooklyn-ny/ (2026-05-26).
 * Path-based filters work; query-string filters are stripped at the edge.
 */
export function buildSearchPath(input: SearchInput): string {
  const slug = locationToSlug(input.location);

  // new_construction has its own URL root; other params are ignored.
  if (input.listing_type === 'new_construction') {
    return `/new-homes/for-sale/${slug}/`;
  }

  let segment = '';
  if (input.listing_type === 'sold') {
    segment = 'sold';
  } else if (input.listing_type === 'open_houses') {
    segment = 'open-houses';
  } else if (input.listing_type === 'for_rent') {
    const typeSlug = input.property_type
      ? TYPE_TO_SLUG_RENT[input.property_type]
      : undefined;
    const rentable = new Set(['houses', 'condos', 'townhouses']);
    segment =
      typeSlug && rentable.has(typeSlug) ? `${typeSlug}-for-rent` : 'homes-for-rent';
  } else if (input.property_type) {
    // listing_type undefined or 'for_sale'
    segment = `${TYPE_TO_SLUG_SALE[input.property_type]}-for-sale`;
  }

  const sort = input.sort === 'newest' ? 'newest' : '';

  const parts: string[] = [slug];
  if (segment) parts.push(segment);
  if (sort) parts.push(sort);
  return `/${parts.join('/')}/`;
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
        "Search homes.com listings by free-text location (city, ZIP, neighborhood). Optionally filter by property_type (single_family/condo/townhouse/land/mobile/multi_family), listing_type (for_sale/sold/for_rent/open_houses/new_construction), and sort (newest). Slugifies the location into homes.com's URL routing (e.g. 'Atlanta, GA' + condo + for_sale → /atlanta-ga/condos-for-sale/). Parses the embedded Schema.org JSON-LD to return each listing's address, price, beds/baths, sqft, primary photo, listing agent + brokerage, and the homes.com property URL. KNOWN CAP: homes.com server-renders ~40 listings per page; the response carries `truncated: true` + `total_estimated` when the market has more. To enumerate a busy market, price-band or sub-area your search until each segment fits under the cap. Read-only; safe to call repeatedly.",
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
          .describe(
            'Max listings to return (default 40, which is also the homes.com SSR page size). Passing >40 will still cap at the page size; the response will set `truncated: true` and `total_estimated` to homes.com\'s reported total.'
          ),
        property_type: z
          .enum([
            'single_family',
            'condo',
            'townhouse',
            'land',
            'mobile',
            'multi_family',
          ])
          .optional()
          .describe(
            'Restrict to a specific homes.com property type. Composes with listing_type.'
          ),
        listing_type: z
          .enum(['for_sale', 'sold', 'for_rent', 'open_houses', 'new_construction'])
          .optional()
          .describe(
            'Search axis. Defaults to for_sale. "sold" returns recently-sold listings (useful for market context). "for_rent" returns rentals. "open_houses" returns listings with scheduled open houses. "new_construction" returns builder listings under /new-homes/.'
          ),
        sort: z
          .enum(['newest'])
          .optional()
          .describe('Sort order. Only "newest" is currently supported.'),
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
      // #25: homes.com SSRs ~40 listings per page even when its
      // numberOfItems counter reports more. Signal the slice explicitly
      // so callers can tell "all results" from "page 1 of many".
      const truncated =
        typeof total === 'number' && total > formatted.length;
      const payload: {
        search_path: string;
        total_items: number | undefined;
        count: number;
        truncated: boolean;
        total_estimated?: number;
        results: FormattedHome[];
      } = {
        search_path: path,
        total_items: total,
        count: formatted.length,
        truncated,
        results: formatted,
      };
      if (truncated && typeof total === 'number') {
        payload.total_estimated = total;
      }
      return textResult(payload);
    }
  );
}
