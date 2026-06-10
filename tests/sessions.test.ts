/**
 * Shared SessionRegistry — multi-session bookkeeping (#20, #21).
 *
 * As of the Wave-6 fleet audit the hand-rolled `src/sessions.ts` registry
 * was replaced by the fleet-shared `createSessionRegistry()` from
 * `@chrischall/mcp-utils/session`. The registry's own invariants are
 * covered by the mcp-utils test suite; these tests pin the behaviours
 * homes-mcp relies on against the shared API:
 *
 *   - sessions are keyed by `account_identity` (required, non-empty);
 *   - the registry starts EMPTY (no seeded default) and the first
 *     registered session becomes active;
 *   - `setActive` returns a boolean (false for unknown ids);
 *   - `register` + `setActive` together give register-and-activate.
 *
 * The homes-mcp transport physically bridges to ONE fetchproxy extension
 * at a time; the registry is a labelled-context layer on top so the
 * "signed in under two accounts" workflow stays visible end-to-end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSessionRegistry,
  type SessionRegistry,
} from '@chrischall/mcp-utils/session';

describe('shared SessionRegistry (homes adoption)', () => {
  let registry: SessionRegistry;
  beforeEach(() => {
    registry = createSessionRegistry();
  });

  it('starts empty — no seeded default session', () => {
    const ctx = registry.getContext();
    expect(ctx.sessions).toHaveLength(0);
    expect(ctx.active_session_id).toBeNull();
  });

  it('first registered session becomes active', () => {
    const s = registry.register({ account_identity: 'me@example.com' });
    expect(registry.activeSessionId()).toBe(s.session_id);
    expect(registry.getContext().sessions).toHaveLength(1);
  });

  it('a second register leaves the active pointer unchanged', () => {
    const first = registry.register({ account_identity: 'a@example.com' });
    registry.register({ account_identity: 'b@example.com' });
    expect(registry.activeSessionId()).toBe(first.session_id);
    expect(registry.getContext().sessions).toHaveLength(2);
  });

  it('register + setActive gives register-and-activate', () => {
    registry.register({ account_identity: 'a@example.com' });
    const second = registry.register({ account_identity: 'b@example.com' });
    expect(registry.setActive(second.session_id)).toBe(true);
    expect(registry.activeSessionId()).toBe(second.session_id);
  });

  it('setActive returns false for an unknown session id', () => {
    expect(registry.setActive('does-not-exist')).toBe(false);
  });

  it('re-registering the same account_identity updates in place', () => {
    const first = registry.register({ account_identity: 'me@example.com' });
    const again = registry.register({ account_identity: 'me@example.com' });
    expect(again.session_id).toBe(first.session_id);
    expect(registry.getContext().sessions).toHaveLength(1);
  });

  it('account_identity surfaces back in the session record', () => {
    const s = registry.register({ account_identity: 'me@example.com' });
    const ctx = registry.getContext();
    const row = ctx.sessions.find((r) => r.session_id === s.session_id)!;
    expect(row.account_identity).toBe('me@example.com');
  });

  it('rejects an empty account_identity', () => {
    expect(() => registry.register({ account_identity: '  ' })).toThrow(
      /account_identity/i
    );
  });

  it('every session_id is unique', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) {
      ids.add(registry.register({ account_identity: `acct-${i}` }).session_id);
    }
    expect(ids.size).toBe(6);
  });
});
