import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
} from '@fetchproxy/server';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  resolveOneAddress,
  type ByAddressInput,
} from './by-address.js';

/**
 * `homes_resolve_addresses` — batch sibling of `homes_get_by_address`
 * (#24). Real-world session had 60 addresses across two sessions;
 * resolving them singly was ~15 calls + manual matching. Batch
 * collapses that to one round trip.
 *
 * Each row carries the original address fields plus `{ resolved,
 * url?, property_id?, error? }`. Per-row order matches input order so
 * the caller can map a parallel `addresses[]` array onto results
 * without re-keying.
 */

const MAX_ADDRESSES = 100;

interface ResolveRow extends ByAddressInput {
  resolved: boolean;
  url?: string;
  property_id?: string;
  street_address?: string;
  matched_via?: 'slug' | 'search_fallback';
  error?: string;
}

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
      // Fan out via the same rung `homes_get_by_address` runs.
      // `resolveOneAddress` owns the slug → fetch → parse → graceful
      // "no listing found" degradation for generic transport errors;
      // we only reshape the success row (renaming `property_hash` to
      // `property_id` to line up with `homes_bulk_get`).
      //
      // Bulk-specific behaviour vs the single-call tool:
      //
      //   1. Bounded concurrency via `mapWithConcurrency` +
      //      BRIDGE_CONCURRENCY (=6). A 60-address batch fanning out
      //      unbounded tips the bridge into timeouts (round-3 #78).
      //   2. `retryOnceOnTimeout` absorbs the rotating-tab tax.
      //   3. `rethrowBridgeErrors: true` lets fetchproxy timeouts /
      //      bridge-down errors surface distinctly via
      //      `classifyRowError`, so a summary like "60/60 with 3
      //      timeouts" doesn't masquerade as "60/60 with 3 missing
      //      listings". Non-fetchproxy transport errors still
      //      degrade to the canonical `'no listing found'` sentinel
      //      — the parity contract with the single tool is preserved
      //      for everything except fetchproxy bridge failures, which
      //      are a system-level outcome the caller deserves to see.
      const rows: ResolveRow[] = await mapWithConcurrency(
        ts,
        BRIDGE_CONCURRENCY,
        async (input): Promise<ResolveRow> => {
          try {
            const result = await retryOnceOnTimeout(() =>
              resolveOneAddress(client, input, {
                rethrowBridgeErrors: true,
              })
            );
            if (result.resolved) {
              return {
                ...input,
                resolved: true,
                url: result.url,
                property_id: result.property_hash,
                street_address: result.street_address,
                matched_via: result.matched_via,
              };
            }
            return {
              ...input,
              resolved: false,
              error: result.error,
            };
          } catch (e) {
            return {
              ...input,
              resolved: false,
              error: classifyRowError(e).message,
            };
          }
        }
      );
      return textResult({
        count: rows.length,
        results: rows,
      });
    }
  );
}
