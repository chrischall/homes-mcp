// The `view` rollout is a cross-cutting change: five read tools each wire
// `viewArg()` into their schema and route their payload through `viewResponse`,
// and a sixth (homes_get_property_photos) must NOT. Nothing in src/view.ts can
// tell you whether a given tool was wired — that is per-call-site, and a tool
// left on the old `minifiedResult` path looks completely healthy from every
// other test in this suite. So the wiring itself is asserted here, once per
// tool, rather than left implied by the unit tests in tests/view.test.ts.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import { registerSearchTools } from '../../src/tools/search.js';
import { registerPropertyTools } from '../../src/tools/properties.js';
import { registerCompareTools } from '../../src/tools/compare.js';
import { registerBulkGetTools } from '../../src/tools/bulk-get.js';
import { registerMarketTools } from '../../src/tools/market.js';
import { registerPhotosTools } from '../../src/tools/photos.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

const PHOTO = 'https://images.homes.com/listing/aaa/primary.jpg';
const DESCRIPTION = 'Charming ranch.\n\n  Updated kitchen.\n\tNew roof 2024.\n\nMotivated seller.';

/** A single property-detail page carrying a photo and a multi-paragraph blurb. */
function detailHtml(id = 'aaa'): string {
  const doc = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['RealEstateListing', 'Product'],
        '@id': `https://www.homes.com/property/x/${id}/`,
        url: `https://www.homes.com/property/x/${id}/`,
        description: DESCRIPTION,
        image: [PHOTO],
        offers: { price: 500000, availability: 'https://schema.org/InStock' },
        mainEntity: {
          address: {
            streetAddress: `${id} Main St`,
            addressLocality: 'Atlanta',
            addressRegion: 'GA',
            postalCode: '30311',
          },
          numberOfBedrooms: 3,
          numberOfBathroomsTotal: 2,
          floorSize: { value: 1500, unitCode: 'FTK' },
        },
      },
    ],
  };
  return `<html><script type="application/ld+json">${JSON.stringify(doc)}</script></html>`;
}

/** A search / sold collection page carrying one listing with a photo. */
function collectionHtml(id = 'aaa'): string {
  const doc = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        mainEntity: {
          numberOfItems: 1,
          itemListElement: [
            {
              '@type': ['RealEstateListing', 'Product'],
              '@id': `https://www.homes.com/property/x/${id}/`,
              url: `https://www.homes.com/property/x/${id}/`,
              image: [PHOTO],
              offers: { price: 500000, availability: 'https://schema.org/InStock' },
              mainEntity: {
                address: {
                  streetAddress: `${id} Main St`,
                  addressLocality: 'Atlanta',
                  addressRegion: 'GA',
                  postalCode: '30311',
                },
                numberOfBedrooms: 3,
                numberOfBathroomsTotal: 2,
                floorSize: { value: 1500, unitCode: 'FTK' },
              },
            },
          ],
        },
      },
    ],
  };
  return `<html><script type="application/ld+json">${JSON.stringify(doc)}</script></html>`;
}

/** Every `primary_photo_url` anywhere in a payload, at any depth. */
function photoUrls(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) photoUrls(v, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'primary_photo_url') found.push(String(v));
      else photoUrls(v, found);
    }
  }
  return found;
}

describe('view wiring — homes_search_properties', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerSearchTools(server, mockClient));
  });

  // Compact-by-default at the tool boundary: no `view` argument at all. This is
  // the claim of the whole rollout, and it is the one a schema default or a
  // handler-level `?? 'full'` would silently undo.
  it('strips primary_photo_url when no view argument is passed', async () => {
    mockFetchHtml.mockResolvedValueOnce(collectionHtml());
    const r = await harness.callTool('homes_search_properties', { location: 'Atlanta, GA' });
    const parsed = parseToolResult<{ results: Array<Record<string, unknown>> }>(r);
    expect(parsed.results).toHaveLength(1);
    expect(photoUrls(parsed)).toEqual([]);
    // Subtractive: everything that is not media is still there.
    expect(parsed.results[0]).toMatchObject({ property_id: 'aaa', price: 500000 });
  });

  it('returns primary_photo_url under view: "full"', async () => {
    mockFetchHtml.mockResolvedValueOnce(collectionHtml());
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
      view: 'full',
    });
    expect(photoUrls(parseToolResult(r))).toEqual([PHOTO]);
  });

  // `view` is OURS — a response-shape knob — and must never reach homes.com.
  // This tool is the one that builds a URL out of its whole input object, so it
  // is where a leak would land: a stray `view` in the path or query string is at
  // best noise and at worst a different search than the caller asked for. The
  // handler destructures `view` off before `buildSearchPath` sees the rest.
  it('never puts view on the upstream search path', async () => {
    for (const view of ['compact', 'full']) {
      mockFetchHtml.mockClear();
      mockFetchHtml.mockResolvedValueOnce(collectionHtml());
      await harness.callTool('homes_search_properties', {
        location: 'Atlanta, GA',
        price_min: 100000,
        view,
      });
      const path = mockFetchHtml.mock.calls[0][0] as string;
      expect(path).not.toContain('view');
      expect(path).not.toContain(view);
      expect(path).toBe('/atlanta-ga/?price-min=100000');
    }
  });

  // Minification is the other half of the change; `textResult` (what these tools
  // used to return) pretty-prints, so single-line output is what distinguishes
  // the two. Asserted on the raw text because both parse identically.
  it('emits one line of JSON', async () => {
    mockFetchHtml.mockResolvedValueOnce(collectionHtml());
    const r = await harness.callTool('homes_search_properties', { location: 'Atlanta, GA' });
    expect((r.content[0] as { text: string }).text).not.toMatch(/\n/);
  });
});

describe('view wiring — homes_get_property', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerPropertyTools(server, mockClient));
  });

  it('strips primary_photo_url when no view argument is passed', async () => {
    mockFetchHtml.mockResolvedValueOnce(detailHtml());
    const r = await harness.callTool('homes_get_property', { url: '/property/x/aaa/' });
    const parsed = parseToolResult<Record<string, unknown>>(r);
    expect(photoUrls(parsed)).toEqual([]);
    expect(parsed).toMatchObject({ property_id: 'aaa', price: 500000 });
  });

  it('returns primary_photo_url under view: "full"', async () => {
    mockFetchHtml.mockResolvedValueOnce(detailHtml());
    const r = await harness.callTool('homes_get_property', {
      url: '/property/x/aaa/',
      view: 'full',
    });
    expect(photoUrls(parseToolResult(r))).toEqual([PHOTO]);
  });

  // Minifying drops FORMATTING whitespace only. A listing description is the
  // longest free text this server returns and the place where paragraph breaks
  // carry meaning, so it is compared byte-for-byte on both rungs — a minifier
  // that collapsed \s+ inside values would pass every other test in this file.
  it('leaves the blank lines inside a description byte-identical on both rungs', async () => {
    for (const extra of [{}, { view: 'full' }]) {
      mockFetchHtml.mockResolvedValueOnce(detailHtml());
      const r = await harness.callTool('homes_get_property', {
        url: '/property/x/aaa/',
        include_description: true,
        ...extra,
      });
      expect(parseToolResult<{ description: string }>(r).description).toBe(DESCRIPTION);
    }
  });

  it('never puts view on the upstream path', async () => {
    mockFetchHtml.mockResolvedValueOnce(detailHtml());
    await harness.callTool('homes_get_property', { url: '/property/x/aaa/', view: 'full' });
    expect(mockFetchHtml).toHaveBeenCalledWith('/property/x/aaa/');
  });
});

describe('view wiring — homes_compare_properties', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerCompareTools(server, mockClient));
  });

  // Compare fans out over N rows and nests each record under `results[].property`,
  // so this is where a strip that only reached the top level would show up.
  it('strips primary_photo_url from every nested row by default', async () => {
    mockFetchHtml.mockResolvedValue(detailHtml());
    const r = await harness.callTool('homes_compare_properties', {
      targets: [{ url: '/property/x/aaa/' }, { url: '/property/x/bbb/' }],
    });
    const parsed = parseToolResult<{ count: number; results: unknown[] }>(r);
    expect(parsed.count).toBe(2);
    expect(photoUrls(parsed)).toEqual([]);
  });

  it('returns every row\'s primary_photo_url under view: "full"', async () => {
    mockFetchHtml.mockResolvedValue(detailHtml());
    const r = await harness.callTool('homes_compare_properties', {
      targets: [{ url: '/property/x/aaa/' }, { url: '/property/x/bbb/' }],
      view: 'full',
    });
    expect(photoUrls(parseToolResult(r))).toEqual([PHOTO, PHOTO]);
  });
});

describe('view wiring — homes_bulk_get', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerBulkGetTools(server, mockClient));
  });

  // The tool built for "I have 53 saved homes, give me everything" — the largest
  // payload this server produces, and so the one where a per-row photo URL costs
  // the most. It was left on the old minifiedResult path in the first cut.
  it('strips primary_photo_url from every row by default', async () => {
    mockFetchHtml.mockResolvedValue(detailHtml());
    const r = await harness.callTool('homes_bulk_get', {
      urls: ['/property/x/aaa/', '/property/x/bbb/'],
    });
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(2);
    expect(photoUrls(parsed)).toEqual([]);
  });

  it('returns every row\'s primary_photo_url under view: "full"', async () => {
    mockFetchHtml.mockResolvedValue(detailHtml());
    const r = await harness.callTool('homes_bulk_get', {
      urls: ['/property/x/aaa/', '/property/x/bbb/'],
      view: 'full',
    });
    expect(photoUrls(parseToolResult(r))).toEqual([PHOTO, PHOTO]);
  });
});

describe('view wiring — homes_get_market_report', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerMarketTools(server, mockClient));
  });

  // The market report embeds its whole `sample_sold` array of formatted homes,
  // so it carries one photo URL per sampled listing while the summary a caller
  // actually reads is three numbers.
  it('strips primary_photo_url from sample_sold by default, and keeps the summary', async () => {
    mockFetchHtml.mockResolvedValueOnce(collectionHtml());
    const r = await harness.callTool('homes_get_market_report', { location: 'Atlanta, GA' });
    const parsed = parseToolResult<{
      region: string;
      sold_summary: { count: number };
      sample_sold: unknown[];
    }>(r);
    expect(photoUrls(parsed)).toEqual([]);
    expect(parsed.region).toBe('Atlanta, GA');
    expect(parsed.sold_summary.count).toBe(1);
    expect(parsed.sample_sold).toHaveLength(1);
  });

  it('returns primary_photo_url under view: "full"', async () => {
    mockFetchHtml.mockResolvedValueOnce(collectionHtml());
    const r = await harness.callTool('homes_get_market_report', {
      location: 'Atlanta, GA',
      view: 'full',
    });
    expect(photoUrls(parseToolResult(r))).toEqual([PHOTO]);
  });
});

describe('view wiring — homes_get_property_photos is deliberately NOT wired', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerPhotosTools(server, mockClient));
  });

  // The one tool whose PRODUCT is the image. Compact there would not shrink the
  // response, it would EMPTY it: `photos` is itself a media key, so the whole
  // array vanishes and the tool answers "no photos" for a listing that has
  // twelve. This asserts the negative, which no positive test can: the tool does
  // not advertise `view` at all, and its URLs survive even when a caller passes
  // one anyway (MCP tool schemas are non-strict, so an unknown key is ignored
  // rather than refused — which is exactly why "it isn't wired" has to be
  // checked on the schema and not inferred from a call succeeding).
  it('does not advertise view, and returns the photo URLs untouched if one is passed', async () => {
    const tools = await harness.client.listTools();
    const photos = tools.tools.find((t) => t.name === 'homes_get_property_photos');
    expect(photos).toBeDefined();
    expect(Object.keys(photos!.inputSchema.properties ?? {})).not.toContain('view');

    const html =
      `<html><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': ['RealEstateListing', 'Product'],
            '@id': 'https://www.homes.com/property/x/aaa/',
            url: 'https://www.homes.com/property/x/aaa/',
          },
        ],
      })}</script>` +
      `<img src="https://images.homes.com/listing/1.jpg" alt="Kitchen">` +
      `<img src="https://images.homes.com/listing/2.jpg" alt="Living"></html>`;

    mockFetchHtml.mockResolvedValueOnce(html);
    const ok = await harness.callTool('homes_get_property_photos', { url: '/property/x/aaa/' });
    const parsed = parseToolResult<{ count: number; photos: Array<{ url: string }> }>(ok);
    expect(parsed.count).toBe(2);
    expect(parsed.photos.map((p) => p.url)).toEqual([
      'https://images.homes.com/listing/1.jpg',
      'https://images.homes.com/listing/2.jpg',
    ]);

    mockFetchHtml.mockResolvedValueOnce(html);
    const withStrayView = await harness.callTool('homes_get_property_photos', {
      url: '/property/x/aaa/',
      view: 'compact',
    });
    const still = parseToolResult<{ count: number; photos: Array<{ url: string }> }>(withStrayView);
    expect(still.count).toBe(2);
    expect(still.photos.map((p) => p.url)).toEqual([
      'https://images.homes.com/listing/1.jpg',
      'https://images.homes.com/listing/2.jpg',
    ]);
  });

  // The other half of the same rule, stated on the other side: routing this
  // payload through the compact rung is what the exclusion prevents. If someone
  // "completes the rollout" by wiring `viewResponse` here, this is the shape
  // they would ship — `photos` gone entirely, `count: 2` still claiming two.
  it('would be emptied, not shrunk, if it were routed through compact', async () => {
    const { viewResponse } = await import('../../src/view.js');
    const payload = {
      property_id: 'aaa',
      count: 2,
      photos: [
        { url: 'https://images.homes.com/listing/1.jpg', position: 1 },
        { url: 'https://images.homes.com/listing/2.jpg', position: 2 },
      ],
    };
    const compacted = JSON.parse((viewResponse(undefined, payload).content[0] as { text: string }).text);
    expect(compacted).not.toHaveProperty('photos');
    expect(compacted).toMatchObject({ count: 2 });
  });
});
