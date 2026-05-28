import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
  withDeadline,
} from '@fetchproxy/server';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  resolveOneAddress,
  type ByAddressInput,
} from './by-address.js';

/**
 * Overall deadline for a whole `homes_resolve_addresses` fan-out (#54).
 * Below the MCP SDK's default 60s request timeout so the handler always
 * wins the race and can return partial rows, rather than the client
 * tearing the connection down first with a `-32001`.
 *
 * `withDeadline` itself now lives in `@fetchproxy/server` (promoted from
 * homes-mcp's local `src/tools/deadline.ts` in fetchproxy#86); only this
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
type RowStatus = 'resolved' | 'unresolved' | 'pending';

interface ResolveRow extends ByAddressInput {
  resolved: boolean;
  status: RowStatus;
  url?: string;
  property_id?: string;
  street_address?: string;
  matched_via?: 'typeahead' | 'slug' | 'search_fallback';
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
    if (typeof t === 'object' && typeof t.unref === 'function') t.unref();
  });

export function registerResolveAddressesTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_resolve_addresses',
    {
      title: 'Bulk-resolve street addresses to homes.com property URLs',
      description:
        "Resolve up to 100 street addresses to canonical homes.com property URLs + opaque property hashes in one call. Pass `addresses: [{ address, city, state, zip? }, ...]`. Fans out to the same rungs `homes_get_by_address` runs (structured smartsearch typeahead → slug → city/zip search fallback), verifying each candidate with the same whole-token street + unit match. Per-row outcomes parallel `homes_get_by_address` (with `property_hash` renamed to `property_id` here so the field name lines up with `homes_bulk_get`): `{ resolved: true, url, property_id, street_address, matched_via }` on success — `matched_via` is `'typeahead'`, `'slug'`, or `'search_fallback'` — `{ resolved: false, error }` otherwise; one bad row won't fail the whole call. Results preserve input order. Use this instead of looping `homes_get_by_address` for any batch ≥ 3. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Bulk-resolve street addresses to homes.com property URLs',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        addresses: z
          .array(
            z
              .object({
                address: z.string(),
                city: z.string(),
                state: z.string(),
                zip: z.string().optional(),
              })
              .passthrough()
          )
          .min(1)
          .max(MAX_ADDRESSES)
          .describe(
            `Array of address records to resolve (1–${MAX_ADDRESSES} per call). Each must include street \`address\`, \`city\`, and 2-letter \`state\`; \`zip\` is optional but improves precision.`
          ),
      },
    },
    async ({ addresses }) => {
      const ts = addresses as ByAddressInput[];

      // #54: partial-results contract. Seed every row as `'pending'`
      // up front, then overwrite each in place as its resolution
      // settles. If the overall deadline fires before a row finishes,
      // it stays `'pending'` with an `error: 'timeout'` marker — so the
      // caller always gets a full-length, input-ordered array with a
      // status for every address, even when the batch is too big /
      // homes.com too slow to finish in time. A bulk tool that wedges
      // the whole MCP connection on a large input is worse than one
      // that returns "here's what I got, retry the rest".
      const rows: ResolveRow[] = ts.map((input) => ({
        ...input,
        resolved: false,
        status: 'pending',
        error: 'timeout',
      }));

      // Resolve one address into its row slot. `resolveOneAddress` owns
      // the slug → fetch → parse → graceful "no listing found"
      // degradation for generic transport errors; we only reshape the
      // success row (renaming `property_hash` to `property_id` to line
      // up with `homes_bulk_get`).
      //
      // Bridge-specific behaviour vs the single-call tool:
      //
      //   1. `retryOnceOnTimeout` absorbs the rotating-tab tax.
      //   2. `rethrowBridgeErrors: true` lets fetchproxy timeouts /
      //      bridge-down errors surface distinctly via
      //      `classifyRowError`, so a summary like "60/60 with 3
      //      timeouts" doesn't masquerade as "60/60 with 3 missing
      //      listings". Non-fetchproxy transport errors still degrade
      //      to the canonical `'no listing found'` sentinel — the
      //      parity contract with the single tool is preserved for
      //      everything except fetchproxy bridge failures.
      const resolveInto = async (index: number): Promise<void> => {
        const input = ts[index];
        try {
          const result = await retryOnceOnTimeout(() =>
            resolveOneAddress(client, input, { rethrowBridgeErrors: true })
          );
          rows[index] = result.resolved
            ? {
                ...input,
                resolved: true,
                status: 'resolved',
                url: result.url,
                property_id: result.property_hash,
                street_address: result.street_address,
                matched_via: result.matched_via,
              }
            : {
                ...input,
                resolved: false,
                status: 'unresolved',
                error: result.error,
              };
        } catch (e) {
          rows[index] = {
            ...input,
            resolved: false,
            status: 'unresolved',
            error: classifyRowError(e).message,
          };
        }
      };

      // Bounded worker pool with paced dispatch (mirrors redfin/zillow).
      // A shared cursor keeps at most BRIDGE_CONCURRENCY (=6) fetches in
      // flight continuously — a slow row never starves the others behind
      // it the way barrier-synced chunks would. The pool fills up front
      // (so a healthy batch runs at full concurrency), then each worker's
      // *subsequent* dispatch is spaced through a shared "next allowed
      // dispatch" clock — so as fast rows free up workers, refills trickle
      // out ~DISPATCH_PACING_MS apart instead of re-stampeding the bridge
      // all at once (round-3 #78). The whole sweep races the overall
      // deadline: on timeout we return whatever's settled so far, with the
      // rest left as their seeded `'pending'` markers.
      const fanOut = (async () => {
        const poolSize = Math.min(BRIDGE_CONCURRENCY, ts.length);
        let cursor = poolSize; // first `poolSize` indices fill the pool
        let nextRefillAt = 0;
        const worker = async (firstIndex: number): Promise<void> => {
          await resolveInto(firstIndex);
          while (cursor < ts.length) {
            const index = cursor++;
            // Stagger refills on a shared clock so freed workers don't
            // all re-dispatch on the same tick.
            const now = Date.now();
            const wait = Math.max(0, nextRefillAt - now);
            nextRefillAt = Math.max(now, nextRefillAt) + DISPATCH_PACING_MS;
            if (wait > 0) await sleep(wait);
            await resolveInto(index);
          }
        };
        await Promise.all(
          Array.from({ length: poolSize }, (_, i) => worker(i))
        );
      })();

      await withDeadline(fanOut, RESOLVE_DEADLINE_MS);

      return textResult({
        count: rows.length,
        results: rows,
      });
    }
  );
}
