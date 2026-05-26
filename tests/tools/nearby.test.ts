import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
  it('returns nearby property cards with id/url/address/price/beds/baths/sqft', () => {
    const root = parseHtml(FIX);
    const items = parseNearbyListings(root);
    expect(items).toHaveLength(2);
    expect(items[0].property_id).toBe('aaa111');
    expect(items[0].url).toBe('https://www.homes.com/property/3185-delmar-ln-nw-atlanta-ga/aaa111/');
    expect(items[0].address).toContain('3185 Delmar');
    expect(items[0].price).toBe(295000);
    expect(items[0].beds).toBe(3);
    expect(items[0].baths).toBe(2);
    expect(items[0].sqft).toBe(1800);
    expect(items[0].primary_photo_url).toContain('aaa111');
  });

  it('returns [] when no nearby section', () => {
    const root = parseHtml('<html><body><h1>Just a page</h1></body></html>');
    expect(parseNearbyListings(root)).toEqual([]);
  });
});

describe('homes_get_nearby_listings tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerNearbyTools(s, c));
  });
  afterAll(async () => h?.close());

  it('returns property_id, count, listings[]', async () => {
    fetch.mockResolvedValueOnce(FIX);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_nearby_listings', {
        url: 'https://www.homes.com/property/x/abc123/',
      })
    );
    expect(p.count).toBe(2);
    expect(p.listings).toHaveLength(2);
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
});
