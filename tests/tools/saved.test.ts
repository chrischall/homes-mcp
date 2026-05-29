import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import {
  parseSavedHomes,
  parseSavedSearches,
  registerSavedTools,
} from '../../src/tools/saved.js';
import { parseHtml } from '../../src/html.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(resolve(__dirname, '../fixtures', n), 'utf8');
const HOMES_FULL = fx('saved-homes-populated.html');
const HOMES_EMPTY = fx('saved-homes-empty.html');
const SEARCHES_FULL = fx('saved-searches-populated.html');
const SEARCHES_EMPTY = fx('saved-searches-empty.html');

describe('parseSavedHomes', () => {
  it('returns one entry per favorite card', () => {
    const items = parseSavedHomes(parseHtml(HOMES_FULL));
    expect(items).toHaveLength(2);
    expect(items[0].property_id).toBe('abc123');
    expect(items[0].address).toContain('3199 Delmar');
    expect(items[0].price).toBe(315000);
    expect(items[0].beds).toBe(5);
    expect(items[0].baths).toBe(2);
    expect(items[0].sqft).toBe(2116);
    expect(items[0].status).toBe('Active');
    expect(items[1].baths).toBe(3.5);
  });

  it('returns [] for the empty state', () => {
    expect(parseSavedHomes(parseHtml(HOMES_EMPTY))).toEqual([]);
  });

  it('omits baths (does not set 0) when the card shows a "--" sentinel', () => {
    // The old inline Number() parser turned "--" into 0; route through
    // the shared safe parser so an absent value stays absent.
    const html = `<article>
      <a href="/property/x/sentinel1/"></a>
      <span class="baths">-- ba</span>
    </article>`;
    const items = parseSavedHomes(parseHtml(html));
    expect(items).toHaveLength(1);
    expect(items[0].baths).toBeUndefined();
  });
});

describe('parseSavedSearches', () => {
  it('returns one entry per saved-search card', () => {
    const items = parseSavedSearches(parseHtml(SEARCHES_FULL));
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe('Atlanta condos under $500k');
    expect(items[0].url).toBe('https://www.homes.com/atlanta-ga/condos-for-sale/');
    expect(items[0].filters).toBe('Condo · For Sale · $0–$500K');
    expect(items[1].url).toBe('https://www.homes.com/brooklyn-ny/townhouses-for-sale/');
  });

  it('returns [] for the empty state', () => {
    expect(parseSavedSearches(parseHtml(SEARCHES_EMPTY))).toEqual([]);
  });
});

describe('homes_get_saved_homes / homes_get_saved_searches tools', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerSavedTools(s, c));
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => h?.close());

  it('saved_homes hits /customer/dashboard/favorites/ and returns parsed cards', async () => {
    fetch.mockResolvedValueOnce(HOMES_FULL);
    const p = parseToolResult<any>(await h.callTool('homes_get_saved_homes', {}));
    expect(fetch.mock.calls[0][0]).toBe('/customer/dashboard/favorites/');
    expect(p.count).toBe(2);
    expect(p.homes).toHaveLength(2);
  });

  it('saved_homes returns count:0 when empty', async () => {
    fetch.mockResolvedValueOnce(HOMES_EMPTY);
    const p = parseToolResult<any>(await h.callTool('homes_get_saved_homes', {}));
    expect(p.count).toBe(0);
    expect(p.homes).toEqual([]);
  });

  it('saved_searches hits /customer/dashboard/saved-searches/ and returns parsed cards', async () => {
    fetch.mockResolvedValueOnce(SEARCHES_FULL);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_saved_searches', {})
    );
    expect(fetch.mock.calls[0][0]).toBe('/customer/dashboard/saved-searches/');
    expect(p.count).toBe(2);
    expect(p.searches).toHaveLength(2);
  });

  it('saved_searches returns count:0 when empty', async () => {
    fetch.mockResolvedValueOnce(SEARCHES_EMPTY);
    const p = parseToolResult<any>(await h.callTool('homes_get_saved_searches', {}));
    expect(p.count).toBe(0);
  });
});
