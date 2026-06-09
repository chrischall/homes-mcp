import { parse, type HTMLElement } from 'node-html-parser';

export { HTMLElement };

// The heading-anchored scrapers below were hoisted from this file into
// @chrischall/mcp-utils/html (shared across the realty cohort). They are
// re-exported here so this module stays the single import surface for
// call sites and tests:
//
//   - `parsePropertyTable(root, heading)` fuses the old local trio
//     findTableByHeading / tableHeaderCells / tableRows into one
//     `{ headers, rows } | null` — same heading walk, same <thead>
//     scoping, same `<th scope="row">`-aware row collection.
//   - `findLinksUnderHeading` is the old local helper, slightly
//     improved: direct-sibling elements are matched against the custom
//     `selector` too (the local copy hardcoded `tagName === 'A'`).
//
// The numeric/date normalizers further down have no upstream home and
// stay local.
export {
  parsePropertyTable,
  findLinksUnderHeading,
  type PropertyTable,
} from '@chrischall/mcp-utils/html';

/** Parse a fragment or full document into a queryable root element. */
export function parseHtml(html: string): HTMLElement {
  return parse(html, { lowerCaseTagName: false, comment: false });
}

/**
 * Normalize a homes.com date to ISO 8601 `YYYY-MM-DD`. Always returns
 * `raw`; adds `iso` when parse succeeds.
 *
 * Accepts:
 *   - "MM/DD/YYYY"
 *   - "MM/DD/YY" (50-year window: 00–49 → 20xx, 50–99 → 19xx)
 *   - bare "YYYY" (→ Jan 1)
 *
 * Tolerates extra content around the date, because real homes.com cells
 * often contain BOTH a long-date span and a short-date span side-by-side
 * (e.g. `04/30/2026 04/05/26`). We prefer the 4-digit-year form when
 * present, fall back to the 2-digit form, and only bare-year as a last
 * resort.
 */
export function normalizeDate(raw: string): { iso?: string; raw: string } {
  const trimmed = raw.trim();
  let m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return { raw, iso: `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` };
  }
  m = /(\d{1,2})\/(\d{1,2})\/(\d{2})\b/.exec(trimmed);
  if (m) {
    const [, mm, dd, yy] = m;
    const n = Number(yy);
    const century = n < 50 ? '20' : '19';
    return { raw, iso: `${century}${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` };
  }
  m = /^(\d{4})$/.exec(trimmed);
  if (m) {
    return { raw, iso: `${m[1]}-01-01` };
  }
  return { raw };
}

const EMPTY = new Set(['', '--', 'N/A', 'n/a', 'NA']);

export function parseDollar(raw: string): number | undefined {
  const v = raw.trim();
  if (EMPTY.has(v)) return undefined;
  const cleaned = v.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

export function parsePercent(raw: string): number | undefined {
  const v = raw.trim();
  if (EMPTY.has(v)) return undefined;
  const cleaned = v.replace(/[^0-9.+\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

export function parseIntegerLoose(raw: string): number | undefined {
  const v = raw.trim();
  if (EMPTY.has(v)) return undefined;
  const cleaned = v.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}

/**
 * Like `parseIntegerLoose` but keeps a fractional component — for fields
 * that are legitimately non-integer, e.g. bath counts ("3.5 ba"). Strips
 * everything but digits, a sign, and the decimal point, then guards the
 * EMPTY sentinels and a finite result. Returns `undefined` (never `0`)
 * for "--"/"N/A"/""/multi-dot junk so the absent case stays absent
 * rather than masquerading as a real `0`.
 */
export function parseDecimalLoose(raw: string): number | undefined {
  const v = raw.trim();
  if (EMPTY.has(v)) return undefined;
  const cleaned = v.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}
