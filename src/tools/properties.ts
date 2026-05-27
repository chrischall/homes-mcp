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
import {
  extractFeatures,
  loadCommunities,
  type ExtractedFeatures,
} from '../features.js';
import {
  buildPortalUrlHyperlink,
  computePriceDrop,
  daysSince,
  hoaToMonthlyUsd,
  isTaxSentinel,
} from '../format.js';
import {
  normalizeEvents,
  parseLienHistory,
  parseOwnershipHistory,
  parsePropertyHistory,
  parseTaxHistory,
  type LienEvent,
  type ListingEvent,
  type NormalizedEvent,
  type OwnershipEvent,
  type TaxRecord,
} from './history.js';

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
  /**
   * Raw HOA fee in the units homes.com reported. Kept for back-compat.
   * Prefer `hoa_monthly_usd` for consistent cross-property math (#15).
   */
  hoa_fee?: number;
  /**
   * HOA cost normalized to monthly USD, rounded. `null` when the
   * frequency is unknown or no fee is reported. Same field name and
   * units across the real-estate MCP family (#15).
   */
  hoa_monthly_usd?: number | null;
  /** Raw `frequency` string when the DOM exposed one (e.g. "month", "year"). */
  hoa_frequency?: string;
  lot_size_sqft?: number;
  lot_size_acres?: number;
  parking?: string;
  heating?: string;
  cooling?: string;
  mls_id?: string;
  mls_source?: string;
  /**
   * Annual property tax from the homes.com financial section. `null`
   * when the raw value is a not-yet-assessed sentinel (0 / 1 / sub-$10).
   * See `tax_is_estimated` for whether it was upstream-marked as a
   * county estimate vs an actual bill (#17).
   */
  tax_annual?: number | null;
  /** Whether homes.com flagged the tax value as a county estimate (#17). */
  tax_is_estimated?: boolean;
  /**
   * Days since the listing's `datePosted`. `null` when the timestamp is
   * absent or unparseable (re-lists with no first-list info). (#16.)
   */
  days_on_market?: number | null;
  /**
   * Previous list price (when surfaced by homes.com). Drives the
   * `price_drop_*` derivations. (#16.)
   */
  previous_list_price?: number;
  /** `previous_list_price - price`. `null` when either is missing. (#16.) */
  price_drop_amount?: number | null;
  /** `(previous - current) / previous * 100`, rounded to 0.1. (#16.) */
  price_drop_percent?: number | null;
  /**
   * Google-Sheets `HYPERLINK` formula pointing at the same listing.
   * Always present (mirrors `url`). Pasting it into a Sheets cell
   * renders as a clickable "Homes" link (#22).
   */
  portal_url_hyperlink?: string;
  /**
   * Alternate address strings from other MLS feeds when they disagree
   * with the primary address. Omitted when there's nothing to flag
   * (#23). Helps catch cross-feed mismatches like the live "109 vs
   * 169 Overlook Point Ln" case.
   */
  address_alternates?: string[];
  // P0 context-savings (#13/#14): server-side extracted features lift
  // keyword-parsing work out of the caller. Always present when a
  // description was available upstream; absent when there was no
  // description to extract from.
  extracted_features?: ExtractedFeatures;
  /**
   * Price + ownership + lien timelines + events_normalized. Populated
   * when `homes_get_property` is called with `include_price_history:
   * true` (or the matching `include_tax_history`). Same shape as the
   * standalone `homes_get_property_history` tool emits (#27).
   */
  price_history?: {
    listing_events: ListingEvent[];
    ownership_events: OwnershipEvent[];
    lien_events: LienEvent[];
    events_normalized: NormalizedEvent[];
  };
  /**
   * Year-by-year tax records. Populated when `homes_get_property` is
   * called with `include_tax_history: true`. Same shape as the
   * standalone `homes_get_tax_history` tool emits (#27).
   */
  tax_history?: TaxRecord[];
}

/**
 * Per-call formatting controls. Default `includeDescription: false`
 * trims the marketing-copy prose from the payload (caller can opt back
 * in for the raw text). See #13.
 */
export interface FormatOptions {
  includeDescription?: boolean;
  /**
   * Inline `price_history` (listing/ownership/lien events plus
   * events_normalized) on the formatted record. Parsed from the same
   * HTML the format call already has — no extra round trip (#27).
   */
  includePriceHistory?: boolean;
  /** Inline `tax_history` records on the formatted record (#27). */
  includeTaxHistory?: boolean;
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

export function format(
  listing: JsonLdListing,
  html?: string,
  opts: FormatOptions = {}
): FormattedProperty {
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

  // P0 (#14): compute extracted_features whenever the listing has a
  // description, even when we'll omit the raw text from the response.
  // Skip the work entirely when there's nothing to parse.
  const description = listing.description;
  const extractedFeatures = description
    ? extractFeatures(description, loadCommunities())
    : undefined;

  const url = listing.url ?? listing['@id'] ?? '';
  const out: FormattedProperty = {
    property_id: extractPropertyId(listing),
    url,
    name: listing.name,
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

  // #22: Sheets-paste-ready hyperlink. Always present (mirrors `url`).
  if (url) {
    out.portal_url_hyperlink = buildPortalUrlHyperlink(url);
  }

  // #15: HOA monthly normalization. Both fields surface on every record
  // so callers can rely on `hoa_monthly_usd` being present (null if no
  // info) without having to inspect a frequency string.
  out.hoa_monthly_usd = hoaToMonthlyUsd(out.hoa_fee, out.hoa_frequency);

  // #16: days_on_market + price_drop derivations.
  out.days_on_market = daysSince(listing.datePosted);
  const drop = computePriceDrop(out.previous_list_price, out.price);
  out.price_drop_amount = drop.amount;
  out.price_drop_percent = drop.percent;

  // #17: Null out tax_annual sentinel placeholders. The flag stays so
  // callers can tell "no data" apart from "real $0" later.
  if (isTaxSentinel(out.tax_annual ?? undefined)) {
    out.tax_annual = null;
  }

  // #23: Drop alternates that duplicate the primary streetAddress. Keep
  // only genuinely-different alternates.
  if (out.address_alternates && out.address) {
    const primary = out.address.toLowerCase();
    const filtered = out.address_alternates.filter(
      (a) => a.toLowerCase() !== primary
    );
    if (filtered.length > 0) {
      out.address_alternates = filtered;
    } else {
      delete out.address_alternates;
    }
  }

  // P0 (#13): omit `description` by default — opt back in with
  // includeDescription: true. The raw text is heavy marketing prose
  // that callers were keyword-parsing and discarding.
  if (opts.includeDescription && description) {
    out.description = description;
  }
  if (extractedFeatures) {
    out.extracted_features = extractedFeatures;
  }

  // #27: optionally inline history series parsed from the same HTML
  // the format call already has. Saves a second round trip vs calling
  // homes_get_property_history / homes_get_tax_history separately.
  if ((opts.includePriceHistory || opts.includeTaxHistory) && html) {
    const root = parseHtml(html);
    if (opts.includePriceHistory) {
      const listing_events = parsePropertyHistory(root);
      out.price_history = {
        listing_events,
        ownership_events: parseOwnershipHistory(root),
        lien_events: parseLienHistory(root),
        events_normalized: normalizeEvents(listing_events),
      };
    }
    if (opts.includeTaxHistory) {
      out.tax_history = parseTaxHistory(root);
    }
  }

  return out;
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
        "Fetch a property's full homes.com record. Pass `url` — the full property detail URL (e.g. from a homes_search_properties result's `url` field). Parses the page's Schema.org JSON-LD plus DOM-side sections to return address, lat/lng, beds/baths, sqft, year built, price, status, listing agent + brokerage, highlights, estimated monthly payment, total views, Matterport tour URL, floorplan URLs, schools, HOA fee, lot size, parking, heating/cooling, MLS ID/source, and date posted/modified. Also returns `extracted_features` (lake_front, hot_tub, basement, furnished, dock, community) derived server-side from the listing description so callers don't have to keyword-parse marketing prose. Pass `include_price_history: true` to inline the same data `homes_get_property_history` returns (`listing_events`, `ownership_events`, `lien_events`, `events_normalized`) under `price_history`. Pass `include_tax_history: true` to inline `homes_get_tax_history` records under `tax_history`. Both are off by default; opting in costs nothing extra over the dedicated tools (same page fetch). The raw `description` is omitted by default; pass `include_description: true` to opt back in. Read-only; safe to call repeatedly.",
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
        include_description: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When true, include the raw listing `description` marketing prose. Default false — the structured `extracted_features` field surfaces the keywords callers usually want; the prose itself is heavy chat-history weight.'
          ),
        include_price_history: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When true, inline `price_history` (listing/ownership/lien events + events_normalized) on the response — the same data `homes_get_property_history` returns. Saves a second round trip when you need both (#27).'
          ),
        include_tax_history: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When true, inline `tax_history` records — same data `homes_get_tax_history` returns. Saves a second round trip when you need both (#27).'
          ),
      },
    },
    async ({ url, include_description, include_price_history, include_tax_history }) => {
      const { listing, html } = await fetchListingRecord(client, { url });
      return textResult(
        format(listing, html, {
          includeDescription: include_description,
          includePriceHistory: include_price_history,
          includeTaxHistory: include_tax_history,
        })
      );
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

  // Listing and Financial Details — HOA, MLS, source, tax.
  const finText = findDivTextAfterHeading(root, 'Listing and Financial Details');
  if (finText) {
    // HOA. Capture both the dollar amount AND the trailing frequency
    // (e.g. "$250 / month", "$4,967 annually") so we can normalize to
    // monthly USD in format(). See #15.
    const hoa = /HOA Fee:\s*\$?([0-9,]+|0)\s*(?:\/\s*(year|month|quarter|week)|(annually|monthly|quarterly|weekly|semi-?annually))?/i.exec(
      finText
    );
    if (hoa) {
      const n = parseDollar(hoa[1]);
      if (n !== undefined) out.hoa_fee = n;
      const freq = hoa[2] ?? hoa[3];
      if (freq) out.hoa_frequency = freq.toLowerCase();
    } else if (/No HOA/i.test(bodyText)) {
      out.hoa_fee = 0;
      out.hoa_frequency = 'month';
    }
    const mls = /MLS#?:?\s*([A-Z0-9-]+)/i.exec(finText);
    if (mls) out.mls_id = mls[1];
    const src = /Source:\s*([A-Z][A-Za-z0-9 ]+)/.exec(finText);
    if (src) out.mls_source = src[1].trim();
    // Tax — homes.com surfaces "Annual Tax" / "Property Tax" / "Tax".
    // Capture the dollar amount; sentinel cleanup happens in format().
    const tax = /(?:Annual Tax|Property Tax|Tax(?:es)?)(?: Amount)?:?\s*\$?([0-9,]+)/i.exec(
      finText
    );
    if (tax) {
      const n = parseDollar(tax[1]);
      if (n !== undefined) out.tax_annual = n;
    }
    // Some pages flag the tax value with "(estimated)" / "(est.)" or
    // "estimated by county". Surface that as #17's tax_is_estimated.
    if (/tax[^.]{0,40}\b(estimated|est\.|county estimate)\b/i.test(finText)) {
      out.tax_is_estimated = true;
    }
    // Previous list price (when homes.com surfaces a price-history hint
    // in the financial section). Used to derive price_drop_* (#16).
    const prev = /(?:Previous(?:ly)?(?: List(?:ed)?)? Price|Was|Originally listed at)\s*:?\s*\$?([0-9,]+)/i.exec(
      finText
    );
    if (prev) {
      const n = parseDollar(prev[1]);
      if (n !== undefined) out.previous_list_price = n;
    }
  }
  // "No HOA" fallback even if no Listing+Financial section.
  if (out.hoa_fee === undefined && /No HOA/i.test(bodyText)) {
    out.hoa_fee = 0;
    out.hoa_frequency = 'month';
  }

  // #23: Address alternates from MLS data attributes. homes.com pages
  // sometimes carry a `data-unparsed-address` or list multiple
  // "MLS Address" rows. We scan for either and surface anything that
  // disagrees with the primary streetAddress (which the caller already
  // gets in `address`). Omit the field entirely when no alternates.
  const alts = collectAddressAlternates(root);
  if (alts.length > 0) out.address_alternates = alts;

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

/**
 * Collect alternate address strings — MLS feeds, prior addresses,
 * parcel variants. Returns the list dedup'd, in document order. The
 * primary `streetAddress` (already on the formatted record) is NOT
 * filtered here; the caller compares against it in format(). See #23.
 */
function collectAddressAlternates(root: HTMLElement): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string | undefined): void => {
    if (!s) return;
    const v = s.replace(/\s+/g, ' ').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  // data-unparsed-address attributes carried on hidden MLS-feed nodes.
  root
    .querySelectorAll('[data-unparsed-address]')
    .forEach((el) => add(el.getAttribute('data-unparsed-address') ?? undefined));
  // <li> rows under an "MLS Address" or "Alternate Address" heading.
  const altItems = findUlAfterHeading(root, 'Alternate Address');
  for (const item of altItems) add(item);
  const mlsItems = findUlAfterHeading(root, 'MLS Address');
  for (const item of mlsItems) add(item);
  return out;
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
