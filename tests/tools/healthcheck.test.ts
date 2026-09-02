// homes_healthcheck is the shared `registerBridgeHealthcheckTool` from
// @chrischall/mcp-utils/fetchproxy (0.20.0) — the probe loop, the error
// envelope, and the hint ladder all live upstream. What these tests pin is
// the homes-specific layer on top: the /robots.txt probe against
// www.homes.com, the 18s interactive deadline inside `probeFn` (#66), the
// homes-flavoured hint copy, and the 2.5.0 extension-link fields riding
// through the `bridge` block.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { classifyBridgeError } from '@fetchproxy/server';
import type { HomesClient } from '../../src/client.js';
import {
  registerHealthcheckTools,
  HEALTHCHECK_PROBE_DEADLINE_MS,
} from '../../src/tools/healthcheck.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyProtocolError,
  FetchproxySessionNotReadyError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import type {
  BridgeProbeResult,
  BridgeStatus,
} from '../../src/transport.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// A full @fetchproxy/server 2.5.0 `bridgeHealth()` snapshot — `BridgeStatus`
// is that shape verbatim, so the stub carries the `session` block the
// shared healthcheck projects into `session_state` / `pending_pair_code` /
// `extension_connected`.
const DEFAULT_STATUS: BridgeStatus = {
  role: 'host',
  port: 37149,
  host: '127.0.0.1',
  serverVersion: '0.0.0',
  fetchTimeoutMs: 30_000,
  bridgeReviveDelayMs: 2_000,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
  lastExtensionMessageAt: null,
  session: { state: 'linked', pairCode: null, extensionConnected: true },
  keepAlive: {
    enabled: true,
    intervalMs: 20_000,
    maxIdleMs: 300_000,
    lastPingAt: null,
    totalPings: 0,
    idleSinceMs: null,
  },
  swEviction: {
    lazyReviveAttempts: 0,
    lazyReviveSuccesses: 0,
    lastEvictionDetectedAt: null,
  },
};

function stubClient(args: {
  status?: Partial<BridgeStatus>;
  fetchHtml?: ReturnType<typeof vi.fn>;
}): HomesClient {
  const status: BridgeStatus = { ...DEFAULT_STATUS, ...(args.status ?? {}) };
  const fetchHtml =
    args.fetchHtml ?? vi.fn().mockResolvedValue('User-agent: *');
  // Stand-in for the transport's runProbe (@fetchproxy/server 2.5.0's probe
  // loop): run the supplied probe closure, classify any thrown error, and
  // project bridgeStatus() into the snake-cased `bridge` block — including
  // the 2.5.0 session fields — exactly the shape the real BridgeProbeResult
  // carries.
  const runProbe = vi
    .fn()
    .mockImplementation(
      async (
        fetchFn: (path: string) => Promise<unknown>,
        probePath: string
      ): Promise<BridgeProbeResult> => {
        const start = Date.now();
        let ok = false;
        let error: BridgeProbeResult['error'];
        try {
          await fetchFn(probePath);
          ok = true;
        } catch (e) {
          error = {
            kind: classifyBridgeError(e),
            message: e instanceof Error ? e.message : String(e),
          };
        }
        return {
          ok,
          elapsed_ms: Date.now() - start,
          bridge: {
            role: status.role,
            port: status.port,
            server_version: status.serverVersion,
            fetch_timeout_ms: status.fetchTimeoutMs,
            last_success_at: status.lastSuccessAt,
            last_failure_at: status.lastFailureAt,
            last_failure_reason: status.lastFailureReason,
            consecutive_failures: status.consecutiveFailures,
            session_state: status.session.state,
            pending_pair_code: status.session.pairCode,
            extension_connected: status.session.extensionConnected,
            last_extension_message_at: status.lastExtensionMessageAt,
          },
          ...(error ? { error } : {}),
        };
      }
    );
  return {
    bridgeStatus: vi.fn().mockReturnValue(status),
    fetchHtml,
    runProbe,
  } as unknown as HomesClient;
}

interface Envelope {
  ok: boolean;
  bridge: {
    role: string | null;
    port: number;
    server_version: string;
    last_success_at: number | null;
    last_failure_at: number | null;
    last_failure_reason: string | null;
    consecutive_failures: number;
    last_extension_message_at: number | null;
    session_state?: string;
    pending_pair_code?: string | null;
    extension_connected?: boolean;
  };
  probe: { url: string; elapsed_ms: number; status?: number; body_length?: number };
  error?: {
    kind: string;
    message: string;
    bridge_hint?: string;
    detail?: Record<string, unknown>;
  };
  hint: string;
  // Dropped from the envelope — asserted absent below.
  error_kind?: unknown;
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

async function run(client: HomesClient): Promise<Envelope> {
  harness = await createTestHarness((server) =>
    registerHealthcheckTools(server, client)
  );
  const r = await harness.callTool('homes_healthcheck', {});
  // The healthcheck reports failure in the payload, never as a tool error.
  expect(r.isError).toBeFalsy();
  return parseToolResult<Envelope>(r);
}

describe('homes_healthcheck tool', () => {
  it('returns ok=true when /robots.txt round-trips through the bridge', async () => {
    const EXT_AT = Date.parse('2026-05-25T03:39:46Z');
    const client = stubClient({
      status: { lastExtensionMessageAt: EXT_AT },
      fetchHtml: vi.fn().mockResolvedValue('User-agent: *\nDisallow:\n'),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(true);
    expect(parsed.bridge.role).toBe('host');
    expect(parsed.probe.url).toBe('https://www.homes.com/robots.txt');
    expect(parsed.probe.status).toBe(200);
    expect(parsed.probe.body_length).toBe('User-agent: *\nDisallow:\n'.length);
    expect(parsed.hint).toMatch(/successfully/i);
    // homes-specific ok copy: point past the bridge at homes.com's WAF.
    expect(parsed.hint).toMatch(/AWS WAF/);
    expect(parsed.error).toBeUndefined();
    expect(parsed.error_kind).toBeUndefined();
    // 2.5.0 extension-link state rides through the bridge block.
    expect(parsed.bridge.session_state).toBe('linked');
    expect(parsed.bridge.pending_pair_code).toBeNull();
    expect(parsed.bridge.extension_connected).toBe(true);
    expect(parsed.bridge.last_extension_message_at).toBe(EXT_AT);
  });

  it('surfaces a pending pair code via bridge.session_state / pending_pair_code', async () => {
    const client = stubClient({
      status: {
        session: {
          state: 'pair_pending',
          pairCode: 'QX7T',
          extensionConnected: true,
        },
      },
    });
    const parsed = await run(client);
    expect(parsed.bridge.session_state).toBe('pair_pending');
    expect(parsed.bridge.pending_pair_code).toBe('QX7T');
  });

  it('classifies a FetchproxyTimeoutError as kind=timeout and tells the user to open AND interact with a homes.com portal tab', async () => {
    const client = stubClient({
      status: { role: 'peer', port: 37200, fetchTimeoutMs: 25 },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/robots.txt',
          timeoutMs: 25,
          role: 'peer',
          port: 37200,
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('timeout');
    expect(parsed.bridge.role).toBe('peer');
    expect(parsed.bridge.port).toBe(37200);
    // Must name homes.com, instruct interaction (scroll/click), and quote
    // the probe's own deadline rather than the transport's 30s.
    expect(parsed.hint).toMatch(/homes\.com/i);
    expect(parsed.hint).toMatch(/interact|scroll|click/i);
    expect(parsed.hint).toMatch(
      new RegExp(`${Math.round(HEALTHCHECK_PROBE_DEADLINE_MS / 1000)}s`)
    );
    expect(parsed.hint).toMatch(/extension popup/i);
  });

  it('bridge_down hint wins over the generic role=null hint when both apply', async () => {
    // A FetchproxyBridgeDownError can fire while role is still null (the
    // bridge can hand back the SW-eviction error before listen() resolves);
    // the specific hint must beat "never bound a role".
    const client = stubClient({
      status: { role: null },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
          op: 'fetch',
          url: 'https://www.homes.com/robots.txt',
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.error?.kind).toBe('bridge_down');
    expect(parsed.hint).toMatch(/service worker/i);
    expect(parsed.hint).not.toMatch(/never bound a role/);
  });

  it('hint when role is null points at startup failure (naming the real port), not an extension issue', async () => {
    const client = stubClient({
      status: { role: null, port: 37200, fetchTimeoutMs: 25 },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/robots.txt',
          timeoutMs: 25,
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.bridge.role).toBeNull();
    expect(parsed.hint).toMatch(/never bound a role/);
    // The shared ladder names the configured port, not a literal 37149.
    expect(parsed.hint).toMatch(/37200/);
  });

  it('classifies a bare FetchproxyProtocolError as kind=protocol with the homes.com-tab hint', async () => {
    const client = stubClient({
      fetchHtml: vi
        .fn()
        .mockRejectedValue(new FetchproxyProtocolError('extension offline')),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('protocol');
    expect(parsed.hint).toMatch(/no homes\.com tab is open/i);
  });

  it('classifies a FetchproxyBridgeDownError as kind=bridge_down with the lazy-revive SW-eviction hint and the upstream bridge_hint', async () => {
    const client = stubClient({
      status: { role: 'peer' },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError:
            'tab fetch failed: Error: Could not establish connection. Receiving end does not exist.',
          retryAttempted: true,
          op: 'fetch',
          url: 'https://www.homes.com/robots.txt',
          role: 'peer',
          port: 37149,
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('bridge_down');
    // Hint points the operator at the extension's service worker — and
    // keeps the homes wording that the automatic lazy-revive already ran.
    expect(parsed.hint).toMatch(/service worker/i);
    expect(parsed.hint).toMatch(/lazy-revive/i);
    // The upstream-curated recovery hint still rides on error.bridge_hint.
    expect(parsed.error?.bridge_hint).toBeDefined();
    expect(parsed.error?.bridge_hint!.length).toBeGreaterThan(0);
  });

  it('classifies a FetchproxySessionNotReadyError as kind=session_not_ready and names the pending pair code', async () => {
    const client = stubClient({
      status: {
        session: {
          state: 'pair_pending',
          pairCode: 'QX7T',
          extensionConnected: true,
        },
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxySessionNotReadyError({
          mcpId: 'homes-mcp',
          pairCode: 'QX7T',
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('session_not_ready');
    expect(parsed.bridge.session_state).toBe('pair_pending');
    expect(parsed.hint).toMatch(/QX7T/);
    expect(parsed.hint).toMatch(/homes-mcp/);
  });

  it('surfaces freshness counters (last_success_at, last_failure_at, consecutive_failures) on the bridge block', async () => {
    const SUCCESS_AT = Date.parse('2026-05-25T03:39:46Z');
    const FAILURE_AT = Date.parse('2026-05-25T03:40:00Z');
    const client = stubClient({
      status: {
        lastSuccessAt: SUCCESS_AT,
        lastFailureAt: FAILURE_AT,
        lastFailureReason: 'Could not establish connection.',
        consecutiveFailures: 3,
      },
    });
    const parsed = await run(client);
    expect(parsed.bridge.last_success_at).toBe(SUCCESS_AT);
    expect(parsed.bridge.last_failure_at).toBe(FAILURE_AT);
    expect(parsed.bridge.last_failure_reason).toMatch(/Could not establish/);
    expect(parsed.bridge.consecutive_failures).toBe(3);
  });

  it('classifies an unrelated error as kind=unknown', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(new Error('something else')),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('unknown');
    expect(parsed.error?.message).toMatch(/something else/);
    expect(parsed.hint).toMatch(/error\.message/);
  });

  it('drops the legacy top-level error_kind and the role/port/elapsed extras from the error block', async () => {
    // The `bridge` block already carries role/port, and `probe.elapsed_ms`
    // carries the timing — the shared envelope has no duplicate slots.
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/robots.txt',
          timeoutMs: 30_000,
          role: 'host',
          port: 37149,
          elapsedMs: 30_007,
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.error_kind).toBeUndefined();
    expect(parsed.error).not.toHaveProperty('role_at_failure');
    expect(parsed.error).not.toHaveProperty('port_at_failure');
    expect(parsed.error).not.toHaveProperty('elapsed_ms');
    expect(typeof parsed.probe.elapsed_ms).toBe('number');
  });

  it('last_extension_message_at defaults to null pre-first-frame', async () => {
    const parsed = await run(stubClient({}));
    expect(parsed.bridge.last_extension_message_at).toBeNull();
  });

  // ---------- #66: short probe deadline + actionable open/interact hint ----------

  it('caps the probe at a short interactive budget (15–20s), not the transport 30s+', () => {
    // The probe must fail fast so a user staring at a wedged call gets a
    // signal in seconds, not after a ~2-minute hang. Pin the budget to
    // the recommended 15–20s window.
    expect(HEALTHCHECK_PROBE_DEADLINE_MS).toBeGreaterThanOrEqual(15_000);
    expect(HEALTHCHECK_PROBE_DEADLINE_MS).toBeLessThanOrEqual(20_000);
  });

  it('fails fast as a timeout when the probe fetch outlives the probe deadline', async () => {
    vi.useFakeTimers();
    try {
      // fetchHtml that never settles — stands in for a wedged bridge /
      // sleeping homes.com tab. The tool's own withDeadline wrapper must
      // fire well before the transport's 30s fetchTimeoutMs would.
      const neverSettles = vi.fn(() => new Promise<string>(() => {}));
      const client = stubClient({ fetchHtml: neverSettles });
      harness = await createTestHarness((server) =>
        registerHealthcheckTools(server, client)
      );
      const call = harness.callTool('homes_healthcheck', {});
      // Advance past the probe deadline (but well short of 30s+).
      await vi.advanceTimersByTimeAsync(HEALTHCHECK_PROBE_DEADLINE_MS + 50);
      const r = await call;
      const parsed = parseToolResult<Envelope>(r);
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.kind).toBe('timeout');
      expect(parsed.hint).toMatch(/interact|scroll|click/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- timeout while the extension link is not established ----------
//
// The 18s probe deadline fires before fetchproxy's 30s session-ready wait,
// so without a re-kind a pending pair code / detached extension /
// unanswered hello would surface as `timeout` with the "interact with the
// tab" hint (observed live: pair_pending + timeout). The homes registrar's
// classifyThrown files such a timeout under `session_not_ready` so the
// shared ladder's session arm names the actual fix from the bridge block.
describe('homes_healthcheck timeout vs. extension link state', () => {
  const transportTimeout = () =>
    vi.fn().mockRejectedValue(
      new FetchproxyTimeoutError({
        url: 'https://www.homes.com/robots.txt',
        timeoutMs: 30_000,
        role: 'host',
        port: 37149,
      })
    );

  it('re-kinds a timeout to session_not_ready and names the pair code when a pair is pending', async () => {
    const client = stubClient({
      status: {
        session: { state: 'pair_pending', pairCode: '612-757', extensionConnected: true },
      },
      fetchHtml: transportTimeout(),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('session_not_ready');
    expect(parsed.bridge.session_state).toBe('pair_pending');
    expect(parsed.hint).toMatch(/612-757/);
    expect(parsed.hint).toMatch(/approve/i);
    expect(parsed.hint).not.toMatch(/interact/i);
  });

  it('re-kinds a timeout to session_not_ready with the "no extension attached" hint when the extension is disconnected', async () => {
    const client = stubClient({
      status: {
        session: { state: 'extension_disconnected', pairCode: null, extensionConnected: false },
      },
      fetchHtml: transportTimeout(),
    });
    const parsed = await run(client);
    expect(parsed.error?.kind).toBe('session_not_ready');
    expect(parsed.hint).toMatch(/No Transporter extension is attached/i);
    expect(parsed.hint).not.toMatch(/interact/i);
  });

  it('re-kinds a timeout to session_not_ready with the "never confirmed a session" hint on no_session', async () => {
    const client = stubClient({
      status: {
        session: { state: 'no_session', pairCode: null, extensionConnected: true },
      },
      fetchHtml: transportTimeout(),
    });
    const parsed = await run(client);
    expect(parsed.error?.kind).toBe('session_not_ready');
    expect(parsed.hint).toMatch(/never confirmed a session/i);
  });

  it('keeps kind=timeout and the interact-with-the-tab hint when the link is linked', async () => {
    const client = stubClient({
      status: { session: { state: 'linked', pairCode: null, extensionConnected: true } },
      fetchHtml: transportTimeout(),
    });
    const parsed = await run(client);
    expect(parsed.error?.kind).toBe('timeout');
    expect(parsed.hint).toMatch(/interact|scroll|click/i);
  });

  it('keeps kind=timeout on not_listening so the no_role hint still wins for a bridge that never bound a role', async () => {
    const client = stubClient({
      status: {
        role: null,
        session: { state: 'not_listening', pairCode: null, extensionConnected: false },
      },
      fetchHtml: transportTimeout(),
    });
    const parsed = await run(client);
    expect(parsed.error?.kind).toBe('timeout');
    expect(parsed.hint).toMatch(/never bound a role/);
  });

  it('does not re-kind a non-timeout error even when a pair is pending', async () => {
    const client = stubClient({
      status: {
        session: { state: 'pair_pending', pairCode: '612-757', extensionConnected: true },
      },
      fetchHtml: vi
        .fn()
        .mockRejectedValue(new FetchproxyProtocolError('extension offline')),
    });
    const parsed = await run(client);
    expect(parsed.error?.kind).toBe('protocol');
  });

  it('re-kinds the synthesized 18s deadline timeout to session_not_ready when a pair is pending (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const neverSettles = vi.fn(() => new Promise<string>(() => {}));
      const client = stubClient({
        status: {
          session: { state: 'pair_pending', pairCode: '612-757', extensionConnected: true },
        },
        fetchHtml: neverSettles,
      });
      harness = await createTestHarness((server) =>
        registerHealthcheckTools(server, client)
      );
      const call = harness.callTool('homes_healthcheck', {});
      await vi.advanceTimersByTimeAsync(HEALTHCHECK_PROBE_DEADLINE_MS + 50);
      const parsed = parseToolResult<Envelope>(await call);
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.kind).toBe('session_not_ready');
      expect(parsed.hint).toMatch(/612-757/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the synthesized 18s deadline timeout as kind=timeout when the link is linked (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const neverSettles = vi.fn(() => new Promise<string>(() => {}));
      const client = stubClient({
        status: { session: { state: 'linked', pairCode: null, extensionConnected: true } },
        fetchHtml: neverSettles,
      });
      harness = await createTestHarness((server) =>
        registerHealthcheckTools(server, client)
      );
      const call = harness.callTool('homes_healthcheck', {});
      await vi.advanceTimersByTimeAsync(HEALTHCHECK_PROBE_DEADLINE_MS + 50);
      const parsed = parseToolResult<Envelope>(await call);
      expect(parsed.error?.kind).toBe('timeout');
      expect(parsed.hint).toMatch(/interact|scroll|click/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
