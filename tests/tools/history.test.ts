import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import {
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
