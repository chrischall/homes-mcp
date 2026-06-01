/**
 * Small helpers for shaping tool responses that the MCP SDK expects.
 *
 * `textResult` now lives in `@chrischall/mcp-utils` (the generic MCP glue
 * hoisted out of the ~19-server fleet) — the local copy was byte-identical.
 * We re-export it here so every `homes_*` tool keeps importing it from
 * `./mcp.js` without churn.
 */
export { textResult } from '@chrischall/mcp-utils';
