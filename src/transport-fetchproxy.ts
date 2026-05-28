// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// homes-mcp's HomesTransport interface.
//
// As of @fetchproxy/server 0.9.0, lazy-revive on Chrome MV3 service-
// worker eviction (default 2000ms) and per-request timeouts (default
// 30000ms) are server defaults — we get them with zero configuration,
// so we only forward those options to the server when the caller
// overrides them. The convenience `request()` method throws typed
// `FetchproxyBridgeDownError` / `FetchproxyTimeoutError` on failure
// (both subclasses of `FetchproxyProtocolError`). Process-wide
// freshness counters are exposed via `bridgeHealth()` — homes-mcp's
// status() forwards them so the healthcheck tool keeps working.

import {
  FetchproxyServer,
  type FetchproxyServerOpts,
} from '@fetchproxy/server';
import type {
  BridgeStatus,
  FetchInit,
  FetchResult,
  HomesTransport,
} from './transport.js';

// Re-export the typed errors so consumers (e.g. healthcheck) can keep
// importing them from this module rather than reaching into the dep.
// 0.8.0+: `classifyBridgeError` is the canonical discriminator over the
// typed-error hierarchy — use it instead of a hand-rolled `instanceof`
// ladder (the parent/subclass ordering is easy to get wrong, and the
// helper enforces it once at the dep boundary).
export {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyProtocolError,
  FetchproxyHttpError,
  classifyBridgeError,
  type BridgeError,
} from '@fetchproxy/server';

const DEFAULT_PORT = 37_149;

// Homes-mcp keeps the historical default in BridgeStatus.fetchTimeoutMs
// so the healthcheck JSON stays stable; the server uses the same value
// as its built-in default.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'homes-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
  /** Per-request timeout in ms. Default 30s (server built-in). */
  fetchTimeoutMs?: number;
  /** Lazy-revive delay (ms) on SW eviction. Default 2s (server built-in). */
  bridgeReviveDelayMs?: number;
}

export class FetchproxyTransport implements HomesTransport {
  private readonly inner: FetchproxyServer;
  private readonly port: number;
  private readonly serverVersion: string;
  private readonly fetchTimeoutMs: number;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'homes-mcp',
      version: opts.version,
      // Subdomains of homes.com (www, photos, etc.) match automatically.
      domains: ['homes.com'],
      // fetchproxy#71 — keep SW resident across human-paced session gaps
      keepAliveIntervalMs: 25_000,
      // 0.9.0 defaults fetchTimeoutMs=30_000 and bridgeReviveDelayMs=2_000,
      // so only forward overrides when the caller actually supplies one.
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
      ...(opts.bridgeReviveDelayMs !== undefined
        ? { bridgeReviveDelayMs: opts.bridgeReviveDelayMs }
        : {}),
    };
    this.inner = new FetchproxyServer(options);
  }

  async start(): Promise<void> {
    await this.inner.listen();
    // Stderr-only — stdio MCP transports reserve stdout for JSON-RPC.
    console.error(
      `[homes-mcp:bridge] listening on 127.0.0.1:${this.port} ` +
        `(role=${this.inner.role ?? 'unknown'}, version=${this.serverVersion})`
    );
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /** Diagnostic snapshot of the bridge. Safe to call before start(). */
  status(): BridgeStatus {
    const health = this.inner.bridgeHealth();
    return {
      role: health.role,
      port: health.port,
      serverVersion: this.serverVersion,
      fetchTimeoutMs: this.fetchTimeoutMs,
      lastSuccessAt: health.lastSuccessAt,
      lastFailureAt: health.lastFailureAt,
      lastFailureReason: health.lastFailureReason,
      consecutiveFailures: health.consecutiveFailures,
      lastExtensionMessageAt: health.lastExtensionMessageAt,
    };
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    // 0.8.0+: `request()` throws FetchproxyBridgeDownError /
    // FetchproxyTimeoutError on bridge failures (both subclass
    // FetchproxyProtocolError). `subdomain` applies only to relative
    // paths; absolute paths self-describe their host, so it's safe to
    // always pass `subdomain: 'www'` even for https://photos.homes.com/x
    // — the server derives tabUrl from the URL host in that case.
    const response = await this.inner.request(init.method, init.path, {
      subdomain: 'www',
      headers: init.headers,
      body: init.body,
    });
    return { status: response.status, body: response.body, url: response.url };
  }
}
