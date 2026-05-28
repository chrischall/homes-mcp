/**
 * Tests for shared formatting derivations added in PR 2 (#15, #16, #17,
 * #22, #23). Covers pure helpers individually so the integration paths
 * in tools/properties.test.ts and tools/compare.test.ts can stay
 * focused on tool wiring.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildPortalUrlHyperlink,
  computePriceDrop,
  daysSince,
  hoaToMonthlyUsd,
  isTaxSentinel,
  lotSizeAcres,
} from '../src/format.js';

describe('buildPortalUrlHyperlink', () => {
  it('wraps a URL in Sheets HYPERLINK syntax with "Homes" label', () => {
    const url = 'https://www.homes.com/property/x/abc/';
    expect(buildPortalUrlHyperlink(url)).toBe(`=HYPERLINK("${url}","Homes")`);
  });

  it('escapes double quotes inside the URL', () => {
    // Highly unlikely but defensive — Sheets formulas break on bare quotes.
    expect(buildPortalUrlHyperlink('https://x.com/?q="a"')).toContain('""a""');
  });
});

describe('hoaToMonthlyUsd', () => {
  it('returns annual amount divided by 12, rounded', () => {
    expect(hoaToMonthlyUsd(4967, 'Annually')).toBe(414);
  });
  it('returns amount as-is for Monthly', () => {
    expect(hoaToMonthlyUsd(250, 'Monthly')).toBe(250);
  });
  it('divides quarterly amounts by 3', () => {
    expect(hoaToMonthlyUsd(300, 'Quarterly')).toBe(100);
  });
  it('divides semi-annual amounts by 6', () => {
    expect(hoaToMonthlyUsd(600, 'SemiAnnually')).toBe(100);
  });
  it('converts weekly via amount * 52 / 12', () => {
    expect(hoaToMonthlyUsd(50, 'Weekly')).toBe(Math.round((50 * 52) / 12));
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
  it('treats amount 0 as 0 monthly (No HOA case)', () => {
    expect(hoaToMonthlyUsd(0, 'Monthly')).toBe(0);
  });
});

describe('daysSince', () => {
  it('returns days between iso timestamp and now', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(daysSince(thirtyDaysAgo)).toBe(30);
  });
  it('returns null for missing input', () => {
    expect(daysSince(undefined)).toBe(null);
  });
  it('returns null for unparseable input', () => {
    expect(daysSince('not a date')).toBe(null);
  });
});

describe('computePriceDrop', () => {
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

describe('isTaxSentinel', () => {
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

describe('lotSizeAcres', () => {
  // Canonical guarded conversion shared across the real-estate MCP
  // cohort (realty-mcp#7, redfin #81, zillow #93, compass #81,
  // onehome #49; homes #82). round(sqft / 43560, 2), null-safe.
  it('45,738 sq ft → 1.05 acres', () => {
    // 45738 / 43560 = 1.0499… → rounds to 1.05
    expect(lotSizeAcres(45_738)).toBe(1.05);
  });
  it('13,503 sq ft → 0.31 acres', () => {
    expect(lotSizeAcres(13_503)).toBe(0.31);
  });
  it('94,089 sq ft → 2.16 acres', () => {
    expect(lotSizeAcres(94_089)).toBe(2.16);
  });
  it('43,560 sq ft → exactly 1.0 acre', () => {
    expect(lotSizeAcres(43_560)).toBe(1.0);
  });
  it('a tiny lot too small to round to a non-zero 2dp → null (never 0)', () => {
    // 200 / 43560 = 0.0046… → rounds to 0.00. The invariant is that a
    // non-null result is always > 0, so this collapses to null, NOT 0.
    expect(lotSizeAcres(200)).toBeNull();
  });
  it('non-positive → null', () => {
    expect(lotSizeAcres(0)).toBeNull();
    expect(lotSizeAcres(-1)).toBeNull();
  });
  it('missing / non-finite → null', () => {
    expect(lotSizeAcres(undefined)).toBeNull();
    expect(lotSizeAcres(null)).toBeNull();
    expect(lotSizeAcres(NaN)).toBeNull();
    expect(lotSizeAcres(Infinity)).toBeNull();
  });
});
