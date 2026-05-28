import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withDeadline } from '@fetchproxy/server';

/**
 * `withDeadline` is the building block for the per-request and overall
 * deadlines added in #54. As of @fetchproxy/server 0.10.0 it's imported
 * from the dep (promoted from homes-mcp's local `src/tools/deadline.ts`
 * in fetchproxy#86); this test keeps the original behavioral parity bar
 * against the adopted implementation. It races a promise against a timer
 * and resolves to a discriminated `{ timedOut }` envelope instead of
 * throwing — callers decide how to mark a timed-out row. Crucially it
 * must clear its timer on the happy path so it never keeps the event
 * loop alive, and must not reject when the inner promise rejects (the
 * rejection is forwarded so per-row try/catch still works).
 */

describe('withDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with the inner value before the deadline fires', async () => {
    const inner = Promise.resolve('done');
    const p = withDeadline(inner, 1000);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ timedOut: false, value: 'done' });
  });

  it('resolves with { timedOut: true } when the inner promise never settles', async () => {
    const never = new Promise<string>(() => {});
    const p = withDeadline(never, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ timedOut: true });
  });

  it('forwards inner rejection (does not swallow it into a timeout)', async () => {
    // Reject on a microtask so the handler `withDeadline` attaches owns
    // the rejection — a bare `Promise.reject(...)` literal would log an
    // unhandled-rejection warning before the race wires up.
    const boom = (async () => {
      throw new Error('boom');
    })();
    const p = withDeadline(boom, 1000);
    await expect(p).rejects.toThrow('boom');
  });

  it('clears its timer once the inner promise settles', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const inner = Promise.resolve(42);
    await withDeadline(inner, 5000);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
