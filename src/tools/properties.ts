import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';
import { urlToPath } from '../url.js';
import {
  parseHtml,
  parseDollar,
  parseIntegerLoose,
  type HTMLElement,
} from '../html.js';

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

export interface School {
  name: string;
  level?: string;
  district?: string;
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
  // NEW FIELDS:
  highlights?: string[];
  estimated_monthly_payment?: number;
  total_views?: number;
  matterport_url?: string;
  floorplan_urls?: string[];
  schools?: School[];
  hoa_fee?: number;
  lot_size_sqft?: number;
  lot_size_acres?: number;
  parking?: string;
  heating?: string;
  cooling?: string;
  mls_id?: string;
  mls_source?: string;
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
 * Derive a homes.com property id from a listing's `url` or `@id`. We
 * take the last non-empty path segment (e.g. `rxrzwg0kjnr32`).
 *
 * Prefer `url` over `@id` because homes.com's @id now includes a
 * `#realestatelisting` fragment (e.g. `.../abc123/#realestatelisting`)
 * — taking the last path segment would otherwise return the fragment
 * instead of the id. The `url` field is fragment-free.
 */
export function extractPropertyId(listing: JsonLdListing): string {
  const source = listing.url ?? listing['@id'] ?? '';
  const path = source
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '');
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

export function format(listing: JsonLdListing, html?: string): FormattedProperty {
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
  const extras: Partial<FormattedProperty> = html ? extractDomFields(html) : {};
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
    ...extras,
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
        "Fetch a property's full homes.com record. Pass `url` — the full property detail URL (e.g. from a homes_search_properties result's `url` field). Parses the page's Schema.org JSON-LD plus DOM-side sections to return address, lat/lng, beds/baths, sqft, year built, price, status, listing agent + brokerage, description, highlights, estimated monthly payment, total views, Matterport tour URL, floorplan URLs, schools, HOA fee, lot size, parking, heating/cooling, MLS ID/source, and date posted/modified. Read-only; safe to call repeatedly.",
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
      const { listing, html } = await fetchListingRecord(client, { url });
      return textResult(format(listing, html));
    }
  );
}

/**
 * Best-effort DOM scraping for fields that don't appear in JSON-LD.
 * Every field is optional — missing-from-this-listing is normal.
 *
 * Sections (per live probe on 2026-05-26):
 *   - "Highlights" <ul><li>…</li></ul>
 *   - Estimated payment (text "Estimated payment <amount>/month")
 *   - Total Views (text "Total Views <number>")
 *   - Matterport <a> with my.matterport.com URL
 *   - Floorplans <img> tags whose URL contains "floorplan"
 *   - "Schools" <ul><li>…</li></ul> (or "MLS Schools")
 *   - "Listing and Financial Details" <div> with HOA / MLS / Source text
 *   - "Lot Details" / "Parking" / "Utilities" <div> after their <h3>
 */
function extractDomFields(html: string): Partial<FormattedProperty> {
  const root = parseHtml(html);
  const out: Partial<FormattedProperty> = {};

  // Highlights
  const hl = findUlAfterHeading(root, 'Highlights');
  if (hl.length > 0) out.highlights = hl;

  // Estimated payment / Total Views — flat-text regex over the body.
  const bodyText = root.text;
  const est = /Estimated payment\s*\$?([0-9,]+)/i.exec(bodyText);
  if (est) {
    const n = parseDollar(est[1]);
    if (n !== undefined) out.estimated_monthly_payment = n;
  }
  const views = /Total Views\s*([0-9,]+)/i.exec(bodyText);
  if (views) {
    const n = parseIntegerLoose(views[1]);
    if (n !== undefined) out.total_views = n;
  }

  // Matterport URL
  const matter = root
    .querySelectorAll('a')
    .find((a) => (a.getAttribute('href') ?? '').includes('matterport.com'));
  if (matter) out.matterport_url = matter.getAttribute('href') ?? undefined;

  // Floorplans — <img> whose src includes "floorplan"
  const fps = root
    .querySelectorAll('img')
    .map((img) => img.getAttribute('src') ?? '')
    .filter((src) => src.includes('floorplan'));
  if (fps.length > 0) out.floorplan_urls = fps;

  // Schools
  const schoolItems = findUlAfterHeading(root, 'Schools');
  if (schoolItems.length > 0) {
    out.schools = schoolItems.map(parseSchoolLine);
  }

  // Listing and Financial Details — HOA, MLS, source.
  const finText = findDivTextAfterHeading(root, 'Listing and Financial Details');
  if (finText) {
    const hoa = /HOA Fee:\s*\$?([0-9,]+|0)/i.exec(finText);
    if (hoa) {
      const n = parseDollar(hoa[1]);
      if (n !== undefined) out.hoa_fee = n;
    } else if (/No HOA/i.test(bodyText)) {
      out.hoa_fee = 0;
    }
    const mls = /MLS#?:?\s*([A-Z0-9-]+)/i.exec(finText);
    if (mls) out.mls_id = mls[1];
    const src = /Source:\s*([A-Z][A-Za-z0-9 ]+)/.exec(finText);
    if (src) out.mls_source = src[1].trim();
  }
  // "No HOA" fallback even if no Listing+Financial section.
  if (out.hoa_fee === undefined && /No HOA/i.test(bodyText)) {
    out.hoa_fee = 0;
  }

  // Lot Details — accept "X acres / Y sqft" or "Y sqft" or "X acres".
  const lotText = findDivTextAfterHeading(root, 'Lot Details');
  if (lotText) {
    const sqft = /([0-9,]+)\s*sqft/i.exec(lotText);
    if (sqft) {
      const n = parseIntegerLoose(sqft[1]);
      if (n !== undefined) out.lot_size_sqft = n;
    }
    const acres = /([0-9.]+)\s*acres?/i.exec(lotText);
    if (acres) {
      const n = Number(acres[1]);
      if (Number.isFinite(n)) out.lot_size_acres = n;
    }
  }

  // Parking
  const parkingText = findDivTextAfterHeading(root, 'Parking');
  if (parkingText) out.parking = parkingText.replace(/\s+/g, ' ').trim();

  // Utilities — Heating / Cooling
  const util = findDivTextAfterHeading(root, 'Utilities');
  if (util) {
    const heat = /Heating:\s*([^.]+)/i.exec(util);
    if (heat) out.heating = heat[1].trim();
    const cool = /Cooling:\s*([^.]+)/i.exec(util);
    if (cool) out.cooling = cool[1].trim();
  }

  return out;
}

function findUlAfterHeading(root: HTMLElement, heading: string): string[] {
  const needle = heading.toLowerCase();
  const hs = root.querySelectorAll('h1, h2, h3, h4');
  for (const h of hs) {
    if (!h.text.toLowerCase().includes(needle)) continue;
    // Search the heading's parent for the first <ul>.
    const parent = h.parentNode as HTMLElement | null;
    const ul = parent?.querySelector('ul');
    if (ul) {
      return ul
        .querySelectorAll('li')
        .map((li) => li.text.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }
    // Walk forward siblings.
    let cur: HTMLElement | null = h.nextElementSibling as HTMLElement | null;
    while (cur) {
      if (/^H[1-4]$/.test(cur.tagName)) break;
      if (cur.tagName === 'UL') {
        return cur
          .querySelectorAll('li')
          .map((li) => li.text.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
      }
      const nested = cur.querySelector('ul');
      if (nested) {
        return nested
          .querySelectorAll('li')
          .map((li) => li.text.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
      }
      cur = cur.nextElementSibling as HTMLElement | null;
    }
  }
  return [];
}

function findDivTextAfterHeading(
  root: HTMLElement,
  heading: string
): string | null {
  const needle = heading.toLowerCase();
  const hs = root.querySelectorAll('h1, h2, h3, h4');
  for (const h of hs) {
    if (!h.text.toLowerCase().includes(needle)) continue;
    const sib = h.nextElementSibling as HTMLElement | null;
    if (sib && sib.tagName === 'DIV') {
      return sib.text.replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function parseSchoolLine(line: string): School {
  // "Cascade Elementary School (K-5) — Atlanta Public Schools"
  const m = /^(.+?)(?:\s*\(([^)]+)\))?(?:\s*[—-]\s*(.+))?$/.exec(line);
  if (!m) return { name: line };
  const [, name, level, district] = m;
  const out: School = { name: name.trim() };
  if (level) out.level = level.trim();
  if (district) out.district = district.trim();
  return out;
}
