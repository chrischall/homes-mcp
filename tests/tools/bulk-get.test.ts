import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@fetchproxy/server';
import type { HomesClient } from '../../src/client.js';
import { registerBulkGetTools } from '../../src/tools/bulk-get.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

let h: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  h = await createTestHarness((server) => registerBulkGetTools(server, mockClient));
});
beforeEach(() => vi.clearAllMocks());
afterAll(async () => h?.close());

const htmlWith = (listing: unknown) => {
  const doc = {
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'BreadcrumbList' }, listing],
  };
  return `<html><script type="application/ld+json">${JSON.stringify(doc)}</script></html>`;
};

describe('homes_bulk_get', () => {
  it('fetches N listings concurrently and returns structured results', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: `https://www.homes.com/property/foo/id-${n}/`,
        offers: { price: n * 100_000 },
        mainEntity: { address: { streetAddress: `${n} Main St` } },
      });
    });
    const r = await h.callTool('homes_bulk_get', {
      urls: ['/property/foo/a/', '/property/foo/b/', '/property/foo/c/'],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      results: Array<{
        url?: string;
        property?: { price?: number };
        error?: string;
      }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results.map((row) => row.property?.price).sort()).toEqual([
      100_000, 200_000, 300_000,
    ]);
  });

  it('captures per-row errors without failing the whole call', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      if (n === 2) throw new Error('boom');
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: `https://www.homes.com/property/foo/id-${n}/`,
        offers: { price: 500_000 },
        mainEntity: { address: { streetAddress: `${n} Main St` } },
      });
    });
    const r = await h.callTool('homes_bulk_get', {
      urls: ['/property/foo/a/', '/property/foo/b/', '/property/foo/c/'],
    });
    const parsed = parseToolResult<{
      results: Array<{ error?: string; property?: { price?: number } }>;
    }>(r);
    expect(parsed.results[1].error).toMatch(/boom/);
    expect(parsed.results[0].property?.price).toBe(500_000);
    expect(parsed.results[2].property?.price).toBe(500_000);
  });

  it('preserves input order in the response', async () => {
    let n = 0;
    // Reverse-order delay so first request resolves last — confirms we
    // align responses to input order, not completion order.
    mockFetchHtml.mockImplementation(async (path: string) => {
      n++;
      const id = path.match(/id-([a-z])/)?.[1] ?? 'x';
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve(
              htmlWith({
                '@type': ['RealEstateListing', 'Product'],
                url: `https://www.homes.com/property/foo/id-${id}/`,
                offers: { price: 100_000 },
                mainEntity: {
                  address: { streetAddress: `${id.toUpperCase()} Main` },
                },
              })
            ),
          (4 - n) * 5
        );
      });
    });
    const r = await h.callTool('homes_bulk_get', {
      urls: [
        '/property/foo/id-a/',
        '/property/foo/id-b/',
        '/property/foo/id-c/',
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{ property?: { address?: string } }>;
    }>(r);
    expect(parsed.results.map((r) => r.property?.address)).toEqual([
      'A Main',
      'B Main',
      'C Main',
    ]);
  });

  it('caps in-flight fetches at BRIDGE_CONCURRENCY (=6)', async () => {
    // Track the high-water mark of concurrent in-flight fetches. Round-3
    // #78 pinned the cohort-wide cap at 6 — fanning a 20-row batch out
    // unbounded was what tipped the bridge into timeouts.
    let inFlight = 0;
    let peakInFlight = 0;
    mockFetchHtml.mockImplementation(async (path: string) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Hold the request open briefly so the worker pool actually has
      // a chance to saturate.
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      const id = path.match(/id-(\d+)/)?.[1] ?? '0';
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: `https://www.homes.com/property/foo/id-${id}/`,
        offers: { price: 100_000 },
        mainEntity: { address: { streetAddress: `${id} Main St` } },
      });
    });
    const urls = Array.from({ length: 20 }, (_, i) => `/property/foo/id-${i}/`);
    const r = await h.callTool('homes_bulk_get', { urls });
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(20);
    expect(peakInFlight).toBeLessThanOrEqual(6);
    expect(peakInFlight).toBeGreaterThan(1); // not serialized
  });

  it('surfaces bridge timeouts as a distinct error string (round-3 #78)', async () => {
    // The cohort-wide contract: a bridge timeout must NOT be reported
    // as "no listing found" or as a generic per-row parse error.
    // `classifyRowError` wraps it as 'bridge timeout after retry: …'
    // so a "20/20 with 2 timeouts" summary stays distinguishable from
    // "20/20 with 2 missing listings". Path-keyed so concurrent
    // fan-out order doesn't affect which row gets the timeout.
    const timeoutCounts = new Map<string, number>();
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (path === '/property/x/b/') {
        // Both first attempt + retry throw → row 1 surfaces
        // 'bridge timeout after retry: …'.
        timeoutCounts.set(path, (timeoutCounts.get(path) ?? 0) + 1);
        throw new FetchproxyTimeoutError({
          url: 'https://homes.com/',
          timeoutMs: 12000,
        });
      }
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: 'https://www.homes.com/property/x/abc/',
        offers: { price: 100_000 },
        mainEntity: { address: { streetAddress: '1 Main' } },
      });
    });
    const r = await h.callTool('homes_bulk_get', {
      urls: ['/property/x/a/', '/property/x/b/', '/property/x/c/'],
    });
    const parsed = parseToolResult<{
      results: Array<{ error?: string; property?: unknown }>;
    }>(r);
    expect(parsed.results[0].property).toBeTruthy();
    expect(parsed.results[1].error).toMatch(/^bridge timeout after retry:/);
    expect(parsed.results[2].property).toBeTruthy();
    // Confirm the retry path actually fired (first attempt + retry).
    expect(timeoutCounts.get('/property/x/b/')).toBe(2);
  });

  it('retries once on timeout — second attempt success surfaces the row', async () => {
    // Path-keyed: first attempt for `/property/x/a/` times out,
    // second attempt resolves. One retry is consumed; row reports
    // success.
    const attempts = new Map<string, number>();
    mockFetchHtml.mockImplementation(async (path: string) => {
      const n = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, n);
      if (n === 1) {
        throw new FetchproxyTimeoutError({
          url: 'https://homes.com/',
          timeoutMs: 12000,
        });
      }
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: 'https://www.homes.com/property/x/abc/',
        offers: { price: 250_000 },
        mainEntity: { address: { streetAddress: '7 Maple Ave' } },
      });
    });
    const r = await h.callTool('homes_bulk_get', {
      urls: ['/property/x/a/'],
    });
    const parsed = parseToolResult<{
      results: Array<{ error?: string; property?: { price?: number } }>;
    }>(r);
    expect(parsed.results[0].error).toBeUndefined();
    expect(parsed.results[0].property?.price).toBe(250_000);
    expect(attempts.get('/property/x/a/')).toBe(2); // one retry consumed
  });

  it('surfaces bridge-down as a distinct error string', async () => {
    mockFetchHtml.mockImplementation(async () => {
      throw new FetchproxyBridgeDownError({
        originalError: 'WebSocket connection refused',
      });
    });
    const r = await h.callTool('homes_bulk_get', {
      urls: ['/property/x/a/'],
    });
    const parsed = parseToolResult<{ results: Array<{ error?: string }> }>(r);
    expect(parsed.results[0].error).toMatch(/^bridge unreachable:/);
  });

  it('omits description by default and accepts include_description', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: 'https://www.homes.com/property/x/abc/',
        description: 'Charming bungalow.',
        offers: { price: 100_000 },
        mainEntity: { address: { streetAddress: '1 Main' } },
      })
    );
    const noDesc = parseToolResult<{
      results: Array<{ property?: { description?: string } }>;
    }>(
      await h.callTool('homes_bulk_get', {
        urls: ['/property/x/abc/'],
      })
    );
    expect(noDesc.results[0].property?.description).toBeUndefined();

    const withDesc = parseToolResult<{
      results: Array<{ property?: { description?: string } }>;
    }>(
      await h.callTool('homes_bulk_get', {
        urls: ['/property/x/abc/'],
        include_description: true,
      })
    );
    expect(withDesc.results[0].property?.description).toContain('Charming');
  });
});
