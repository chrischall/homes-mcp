import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';
import type { SessionRegistry } from '../sessions.js';

/**
 * Caller-facing surface for the SessionRegistry (#20, #21). Three
 * tools:
 *
 * - homes_get_session_context — diagnostic: every registered session
 *   and which one is active.
 * - homes_register_session — adds a logical session label (typically
 *   one per browser-tab / account the user is signed into).
 * - homes_set_active_session — switches which registered session
 *   counts as "active" for narration purposes.
 *
 * Important caveat surfaced in the tool descriptions: the physical
 * fetchproxy bridge still routes to whichever browser tab the
 * extension is bound to right now — the registry is a labelled-
 * context layer the caller uses to track which account it's working
 * with, not a transport-level multiplexer.
 */

export function registerSessionsTools(
  server: McpServer,
  registry: SessionRegistry
): void {
  server.registerTool(
    'homes_get_session_context',
    {
      title: 'List all registered homes.com sessions',
      description:
        "Returns every registered logical session plus the active session id. Useful when working across multiple homes.com accounts: callers can confirm the right account is active before running an account-scoped tool (e.g. homes_get_saved_homes). NOTE: the underlying fetchproxy bridge physically routes to ONE browser tab at a time, so 'active' here means the labelled context for narration; the user is responsible for ensuring the browser is signed into the matching account. Read-only.",
      annotations: {
        title: 'List all registered homes.com sessions',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => {
      return textResult(registry.getContext());
    }
  );

  server.registerTool(
    'homes_register_session',
    {
      title: 'Register an additional logical homes.com session',
      description:
        "Adds a new session entry with an optional `account_hint` label (typically the account email or a free-text 'work'/'personal' marker). Returns the new `session_id` and whether it was marked active. Pass `mark_active: true` to flip the active session in the same call. NOTE: this is a label-only registry; the underlying fetchproxy bridge still routes to whichever browser tab is bound right now. The user is responsible for switching the browser session to match the active label.",
      annotations: {
        title: 'Register an additional logical homes.com session',
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        account_hint: z
          .string()
          .optional()
          .describe(
            'Free-text label for the session (account email, "work", "personal"). Surfaced verbatim in homes_get_session_context.'
          ),
        mark_active: z
          .boolean()
          .optional()
          .default(false)
          .describe('When true, the new session becomes the active one immediately.'),
      },
    },
    async ({ account_hint, mark_active }) => {
      const id = registry.register({
        account_hint,
        markActive: mark_active,
      });
      return textResult({
        session_id: id,
        active: registry.activeSessionId() === id,
      });
    }
  );

  server.registerTool(
    'homes_set_active_session',
    {
      title: 'Switch the active homes.com session',
      description:
        "Sets the active session to `session_id`. The id must come from a prior homes_register_session call (or the default session that every process starts with). Errors when the id was never registered.",
      annotations: {
        title: 'Switch the active homes.com session',
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        session_id: z
          .string()
          .describe(
            'Session id to make active. Get valid ids from homes_get_session_context.'
          ),
      },
    },
    async ({ session_id }) => {
      registry.setActive(session_id);
      return textResult({ active_session_id: registry.activeSessionId() });
    }
  );
}
