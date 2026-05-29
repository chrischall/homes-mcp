/**
 * Tests for the homes-mcp adapter layer over the canonical
 * `@chrischall/realty-core` derivations (#15, #16, #17, #22, #82).
 *
 * The underlying math now lives in realty-core (which tests it directly);
 * what stays here is coverage of the homes-mcp-specific *contract* the
 * adapters preserve: the "Homes" hyperlink label, the always-present
 * `{ amount, percent }` price-drop shape with rise/equal handling, the
 * `hoa_monthly_usd: 0` "No HOA" case, and the boolean `isTaxSentinel`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildPortalUrlHyperlink,
  computePriceDrop,
  hoaToMonthlyUsd,
  isTaxSentinel,
} from '../src/format.js';

describe('buildPortalUrlHyperlink (adapter — "Homes" label)', () => {
  it('wraps a URL in Sheets HYPERLINK syntax with "Homes" label', () => {
    const url = 'https://www.homes.com/property/x/abc/';
    expect(buildPortalUrlHyperlink(url)).toBe(`=HYPERLINK("${url}","Homes")`);
  });

  it('escapes double quotes inside the URL', () => {
    // Highly unlikely but defensive — Sheets formulas break on bare quotes.
    expect(buildPortalUrlHyperlink('https://x.com/?q="a"')).toContain('""a""');
  });
});

describe('hoaToMonthlyUsd (adapter — "No HOA" zero case)', () => {
  it('returns annual amount divided by 12, rounded', () => {
    expect(hoaToMonthlyUsd(4967, 'Annually')).toBe(414);
  });
  it('returns amount as-is for Monthly', () => {
    expect(hoaToMonthlyUsd(250, 'Monthly')).toBe(250);
  });
  it('returns null and warns on unknown frequency', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(hoaToMonthlyUsd(100, 'Whenever')).toBe(null);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown'));
    spy.mockRestore();
  });
  it('returns null when amount is missing', () => {
    expect(hoaToMonthlyUsd(undefined, 'Monthly')).toBe(null);
  });
  it('returns null when frequency is missing', () => {
    expect(hoaToMonthlyUsd(100, undefined)).toBe(null);
  });
  it('treats amount 0 with a known frequency as 0 monthly (homes "No HOA" delta)', () => {
    // homes.com renders "No HOA" as hoa_fee: 0 / frequency: 'month'. The
    // canonical core returns null for a zero amount (treats it as absent);
    // the homes adapter surfaces it as a real 0 so callers see "$0/mo".
    expect(hoaToMonthlyUsd(0, 'Monthly')).toBe(0);
  });
});

describe('computePriceDrop (adapter — always-present {amount, percent})', () => {
  it('computes drop amount + percent (rounded to 0.1)', () => {
    expect(computePriceDrop(500000, 480000)).toEqual({ amount: 20000, percent: 4.0 });
  });
  it('returns nulls when current is missing', () => {
    expect(computePriceDrop(500000, undefined)).toEqual({ amount: null, percent: null });
  });
  it('returns nulls when previous is missing', () => {
    expect(computePriceDrop(undefined, 480000)).toEqual({ amount: null, percent: null });
  });
  it('returns 0/0 when previous equals current (no drop)', () => {
    expect(computePriceDrop(500000, 500000)).toEqual({ amount: 0, percent: 0 });
  });
  it('returns negative numbers for price increases (callers can filter)', () => {
    expect(computePriceDrop(400000, 500000)).toEqual({ amount: -100000, percent: -25.0 });
  });
});

describe('isTaxSentinel (adapter — boolean over cleanTaxAnnual)', () => {
  it('treats $0 as a sentinel (not a real assessed value)', () => {
    expect(isTaxSentinel(0)).toBe(true);
  });
  it('treats $1 as a sentinel', () => {
    expect(isTaxSentinel(1)).toBe(true);
  });
  it('treats sub-$10 values as sentinels', () => {
    expect(isTaxSentinel(9)).toBe(true);
  });
  it('treats $10 and up as real values', () => {
    expect(isTaxSentinel(10)).toBe(false);
    expect(isTaxSentinel(4500)).toBe(false);
  });
  it('returns false for undefined (no value to flag)', () => {
    expect(isTaxSentinel(undefined)).toBe(false);
  });
});
