import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import {
  buildPath,
  extractPropertyId,
  findListing,
  format,
  registerPropertyTools,
} from '../../src/tools/properties.js';
import { extractJsonLd } from '../../src/page-state.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('buildPath', () => {
  it('preserves a path-shaped URL', () => {
    expect(buildPath({ url: '/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/' })).toBe(
      '/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/'
    );
  });

  it('reduces a full URL to its path', () => {
    expect(
      buildPath({ url: 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/' })
    ).toBe('/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/');
  });

  it('throws when no url is provided', () => {
    expect(() => buildPath({})).toThrow(/must provide `url`/);
  });
});

describe('extractPropertyId', () => {
  it('pulls the property id out of a full URL', () => {
    expect(
      extractPropertyId({
        url: 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
      })
    ).toBe('rxrzwg0kjnr32');
  });

  it('falls back to @id when url is missing', () => {
    expect(extractPropertyId({ '@id': 'https://www.homes.com/property/x/abc/' })).toBe('abc');
  });
});

describe('findListing', () => {
  it('finds the RealEstateListing node in the graph', () => {
    const doc = extractJsonLd(
      `<script type="application/ld+json">${JSON.stringify({
        '@graph': [
          { '@type': 'BreadcrumbList' },
          {
            '@type': ['RealEstateListing', 'Product'],
            name: 'A nice home',
            url: 'https://www.homes.com/property/x/abc/',
          },
        ],
      })}</script>`
    );
    expect(findListing(doc)?.name).toBe('A nice home');
  });

  it('returns null when no listing node is in the graph', () => {
    const doc = extractJsonLd(
      `<script type="application/ld+json">${JSON.stringify({
        '@graph': [{ '@type': 'BreadcrumbList' }],
      })}</script>`
    );
    expect(findListing(doc)).toBeNull();
  });
});

describe('format', () => {
  it('flattens a detail-page listing JSON-LD into the canonical shape', () => {
    const out = format({
      '@type': ['RealEstateListing', 'Product'],
      '@id': 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
      url: 'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/',
      name: '3199 Delmar Ln NW',
      description: 'Charming bungalow with hardwood floors.',
      image: 'https://images.homes.com/listing/photo1.jpg',
      datePosted: '2026-05-01T00:00:00Z',
      dateModified: '2026-05-20T00:00:00Z',
      offers: {
        price: 525000,
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        seller: { name: 'Coldwell Banker' },
        offeredBy: [
          {
            name: 'Jane Smith',
            telephone: '+1-404-555-0100',
            email: 'jane@cb.com',
            jobTitle: 'Real Estate Agent',
            url: 'https://www.homes.com/agent/jane-smith/',
            memberOf: { name: 'Coldwell Banker' },
          },
        ],
      },
      mainEntity: {
        '@type': 'SingleFamilyResidence',
        numberOfBedrooms: 4,
        numberOfBathroomsTotal: 3,
        yearBuilt: 1955,
        floorSize: { value: 2400, unitCode: 'FTK' },
        address: {
          streetAddress: '3199 Delmar Ln NW',
          addressLocality: 'Atlanta',
          addressRegion: 'GA',
          postalCode: '30311',
          addressCountry: 'US',
        },
        geo: { latitude: 33.789, longitude: -84.456 },
      },
    });

    expect(out.property_id).toBe('rxrzwg0kjnr32');
    expect(out.url).toBe(
      'https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/'
    );
    expect(out.address).toBe('3199 Delmar Ln NW');
    expect(out.city).toBe('Atlanta');
    expect(out.state).toBe('GA');
    expect(out.zip).toBe('30311');
    expect(out.lat).toBe(33.789);
    expect(out.lng).toBe(-84.456);
    expect(out.beds).toBe(4);
    expect(out.baths).toBe(3);
    expect(out.sqft).toBe(2400);
    expect(out.year_built).toBe(1955);
    expect(out.price).toBe(525000);
    expect(out.price_currency).toBe('USD');
    expect(out.description).toBe('Charming bungalow with hardwood floors.');
    expect(out.date_posted).toBe('2026-05-01T00:00:00Z');
    expect(out.date_modified).toBe('2026-05-20T00:00:00Z');
    expect(out.listing_agent).toEqual({
      name: 'Jane Smith',
      telephone: '+1-404-555-0100',
      email: 'jane@cb.com',
      job_title: 'Real Estate Agent',
      url: 'https://www.homes.com/agent/jane-smith/',
    });
    expect(out.brokerage).toBe('Coldwell Banker');
  });

  it('uses primaryImageOfPage when present', () => {
    const out = format({
      url: 'https://www.homes.com/property/x/abc/',
      primaryImageOfPage: { url: 'https://images.homes.com/primary.jpg' },
      mainEntity: {},
    });
    expect(out.primary_photo_url).toBe('https://images.homes.com/primary.jpg');
  });

  it('falls back to seller.name when offeredBy is missing', () => {
    const out = format({
      url: 'https://www.homes.com/property/x/abc/',
      offers: { seller: { name: 'Solo Realty' } },
      mainEntity: {},
    });
    expect(out.brokerage).toBe('Solo Realty');
    expect(out.listing_agent).toBeUndefined();
  });
});

describe('homes_get_property tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerPropertyTools(server, mockClient)
    );
  });

  const htmlWith = (listing: unknown) => {
    const doc = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'BreadcrumbList' },
        listing,
      ],
    };
    return `<html><script type="application/ld+json">${JSON.stringify(doc)}</script></html>`;
  };

  it('fetches the property page + returns the formatted record', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        '@type': ['RealEstateListing', 'Product'],
        '@id': 'https://www.homes.com/property/foo/abc/',
        url: 'https://www.homes.com/property/foo/abc/',
        offers: { price: 1000000, availability: 'https://schema.org/InStock' },
        mainEntity: {
          numberOfBedrooms: 3,
          numberOfBathroomsTotal: 2,
          address: {
            streetAddress: '1 Main',
            addressLocality: 'Atlanta',
            addressRegion: 'GA',
          },
          geo: { latitude: 33.7, longitude: -84.4 },
        },
      })
    );
    const r = await harness.callTool('homes_get_property', {
      url: '/property/foo/abc/',
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/property/foo/abc/');
    const parsed = parseToolResult<{
      address: string;
      price: number;
      status: string;
      lat: number;
    }>(r);
    expect(parsed.address).toBe('1 Main');
    expect(parsed.price).toBe(1000000);
    expect(parsed.status).toBe('https://schema.org/InStock');
    expect(parsed.lat).toBe(33.7);
  });

  it('throws when JSON-LD is absent', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no json-ld here</html>');
    const r = await harness.callTool('homes_get_property', {
      url: '/property/foo/abc/',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/Could not locate JSON-LD/);
  });

  it('throws when the JSON-LD has no listing node', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      `<html><script type="application/ld+json">${JSON.stringify({
        '@graph': [{ '@type': 'BreadcrumbList' }],
      })}</script></html>`
    );
    const r = await harness.callTool('homes_get_property', {
      url: '/property/foo/abc/',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/No RealEstateListing/);
  });
});
