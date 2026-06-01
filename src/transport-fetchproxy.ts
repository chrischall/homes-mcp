// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// homes-mcp's HomesTransport interface.
//
// As of @fetchproxy/server 0.10.0, lazy-revive on Chrome MV3 service-
// worker eviction (default 2000ms), per-request timeouts (default
// 30000ms), and the proactive keep-alive ping interval (default
// 25000ms, fetchproxy#72) are all server defaults — we get them with
// zero configuration, so we only forward those options to the server
// when the caller overrides them. The convenience `request()` method throws typed
// `FetchproxyBridgeDownError` / `FetchproxyTimeoutError` on failure
// (both subclasses of `FetchproxyProtocolError`). Process-wide
// freshness counters are exposed via `bridgeHealth()` — homes-mcp's
// status() forwards them so the healthcheck tool keeps working.

import {
  FetchproxyServer,
  type FetchproxyServerOpts,
} from '@chrischall/mcp-utils/fetchproxy';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchInit,
  FetchResult,
  HomesTransport,
  JsonRequestInit,
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
} from '@chrischall/mcp-utils/fetchproxy';

const DEFAULT_PORT = 37_149;

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

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'homes-mcp',
      version: opts.version,
      // Subdomains of homes.com (www, photos, etc.) match automatically.
      domains: ['homes.com'],
      // 0.10.0 promotes keepAliveIntervalMs to a 25_000 default (fetchproxy
      // #72 — the round-3 #71 cohort showed every consumer was opting into
      // exactly this value, so the explicit opt-in is gone here and we rely
      // on the server default. Behavior-preserving.
      // 0.10.0 also defaults fetchTimeoutMs=30_000 and bridgeReviveDelayMs=
      // 2_000, so only forward overrides when the caller actually supplies one.
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
    // 0.9.0+: `bridgeHealth()` is the source of truth for the resolved
    // per-request timeout — the server tracks the value it actually
    // applies (override or built-in default), so we just forward it
    // through instead of re-resolving the default locally.
    const health = this.inner.bridgeHealth();
    return {
      role: health.role,
      port: health.port,
      serverVersion: this.serverVersion,
      fetchTimeoutMs: health.fetchTimeoutMs,
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

  async requestJson<T>(
    init: JsonRequestInit
  ): Promise<{ data: T | null; result: FetchResult }> {
    // 0.10.0+: `requestJson` owns serialization + Accept/Content-Type
    // header defaults + 204/empty-body → null + JSON.parse. It returns
    // BOTH the parsed `data` and the raw success-arm FetchResult so the
    // client can keep its homes.com-specific throwIfNotOk / sign-in
    // guards over `result`. Bridge failures still throw the typed errors
    // (FetchproxyBridgeDownError / FetchproxyTimeoutError) via request().
    const { data, result } = await this.inner.requestJson<T>(
      init.method,
      init.path,
      {
        subdomain: 'www',
        headers: init.headers,
        body: init.body,
      }
    );
    return {
      data,
      result: { status: result.status, body: result.body, url: result.url },
    };
  }

  /**
   * 0.10.0+: delegate the transport half of the healthcheck probe loop
   * to the server's `runProbe` — it runs `fetchFn`, measures elapsed ms,
   * classifies any thrown error, and projects post-probe `bridgeHealth()`
   * into the snake-cased `bridge` block. The tool registration and the
   * homes-specific hint text stay in src/tools/healthcheck.ts.
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
