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
import type { BridgeProbeResult } from '@chrischall/mcp-utils/fetchproxy';
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

/** Diagnostic snapshot returned by `HomesTransport.status()`. */
export interface BridgeStatus {
  /** Role the underlying server elected (host vs peer). `null` until `start()` resolves. */
  role: 'host' | 'peer' | null;
  /** The WebSocket port. Hosts bind it; peers tunnel through it. */
  port: number;
  /** MCP server version announced to the extension. */
  serverVersion: string;
  /** Default per-request timeout in ms. */
  fetchTimeoutMs: number;
  /** Unix-ms timestamp of the last successful round-trip. `null` until the first success. */
  lastSuccessAt: number | null;
  /** Unix-ms timestamp of the last failed round-trip. `null` until the first failure. */
  lastFailureAt: number | null;
  /** Short message describing the most recent failure. `null` until the first failure. */
  lastFailureReason: string | null;
  /** Number of failures since the last success (or since process start, if none). */
  consecutiveFailures: number;
  /**
   * 0.8.0+: wall-clock timestamp (Unix ms) of the most recent inner
   * frame received from the fetchproxy extension — regardless of
   * whether that frame was a success or error for the calling MCP.
   * Distinct from `lastSuccessAt`/`lastFailureAt`, which track
   * *user-visible* fetch outcomes. This is "is the extension still
   * answering?" liveness. `null` until the first frame arrives.
   */
  lastExtensionMessageAt: number | null;
}

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
