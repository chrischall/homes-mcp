import { withDeadline } from '@chrischall/mcp-utils/fetchproxy';
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
 * 0.10.0 integration: the transport half of this probe loop — run the
 * probe fetch, time it, classify any error, and project the post-probe
 * bridge counters — lives in `@fetchproxy/server`'s `runProbe` (surfaced
 * through the client). This tool keeps the registration, the rich
 * homes-shaped error block, the probe `status` / `body_length`, the
 * `last_extension_message_at` liveness field, and the plain-English hint.
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

/**
 * Hard probe deadline for `homes_healthcheck` (#66).
 *
 * The transport's per-request `fetchTimeoutMs` defaults to ~30s, and a
 * one-shot lazy-revive retry on SW eviction can stack that to ~60s —
 * so without a shorter wrapper a wedged bridge / sleeping homes.com tab
 * leaves the probe hanging for up to ~2 minutes before it gives up. For
 * an *interactive* diagnostic that's far too long: a user staring at a
 * frozen call has no signal about what to do.
 *
 * Cap the probe at a short interactive budget so the failure mode is
 * fast and the actionable hint (open & interact with a homes.com portal
 * tab) surfaces in seconds rather than minutes. We still ride
 * fetchproxy's `withDeadline` helper (promoted from homes-mcp in
 * fetchproxy#86) and the server's `runProbe` loop — this just bounds the
 * probe fetch from above.
 */
export const HEALTHCHECK_PROBE_DEADLINE_MS = 18_000;

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
    return `Bridge is alive (role=${args.role}), but the probe didn't get a response within ${Math.round(HEALTHCHECK_PROBE_DEADLINE_MS / 1000)}s. The fix is almost always to wake the homes.com tab: open a homes.com portal tab in your browser, sign in if needed, and INTERACT with it (scroll or click) so the page becomes active — a loaded, signed-in, interacted tab is what unblocks the bridge. Then retry. If that doesn't help, the fetchproxy browser extension may not be connected to this MCP — open the extension popup and check for a green dot next to "homes-mcp".`;
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
      // 0.10.0+: the transport half of this probe loop — run the probe
      // fetch, measure elapsed ms, classify any thrown error, and project
      // the post-probe bridgeHealth() into the snake-cased `bridge` block
      // — lives in @fetchproxy/server's `runProbe` (surfaced through the
      // client). We hand it a probe closure and the probe path, and keep
      // the homes-specific extras (the rich typed-error block, the
      // body_length / status on the probe, last_extension_message_at, the
      // error_kind discriminator, and the plain-English hint) here.
      //
      // The closure does double duty: it captures the success body length
      // and re-throws the original typed error so we keep the *instance*
      // for the rich error block (runProbe only hands back {kind, message}).
      let bodyLength: number | undefined;
      let thrown: unknown;
      const probeResult = await client.runProbe(async (path) => {
        // #66: bound the probe fetch from above with a short interactive
        // deadline so a wedged bridge / sleeping homes.com tab fails fast
        // instead of riding the transport's ~30s fetchTimeoutMs (×2 with
        // lazy-revive ≈ up to ~2 min). `withDeadline` leaves the inner
        // fetch to settle in the background; we synthesize a
        // FetchproxyTimeoutError on the timeout arm so runProbe classifies
        // this exactly like a transport-level timeout (error_kind:
        // 'timeout') and the actionable open-&-interact hint fires.
        try {
          const outcome = await withDeadline(
            client.fetchHtml(path),
            HEALTHCHECK_PROBE_DEADLINE_MS
          );
          if (outcome.timedOut) {
            const { role, port } = client.bridgeStatus();
            throw new FetchproxyTimeoutError({
              url: `https://www.homes.com${path}`,
              timeoutMs: HEALTHCHECK_PROBE_DEADLINE_MS,
              role,
              port,
              elapsedMs: HEALTHCHECK_PROBE_DEADLINE_MS,
            });
          }
          bodyLength = outcome.value.length;
          return outcome.value;
        } catch (e) {
          thrown = e;
          throw e;
        }
      }, PROBE_PATH);

      const ok = probeResult.ok;
      const probe: HealthcheckResult['probe'] = {
        url: `https://www.homes.com${PROBE_PATH}`,
        elapsed_ms: probeResult.elapsed_ms,
        ...(ok
          ? // fetchHtml throws on non-2xx; reaching success means 2xx.
            { status: 200, body_length: bodyLength ?? 0 }
          : {}),
      };

      // Rich, homes-shaped error block built from the captured *instance*.
      // 0.8.0+: classifyBridgeError is the canonical discriminator —
      // enforces the parent-after-subclass ordering of the typed-error
      // hierarchy once at the dep boundary so we don't re-hand-roll an
      // `instanceof` ladder that's easy to get wrong (parent class before
      // subclass collapses the subclass arms onto 'protocol'). runProbe
      // already classified into probeResult.error.kind — we re-derive the
      // canonical BridgeError discriminator for the error_kind field.
      let error: HealthcheckResult['error'];
      let errorKind: BridgeError | undefined;
      if (!ok) {
        const e = thrown;
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
      }

      // runProbe's `bridge` projection covers the freshness counters but
      // not the 0.8.0 extension-liveness signal, so read that one field
      // from bridgeStatus() (post-probe, so it reflects this very call).
      const lastExtensionMessageAt =
        client.bridgeStatus().lastExtensionMessageAt;
      const b = probeResult.bridge;
      const result: HealthcheckResult = {
        ok,
        bridge: {
          role: b.role,
          port: b.port,
          server_version: b.server_version,
          fetch_timeout_ms: b.fetch_timeout_ms,
          last_success_at: b.last_success_at,
          last_failure_at: b.last_failure_at,
          last_failure_reason: b.last_failure_reason,
          consecutive_failures: b.consecutive_failures,
          last_extension_message_at: lastExtensionMessageAt,
        },
        probe,
        ...(errorKind !== undefined ? { error_kind: errorKind } : {}),
        ...(error ? { error } : {}),
        hint: hintFor({
          ok,
          role: b.role,
          errorKind: error?.kind,
        }),
      };
      return textResult(result);
    }
  );
}
