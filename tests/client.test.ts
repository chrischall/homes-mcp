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
    // Stand-in for the real transport's requestJson (which delegates to
    // @fetchproxy/server 0.10.0's requestJson): serialize the body, add
    // the Accept/Content-Type defaults, round-trip via the same handler,
    // and split the reply into { data, result } with 204/empty → null.
    // The client keeps its homes.com throwIfNotOk / sign-in guards over
    // `result`.
    requestJson: vi
      .fn()
      .mockImplementation(
        async (init: {
          path: string;
          method: 'GET' | 'POST' | 'PUT' | 'DELETE';
          headers?: Record<string, string>;
          body?: unknown;
        }) => {
          const isGet = init.method === 'GET';
          const sendBody = !isGet && init.body !== undefined;
          const result = await handler({
            path: init.path,
            method: init.method,
            headers: {
              Accept: 'application/json',
              ...(sendBody ? { 'Content-Type': 'application/json' } : {}),
              ...(init.headers ?? {}),
            },
            body: sendBody ? JSON.stringify(init.body) : undefined,
          });
          const data =
            result.status === 204 || result.body === ''
              ? null
              : JSON.parse(result.body);
          return { data, result };
        }
      ),
    status: vi.fn().mockReturnValue({
      role: 'host',
      port: 37149,
      serverVersion: '0.0.0',
      fetchTimeoutMs: 30_000,
    }),
    runProbe: vi.fn(),
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
