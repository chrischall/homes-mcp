import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { runBoundedBatch } from "@chrischall/mcp-utils";
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from "@chrischall/mcp-utils/fetchproxy";
import type { HomesClient } from "../client.js";
import { minifiedResult } from "../mcp.js";
import {
  ResolveAbortedError,
  isBlockedError,
  resolveOneAddress,
  type ByAddressInput,
} from "./by-address.js";

/**
 * Overall deadline for a whole `homes_resolve_addresses` fan-out (#54).
 * Below the MCP SDK's default 60s request timeout so the handler always
 * wins the race and can return partial rows, rather than the client
 * tearing the connection down first with a `-32001`.
 *
 * The deadline + bounded pool is mcp-utils' `runBoundedBatch`; only this
 * homes-specific deadline value stays here.
 */
export const RESOLVE_DEADLINE_MS = 50_000;

/**
 * `homes_resolve_addresses` — batch sibling of `homes_get_by_address`
 * (#24). Real-world session had 60 addresses across two sessions;
 * resolving them singly was ~15 calls + manual matching. Batch
 * collapses that to one round trip.
 *
 * Each row carries the original address fields plus `{ resolved,
 * status, url?, property_id?, error? }`. Per-row order matches input
 * order so the caller can map a parallel `addresses[]` array onto
 * results without re-keying.
 */

const MAX_ADDRESSES = 100;

/**
 * Milliseconds to pace between dispatching successive rows of the
 * fan-out (#54). The bridge tips into timeouts when a large batch
 * stampedes it; staggering each dispatch by a short beat smooths the
 * load on the user's single browser tab without meaningfully slowing a
 * batch that's already bounded by `BRIDGE_CONCURRENCY` in-flight.
 */
const DISPATCH_PACING_MS = 150;

/**
 * Per-row lifecycle marker (#54). A row left `'pending'` when the
 * overall deadline fires never got a chance to finish — distinct from
 * `'unresolved'` (homes.com genuinely had no match) so a caller can
 * retry the pending rows in a follow-up batch rather than treating them
 * as "not on homes.com".
 */
type RowStatus = "resolved" | "unresolved" | "pending" | "blocked";

interface ResolveRow extends ByAddressInput {
  resolved: boolean;
  status: RowStatus;
  url?: string;
  property_id?: string;
  street_address?: string;
  matched_via?: "typeahead" | "slug" | "search_fallback";
  error?: string;
}

/**
 * Pacing delay between dispatches. `unref`s its timer so that once the
 * overall deadline has fired and the response is serialized, the workers
 * still mid-loop in the background can't keep the event loop alive
 * stepping every `DISPATCH_PACING_MS`.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && typeof t.unref === "function") t.unref();
  });

export function registerResolveAddressesTools(
  server: McpServer,
  client: HomesClient,
): void {
  server.registerTool(
    "homes_resolve_addresses",
    {
      title: "Bulk-resolve street addresses to homes.com property URLs",
      description:
        "Resolve up to 100 street addresses to canonical homes.com property URLs + opaque property hashes in one call. Pass `addresses: [{ address, city, state, zip? }, ...]`. Fans out to the same rungs `homes_get_by_address` runs (structured smartsearch typeahead → slug → city/zip search fallback), verifying each candidate with the same whole-token street + unit match. Per-row outcomes parallel `homes_get_by_address` (with `property_hash` renamed to `property_id` here so the field name lines up with `homes_bulk_get`): `{ resolved: true, url, property_id, street_address, matched_via }` on success — `matched_via` is `'typeahead'`, `'slug'`, or `'search_fallback'` — `{ resolved: false, error }` otherwise; one bad row won't fail the whole call. Each row's `status` is `resolved`, `unresolved`, `pending` (deadline reached — retry it) or `blocked` (homes.com returned a sign-in / AWS WAF challenge or HTTP 403/429 — not a miss; clear the challenge in the browser and retry). Results preserve input order. Use this instead of looping `homes_get_by_address` for any batch ≥ 3. Read-only; safe to call repeatedly.",
      annotations: {
        title: "Bulk-resolve street addresses to homes.com property URLs",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        addresses: z
          .array(
            z
              .object({
                address: z.string(),
                city: z.string(),
                state: z.string(),
                zip: z.string().optional(),
                price_min: z.number().nonnegative().optional(),
                price_max: z.number().nonnegative().optional(),
              })
              .passthrough(),
          )
          .min(1)
          .max(MAX_ADDRESSES)
          .describe(
            `Array of address records to resolve (1–${MAX_ADDRESSES} per call). Each must include street \`address\`, \`city\`, and 2-letter \`state\`; \`zip\` is optional but improves precision. Optional per-row \`price_min\` / \`price_max\` (USD) bound that row's city/zip search-fallback rung — same semantics as \`homes_get_by_address\` (must be non-negative, min <= max; an invalid band fails only that row).`,
          ),
      }),
    },
    async ({ addresses }) => {
      const ts = addresses as ByAddressInput[];

      // #54 partial-results contract via mcp-utils `runBoundedBatch`: at most
      // BRIDGE_CONCURRENCY (=6) rows in flight, the whole sweep raced against
      // RESOLVE_DEADLINE_MS, and every row still unsettled at the deadline
      // backfilled as `status: 'pending'` / `error: 'timeout'` — so the
      // caller always gets a full-length, input-ordered array.
      //
      // Bridge-specific behaviour vs the single-call tool:
      //
      //   1. `retryOnceOnTimeout` absorbs the rotating-tab tax.
      //   2. `rethrowBridgeErrors: true` lets fetchproxy timeouts /
      //      bridge-down errors surface distinctly via `classifyRowError`,
      //      so "60/60 with 3 timeouts" doesn't masquerade as "60/60 with 3
      //      missing listings". Non-fetchproxy transport errors still
      //      degrade to the canonical `'no listing found'` sentinel.
      //
      // Abort (chrischall/fleet-audit#132 / #1161): mcp-utils >= 2.12
      // `runBoundedBatch` stops dispatching once the deadline (or the
      // caller's cancel) fires, so the old worker-loop `!signal.aborted`
      // guards are gone. The batch signal still goes into
      // `resolveOneAddress`, which checks it before every rung — a
      // multi-request row stops mid-flight instead of finishing its rungs
      // through the user's browser tab after the call has returned.
      //
      // Row statuses stay homes' resolver vocabulary (`resolved` /
      // `unresolved` / `pending` / `blocked`) rather than realty-core's
      // `runRowBatch` ok/error-kind envelope: an `unresolved` row is a real
      // answer (homes.com has no match), not an error.
      const poolSize = Math.min(BRIDGE_CONCURRENCY, ts.length);
      let dispatched = 0;
      let nextRefillAt = 0;

      const rows = await runBoundedBatch<ByAddressInput, ResolveRow>(
        ts,
        async (input, signal) => {
          // Paced refills (round-3 #78): the pool fills up front, then each
          // later dispatch is spaced on a shared clock so freed workers
          // don't re-stampede the bridge on the same tick.
          if (dispatched++ >= poolSize) {
            const now = Date.now();
            const wait = Math.max(0, nextRefillAt - now);
            nextRefillAt = Math.max(now, nextRefillAt) + DISPATCH_PACING_MS;
            if (wait > 0) await sleep(wait);
          }
          const result = await retryOnceOnTimeout(() =>
            resolveOneAddress(client, input, {
              rethrowBridgeErrors: true,
              signal,
            }),
          );
          return result.resolved
            ? {
                ...input,
                resolved: true,
                status: "resolved",
                url: result.url,
                property_id: result.property_hash,
                street_address: result.street_address,
                matched_via: result.matched_via,
              }
            : {
                ...input,
                resolved: false,
                status: "unresolved",
                error: result.error,
              };
        },
        {
          deadlineMs: RESOLVE_DEADLINE_MS,
          concurrency: BRIDGE_CONCURRENCY,
          onTimeout: (input) => ({
            ...input,
            resolved: false,
            status: "pending",
            error: "timeout",
          }),
          onError: (input, _index, e) =>
            e instanceof ResolveAbortedError
              ? { ...input, resolved: false, status: "pending", error: "timeout" }
              : {
                  ...input,
                  resolved: false,
                  // #133: a sign-in / WAF challenge / 403 / 429 is not a miss.
                  status: isBlockedError(e) ? "blocked" : "unresolved",
                  error: classifyRowError(e).message,
                },
        },
      );

      return minifiedResult({
        count: rows.length,
        results: rows,
      });
    },
  );
}
