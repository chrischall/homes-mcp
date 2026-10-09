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
  registerSharedSessionTools(withAdditiveSessionWrites(server), registry, {
    prefix: "homes",
    serviceLabel: "Homes.com",
    routing: "label-only",
    labelOnlyNote:
      "Every homes tool call goes through whichever browser tab the ContextMint " +
      "Bridge extension is signed into; to read a different account, sign that tab into it.",
  });
}

/**
 * The two session writes, classified by the inverse test. The shared
 * registrar (mcp-utils 3.0.0) sets `readOnlyHint: false` but no
 * `destructiveHint`, which the spec defaults to TRUE — so both were
 * published as destructive. Neither is: they touch only the process-local,
 * label-only registry (nothing routes on it, nothing reaches another person,
 * a restart clears it), and the one piece of prior state either replaces —
 * which session is active — is restored by `homes_set_active_session`.
 */
const ADDITIVE_SESSION_WRITES = new Set([
  "homes_register_session",
  "homes_set_active_session",
]);

/**
 * A view of `server` whose `registerTool` adds `destructiveHint: false` to
 * the session writes above and passes everything else through untouched.
 */
function withAdditiveSessionWrites(server: McpServer): McpServer {
  const registerTool = ((
    name: string,
    config: { annotations?: Record<string, unknown> },
    cb: unknown,
  ) =>
    (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      ADDITIVE_SESSION_WRITES.has(name)
        ? { ...config, annotations: { ...config.annotations, destructiveHint: false } }
        : config,
      cb,
    )) as McpServer["registerTool"];
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") return registerTool;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
