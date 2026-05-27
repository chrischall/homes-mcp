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
  // Mirrors per-row values verbatim — no string-coercion / no
  // JSON-encoding. The summary cell value for `hoa_fee` is the same
  // type as `row.property.hoa_fee` (#18).
  values: Array<unknown>;
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
  'hoa_fee',
  'hoa_monthly_usd',
  'days_on_market',
  'price_drop_amount',
];

export function buildSummary(rows: CompareRow[]): SummaryRow[] {
  return SUMMARY_FIELDS.map((field) => ({
    field,
    values: rows.map((r) =>
      r.property
        ? ((r.property as unknown as Record<string, unknown>)[field] ?? null)
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
        "Fetch 2 or more homes.com properties and align their facts side-by-side. Each target supplies a `url` — the full homes.com property URL (e.g. from a homes_search_properties result's `url` field). Returns the full per-property record (with server-side `extracted_features`, `hoa_monthly_usd`, `days_on_market`, `price_drop_*`, and `portal_url_hyperlink`). Per-target errors are captured per-row — one bad target will not fail the whole call. Calls are concurrent. The raw `description` is omitted by default; pass `include_description: true` to keep the marketing prose. The cross-row `summary` table duplicates per-property fields (~30% of response weight); it is OPT-IN via `include_summary: true`.",
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
        include_description: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When true, include the raw listing `description` marketing prose on each per-property record. Default false.'
          ),
        include_summary: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When true, also emit a cross-row `summary` table aligned by field. Default false — the per-row records already carry every summary field, so the table is redundant context weight unless explicitly requested (#18).'
          ),
      },
    },
    async ({ targets, include_description, include_summary }) => {
      const ts = targets as CompareTarget[];
      const rows: CompareRow[] = await Promise.all(
        ts.map(async (t) => {
          try {
            const { listing, html } = await fetchListingRecord(client, t);
            const formatted = format(listing, html, {
              includeDescription: include_description,
            });
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
      const payload: {
        count: number;
        summary?: SummaryRow[];
        results: CompareRow[];
      } = {
        count: rows.length,
        results: rows,
      };
      if (include_summary) {
        payload.summary = buildSummary(rows);
      }
      return textResult(payload);
    }
  );
}
