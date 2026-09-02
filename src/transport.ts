// Transport-agnostic interface for the bridge that relays homes.com
// fetches through the user's real Chrome session.
//
// The default implementation in src/transport-fetchproxy.ts wraps
// @fetchproxy/server's FetchproxyServer (127.0.0.1:37149 WebSocket).
//
// HomesClient (src/client.ts) accepts any HomesTransport. Error
// mapping (non-2xx, sign-in interstitial, 204 → null) lives on the
// client, not the transport — every implementation only has to round-
// trip the request and return a {status, body, url} triple.

// The transport half of the healthcheck probe loop lives in
// @fetchproxy/server 0.10.0 (`runProbe`); re-export its result shape so
// the healthcheck tool can type the projection without reaching into the
// dep directly.
import type {
  BridgeHealth,
  BridgeProbeResult,
} from '@chrischall/mcp-utils/fetchproxy';
export type { BridgeProbeResult };

export interface FetchInit {
  /** Path-and-query relative to https://www.homes.com, e.g.
   *  `/atlanta-ga/` (search) or `/property/<slug>/<id>/` (detail). */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Serialized request body. JSON callers stringify before calling.
   *  Omitted for GETs. */
  body?: string;
}

export interface FetchResult {
  status: number;
  /** Response body as a string. Empty string for 204. */
  body: string;
  /** Final URL after redirects. Used for sign-in-page detection. */
  url: string;
}

/** Input to `HomesTransport.requestJson` — the body is unserialized. */
export interface JsonRequestInit {
  /** Path-and-query relative to https://www.homes.com. */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Raw request body. The transport `JSON.stringify`s it; GETs omit it. */
  body?: unknown;
}

/**
 * Diagnostic snapshot returned by `HomesTransport.status()`.
 *
 * This is @fetchproxy/server's `bridgeHealth()` shape verbatim (role, port,
 * freshness counters, `lastExtensionMessageAt`, and — 2.5.0+ — the
 * `session` extension-link block: `state` / `pairCode` /
 * `extensionConnected`). The shared `registerBridgeHealthcheckTool` in
 * @chrischall/mcp-utils consumes exactly this type, so aliasing rather than
 * re-declaring a local subset keeps homes from drifting behind new fields.
 */
export type BridgeStatus = BridgeHealth;

export interface HomesTransport {
  /** Bring the transport up. Idempotent. */
  start(): Promise<void>;

  /** Tear the transport down. Idempotent. */
  close(): Promise<void>;

  /** Round-trip one request through the bridge. Resolves to a result
   *  triple even for non-2xx statuses — the client maps HTTP errors. */
  fetch(init: FetchInit): Promise<FetchResult>;

  /**
   * Round-trip a JSON request and return BOTH the parsed `data` and the
   * raw `result` triple. The transport owns serialization +
   * `Accept`/`Content-Type` header defaults + 204/empty-body → `null` +
   * `JSON.parse` only; it does NOT assert HTTP status or look for a
   * sign-in interstitial — those guards are site-specific and stay on the
   * client, which runs them over `result`. The `body` here is the raw
   * (unserialized) value; the transport `JSON.stringify`s it. Bridge-level
   * failures still throw the typed errors.
   */
  requestJson<T>(
    init: JsonRequestInit
  ): Promise<{ data: T | null; result: FetchResult }>;

  /** Diagnostic snapshot of the bridge. Safe to call any time. */
  status(): BridgeStatus;

  /**
   * Run a single healthcheck probe through `fetchFn`, measure the
   * elapsed round-trip, classify any thrown error, and project the
   * post-probe bridge state into a snake-cased `bridge` sub-object. The
   * tool registration + the homes-specific hint text stay on the
   * consumer; this is just the transport half of the probe loop.
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult>;
}
