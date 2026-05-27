import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
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
