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
 * Fetch + align N homes.com properties for side-by-side comparison.
 *
 * Per-target failures don't fail the whole call — each row reports an
 * `error` string with the message and the per-row `property` is null.
 * Fetches are concurrent.
 */

export interface CompareTarget {
  url?: string;
}

interface CompareRow {
  property_id?: string;
  url?: string;
  property?: FormattedProperty;
  error?: string;
}

interface SummaryRow {
  field: string;
  values: Array<string | number | null>;
}

const SUMMARY_FIELDS: Array<keyof FormattedProperty> = [
  'address',
  'city',
  'state',
  'zip',
  'price',
  'beds',
  'baths',
  'sqft',
  'year_built',
  'status',
];

export function buildSummary(rows: CompareRow[]): SummaryRow[] {
  return SUMMARY_FIELDS.map((field) => ({
    field,
    values: rows.map((r) =>
      r.property
        ? ((r.property as unknown as Record<string, unknown>)[field] as
            | string
            | number
            | null
            | undefined) ?? null
        : null
    ),
  }));
}

export function registerCompareTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_compare_properties',
    {
      title: 'Compare homes.com properties side-by-side',
      description:
        "Fetch 2 or more homes.com properties and align their facts side-by-side. Each target supplies a `url` — the full homes.com property URL (e.g. from a homes_search_properties result's `url` field). Returns a compact summary table aligned by field (address, price, beds/baths, sqft, year built, status) plus the full per-property record. Per-target errors are captured per-row — one bad target will not fail the whole call. Calls are concurrent.",
      annotations: {
        title: 'Compare homes.com properties side-by-side',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        targets: z
          .array(
            z
              .object({
                url: z
                  .string()
                  .describe(
                    'homes.com property URL or path. Required per target — pass the `url` field from a homes_search_properties result.'
                  ),
              })
              .passthrough()
          )
          .min(2)
          .max(8)
          .describe('Array of 2–8 properties to compare'),
      },
    },
    async ({ targets }) => {
      const ts = targets as CompareTarget[];
      const rows: CompareRow[] = await Promise.all(
        ts.map(async (t) => {
          try {
            const { listing, html } = await fetchListingRecord(client, t);
            const formatted = format(listing, html);
            return {
              property_id: formatted.property_id,
              url: formatted.url,
              property: formatted,
            };
          } catch (e) {
            return {
              url: t.url,
              error: (e as Error).message,
            };
          }
        })
      );
      const summary = buildSummary(rows);
      return textResult({
        count: rows.length,
        summary,
        results: rows,
      });
    }
  );
}
