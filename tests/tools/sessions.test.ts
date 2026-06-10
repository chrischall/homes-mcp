/**
 * Session tool trio (#20, #21) — now the fleet-shared `registerSessionTools`
 * from `@chrischall/mcp-utils/session`, bound to the `homes` prefix via the
 * thin wrapper in `src/tools/sessions.ts`.
 *
 * BREAKING (Wave-6 audit): `homes_register_session` takes `account_identity`
 * (required) instead of the old optional `account_hint`. `mark_active` is
 * RETAINED — register-and-activate still works in a single call.
 *
 * The homes-mcp transport physically bridges to ONE fetchproxy extension at a
 * time; the registry is a labelled-context layer on top.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSessionRegistry,
  type SessionRegistry,
} from '@chrischall/mcp-utils/session';
import { registerSessionsTools } from '../../src/tools/sessions.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

let h: Awaited<ReturnType<typeof createTestHarness>>;
let registry: SessionRegistry;

beforeEach(async () => {
  registry = createSessionRegistry();
  h = await createTestHarness((server) =>
    registerSessionsTools(server, registry)
  );
});

afterEach(async () => {
  await h.close();
});

describe('homes_get_session_context', () => {
  it('starts empty — no sessions, null active id', async () => {
    const r = await h.callTool('homes_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string | null;
      sessions: Array<{ session_id: string; account_identity: string }>;
    }>(r);
    expect(parsed.sessions).toHaveLength(0);
    expect(parsed.active_session_id).toBeNull();
  });

  it('lists registered sessions with their identities (#21)', async () => {
    const first = registry.register({ account_identity: 'me@example.com' });
    registry.register({ account_identity: 'partner@example.com' });
    const r = await h.callTool('homes_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string | null;
      sessions: Array<{ session_id: string; account_identity: string }>;
    }>(r);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions.map((s) => s.account_identity)).toEqual([
      'me@example.com',
      'partner@example.com',
    ]);
    // First registered wins the active pointer.
    expect(parsed.active_session_id).toBe(first.session_id);
  });
});

describe('homes_register_session', () => {
  it('adds a session keyed by account_identity (#20)', async () => {
    const r = await h.callTool('homes_register_session', {
      account_identity: 'work@example.com',
    });
    const parsed = parseToolResult<{
      session: { session_id: string; account_identity: string };
      active_session_id: string | null;
    }>(r);
    expect(parsed.session.session_id).toBeTruthy();
    expect(parsed.session.account_identity).toBe('work@example.com');
    // First registered becomes active.
    expect(parsed.active_session_id).toBe(parsed.session.session_id);
    expect(registry.getContext().sessions).toHaveLength(1);
  });

  it('honours mark_active: true to register AND activate in one call', async () => {
    // Seed an existing active session so mark_active has to flip the pointer.
    const first = registry.register({ account_identity: 'first@example.com' });
    expect(registry.activeSessionId()).toBe(first.session_id);

    const r = await h.callTool('homes_register_session', {
      account_identity: 'second@example.com',
      mark_active: true,
    });
    const parsed = parseToolResult<{
      session: { session_id: string };
      active_session_id: string | null;
    }>(r);
    expect(parsed.active_session_id).toBe(parsed.session.session_id);
    expect(registry.activeSessionId()).toBe(parsed.session.session_id);
  });

  it('without mark_active, the prior active session is preserved', async () => {
    const first = registry.register({ account_identity: 'first@example.com' });
    const r = await h.callTool('homes_register_session', {
      account_identity: 'second@example.com',
    });
    const parsed = parseToolResult<{
      session: { session_id: string };
      active_session_id: string | null;
    }>(r);
    expect(parsed.active_session_id).toBe(first.session_id);
    expect(parsed.session.session_id).not.toBe(first.session_id);
  });

  it('rejects a missing account_identity', async () => {
    const r = await h.callTool('homes_register_session', {});
    expect(r.isError).toBeTruthy();
  });
});

describe('homes_set_active_session', () => {
  it('switches the active session (#20)', async () => {
    registry.register({ account_identity: 'first@example.com' });
    const second = registry.register({ account_identity: 'second@example.com' });
    const r = await h.callTool('homes_set_active_session', {
      session_id: second.session_id,
    });
    const parsed = parseToolResult<{ active_session_id: string }>(r);
    expect(parsed.active_session_id).toBe(second.session_id);
    expect(registry.activeSessionId()).toBe(second.session_id);
  });

  it('returns an error for an unknown session id', async () => {
    const r = await h.callTool('homes_set_active_session', {
      session_id: 'sess_nonexistent',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/unknown session_id/i);
  });
});
