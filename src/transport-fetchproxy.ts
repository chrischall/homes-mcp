// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// homes-mcp's HomesTransport interface.
//
// As of @chrischall/mcp-utils 0.10.0, the FetchproxyServer construction +
// the start/close lifecycle + the per-verb passthroughs (fetch / requestJson /
// runProbe) that ~12 fetchproxy MCPs each hand-rolled are factored into
// `createFetchproxyTransport`. We delegate to its inner adapter and keep only
// what's homes-specific: the port/serverName/domain pins, the
// `defaultSubdomain: 'www'` choice (every relative homes.com path is served
// from www.homes.com), and the `requestJson` method-mapping (homes takes the
// method inside the init object; the adapter takes it positionally).
//
// 0.10.0 additions we lean on:
//   - `logListening: true` emits the canonical `[homes-mcp:bridge] listening …`
//     banner on `start()` (stderr) with the bridge's *resolved* port + role —
//     so we drop the hand-rolled `console.error` the adapter used to carry.
//   - `status()` returns `bridgeHealth()` with `serverVersion` additively
//     pinned to the `version` opt, so the snake-case `server_version` the
//     healthcheck consumes is sourced from the factory rather than a local
//     mirror. (homes_healthcheck reads it off `runProbe`'s `bridge` projection,
//     which the dep populates from the same `serverVersion`.)
//
// The verb adapters forward `FetchproxyServerOpts` verbatim, so the homes
// contract is intact — port 37149, fetchTimeoutMs / revive / keepAlive
// defaults from the server (0.10.0: keepAliveIntervalMs default too), and the
// typed FetchproxyBridgeDownError / FetchproxyTimeoutError thrown straight
// through on bridge failure.

import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyTransportAdapter,
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
  // createFetchproxyTransport owns the FetchproxyServer construction, the
  // start/close lifecycle (incl. the `logListening` banner), and the fetch /
  // requestJson / runProbe verb passthroughs (each with `defaultSubdomain:
  // 'www'` applied). We keep this thin class so the HomesTransport interface
  // (consumed by HomesClient and the session tools) stays stable.
  private readonly inner: FetchproxyTransportAdapter;

  constructor(opts: FetchproxyTransportOptions) {
    this.inner = createFetchproxyTransport({
      port: opts.port ?? DEFAULT_PORT,
      serverName: opts.server ?? 'homes-mcp',
      version: opts.version,
      // Subdomains of homes.com (www, photos, etc.) match automatically.
      domains: ['homes.com'],
      // Every relative homes.com path is served from www.homes.com — the verb
      // adapters apply this unless a per-call subdomain overrides it. Absolute
      // http(s):// paths self-describe their host and ignore it (so a
      // photos.homes.com URL still routes to the photos tab).
      defaultSubdomain: 'www',
      // 0.10.0: opt into the canonical startup banner the hand-rolled adapter
      // used to emit by hand. The factory logs it to **stderr** (stdout is the
      // MCP JSON-RPC channel) in the exact fleet format
      // `[homes-mcp:bridge] listening on 127.0.0.1:<port> (role=…, version=…)`,
      // sourcing <port> from the bridge's resolved `bridgeHealth()` after
      // listen(). Behavior-preserving.
      logListening: true,
      // keepAliveIntervalMs (fetchproxy#72) defaults to 25_000 as of 0.10.0,
      // and fetchTimeoutMs / bridgeReviveDelayMs default to 30_000 / 2_000 —
      // matching what homes would otherwise hardcode. Only forward when the
      // caller overrides.
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
      ...(opts.bridgeReviveDelayMs !== undefined
        ? { bridgeReviveDelayMs: opts.bridgeReviveDelayMs }
        : {}),
    });
  }

  start(): Promise<void> {
    // The factory's start() emits the `logListening` banner (stderr) after
    // listen() resolves — so no hand-rolled console.error here any more.
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /**
   * Diagnostic snapshot of the bridge. The adapter's `status()` returns
   * `bridgeHealth()` with `serverVersion` additively pinned to the `version`
   * opt — a superset of `BridgeStatus` (same field names), so it satisfies the
   * interface structurally. The `server_version` the healthcheck surfaces now
   * comes from the factory rather than a local mirror.
   */
  status(): BridgeStatus {
    return this.inner.status();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    // 0.8.0+: throws FetchproxyBridgeDownError / FetchproxyTimeoutError on
    // bridge failures (both subclass FetchproxyProtocolError). `defaultSubdomain:
    // 'www'` is applied by the adapter; absolute paths self-describe their host.
    return this.inner.fetch(init);
  }

  async requestJson<T>(
    init: JsonRequestInit
  ): Promise<{ data: T | null; result: FetchResult }> {
    // The adapter's requestJson(method, path, init) owns serialization,
    // header-defaults, 204 → null, and JSON.parse — returning BOTH the parsed
    // `data` and the raw success-arm `result` so the client keeps its
    // homes.com-specific throwIfNotOk / throwIfSignInPage guards over `result`.
    // homes's interface carries the method/path inside the init object; map
    // that onto the adapter's positional (method, path, init) signature.
    return this.inner.requestJson<T>(init.method, init.path, {
      headers: init.headers,
      body: init.body,
    });
  }

  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    // The probe loop + classification + post-probe bridgeHealth() projection
    // live in @fetchproxy/server's runProbe (the transport half of the
    // healthcheck the cohort hand-rolled). homes_healthcheck consumes this
    // through the client and keeps the homes-shaped error block + hint text.
    return this.inner.runProbe(fetchFn, probePath);
  }
}
