import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import { extractJsonLd } from '../page-state.js';
import { findListings, formatHome, type FormattedHome } from './search.js';
import { locationToSlug } from '../url.js';

/**
 * `homes_get_market_report` — derive a sample-based market summary from
 * homes.com's recently-sold listings page (`/<city-slug>/sold/`).
 *
 * homes.com doesn't publish a Zillow-ZHVI-style price index in the SSR
 * HTML, so we compute median price + average $/sqft directly from the
 * sold listings the SSR page emits in JSON-LD (`CollectionPage.
 * mainEntity.itemListElement[]`). Typical sample size: ~40 listings.
 */

export interface SoldSummary {
  count: number;
  median_price?: number;
  avg_price_per_sqft?: number;
}

export function computeMarketSummary(
  items: Array<{ price?: number; sqft?: number }>
): SoldSummary {
  const prices = items.map((i) => i.price).filter((p): p is number => typeof p === 'number');
  if (prices.length === 0) return { count: 0 };
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const ppsfs = items
    .filter((i) => typeof i.price === 'number' && typeof i.sqft === 'number' && i.sqft! > 0)
    .map((i) => i.price! / i.sqft!);
  const avgPpsf =
    ppsfs.length > 0 ? Math.round(ppsfs.reduce((a, b) => a + b, 0) / ppsfs.length) : undefined;
  return {
    count: prices.length,
    median_price: median,
    ...(avgPpsf !== undefined ? { avg_price_per_sqft: avgPpsf } : {}),
  };
}

export function registerMarketTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_market_report',
    {
      title: 'Get a homes.com market report for a location',
      description:
        "Fetch homes.com's recently-sold listings for a city/ZIP/neighborhood and derive a market summary: count, median sale price, and average $/sqft across the sample. Pass `location` — free-text (e.g. 'Brooklyn, NY', '30311'). Returns `{ region, slug, sold_summary, sample_sold }`. Note: homes.com's sold page typically returns ~40 recent listings — this is a sample-based summary, not an exhaustive market index. Read-only.",
      annotations: {
        title: 'Get a homes.com market report for a location',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        location: z
          .string()
          .describe('Free-text location: city, ZIP, neighborhood'),
      },
    },
    async ({ location }) => {
      const slug = locationToSlug(location);
      const path = `/${slug}/sold/`;
      const html = await client.fetchHtml(path);
      const doc = extractJsonLd(html);
      const { items } = findListings(doc);
      const sample = items
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null);
      return minifiedResult({
        region: location,
        slug,
        sold_summary: computeMarketSummary(sample),
        sample_sold: sample,
      });
    }
  );
}
