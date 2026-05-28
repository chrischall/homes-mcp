import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import { registerByAddressTools } from '../../src/tools/by-address.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

/**
 * Parity contract for the resolver rungs.
 *
 * `homes_resolve_addresses` is the bulk sibling of `homes_get_by_address`.
 * Round-3 review (chrischall/homes-mcp#44) called for verifying that bulk
 * paths run the same rungs as their single counterparts — a bulk wrapper
 * that silently drops a fallback or surfaces a different error shape
 * makes the two tools subtly non-interchangeable.
 *
 * Contract pinned here:
 *
 *   1. Per-row resolution payload matches `homes_get_by_address` shape
 *      (with the documented `property_hash` → `property_id` rename so
 *      it lines up with `homes_bulk_get`).
 *   2. Empty / 404-style / JSON-LD-missing pages map to the same
 *      `'no listing found'` error string.
 *   3. **Transport failures degrade to the same canonical error string.**
 *      The single rung swallows the raw fetch error and returns
 *      `'no listing found'` so the unified canonical-URL caller can
 *      treat the row as "not on this site" rather than a system-level
 *      failure. The bulk rung must do the same — otherwise a network
 *      blip in one row of a 60-row batch leaks transport noise
 *      (`'network down'`, `'homes.com error: 503 ...'`) while a
 *      single-call retry would have returned a clean "not resolved".
 */

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

let single: Awaited<ReturnType<typeof createTestHarness>>;
let bulk: Awaited<ReturnType<typeof createTestHarness>>;

beforeAll(async () => {
  single = await createTestHarness((server) =>
    registerByAddressTools(server, mockClient)
  );
  bulk = await createTestHarness((server) =>
    registerResolveAddressesTools(server, mockClient)
  );
});
afterAll(async () => {
  await single?.close();
  await bulk?.close();
});
beforeEach(() => vi.clearAllMocks());

const detailHtml = (id: string, streetAddress: string) =>
  `<html><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['RealEstateListing', 'Product'],
        '@id': `https://www.homes.com/property/x/${id}/#realestatelisting`,
        url: `https://www.homes.com/property/x/${id}/`,
        mainEntity: { address: { streetAddress } },
      },
    ],
  })}</script></html>`;

const ADDRS = [
  { address: '1 Main St', city: 'Atlanta', state: 'GA' },
  { address: '2 Oak Ave', city: 'Atlanta', state: 'GA' },
  { address: '3 Pine Dr', city: 'Atlanta', state: 'GA' },
];

interface SingleOk {
  resolved: true;
  url: string;
  property_hash: string;
  street_address: string;
}
interface SingleFail {
  resolved: false;
  error: string;
}
type SingleResult = SingleOk | SingleFail;

interface BulkRow {
  address: string;
  city: string;
  state: string;
  zip?: string;
  resolved: boolean;
  url?: string;
  property_id?: string;
  street_address?: string;
  error?: string;
}
interface BulkResult {
  count: number;
  results: BulkRow[];
}

// Deterministic HTML factory keyed by request path. Lets us run the same
// upstream behaviour through both rungs and compare the partitions.
function htmlFor(path: string): string {
  if (path.startsWith('/1-main-st-'))
    return detailHtml('hash-1-main', '1 Main St');
  if (path.startsWith('/2-oak-ave-')) return '<html>no ld json</html>'; // unresolved
  if (path.startsWith('/3-pine-dr-'))
    return detailHtml('hash-3-pine', '3 Pine Dr');
  return '<html></html>';
}

describe('resolver rung parity: homes_resolve_addresses vs homes_get_by_address', () => {
  it('bulk partitions identically to a loop of single calls (success + unresolved)', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => htmlFor(path));

    // Loop single calls — this is the baseline the bulk path must match.
    const singles: SingleResult[] = [];
    for (const a of ADDRS) {
      const r = await single.callTool('homes_get_by_address', a);
      singles.push(parseToolResult<SingleResult>(r));
    }

    mockFetchHtml.mockClear();
    mockFetchHtml.mockImplementation(async (path: string) => htmlFor(path));

    const bulkResult = parseToolResult<BulkResult>(
      await bulk.callTool('homes_resolve_addresses', { addresses: ADDRS })
    );

    expect(bulkResult.count).toBe(ADDRS.length);
    expect(bulkResult.results).toHaveLength(singles.length);

    for (let i = 0; i < ADDRS.length; i++) {
      const s = singles[i];
      const b = bulkResult.results[i];
      // resolved-bit parity
      expect(b.resolved).toBe(s.resolved);
      if (s.resolved && b.resolved) {
        // Same upstream rung → same hash, same canonical URL,
        // same street_address — modulo the documented `property_hash`
        // → `property_id` field rename in the bulk shape.
        expect(b.url).toBe(s.url);
        expect(b.property_id).toBe(s.property_hash);
        expect(b.street_address).toBe(s.street_address);
      } else if (!s.resolved && !b.resolved) {
        expect(b.error).toBe(s.error);
      }
    }
  });

  it('bulk degrades transport errors to "no listing found" — same canonical string as single', async () => {
    // Single-call behaviour: fetch throws → returns the canonical
    // "no listing found" sentinel (see by-address.test.ts).
    mockFetchHtml.mockRejectedValueOnce(new Error('network down'));
    const sr = parseToolResult<SingleResult>(
      await single.callTool('homes_get_by_address', ADDRS[0])
    );
    expect(sr.resolved).toBe(false);
    if (!sr.resolved) expect(sr.error).toBe('no listing found');

    // Bulk must match — otherwise the bulk path leaks transport
    // noise that a per-row retry through `homes_get_by_address`
    // would have hidden, breaking the "use bulk for ≥ 3" guidance.
    mockFetchHtml
      .mockResolvedValueOnce(detailHtml('hash-1-main', '1 Main St'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(detailHtml('hash-3-pine', '3 Pine Dr'));

    const br = parseToolResult<BulkResult>(
      await bulk.callTool('homes_resolve_addresses', { addresses: ADDRS })
    );

    expect(br.results[0].resolved).toBe(true);
    expect(br.results[1].resolved).toBe(false);
    expect(br.results[1].error).toBe('no listing found');
    expect(br.results[2].resolved).toBe(true);
  });
});
