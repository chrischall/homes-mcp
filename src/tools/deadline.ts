/**
 * Deadline helpers for the resolver tools (#54).
 *
 * Background. `homes_resolve_addresses` hung ~4 min on a 60-address
 * batch then died with "No result received… server may be unresponsive
 * / crashed", and even a single `homes_get_by_address` started timing
 * out at the MCP layer (`-32001 Request timed out`). The MCP SDK gives
 * each tool call a finite request deadline (60s by default); a homes.com
 * fetch with no effective deadline shorter than that can wedge the whole
 * connection.
 *
 * `@fetchproxy/server` already applies a per-request `fetchTimeoutMs`
 * (default 30s) inside `request()`, so one stuck fetch *should* abort at
 * ~30s. But the resolver runs up to two fetch rungs per address (slug →
 * search fallback), so a single address can legitimately spend ~60s in
 * the transport before giving up — right at the MCP client's deadline.
 * And a bulk fan-out has no overall cap at all. We need our own
 * deadlines, comfortably below the MCP request timeout, that turn "hang
 * until the client kills the connection" into "return partial results
 * with per-row markers".
 *
 * These are pure helpers — no I/O, no logging. Timers are always
 * cleared so they never keep the event loop alive past the inner work.
 */

/**
 * Overall deadline for a whole `homes_resolve_addresses` fan-out. Below
 * the MCP SDK's default 60s request timeout so the handler always wins
 * the race and can return partial rows, rather than the client tearing
 * the connection down first with a `-32001`.
 */
export const RESOLVE_DEADLINE_MS = 50_000;

/**
 * Hard overall deadline for a single `homes_get_by_address` call. A
 * single address runs at most two fetch rungs, each bounded by the
 * transport's ~30s `fetchTimeoutMs`; without a wrapper that's up to ~60s,
 * which races the MCP client's own deadline. Cap it below that so a hung
 * fetch returns a clean `{ resolved: false, error: 'timeout' }` instead
 * of an infinite hang.
 */
export const SINGLE_RESOLVE_DEADLINE_MS = 45_000;

/** Discriminated outcome of a deadline race. */
export type DeadlineOutcome<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

/**
 * Race `inner` against a `ms` timer.
 *
 *   * Inner resolves first → `{ timedOut: false, value }`.
 *   * Timer fires first     → `{ timedOut: true }` (the inner promise is
 *                             left to settle in the background; its
 *                             eventual result/rejection is ignored).
 *   * Inner rejects first   → the rejection propagates (NOT folded into
 *                             a timeout) so per-row try/catch still sees
 *                             the real error.
 *
 * The timer is cleared as soon as either side wins, so a fast inner
 * promise never keeps the process alive for the full `ms`.
 */
export function withDeadline<T>(
  inner: Promise<T>,
  ms: number
): Promise<DeadlineOutcome<T>> {
  return new Promise<DeadlineOutcome<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    // Don't let the deadline timer hold the event loop open on its own.
    if (typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
    inner.then(
      (value) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ timedOut: false, value });
      },
      (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      }
    );
  });
}
