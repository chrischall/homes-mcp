// HomesClient unit tests — error mapping + sign-in detection. Homes
// has no stingray-style JSON envelope, so this client is intentionally
// simpler than the Redfin one.
import { describe, it, expect, vi } from 'vitest';
import {
  HomesClient,
  SessionNotAuthenticatedError,
} from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  HomesTransport,
} from '../src/transport.js';

function stubTransport(
  handler: (init: FetchInit) => Promise<FetchResult>
): HomesTransport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockImplementation(handler),
    status: vi.fn().mockReturnValue({
      role: 'host',
      port: 37149,
      serverVersion: '0.0.0',
      fetchTimeoutMs: 30_000,
    }),
  };
}

describe('HomesClient', () => {
  it('fetchHtml returns the body when transport replies 200', async () => {
    const client = new HomesClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>page</html>',
        url: 'https://www.homes.com/x',
      })),
    });
    expect(await client.fetchHtml('/x')).toBe('<html>page</html>');
  });

  it('fetchHtml throws SessionNotAuthenticatedError on /sign-in redirect', async () => {
    const client = new HomesClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>sign in form</html>',
        url: 'https://www.homes.com/sign-in',
      })),
    });
    await expect(client.fetchHtml('/favorites')).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError
    );
  });

  it('fetchHtml throws SessionNotAuthenticatedError on AWS WAF challenge', async () => {
    const client = new HomesClient({
      transport: stubTransport(async () => ({
        status: 200,
        body:
          '<html><head><script src="https://22af.edge.sdk.awswaf.com/x/y/challenge.js"></script></head></html>',
        url: 'https://www.homes.com/x',
      })),
    });
    await expect(client.fetchHtml('/x')).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError
    );
  });

  it('fetchHtml does NOT false-positive on a normal page mentioning awswaf.com in a large body', async () => {
    const big = 'x'.repeat(100_000) + 'awswaf.com challenge.js';
    const client = new HomesClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: big,
        url: 'https://www.homes.com/privacy',
      })),
    });
    await expect(client.fetchHtml('/privacy')).resolves.toBeDefined();
  });

  it('fetchHtml throws for non-2xx status', async () => {
    const client = new HomesClient({
      transport: stubTransport(async () => ({
        status: 500,
        body: 'oops',
        url: 'https://www.homes.com/x',
      })),
    });
    await expect(client.fetchHtml('/x')).rejects.toThrow(/500/);
  });

  it('fetchJson POSTs JSON and parses the reply', async () => {
    const client = new HomesClient({
      transport: stubTransport(async (init) => {
        expect(init.method).toBe('POST');
        const body = JSON.parse(String(init.body));
        return {
          status: 200,
          body: JSON.stringify({ echoed: body }),
          url: 'https://www.homes.com/x',
        };
      }),
    });
    const r = await client.fetchJson<{ echoed: { n: number } }>('/x', {
      method: 'POST',
      body: { n: 42 },
    });
    expect(r.echoed.n).toBe(42);
  });

  it('fetchJson returns null for 204', async () => {
    const client = new HomesClient({
      transport: stubTransport(async () => ({
        status: 204,
        body: '',
        url: 'https://www.homes.com/x',
      })),
    });
    expect(await client.fetchJson('/x', { method: 'POST', body: {} })).toBeNull();
  });
});
