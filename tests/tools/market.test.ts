import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import { computeMarketSummary, registerMarketTools } from '../../src/tools/market.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLD = readFileSync(resolve(__dirname, '../fixtures/sold-page.html'), 'utf8');

describe('computeMarketSummary', () => {
  it('returns median price + count + mean $/sqft', () => {
    const s = computeMarketSummary([
      { price: 650000, sqft: 1200 },
      { price: 850000, sqft: 1500 },
      { price: 1200000, sqft: 2000 },
    ]);
    expect(s.count).toBe(3);
    expect(s.median_price).toBe(850000);
    expect(s.avg_price_per_sqft).toBeCloseTo(
      (650000 / 1200 + 850000 / 1500 + 1200000 / 2000) / 3,
      0
    );
  });

  it('handles even-count median', () => {
    const s = computeMarketSummary([{ price: 100 }, { price: 200 }, { price: 300 }, { price: 400 }]);
    expect(s.median_price).toBe(250); // (200+300)/2
  });

  it('skips entries with no price', () => {
    const s = computeMarketSummary([{ price: 100 }, {}, { price: 300 }]);
    expect(s.count).toBe(2);
    expect(s.median_price).toBe(200);
  });

  it('returns zero count when no sold listings', () => {
    const s = computeMarketSummary([]);
    expect(s.count).toBe(0);
    expect(s.median_price).toBeUndefined();
  });
});

describe('homes_get_market_report tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerMarketTools(s, c));
  });
  afterAll(async () => h?.close());

  it('fetches /<location>/sold/ and returns sold_summary + sample', async () => {
    fetch.mockResolvedValueOnce(SOLD);
    const r = await h.callTool('homes_get_market_report', {
      location: 'Brooklyn, NY',
    });
    expect(fetch.mock.calls[0][0]).toBe('/brooklyn-ny/sold/');
    const p = parseToolResult<any>(r);
    expect(p.region).toBe('Brooklyn, NY');
    expect(p.slug).toBe('brooklyn-ny');
    expect(p.sold_summary.count).toBe(3);
    expect(p.sold_summary.median_price).toBe(850000);
    expect(p.sample_sold).toHaveLength(3);
    expect(p.sample_sold[0].property_id).toBe('aaa');
  });
});
