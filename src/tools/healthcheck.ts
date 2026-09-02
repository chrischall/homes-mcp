import {
  registerBridgeHealthcheckTool,
  withDeadline,
} from '@chrischall/mcp-utils/fetchproxy';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { FetchproxyTimeoutError } from '../transport-fetchproxy.js';

/**
 * `homes_healthcheck` — round-trip a no-op request through the full bridge
 * so the user can tell, with ONE tool call and no real search, whether:
 *
 *   - homes-mcp's WebSocket bridge is up (`bridge.role` non-null)
 *   - the fetchproxy browser extension is attached and paired
 *     (`bridge.session_state` / `pending_pair_code` / `extension_connected`,
 *     @fetchproxy/server 2.5.0+)
 *   - the active homes.com tab is responsive (the fetch resolved within
 *     the probe deadline)
 *
 * Probe target: `/robots.txt` on www.homes.com. It's small (~150 bytes),
 * public (no auth needed), and served from homes.com's edge — so a failure
 * here cleanly isolates the bridge from homes.com's own auth/SSR pipeline.
 * If `/robots.txt` round-trips OK but a real tool still hangs, the problem
 * is downstream of fetchproxy (sign-in redirect, AWS WAF challenge, …); if
 * `/robots.txt` fails, the bridge, the extension link, or the tab is the
 * issue.
 *
 * 0.20.0 integration: the tool registration, the result envelope, the
 * error classification (`error.kind`: `timeout` / `bridge_down` /
 * `session_not_ready` / `http` / `protocol` / `unknown`), and the hint
 * ladder all live in `@chrischall/mcp-utils/fetchproxy`'s
 * `registerBridgeHealthcheckTool`. homes keeps only its site-specific
 * bits: the probe path + host label, the short interactive probe
 * deadline inside `probeFn` (#66), a `classifyThrown` that files a timeout
 * hit while the extension link is not `linked` under `session_not_ready`
 * (the 18s deadline beats fetchproxy's 30s session-ready wait, so a
 * pending pair code would otherwise masquerade as a tab timeout), and the
 * hint copy that names homes.com / AWS WAF / the open-AND-interact
 * recovery step.
 *
 * Envelope (vs. the pre-0.20.0 hand-rolled tool): the top-level
 * `error_kind` is gone (`error.kind` IS the canonical discriminator now,
 * with `'protocol'` replacing the old `'transport'` and `'unknown'`
 * replacing `'other'`), and `error.role_at_failure` / `port_at_failure` /
 * `elapsed_ms` are dropped — the `bridge` block carries role/port and
 * `probe.elapsed_ms` carries the timing.
 */

const PROBE_PATH = '/robots.txt';
const HOST_LABEL = 'www.homes.com';

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
 * tab) surfaces in seconds rather than minutes. The deadline lives inside
 * `probeFn`, so it still rides the shared tool's `runProbe` loop — the
 * timeout arm just synthesizes a `FetchproxyTimeoutError` so the loop
 * classifies it exactly like a transport-level timeout.
 */
export const HEALTHCHECK_PROBE_DEADLINE_MS = 18_000;

const PROBE_DEADLINE_S = Math.round(HEALTHCHECK_PROBE_DEADLINE_MS / 1000);

export function registerHealthcheckTools(
  server: McpServer,
  client: HomesClient
): void {
  registerBridgeHealthcheckTool({
    server,
    prefix: 'homes',
    probePath: PROBE_PATH,
    hostLabel: HOST_LABEL,
    // The tool layer holds the client, whose transport is private; the
    // shared healthcheck only needs the two verbs the client already
    // surfaces from it (`runProbe` for the probe loop + post-probe bridge
    // projection, `status()` for the live `bridgeHealth()` snapshot).
    transport: {
      runProbe: (fetchFn, probePath) => client.runProbe(fetchFn, probePath),
      status: () => client.bridgeStatus(),
    },
    probeFn: async (path) => {
      // Bound the probe fetch from above with the short interactive
      // deadline. `withDeadline` leaves the inner fetch to settle in the
      // background; on the timeout arm we throw a FetchproxyTimeoutError
      // so the shared loop files it under `error.kind: 'timeout'` and the
      // open-&-interact hint below fires.
      const outcome = await withDeadline(
        client.fetchHtml(path),
        HEALTHCHECK_PROBE_DEADLINE_MS
      );
      if (outcome.timedOut) {
        const { role, port } = client.bridgeStatus();
        throw new FetchproxyTimeoutError({
          url: `https://${HOST_LABEL}${path}`,
          timeoutMs: HEALTHCHECK_PROBE_DEADLINE_MS,
          role,
          port,
          elapsedMs: HEALTHCHECK_PROBE_DEADLINE_MS,
        });
      }
      return outcome.value;
    },
    // A timeout while the extension link is NOT established is not a tab
    // problem: the 18s probe deadline above fires before fetchproxy's 30s
    // SESSION_READY_TIMEOUT_MS, so a pending pair code / detached extension /
    // unanswered hello would otherwise surface as `timeout` with the
    // "interact with the tab" hint (seen live: pair_pending + timeout). Re-kind
    // it to `session_not_ready` so the shared ladder's session arm names the
    // pair code / "no extension attached" / "never confirmed a session" from
    // the `bridge` block. `linked` keeps `timeout` (the tab really is the
    // problem) and `not_listening` keeps `timeout` so the `no_role` hint
    // still wins for a bridge that never bound a role.
    classifyThrown: (err) => {
      if (!(err instanceof FetchproxyTimeoutError)) return undefined;
      const { state } = client.bridgeStatus().session;
      if (state === 'linked' || state === 'not_listening') return undefined;
      return { kind: 'session_not_ready' };
    },
    // homes-specific copy for the arms whose shared default is too generic
    // for this portal. The other arms (`session_not_ready` — pair code /
    // extension not attached — and `no_role`, which names the real
    // configured port) use the shared ladder verbatim.
    hints: {
      ok: `Bridge round-tripped ${PROBE_PATH} successfully. If real tools still hang, the problem is downstream of fetchproxy (homes.com redirecting on sign-in, AWS WAF challenge, etc.) — not the bridge.`,
      timeout: `Bridge is alive, but the probe didn't get a response within ${PROBE_DEADLINE_S}s. The fix is almost always to wake the homes.com tab: open a homes.com portal tab in your browser, sign in if needed, and INTERACT with it (scroll or click) so the page becomes active — a loaded, signed-in, interacted tab is what unblocks the bridge. Then retry. If that doesn't help, the fetchproxy browser extension may not be connected to this MCP — open the extension popup and check for a green dot next to "homes-mcp".`,
      protocol: `The bridge returned a protocol error before any HTTP response. Most commonly: no homes.com tab is open, or the extension declined the request. Open homes.com, sign in, and retry.`,
      bridge_down: `The fetchproxy browser extension's service worker is not responding even after homes-mcp's automatic lazy-revive retry. Chrome evicts extension service workers after ~30s idle by default. Wake it manually by clicking the fetchproxy extension icon in your browser toolbar, or open chrome://extensions and reload the fetchproxy extension. Then retry.`,
    },
  });
}
