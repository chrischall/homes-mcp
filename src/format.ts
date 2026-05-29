/**
 * Pure helpers for derived fields surfaced on every formatted property
 * record. These lift math the caller would otherwise redo per-listing
 * (#15 HOA normalization, #16 days_on_market + price_drop, #17 tax
 * sentinel cleanup, #22 portal_url_hyperlink, #82 lot_size_acres).
 *
 * The underlying math now lives in `@chrischall/realty-core` (the
 * cohort migration, realty-mcp#1) — every cohort MCP had a copy of these
 * helpers. This module is now a thin homes-mcp adapter layer over the
 * canonical core: it preserves homes-mcp's exact output contract
 * (portal label "Homes", the always-present `{ amount, percent }`
 * price-drop shape with rise/equal handling, the `hoa_monthly_usd: 0`
 * "No HOA" case, the boolean `isTaxSentinel`) while delegating the
 * underlying derivation to the shared core.
 */

import {
  buildHyperlinkFormula,
  hoaToMonthlyUsd as coreHoaToMonthlyUsd,
  priceDrop,
  cleanTaxAnnual,
  sqftToAcres,
  SQFT_PER_ACRE as CORE_SQFT_PER_ACRE,
} from '@chrischall/realty-core';

// Re-exported verbatim from the canonical core — homes-mcp's inline
// copies were behavior-identical, so these are bare passthroughs.
//
//  - `daysSince`: homes called `Date.now()` unconditionally; the core's
//    `now` argument defaults to `Date.now()`, so the one-arg call sites
//    are unchanged.
//  - `sqftToAcres` (homes's `lotSizeAcres`): same guarded
//    `round(sqft / 43560, 2)` contract, sub-218-sqft → null.
//  - `SQFT_PER_ACRE`: the 43,560 constant (also used to derive sqft from
//    an acres-only Lot-Details line in properties.ts).
export { daysSince } from '@chrischall/realty-core';
export const SQFT_PER_ACRE = CORE_SQFT_PER_ACRE;

/**
 * Convert a lot size in square feet to acres, rounded to 2 decimals.
 * Thin alias over the canonical `sqftToAcres` (#82) — null-safe, returns
 * `null` for any non-positive / missing / non-finite input and for a
 * positive lot too small to round to a non-zero 2dp acreage.
 */
export function lotSizeAcres(
  sqft: number | undefined | null
): number | null {
  return sqftToAcres(sqft);
}

/**
 * Google-Sheets `HYPERLINK` formula pointing at the listing's URL.
 * Pasting the returned string into a Sheets cell renders as a clickable
 * "Homes" link. Always present on formatted records (#22).
 *
 * Thin adapter over the canonical `buildHyperlinkFormula`, pinning the
 * portal label to "Homes".
 */
export function buildPortalUrlHyperlink(url: string): string {
  return buildHyperlinkFormula(url, 'Homes');
}

/**
 * Convert an HOA amount + frequency string to monthly USD, rounded to
 * the nearest dollar. Returns `null` for unknown frequency strings
 * (with a stderr warning so unknowns don't go unnoticed) or when
 * inputs are absent (#15).
 *
 * Adapter over the canonical `hoaToMonthlyUsd`. The one homes-specific
 * delta: a `$0` fee with a known frequency is a real "No HOA" signal
 * (homes.com renders "No HOA", which the parser maps to
 * `hoa_fee: 0, hoa_frequency: 'month'`), so it surfaces as `0`, not the
 * core's `null` (which treats a zero amount as absent).
 */
export function hoaToMonthlyUsd(
  amount: number | undefined,
  frequency: string | undefined
): number | null {
  if (amount === 0 && frequency) return 0;
  return coreHoaToMonthlyUsd(amount, frequency);
}

/**
 * Compute `{ amount, percent }` for the gap between previous + current
 * list price. `percent` rounded to 0.1. Returns nulls when either input
 * is missing. Negative values mean price went up — callers can filter
 * if they only want drops (#16).
 *
 * Adapter over the canonical `priceDrop`, which returns a single `null`
 * for any non-drop. homes-mcp's contract is the always-present object
 * (with `null`s / negatives / zero), so we reconstruct the non-drop
 * branches here while delegating the real-drop math to the core.
 */
export function computePriceDrop(
  previous: number | undefined,
  current: number | undefined
): { amount: number | null; percent: number | null } {
  if (typeof previous !== 'number' || typeof current !== 'number') {
    return { amount: null, percent: null };
  }
  const drop = priceDrop(previous, current);
  if (drop) return drop;
  // No real drop per the core (current >= previous, or previous <= 0).
  // homes-mcp still surfaces the gap so callers see rises / no-change.
  const amount = previous - current;
  // Match the legacy contract: no division base when previous is 0.
  if (previous === 0) return { amount, percent: null };
  const percent = Math.round((amount / previous) * 1000) / 10;
  return { amount, percent };
}

/**
 * Whether a `tax_annual` value is a not-yet-assessed placeholder rather
 * than a real assessed amount. Real-world session saw three new-build
 * listings come back with `tax_annual: 1` from sister MCPs; treat any
 * sub-$10 value (or 0) the same way for safety (#17). Callers should
 * substitute `null` when this returns true.
 *
 * Boolean adapter over the canonical `cleanTaxAnnual` — homes-mcp's
 * `< 10` threshold IS the canonical one (`TAX_SENTINEL_THRESHOLD`), so
 * this is behavior-preserving: a sentinel is exactly the input the core
 * classifies as `not_yet_assessed`. A missing / non-finite value is
 * "absent", not a sentinel.
 */
export function isTaxSentinel(value: number | undefined): boolean {
  return cleanTaxAnnual(value).tax_status === 'not_yet_assessed';
}
