import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import {
  buildSearchPath,
  extractPropertyId,
  findListings,
  formatHome,
  registerSearchTools,
  validatePriceBand,
} from '../../src/tools/search.js';
import { extractJsonLd } from '../../src/page-state.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('buildSearchPath', () => {
  it('slugifies a city + state to "/<city>-<state>/"', () => {
    expect(buildSearchPath({ location: 'Atlanta, GA' })).toBe('/atlanta-ga/');
  });

  it('handles multi-word cities', () => {
    expect(buildSearchPath({ location: 'New York, NY' })).toBe('/new-york-ny/');
  });

  it('passes ZIP codes through as-is', () => {
    expect(buildSearchPath({ location: '30311' })).toBe('/30311/');
  });

  it('trims punctuation noise', () => {
    expect(buildSearchPath({ location: 'Brooklyn, NY' })).toBe('/brooklyn-ny/');
  });
});

describe('buildSearchPath — extended filters', () => {
  it('property_type=single_family → /houses-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'single_family' })
    ).toBe('/atlanta-ga/houses-for-sale/');
  });

  it('property_type=condo → /condos-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', property_type: 'condo' })
    ).toBe('/brooklyn-ny/condos-for-sale/');
  });

  it('property_type=townhouse → /townhouses-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'townhouse' })
    ).toBe('/atlanta-ga/townhouses-for-sale/');
  });

  it('property_type=land → /land-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'land' })
    ).toBe('/atlanta-ga/land-for-sale/');
  });

  it('property_type=mobile → /mobile-homes-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'mobile' })
    ).toBe('/atlanta-ga/mobile-homes-for-sale/');
  });

  it('property_type=multi_family → /multi-family-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'multi_family' })
    ).toBe('/atlanta-ga/multi-family-for-sale/');
  });

  it('listing_type=sold → /<city>/sold/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', listing_type: 'sold' })
    ).toBe('/brooklyn-ny/sold/');
  });

  it('listing_type=for_rent → /<city>/homes-for-rent/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', listing_type: 'for_rent' })
    ).toBe('/brooklyn-ny/homes-for-rent/');
  });

  it('listing_type=open_houses → /<city>/open-houses/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', listing_type: 'open_houses' })
    ).toBe('/brooklyn-ny/open-houses/');
  });

  it('listing_type=new_construction → /new-homes/for-sale/<city>/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', listing_type: 'new_construction' })
    ).toBe('/new-homes/for-sale/brooklyn-ny/');
  });

  it('property_type + listing_type=for_rent composes (condo → /condos-for-rent/)', () => {
    expect(
      buildSearchPath({
        location: 'Brooklyn, NY',
        property_type: 'condo',
        listing_type: 'for_rent',
      })
    ).toBe('/brooklyn-ny/condos-for-rent/');
  });

  it('single_family + for_rent → /<city>/houses-for-rent/', () => {
    expect(
      buildSearchPath({
        location: 'Brooklyn, NY',
        property_type: 'single_family',
        listing_type: 'for_rent',
      })
    ).toBe('/brooklyn-ny/houses-for-rent/');
  });

  it('sort=newest appends /newest/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', sort: 'newest' })
    ).toBe('/atlanta-ga/newest/');
  });

  it('sort=newest with property_type composes', () => {
    expect(
      buildSearchPath({
        location: 'Atlanta, GA',
        property_type: 'condo',
        sort: 'newest',
      })
    ).toBe('/atlanta-ga/condos-for-sale/newest/');
  });

  it('listing_type=new_construction ignores sort + property_type (different URL space)', () => {
    expect(
      buildSearchPath({
        location: 'Brooklyn, NY',
        listing_type: 'new_construction',
        property_type: 'condo',
        sort: 'newest',
      })
    ).toBe('/new-homes/for-sale/brooklyn-ny/');
  });
});

// ── Price band (#46) ───────────────────────────────────────────────────
//
// homes.com honours the price filter as a QUERY STRING (`?price-min=` /
// `?price-max=`), unlike every other (path-based) facet. Verified live
// 2026-05-29: `/atlanta-ga/houses-for-sale/?price-min=300000&price-max=
// 500000` bounded the rendered CollectionPage to [309000, 499000]; the
// bare `/lake-lure-nc/?price-min=…&price-max=…` slug bounded identically.
// (homes.com's own `under-<max>` path facet 302-redirects to exactly the
// `?price-max=` query string.)
describe('buildSearchPath — price band (#46)', () => {
  it('appends ?price-min= for a lower bound on a bare location', () => {
    expect(
      buildSearchPath({ location: 'Lake Lure, NC', price_min: 300000 })
    ).toBe('/lake-lure-nc/?price-min=300000');
  });

  it('appends ?price-max= for an upper bound', () => {
    expect(
      buildSearchPath({ location: 'Lake Lure, NC', price_max: 600000 })
    ).toBe('/lake-lure-nc/?price-max=600000');
  });

  it('appends both bounds as &-joined query params', () => {
    expect(
      buildSearchPath({
        location: 'Atlanta, GA',
        price_min: 300000,
        price_max: 500000,
      })
    ).toBe('/atlanta-ga/?price-min=300000&price-max=500000');
  });

  it('composes the band with a path facet (query string trails the path)', () => {
    expect(
      buildSearchPath({
        location: 'Atlanta, GA',
        property_type: 'single_family',
        price_min: 300000,
        price_max: 500000,
      })
    ).toBe('/atlanta-ga/houses-for-sale/?price-min=300000&price-max=500000');
  });

  it('composes the band with a ZIP location', () => {
    expect(
      buildSearchPath({ location: '28746', price_min: 250000 })
    ).toBe('/28746/?price-min=250000');
  });

  it('floors a fractional bound to an integer dollar amount', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', price_max: 499999.99 })
    ).toBe('/atlanta-ga/?price-max=499999');
  });

  it('omits the query string entirely when no band is given (unchanged)', () => {
    expect(buildSearchPath({ location: 'Atlanta, GA' })).toBe('/atlanta-ga/');
  });

  it('also bounds the new-construction URL space', () => {
    expect(
      buildSearchPath({
        location: 'Atlanta, GA',
        listing_type: 'new_construction',
        price_max: 400000,
      })
    ).toBe('/new-homes/for-sale/atlanta-ga/?price-max=400000');
  });
});

describe('validatePriceBand (#46)', () => {
  it('accepts an empty band (no-op)', () => {
    expect(() => validatePriceBand({})).not.toThrow();
  });

  it('accepts a lower-only, upper-only, and full band', () => {
    expect(() => validatePriceBand({ price_min: 0 })).not.toThrow();
    expect(() => validatePriceBand({ price_max: 100 })).not.toThrow();
    expect(() =>
      validatePriceBand({ price_min: 100, price_max: 200 })
    ).not.toThrow();
  });

  it('accepts an equal band (min === max)', () => {
    expect(() =>
      validatePriceBand({ price_min: 500000, price_max: 500000 })
    ).not.toThrow();
  });

  it('rejects a negative bound with a clear message', () => {
    expect(() => validatePriceBand({ price_min: -1 })).toThrow(/non-negative/);
    expect(() => validatePriceBand({ price_max: -5 })).toThrow(/non-negative/);
  });

  it('rejects a non-finite bound', () => {
    expect(() => validatePriceBand({ price_max: Infinity })).toThrow(
      /finite/
    );
    expect(() => validatePriceBand({ price_min: NaN })).toThrow(/finite/);
  });

  it('rejects an inverted band (min > max) with a clear message', () => {
    expect(() =>
      validatePriceBand({ price_min: 500000, price_max: 300000 })
    ).toThrow(/price_min .* <= price_max/);
  });
});

describe('extractPropertyId', () => {
  it('extracts the last path segment from a homes.com property URL', () => {
    expect(
      extractPropertyId({
        url: 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
      })
    ).toBe('rxrzwg0kjnr32');
  });

  it('falls back to @id when url is missing', () => {
    expect(
      extractPropertyId({
        '@id': 'https://www.homes.com/property/x/abc123/',
      })
    ).toBe('abc123');
  });

  it('strips query strings before pulling the last segment', () => {
    expect(
      extractPropertyId({
        url: 'https://www.homes.com/property/foo/abc123/?ref=search',
      })
    ).toBe('abc123');
  });

  it('strips #realestatelisting fragments (homes.com SSR includes them in @id)', () => {
    // Verified live 2026-05-26: homes.com JSON-LD now emits
    //   "@id": "https://www.homes.com/property/x/abc123/#realestatelisting"
    // Without stripping #fragment we'd return "#realestatelisting".
    expect(
      extractPropertyId({
        '@id': 'https://www.homes.com/property/x/abc123/#realestatelisting',
      })
    ).toBe('abc123');
  });

  it('prefers url over @id when both are present (url is fragment-free)', () => {
    expect(
      extractPropertyId({
        '@id': 'https://www.homes.com/property/x/abc123/#realestatelisting',
        url: 'https://www.homes.com/property/x/abc123/',
      })
    ).toBe('abc123');
  });

  it('returns "" when neither url nor @id is present', () => {
    expect(extractPropertyId({})).toBe('');
  });
});

describe('formatHome', () => {
  it('flattens a search-page listing item into the canonical shape', () => {
    const out = formatHome({
      '@type': ['RealEstateListing', 'Product'],
      '@id': 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
      name: '3199 Delmar Ln NW',
      url: 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
      image: 'https://images.homes.com/listing/photo1.jpg',
      position: 1,
      offers: {
        price: 525000,
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        seller: { name: 'Coldwell Banker' },
        offeredBy: [
          {
            name: 'Jane Smith',
            telephone: '+1-404-555-0100',
            jobTitle: 'Real Estate Agent',
            memberOf: { name: 'Coldwell Banker' },
          },
        ],
      },
      mainEntity: {
        '@type': 'SingleFamilyResidence',
        numberOfBedrooms: 4,
        numberOfBathroomsTotal: 3,
        floorSize: { value: 2400, unitCode: 'FTK' },
        address: {
          streetAddress: '3199 Delmar Ln NW',
          addressLocality: 'Atlanta',
          addressRegion: 'GA',
          postalCode: '30311',
          addressCountry: 'US',
        },
      },
    });
    expect(out).toEqual({
      property_id: 'rxrzwg0kjnr32',
      url: 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
      address: '3199 Delmar Ln NW',
      city: 'Atlanta',
      state: 'GA',
      zip: '30311',
      price: 525000,
      beds: 4,
      baths: 3,
      sqft: 2400,
      primary_photo_url: 'https://images.homes.com/listing/photo1.jpg',
      listing_agent: 'Jane Smith',
      brokerage: 'Coldwell Banker',
      status: 'https://schema.org/InStock',
    });
  });

  it('returns null when the listing has no @id and no url', () => {
    expect(formatHome({ name: 'orphan' })).toBeNull();
  });

  it('falls back to seller.name when offeredBy is missing', () => {
    const out = formatHome({
      url: 'https://www.homes.com/property/foo/abc123/',
      offers: { price: 100000, seller: { name: 'Solo Realty' } },
      mainEntity: { address: { streetAddress: '1 Main' } },
    });
    expect(out?.brokerage).toBe('Solo Realty');
    expect(out?.listing_agent).toBeUndefined();
  });

  it('coerces string prices into numbers', () => {
    const out = formatHome({
      url: 'https://www.homes.com/property/foo/abc123/',
      offers: { price: '525,000' as unknown as number },
      mainEntity: {},
    });
    expect(out?.price).toBe(525000);
  });
});

describe('findListings', () => {
  it('reaches CollectionPage.mainEntity.itemListElement', () => {
    const doc = extractJsonLd(
      `<script type="application/ld+json">${JSON.stringify({
        '@graph': [
          { '@type': 'BreadcrumbList' },
          {
            '@type': 'CollectionPage',
            mainEntity: {
              numberOfItems: 42,
              itemListElement: [
                { '@type': 'RealEstateListing', url: 'https://www.homes.com/property/x/a1/' },
                { '@type': 'RealEstateListing', url: 'https://www.homes.com/property/x/a2/' },
              ],
            },
          },
        ],
      })}</script>`
    );
    const r = findListings(doc);
    expect(r.total).toBe(42);
    expect(r.items).toHaveLength(2);
  });

  it('returns empty items when CollectionPage is missing', () => {
    const doc = extractJsonLd(
      `<script type="application/ld+json">${JSON.stringify({
        '@graph': [{ '@type': 'BreadcrumbList' }],
      })}</script>`
    );
    expect(findListings(doc).items).toEqual([]);
  });
});

describe('homes_search_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSearchTools(server, mockClient)
    );
  });

  const htmlWith = (items: unknown[], totalItems = items.length) => {
    const doc = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'BreadcrumbList' },
        {
          '@type': 'CollectionPage',
          mainEntity: {
            numberOfItems: totalItems,
            itemListElement: items,
          },
        },
      ],
    };
    return `<html><script type="application/ld+json">${JSON.stringify(doc)}</script></html>`;
  };

  const itemFor = (id: string, price: number) => ({
    '@type': ['RealEstateListing', 'Product'],
    '@id': `https://www.homes.com/property/x/${id}/`,
    url: `https://www.homes.com/property/x/${id}/`,
    offers: { price, availability: 'https://schema.org/InStock' },
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
  });

  it('fetches the SSR search page and returns formatted listings', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith([itemFor('aaa', 500000), itemFor('bbb', 750000)])
    );
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/atlanta-ga/');
    const parsed = parseToolResult<{
      total_items: number;
      count: number;
      results: Array<{ property_id: string; price: number }>;
    }>(r);
    expect(parsed.total_items).toBe(2);
    expect(parsed.count).toBe(2);
    expect(parsed.results.map((x) => x.property_id)).toEqual(['aaa', 'bbb']);
    expect(parsed.results[0].price).toBe(500000);
  });

  it('respects limit', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith(
        Array.from({ length: 10 }, (_, i) => itemFor(`p${i}`, 100000 + i * 1000))
      )
    );
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
      limit: 3,
    });
    const parsed = parseToolResult<{ results: unknown[] }>(r);
    expect(parsed.results).toHaveLength(3);
  });

  it('does NOT mark truncated when a small `limit` slices a fully-rendered page', async () => {
    // The page SSR'd 10 listings and numberOfItems reports 10 — all
    // results are present. A small user `limit` slicing the response down
    // to 3 must NOT flip truncated:true: the cap signals "homes.com has
    // more than it rendered", not "you asked for fewer than were
    // rendered". Compare total against the pre-slice page size, not the
    // limit-sliced length.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith(
        Array.from({ length: 10 }, (_, i) => itemFor(`p${i}`, 100000 + i * 1000)),
        10
      )
    );
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
      limit: 3,
    });
    const parsed = parseToolResult<{
      count: number;
      truncated: boolean;
      total_estimated?: number;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.truncated).toBe(false);
    expect(parsed.total_estimated).toBeUndefined();
  });

  it('marks truncated: true when numberOfItems exceeds returned items (#25)', async () => {
    // homes.com pages SSR ~40 listings even when numberOfItems reports
    // more. The tool must signal that the caller is looking at a slice.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith(
        Array.from({ length: 40 }, (_, i) => itemFor(`p${i}`, 100000 + i * 1000)),
        200 // numberOfItems claims 200 listings
      )
    );
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
      limit: 100,
    });
    const parsed = parseToolResult<{
      count: number;
      total_items: number;
      truncated: boolean;
      total_estimated?: number;
    }>(r);
    expect(parsed.count).toBe(40);
    expect(parsed.total_items).toBe(200);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total_estimated).toBe(200);
  });

  it('marks truncated: false when all items fit in one page (#25)', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith(
        Array.from({ length: 5 }, (_, i) => itemFor(`p${i}`, 100000 + i * 1000)),
        5
      )
    );
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
    });
    const parsed = parseToolResult<{ truncated: boolean }>(r);
    expect(parsed.truncated).toBe(false);
  });

  it('throws when JSON-LD cannot be located in the HTML', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no ld json here</html>');
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/could not locate JSON-LD/);
  });

  it('threads price_min/price_max into the fetched search path (#46)', async () => {
    mockFetchHtml.mockResolvedValueOnce(htmlWith([itemFor('aaa', 400000)]));
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
      price_min: 300000,
      price_max: 500000,
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe(
      '/atlanta-ga/?price-min=300000&price-max=500000'
    );
  });

  it('returns a clear error (no fetch) on an inverted price band (#46)', async () => {
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
      price_min: 500000,
      price_max: 300000,
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/price_min .* <= price_max/);
    // The band was rejected before any network call.
    expect(mockFetchHtml).not.toHaveBeenCalled();
  });
});
