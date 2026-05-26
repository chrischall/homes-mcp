import { parse, type HTMLElement } from 'node-html-parser';

export { HTMLElement };

/** Parse a fragment or full document into a queryable root element. */
export function parseHtml(html: string): HTMLElement {
  return parse(html, { lowerCaseTagName: false, comment: false });
}

/**
 * Find the first <h1>/<h2>/<h3>/<h4> whose text contains `heading`
 * (case-insensitive), then return the nearest following <table>. Looks
 * at the heading's containing section first, then forward siblings.
 */
export function findTableByHeading(
  root: HTMLElement,
  heading: string
): HTMLElement | null {
  const needle = heading.trim().toLowerCase();
  const headings = root.querySelectorAll('h1, h2, h3, h4');
  for (const h of headings) {
    if (!h.text.toLowerCase().includes(needle)) continue;
    // 1. Search inside the heading's parent for a table.
    const parent = h.parentNode as HTMLElement | null;
    const inside = parent?.querySelector('table');
    if (inside) return inside;
    // 2. Walk forward siblings until a table or the next heading.
    let cur: HTMLElement | null = h.nextElementSibling as HTMLElement | null;
    while (cur) {
      if (/^H[1-4]$/.test(cur.tagName)) break;
      if (cur.tagName === 'TABLE') return cur;
      const nested = cur.querySelector('table');
      if (nested) return nested;
      cur = cur.nextElementSibling as HTMLElement | null;
    }
  }
  return null;
}

/** Trimmed text of every <th> in a table (header row), in document order. */
export function tableHeaderCells(table: HTMLElement): string[] {
  return table.querySelectorAll('th').map((th) => th.text.replace(/\s+/g, ' ').trim());
}

/** Each <tbody> row as a string[] of trimmed <td> text. Skips rows with no <td>. */
export function tableRows(table: HTMLElement): string[][] {
  const tbody = table.querySelector('tbody') ?? table;
  return tbody
    .querySelectorAll('tr')
    .map((tr) =>
      tr.querySelectorAll('td').map((td) => td.text.replace(/\s+/g, ' ').trim())
    )
    .filter((cells) => cells.length > 0);
}

/**
 * Find all <a> elements that follow a matching heading, up to (but not
 * including) the next sibling heading. Useful for "Homes for Sale"
 * link lists at the bottom of a detail page.
 */
export function findLinksUnderHeading(
  root: HTMLElement,
  heading: string,
  selector = 'a'
): HTMLElement[] {
  const needle = heading.trim().toLowerCase();
  const headings = root.querySelectorAll('h1, h2, h3, h4');
  for (const h of headings) {
    if (!h.text.toLowerCase().includes(needle)) continue;
    const out: HTMLElement[] = [];
    // Walk forward siblings until the next heading.
    let cur: HTMLElement | null = h.nextElementSibling as HTMLElement | null;
    while (cur) {
      if (/^H[1-4]$/.test(cur.tagName)) break;
      if (cur.tagName === 'A') out.push(cur);
      for (const a of cur.querySelectorAll(selector)) out.push(a);
      cur = cur.nextElementSibling as HTMLElement | null;
    }
    return out;
  }
  return [];
}

/**
 * Normalize a homes.com date to ISO 8601 `YYYY-MM-DD`. Always returns
 * `raw`; adds `iso` when parse succeeds.
 *
 * Accepted: "MM/DD/YYYY", "MM/DD/YY" (50-year window: 00–49 → 20xx,
 * 50–99 → 19xx), bare "YYYY" (→ Jan 1).
 */
export function normalizeDate(raw: string): { iso?: string; raw: string } {
  const trimmed = raw.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return { raw, iso: `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` };
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(trimmed);
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
