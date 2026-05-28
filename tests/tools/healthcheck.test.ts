import { describe, it, expect, vi, afterAll } from 'vitest';
import { classifyBridgeError } from '@fetchproxy/server';
import type { HomesClient } from '../../src/client.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyProtocolError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import type {
  BridgeProbeResult,
  BridgeStatus,
} from '../../src/transport.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const DEFAULT_STATUS: BridgeStatus = {
  role: 'host',
  port: 37149,
  serverVersion: '0.0.0',
  fetchTimeoutMs: 30_000,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
  lastExtensionMessageAt: null,
};

function stubClient(args: {
  status?: Partial<BridgeStatus>;
  fetchHtml?: ReturnType<typeof vi.fn>;
}): HomesClient {
  const status: BridgeStatus = { ...DEFAULT_STATUS, ...(args.status ?? {}) };
  const fetchHtml =
    args.fetchHtml ?? vi.fn().mockResolvedValue('User-agent: *');
  // Stand-in for the transport's runProbe (which delegates to
  // @fetchproxy/server 0.10.0's probe loop): run the supplied probe
  // closure, classify any thrown error, and project bridgeStatus() into
  // the snake-cased `bridge` block — exactly the shape the real
  // BridgeProbeResult carries. The healthcheck tool layers the
  // homes-specific extras (rich typed-error block, body_length,
  // last_extension_message_at, hint) on top of this.
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

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('homes_healthcheck tool', () => {
  it('returns ok=true when /robots.txt round-trips through the bridge', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockResolvedValue('User-agent: *\nDisallow:\n'),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string; port: number };
      probe: { url: string; status: number; body_length: number };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(true);
    expect(parsed.bridge.role).toBe('host');
    expect(parsed.probe.url).toBe('https://www.homes.com/robots.txt');
    expect(parsed.probe.status).toBe(200);
    expect(parsed.probe.body_length).toBeGreaterThan(0);
    expect(parsed.hint).toMatch(/successfully/i);
  });

  it('classifies a FetchproxyTimeoutError as kind=timeout with role-specific hint', async () => {
    // 0.8.0+: role_at_failure is read off the typed error
    // (`err.role`), not from a post-throw bridgeStatus() snapshot.
    // Pass `role: 'peer'` on the error so the assertion below holds.
    const client = stubClient({
      status: {
        role: 'peer',
        port: 37200,
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/robots.txt',
          timeoutMs: 25,
          role: 'peer',
          port: 37200,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    expect(r.isError).toBeFalsy(); // healthcheck reports failure in payload, not as tool error
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string };
      error: { kind: string; role_at_failure: string };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('timeout');
    expect(parsed.error.role_at_failure).toBe('peer');
    expect(parsed.hint).toMatch(/extension popup/i);
  });

  it('bridge_down hint wins over the generic role=null hint when both apply', async () => {
    // Regression: the previous hintFor ordering checked role===null
    // first, so a FetchproxyBridgeDownError thrown while role happened
    // to be null (technically possible during startup) showed the
    // wrong message ("bridge never bound a role") instead of the
    // SW-eviction guidance.
    const client = stubClient({
      status: {
        role: null,
        port: 37149,
        serverVersion: '1.0.0',
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
          op: 'fetch',
          url: 'https://www.homes.com/robots.txt',
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{ error: { kind: string }; hint: string }>(r);
    expect(parsed.error.kind).toBe('bridge_down');
    expect(parsed.hint).toMatch(/service worker/i);
    expect(parsed.hint).not.toMatch(/never bound a role/);
  });

  it('hint when role is null points at startup failure, not extension issue', async () => {
    const client = stubClient({
      status: {
        role: null,
        port: 37149,
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/robots.txt',
          timeoutMs: 25,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      error: { role_at_failure: string | null };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.role_at_failure).toBeNull();
    expect(parsed.hint).toMatch(/never bound a role/);
  });

  it('classifies a generic FetchproxyProtocolError as kind=transport', async () => {
    const client = stubClient({
      fetchHtml: vi
        .fn()
        .mockRejectedValue(new FetchproxyProtocolError('extension offline')),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string }; hint: string }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('transport');
    expect(parsed.hint).toMatch(/no homes\.com tab is open/i);
  });

  it('classifies a FetchproxyBridgeDownError as kind=bridge_down with SW-eviction hint', async () => {
    const client = stubClient({
      status: { role: 'peer', port: 37149, serverVersion: '0.5.0' },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError:
            'tab fetch failed: Error: Could not establish connection. Receiving end does not exist.',
          retryAttempted: true,
          op: 'fetch',
          url: 'https://www.homes.com/robots.txt',
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      error: { kind: string; message: string };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('bridge_down');
    // Hint must point the operator at the right place: the extension's
    // service worker, not the MCP process and not homes.com itself.
    expect(parsed.hint).toMatch(/service worker/i);
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
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      bridge: {
        last_success_at: number | null;
        last_failure_at: number | null;
        last_failure_reason: string | null;
        consecutive_failures: number;
      };
    }>(r);
    expect(parsed.bridge.last_success_at).toBe(SUCCESS_AT);
    expect(parsed.bridge.last_failure_at).toBe(FAILURE_AT);
    expect(parsed.bridge.last_failure_reason).toMatch(/Could not establish/);
    expect(parsed.bridge.consecutive_failures).toBe(3);
  });

  it('classifies an unrelated error as kind=other', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(new Error('something else')),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string } }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('other');
  });

  // ---------- 0.8.0 integration: classifyBridgeError + typed-error fields ----------

  it('surfaces error_kind from classifyBridgeError() (timeout maps to "timeout")', async () => {
    // The healthcheck output's `error_kind` is the canonical
    // BridgeError discriminator returned by classifyBridgeError().
    // For a FetchproxyTimeoutError that's `'timeout'` — same string
    // the legacy `error.kind` field carries, so callers can switch
    // on either, but `error_kind` is preferred going forward.
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.homes.com/robots.txt',
          timeoutMs: 25,
          role: 'host',
          port: 37149,
          elapsedMs: 27,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{ error_kind: string }>(r);
    expect(parsed.error_kind).toBe('timeout');
  });

  it('error_kind is "bridge_down" for FetchproxyBridgeDownError', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
          op: 'fetch',
          url: 'https://www.homes.com/robots.txt',
          role: 'host',
          port: 37149,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{ error_kind: string }>(r);
    expect(parsed.error_kind).toBe('bridge_down');
  });

  it('error_kind is "protocol" for a bare FetchproxyProtocolError (non-subclass)', async () => {
    // Note: the existing `error.kind` field uses 'transport' for this
    // case to keep the user-facing JSON shape stable. The new
    // `error_kind` discriminator surfaces the canonical 'protocol'
    // string from classifyBridgeError() so callers that want the
    // upstream taxonomy can read it.
    const client = stubClient({
      fetchHtml: vi
        .fn()
        .mockRejectedValue(new FetchproxyProtocolError('extension offline')),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      error_kind: string;
      error: { kind: string };
    }>(r);
    expect(parsed.error_kind).toBe('protocol');
    expect(parsed.error.kind).toBe('transport');
  });

  it('error_kind is "other" for an unrelated Error', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(new Error('something else')),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{ error_kind: string }>(r);
    expect(parsed.error_kind).toBe('other');
  });

  it('surfaces the bridge-down error .hint to the model for actionable recovery guidance', async () => {
    // FetchproxyBridgeDownError ships with a `.hint` string the
    // upstream dep curates (SW eviction recovery steps). Surface it
    // verbatim under error.bridge_hint so the LLM gets the canonical
    // wording rather than relying on us to re-paraphrase it.
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
          op: 'fetch',
          url: 'https://www.homes.com/robots.txt',
          role: 'host',
          port: 37149,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      error: { bridge_hint?: string };
    }>(r);
    expect(parsed.error.bridge_hint).toBeDefined();
    expect(parsed.error.bridge_hint!.length).toBeGreaterThan(0);
  });

  it('reads role/port/elapsed_ms directly off the typed timeout error (0.8.0 fields)', async () => {
    // 0.8.0+: FetchproxyTimeoutError carries role/port/elapsedMs
    // captured at throw time. Use those directly instead of re-reading
    // bridgeStatus() post-throw — the error fields are the source of
    // truth for the moment of failure.
    const client = stubClient({
      // Make the post-throw snapshot inconsistent with the error
      // fields so the test pins which one we trust.
      status: { role: 'peer', port: 99999 },
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
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      error: {
        role_at_failure: string | null;
        port_at_failure?: number;
        elapsed_ms?: number;
      };
    }>(r);
    // role_at_failure now comes from err.role, not the snapshot
    expect(parsed.error.role_at_failure).toBe('host');
    expect(parsed.error.port_at_failure).toBe(37149);
    expect(parsed.error.elapsed_ms).toBe(30_007);
  });

  it('reads role/port directly off the typed bridge-down error', async () => {
    const client = stubClient({
      status: { role: 'peer', port: 99999 },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
          op: 'fetch',
          url: 'https://www.homes.com/robots.txt',
          role: 'host',
          port: 37149,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      error: { role_at_failure: string | null; port_at_failure?: number };
    }>(r);
    expect(parsed.error.role_at_failure).toBe('host');
    expect(parsed.error.port_at_failure).toBe(37149);
  });

  it('surfaces last_extension_message_at in the bridge block (0.8.0 liveness signal)', async () => {
    const EXT_AT = Date.parse('2026-05-25T03:39:46Z');
    const client = stubClient({
      status: {
        lastExtensionMessageAt: EXT_AT,
      },
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      bridge: { last_extension_message_at: number | null };
    }>(r);
    expect(parsed.bridge.last_extension_message_at).toBe(EXT_AT);
  });

  it('last_extension_message_at defaults to null pre-first-frame', async () => {
    const client = stubClient({});
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('homes_healthcheck', {});
    const parsed = parseToolResult<{
      bridge: { last_extension_message_at: number | null };
    }>(r);
    expect(parsed.bridge.last_extension_message_at).toBeNull();
  });
});
