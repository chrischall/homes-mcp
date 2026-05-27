import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../../src/sessions.js';
import { registerSessionsTools } from '../../src/tools/sessions.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

let h: Awaited<ReturnType<typeof createTestHarness>>;
let registry: SessionRegistry;

beforeEach(async () => {
  registry = new SessionRegistry();
  h = await createTestHarness((server) =>
    registerSessionsTools(server, registry)
  );
});

afterEach(async () => {
  await h.close();
});

describe('homes_get_session_context', () => {
  it('returns active_session_id + sessions[]', async () => {
    const r = await h.callTool('homes_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string;
      sessions: Array<{ session_id: string; account_hint?: string }>;
    }>(r);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.active_session_id).toBe(parsed.sessions[0].session_id);
  });

  it('lists multiple registered sessions with their hints (#21)', async () => {
    registry.register({ account_hint: 'me@example.com' });
    registry.register({ account_hint: 'partner@example.com', markActive: true });
    const r = await h.callTool('homes_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string;
      sessions: Array<{ session_id: string; account_hint?: string }>;
    }>(r);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.sessions.map((s) => s.account_hint)).toEqual([
      undefined,
      'me@example.com',
      'partner@example.com',
    ]);
    expect(parsed.active_session_id).toBe(parsed.sessions[2].session_id);
  });
});

describe('homes_register_session', () => {
  it('adds a session and returns its id (#20)', async () => {
    const r = await h.callTool('homes_register_session', {
      account_hint: 'work@example.com',
    });
    const parsed = parseToolResult<{ session_id: string; active: boolean }>(r);
    expect(parsed.session_id).toBeTruthy();
    expect(parsed.active).toBe(false);
    expect(registry.getContext().sessions).toHaveLength(2);
  });

  it('honours mark_active: true to flip the active pointer', async () => {
    const r = await h.callTool('homes_register_session', {
      account_hint: 'second@example.com',
      mark_active: true,
    });
    const parsed = parseToolResult<{ session_id: string; active: boolean }>(r);
    expect(parsed.active).toBe(true);
    expect(registry.activeSessionId()).toBe(parsed.session_id);
  });
});

describe('homes_set_active_session', () => {
  it('switches the active session (#20)', async () => {
    const id = registry.register({ account_hint: 'partner' });
    const r = await h.callTool('homes_set_active_session', {
      session_id: id,
    });
    const parsed = parseToolResult<{ active_session_id: string }>(r);
    expect(parsed.active_session_id).toBe(id);
    expect(registry.activeSessionId()).toBe(id);
  });

  it('returns an error for an unknown session id', async () => {
    const r = await h.callTool('homes_set_active_session', {
      session_id: 'sess_nonexistent',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/no such session/i);
  });
});
