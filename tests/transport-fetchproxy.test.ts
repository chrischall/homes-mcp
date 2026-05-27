// Adapter-level tests for FetchproxyTransport against @fetchproxy/server
// 0.8.0+. The lazy-revive retry, per-request timeout, and freshness
// counters live in the server itself now — we don't re-test them here.
// What this file covers is the homes-mcp-shaped surface: URL/subdomain
// routing, BridgeStatus mapping, error pass-through, and start/close.
import { describe, it, expect, vi } from 'vitest';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyTransport,
} from '../src/transport-fetchproxy.js';

type Inner = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  bridgeHealth: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function stubInner(role: 'host' | 'peer' | null = 'host'): Inner {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    bridgeHealth: vi.fn().mockReturnValue({
      role,
      port: 37149,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    }),
    role,
  };
}

function installInner(t: FetchproxyTransport, inner: Inner): void {
  // @ts-expect-error reach into the private field for unit testing
  t.inner = inner;
}

describe('FetchproxyTransport', () => {
  it('routes relative paths via subdomain=www (resolves to www.homes.com)', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: 'x',
      url: 'https://www.homes.com/home/40732555',
    });
    installInner(t, inner);

    await t.fetch({ path: '/home/40732555', method: 'GET' });
    expect(inner.request).toHaveBeenCalledWith('GET', '/home/40732555', {
      subdomain: 'www',
      headers: undefined,
      body: undefined,
    });
  });

  it('passes absolute URLs through; subdomain is harmless because server derives tabUrl from URL host', async () => {
    // 0.8.0+: server's request() ignores `subdomain` for absolute
    // paths and derives tabUrl from the URL host directly. So always
    // passing `subdomain: 'www'` is safe even for photos.homes.com
    // URLs — the server routes through a photos.homes.com tab, not www.
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: '',
      url: 'https://photos.homes.com/x',
    });
    installInner(t, inner);

    await t.fetch({ path: 'https://photos.homes.com/x', method: 'GET' });
    const call = inner.request.mock.calls[0];
    expect(call[0]).toBe('GET');
    expect(call[1]).toBe('https://photos.homes.com/x');
  });

  it('returns {status, body, url} from inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: 'hello',
      url: 'https://www.homes.com/x',
    });
    installInner(t, inner);

    const result = await t.fetch({ path: '/x', method: 'GET' });
    expect(result).toEqual({
      status: 200,
      body: 'hello',
      url: 'https://www.homes.com/x',
    });
  });

  it('forwards method, headers, and body through to inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 204,
      body: '',
      url: 'https://www.homes.com/api/x',
    });
    installInner(t, inner);

    await t.fetch({
      path: '/api/x',
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: '{"a":1}',
    });
    expect(inner.request).toHaveBeenCalledWith('POST', '/api/x', {
      subdomain: 'www',
      headers: { 'X-Test': '1' },
      body: '{"a":1}',
    });
  });

  // Pass-through of typed protocol errors — homes_healthcheck still
  // narrows on these instances, so we pin that they propagate unwrapped.
  it('propagates FetchproxyBridgeDownError from inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner('host');
    inner.request.mockRejectedValue(
      new FetchproxyBridgeDownError({
        originalError: 'Could not establish connection.',
        retryAttempted: true,
        op: 'fetch',
        url: 'https://www.homes.com/x',
      })
    );
    installInner(t, inner);
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyBridgeDownError
    );
  });

  it('propagates FetchproxyTimeoutError from inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner('peer');
    inner.request.mockRejectedValue(
      new FetchproxyTimeoutError({
        url: 'https://www.homes.com/slow',
        timeoutMs: 30_000,
      })
    );
    installInner(t, inner);
    await expect(t.fetch({ path: '/slow', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyTimeoutError
    );
  });

  it('propagates other protocol errors as plain throws', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockRejectedValue(new Error('no homes.com tab open'));
    installInner(t, inner);
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /no homes\.com tab open/
    );
  });

  it('start/close delegate to the inner FetchproxyServer', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    installInner(t, inner);

    await t.start();
    expect(inner.listen).toHaveBeenCalledTimes(1);

    await t.close();
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  it('status() projects bridgeHealth() into homes-mcp BridgeStatus shape', () => {
    const t = new FetchproxyTransport({
      version: '1.2.3',
      port: 37200,
      fetchTimeoutMs: 5_000,
    });
    const inner = stubInner('host');
    inner.bridgeHealth.mockReturnValue({
      role: 'host',
      port: 37200,
      lastSuccessAt: 111,
      lastFailureAt: 222,
      lastFailureReason: 'oops',
      consecutiveFailures: 3,
      lastExtensionMessageAt: 333,
    });
    installInner(t, inner);

    expect(t.status()).toEqual({
      role: 'host',
      port: 37200,
      serverVersion: '1.2.3',
      fetchTimeoutMs: 5_000,
      lastSuccessAt: 111,
      lastFailureAt: 222,
      lastFailureReason: 'oops',
      consecutiveFailures: 3,
    });
  });

  it('status().role reflects whatever role bridgeHealth() reports (null pre-listen)', () => {
    const t = new FetchproxyTransport({ version: '1.0.0' });
    const inner = stubInner(null);
    inner.bridgeHealth.mockReturnValue({
      role: null,
      port: 37149,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    });
    installInner(t, inner);
    expect(t.status().role).toBeNull();
  });
});
