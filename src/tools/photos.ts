import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { extractImgTags } from '@fetchproxy/server';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { lastPathSegment } from '../jsonld.js';
import { fetchListingRecord } from './properties.js';

// Re-exported from @fetchproxy/server so tests/tools/photos.test.ts (and any
// other caller importing from this module) keep their import path unchanged.
export { extractImgTags };

/**
 * Photo galleries on homes.com are NOT exposed via JSON-LD beyond a
 * single `image` URL and a `primaryImageOfPage`. The full gallery — the
 * one users actually see when they click into a listing — lives only
 * in the DOM: there are ~20-30 `<img>` tags on every detail page whose
 * `src` points at the homes.com CDN.
 *
 * For v0.1 we scrape those `<img>` tags directly from the SSR HTML.
 * We filter by host (`homes.com` in the URL) to skip site-chrome icons
 * pulled from other CDNs.
 *
 * This is a v0.1 trade-off — JSON-LD would be cleaner but doesn't
 * carry the gallery. A future version could parse a richer DOM-side
 * data structure if one becomes available.
 *
 * Verified live 2026-05-24 against
 *   /property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/
 *   — counted 22 listing-photo `<img>` tags pointing at the homes.com
 *   CDN, plus a handful of icons from unrelated hosts that we filter
 *   out by host check.
 */

export interface FormattedPhoto {
  url: string;
  position: number;
  alt?: string;
}

/**
 * Filter `<img>` tags to ones served from a homes.com CDN. The site
 * uses a handful of host names — they all share `homes.com` somewhere
 * in the URL. This drops third-party widgets (analytics pixels, etc.)
 * while keeping every listing photo.
 *
 * Also deduplicate by URL — listing photos sometimes appear twice
 * (once in the carousel, once as a thumbnail). Order is preserved by
 * first occurrence.
 */
export function pickListingPhotos(
  imgs: Array<{ src: string; alt?: string }>
): Array<{ src: string; alt?: string }> {
  const seen = new Set<string>();
  const out: Array<{ src: string; alt?: string }> = [];
  for (const img of imgs) {
    if (!img.src.includes('homes.com')) continue;
    // Skip obvious data: / SVG-inline / blank images.
    if (img.src.startsWith('data:')) continue;
    if (seen.has(img.src)) continue;
    seen.add(img.src);
    out.push(img);
  }
  return out;
}

export function registerPhotosTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_property_photos',
    {
      title: 'Get homes.com property photo gallery',
      description:
        "The full photo gallery for a homes.com listing. homes.com's JSON-LD only exposes one primary image, so this tool scrapes every <img> tag on the property detail page and filters to the homes.com CDN. Pass `url` — the full homes.com property URL or path (e.g. from a homes_search_properties result's `url` field). Returns `{ property_id, url, count, photos: [{ url, position, alt? }] }`. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get homes.com property photo gallery',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z
          .string()
          .describe(
            'homes.com property detail URL or path. Required — pass the `url` field from a homes_search_properties result.'
          ),
      },
    },
    async ({ url }) => {
      const { listing, html } = await fetchListingRecord(client, { url });
      const raw = extractImgTags(html);
      const picked = pickListingPhotos(raw);
      const photos: FormattedPhoto[] = picked.map((img, i) => ({
        url: img.src,
        position: i + 1,
        ...(img.alt ? { alt: img.alt } : {}),
      }));
      // Prefer listing.url over listing['@id'] (homes.com @id now has a
      // #realestatelisting fragment). `lastPathSegment` strips the
      // #fragment and ?query before taking the last path segment.
      return textResult({
        property_id: lastPathSegment(listing.url ?? listing['@id'] ?? ''),
        url: listing.url ?? listing['@id'] ?? '',
        count: photos.length,
        photos,
      });
    }
  );
}
