import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  buildAddressSearchPath,
  resolveListing,
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
        "Resolve up to 100 street addresses to canonical homes.com property URLs + opaque property hashes in one call. Pass `addresses: [{ address, city, state, zip? }, ...]`. Fans out to the same resolution path `homes_get_by_address` uses (slugify → fetch the location page → parse JSON-LD; handles both collection-redirect and detail-redirect shapes). Per-row outcomes mirror the singular tool: `{ resolved: true, url, property_id, street_address }` on success, `{ resolved: false, error }` otherwise — one bad row won't fail the whole call. Results preserve input order. Use this instead of looping `homes_get_by_address` for any batch ≥ 3. Read-only; safe to call repeatedly.",
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
      const rows: ResolveRow[] = await Promise.all(
        ts.map(async (input): Promise<ResolveRow> => {
          const path = buildAddressSearchPath(input);
          let html: string;
          try {
            html = await client.fetchHtml(path);
          } catch (e) {
            return {
              ...input,
              resolved: false,
              error: (e as Error).message,
            };
          }
          const result = resolveListing(html);
          if (result.resolved) {
            return {
              ...input,
              resolved: true,
              url: result.url,
              property_id: result.property_hash,
              street_address: result.street_address,
            };
          }
          return {
            ...input,
            resolved: false,
            error: result.error,
          };
        })
      );
      return textResult({
        count: rows.length,
        results: rows,
      });
    }
  );
}
