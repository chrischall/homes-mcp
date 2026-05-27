import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

  it('strips #realestatelisting fragments from @id (homes.com SSR adds them)', () => {
    expect(
      extractPropertyId({
        '@id': 'https://www.homes.com/property/x/abc123/#realestatelisting',
      })
    ).toBe('abc123');
  });

  it('prefers url over @id when both are present', () => {
    expect(
      extractPropertyId({
        '@id': 'https://www.homes.com/property/x/abc123/#realestatelisting',
        url: 'https://www.homes.com/property/x/abc123/',
      })
    ).toBe('abc123');
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
    // description default-off per #13 — see "include_description" coverage below.
    expect(out.description).toBeUndefined();
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const RICH_FIXTURE = readFileSync(
  resolve(__dirname, '../fixtures/property-detail-rich.html'),
  'utf8'
);

describe('homes_get_property — richer fields', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerPropertyTools(s, c));
  });
  afterAll(async () => h?.close());

  it('omits description by default (#13 — context-savings)', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const r = await h.callTool('homes_get_property', {
      url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
    });
    const p = parseToolResult<any>(r);
    expect(p.description).toBeUndefined();
  });

  it('returns description when include_description: true', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const r = await h.callTool('homes_get_property', {
      url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      include_description: true,
    });
    const p = parseToolResult<any>(r);
    expect(p.description).toContain('Charming bungalow');
  });

  it('always populates extracted_features when a description exists (#14)', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const r = await h.callTool('homes_get_property', {
      url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
    });
    const p = parseToolResult<any>(r);
    expect(p.extracted_features).toBeDefined();
    expect(p.extracted_features).toMatchObject({
      lake_front: expect.any(Boolean),
      hot_tub: expect.any(Boolean),
    });
  });

  it('extracts highlights bullets from the Highlights section', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.highlights).toEqual([
      'Ranch Style House',
      'In-Law or Guest Suite',
      'Central Air',
      'No HOA',
    ]);
  });

  it('extracts estimated_monthly_payment and total_views', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.estimated_monthly_payment).toBe(1994);
    expect(p.total_views).toBe(87346);
  });

  it('extracts matterport_url', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.matterport_url).toContain('matterport.com');
  });

  it('extracts floorplan_urls', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.floorplan_urls).toHaveLength(2);
    expect(p.floorplan_urls[0]).toContain('floorplan');
  });

  it('extracts schools', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.schools).toHaveLength(3);
    expect(p.schools[0].name).toContain('Cascade Elementary');
  });

  it('extracts mls_id and mls_source from the Listing and Financial Details section', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.mls_id).toBe('7654321');
    expect(p.mls_source).toBe('FMLS');
  });

  it('extracts hoa_fee (0 when "No HOA")', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.hoa_fee).toBe(0);
  });

  it('extracts lot size and parking', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.lot_size_sqft).toBe(10890);
    expect(p.lot_size_acres).toBeCloseTo(0.25, 2);
    expect(p.parking).toContain('2-car garage');
  });

  it('extracts heating and cooling', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.heating).toContain('Forced Air');
    expect(p.cooling).toContain('Central Air');
  });

  it('preserves existing fields (address, lat, price, beds, baths, year_built)', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.address).toBe('123 Test St');
    expect(p.lat).toBeCloseTo(33.74, 2);
    expect(p.price).toBe(425000);
    expect(p.beds).toBe(4);
    expect(p.baths).toBe(3);
    expect(p.year_built).toBe(1955);
  });

  it('always emits portal_url_hyperlink mirroring url (#22)', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.portal_url_hyperlink).toBe(`=HYPERLINK("${p.url}","Homes")`);
  });

  it('emits days_on_market derived from datePosted (#16)', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(typeof p.days_on_market).toBe('number');
  });

  it('emits hoa_monthly_usd of 0 when listing shows "No HOA" (#15)', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.hoa_monthly_usd).toBe(0);
  });

  it('omits address_alternates when no MLS alternates exist (#23)', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.address_alternates).toBeUndefined();
  });
});

describe('homes_get_property — sentinel + alternates pinned via JSON-LD shim', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch2 = vi.fn();
  const c = { fetchHtml: fetch2 } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerPropertyTools(s, c));
  });
  afterAll(async () => h?.close());

  // Synthesize HTML with the financial section homes.com renders. The
  // sentinel + alternate cases don't exist in the rich fixture so we
  // build minimal HTML around each scenario.
  const htmlWithFinSection = (finText: string, alternates: string[] = []) => {
    const altHtml = alternates
      .map((a) => `<span data-unparsed-address="${a}"></span>`)
      .join('');
    return `<html><script type="application/ld+json">${JSON.stringify({
      '@graph': [
        {
          '@type': ['RealEstateListing', 'Product'],
          url: 'https://www.homes.com/property/x/abc/',
          offers: { price: 500000 },
          mainEntity: {
            address: { streetAddress: '123 Main St' },
          },
        },
      ],
    })}</script><body><h3>Listing and Financial Details</h3><div>${finText}</div>${altHtml}</body></html>`;
  };

  it('nulls tax_annual when upstream reports $1 sentinel (#17)', async () => {
    fetch2.mockResolvedValueOnce(htmlWithFinSection('Property Tax: $1. MLS#: AB-1.'));
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/x/abc/',
      })
    );
    expect(p.tax_annual).toBe(null);
  });

  it('keeps real tax_annual values intact (#17)', async () => {
    fetch2.mockResolvedValueOnce(htmlWithFinSection('Property Tax: $4,500.'));
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/x/abc/',
      })
    );
    expect(p.tax_annual).toBe(4500);
  });

  it('surfaces tax_is_estimated when the section flags it (#17)', async () => {
    fetch2.mockResolvedValueOnce(
      htmlWithFinSection('Property Tax: $4,500 (estimated by county).')
    );
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/x/abc/',
      })
    );
    expect(p.tax_is_estimated).toBe(true);
  });

  it('normalizes annual HOA to monthly USD (#15)', async () => {
    fetch2.mockResolvedValueOnce(htmlWithFinSection('HOA Fee: $4,967 annually'));
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/x/abc/',
      })
    );
    expect(p.hoa_fee).toBe(4967);
    expect(p.hoa_monthly_usd).toBe(414);
  });

  it('normalizes "$250 / month" HOA to monthly USD (#15)', async () => {
    fetch2.mockResolvedValueOnce(htmlWithFinSection('HOA Fee: $250 / month'));
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/x/abc/',
      })
    );
    expect(p.hoa_fee).toBe(250);
    expect(p.hoa_monthly_usd).toBe(250);
  });

  it('emits price_drop_amount + price_drop_percent when previous price is surfaced (#16)', async () => {
    fetch2.mockResolvedValueOnce(
      htmlWithFinSection('Previous Price: $550,000. MLS#: X.')
    );
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/x/abc/',
      })
    );
    expect(p.previous_list_price).toBe(550000);
    expect(p.price_drop_amount).toBe(50000);
    expect(p.price_drop_percent).toBeCloseTo(9.1, 1);
  });

  it('surfaces address_alternates from data-unparsed-address when they differ (#23)', async () => {
    fetch2.mockResolvedValueOnce(
      htmlWithFinSection('', ['169 Overlook Point Ln', '109 Overlook Point Ln'])
    );
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/x/abc/',
      })
    );
    expect(p.address_alternates).toEqual([
      '169 Overlook Point Ln',
      '109 Overlook Point Ln',
    ]);
  });

  it('drops alternates that equal the primary address (#23)', async () => {
    fetch2.mockResolvedValueOnce(htmlWithFinSection('', ['123 Main St']));
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/x/abc/',
      })
    );
    expect(p.address_alternates).toBeUndefined();
  });
});
