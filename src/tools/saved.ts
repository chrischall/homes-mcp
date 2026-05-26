import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  parseHtml,
  parseDollar,
  parseIntegerLoose,
  type HTMLElement,
} from '../html.js';

/**
 * Auth-gated DOM scrape of the signed-in user's saved homes and saved
 * searches. Both pages are server-rendered with card-style HTML when
 * the user is signed in. `HomesClient.fetchHtml` throws
 * `SessionNotAuthenticatedError` if the request hits the sign-in
 * interstitial — callers don't need to handle auth here.
 *
 * Verified live 2026-05-26: empty-state pages load (don't redirect to
 * sign-in), so `count: 0` is a legitimate result.
 */

export interface SavedHome {
  property_id: string;
  url: string;
  address?: string;
  price?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  status?: string;
}

export interface SavedSearch {
  url: string;
  name?: string;
  filters?: string;
}

const PROPERTY_LINK_RE = /\/property\/[^/]+\/([^/]+)\/?$/;

export function parseSavedHomes(root: HTMLElement): SavedHome[] {
  const cards = root.querySelectorAll(
    'article, [class*="favorite" i], [class*="saved" i]'
  );
  const seen = new Set<string>();
  const out: SavedHome[] = [];
  for (const card of cards) {
    const a = card.querySelector('a[href*="/property/"]');
    if (!a) continue;
    const href = a.getAttribute('href') ?? '';
    const m = PROPERTY_LINK_RE.exec(href.replace(/^https?:\/\/[^/]+/, ''));
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const addrEl = card.querySelector('.address, [class*="address" i]');
    const priceEl = card.querySelector('.price, [class*="price" i]');
    const bedsEl = card.querySelector('.beds, [class*="beds" i]');
    const bathsEl = card.querySelector('.baths, [class*="baths" i]');
    const sqftEl = card.querySelector('.sqft, [class*="sqft" i]');
    const statusEl = card.querySelector('.status, [class*="status" i]');
    const item: SavedHome = {
      property_id: id,
      url: href.startsWith('http')
        ? href
        : `https://www.homes.com${href.startsWith('/') ? href : '/' + href}`,
    };
    if (addrEl) item.address = addrEl.text.replace(/\s+/g, ' ').trim();
    if (priceEl) {
      const n = parseDollar(priceEl.text);
      if (n !== undefined) item.price = n;
    }
    if (bedsEl) {
      const n = parseIntegerLoose(bedsEl.text);
      if (n !== undefined) item.beds = n;
    }
    if (bathsEl) {
      const n = Number(bathsEl.text.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n)) item.baths = n;
    }
    if (sqftEl) {
      const n = parseIntegerLoose(sqftEl.text);
      if (n !== undefined) item.sqft = n;
    }
    if (statusEl) {
      const t = statusEl.text.replace(/\s+/g, ' ').trim();
      if (t) item.status = t;
    }
    out.push(item);
  }
  return out;
}

export function parseSavedSearches(root: HTMLElement): SavedSearch[] {
  const cards = root.querySelectorAll(
    'article, [class*="saved-search" i], [class*="search-card" i]'
  );
  const out: SavedSearch[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const a = card.querySelector('a[href]');
    if (!a) continue;
    const href = a.getAttribute('href') ?? '';
    if (!href || href.includes('/property/')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const item: SavedSearch = {
      url: href.startsWith('http')
        ? href
        : `https://www.homes.com${href.startsWith('/') ? href : '/' + href}`,
    };
    const titleEl = card.querySelector('h2, h3, h4');
    if (titleEl) item.name = titleEl.text.replace(/\s+/g, ' ').trim();
    const filtersEl = card.querySelector('.filters, [class*="filter" i]');
    if (filtersEl) item.filters = filtersEl.text.replace(/\s+/g, ' ').trim();
    out.push(item);
  }
  return out;
}

export function registerSavedTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_saved_homes',
    {
      title: "Get the signed-in user's saved homes on homes.com",
      description:
        "The signed-in user's saved (favorited) homes on homes.com. Scrapes /customer/dashboard/favorites/. Returns `{ count, homes: [{ property_id, url, address?, price?, beds?, baths?, sqft?, status? }] }`. Requires the user to be signed in (the fetchproxy bridge handles auth automatically). Read-only; safe to call repeatedly.",
      annotations: {
        title: "Get the signed-in user's saved homes on homes.com",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/customer/dashboard/favorites/');
      const root = parseHtml(html);
      const homes = parseSavedHomes(root);
      return textResult({ count: homes.length, homes });
    }
  );

  server.registerTool(
    'homes_get_saved_searches',
    {
      title: "Get the signed-in user's saved searches on homes.com",
      description:
        "The signed-in user's saved searches on homes.com. Scrapes /customer/dashboard/saved-searches/. Returns `{ count, searches: [{ name?, url, filters? }] }`. Requires the user to be signed in. Read-only; safe to call repeatedly.",
      annotations: {
        title: "Get the signed-in user's saved searches on homes.com",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/customer/dashboard/saved-searches/');
      const root = parseHtml(html);
      const searches = parseSavedSearches(root);
      return textResult({ count: searches.length, searches });
    }
  );
}
