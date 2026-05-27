/**
 * SessionRegistry — multi-session bookkeeping (#20, #21).
 *
 * The homes-mcp transport physically bridges to ONE fetchproxy
 * extension at a time (Chrome can have only one extension instance per
 * profile binding to our WebSocket). What the registry provides is a
 * labelled-context layer on top: callers can register multiple
 * sessions, switch the active one, and surface the full set in the
 * diagnostic tool — so the workflow of "I have homes.com signed in
 * under two different accounts" is at least visible end-to-end even
 * though the physical bridge still routes to whichever account the
 * browser has loaded right now.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../src/sessions.js';

describe('SessionRegistry', () => {
  let registry: SessionRegistry;
  beforeEach(() => {
    registry = new SessionRegistry();
  });

  it('starts with a single default session active', () => {
    const ctx = registry.getContext();
    expect(ctx.sessions).toHaveLength(1);
    expect(ctx.active_session_id).toBe(ctx.sessions[0].session_id);
  });

  it('register adds a session, returns its id, leaves active unchanged unless markActive', () => {
    const initialActive = registry.activeSessionId();
    const id = registry.register({ account_hint: 'me@example.com' });
    expect(id).toBeTruthy();
    expect(registry.getContext().sessions).toHaveLength(2);
    expect(registry.activeSessionId()).toBe(initialActive);
  });

  it('register({ markActive: true }) flips the active pointer', () => {
    const id = registry.register({
      account_hint: 'partner@example.com',
      markActive: true,
    });
    expect(registry.activeSessionId()).toBe(id);
  });

  it('setActive switches to an existing session', () => {
    const id = registry.register({ account_hint: 'a' });
    registry.setActive(id);
    expect(registry.activeSessionId()).toBe(id);
  });

  it('setActive throws for an unknown session id', () => {
    expect(() => registry.setActive('does-not-exist')).toThrow(/no such session/i);
  });

  it('getContext returns all sessions with stable ordering', () => {
    const a = registry.register({ account_hint: 'a' });
    const b = registry.register({ account_hint: 'b' });
    const ctx = registry.getContext();
    expect(ctx.sessions.map((s) => s.account_hint)).toEqual([
      undefined,
      'a',
      'b',
    ]);
    expect(ctx.sessions[1].session_id).toBe(a);
    expect(ctx.sessions[2].session_id).toBe(b);
  });

  it('account_hint surfaces back in the session record', () => {
    const id = registry.register({ account_hint: 'me@example.com' });
    const ctx = registry.getContext();
    const row = ctx.sessions.find((s) => s.session_id === id)!;
    expect(row.account_hint).toBe('me@example.com');
  });

  it('every session_id is unique', () => {
    const ids = new Set<string>();
    ids.add(registry.activeSessionId());
    for (let i = 0; i < 5; i++) {
      ids.add(registry.register({ account_hint: `acct-${i}` }));
    }
    expect(ids.size).toBe(6);
  });
});
