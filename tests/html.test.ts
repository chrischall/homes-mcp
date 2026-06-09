import { describe, it, expect } from 'vitest';
import {
  parseHtml,
  parsePropertyTable,
  findLinksUnderHeading,
  normalizeDate,
  parseDollar,
  parsePercent,
  parseIntegerLoose,
  parseDecimalLoose,
} from '../src/html.js';
import * as upstream from '@chrischall/mcp-utils/html';

// The heading-anchored table/link scrapers were hoisted from this file
// into @chrischall/mcp-utils/html and are now re-exported here. Pin the
// re-export identity so a local copy can't silently fork again.
describe('shared-helper re-exports', () => {
  it('parsePropertyTable is the @chrischall/mcp-utils/html export', () => {
    expect(parsePropertyTable).toBe(upstream.parsePropertyTable);
  });
  it('findLinksUnderHeading is the @chrischall/mcp-utils/html export', () => {
    expect(findLinksUnderHeading).toBe(upstream.findLinksUnderHeading);
  });
});

// These cases previously tested the local findTableByHeading /
// tableHeaderCells / tableRows trio; upstream fuses them into
// parsePropertyTable. Kept as integration pins — they now exercise the
// upstream code through the src/html.ts re-export.
describe('parsePropertyTable', () => {
  // Mirrors the real homes.com shape: `<th scope="row">` for the first
  // cell of every data row (year/date column), `<td>` for the rest.
  // Verified live 2026-05-26.
  const html = `
    <html><body>
      <section>
        <h2>Tax History</h2>
        <table>
          <thead><tr><th>Year</th><th>Tax Paid</th><th>Assessment</th></tr></thead>
          <tbody>
            <tr><th scope="row">2025</th><td>$2,714</td><td>$72,520</td></tr>
            <tr><th scope="row">2024</th><td>$2,500</td><td>$70,000</td></tr>
          </tbody>
        </table>
      </section>
      <section>
        <h2>Other</h2>
        <table><tbody><tr><td>x</td></tr></tbody></table>
      </section>
    </body></html>`;

  it('locates the table after a matching heading', () => {
    const root = parseHtml(html);
    expect(parsePropertyTable(root, 'Tax History')).not.toBeNull();
  });

  it('returns null when no matching heading exists', () => {
    const root = parseHtml(html);
    expect(parsePropertyTable(root, 'Climate Risk')).toBeNull();
  });

  it('reads header cells from <thead> only — ignoring th cells inside tbody data rows', () => {
    const root = parseHtml(html);
    const t = parsePropertyTable(root, 'Tax History')!;
    expect(t.headers).toEqual(['Year', 'Tax Paid', 'Assessment']);
  });

  it('reads tbody rows including the leading <th scope="row"> cell', () => {
    const root = parseHtml(html);
    const t = parsePropertyTable(root, 'Tax History')!;
    expect(t.rows).toEqual([
      ['2025', '$2,714', '$72,520'],
      ['2024', '$2,500', '$70,000'],
    ]);
  });

  it('case-insensitive heading match', () => {
    const root = parseHtml(html);
    expect(parsePropertyTable(root, 'tax history')).not.toBeNull();
  });
});

describe('findLinksUnderHeading', () => {
  const html = `
    <h2>Homes for Sale Near This Property</h2>
    <div>
      <a href="/property/x/abc/">A</a>
      <a href="/property/x/def/">B</a>
      <a href="https://other.com/">C</a>
    </div>
    <h2>Footer</h2>
    <a href="/anything/">Z</a>`;

  it('returns links that follow a matching heading, scoped before the next heading', () => {
    const root = parseHtml(html);
    const links = findLinksUnderHeading(root, 'Homes for Sale');
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/property/x/abc/');
    expect(hrefs).toContain('/property/x/def/');
    expect(hrefs).not.toContain('/anything/');
  });

  it('returns [] when no matching heading', () => {
    const root = parseHtml(html);
    expect(findLinksUnderHeading(root, 'Climate')).toEqual([]);
  });

  it('honors a custom selector for direct-sibling elements (upstream improvement)', () => {
    // The local copy hardcoded `tagName === 'A'` for direct siblings, so a
    // custom selector only applied to nested elements. The upstream helper
    // matches direct siblings against the selector too.
    const root = parseHtml(`
      <h2>Nearby</h2>
      <a class="card" href="/one/">One</a>
      <div><a class="card" href="/two/">Two</a><a href="/plain/">Plain</a></div>
      <h2>Footer</h2>
      <a class="card" href="/footer/">F</a>`);
    const hrefs = findLinksUnderHeading(root, 'Nearby', 'a.card').map((a) =>
      a.getAttribute('href')
    );
    expect(hrefs).toEqual(['/one/', '/two/']);
  });
});

describe('normalizeDate', () => {
  it('parses MM/DD/YYYY', () => {
    expect(normalizeDate('04/30/2026')).toEqual({ iso: '2026-04-30', raw: '04/30/2026' });
  });
  it('parses MM/DD/YY with 50-year window: <50 → 20xx', () => {
    expect(normalizeDate('05/04/22')).toEqual({ iso: '2022-05-04', raw: '05/04/22' });
  });
  it('parses MM/DD/YY with 50-year window: ≥50 → 19xx', () => {
    expect(normalizeDate('06/15/85')).toEqual({ iso: '1985-06-15', raw: '06/15/85' });
  });
  it('parses 4-digit year alone', () => {
    expect(normalizeDate('2024')).toEqual({ iso: '2024-01-01', raw: '2024' });
  });
  it('returns only raw for unparseable input', () => {
    expect(normalizeDate('not a date')).toEqual({ raw: 'not a date' });
  });

  it('extracts the first MM/DD/YYYY when long+short dates appear side-by-side', () => {
    // homes.com renders <span class="long-date">04/30/2026</span><span class="short-date">04/05/26</span>
    // inside Property History cells; cell.text concatenates both.
    expect(normalizeDate('04/30/2026 04/05/26')).toEqual({
      iso: '2026-04-30',
      raw: '04/30/2026 04/05/26',
    });
  });

  it('falls back to MM/DD/YY when no MM/DD/YYYY is present', () => {
    expect(normalizeDate(' 05/04/22 ')).toEqual({
      iso: '2022-05-04',
      raw: ' 05/04/22 ',
    });
  });
});

describe('parseDollar / parsePercent / parseIntegerLoose', () => {
  it('parseDollar strips $ and commas', () => {
    expect(parseDollar('$2,714')).toBe(2714);
    expect(parseDollar('$1,000,000')).toBe(1000000);
  });
  it('parseDollar returns undefined for "--" / "N/A" / ""', () => {
    expect(parseDollar('--')).toBeUndefined();
    expect(parseDollar('N/A')).toBeUndefined();
    expect(parseDollar('')).toBeUndefined();
  });
  it('parsePercent strips % sign and handles negatives', () => {
    expect(parsePercent('-5.8%')).toBe(-5.8);
    expect(parsePercent('+12.5%')).toBe(12.5);
  });
  it('parseIntegerLoose strips commas', () => {
    expect(parseIntegerLoose('87,346')).toBe(87346);
  });

  it('parseDecimalLoose keeps fractional values (e.g. baths "3.5 ba")', () => {
    expect(parseDecimalLoose('3.5 ba')).toBe(3.5);
    expect(parseDecimalLoose('2 ba')).toBe(2);
  });

  it('parseDecimalLoose returns undefined for "--" / "N/A" / "" (no 0 leak)', () => {
    // The old inline saved.ts parser returned 0 for these because
    // Number("") is 0 — baths got set to 0 instead of being omitted.
    expect(parseDecimalLoose('--')).toBeUndefined();
    expect(parseDecimalLoose('N/A')).toBeUndefined();
    expect(parseDecimalLoose('')).toBeUndefined();
  });

  it('parseDecimalLoose returns undefined for multi-dot junk', () => {
    expect(parseDecimalLoose('2.5.3')).toBeUndefined();
  });
});
