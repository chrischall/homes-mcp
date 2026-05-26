import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import { parseNearbyListings, registerNearbyTools } from '../../src/tools/nearby.js';
import { parseHtml } from '../../src/html.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = readFileSync(resolve(__dirname, '../fixtures/nearby-listings.html'), 'utf8');

describe('parseNearbyListings', () => {
  it('returns the For Sale tab (ul#nb-Property) by default', () => {
    const root = parseHtml(FIX);
    const items = parseNearbyListings(root);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      property_id: 'aaa111',
      url: 'https://www.homes.com/property/3185-delmar-ln-nw-atlanta-ga-unit-1/aaa111/',
      address: '3185 Delmar Ln NW Unit 1',
      tab: 'for_sale',
    });
    expect(items[2].property_id).toBe('ccc333');
  });

  it('does not include the Rentals tab by default', () => {
    const root = parseHtml(FIX);
    const items = parseNearbyListings(root);
    const tabs = new Set(items.map((i) => i.tab));
    expect(tabs).toEqual(new Set(['for_sale']));
  });

  it('with include_rentals=true also pulls the Rentals tab (ul#nb-property)', () => {
    const root = parseHtml(FIX);
    const items = parseNearbyListings(root, { include_rentals: true });
    expect(items).toHaveLength(5); // 3 for_sale + 2 for_rent
    const rentals = items.filter((i) => i.tab === 'for_rent');
    expect(rentals).toHaveLength(2);
    expect(rentals[0].property_id).toBe('rrr444');
    expect(rentals[0].address).toBe('3188 Delmar Ln NW');
  });

  it('returns [] when no nearby section is present', () => {
    const root = parseHtml('<html><body><h1>Just a page</h1></body></html>');
    expect(parseNearbyListings(root)).toEqual([]);
  });

  it('prefers the <a title> attribute over link text when both differ', () => {
    const root = parseHtml(`<ul id="nb-Property"><li>
      <a class="text-only" href="/property/x/zzz/" title="Real Address Title"> ignore </a>
    </li></ul>`);
    expect(parseNearbyListings(root)[0].address).toBe('Real Address Title');
  });
});

describe('homes_get_nearby_listings tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerNearbyTools(s, c));
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => h?.close());

  it('returns property_id, count, listings[] with tab="for_sale"', async () => {
    fetch.mockResolvedValueOnce(FIX);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_nearby_listings', {
        url: 'https://www.homes.com/property/x/abc123/',
      })
    );
    expect(p.count).toBe(3);
    expect(p.listings).toHaveLength(3);
    expect(p.listings.every((l: any) => l.tab === 'for_sale')).toBe(true);
  });

  it('respects limit', async () => {
    fetch.mockResolvedValueOnce(FIX);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_nearby_listings', {
        url: 'https://www.homes.com/property/x/abc123/',
        limit: 1,
      })
    );
    expect(p.listings).toHaveLength(1);
  });

  it('include_rentals=true picks up the Rentals tab too', async () => {
    fetch.mockResolvedValueOnce(FIX);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_nearby_listings', {
        url: 'https://www.homes.com/property/x/abc123/',
        include_rentals: true,
      })
    );
    expect(p.count).toBe(5);
    const tabs = new Set(p.listings.map((l: any) => l.tab));
    expect(tabs).toEqual(new Set(['for_sale', 'for_rent']));
  });
});
