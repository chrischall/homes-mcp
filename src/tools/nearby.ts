import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { parseHtml, type HTMLElement } from '../html.js';
import { urlToPath } from '../url.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';

/**
 * homes.com renders a "Homes for Sale Near This Property" section near
 * the bottom of every property detail page — but the section is
 * **anchorless** (no heading element), which broke the original
 * heading-based scraper.
 *
 * The data lives in a tabbed `<section class="nearby-links-section-dt-v2">`
 * with four lists, keyed by id (verified live 2026-05-26):
 *
 *   <ul id="nb-Property"> — 20 nearby for-sale listings (tab: "Homes for Sale")
 *   <ul id="nb-Neighborhood"> — nearby neighborhood names (no property links)
 *   <ul id="nb-City"> — nearby city names (no property links)
 *   <ul id="nb-property"> — 20 nearby rentals (tab: "Rentals")
 *
 * Each `<li>` is minimal:
 *
 *   <li><a class="text-only" href="/property/<slug>/<id>/" title="<address>">
 *     <address>
 *   </a></li>
 *
 * No price, beds, baths, sqft, or photo — those fields are only on the
 * cards used elsewhere on the page. So the canonical return shape is
 * `{ property_id, url, address, tab }`.
 */

export type NearbyTab = 'for_sale' | 'for_rent';

export interface NearbyListing {
  property_id: string;
  url: string;
  address?: string;
  tab: NearbyTab;
}

const PROPERTY_LINK_RE = /\/property\/[^/]+\/([^/]+)\/?$/;

const TAB_LIST_IDS: Record<NearbyTab, string> = {
  for_sale: 'nb-Property',
  for_rent: 'nb-property',
};

function readListItems(root: HTMLElement, tab: NearbyTab): NearbyListing[] {
  const ul = root.querySelector(`ul#${TAB_LIST_IDS[tab]}`);
  if (!ul) return [];
  const out: NearbyListing[] = [];
  const seen = new Set<string>();
  for (const a of ul.querySelectorAll('a[href*="/property/"]')) {
    const href = a.getAttribute('href') ?? '';
    const m = PROPERTY_LINK_RE.exec(href.replace(/^https?:\/\/[^/]+/, ''));
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const address =
      a.getAttribute('title')?.trim() || a.text.replace(/\s+/g, ' ').trim();
    out.push({
      property_id: id,
      url: href.startsWith('http')
        ? href
        : `https://www.homes.com${href.startsWith('/') ? href : '/' + href}`,
      address: address || undefined,
      tab,
    });
  }
  return out;
}

/**
 * Parse the nearby-listings section from a property detail page's
 * rendered HTML. Returns the For Sale tab by default; pass
 * `include_rentals: true` to also collect the Rentals tab.
 */
export function parseNearbyListings(
  root: HTMLElement,
  opts: { include_rentals?: boolean } = {}
): NearbyListing[] {
  const out = readListItems(root, 'for_sale');
  if (opts.include_rentals) {
    out.push(...readListItems(root, 'for_rent'));
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
  // Prefer node.url over node['@id'] — homes.com @id carries a
  // `#realestatelisting` fragment that breaks last-segment extraction.
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
        "Scrape the nearby-links section of a homes.com detail page (the tabbed list of `<ul id=\"nb-Property\">` near the bottom of the page) and return the nearby active listings. Pass `url` (the property whose neighborhood to inspect). By default returns the For Sale tab; pass `include_rentals: true` to also include the Rentals tab. Optional `limit` caps the count. Returns `{ property_id, url, count, listings: [{ property_id, url, address?, tab }] }`. Note: the nearby section is a curated cross-link list, not a comparable-sales set — only URL + address are exposed (no price/beds/baths/sqft/photo). To enrich a row, call `homes_get_property` on its url. Read-only; safe to call repeatedly.",
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
        include_rentals: z
          .boolean()
          .optional()
          .describe(
            'When true, also include the Rentals tab (`<ul id="nb-property">` lowercase). Default false — For Sale tab only.'
          ),
      },
    },
    async ({ url, limit, include_rentals }) => {
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const root = parseHtml(html);
      const all = parseNearbyListings(root, { include_rentals });
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
