import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import {
  normalizeEvents,
  parsePropertyHistory,
  parseOwnershipHistory,
  parseLienHistory,
  parseTaxHistory,
  registerHistoryTools,
} from '../../src/tools/history.js';
import { parseHtml } from '../../src/html.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FULL = readFileSync(resolve(__dirname, '../fixtures/history-full.html'), 'utf8');
const EMPTY = readFileSync(resolve(__dirname, '../fixtures/history-empty.html'), 'utf8');
const TAX = readFileSync(resolve(__dirname, '../fixtures/tax-history.html'), 'utf8');

describe('parsePropertyHistory', () => {
  it('parses listing events with normalized dates and numeric fields', () => {
    const root = parseHtml(FULL);
    const events = parsePropertyHistory(root);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      date: '2026-04-30',
      event: 'Price Changed',
      price: 315000,
      list_to_sale_pct: -5.8,
      price_per_sqft: 149,
    });
    expect(events[1].event).toBe('Listed');
    expect(events[1].price).toBe(335000);
    expect(events[1].list_to_sale_pct).toBeUndefined();
    expect(events[2].event).toBe('Off Market');
    expect(events[2].price).toBeUndefined();
  });

  it('returns [] when the section is missing', () => {
    const root = parseHtml(EMPTY);
    expect(parsePropertyHistory(root)).toEqual([]);
  });
});

describe('parseOwnershipHistory', () => {
  it('parses Purchase History rows with MM/DD/YY → 20xx', () => {
    const root = parseHtml(FULL);
    const events = parseOwnershipHistory(root);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      date: '2022-05-04',
      deed_type: 'Warranty Deed',
      sale_price: 152000,
    });
    expect(events[1].title_company).toBe('Bay Title');
  });
});

describe('parseLienHistory', () => {
  it('parses Mortgage History rows', () => {
    const root = parseHtml(FULL);
    const events = parseLienHistory(root);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      date: '2022-05-04',
      status: 'Closed',
      loan_amount: 220500,
      loan_type: 'Mortgage Modification',
    });
  });
});

describe('normalizeEvents (#26)', () => {
  it('maps "Listed" to Listed', () => {
    const out = normalizeEvents([
      { date: '2026-01-01', event: 'Listed', price: 500_000 },
    ]);
    expect(out).toEqual([{ date: '2026-01-01', type: 'Listed', price: 500_000 }]);
  });

  it('maps "Price Changed" / "Price Reduced" to PriceChange', () => {
    const out = normalizeEvents([
      { date: '2026-02-01', event: 'Price Changed', price: 480_000 },
      { date: '2026-02-15', event: 'Price Reduced', price: 460_000 },
    ]);
    expect(out.map((e) => e.type)).toEqual(['PriceChange', 'PriceChange']);
  });

  it('maps "Pending" / "Contingent" / "Sold" / "Withdrawn" / "Off Market" to enum', () => {
    const out = normalizeEvents([
      { date: '2026-03-01', event: 'Pending' },
      { date: '2026-03-05', event: 'Contingent' },
      { date: '2026-03-10', event: 'Sold' },
      { date: '2026-03-15', event: 'Withdrawn' },
      { date: '2026-03-20', event: 'Off Market' },
    ]);
    expect(out.map((e) => e.type)).toEqual([
      'Pending',
      'Contingent',
      'Sold',
      'Withdrawn',
      'Delisted',
    ]);
  });

  it('maps "Relisted" to Relisted', () => {
    const out = normalizeEvents([{ date: '2026-04-01', event: 'Relisted' }]);
    expect(out[0].type).toBe('Relisted');
  });

  it('maps "Sale Completed" / "Completed" to Sold (realty-core 0.4.0)', () => {
    // realty-core 0.4.0 adds `completed` → Sold to mapEventType, so
    // homes.com's "Sale Completed" / "Completed" event strings normalize
    // to Sold via the wrapper instead of dropping as Unknown.
    const out = normalizeEvents([
      { date: '2026-04-10', event: 'Sale Completed' },
      { date: '2026-04-12', event: 'Completed' },
    ]);
    expect(out.map((e) => e.type)).toEqual(['Sold', 'Sold']);
  });

  it('preserves price + carries price_change_pct when present', () => {
    const out = normalizeEvents([
      {
        date: '2026-05-01',
        event: 'Price Changed',
        price: 480_000,
        list_to_sale_pct: -4.0,
      },
    ]);
    expect(out[0]).toMatchObject({
      type: 'PriceChange',
      price: 480_000,
      price_change_pct: -4.0,
    });
  });

  it('drops unmappable rows + emits a stderr warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = normalizeEvents([
      { date: '2026-05-01', event: 'Some Unrecognized Action' },
    ]);
    expect(out).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unrecognized'));
    spy.mockRestore();
  });

  it('does NOT false-match "Inactive" / "Foreclosed" via word-boundary anchors (realty-core delta)', () => {
    // The canonical mapper anchors `\bactive\b` and `\bclosed\b` so
    // "Inactive" doesn't bucket as Listed and "Foreclosed" doesn't
    // bucket as Sold — both fall through to the dropped `'Unknown'` row.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = normalizeEvents([
      { date: '2026-05-01', event: 'Inactive' },
      { date: '2026-05-02', event: 'Foreclosed' },
    ]);
    expect(out).toEqual([]);
    spy.mockRestore();
  });

  it('handles empty input', () => {
    expect(normalizeEvents([])).toEqual([]);
  });
});

describe('homes_get_property_history tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerHistoryTools(s, c));
  });
  afterAll(async () => h?.close());

  it('returns all three series for a full-history listing', async () => {
    fetch.mockResolvedValueOnce(FULL);
    const r = await h.callTool('homes_get_property_history', {
      url: 'https://www.homes.com/property/x/abc123/',
    });
    expect(r.isError).toBeFalsy();
    const p = parseToolResult<any>(r);
    expect(p.property_id).toBe('abc123');
    expect(p.listing_events).toHaveLength(3);
    expect(p.ownership_events).toHaveLength(3);
    expect(p.lien_events).toHaveLength(2);
  });

  it('emits events_normalized alongside listing_events (#26)', async () => {
    fetch.mockResolvedValueOnce(FULL);
    const p = parseToolResult<{
      listing_events: unknown[];
      events_normalized: Array<{ date: string; type: string; price?: number }>;
    }>(
      await h.callTool('homes_get_property_history', {
        url: 'https://www.homes.com/property/x/abc123/',
      })
    );
    expect(p.events_normalized).toBeDefined();
    expect(p.events_normalized.length).toBeGreaterThan(0);
    // Every normalized entry has a type from the standard enum.
    const validTypes = new Set([
      'Listed',
      'PriceChange',
      'Pending',
      'Contingent',
      'Sold',
      'Withdrawn',
      'Relisted',
      'Delisted',
    ]);
    for (const e of p.events_normalized) {
      expect(validTypes.has(e.type)).toBe(true);
    }
  });

  it('returns three empty arrays for a new-construction-style empty listing', async () => {
    fetch.mockResolvedValueOnce(EMPTY);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property_history', {
        url: 'https://www.homes.com/property/x/empty/',
      })
    );
    expect(p.listing_events).toEqual([]);
    expect(p.ownership_events).toEqual([]);
    expect(p.lien_events).toEqual([]);
  });
});

describe('parseTaxHistory', () => {
  it('parses every row with numeric fields', () => {
    const root = parseHtml(TAX);
    const events = parseTaxHistory(root);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      year: 2025,
      tax_paid: 2714,
      assessment_total: 72520,
      assessment_land: 20200,
      assessment_improvement: 52320,
    });
    expect(events[2].tax_paid).toBeUndefined();
    expect(events[2].assessment_total).toBe(65000);
  });

  it('returns [] when no Tax History section', () => {
    const root = parseHtml(EMPTY);
    expect(parseTaxHistory(root)).toEqual([]);
  });
});

describe('homes_get_tax_history tool', () => {
  let h2: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch2 = vi.fn();
  const c2 = { fetchHtml: fetch2 } as unknown as HomesClient;

  beforeAll(async () => {
    h2 = await createTestHarness((s) => registerHistoryTools(s, c2));
  });
  afterAll(async () => h2?.close());

  it('returns parsed tax records', async () => {
    fetch2.mockResolvedValueOnce(TAX);
    const p = parseToolResult<any>(
      await h2.callTool('homes_get_tax_history', {
        url: 'https://www.homes.com/property/x/abc123/',
      })
    );
    expect(p.records).toHaveLength(3);
    expect(p.records[0].year).toBe(2025);
  });
});

describe('homes_get_history (combined) tool — #31', () => {
  let hc: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch3 = vi.fn();
  const c3 = { fetchHtml: fetch3 } as unknown as HomesClient;

  beforeAll(async () => {
    hc = await createTestHarness((s) => registerHistoryTools(s, c3));
  });
  afterAll(async () => hc?.close());

  it('returns price + tax in one call', async () => {
    // FULL has price/ownership/lien sections; TAX has tax. Combining
    // them in one HTML payload simulates a real listing page.
    fetch3.mockResolvedValueOnce(FULL + TAX);
    const r = await hc.callTool('homes_get_history', {
      url: 'https://www.homes.com/property/x/abc123/',
    });
    expect(r.isError).toBeFalsy();
    const p = parseToolResult<{
      listing_events: unknown[];
      ownership_events: unknown[];
      lien_events: unknown[];
      events_normalized: Array<{ type: string }>;
      tax_records: Array<{ year: number }>;
    }>(r);
    expect(p.listing_events.length).toBeGreaterThan(0);
    expect(p.ownership_events.length).toBeGreaterThan(0);
    expect(p.lien_events.length).toBeGreaterThan(0);
    expect(p.events_normalized.length).toBeGreaterThan(0);
    expect(p.tax_records.length).toBeGreaterThan(0);
  });

  it('returns empty series for a listing with no history sections', async () => {
    fetch3.mockResolvedValueOnce(EMPTY);
    const p = parseToolResult<{
      listing_events: unknown[];
      tax_records: unknown[];
    }>(
      await hc.callTool('homes_get_history', {
        url: 'https://www.homes.com/property/x/empty/',
      })
    );
    expect(p.listing_events).toEqual([]);
    expect(p.tax_records).toEqual([]);
  });
});
