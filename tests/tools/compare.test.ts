import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import { buildSummary, registerCompareTools } from '../../src/tools/compare.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

const htmlWith = (listing: unknown) => {
  const doc = {
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'BreadcrumbList' }, listing],
  };
  return `<html><script type="application/ld+json">${JSON.stringify(doc)}</script></html>`;
};

describe('buildSummary', () => {
  it('aligns per-field values across rows + null-fills errors', () => {
    const rows = [
      {
        url: 'u',
        property: {
          property_id: 'a',
          url: 'u',
          address: '1 Main',
          price: 100,
          beds: 2,
        } as never,
      },
      { url: 'b-url', error: 'fetch failed' },
      {
        url: 'u',
        property: {
          property_id: 'c',
          url: 'u',
          address: '3 Main',
          price: 300,
          beds: 4,
        } as never,
      },
    ];
    const summary = buildSummary(rows);
    const price = summary.find((r) => r.field === 'price')!;
    expect(price.values).toEqual([100, null, 300]);
    const beds = summary.find((r) => r.field === 'beds')!;
    expect(beds.values).toEqual([2, null, 4]);
  });
});

describe('homes_compare_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerCompareTools(server, mockClient)
    );
  });

  it('runs concurrent fetches per target and aligns the summary', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        '@id': `https://www.homes.com/property/foo/id-${n}/`,
        url: `https://www.homes.com/property/foo/id-${n}/`,
        offers: { price: n * 100_000 },
        mainEntity: {
          address: { streetAddress: `${n} Main` },
          numberOfBedrooms: n,
          numberOfBathroomsTotal: n,
        },
      });
    });

    const r = await harness.callTool('homes_compare_properties', {
      targets: [
        { url: '/property/foo/a/' },
        { url: '/property/foo/b/' },
        { url: '/property/foo/c/' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      results: Array<{ property?: { price?: number } }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.results.map((res) => res.property?.price)).toEqual([
      100_000, 200_000, 300_000,
    ]);
  });

  it('omits summary by default (#18 — opt-in)', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: `https://www.homes.com/property/foo/id-${n}/`,
        offers: { price: n * 100_000 },
        mainEntity: { address: { streetAddress: `${n} Main` } },
      });
    });

    const r = await harness.callTool('homes_compare_properties', {
      targets: [{ url: '/property/foo/a/' }, { url: '/property/foo/b/' }],
    });
    const parsed = parseToolResult<{ summary?: unknown; results: unknown[] }>(r);
    expect(parsed.summary).toBeUndefined();
    expect(parsed.results).toHaveLength(2);
  });

  it('emits summary when include_summary: true', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: `https://www.homes.com/property/foo/id-${n}/`,
        offers: { price: n * 100_000 },
        mainEntity: { address: { streetAddress: `${n} Main` } },
      });
    });

    const r = await harness.callTool('homes_compare_properties', {
      targets: [{ url: '/property/foo/a/' }, { url: '/property/foo/b/' }],
      include_summary: true,
    });
    const parsed = parseToolResult<{
      summary: Array<{ field: string; values: unknown[] }>;
    }>(r);
    expect(parsed.summary).toBeDefined();
    const price = parsed.summary.find((r) => r.field === 'price')!;
    expect(price.values).toEqual([100_000, 200_000]);
  });

  it('summary hoa_fee values mirror the per-row property.hoa_fee shape (#18)', async () => {
    // The two cells for `hoa_fee` in the summary should equal the
    // per-row `property.hoa_fee` — same type, same null-vs-number
    // representation. The fixture has no HOA section so both rows
    // null out.
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        url: `https://www.homes.com/property/foo/id-${n}/`,
        offers: { price: 100_000 },
        mainEntity: { address: { streetAddress: `${n} Main` } },
      });
    });
    const r = await harness.callTool('homes_compare_properties', {
      targets: [{ url: '/property/foo/a/' }, { url: '/property/foo/b/' }],
      include_summary: true,
    });
    const parsed = parseToolResult<{
      summary: Array<{ field: string; values: unknown[] }>;
      results: Array<{ property: Record<string, unknown> }>;
    }>(r);
    const hoaSummary = parsed.summary.find((s) => s.field === 'hoa_fee')!;
    expect(hoaSummary.values).toEqual(
      parsed.results.map((row) => row.property.hoa_fee ?? null)
    );
  });

  it('captures per-target errors without failing the whole call', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      if (n === 2) throw new Error('boom');
      return htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        '@id': `https://www.homes.com/property/foo/id-${n}/`,
        url: `https://www.homes.com/property/foo/id-${n}/`,
        offers: { price: 500_000 },
        mainEntity: { address: { streetAddress: `${n} Main` } },
      });
    });

    const r = await harness.callTool('homes_compare_properties', {
      targets: [
        { url: '/property/foo/a/' },
        { url: '/property/foo/b/' },
        { url: '/property/foo/c/' },
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{ error?: string; property?: { price?: number } }>;
    }>(r);
    expect(parsed.results[0].property?.price).toBe(500_000);
    expect(parsed.results[1].error).toMatch(/boom/);
    expect(parsed.results[2].property?.price).toBe(500_000);
  });
});
