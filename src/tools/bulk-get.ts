import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  fetchListingRecord,
  format,
  type FormattedProperty,
} from './properties.js';

/**
 * `homes_bulk_get` — unbounded structured fetch for the
 * "I have 53 saved homes, give me everything" workflow (#19). Keeps
 * `homes_compare_properties` focused on side-by-side analysis (which
 * caps at 8 + carries a summary table); this tool is rows-only.
 *
 * Per-row failures are captured. Fetches are concurrent. Order
 * matches input order — the caller can map a parallel input array of
 * notes/labels directly onto results.
 */

const MAX_URLS = 200;

interface BulkRow {
  url: string;
  property_id?: string;
  property?: FormattedProperty;
  error?: string;
}

export function registerBulkGetTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_bulk_get',
    {
      title: 'Bulk-fetch homes.com properties (structured records only)',
      description:
        "Fetch up to 200 homes.com properties in one call and return their structured records. Pass `urls: string[]`. Results are ordered to match the input array and per-row errors are captured (one bad URL won't fail the whole call). Mirrors `homes_get_property` per-row, including `extracted_features`, `hoa_fee`, `highlights`, `schools`, and all standard listing fields. The raw `description` is omitted by default; opt back in via `include_description: true`. Use this instead of looping `homes_compare_properties` (which caps at 8 + emits a redundant summary table) when you just want the records. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Bulk-fetch homes.com properties (structured records only)',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        urls: z
          .array(z.string())
          .min(1)
          .max(MAX_URLS)
          .describe(
            `Array of homes.com property URLs or paths (e.g. from a homes_search_properties result). 1–${MAX_URLS} per call.`
          ),
        include_description: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When true, include the raw listing `description` marketing prose per-row. Default false.'
          ),
      },
    },
    async ({ urls, include_description }) => {
      const rows: BulkRow[] = await Promise.all(
        urls.map(async (url): Promise<BulkRow> => {
          try {
            const { listing, html } = await fetchListingRecord(client, { url });
            const formatted = format(listing, html, {
              includeDescription: include_description,
            });
            return {
              url,
              property_id: formatted.property_id,
              property: formatted,
            };
          } catch (e) {
            return {
              url,
              error: (e as Error).message,
            };
          }
        })
      );
      return textResult({
        count: rows.length,
        results: rows,
      });
    }
  );
}
