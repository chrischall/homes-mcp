import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from '@fetchproxy/server';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  resolveOneAddress,
  type ByAddressInput,
} from './by-address.js';
import { RESOLVE_DEADLINE_MS, withDeadline } from './deadline.js';

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

export { RESOLVE_DEADLINE_MS } from './deadline.js';

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
  matched_via?: 'slug' | 'search_fallback';
  error?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function registerResolveAddressesTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_resolve_addresses',
    {
      title: 'Bulk-resolve street addresses to homes.com property URLs',
      description:
        "Resolve up to 100 street addresses to canonical homes.com property URLs + opaque property hashes in one call. Pass `addresses: [{ address, city, state, zip? }, ...]`. Fans out to the same rungs `homes_get_by_address` runs (slug → city/zip search fallback with street-token fuzzy match). Per-row outcomes parallel `homes_get_by_address` (with `property_hash` renamed to `property_id` here so the field name lines up with `homes_bulk_get`): `{ resolved: true, url, property_id, street_address, matched_via }` on success — `matched_via` is `'slug'` or `'search_fallback'` — `{ resolved: false, error }` otherwise; one bad row won't fail the whole call. Results preserve input order. Use this instead of looping `homes_get_by_address` for any batch ≥ 3. Read-only; safe to call repeatedly.",
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
      // it the way barrier-synced chunks would — and each new dispatch is
      // staggered by a short beat so a 60-address batch can't stampede
      // the bridge into timeouts (round-3 #78). The whole sweep races the
      // overall deadline: on timeout we return whatever's settled so far,
      // with the rest left as their seeded `'pending'` markers.
      const fanOut = (async () => {
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < ts.length) {
            const index = cursor++;
            if (index > 0) await sleep(DISPATCH_PACING_MS);
            await resolveInto(index);
          }
        };
        const workers = Array.from(
          { length: Math.min(BRIDGE_CONCURRENCY, ts.length) },
          () => worker()
        );
        await Promise.all(workers);
      })();

      await withDeadline(fanOut, RESOLVE_DEADLINE_MS);

      return textResult({
        count: rows.length,
        results: rows,
      });
    }
  );
}
