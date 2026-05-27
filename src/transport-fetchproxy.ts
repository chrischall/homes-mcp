// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// homes-mcp's HomesTransport interface.
//
// What this layer DOES instrument (boundary visibility):
//   - The `role` (host vs peer) the FetchproxyServer landed in after
//     `listen()`. Logged once to stderr on startup.
//   - Per-request timing around `this.inner.fetch(...)` when
//     HOMES_DEBUG=1 is set in the env.
//   - The timeout error carries the role, port, elapsed ms, and the
//     failed URL so the user can tell "bridge never came up" apart
//     from "single request stalled in flight."
//
// What this layer CAN'T instrument (lives upstream in
// https://github.com/chrischall/fetchproxy):
//   - Service worker wake-up + message-listener binding
//   - Content-script injection on the active tab
//   - Tab selection (which homes.com tab the SW picked)
//   - The window.fetch() that actually runs in the page
// If you need that level of detail, file an issue / PR upstream — the
// hooks would need to land in the @fetchproxy/server protocol.

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

const HOMES_ORIGIN = 'https://www.homes.com';
const HOMES_TAB_URL = 'https://www.homes.com/';

// Generous deadline for a Homes SSR response; the bridge has no
// native timeout, so a frozen tab / dropped extension would otherwise
// hang the MCP call indefinitely.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_PORT = 37_149;

// #29 lazy-revive: when the SW is content_script_unreachable, wait
// briefly and retry once. The inbound message itself usually wakes the
// SW; 2s gives the extension time to bind its message listener again
// before we ask. Configurable via constructor opt for tests.
const DEFAULT_BRIDGE_REVIVAL_DELAY_MS = 2_000;

const DEBUG = process.env.HOMES_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[homes-mcp:bridge]', ...args);
}

/**
 * Thrown when the upstream extension's service worker is unreachable.
 * Distinct from `FetchproxyTimeoutError` (no response within timeout)
 * and from a generic transport `Error` (any other ok:false reason).
 * Carries the same role/port/elapsed diagnostic surface so callers
 * can show users one consistent failure shape.
 */
export class FetchproxyBridgeDownError extends Error {
  readonly url: string;
  readonly elapsedMs: number;
  readonly role: 'host' | 'peer' | null;
  readonly port: number;
  readonly originalError: string;
  readonly hint: string;

  constructor(args: {
    url: string;
    elapsedMs: number;
    role: 'host' | 'peer' | null;
    port: number;
    originalError: string;
  }) {
    const hint =
      `the fetchproxy browser extension's service worker is not ` +
      `responding ("${args.originalError}"). Chrome evicts extension ` +
      `service workers after ~30s idle by default, and homes-mcp has ` +
      `already retried once with a short delay (lazy-revive). To wake ` +
      `the SW manually, click the fetchproxy extension icon in your ` +
      `browser toolbar, or open chrome://extensions and reload the ` +
      `fetchproxy extension. Then retry the tool call.`;
    super(
      `fetchproxy bridge down: ${args.url} after ${args.elapsedMs}ms ` +
        `(role=${args.role ?? 'null'} port=${args.port}). ${hint}`
    );
    this.name = 'FetchproxyBridgeDownError';
    this.url = args.url;
    this.elapsedMs = args.elapsedMs;
    this.role = args.role;
    this.port = args.port;
    this.originalError = args.originalError;
    this.hint = hint;
  }
}

/**
 * Thrown when a request didn't get a response within `fetchTimeoutMs`.
 * Carries enough diagnostic context to distinguish:
 *   - bridge never came up (`role` = null, time elapsed ≈ timeout)
 *   - bridge came up but no extension connected yet
 *   - bridge + extension connected, single request stalled
 */
export class FetchproxyTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly role: 'host' | 'peer' | null;
  readonly port: number;
  readonly hint: string;

  constructor(args: {
    url: string;
    timeoutMs: number;
    elapsedMs: number;
    role: 'host' | 'peer' | null;
    port: number;
  }) {
    const hint =
      args.role === null
        ? `the bridge never bound role on startup — listen() may have failed before this request fired. Check stderr from homes-mcp's startup banner.`
        : `bridge is role=${args.role} on port ${args.port}, so the WebSocket side is up; the request reached the bridge but no upstream response arrived within ${args.timeoutMs}ms. Most common causes: (a) the fetchproxy browser extension isn't connected to this MCP yet (check the extension popup for a green dot next to "homes-mcp"), (b) the signed-in homes.com tab is sleeping or was navigated away from before the request resolved, (c) the upstream homes.com fetch itself is hanging on a login redirect or behavioral challenge.`;
    super(
      `fetchproxy: ${args.url} did not respond within ${args.timeoutMs}ms ` +
        `(elapsed ${args.elapsedMs}ms; bridge role=${args.role ?? 'null'} port=${args.port}). ` +
        hint
    );
    this.name = 'FetchproxyTimeoutError';
    this.url = args.url;
    this.timeoutMs = args.timeoutMs;
    this.elapsedMs = args.elapsedMs;
    this.role = args.role;
    this.port = args.port;
    this.hint = hint;
  }
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'homes-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
  /** Per-request timeout in ms. Default 30s. */
  fetchTimeoutMs?: number;
  /**
   * Delay before the SW lazy-revive retry fires (#29). The first
   * inbound request usually wakes the SW; this delay gives the
   * extension time to re-bind its message listener. Default 2s.
   */
  bridgeRevivalDelayMs?: number;
}

export class FetchproxyTransport implements HomesTransport {
  private readonly inner: FetchproxyServer;
  private readonly fetchTimeoutMs: number;
  private readonly bridgeRevivalDelayMs: number;
  private readonly port: number;
  private readonly serverVersion: string;
  // Freshness counters surfaced through `status()` so `homes_healthcheck`
  // can answer "is this bridge healthy or limping along?". Reset by a
  // success, not by close()/start() — we want a process-wide history.
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureReason: string | null = null;
  private consecutiveFailures = 0;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'homes-mcp',
      version: opts.version,
      // Subdomains of homes.com (www, photos, etc.) match automatically.
      domains: ['homes.com'],
    };
    this.inner = new FetchproxyServer(options);
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.bridgeRevivalDelayMs =
      opts.bridgeRevivalDelayMs ?? DEFAULT_BRIDGE_REVIVAL_DELAY_MS;
  }

  async start(): Promise<void> {
    log('listen start', { port: this.port, version: this.serverVersion });
    await this.inner.listen();
    // Stderr-only — stdio MCP transports reserve stdout for JSON-RPC.
    console.error(
      `[homes-mcp:bridge] listening on 127.0.0.1:${this.port} ` +
        `(role=${this.inner.role ?? 'unknown'}, version=${this.serverVersion})`
    );
  }

  async close(): Promise<void> {
    log('close');
    return this.inner.close();
  }

  /**
   * Diagnostic snapshot of the bridge. Safe to call before `start()` —
   * `role` will be null until `listen()` resolves; freshness counters
   * are null/0 until the first request fires.
   */
  status(): BridgeStatus {
    return {
      role: this.inner.role,
      port: this.port,
      serverVersion: this.serverVersion,
      fetchTimeoutMs: this.fetchTimeoutMs,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private recordSuccess(): void {
    this.lastSuccessAt = Date.now();
    this.consecutiveFailures = 0;
  }

  private recordFailure(reason: string): void {
    this.lastFailureAt = Date.now();
    this.lastFailureReason = reason;
    this.consecutiveFailures += 1;
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${HOMES_ORIGIN}${init.path}`;

    // #29: try once; on content_script_unreachable, wait briefly +
    // try again. Most "first call after Chrome evicted the SW" cases
    // heal on the second attempt because the message itself wakes
    // the SW. Failures of any other kind (no_tab, tab_fetch_failed,
    // timeout) skip the retry — they're not SW-eviction failures.
    const first = await this.attemptFetch(url, init);
    if (first.kind === 'ok') return first.value;
    if (first.kind === 'sw_down') {
      log('fetch:sw-down — waiting then retrying once', {
        url,
        delayMs: this.bridgeRevivalDelayMs,
      });
      await sleep(this.bridgeRevivalDelayMs);
      const second = await this.attemptFetch(url, init);
      if (second.kind === 'ok') return second.value;
      // Both attempts came back unreachable / errored — surface the
      // typed bridge-down error from the second attempt's diagnostics.
      throw second.error;
    }
    throw first.error;
  }

  /**
   * Single attempt — returns either an ok-result, a sw_down marker
   * (carrying the error to throw if no retry is possible), or a
   * generic error for any other failure (timeout, transport, ok:false
   * with a different kind). The caller in `fetch()` decides whether
   * to retry.
   */
  private async attemptFetch(
    url: string,
    init: FetchInit
  ): Promise<
    | { kind: 'ok'; value: FetchResult }
    | { kind: 'sw_down'; error: Error }
    | { kind: 'error'; error: Error }
  > {
    const start = Date.now();
    log('fetch:start', {
      method: init.method,
      url,
      role: this.inner.role,
      port: this.port,
    });
    const inner = this.inner.fetch({
      url,
      method: init.method,
      tabUrl: HOMES_TAB_URL,
      headers: init.headers,
      body: init.body,
    });
    inner.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result;
    try {
      result = await Promise.race([
        inner,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const elapsed = Date.now() - start;
            log('fetch:timeout', { url, elapsed, role: this.inner.role });
            const err = new FetchproxyTimeoutError({
              url,
              timeoutMs: this.fetchTimeoutMs,
              elapsedMs: elapsed,
              role: this.inner.role,
              port: this.port,
            });
            this.recordFailure(`timeout: ${url}`);
            reject(err);
          }, this.fetchTimeoutMs);
        }),
      ]);
    } catch (e) {
      // Timeouts surface as throws from the race; pass them up.
      return { kind: 'error', error: e as Error };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const elapsed = Date.now() - start;
    if (!result.ok) {
      log('fetch:bridge-error', { url, elapsed, error: result.error });
      this.recordFailure(result.error);
      if (result.kind === 'content_script_unreachable') {
        const err = new FetchproxyBridgeDownError({
          url,
          elapsedMs: elapsed,
          role: this.inner.role,
          port: this.port,
          originalError: result.error,
        });
        return { kind: 'sw_down', error: err };
      }
      return {
        kind: 'error',
        error: new Error(
          `fetchproxy transport error after ${elapsed}ms (role=${this.inner.role ?? 'null'}): ${result.error}`
        ),
      };
    }
    log('fetch:done', {
      url,
      elapsed,
      status: result.status,
      bodyLen: result.body.length,
    });
    this.recordSuccess();
    return {
      kind: 'ok',
      value: { status: result.status, body: result.body, url: result.url },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
