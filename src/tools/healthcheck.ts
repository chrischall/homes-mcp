import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  type BridgeError,
  classifyBridgeError,
  FetchproxyBridgeDownError,
  FetchproxyProtocolError,
  FetchproxyTimeoutError,
} from '../transport-fetchproxy.js';

/**
 * Round-trip a no-op request through the full bridge so the user can
 * tell — with ONE tool call, without needing a real search — whether:
 *
 *   - homes-mcp's WebSocket bridge is up (`bridge.role` non-null)
 *   - the fetchproxy browser extension is connected (request reaches
 *     a tab and a response comes back)
 *   - the active homes.com tab is responsive (the fetch resolved
 *     within the timeout)
 *
 * Probe target: `/robots.txt` on homes.com. It's small (~150 bytes),
 * public (no auth needed), and served from homes.com's edge — so a
 * failure here cleanly isolates the bridge from homes.com's own
 * auth/SSR pipeline. If `/robots.txt` round-trips OK but the real
 * search still hangs, the problem is downstream of fetchproxy
 * (homes.com redirecting on sign-in, WAF challenge, etc.); if
 * `/robots.txt` fails, the bridge or extension is the issue.
 *
 * 0.8.0 integration notes:
 *   - The `error_kind` field on the response uses the canonical
 *     `BridgeError` discriminator from `classifyBridgeError`
 *     (`'timeout' | 'bridge_down' | 'http' | 'protocol' | 'other'`).
 *     The legacy `error.kind` field is preserved for back-compat (it
 *     maps `'protocol'` → `'transport'` to keep the older JSON shape
 *     stable for any consumer that still reads it).
 *   - `role_at_failure` / `port_at_failure` / `elapsed_ms` on the
 *     error block are read directly off the typed-error instances
 *     (`err.role`, `err.port`, `err.elapsedMs` — added in 0.8.0).
 *     They reflect the bridge state at the moment of the throw, not
 *     a post-throw snapshot.
 *   - `error.bridge_hint` is the curated, upstream-supplied
 *     recovery hint shipped on `FetchproxyBridgeDownError.hint`. The
 *     dep owns the canonical wording so we don't paraphrase it.
 *   - `bridge.last_extension_message_at` is the extension-side
 *     liveness signal from `bridgeHealth()` — distinct from the
 *     user-visible success/failure counters.
 */

interface HealthcheckResult {
  ok: boolean;
  bridge: {
    role: 'host' | 'peer' | null;
    port: number;
    server_version: string;
    fetch_timeout_ms: number;
    /** Unix-ms timestamp of the last successful round-trip. `null` until the first success. */
    last_success_at: number | null;
    /** Unix-ms timestamp of the last failed round-trip. `null` until the first failure. */
    last_failure_at: number | null;
    /** Most recent failure reason. `null` until the first failure. */
    last_failure_reason: string | null;
    /** Count of failures since the last success (or process start, if none). */
    consecutive_failures: number;
    /**
     * 0.8.0+: timestamp of the most recent inner frame from the
     * extension (any kind). Useful as an "extension still answering?"
     * signal independent of whether *our* probe specifically succeeded.
     * `null` until the first frame arrives.
     */
    last_extension_message_at: number | null;
  };
  probe: {
    url: string;
    elapsed_ms: number;
    status?: number;
    body_length?: number;
  };
  /**
   * Canonical discriminator from `classifyBridgeError`. Present on
   * both success (`'other'` would be wrong, so this field is only
   * meaningful when `ok === false`; omitted on success).
   */
  error_kind?: BridgeError;
  error?: {
    /**
     * Back-compat error kind. `'transport'` corresponds to the new
     * `error_kind: 'protocol'` (bare FetchproxyProtocolError). Prefer
     * `error_kind` for new code.
     */
    kind: 'timeout' | 'transport' | 'bridge_down' | 'other';
    message: string;
    /** Bridge role at the moment the typed error was thrown. */
    role_at_failure?: 'host' | 'peer' | null;
    /** 0.8.0+: bridge port at the moment of the throw (read from `err.port`). */
    port_at_failure?: number;
    /** 0.8.0+: actual elapsed ms when a `timeout` error fires (read from `err.elapsedMs`). */
    elapsed_ms?: number;
    /**
     * 0.8.0+: curated recovery hint shipped on
     * `FetchproxyBridgeDownError.hint`. Surfaces verbatim so the LLM
     * gets the upstream-canonical wording rather than our paraphrase.
     */
    bridge_hint?: string;
  };
  /** Plain-English next-step suggestion derived from the result. */
  hint: string;
}

const PROBE_PATH = '/robots.txt';

function hintFor(args: {
  ok: boolean;
  role: 'host' | 'peer' | null;
  errorKind?: 'timeout' | 'transport' | 'bridge_down' | 'other';
}): string {
  if (args.ok) {
    return `Bridge round-tripped /robots.txt successfully. If real tools still hang, the problem is downstream of fetchproxy (homes.com redirecting on sign-in, AWS WAF challenge, etc.) — not the bridge.`;
  }
  // Order: specific error kinds first, then the generic role-based hint.
  // A FetchproxyBridgeDownError can fire with role=null (the bridge can
  // hand back the SW-eviction error before listen() has resolved); the
  // more-specific bridge_down hint must win over the generic
  // "never bound a role" message in that case.
  if (args.errorKind === 'bridge_down') {
    return `The fetchproxy browser extension's service worker is not responding even after homes-mcp's automatic lazy-revive retry. Chrome evicts extension service workers after ~30s idle by default. Wake it manually by clicking the fetchproxy extension icon in your browser toolbar, or open chrome://extensions and reload the fetchproxy extension. Then retry.`;
  }
  if (args.role === null) {
    return `The bridge never bound a role. listen() may have failed silently on startup. Check stderr from homes-mcp for an error during start, and confirm port ${37149} isn't blocked.`;
  }
  if (args.errorKind === 'timeout') {
    return `Bridge is alive (role=${args.role}), but the request didn't get a response in time. Either (a) the fetchproxy browser extension isn't connected to this MCP yet — open the extension popup and check for a green dot next to "homes-mcp", or (b) the signed-in homes.com tab is sleeping / closed. Open homes.com in your browser, then retry.`;
  }
  if (args.errorKind === 'transport') {
    return `The bridge returned a protocol error before any HTTP response. Most commonly: no homes.com tab is open, or the extension declined the request. Open homes.com, sign in, and retry.`;
  }
  return `Unexpected error — see the error.message field for details.`;
}

export function registerHealthcheckTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_healthcheck',
    {
      title: 'Verify the fetchproxy bridge end-to-end',
      description:
        "Round-trips a small public homes.com URL (/robots.txt) through the fetchproxy bridge and returns diagnostics: the bridge's role (host/peer/null), port, version, the elapsed round-trip time, and a plain-English hint that distinguishes 'bridge never came up' from 'extension not connected' from 'real homes.com-side problem'. Call this when a real homes.com tool times out and you want to know which hop failed. Read-only, no auth required.",
      annotations: {
        title: 'Verify the fetchproxy bridge end-to-end',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      // We read bridgeStatus() once at the bottom (after the probe) so
      // the freshness counters in the response include this very call.
      // Don't read it up front — that snapshot would be stale.
      const start = Date.now();
      let probe: HealthcheckResult['probe'] = {
        url: `https://www.homes.com${PROBE_PATH}`,
        elapsed_ms: 0,
      };
      let error: HealthcheckResult['error'];
      let errorKind: BridgeError | undefined;
      let ok = false;
      try {
        const html = await client.fetchHtml(PROBE_PATH);
        probe = {
          url: `https://www.homes.com${PROBE_PATH}`,
          elapsed_ms: Date.now() - start,
          status: 200, // fetchHtml throws on non-2xx; reaching here means 2xx
          body_length: html.length,
        };
        ok = true;
      } catch (e) {
        const elapsedMs = Date.now() - start;
        // 0.8.0+: classifyBridgeError is the canonical discriminator —
        // enforces the parent-after-subclass ordering of the typed-error
        // hierarchy once at the dep boundary so we don't re-hand-roll an
        // `instanceof` ladder that's easy to get wrong (parent class
        // before subclass collapses the subclass arms onto 'protocol').
        errorKind = classifyBridgeError(e);
        if (e instanceof FetchproxyTimeoutError) {
          // 0.8.0+: read role/port/elapsedMs directly off the error
          // (captured at throw time). Trumps a post-throw bridgeStatus()
          // snapshot, which can reflect later state changes.
          error = {
            kind: 'timeout',
            message: e.message,
            role_at_failure: e.role,
            port_at_failure: e.port,
            elapsed_ms: e.elapsedMs,
          };
        } else if (e instanceof FetchproxyBridgeDownError) {
          // 0.8.0+: also surface .hint — the upstream dep curates the
          // SW-eviction recovery wording, so the LLM should see it
          // verbatim rather than only our wrapper hint.
          error = {
            kind: 'bridge_down',
            message: e.message,
            role_at_failure: e.role,
            port_at_failure: e.port,
            bridge_hint: e.hint,
          };
        } else if (e instanceof FetchproxyProtocolError) {
          // Bare protocol error has no role/port/elapsed fields on it.
          // 'transport' is the legacy `error.kind` for this case;
          // `error_kind` separately carries 'protocol'.
          error = { kind: 'transport', message: e.message };
        } else {
          error = {
            kind: 'other',
            message: e instanceof Error ? e.message : String(e),
          };
        }
        probe = { ...probe, elapsed_ms: elapsedMs };
      }
      // Re-read after the probe — recordSuccess/recordFailure on the
      // transport just updated the counters, so this snapshot reflects
      // the freshest state including this very call.
      const postProbeBridge = client.bridgeStatus();
      const result: HealthcheckResult = {
        ok,
        bridge: {
          role: postProbeBridge.role,
          port: postProbeBridge.port,
          server_version: postProbeBridge.serverVersion,
          fetch_timeout_ms: postProbeBridge.fetchTimeoutMs,
          last_success_at: postProbeBridge.lastSuccessAt,
          last_failure_at: postProbeBridge.lastFailureAt,
          last_failure_reason: postProbeBridge.lastFailureReason,
          consecutive_failures: postProbeBridge.consecutiveFailures,
          last_extension_message_at: postProbeBridge.lastExtensionMessageAt,
        },
        probe,
        ...(errorKind !== undefined ? { error_kind: errorKind } : {}),
        ...(error ? { error } : {}),
        hint: hintFor({
          ok,
          role: postProbeBridge.role,
          errorKind: error?.kind,
        }),
      };
      return textResult(result);
    }
  );
}
