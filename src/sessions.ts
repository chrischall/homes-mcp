/**
 * SessionRegistry — labelled-session bookkeeping for the homes-mcp
 * server (#20, #21).
 *
 * The fetchproxy WebSocket bridge physically routes to ONE browser
 * extension at a time, so the registry doesn't drive request routing
 * the way OneHome's multi-session client does. What it provides is the
 * caller-facing model: register a session with a free-text
 * `account_hint` (e.g. an email), switch the active session, surface
 * the full registry in the diagnostic tool. Workflows that need to
 * compare data across accounts can at least see what's registered and
 * narrate the switch — and the physical bridge can be extended later
 * to multi-port routing without changing the public surface.
 */

import { randomUUID } from 'node:crypto';

export interface SessionInfo {
  session_id: string;
  /**
   * Free-text label the caller supplied (typically an account email,
   * profile name, or "personal" / "work"). Surfaced verbatim in
   * `homes_get_session_context` so callers can tell sessions apart.
   */
  account_hint?: string;
  /** Unix-ms timestamp when this session was registered. */
  registered_at: number;
}

export interface SessionContext {
  active_session_id: string;
  sessions: SessionInfo[];
}

export interface RegisterOptions {
  account_hint?: string;
  /** When true, the new session becomes the active one. */
  markActive?: boolean;
}

const DEFAULT_ID_PREFIX = 'sess';

function makeId(): string {
  // Short, opaque, sortable-by-insertion (the registered_at field is
  // the source of truth for ordering). Using UUID-derived suffix keeps
  // it unique without leaking a counter that varies by test order.
  return `${DEFAULT_ID_PREFIX}_${randomUUID().slice(0, 8)}`;
}

/**
 * In-memory registry. Process-lifetime only — there's no need to
 * persist; each homes-mcp launch starts with a single default session
 * (the bridge is up before the registry binds).
 */
export class SessionRegistry {
  private sessions: SessionInfo[] = [];
  private activeId: string;

  constructor() {
    const initial: SessionInfo = {
      session_id: makeId(),
      registered_at: Date.now(),
    };
    this.sessions.push(initial);
    this.activeId = initial.session_id;
  }

  /**
   * Register a new session. Returns its id. Active session unchanged
   * unless `markActive: true` (callers typically want this when
   * they're about to switch the browser to a different account).
   */
  register(opts: RegisterOptions = {}): string {
    const info: SessionInfo = {
      session_id: makeId(),
      account_hint: opts.account_hint,
      registered_at: Date.now(),
    };
    this.sessions.push(info);
    if (opts.markActive) this.activeId = info.session_id;
    return info.session_id;
  }

  /**
   * Switch the active session. Throws if the id was never registered —
   * callers should look up the id via `homes_get_session_context`
   * first.
   */
  setActive(sessionId: string): void {
    const exists = this.sessions.some((s) => s.session_id === sessionId);
    if (!exists) {
      throw new Error(
        `no such session "${sessionId}". Use homes_get_session_context to list valid ids.`
      );
    }
    this.activeId = sessionId;
  }

  activeSessionId(): string {
    return this.activeId;
  }

  getContext(): SessionContext {
    // Return a shallow clone so callers can't mutate our internal state.
    return {
      active_session_id: this.activeId,
      sessions: this.sessions.map((s) => ({ ...s })),
    };
  }
}
