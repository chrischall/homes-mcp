import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';
import { urlToPath } from '../url.js';

/**
 * homes.com property detail: GET /property/<address-slug>/<propertyId>/
 *
 * The page server-renders Schema.org JSON-LD whose `@graph` contains a
 * `[RealEstateListing, Product]` node. The listing carries:
 *
 *   - top-level: `@id`, `name`, `description`, `url`, `image`,
 *     `datePosted`, `dateModified`, `offers`, `primaryImageOfPage`
 *   - `offers.offeredBy[]` — agent details (name, telephone, email,
 *     jobTitle, image, url, address). It's an array (length 1 in
 *     practice) on detail pages.
 *   - `mainEntity` — `SingleFamilyResidence`-style record with
 *     `numberOfBedrooms`, `numberOfBathroomsTotal`, `floorSize`,
 *     `yearBuilt`, `address`, `geo{latitude, longitude}`, `image`.
 *     `geo` is ONLY on the detail page — search-page items lack it.
 *
 * Verified live 2026-05-24 against:
 *   - https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/
 */

interface JsonLdAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
}

interface JsonLdGeo {
  latitude?: number | string;
  longitude?: number | string;
}

interface JsonLdFloorSize {
  value?: number | string;
  unitCode?: string;
}

interface JsonLdAgent {
  name?: string;
  telephone?: string;
  email?: string;
  jobTitle?: string;
  image?: string;
  url?: string;
  address?: JsonLdAddress | string;
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
  yearBuilt?: number | string;
  address?: JsonLdAddress;
  geo?: JsonLdGeo;
  image?: string | string[];
  url?: string;
}

export interface JsonLdListing {
  '@type'?: string | string[];
  '@id'?: string;
  name?: string;
  description?: string;
  url?: string;
  image?: string | string[];
  datePosted?: string;
  dateModified?: string;
  offers?: JsonLdOffer;
  mainEntity?: JsonLdMainEntity;
  primaryImageOfPage?: { url?: string; width?: number; height?: number };
}

export interface FormattedAgent {
  name?: string;
  telephone?: string;
  email?: string;
  job_title?: string;
  url?: string;
}

export interface FormattedProperty {
  property_id: string;
  url: string;
  name?: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  lat?: number;
  lng?: number;
  price?: number;
  price_currency?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  year_built?: number;
  primary_photo_url?: string;
  status?: string;
  date_posted?: string;
  date_modified?: string;
  listing_agent?: FormattedAgent;
  brokerage?: string;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.-]/g, '');
    if (cleaned === '') return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function firstImage(image: string | string[] | undefined): string | undefined {
  if (!image) return undefined;
  if (typeof image === 'string') return image;
  return image[0];
}

function firstAgent(offeredBy: JsonLdOffer['offeredBy']): JsonLdAgent | undefined {
  if (!offeredBy) return undefined;
  if (Array.isArray(offeredBy)) return offeredBy[0];
  return offeredBy;
}

function brokerageFrom(agent: JsonLdAgent | undefined): string | undefined {
  if (!agent?.memberOf) return undefined;
  if (Array.isArray(agent.memberOf)) return agent.memberOf[0]?.name;
  return agent.memberOf.name;
}

/**
 * Derive a homes.com property id from a listing's `@id` or `url`. We
 * take the last non-empty path segment (e.g. `rxrzwg0kjnr32`).
 */
export function extractPropertyId(listing: JsonLdListing): string {
  const source = listing['@id'] ?? listing.url ?? '';
  const path = source.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  const segments = path.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? '';
}

/**
 * Build the path for a homes.com property URL. The user passes the
 * full URL (from a `homes_search_properties` result's `url` field);
 * we reduce it via `urlToPath` and hand it to the transport.
 */
export function buildPath(args: { url?: string }): string {
  if (args.url) return urlToPath(args.url);
  throw new Error('homes property tool: must provide `url`');
}

/**
 * Pull the listing JSON-LD node out of a parsed JSON-LD doc. Returns
 * null if the doc has no graph or no listing node. We match on
 * `RealEstateListing` since that's the most specific of the dual types.
 */
export function findListing(doc: ReturnType<typeof extractJsonLd>): JsonLdListing | null {
  const node = findGraphNode(doc, 'RealEstateListing');
  return node as JsonLdListing | null;
}

/**
 * Fetch + parse a homes.com listing record. Shared by
 * `homes_get_property`, `homes_get_property_photos`, and
 * `homes_compare_properties`.
 */
export async function fetchListingRecord(
  client: HomesClient,
  args: { url?: string }
): Promise<{ listing: JsonLdListing; path: string; html: string }> {
  const path = buildPath(args);
  const html = await client.fetchHtml(path);
  const doc = extractJsonLd(html);
  if (!doc) {
    throw new Error(
      `Could not locate JSON-LD at ${path}. homes.com may have changed their page structure.`
    );
  }
  const listing = findListing(doc);
  if (!listing) {
    throw new Error(`No RealEstateListing node in JSON-LD at ${path}.`);
  }
  return { listing, path, html };
}

function formatAgent(agent: JsonLdAgent | undefined): FormattedAgent | undefined {
  if (!agent) return undefined;
  const out: FormattedAgent = {};
  if (agent.name) out.name = agent.name;
  if (agent.telephone) out.telephone = agent.telephone;
  if (agent.email) out.email = agent.email;
  if (agent.jobTitle) out.job_title = agent.jobTitle;
  if (agent.url) out.url = agent.url;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function format(listing: JsonLdListing): FormattedProperty {
  const main = listing.mainEntity ?? {};
  const addr = main.address ?? {};
  const geo = main.geo ?? {};
  const offers = listing.offers ?? {};
  const agent = firstAgent(offers.offeredBy);
  const primary =
    listing.primaryImageOfPage?.url ??
    firstImage(listing.image) ??
    firstImage(main.image);
  const sqft = toNumber(main.floorSize?.value);
  return {
    property_id: extractPropertyId(listing),
    url: listing.url ?? listing['@id'] ?? '',
    name: listing.name,
    description: listing.description,
    address: addr.streetAddress,
    city: addr.addressLocality,
    state: addr.addressRegion,
    zip: addr.postalCode,
    country: addr.addressCountry,
    lat: toNumber(geo.latitude),
    lng: toNumber(geo.longitude),
    price: toNumber(offers.price),
    price_currency: offers.priceCurrency,
    beds: toNumber(main.numberOfBedrooms),
    baths: toNumber(main.numberOfBathroomsTotal),
    sqft,
    year_built: toNumber(main.yearBuilt),
    primary_photo_url: primary,
    status: offers.availability,
    date_posted: listing.datePosted,
    date_modified: listing.dateModified,
    listing_agent: formatAgent(agent),
    brokerage: brokerageFrom(agent) ?? offers.seller?.name,
  };
}

export function registerPropertyTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_property',
    {
      title: 'Get homes.com property details',
      description:
        "Fetch a property's full homes.com record. Pass `url` — the full property detail URL (e.g. from a homes_search_properties result's `url` field, looks like https://www.homes.com/property/<slug>/<id>/). Parses the page's Schema.org JSON-LD to return address, lat/lng, beds/baths, sqft, year built, price + currency, status, listing agent + brokerage, photos URL, and date posted/modified. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get homes.com property details',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z
          .string()
          .describe(
            'homes.com property detail URL or path (e.g. https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/). Required — pass the `url` field from a homes_search_properties result.'
          ),
      },
    },
    async ({ url }) => {
      const { listing } = await fetchListingRecord(client, { url });
      return textResult(format(listing));
    }
  );
}
