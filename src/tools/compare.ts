import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { runBoundedBatch } from "@chrischall/mcp-utils";
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from "@chrischall/mcp-utils/fetchproxy";
import { pivotSummary, runRowBatch, type SummaryRow } from "@chrischall/realty-core";
import type { HomesClient } from "../client.js";
import { viewArg, viewResponse } from "../view.js";
import {
  includeAgentContactArg,
  fetchListingRecord,
  format,
  type FormattedProperty,
} from "./properties.js";

/**
 * Fetch + align N homes.com properties for side-by-side comparison.
 *
 * Per-target failures don't fail the whole call — each failed row carries
 * the classified `status` / `error_kind`, `retryable` and `error` (the
 * cohort row envelope, realty-core `runRowBatch`, fleet-audit#1091).
 * Fetches are concurrent and the call is deadline-bounded.
 */

export interface CompareTarget {
  url?: string;
}

interface CompareRow {
  url?: string;
  property?: FormattedProperty;
}

const SUMMARY_FIELDS: Array<keyof FormattedProperty> = [
  "address",
  "city",
  "state",
  "zip",
  "price",
  "beds",
  "baths",
  "sqft",
  "lot_size_sqft",
  "lot_size_acres",
  "year_built",
  "status",
  "hoa_fee",
  "hoa_monthly_usd",
  "days_on_market",
  "price_drop_amount",
];

/**
 * The opt-in cross-row `summary` table — realty-core's `pivotSummary`:
 * each cell is the row's property value verbatim (`undefined` / failed row
 * → `null`), same type as `row.property[field]` (#18).
 */
export function buildSummary(rows: ReadonlyArray<CompareRow>): SummaryRow[] {
  return pivotSummary<FormattedProperty>(rows, SUMMARY_FIELDS);
}

export function registerCompareTools(
  server: McpServer,
  client: HomesClient,
): void {
  server.registerTool(
    "homes_compare_properties",
    {
      title: "Compare homes.com properties side-by-side",
      description:
        "Fetch 2 or more homes.com properties and align their facts side-by-side. Each target supplies a `url` — the full homes.com property URL (e.g. from a homes_search_properties result's `url` field). Returns the full per-property record (with server-side `extracted_features`, `hoa_monthly_usd`, `days_on_market`, `price_drop_*`, `lot_size_sqft` + the derived `lot_size_acres`, and `portal_url_hyperlink`). Per-target errors are captured per-row — one bad target will not fail the whole call: a failed row carries `status` = `error_kind` (`timeout` / `bridge_down` / `protocol` / `other`) plus `retryable` and `error`, and the envelope reports `count` / `ok` / `errored`. Calls are concurrent and bounded by an overall deadline: any row still unsettled comes back `status: \"pending\"` (retryable) with a top-level `pending` count — re-run just those targets. The raw `description` is omitted by default; pass `include_description: true` to keep the marketing prose. `listing_agent` omits the agent's telephone/email unless `include_agent_contact: true`. The cross-row `summary` table duplicates per-property fields (~30% of response weight); it is OPT-IN via `include_summary: true`.",
      annotations: {
        title: "Compare homes.com properties side-by-side",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        targets: z
          .array(
            z
              .object({
                url: z
                  .string()
                  .describe(
                    "homes.com property URL or path. Required per target — pass the `url` field from a homes_search_properties result.",
                  ),
              })
              .passthrough(),
          )
          .min(2)
          .max(8)
          .describe("Array of 2–8 properties to compare"),
        include_description: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, include the raw listing `description` marketing prose on each per-property record. Default false.",
          ),
        include_summary: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, also emit a cross-row `summary` table aligned by field. Default false — the per-row records already carry every summary field, so the table is redundant context weight unless explicitly requested (#18).",
          ),
        include_agent_contact: includeAgentContactArg(),
      }),
    },
    async ({
      targets,
      include_description,
      include_summary,
      include_agent_contact,
      view,
    }) => {
      const ts = targets as CompareTarget[];
      // See bulk-get.ts header for the round-3 #78 rationale on
      // BRIDGE_CONCURRENCY + retryOnceOnTimeout + classifyRowError.
      // Compare caps at 8 targets so the cap rarely binds, but the
      // distinct-timeout wrapper still matters: a bridge timeout in
      // row 3 of an 8-row compare must not look like a parse error.
      const envelope = await runRowBatch(
        ts,
        async (t) => {
          const { listing, html } = await fetchListingRecord(client, t);
          const formatted = format(listing, html, {
            includeDescription: include_description,
            includeAgentContact: include_agent_contact,
          });
          return {
            property_id: formatted.property_id,
            url: formatted.url,
            property: formatted,
          };
        },
        {
          kit: { runBoundedBatch, classifyRowError, retryOnceOnTimeout },
          toolLabel: "homes_compare_properties",
          rowBase: (t) => ({ url: t.url }),
          concurrency: BRIDGE_CONCURRENCY,
        },
      );
      const payload: typeof envelope & { summary?: SummaryRow[] } = envelope;
      if (include_summary) {
        payload.summary = buildSummary(envelope.results);
      }
      return viewResponse(view, payload);
    },
  );
}
