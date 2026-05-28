/**
 * Pure helpers for derived fields surfaced on every formatted property
 * record. These lift math the caller would otherwise redo per-listing
 * (#15 HOA normalization, #16 days_on_market + price_drop, #17 tax
 * sentinel cleanup, #22 portal_url_hyperlink). Kept separate from the
 * tool wiring so each rule can be unit-tested in isolation.
 */

/**
 * Google-Sheets `HYPERLINK` formula pointing at the listing's URL.
 * Pasting the returned string into a Sheets cell renders as a clickable
 * "Homes" link. Always present on formatted records (#22).
 */
export function buildPortalUrlHyperlink(url: string): string {
  // Double up any embedded `"` so the formula parses. Sheets uses
  // doubled quotes to escape inside a string literal.
  const escaped = url.replace(/"/g, '""');
  return `=HYPERLINK("${escaped}","Homes")`;
}

/**
 * Convert an HOA amount + frequency string to monthly USD, rounded to
 * the nearest dollar. Returns `null` for unknown frequency strings
 * (with a stderr warning so unknowns don't go unnoticed) or when
 * inputs are absent (#15).
 */
export function hoaToMonthlyUsd(
  amount: number | undefined,
  frequency: string | undefined
): number | null {
  if (typeof amount !== 'number') return null;
  if (!frequency) return null;
  const f = frequency.trim().toLowerCase();
  let monthly: number;
  // Accept the common label set used across MLS feeds + DOM scrapes.
  // The function is tolerant of `/` and case ("/month", "Monthly",
  // "per month") so the same rule can drive both JSON-LD-shaped feeds
  // and DOM-scraped strings like "HOA Fee: $250 / month".
  if (/^month/.test(f) || /per ?month/.test(f) || /\/ ?month/.test(f)) {
    monthly = amount;
  } else if (/^annual/.test(f) || /^year/.test(f) || /\/ ?year/.test(f)) {
    monthly = amount / 12;
  } else if (/^quarter/.test(f) || /\/ ?quarter/.test(f)) {
    monthly = amount / 3;
  } else if (/^semi.?annual/.test(f) || /bi.?annual/.test(f)) {
    monthly = amount / 6;
  } else if (/^week/.test(f) || /\/ ?week/.test(f)) {
    monthly = (amount * 52) / 12;
  } else {
    console.error(
      `[homes-mcp] hoa_monthly_usd: unknown frequency "${frequency}" — returning null`
    );
    return null;
  }
  return Math.round(monthly);
}

/**
 * Days between an ISO timestamp and now, floored. Returns `null` for
 * missing or unparseable input. Used to derive `days_on_market` from
 * `datePosted`-style timestamps (#16).
 */
export function daysSince(at: string | undefined): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Compute `{ amount, percent }` for the gap between previous + current
 * list price. `percent` rounded to 0.1. Returns nulls when either input
 * is missing. Negative values mean price went up — callers can filter
 * if they only want drops (#16).
 */
export function computePriceDrop(
  previous: number | undefined,
  current: number | undefined
): { amount: number | null; percent: number | null } {
  if (typeof previous !== 'number' || typeof current !== 'number') {
    return { amount: null, percent: null };
  }
  const amount = previous - current;
  // Avoid div-by-zero when previous is 0 (would never happen for real
  // listings but the type allows it). Treat as no info.
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
 */
export function isTaxSentinel(value: number | undefined): boolean {
  if (typeof value !== 'number') return false;
  return value < 10;
}

/** Square feet in one acre (US survey acre). */
export const SQFT_PER_ACRE = 43_560;

/**
 * Convert a lot size in square feet to acres, rounded to 2 decimals —
 * `round(sqft / 43560, 2)`. Acreage is the unit that matters for
 * rural / mountain / land listings, so every property record carries it
 * alongside the raw `lot_size_sqft` (#82).
 *
 * This is the canonical guarded contract standardized across the
 * real-estate MCP cohort (realty-mcp#7, redfin #81, zillow #93,
 * compass #81, onehome #49). Null-safe by design: returns `null` for
 * any non-positive, missing, or non-finite input (condos with no lot,
 * absent data, NaN) — never `0`, so callers can tell "no lot" apart
 * from a real "0 acre" lot. A positive lot too small to round to a
 * non-zero 2dp acreage (< ~218 sqft) also collapses to `null`, NOT 0,
 * so a non-null result is always > 0.
 *
 * @example lotSizeAcres(45_738) // 1.05
 * @example lotSizeAcres(13_503) // 0.31
 * @example lotSizeAcres(200)    // null (rounds to 0.00 → null, never 0)
 * @example lotSizeAcres(null)   // null
 */
export function lotSizeAcres(
  sqft: number | undefined | null
): number | null {
  if (typeof sqft !== 'number' || !Number.isFinite(sqft) || sqft <= 0) {
    return null;
  }
  const acres = Math.round((sqft / SQFT_PER_ACRE) * 100) / 100;
  return acres > 0 ? acres : null;
}
