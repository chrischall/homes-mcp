import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  parseHtml,
  findTableByHeading,
  tableRows,
  normalizeDate,
  parseDollar,
  parsePercent,
  type HTMLElement,
} from '../html.js';
import { urlToPath } from '../url.js';
import { lastPathSegment } from '../jsonld.js';
import { mapEventType, type NormalizedEventType } from '@chrischall/realty-core';
import { extractJsonLd, findGraphNode } from '../page-state.js';

/**
 * homes.com detail pages render four parallel history tables:
 *
 *   - "Property History"  — listings, price changes, sales, off-market
 *                            (MM/DD/YYYY dates)
 *   - "Purchase History"  — deeds (MM/DD/YY dates)
 *   - "Mortgage History"  — liens (MM/DD/YY dates)
 *   - "Tax History"       — year-by-year tax assessments
 *
 * Three of those (property/purchase/mortgage) are collapsed into one
 * tool here for ergonomics — a single call gives the full timeline that
 * a user sees on the page. Tax history is its own tool because the
 * row shape and use cases differ.
 */

export interface ListingEvent {
  date: string;
  date_raw?: string;
  event: string;
  price?: number;
  list_to_sale_pct?: number;
  price_per_sqft?: number;
}

/**
 * Standard cross-MCP event type enum (#26). Now sourced from the
 * canonical `@chrischall/realty-core` taxonomy (realty-mcp#1), which is
 * the union of every cohort MCP's enum plus an `'Unknown'` sentinel for
 * input that doesn't map. `normalizeEvents` drops the `'Unknown'` rows
 * (with a stderr warning), so the values that actually surface in
 * homes-mcp output are unchanged from the prior 8-member union.
 */
export type { NormalizedEventType };

export interface NormalizedEvent {
  date: string;
  type: NormalizedEventType;
  price?: number;
  price_change_pct?: number;
  dom?: number;
  source_mls?: string;
}

/**
 * Maps homes.com's free-text `event` strings to the cross-MCP enum
 * (#26). Returns the normalized list, dropping rows that don't map —
 * unrecognized strings emit a stderr warning so the taxonomy can be
 * extended once we see them in the wild.
 */
export function normalizeEvents(events: ListingEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const e of events) {
    // Canonical cohort mapper (realty-mcp#1). Returns `'Unknown'` rather
    // than `null` for input it can't classify — homes-mcp drops those
    // rows (with a stderr warning) exactly as the old inline mapper did,
    // so the normalized output never carries `'Unknown'`.
    const type = mapEventType(e.event);
    if (type === 'Unknown') {
      console.error(
        `[homes-mcp] events_normalized: unrecognized event "${e.event}" — dropped from normalized list`
      );
      continue;
    }
    const rec: NormalizedEvent = { date: e.date, type };
    if (typeof e.price === 'number') rec.price = e.price;
    if (typeof e.list_to_sale_pct === 'number') {
      rec.price_change_pct = e.list_to_sale_pct;
    }
    out.push(rec);
  }
  return out;
}

export interface OwnershipEvent {
  date: string;
  date_raw?: string;
  deed_type?: string;
  sale_price?: number;
  title_company?: string;
}

export interface LienEvent {
  date: string;
  date_raw?: string;
  status?: string;
  loan_amount?: number;
  loan_type?: string;
}

function withDate<T extends { date: string; date_raw?: string }>(
  base: Omit<T, 'date' | 'date_raw'>,
  rawDate: string
): T {
  const n = normalizeDate(rawDate);
  const out = { ...base, date: n.iso ?? n.raw } as T;
  if (!n.iso) out.date_raw = n.raw;
  return out;
}

export function parsePropertyHistory(root: HTMLElement): ListingEvent[] {
  const t = findTableByHeading(root, 'Property History');
  if (!t) return [];
  return tableRows(t)
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [date, event, price, listToSale, ppsf] = cells;
      const base: Omit<ListingEvent, 'date' | 'date_raw'> = {
        event: (event ?? '').trim(),
      };
      if (price !== undefined) {
        const n = parseDollar(price);
        if (n !== undefined) base.price = n;
      }
      if (listToSale !== undefined) {
        const n = parsePercent(listToSale);
        if (n !== undefined) base.list_to_sale_pct = n;
      }
      if (ppsf !== undefined) {
        const n = parseDollar(ppsf);
        if (n !== undefined) base.price_per_sqft = n;
      }
      return withDate<ListingEvent>(base, date ?? '');
    });
}

export function parseOwnershipHistory(root: HTMLElement): OwnershipEvent[] {
  const t = findTableByHeading(root, 'Purchase History');
  if (!t) return [];
  return tableRows(t)
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [date, deedType, salePrice, titleCo] = cells;
      const base: Omit<OwnershipEvent, 'date' | 'date_raw'> = {};
      if (deedType) base.deed_type = deedType.trim();
      if (salePrice !== undefined) {
        const n = parseDollar(salePrice);
        if (n !== undefined) base.sale_price = n;
      }
      if (titleCo && titleCo.trim() !== '--' && titleCo.trim() !== '') {
        base.title_company = titleCo.trim();
      }
      return withDate<OwnershipEvent>(base, date ?? '');
    });
}

export function parseLienHistory(root: HTMLElement): LienEvent[] {
  const t = findTableByHeading(root, 'Mortgage History');
  if (!t) return [];
  return tableRows(t)
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [date, status, loanAmt, loanType] = cells;
      const base: Omit<LienEvent, 'date' | 'date_raw'> = {};
      if (status) base.status = status.trim();
      if (loanAmt !== undefined) {
        const n = parseDollar(loanAmt);
        if (n !== undefined) base.loan_amount = n;
      }
      if (loanType) base.loan_type = loanType.trim();
      return withDate<LienEvent>(base, date ?? '');
    });
}

export interface TaxRecord {
  year: number;
  tax_paid?: number;
  assessment_total?: number;
  assessment_land?: number;
  assessment_improvement?: number;
}

export function parseTaxHistory(root: HTMLElement): TaxRecord[] {
  const t = findTableByHeading(root, 'Tax History');
  if (!t) return [];
  return tableRows(t)
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [yearRaw, paid, assess, land, improvement] = cells;
      const year = Number((yearRaw ?? '').trim());
      const rec: TaxRecord = { year: Number.isFinite(year) ? year : 0 };
      const p = paid !== undefined ? parseDollar(paid) : undefined;
      if (p !== undefined) rec.tax_paid = p;
      const a = assess !== undefined ? parseDollar(assess) : undefined;
      if (a !== undefined) rec.assessment_total = a;
      const l = land !== undefined ? parseDollar(land) : undefined;
      if (l !== undefined) rec.assessment_land = l;
      const i = improvement !== undefined ? parseDollar(improvement) : undefined;
      if (i !== undefined) rec.assessment_improvement = i;
      return rec;
    })
    .filter((rec) => rec.year > 0);
}

function extractPropertyIdFromHtml(html: string, fallbackUrl: string): string {
  const doc = extractJsonLd(html);
  const node = findGraphNode(doc, 'RealEstateListing') as
    | { '@id'?: string; url?: string }
    | null;
  // Prefer node.url over node['@id'] — see properties.ts:extractPropertyId
  // (homes.com @id now carries a `#realestatelisting` fragment).
  return lastPathSegment(node?.url ?? node?.['@id'] ?? fallbackUrl);
}

export function registerHistoryTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_property_history',
    {
      title: 'Get homes.com property history (DEPRECATED — use homes_get_history)',
      description:
        "DEPRECATED — prefer `homes_get_history` (combined timelines + tax) or `homes_get_property({ url, include_price_history: true })`. Same data, fewer round trips. Will be removed in a future major version. Three timelines for a homes.com property in one call: `listing_events`, `ownership_events`, `lien_events`. Also returns `events_normalized` mapped onto the cross-MCP enum.",
      annotations: {
        title: 'Get homes.com property history (DEPRECATED — use homes_get_history)',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().describe('homes.com property detail URL or path.'),
      },
    },
    async ({ url }) => {
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const root = parseHtml(html);
      const listing_events = parsePropertyHistory(root);
      return textResult({
        property_id: extractPropertyIdFromHtml(html, url),
        url,
        listing_events,
        events_normalized: normalizeEvents(listing_events),
        ownership_events: parseOwnershipHistory(root),
        lien_events: parseLienHistory(root),
      });
    }
  );

  server.registerTool(
    'homes_get_tax_history',
    {
      title: 'Get homes.com property tax history (DEPRECATED — use homes_get_history)',
      description:
        "DEPRECATED — prefer `homes_get_history` (combined timelines + tax) or `homes_get_property({ url, include_tax_history: true })`. Same data, fewer round trips; note that `homes_get_history` returns the tax array as `tax_records` (not `records`). Will be removed in a future major version. Year-by-year property-tax records: tax paid, total assessed value, land/improvement split.",
      annotations: {
        title: 'Get homes.com property tax history (DEPRECATED — use homes_get_history)',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().describe('homes.com property detail URL or path.'),
      },
    },
    async ({ url }) => {
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const root = parseHtml(html);
      return textResult({
        property_id: extractPropertyIdFromHtml(html, url),
        url,
        records: parseTaxHistory(root),
      });
    }
  );

  // #31: combined endpoint that returns BOTH price + tax history. Same
  // fetch as either split tool — preferred over the split surface
  // (which is now marked DEPRECATED in its tool descriptions).
  server.registerTool(
    'homes_get_history',
    {
      title: 'Get homes.com property + tax history (combined)',
      description:
        "Combined history endpoint — replaces `homes_get_property_history` + `homes_get_tax_history` with a single fetch. Returns `{ property_id, url, listing_events, ownership_events, lien_events, events_normalized, tax_records }`. Pass `url` — the full property detail URL. Series are `[]` when the listing doesn't carry that section. Cross-MCP-normalized `events_normalized` carries the same enum across siblings (Listed/PriceChange/Pending/Contingent/Sold/Withdrawn/Relisted/Delisted). Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get homes.com property + tax history (combined)',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().describe('homes.com property detail URL or path.'),
      },
    },
    async ({ url }) => {
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const root = parseHtml(html);
      const listing_events = parsePropertyHistory(root);
      return textResult({
        property_id: extractPropertyIdFromHtml(html, url),
        url,
        listing_events,
        ownership_events: parseOwnershipHistory(root),
        lien_events: parseLienHistory(root),
        events_normalized: normalizeEvents(listing_events),
        tax_records: parseTaxHistory(root),
      });
    }
  );
}
