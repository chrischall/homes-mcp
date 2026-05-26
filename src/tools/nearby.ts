import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  parseHtml,
  findLinksUnderHeading,
  parseDollar,
  parseIntegerLoose,
  type HTMLElement,
} from '../html.js';
import { urlToPath } from '../url.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';

/**
 * homes.com renders a "Homes for Sale Near This Property" section near
 * the bottom of every property detail page. Each card is an <a> wrapping
 * the property link plus address/price/bed/bath/sqft spans. We scrape
 * those into a flat NearbyListing[].
 *
 * Note: these are nearby active listings homes.com curates — NOT a comp-
 * sales set or the user's saved homes. The tool name avoids "comparable"
 * to keep that distinction clear.
 */

export interface NearbyListing {
  property_id: string;
  url: string;
  address?: string;
  price?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  primary_photo_url?: string;
}

const PROPERTY_LINK_RE = /\/property\/[^/]+\/([^/]+)\/?$/;

export function parseNearbyListings(root: HTMLElement): NearbyListing[] {
  // homes.com uses several headings interchangeably across listings. Try
  // each — first match wins.
  const HEADINGS = ['Homes for Sale Near', 'Homes for Sale', 'Similar Homes', 'Nearby Homes'];
  let links: HTMLElement[] = [];
  for (const h of HEADINGS) {
    links = findLinksUnderHeading(root, h);
    if (links.length > 0) break;
  }
  if (links.length === 0) return [];

  const seen = new Set<string>();
  const out: NearbyListing[] = [];
  for (const a of links) {
    const href = a.getAttribute('href') ?? '';
    const m = PROPERTY_LINK_RE.exec(href.replace(/^https?:\/\/[^/]+/, ''));
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const text = a.text;
    const priceM = /\$([0-9,]+)/.exec(text);
    const bedsM = /(\d+)\s*bd/i.exec(text);
    const bathsM = /(\d+(?:\.\d+)?)\s*ba/i.exec(text);
    const sqftM = /([0-9,]+)\s*sq\s*ft/i.exec(text);
    const addrEl = a.querySelector('.address, [class*="address" i]');
    const photoEl = a.querySelector('img');
    const item: NearbyListing = {
      property_id: id,
      url: href.startsWith('http')
        ? href
        : `https://www.homes.com${href.startsWith('/') ? href : '/' + href}`,
    };
    if (addrEl) item.address = addrEl.text.replace(/\s+/g, ' ').trim();
    if (priceM) {
      const n = parseDollar(priceM[1]);
      if (n !== undefined) item.price = n;
    }
    if (bedsM) {
      const n = parseIntegerLoose(bedsM[1]);
      if (n !== undefined) item.beds = n;
    }
    if (bathsM) {
      const n = Number(bathsM[1]);
      if (Number.isFinite(n)) item.baths = n;
    }
    if (sqftM) {
      const n = parseIntegerLoose(sqftM[1]);
      if (n !== undefined) item.sqft = n;
    }
    if (photoEl) {
      const src = photoEl.getAttribute('src');
      if (src) item.primary_photo_url = src;
    }
    out.push(item);
  }
  return out;
}

function propertyIdFromUrl(url: string): string {
  const m = PROPERTY_LINK_RE.exec(url.replace(/^https?:\/\/[^/]+/, ''));
  return m ? m[1] : '';
}

function originPropertyId(html: string, fallbackUrl: string): string {
  const doc = extractJsonLd(html);
  const node = findGraphNode(doc, 'RealEstateListing') as
    | { '@id'?: string; url?: string }
    | null;
  // Prefer node.url over node['@id'] — see properties.ts:extractPropertyId
  // (homes.com @id now carries a `#realestatelisting` fragment).
  const src = node?.url ?? node?.['@id'] ?? fallbackUrl;
  return propertyIdFromUrl(src);
}

export function registerNearbyTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_nearby_listings',
    {
      title: 'Get nearby homes.com listings for a property',
      description:
        "Scrape the 'Homes for Sale Near This Property' section of a homes.com detail page and return the nearby active listings: id, URL, address, price, beds, baths, sqft, primary photo. Pass `url` (the property whose neighborhood to inspect). Optional `limit` caps the count. Returns `{ property_id, url, count, listings[] }`. Note: these are nearby listings homes.com chose to surface; not a true comp-sales set. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get nearby homes.com listings for a property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().describe('homes.com property detail URL or path.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max nearby listings to return (default unlimited).'),
      },
    },
    async ({ url, limit }) => {
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const root = parseHtml(html);
      const all = parseNearbyListings(root);
      const listings = limit !== undefined ? all.slice(0, limit) : all;
      return textResult({
        property_id: originPropertyId(html, url),
        url,
        count: listings.length,
        listings,
      });
    }
  );
}
