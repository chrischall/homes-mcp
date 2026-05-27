import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { HomesClient } from '../../src/client.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
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
    // Transport failure surfaces as "not resolved" — matches the
    // singular get_by_address graceful-degradation contract.
    expect(parsed.results[1].error).toBeDefined();
  });
});
