import type { McpServer } from "@modelcontextprotocol/server";
import {
  registerSessionTools as registerSharedSessionTools,
  type SessionRegistry,
} from "@chrischall/mcp-utils/session";

/**
 * MCP tool surface for the shared session registry (#20, #21).
 *
 * Three tools, all `homes`-prefixed:
 *
 * - `homes_register_session` — register (or refresh) an authenticated
 *   session keyed by `account_identity`. Pass `mark_active: true` to
 *   make it the active session in the same call.
 * - `homes_set_active_session` — mark which registered session is the
 *   current account label.
 * - `homes_get_session_context` — diagnostic: every registered session
 *   plus the current `active_session_id`.
 *
 * The trio is the fleet-shared `registerSessionTools` from
 * `@chrischall/mcp-utils/session`, bound to the `homes` prefix.
 *
 * `routing: 'label-only'` (fleet-audit #135 / #1092): nothing in homes-mcp
 * reads the registry to route requests and no homes tool takes
 * `session_id`; the fetchproxy bridge always uses whichever browser tab the
 * extension is bound to. mcp-utils >= 2.12 generates honest label-only
 * descriptions for that case, replacing the Proxy that used to swap them in.
 */
export function registerSessionsTools(
  server: McpServer,
  registry: SessionRegistry,
): void {
  registerSharedSessionTools(server, registry, {
    prefix: "homes",
    serviceLabel: "Homes.com",
    routing: "label-only",
    labelOnlyNote:
      "Every homes tool call goes through whichever browser tab the ContextMint " +
      "Bridge extension is signed into; to read a different account, sign that tab into it.",
  });
}
