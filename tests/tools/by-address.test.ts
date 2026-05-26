import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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

  beforeAll(() => vi.clearAllMocks());

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
});
