import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
  withDeadline,
} from '@chrischall/mcp-utils/fetchproxy';
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

/**
 * Per-row lifecycle marker. A row left `'pending'` when the overall
 * deadline fires never got a chance to finish — distinct from an error
 * row (a genuine per-row failure) so a caller can re-run just the
 * pending URLs in a follow-up batch. Mirrors `homes_resolve_addresses`'
 * `RowStatus` (#54).
 */
type RowStatus = 'ok' | 'pending' | 'error';

interface BulkRow {
  url: string;
  /** Row lifecycle marker — always present so callers never infer it. */
  status: RowStatus;
  property_id?: string;
  property?: FormattedProperty;
  error?: string;
}

export function registerBulkGetTools(
  server: McpServer,
  client: HomesClient,
  tuning: BulkGetTuning = {}
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? BULK_GET_DEADLINE_MS;
  server.registerTool(
    'homes_bulk_get',
    {
      title: 'Bulk-fetch homes.com properties (structured records only)',
      description:
        "Fetch up to 200 homes.com properties in one call and return their structured records. Pass `urls: string[]`. Results are ordered to match the input array and per-row errors are captured (one bad URL won't fail the whole call). Each row carries a `status` (`ok` / `error` / `pending`). Mirrors `homes_get_property` per-row, including `extracted_features`, `hoa_fee`, `highlights`, `schools`, `lot_size_sqft` + the derived `lot_size_acres` (null — never 0 — for condos / no-lot listings), and all standard listing fields. The raw `description` is omitted by default; opt back in via `include_description: true`. The whole call is bounded by an overall hard deadline: a single slow/hung URL never wedges the server — when the deadline is reached any unsettled row is returned with `status: \"pending\"` and a `pending` count so you can re-run just those URLs. Use this instead of looping `homes_compare_properties` (which caps at 8 + emits a redundant summary table) when you just want the records. Read-only; safe to call repeatedly.",
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
      // #54 partial-results contract (D1). Seed every row as `'pending'`
      // up front, then overwrite each in place as its fetch settles. If
      // the overall deadline fires before a row finishes, it stays
      // `'pending'` — so the caller always gets a full-length,
      // input-ordered array with a status for every URL, even when the
      // batch is too big / homes.com too slow to finish in time. A bulk
      // tool that wedges the whole MCP connection on a large input is
      // worse than one that returns "here's what I got, retry the rest".
      const rows: BulkRow[] = urls.map((url) => ({
        url,
        status: 'pending',
        error:
          'bulk_get overall deadline reached before this row settled — the ' +
          'request is still pending (likely a slow/hung sub-request). Re-run ' +
          'just the pending URLs; a single slow row no longer wedges the batch.',
      }));

      // Bounded fan-out via @fetchproxy/server 0.9.x bulk helpers:
      // BRIDGE_CONCURRENCY (=6) caps in-flight requests so a wide
      // batch doesn't tip the bridge into timeouts (round-3 #78);
      // retryOnceOnTimeout absorbs the rotating-tab tax that hits
      // the first request to a stale tab; classifyRowError keeps
      // bridge timeouts / bridge-down distinct from real per-row
      // parse errors so a summary like "20/20 with 2 timeouts"
      // can't be confused with "20/20 with 2 missing listings".
      // Results are written into index-addressable slots so a partial
      // (deadline-cut) batch still reports every input URL in order.
      const indexed = urls.map((url, index) => ({ url, index }));
      const fanOut = mapWithConcurrency<{ url: string; index: number }, void>(
        indexed,
        BRIDGE_CONCURRENCY,
        async ({ url, index }) => {
          try {
            const { listing, html } = await retryOnceOnTimeout(() =>
              fetchListingRecord(client, { url })
            );
            const formatted = format(listing, html, {
              includeDescription: include_description,
            });
            rows[index] = {
              url,
              status: 'ok',
              property_id: formatted.property_id,
              property: formatted,
            };
          } catch (e) {
            rows[index] = {
              url,
              status: 'error',
              error: classifyRowError(e).message,
            };
          }
        }
      );

      // Race the whole fan-out against the overall hard deadline (D1). On
      // expiry the in-flight `fanOut` promise is abandoned (left to settle
      // in the background and ignored) — we do NOT await it, so a
      // permanently-hung row can't wedge the connection; its slot keeps
      // the seeded `'pending'` marker.
      await withDeadline(fanOut, overallDeadlineMs);

      const pending = rows.filter((r) => r.status === 'pending').length;
      const envelope: {
        count: number;
        pending?: number;
        results: BulkRow[];
      } = { count: rows.length, results: rows };
      if (pending > 0) envelope.pending = pending;
      return textResult(envelope);
    }
  );
}
