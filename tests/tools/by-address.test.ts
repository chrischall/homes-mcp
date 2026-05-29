import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@fetchproxy/server';
import type { HomesClient } from '../../src/client.js';
import {
  buildAddressSearchPath,
  registerByAddressTools,
  resolveOneAddressDeadlined,
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
  status?: 'timeout';
  retryable?: boolean;
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
  const mockFetchJson = vi.fn();
  const mockClient = {
    fetchHtml: mockFetchHtml,
    fetchJson: mockFetchJson,
  } as unknown as HomesClient;

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

  // Build a smartsearch autocomplete response (the structured typeahead
  // rung). Shape mirrors the real captured response (see typeahead.ts).
  const smartsearch = (
    places: Array<{ n: string; u: string; key: string; unit?: string }>
  ) => ({
    suggestions: {
      places: places.map((p) => ({
        n: p.n,
        u: p.u,
        g: {
          k: { key: p.key },
          d: p.n,
          t: 8,
          a: { street: p.n.split(',')[0], unit: p.unit },
        },
        s: 'Address',
        sts: 0,
      })),
      neighborhoods: [],
      schools: [],
      buildings: [],
      agents: [],
      newhomes: [],
    },
  });

  // Reset between tests — the fallback rung makes a 2nd fetchHtml call
  // when the slug rung returns UNRESOLVED, so single-`mockResolvedValueOnce`
  // tests need a clean queue to avoid leaking prior responses.
  //
  // Default the structured typeahead rung (rung 0) to "no candidates" so
  // every existing slug / search-fallback test exercises the SSR rungs
  // exactly as before; per-test overrides drive the typeahead rung.
  beforeEach(() => {
    mockFetchHtml.mockReset();
    mockFetchJson.mockReset();
    mockFetchJson.mockResolvedValue({ suggestions: { places: [] } });
  });

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

    it('#65: falls through to the verified search-fallback when the slug rung lands on a WRONG-street listing', async () => {
      // Cold-bridge reality: homes.com routes the guessed slug to a city
      // collection page whose FIRST listing is a different street. The slug
      // rung takes the first item unverified, which would mask the right
      // match. The search-fallback rung does whole-token verification, so a
      // slug result that doesn't match the input street must NOT short-
      // circuit it — search-fallback is a first-class verified rung.
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('wrongstreet', '999 Other Rd')])
      );
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('rightstreet', '158 Raven Blvd')])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '158 Raven Blvd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) {
        expect(parsed.matched_via).toBe('search_fallback');
        expect(parsed.property_hash).toBe('rightstreet');
      }
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

  // ── Structured smartsearch typeahead rung (#55) ─────────────────────
  //
  // The PRIMARY rung. The legacy slug rung guessed
  // `/<addr-slug>-<city>-<state>-<zip>/` URLs that 404 for many real,
  // indexed listings → a false "no listing found". The live search box
  // resolves through `POST /routes/res/consumer/smartsearch/autocomplete/`
  // (term-keyed JSON), whose candidates carry the REAL detail URL
  // `/property/<slug>/<hash>/` + the opaque hash. Fixtures below are the
  // real captured shapes (see typeahead.test.ts / typeahead.ts header).
  describe('structured smartsearch typeahead rung', () => {
    it('resolves via the autocomplete endpoint before any slug/search fetch', async () => {
      mockFetchJson.mockResolvedValueOnce(
        smartsearch([
          {
            n: '126 Sleeping Bear Ln, Lake Lure, NC',
            u: '/property/126-sleeping-bear-ln-lake-lure-nc/typehash1/',
            key: 'typehash1',
          },
        ])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      expect(r.isError).toBeFalsy();
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({
        url: 'https://www.homes.com/property/126-sleeping-bear-ln-lake-lure-nc/typehash1/',
        property_hash: 'typehash1',
        street_address: '126 Sleeping Bear Ln',
        resolved: true,
        matched_via: 'typeahead',
      });
      // The structured rung short-circuits the SSR rungs entirely.
      expect(mockFetchHtml).not.toHaveBeenCalled();
      // It POSTed to the smartsearch endpoint with the term body.
      const [calledPath, init] = mockFetchJson.mock.calls[0];
      expect(calledPath).toBe(
        '/routes/res/consumer/smartsearch/autocomplete/'
      );
      expect(init.method).toBe('POST');
      expect(init.body.term).toBe('126 sleeping bear ln lake lure nc 28746');
    });

    it('CRITICAL #55: resolves 158 Raven Blvd to its real /property/<slug>/<hash>/ URL', async () => {
      // Real false-negative from the field report — the slug rung 404s,
      // so this MUST resolve through the structured rung. Captured live.
      mockFetchJson.mockResolvedValueOnce(
        smartsearch([
          {
            n: '158 Raven Blvd, Lake Lure, NC',
            u: '/property/158-raven-blvd-lake-lure-nc/yhepckbpqstf1/',
            key: 'yhepckbpqstf1',
          },
        ])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '158 Raven Blvd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) {
        expect(parsed.matched_via).toBe('typeahead');
        expect(parsed.property_hash).toBe('yhepckbpqstf1');
        expect(parsed.url).toBe(
          'https://www.homes.com/property/158-raven-blvd-lake-lure-nc/yhepckbpqstf1/'
        );
      }
    });

    it('CRITICAL #55: resolves 155 Quail Cove Blvd Unit 1601 to the matching unit, not a neighbour unit', async () => {
      // Multi-unit building — the live autocomplete returns several units
      // for "155 Quail Cove Blvd". The whole-token verifier must pick the
      // one carrying the "1601" unit token, not the first candidate.
      mockFetchJson.mockResolvedValueOnce(
        smartsearch([
          {
            n: '155 Quail Cove Blvd Unit 1603, Lake Lure, NC',
            u: '/property/155-quail-cove-blvd-lake-lure-nc-unit-1603/0p8h9n2dr1vv0/',
            key: '0p8h9n2dr1vv0',
            unit: '1603',
          },
          {
            n: '155 Quail Cove Blvd Unit 1601, Lake Lure, NC',
            u: '/property/155-quail-cove-blvd-lake-lure-nc-unit-1601/lgt0s6vpv9cln/',
            key: 'lgt0s6vpv9cln',
            unit: '1601',
          },
        ])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '155 Quail Cove Blvd Unit 1601',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) {
        expect(parsed.matched_via).toBe('typeahead');
        expect(parsed.property_hash).toBe('lgt0s6vpv9cln');
        expect(parsed.url).toBe(
          'https://www.homes.com/property/155-quail-cove-blvd-lake-lure-nc-unit-1601/lgt0s6vpv9cln/'
        );
      }
    });

    it('NEGATIVE: rejects a wrong-street typeahead candidate (no token overlap) → falls through to slug, then unresolved', async () => {
      // The endpoint sometimes returns a loose / far candidate. The
      // whole-token verifier must reject it (no URL leak) rather than
      // accept a wrong-but-plausible neighbour. With the slug + fallback
      // rungs also empty, the call returns "no listing found".
      mockFetchJson.mockResolvedValueOnce(
        smartsearch([
          {
            n: '999 Completely Different Rd, Charlotte, NC',
            u: '/property/999-completely-different-rd-charlotte-nc/wrongwrong1/',
            key: 'wrongwrong1',
          },
        ])
      );
      mockFetchHtml.mockResolvedValue('<html>nothing here</html>');
      const r = await harness.callTool('homes_get_by_address', {
        address: '158 Raven Blvd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      expect(r.isError).toBeFalsy();
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
    });

    it('NEGATIVE: rejects a wrong-unit-only typeahead candidate (street matches but unit differs)', async () => {
      // Only the 1603 unit comes back; the input wants 1601. The unit
      // mismatch must reject it — accepting it would point a tracker at
      // the wrong condo. Falls through to the SSR rungs (also empty).
      mockFetchJson.mockResolvedValueOnce(
        smartsearch([
          {
            n: '155 Quail Cove Blvd Unit 1603, Lake Lure, NC',
            u: '/property/155-quail-cove-blvd-lake-lure-nc-unit-1603/0p8h9n2dr1vv0/',
            key: '0p8h9n2dr1vv0',
            unit: '1603',
          },
        ])
      );
      mockFetchHtml.mockResolvedValue('<html>nothing here</html>');
      const r = await harness.callTool('homes_get_by_address', {
        address: '155 Quail Cove Blvd Unit 1601',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
    });

    it('falls through to the slug rung when the typeahead endpoint returns no places', async () => {
      // Default mock already returns empty places; slug rung resolves.
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('slughash', '126 Sleeping Bear Ln')])
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
        expect(parsed.matched_via).toBe('slug');
        expect(parsed.property_hash).toBe('slughash');
      }
    });

    it('falls through to the slug rung when the typeahead endpoint throws (WAF/transport)', async () => {
      mockFetchJson.mockReset();
      mockFetchJson.mockRejectedValue(new Error('homes.com error: 403'));
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('slughash2', '126 Sleeping Bear Ln')])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) expect(parsed.matched_via).toBe('slug');
    });
  });

  // ── Transport-timeout taxonomy on the single path (#64) ─────────────
  //
  // A cold-bridge fetchproxy timeout (FetchproxyTimeoutError) or a
  // service-worker eviction (FetchproxyBridgeDownError) in ANY rung means
  // we genuinely don't know whether homes.com has the listing — it is NOT
  // a confirmed miss. Surfacing `'no listing found'` here is what produced
  // the false "homes.com zero coverage" conclusion: identical input warm
  // resolves true, but cold reported a hard miss. The single path must
  // surface a distinct, retryable `status: 'timeout'` instead — never
  // collapse a transport timeout onto the genuine-miss sentinel.
  describe('transport-timeout taxonomy (#64)', () => {
    it('surfaces status: timeout (retryable) when the typeahead rung hits a fetchproxy timeout and the SSR rungs also time out — NOT "no listing found"', async () => {
      mockFetchJson.mockReset();
      mockFetchJson.mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/',
          timeoutMs: 30000,
        })
      );
      // Slug + search-fallback rungs also time out on the cold bridge.
      mockFetchHtml.mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/',
          timeoutMs: 30000,
        })
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '219 Picnic Point',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      expect(r.isError).toBeFalsy();
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(false);
      if (!parsed.resolved) {
        expect(parsed.status).toBe('timeout');
        expect(parsed.retryable).toBe(true);
        expect(parsed.error).not.toBe('no listing found');
      }
    });

    it('surfaces status: timeout when the slug rung hits a fetchproxy timeout (typeahead empty, search-fallback also times out)', async () => {
      // Typeahead empty (default mock). Slug + search-fallback both throw
      // a bridge timeout — a cold-bridge failure mid-fallthrough.
      mockFetchHtml.mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/',
          timeoutMs: 30000,
        })
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(false);
      if (!parsed.resolved) {
        expect(parsed.status).toBe('timeout');
        expect(parsed.retryable).toBe(true);
      }
    });

    it('surfaces status: timeout on a FetchproxyBridgeDownError (service-worker eviction)', async () => {
      mockFetchJson.mockReset();
      mockFetchJson.mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'service worker evicted',
          retryAttempted: true,
        })
      );
      mockFetchHtml.mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'service worker evicted',
          retryAttempted: true,
        })
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '219 Picnic Point',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(false);
      if (!parsed.resolved) {
        expect(parsed.status).toBe('timeout');
        expect(parsed.retryable).toBe(true);
      }
    });

    it('still reports a GENUINE miss as "no listing found" (no status) when every rung returns empty', async () => {
      // Typeahead empty (default), slug empty, search-fallback empty —
      // homes.com genuinely has no match. This must stay distinguishable
      // from a transport timeout.
      mockFetchHtml.mockResolvedValue(collectionHtml([], 0));
      const r = await harness.callTool('homes_get_by_address', {
        address: '999 Nowhere St',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed).toEqual({ resolved: false, error: 'no listing found' });
    });

    it('a fetchproxy timeout in one rung does not mask a genuine resolve in a later rung', async () => {
      // Typeahead times out, but the slug rung resolves cleanly. The
      // timeout must not poison a successful later rung.
      mockFetchJson.mockReset();
      mockFetchJson.mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/',
          timeoutMs: 30000,
        })
      );
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('slugwin', '126 Sleeping Bear Ln')])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) expect(parsed.property_hash).toBe('slugwin');
    });
  });

  // ── Search-fallback as a first-class rung on typeahead timeout (#65) ──
  //
  // The typeahead rung is the timeout-prone one (it's the first hop on a
  // cold bridge). A typeahead TIMEOUT must NOT prevent resolution when the
  // search corpus has the address — the search-fallback rung (whole-token
  // street match) is a first-class alternative, not just a last resort
  // after the slug rung. These pin: a typeahead timeout still lands on the
  // search-fallback and resolves; the earlier timeout does not poison a
  // successful search-fallback into a `status: 'timeout'`.
  describe('search-fallback rung on typeahead timeout (#65)', () => {
    it('resolves via the search-fallback rung when the typeahead rung times out (slug empty)', async () => {
      mockFetchJson.mockReset();
      mockFetchJson.mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/',
          timeoutMs: 30000,
        })
      );
      // Slug rung: no JSON-LD. Search-fallback: the listing is present.
      mockFetchHtml.mockResolvedValueOnce('<html>nothing here</html>');
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('searchwin', '158 Raven Blvd')])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '158 Raven Blvd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      expect(r.isError).toBeFalsy();
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) {
        expect(parsed.matched_via).toBe('search_fallback');
        expect(parsed.property_hash).toBe('searchwin');
      }
    });

    it('resolves via the search-fallback rung when BOTH the typeahead and slug rungs time out (search page reachable)', async () => {
      // The crux of #65 + #64: the typeahead and slug rungs time out on a
      // half-cold bridge, but the search page is reachable and carries the
      // listing. The earlier timeouts must NOT short-circuit to a
      // `status: 'timeout'` — the search-fallback resolves cleanly.
      mockFetchJson.mockReset();
      mockFetchJson.mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/',
          timeoutMs: 30000,
        })
      );
      // Slug rung throws a timeout; search-fallback resolves.
      mockFetchHtml.mockRejectedValueOnce(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/',
          timeoutMs: 30000,
        })
      );
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([itemFor('lateresolve', '219 Picnic Point')])
      );
      const r = await harness.callTool('homes_get_by_address', {
        address: '219 Picnic Point',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<ByAddressResult>(r);
      expect(parsed.resolved).toBe(true);
      if (parsed.resolved) {
        expect(parsed.matched_via).toBe('search_fallback');
        expect(parsed.property_hash).toBe('lateresolve');
      }
    });

    it('whole-token street match on the fallback keeps the street-number guard (no wrong-number pick) after a typeahead timeout', async () => {
      mockFetchJson.mockReset();
      mockFetchJson.mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/',
          timeoutMs: 30000,
        })
      );
      mockFetchHtml.mockResolvedValueOnce('<html>nothing here</html>');
      // Same street name, different numbers — the guard must pick 126.
      mockFetchHtml.mockResolvedValueOnce(
        collectionHtml([
          itemFor('wrongnum', '127 Sleeping Bear Ln'),
          itemFor('rightnum', '126 Sleeping Bear Ln'),
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
        expect(parsed.matched_via).toBe('search_fallback');
        expect(parsed.property_hash).toBe('rightnum');
      }
    });
  });

});

// ── Per-request deadline (#54) ────────────────────────────────────────
//
// Even a single `homes_get_by_address` was observed timing out at the
// MCP layer (`-32001 Request timed out`) — the per-request path had no
// effective deadline shorter than the client's, so a hung homes.com
// fetch wedged the whole connection. `resolveOneAddressDeadlined` now
// caps the whole resolution and returns a clean `{ resolved: false,
// error: 'timeout' }` row instead of hanging until the client kills it.
//
// Tested at the helper level (not through the MCP harness) so we can
// drive fake timers without racing the SDK's own request-timeout timer.
describe('resolveOneAddressDeadlined', () => {
  const dlFetchHtml = vi.fn();
  const dlFetchJson = vi.fn();
  const dlClient = {
    fetchHtml: dlFetchHtml,
    fetchJson: dlFetchJson,
  } as unknown as HomesClient;

  beforeEach(() => {
    dlFetchHtml.mockReset();
    dlFetchJson.mockReset();
    // Typeahead rung returns no candidates so these timeout/quick tests
    // exercise the slug rung exactly as before (#54 behaviour).
    dlFetchJson.mockResolvedValue({ suggestions: { places: [] } });
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('returns a clean timeout error (not an infinite hang) when the fetch never settles', async () => {
    // fetchHtml never resolves — simulates a hung homes.com SSR fetch
    // that the transport's own timeout failed to abort.
    dlFetchHtml.mockImplementation(() => new Promise<string>(() => {}));

    const p = resolveOneAddressDeadlined(
      dlClient,
      {
        address: '155 Quail Cove Blvd Unit 1601',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      },
      10_000
    );

    await vi.advanceTimersByTimeAsync(10_001);
    const result = await p;

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.error).toBe('timeout');
    }
  });

  it('returns the resolved row when the fetch settles before the deadline', async () => {
    dlFetchHtml.mockResolvedValueOnce(
      detailHtmlTop(
        'https://www.homes.com/property/x/quickhash/',
        '1 Fast Ln'
      )
    );
    const p = resolveOneAddressDeadlined(
      dlClient,
      { address: '1 Fast Ln', city: 'Atlanta', state: 'GA' },
      10_000
    );
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.property_hash).toBe('quickhash');
    }
  });
});

// Detail-page JSON-LD factory shared by the deadline suite (the one
// inside the `homes_get_by_address tool` describe is scoped to it).
function detailHtmlTop(url: string, streetAddress: string): string {
  const doc = {
    '@context': 'https://schema.org',
    '@graph': [
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
}
