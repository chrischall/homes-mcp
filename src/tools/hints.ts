import type { McpServer } from "@modelcontextprotocol/server";

/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, context-groups spec 2026-11-03 D4). Inert data: a host
 * that does not read them sees an extra `_meta` key and nothing else. The
 * shape is fixed by the host's contract, so it is restated here rather than
 * imported — this server takes no dependency on mcp-host.
 *
 * homes-mcp declares no `canonical` read: homes.com serves listings, history
 * and the signed-in user's saved homes/searches, none of which carries a date
 * or change feed that answers a "what's new / due / on" ask, and there is no
 * person-scoped subject (child, property, account) to enumerate. Every read is
 * a `lookup`; the local calculators and the label-only session writes are
 * `other`.
 *
 * `aliases` are the words a person says — lowercase, at most 8, each at most
 * 40 chars — never tool names.
 */
export type MintIntent =
  | "whats-new"
  | "whats-due"
  | "whats-on"
  | "lookup"
  | "turn-on-off"
  | "send"
  | "change"
  | "other";

export interface MintHint {
  domain: "home";
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

export type MintMeta = { mint: MintHint };

/** `_meta` for a homes tool: every tool here is in the `home` domain. */
export function homeMeta(
  intent: MintIntent,
  extra: Omit<MintHint, "domain" | "intent"> = {},
): MintMeta {
  return { mint: { domain: "home", intent, ...extra } };
}

/**
 * A view of `server` whose `registerTool` adds `_meta` from `hints` (by tool
 * name) and passes everything else through untouched. For the shared
 * registrars (realty-core's calculators, mcp-utils' session trio), which take
 * no `_meta` option of their own.
 */
export function withHints(
  server: McpServer,
  hints: Record<string, MintMeta>,
): McpServer {
  const registerTool = ((
    name: string,
    config: { _meta?: Record<string, unknown> },
    cb: unknown,
  ) =>
    (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      hints[name] ? { ...config, _meta: { ...config._meta, ...hints[name] } } : config,
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
