import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerSessionTools as registerSharedSessionTools,
  type SessionRegistry,
} from '@chrischall/mcp-utils/session';

/**
 * MCP tool surface for the shared session registry (#20, #21).
 *
 * Three tools, all `homes`-prefixed:
 *
 * - `homes_register_session` — register (or refresh) an authenticated
 *   session keyed by `account_identity`. Pass `mark_active: true` to
 *   make it the active session in the same call.
 * - `homes_set_active_session` — switch which registered session
 *   subsequent calls treat as active.
 * - `homes_get_session_context` — diagnostic: every registered session
 *   plus the current `active_session_id`.
 *
 * The trio is the fleet-shared `registerSessionTools` from
 * `@chrischall/mcp-utils/session`, bound to the `homes` prefix. It's
 * wrapped here (rather than called directly in index.ts) so the
 * `homes`-specific prefix/label live in one place and the existing
 * `(server, registry)` call site stays unchanged.
 *
 * Important caveat (unchanged): the physical fetchproxy bridge still
 * routes to whichever browser tab the extension is bound to right now —
 * the registry is a labelled-context layer the caller uses to track
 * which account it's working with, not a transport-level multiplexer.
 */
export function registerSessionsTools(
  server: McpServer,
  registry: SessionRegistry
): void {
  registerSharedSessionTools(server, registry, {
    prefix: 'homes',
    serviceLabel: 'Homes',
  });
}
