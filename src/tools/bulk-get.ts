import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { runBoundedBatch } from "@chrischall/mcp-utils";
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from "@chrischall/mcp-utils/fetchproxy";
import { runRowBatch } from "@chrischall/realty-core";
import type { HomesClient } from "../client.js";
import { viewArg, viewResponse } from "../view.js";
import {
  includeAgentContactArg,
  fetchListingRecord,
  format,
} from "./properties.js";

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

/**
 * Overall deadline for a whole `homes_bulk_get` fan-out (D1). Same wedge
 * class the repo's own `resolve_addresses` (50s) and `by_address` (45s)
 * already closed (#54): below the MCP SDK's default 60s request timeout
 * so the handler always wins the race and returns partial rows, rather
 * than the client tearing the connection down first with a `-32001`. A
 * single hung URL out of 200 must never wedge the whole call. Matches
 * the cohort 45-50s convention (45s, in line with `by_address` and
 * zillow's `bulk_get` #98).
 */
export const BULK_GET_DEADLINE_MS = 45_000;

/**
 * Tuning knobs. Tests inject a tiny `overallDeadlineMs` so the suite
 * doesn't wait on real wall-clock.
 */
export interface BulkGetTuning {
  /**
   * Overall hard deadline (ms) for the whole call. When it fires, any
   * row that hasn't settled is left as its seeded `status: 'pending'`
   * marker and the call resolves with partial results rather than
   * hanging. Defaults to {@link BULK_GET_DEADLINE_MS}.
   */
  overallDeadlineMs?: number;
}

export function registerBulkGetTools(
  server: McpServer,
  client: HomesClient,
  tuning: BulkGetTuning = {},
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? BULK_GET_DEADLINE_MS;
  server.registerTool(
    "homes_bulk_get",
    {
      title: "Bulk-fetch homes.com properties (structured records only)",
      description:
        'Fetch up to 200 homes.com properties in one call and return their structured records. Pass `urls: string[]`. Results are ordered to match the input array and per-row errors are captured (one bad URL won\'t fail the whole call). Each row carries a `status`: `ok`, `pending`, or — on failure — the error kind (`timeout` / `bridge_down` / `protocol` / `other`, also in `error_kind`) with a `retryable` flag; the envelope reports `count` / `ok` / `errored` (+ `pending` when non-zero). Mirrors `homes_get_property` per-row, including `extracted_features`, `hoa_fee`, `highlights`, `schools`, `lot_size_sqft` + the derived `lot_size_acres` (null — never 0 — for condos / no-lot listings), and all standard listing fields. The raw `description` is omitted by default; opt back in via `include_description: true`. `listing_agent` omits the agent\'s telephone/email unless `include_agent_contact: true`. The whole call is bounded by an overall hard deadline: a single slow/hung URL never wedges the server — when the deadline is reached any unsettled row is returned with `status: "pending"` and a `pending` count so you can re-run just those URLs. Use this instead of looping `homes_compare_properties` (which caps at 8 + emits a redundant summary table) when you just want the records. Read-only; safe to call repeatedly.',
      annotations: {
        title: "Bulk-fetch homes.com properties (structured records only)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        urls: z
          .array(z.string())
          .min(1)
          .max(MAX_URLS)
          .describe(
            `Array of homes.com property URLs or paths (e.g. from a homes_search_properties result). 1–${MAX_URLS} per call.`,
          ),
        include_description: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, include the raw listing `description` marketing prose per-row. Default false.",
          ),
        include_agent_contact: includeAgentContactArg(),
        view: viewArg(),
      }),
    },
    async ({ urls, include_description, include_agent_contact, view }) => {
      // #54 partial-results contract (D1) via realty-core's shared
      // `runRowBatch` (fleet-audit#1091): bounded by `concurrency`
      // (BRIDGE_CONCURRENCY = 6, round-3 #78) and an overall deadline, with
      // one input-ordered row per URL:
      //
      //   - ok rows: `{ url, status: 'ok', property_id, property }`.
      //   - error rows: `status` = `error_kind` = the classified kind
      //     (`timeout` / `bridge_down` / `protocol` / `other`) plus
      //     `retryable` and `error`, so a bridge timeout can't be mistaken
      //     for a missing listing. retryOnceOnTimeout absorbs the
      //     rotating-tab tax on the first request to a stale tab.
      //   - pending rows: the deadline cut them off — retryable, re-run them.
      //
      // Abort handling (fleet-audit#131 / #1161): mcp-utils >= 2.12
      // `runBoundedBatch` stops dispatching once the deadline (or the
      // caller's cancel) fires, and runRowBatch re-checks the signal before
      // every attempt including the retry — so homes no longer carries its
      // own per-worker `throwIfDeadlinePassed` guard.
      const envelope = await runRowBatch(
        urls,
        async (url) => {
          const { listing, html } = await fetchListingRecord(client, { url });
          const formatted = format(listing, html, {
            includeDescription: include_description,
            includeAgentContact: include_agent_contact,
          });
          return { property_id: formatted.property_id, property: formatted };
        },
        {
          kit: { runBoundedBatch, classifyRowError, retryOnceOnTimeout },
          toolLabel: "homes_bulk_get",
          rowBase: (url) => ({ url }),
          deadlineMs: overallDeadlineMs,
          concurrency: BRIDGE_CONCURRENCY,
        },
      );
      return viewResponse(view, envelope);
    },
  );
}
