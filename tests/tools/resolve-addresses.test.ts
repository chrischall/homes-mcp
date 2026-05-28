import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from 'vitest';
import type { HomesClient } from '../../src/client.js';
import {
  registerResolveAddressesTools,
  RESOLVE_DEADLINE_MS,
} from '../../src/tools/resolve-addresses.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as HomesClient;

let h: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  h = await createTestHarness((server) =>
    registerResolveAddressesTools(server, mockClient)
  );
});
beforeEach(() => vi.clearAllMocks());
afterAll(async () => h?.close());

const detailHtml = (id: string, streetAddress: string) =>
  `<html><script type="application/ld+json">${JSON.stringify({
    '@graph': [
      {
        '@type': 'RealEstateListing',
        url: `https://www.homes.com/property/x/${id}/`,
        mainEntity: { address: { streetAddress } },
      },
    ],
  })}</script></html>`;

describe('homes_resolve_addresses', () => {
  it('resolves multiple addresses concurrently with input order preserved', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      const id = path.match(/^\/(.+?)\//)?.[1] ?? 'x';
      return detailHtml(id.replace(/-.*/, ''), `${id} ADDR`);
    });
    const r = await h.callTool('homes_resolve_addresses', {
      addresses: [
        { address: '1 Main St', city: 'Atlanta', state: 'GA' },
        { address: '2 Oak Ave', city: 'Atlanta', state: 'GA' },
        { address: '3 Pine Dr', city: 'Atlanta', state: 'GA' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      results: Array<{
        address: string;
        resolved: boolean;
        url?: string;
        property_id?: string;
      }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.results.map((row) => row.address)).toEqual([
      '1 Main St',
      '2 Oak Ave',
      '3 Pine Dr',
    ]);
    expect(parsed.results.every((row) => row.resolved)).toBe(true);
  });

  it('marks unresolved rows without failing the whole call', async () => {
    mockFetchHtml.mockImplementationOnce(async () => detailHtml('a1', '1 Main'))
      .mockImplementationOnce(async () => '<html>not a listing</html>')
      .mockImplementationOnce(async () => detailHtml('c3', '3 Pine'));
    const r = await h.callTool('homes_resolve_addresses', {
      addresses: [
        { address: '1 Main St', city: 'Atlanta', state: 'GA' },
        { address: 'bogus', city: 'Atlanta', state: 'GA' },
        { address: '3 Pine Dr', city: 'Atlanta', state: 'GA' },
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{
        address: string;
        resolved: boolean;
        url?: string;
        error?: string;
      }>;
    }>(r);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[1].resolved).toBe(false);
    expect(parsed.results[2].resolved).toBe(true);
  });

  it('captures transport errors per-row', async () => {
    mockFetchHtml.mockImplementationOnce(async () => detailHtml('a', '1 Main'))
      .mockImplementationOnce(async () => {
        throw new Error('network down');
      });
    const r = await h.callTool('homes_resolve_addresses', {
      addresses: [
        { address: '1 Main St', city: 'Atlanta', state: 'GA' },
        { address: '99 Lost St', city: 'Atlanta', state: 'GA' },
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{ resolved: boolean; error?: string }>;
    }>(r);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[1].resolved).toBe(false);
    // Transport failure surfaces as the canonical "no listing found"
    // sentinel — matches the singular get_by_address graceful-degradation
    // contract.
    expect(parsed.results[1].error).toBe('no listing found');
  });
});

// ── Overall deadline + partial results (#54) ──────────────────────────
//
// A 60-address batch hung ~4 min then killed the MCP connection because
// nothing capped total wall-clock below the client's request deadline.
// The handler now races the whole fan-out against `RESOLVE_DEADLINE_MS`
// and returns PARTIAL results — resolved-so-far rows plus per-row
// `status: 'pending'` / `error: 'timeout'` markers for everything still
// in flight — instead of hanging until the client gives up.
describe('homes_resolve_addresses overall deadline', () => {
  let dh: Awaited<ReturnType<typeof createTestHarness>>;
  const dlFetchHtml = vi.fn();
  const dlClient = { fetchHtml: dlFetchHtml } as unknown as HomesClient;

  beforeAll(async () => {
    dh = await createTestHarness((server) =>
      registerResolveAddressesTools(server, dlClient)
    );
  });
  afterAll(async () => dh?.close());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  interface DeadlineRow {
    address: string;
    resolved: boolean;
    status?: 'pending' | 'resolved' | 'unresolved';
    error?: string;
    property_id?: string;
  }
  interface DeadlineResult {
    count: number;
    results: DeadlineRow[];
  }

  const sixty = Array.from({ length: 60 }, (_, i) => ({
    address: `${i} Main St`,
    city: 'Atlanta',
    state: 'GA',
  }));

  it('returns within the deadline with partial timeout markers when every fetch hangs — never hangs the whole call', async () => {
    // Every fetch hangs forever — the worst case that wedged the
    // connection in the field report.
    dlFetchHtml.mockImplementation(() => new Promise<string>(() => {}));

    const call = dh.callTool('homes_resolve_addresses', { addresses: sixty });

    // Push past the overall deadline; the handler must settle.
    await vi.advanceTimersByTimeAsync(RESOLVE_DEADLINE_MS + 1000);
    const r = await call;

    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<DeadlineResult>(r);
    expect(parsed.count).toBe(60);
    expect(parsed.results).toHaveLength(60);
    // Every row is unresolved with a timeout marker — none resolved,
    // none left undefined, and crucially the call returned.
    expect(parsed.results.every((row) => row.resolved === false)).toBe(true);
    expect(parsed.results.every((row) => row.error === 'timeout')).toBe(true);
    expect(parsed.results.every((row) => row.status === 'pending')).toBe(true);
    // Input order preserved.
    expect(parsed.results.map((row) => row.address)).toEqual(
      sixty.map((a) => a.address)
    );
  });

  it('keeps rows that resolved before the deadline and marks the rest pending', async () => {
    // First 6 addresses resolve fast; everything else hangs forever.
    dlFetchHtml.mockImplementation((path: string) => {
      const num = Number(path.match(/^\/(\d+)-/)?.[1] ?? '999');
      if (num < 6) {
        return Promise.resolve(
          detailHtml(`hash${num}`, `${num} Main St`)
        );
      }
      return new Promise<string>(() => {});
    });

    const call = dh.callTool('homes_resolve_addresses', { addresses: sixty });

    // Let the fast rows settle, then trip the deadline.
    await vi.advanceTimersByTimeAsync(RESOLVE_DEADLINE_MS + 1000);
    const r = await call;

    const parsed = parseToolResult<DeadlineResult>(r);
    const resolved = parsed.results.filter((row) => row.resolved);
    const pending = parsed.results.filter((row) => !row.resolved);
    expect(resolved.length).toBe(6);
    expect(pending.length).toBe(54);
    expect(pending.every((row) => row.error === 'timeout')).toBe(true);
    // Resolved rows keep their payload.
    expect(resolved[0].property_id).toMatch(/^hash\d+$/);
  });
});
