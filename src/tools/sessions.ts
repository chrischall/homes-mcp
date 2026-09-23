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
 * `@chrischall/mcp-utils/session`, bound to the `homes` prefix. It's
 * wrapped here (rather than called directly in index.ts) so the
 * `homes`-specific prefix/label live in one place and the existing
 * `(server, registry)` call site stays unchanged.
 *
 * Descriptions (fleet-audit #135): the shared trio's wording promises that
 * `set_active_session` changes which session "subsequent tool calls route
 * through" and that tools accept a `session_id` override. Neither is true
 * here — nothing reads the registry to route requests and no homes tool
 * takes `session_id`; the physical fetchproxy bridge always uses whichever
 * browser tab the extension is bound to. mcp-utils 2.4.0 hard-codes that
 * wording (its only options are `prefix` / `serviceLabel`), so the wrapper
 * hands it a thin view of the server whose `registerTool` swaps in honest,
 * label-only descriptions for the three tools. Everything else (schemas,
 * annotations, handlers) is the shared implementation, untouched.
 */
const LABEL_ONLY =
  'The registry is a label only: it does not change which Homes.com account ' +
  'requests use. Every homes tool call goes through whichever browser tab the ' +
  'fetchproxy extension is signed into; to read a different account, sign that ' +
  'tab into it.';

export const SESSION_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  homes_register_session:
    'Record (or refresh) a note of which Homes.com account the signed-in browser ' +
    'tab belongs to, keyed by `account_identity`. Re-registering the same ' +
    'identity updates the existing entry. Returns a `session_id`; pass ' +
    '`mark_active: true` to mark it as the current account in the same call. ' +
    LABEL_ONLY,
  homes_set_active_session:
    'Mark a previously registered `session_id` as the current account label, ' +
    'for your own bookkeeping across a conversation. ' +
    LABEL_ONLY,
  homes_get_session_context:
    'List every registered account label plus the current `active_session_id`. ' +
    'When none are registered, `sessions` is empty and `active_session_id` is null. ' +
    LABEL_ONLY,
};

export function registerSessionsTools(
  server: McpServer,
  registry: SessionRegistry,
): void {
  const relabelled = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: { description?: string }, cb: unknown) =>
          (target.registerTool as (...a: unknown[]) => unknown)(
            name,
            { ...config, description: SESSION_TOOL_DESCRIPTIONS[name] ?? config.description },
            cb,
          );
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  registerSharedSessionTools(relabelled, registry, {
    prefix: "homes",
    serviceLabel: "Homes",
  });
}
