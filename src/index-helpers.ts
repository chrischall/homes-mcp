/**
 * Small pure helpers for the entrypoint (`src/index.ts`), split out so
 * they're unit-testable without running the module's top-level boot
 * sequence (which constructs a transport and connects stdio).
 */

/**
 * Resolve the fetchproxy WebSocket port from the `HOMES_WS_PORT`
 * environment value.
 *
 * `Number("foo")` is `NaN` — which is truthy-by-presence yet not a
 * usable port; passing it through would hand the transport a bogus
 * value. Guard with `Number.isFinite` so anything that doesn't parse to
 * a real number falls back to `undefined` (the transport then picks its
 * own default, 37149).
 */
export function resolvePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  // Reject NaN/Infinity (the original bug) AND non-positive values — a
  // port must be a finite positive integer; anything else falls back to
  // the transport default.
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
