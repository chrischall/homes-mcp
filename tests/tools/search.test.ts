import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import {
  buildSearchPath,
  extractPropertyId,
  findListings,
  formatHome,
  registerSearchTools,
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

  it('throws when JSON-LD cannot be located in the HTML', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no ld json here</html>');
    const r = await harness.callTool('homes_search_properties', {
      location: 'Atlanta, GA',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/could not locate JSON-LD/);
  });
});
