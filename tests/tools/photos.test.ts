import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import {
  extractImgTags,
  pickListingPhotos,
  registerPhotosTools,
} from '../../src/tools/photos.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('extractImgTags', () => {
  it('finds all <img> tags and captures src + alt', () => {
    const html = `
      <img src="https://images.homes.com/a.jpg" alt="Kitchen">
      <img alt="Living" src="https://images.homes.com/b.jpg">
      <img src="https://other.com/icon.svg">
    `;
    const tags = extractImgTags(html);
    expect(tags).toEqual([
      { src: 'https://images.homes.com/a.jpg', alt: 'Kitchen' },
      { src: 'https://images.homes.com/b.jpg', alt: 'Living' },
      { src: 'https://other.com/icon.svg' },
    ]);
  });

  it('skips img tags without a src attribute', () => {
    expect(extractImgTags('<img alt="oops">')).toEqual([]);
  });

  it('tolerates extra attributes and varied quote styles', () => {
    const html = `<img class="x" data-foo='bar' src='https://images.homes.com/x.jpg' loading="lazy">`;
    expect(extractImgTags(html)).toEqual([{ src: 'https://images.homes.com/x.jpg' }]);
  });
});

describe('pickListingPhotos', () => {
  it('keeps only homes.com hosted images', () => {
    const out = pickListingPhotos([
      { src: 'https://images.homes.com/a.jpg' },
      { src: 'https://cdn.other.com/icon.png' },
      { src: 'https://www.homes.com/static/b.jpg' },
    ]);
    expect(out.map((p) => p.src)).toEqual([
      'https://images.homes.com/a.jpg',
      'https://www.homes.com/static/b.jpg',
    ]);
  });

  it('deduplicates repeated URLs, preserving first-occurrence order', () => {
    const out = pickListingPhotos([
      { src: 'https://images.homes.com/a.jpg' },
      { src: 'https://images.homes.com/b.jpg' },
      { src: 'https://images.homes.com/a.jpg' },
    ]);
    expect(out.map((p) => p.src)).toEqual([
      'https://images.homes.com/a.jpg',
      'https://images.homes.com/b.jpg',
    ]);
  });

  it('skips data: URLs', () => {
    const out = pickListingPhotos([
      { src: 'data:image/png;base64,AAAA' },
      { src: 'https://images.homes.com/a.jpg' },
    ]);
    expect(out.map((p) => p.src)).toEqual(['https://images.homes.com/a.jpg']);
  });
});

const htmlWithListing = (extraBody = '') => {
  const doc = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['RealEstateListing', 'Product'],
        '@id': 'https://www.homes.com/property/foo/abc/',
        url: 'https://www.homes.com/property/foo/abc/',
        offers: {},
        mainEntity: {},
      },
    ],
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(doc)}</script></head><body>${extraBody}</body></html>`;
};

describe('homes_get_property_photos tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerPhotosTools(server, mockClient)
    );
  });

  it('scrapes <img> tags pointing at the homes.com CDN', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithListing(`
        <img src="https://images.homes.com/listing/1.jpg" alt="Front">
        <img src="https://other.com/widget.png" alt="Ad">
        <img src="https://images.homes.com/listing/2.jpg" alt="Kitchen">
      `)
    );
    const r = await harness.callTool('homes_get_property_photos', {
      url: '/property/foo/abc/',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      photos: Array<{ url: string; position: number; alt?: string }>;
    }>(r);
    expect(parsed.count).toBe(2);
    expect(parsed.photos[0]).toEqual({
      url: 'https://images.homes.com/listing/1.jpg',
      position: 1,
      alt: 'Front',
    });
    expect(parsed.photos[1].position).toBe(2);
  });

  it('returns count=0 when no homes.com images are on the page', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithListing(`<img src="https://other.com/x.png">`)
    );
    const r = await harness.callTool('homes_get_property_photos', {
      url: '/property/foo/abc/',
    });
    const parsed = parseToolResult<{ count: number; photos: unknown[] }>(r);
    expect(parsed.count).toBe(0);
    expect(parsed.photos).toEqual([]);
  });

  it('includes the property_id from the JSON-LD listing', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithListing(`<img src="https://images.homes.com/listing/1.jpg">`)
    );
    const r = await harness.callTool('homes_get_property_photos', {
      url: '/property/foo/abc/',
    });
    const parsed = parseToolResult<{ property_id: string }>(r);
    expect(parsed.property_id).toBe('abc');
  });
});
