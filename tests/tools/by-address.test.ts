import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import {
  buildAddressSearchPath,
  registerByAddressTools,
} from '../../src/tools/by-address.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

interface ByAddressResolved {
  url: string;
  property_hash: string;
  street_address: string;
  resolved: true;
  matched_via: 'slug' | 'search_fallback';
}

interface ByAddressUnresolved {
  resolved: false;
  error: string;
}

type ByAddressResult = ByAddressResolved | ByAddressUnresolved;

describe('buildAddressSearchPath', () => {
  it('slugifies `{ address, city, state, zip }` into a single homes.com path', () => {
    expect(
      buildAddressSearchPath({
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      })
    ).toBe('/126-sleeping-bear-ln-lake-lure-nc-28746/');
  });

  it('handles missing zip', () => {
    expect(
      buildAddressSearchPath({
        address: '3199 Delmar Ln NW',
        city: 'Atlanta',
        state: 'GA',
      })
    ).toBe('/3199-delmar-ln-nw-atlanta-ga/');
  });

  it('lowercases and trims punctuation', () => {
    expect(
      buildAddressSearchPath({
        address: '1, Main St.',
        city: 'New York',
        state: 'NY',
        zip: '10001',
      })
    ).toBe('/1-main-st-new-york-ny-10001/');
  });
});

describe('homes_get_by_address tool', () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  const mockFetchHtml = vi.fn();
  const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

  beforeAll(async () => {
    harness = await createTestHarness((server) =>
      registerByAddressTools(server, mockClient)
    );
  });
  afterAll(async () => harness?.close());

  // homes.com's address-search page (e.g. `/<addr-slug>-<city>-<state>-<zip>/`)
  // typically server-renders a CollectionPage whose mainEntity.itemListElement
  // holds the matching listings. We take the first.
  const collectionHtml = (items: unknown[], totalItems = items.length) => {
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

  // A redirect to the property detail page yields a single RealEstateListing
  // graph node — same shape as `homes_get_property`.
  const detailHtml = (url: string, streetAddress: string) => {
    const doc = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'BreadcrumbList' },
        {
          '@type': ['RealEstateListing', 'Product'],
          '@id': `${url}#realestatelisting`,
          url,
          mainEntity: {
            '@type': 'SingleFamilyResidence',
            address: { streetAddress },
          },
        },
      ],
    };
    return `<html><script type="application/ld+json">${JSON.stringify(doc)}</script></html>`;
  };

  const itemFor = (id: string, street: string) => ({
    '@type': ['RealEstateListing', 'Product'],
    '@id': `https://www.homes.com/property/x/${id}/#realestatelisting`,
    url: `https://www.homes.com/property/x/${id}/`,
    mainEntity: {
      address: {
        streetAddress: street,
        addressLocality: 'Lake Lure',
        addressRegion: 'NC',
        postalCode: '28746',
      },
    },
  });

  // Reset between tests — the fallback rung makes a 2nd fetchHtml call
  // when the slug rung returns UNRESOLVED, so single-`mockResolvedValueOnce`
  // tests need a clean queue to avoid leaking prior responses.
  beforeEach(() => mockFetchHtml.mockReset());

  it('hits the address-slug path and resolves to the first listing', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      collectionHtml([itemFor('abc123hash', '126 Sleeping Bear Ln')])
    );
    const r = await harness.callTool('homes_get_by_address', {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe(
      '/126-sleeping-bear-ln-lake-lure-nc-28746/'
    );
    const parsed = parseToolResult<ByAddressResult>(r);
    expect(parsed).toEqual({
      url: 'https://www.homes.com/property/x/abc123hash/',
      property_hash: 'abc123hash',
      street_address: '126 Sleeping Bear Ln',
      resolved: true,
      matched_via: 'slug',
    });
  });

  it('resolves when the address-slug page redirects to the detail page (single RealEstateListing in JSON-LD)', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      detailHtml(
        'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
        '3199 Delmar Ln NW'
      )
    );
    const r = await harness.callTool('homes_get_by_address', {
      address: '3199 Delmar Ln NW',
      city: 'Atlanta',
      state: 'GA',
      zip: '30311',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<ByAddressResult>(r);
    expect(parsed).toEqual({
      url: 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
      property_hash: 'rxrzwg0kjnr32',
      street_address: '3199 Delmar Ln NW',
      resolved: true,
      matched_via: 'slug',
    });
  });

  it('takes the first listing when the page returns multiple results', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      collectionHtml([
        itemFor('firstmatch', '126 Sleeping Bear Ln'),
        itemFor('secondmatch', '127 Sleeping Bear Ln'),
      ])
    );
    const r = await harness.callTool('homes_get_by_address', {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<ByAddressResult>(r);
    expect(parsed.resolved).toBe(true);
    if (parsed.resolved) {
      expect(parsed.property_hash).toBe('firstmatch');
    }
  });

  it('returns { resolved: false } instead of throwing when no listings are present', async () => {
    mockFetchHtml.mockResolvedValueOnce(collectionHtml([], 0));
    const r = await harness.callTool('homes_get_by_address', {
      address: '999 Nowhere St',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<ByAddressResult>(r);
    expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
  });

  it('returns { resolved: false } when JSON-LD is absent (homes.com 404-style page)', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no ld json here</html>');
    const r = await harness.callTool('homes_get_by_address', {
      address: '999 Nowhere St',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<ByAddressResult>(r);
    expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
  });

  it('returns { resolved: false } when fetchHtml throws (non-2xx response from homes.com)', async () => {
    mockFetchHtml.mockRejectedValueOnce(new Error('homes.com error: 404 for GET /…'));
    const r = await harness.callTool('homes_get_by_address', {
      address: '999 Nowhere St',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<ByAddressResult>(r);
    expect(parsed.resolved).toBe(false);
    if (!parsed.resolved) {
      expect(parsed.error).toBe('no listing found');
    }
  });

  it('returns { resolved: false } when the first item has no usable property hash', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      collectionHtml([{ '@type': 'RealEstateListing' /* no url, no @id */ }])
    );
    const r = await harness.callTool('homes_get_by_address', {
      address: '999 Nowhere St',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<ByAddressResult>(r);
    expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
  });

  // ── Search-fallback rung (#47) ──────────────────────────────────────
  //
  // When the slug rung misses (404, empty collection, no JSON-LD), we
  // fall through to a city-level search page and address-fuzzy-match.
  // The path shape reuses `buildSearchPath({ location: "<city>, <state>" })`
  // so we go through the same URL routing search.ts already uses
  // (verified-live; querystring filters are stripped at the edge — path
  // only).
  describe('search-fallback rung', () => {
    it('falls back to the city search page when the slug rung returns no JSON-LD, picks the fuzzy-matching listing', async () => {
      mockFetchHtml.mockClear();
      // Slug rung — empty / no JSON-LD.
      mockFetchHtml.mockResolvedValueOnce('<html>nothing here</html>');
      // Search fallback returns one matching listing.
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('fallbackhash', '126 Sleeping Bear Ln')])
      );

      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      expect(r.isError).toBeFalsy();
      // First call: slug rung.
      expect(mockFetchHtml.mock.calls[0][0]).toBe(
        '/126-sleeping-bear-ln-lake-lure-nc-28746/'
      );
      // Second call: city-level search fallback (reuses buildSearchPath).
      expect(mockFetchHtml.mock.calls[1][0]).toBe('/lake-lure-nc/');
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({
        url: 'https://www.homes.com/property/x/fallbackhash/',
        property_hash: 'fallbackhash',
        street_address: '126 Sleeping Bear Ln',
        resolved: true,
        matched_via: 'search_fallback',
      });
    });

    it('falls back when the slug rung returns an empty CollectionPage', async () => {
      mockFetchHtml.mockResolvedValueOnce(collectionHtml([], 0));
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('falla', '99 Elm St')])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '99 Elm St',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) {
        expect(parsed.matched_via).toBe('search_fallback');
        expect(parsed.property_hash).toBe('falla');
      }
    });

    it('fuzzy-picks the matching street from multiple search-fallback hits', async () => {
      mockFetchHtml.mockResolvedValueOnce('<html>nothing here</html>');
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([
          itemFor('aaa', '999 Other Rd'),
          itemFor('bbb', '127 Sleeping Bear Ln'),
          itemFor('ccc', '126 Sleeping Bear Ln'),
        ])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) {
        // Must pick the exact-street-number match, not the first row.
        expect(parsed.property_hash).toBe('ccc');
        expect(parsed.matched_via).toBe('search_fallback');
      }
    });

    it('falls back to the zip-only search when neither city nor state is given', async () => {
      mockFetchHtml.mockClear();
      mockFetchHtml.mockResolvedValueOnce('<html>nothing</html>');
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('ziphash', '100 Main St')])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '100 Main St',
        city: '',
        state: '',
        zip: '28746',
      });
      // Fallback hits the zip slug — that's what search.ts builds for a
      // bare ZIP location.
      expect(mockFetchHtml.mock.calls[1][0]).toBe('/28746/');
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) expect(parsed.matched_via).toBe('search_fallback');
    });

    it('degrades to "no listing found" when the search fallback throws (preserves #45 contract)', async () => {
      mockFetchHtml.mockResolvedValueOnce('<html>nothing here</html>');
      mockFetchHtml.mockRejectedValueOnce(new Error('homes.com error: 503'));
      const r = await harness.callTool('homes_get_by_address', {
        address: '999 Nowhere St',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      expect(r.isError).toBeFalsy();
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
    });

    it('returns "no listing found" when the fallback page has no fuzzy-matching listing', async () => {
      mockFetchHtml.mockResolvedValueOnce('<html>nothing</html>');
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('zz', '999 Other Rd')])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
    });

    it('does not call the search fallback when the slug rung resolves', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('slughash', '126 Sleeping Bear Ln')])
      );
      await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      // Only the slug rung was called — no fallback request issued.
      expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    });

    it('skips the fallback fetch when only city is given (no state, no zip) — locality too broad', async () => {
      // Slug rung — empty / no JSON-LD.
      mockFetchHtml.mockResolvedValueOnce('<html>nothing here</html>');
      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: '',
      });
      expect(r.isError).toBeFalsy();
      // Only the slug rung fired — a bare "Lake Lure" location would
      // search nationwide for the city name, too noisy to fuzzy-match.
      expect(mockFetchHtml).toHaveBeenCalledTimes(1);
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
    });

    it('skips the fallback fetch when only state is given (no city, no zip)', async () => {
      mockFetchHtml.mockResolvedValueOnce('<html>nothing here</html>');
      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: '',
        state: 'NC',
      });
      expect(r.isError).toBeFalsy();
      // State-only would yield a state-wide `/nc/` search — too broad.
      expect(mockFetchHtml).toHaveBeenCalledTimes(1);
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
    });
  });
});
