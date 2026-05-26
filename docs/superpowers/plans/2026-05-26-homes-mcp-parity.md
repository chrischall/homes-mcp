# homes-mcp v0.7 — Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring homes-mcp from 7 tools to 14 by adding price/tax/ownership/lien-history, saved homes & searches, market report, nearby listings, rent-vs-buy, plus extending search (typed filters) and get_property (richer fields).

**Architecture:** Each new tool lives in `src/tools/<name>.ts`, registered from `src/index.ts`. New shared `src/html.ts` exposes table / section / link / number-parsing helpers built on `node-html-parser`. Every network-bound tool uses the existing `HomesClient.fetchHtml` primitive, so the fetchproxy bridge stays the single source of HTTP auth. Tests mock `HomesClient.fetchHtml` with captured-HTML fixtures.

**Tech Stack:** TypeScript (ESM, NodeNext), `@modelcontextprotocol/sdk`, `zod`, `vitest`, new dep `node-html-parser`.

**Spec:** `docs/superpowers/specs/2026-05-26-homes-mcp-parity-design.md`.

---

## Task 0: Pre-flight

**Files:**
- Read: `docs/superpowers/specs/2026-05-26-homes-mcp-parity-design.md`
- Read: `CLAUDE.md`
- Read: `src/client.ts`, `src/page-state.ts`, `src/url.ts`, `src/mcp.ts`, `src/index.ts`
- Read: `tests/helpers.ts`, `tests/tools/search.test.ts` (reference for harness pattern)

- [ ] **Step 1: Read each file above so the patterns are loaded.** No edits.
- [ ] **Step 2: Run baseline test suite.**

```bash
cd /Users/chris/git/homes-mcp && npm test
```

Expected: all tests pass. If not, stop and report.

- [ ] **Step 3: Typecheck baseline.**

```bash
npx tsc --noEmit
```

Expected: zero errors.

---

## Task 1: Add `node-html-parser` dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (regenerated)

- [ ] **Step 1: Install the dependency.**

```bash
cd /Users/chris/git/homes-mcp && npm install node-html-parser@^7.0.1
```

Expected: `package.json` gets a `"node-html-parser": "^7.0.1"` entry under `dependencies`, lockfile updates.

- [ ] **Step 2: Confirm bundle still builds.**

```bash
npm run build
```

Expected: zero TS errors, `dist/bundle.js` rebuilt.

- [ ] **Step 3: Commit.**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add node-html-parser for SSR scraping"
```

---

## Task 2: HTML helpers (`src/html.ts` + tests)

**Files:**
- Create: `src/html.ts`
- Create: `tests/html.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `tests/html.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseHtml,
  findTableByHeading,
  tableHeaderCells,
  tableRows,
  findLinksUnderHeading,
  normalizeDate,
  parseDollar,
  parsePercent,
  parseIntegerLoose,
} from '../src/html.js';

describe('findTableByHeading + tableHeaderCells + tableRows', () => {
  const html = `
    <html><body>
      <section>
        <h2>Tax History</h2>
        <table>
          <thead><tr><th>Year</th><th>Tax Paid</th><th>Assessment</th></tr></thead>
          <tbody>
            <tr><td>2025</td><td>$2,714</td><td>$72,520</td></tr>
            <tr><td>2024</td><td>$2,500</td><td>$70,000</td></tr>
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
    const table = findTableByHeading(root, 'Tax History');
    expect(table).not.toBeNull();
  });

  it('returns null when no matching heading exists', () => {
    const root = parseHtml(html);
    expect(findTableByHeading(root, 'Climate Risk')).toBeNull();
  });

  it('reads header cells in document order', () => {
    const root = parseHtml(html);
    const t = findTableByHeading(root, 'Tax History')!;
    expect(tableHeaderCells(t)).toEqual(['Year', 'Tax Paid', 'Assessment']);
  });

  it('reads tbody rows as trimmed string arrays', () => {
    const root = parseHtml(html);
    const t = findTableByHeading(root, 'Tax History')!;
    expect(tableRows(t)).toEqual([
      ['2025', '$2,714', '$72,520'],
      ['2024', '$2,500', '$70,000'],
    ]);
  });

  it('case-insensitive heading match', () => {
    const root = parseHtml(html);
    expect(findTableByHeading(root, 'tax history')).not.toBeNull();
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
});
```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
npm test -- tests/html.test.ts
```

Expected: FAIL, "cannot find module ../src/html.js".

- [ ] **Step 3: Implement `src/html.ts`.**

```ts
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
  // MM/DD/YYYY
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return { raw, iso: `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` };
  }
  // MM/DD/YY
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(trimmed);
  if (m) {
    const [, mm, dd, yy] = m;
    const n = Number(yy);
    const century = n < 50 ? '20' : '19';
    return { raw, iso: `${century}${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` };
  }
  // Bare YYYY
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
```

- [ ] **Step 4: Run tests; expect PASS.**

```bash
npm test -- tests/html.test.ts
```

Expected: all 16 assertions pass.

- [ ] **Step 5: Typecheck.**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Commit.**

```bash
git add src/html.ts tests/html.test.ts
git commit -m "feat: add HTML scraping helpers (tables, sections, links, parsers)"
```

---

## Task 3: Extend `homes_search_properties` with `property_type` / `listing_type` / `sort`

**Files:**
- Modify: `src/tools/search.ts`
- Modify: `tests/tools/search.test.ts`

- [ ] **Step 1: Add failing tests at the bottom of `tests/tools/search.test.ts`.**

```ts
describe('buildSearchPath — extended filters', () => {
  it('property_type=single_family → /houses-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'single_family' })
    ).toBe('/atlanta-ga/houses-for-sale/');
  });

  it('property_type=condo → /condos-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', property_type: 'condo' })
    ).toBe('/brooklyn-ny/condos-for-sale/');
  });

  it('property_type=townhouse → /townhouses-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'townhouse' })
    ).toBe('/atlanta-ga/townhouses-for-sale/');
  });

  it('property_type=land → /land-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'land' })
    ).toBe('/atlanta-ga/land-for-sale/');
  });

  it('property_type=mobile → /mobile-homes-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'mobile' })
    ).toBe('/atlanta-ga/mobile-homes-for-sale/');
  });

  it('property_type=multi_family → /multi-family-for-sale/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', property_type: 'multi_family' })
    ).toBe('/atlanta-ga/multi-family-for-sale/');
  });

  it('listing_type=sold → /<city>/sold/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', listing_type: 'sold' })
    ).toBe('/brooklyn-ny/sold/');
  });

  it('listing_type=for_rent → /<city>/homes-for-rent/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', listing_type: 'for_rent' })
    ).toBe('/brooklyn-ny/homes-for-rent/');
  });

  it('listing_type=open_houses → /<city>/open-houses/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', listing_type: 'open_houses' })
    ).toBe('/brooklyn-ny/open-houses/');
  });

  it('listing_type=new_construction → /new-homes/for-sale/<city>/', () => {
    expect(
      buildSearchPath({ location: 'Brooklyn, NY', listing_type: 'new_construction' })
    ).toBe('/new-homes/for-sale/brooklyn-ny/');
  });

  it('property_type + listing_type=for_rent composes (condo → /condos-for-rent/)', () => {
    expect(
      buildSearchPath({
        location: 'Brooklyn, NY',
        property_type: 'condo',
        listing_type: 'for_rent',
      })
    ).toBe('/brooklyn-ny/condos-for-rent/');
  });

  it('property_type + listing_type=for_rent for apartments uses /apartments-for-rent/', () => {
    // homes.com uses "apartments" as a rent-only synonym for single_family rentals.
    // We expose this as property_type=single_family + listing_type=for_rent → houses-for-rent.
    expect(
      buildSearchPath({
        location: 'Brooklyn, NY',
        property_type: 'single_family',
        listing_type: 'for_rent',
      })
    ).toBe('/brooklyn-ny/houses-for-rent/');
  });

  it('sort=newest appends /newest/', () => {
    expect(
      buildSearchPath({ location: 'Atlanta, GA', sort: 'newest' })
    ).toBe('/atlanta-ga/newest/');
  });

  it('sort=newest with property_type composes', () => {
    expect(
      buildSearchPath({
        location: 'Atlanta, GA',
        property_type: 'condo',
        sort: 'newest',
      })
    ).toBe('/atlanta-ga/condos-for-sale/newest/');
  });

  it('listing_type=new_construction ignores sort + property_type (different URL space)', () => {
    expect(
      buildSearchPath({
        location: 'Brooklyn, NY',
        listing_type: 'new_construction',
        property_type: 'condo',
        sort: 'newest',
      })
    ).toBe('/new-homes/for-sale/brooklyn-ny/');
  });
});
```

- [ ] **Step 2: Run tests; expect FAIL with "property_type does not satisfy" or similar.**

```bash
npm test -- tests/tools/search.test.ts
```

Expected: FAIL on every new assertion.

- [ ] **Step 3: Replace the `SearchInput` interface and `buildSearchPath` in `src/tools/search.ts`.**

Find this in `src/tools/search.ts`:

```ts
export interface SearchInput {
  location: string;
  limit?: number;
}
```

Replace with:

```ts
export type PropertyType =
  | 'single_family'
  | 'condo'
  | 'townhouse'
  | 'land'
  | 'mobile'
  | 'multi_family';

export type ListingType =
  | 'for_sale'
  | 'sold'
  | 'for_rent'
  | 'open_houses'
  | 'new_construction';

export type SortOption = 'newest';

export interface SearchInput {
  location: string;
  limit?: number;
  property_type?: PropertyType;
  listing_type?: ListingType;
  sort?: SortOption;
}

const TYPE_TO_SLUG_SALE: Record<PropertyType, string> = {
  single_family: 'houses',
  condo: 'condos',
  townhouse: 'townhouses',
  land: 'land',
  mobile: 'mobile-homes',
  multi_family: 'multi-family',
};

const TYPE_TO_SLUG_RENT: Record<PropertyType, string> = {
  single_family: 'houses',
  condo: 'condos',
  townhouse: 'townhouses',
  land: 'land', // not a real homes.com path; falls back to /homes-for-rent/ below
  mobile: 'mobile-homes', // same
  multi_family: 'multi-family', // same
};
```

Then replace the existing `buildSearchPath` with:

```ts
/**
 * Build the `/<location>/[<segment>/[<sort>/]]` path for a search.
 *
 * homes.com routes locations like `/atlanta-ga/`, `/brooklyn-ny/`,
 * `/30311/` (ZIPs), with filter facets baked into the URL path:
 *
 *   /<city>/houses-for-sale/          property_type=single_family
 *   /<city>/condos-for-sale/          property_type=condo
 *   /<city>/townhouses-for-sale/      property_type=townhouse
 *   /<city>/land-for-sale/            property_type=land
 *   /<city>/mobile-homes-for-sale/    property_type=mobile
 *   /<city>/multi-family-for-sale/    property_type=multi_family
 *   /<city>/sold/                     listing_type=sold
 *   /<city>/homes-for-rent/           listing_type=for_rent (untyped)
 *   /<city>/condos-for-rent/          property_type=condo + listing_type=for_rent
 *   /<city>/open-houses/              listing_type=open_houses
 *   /new-homes/for-sale/<city>/       listing_type=new_construction
 *   /<city>/<segment>/newest/         sort=newest (appended)
 *
 * Verified by inspecting homes.com nav links on /brooklyn-ny/ (2026-05-26).
 */
export function buildSearchPath(input: SearchInput): string {
  const slug = locationToSlug(input.location);

  // new_construction has its own URL root; other params are ignored.
  if (input.listing_type === 'new_construction') {
    return `/new-homes/for-sale/${slug}/`;
  }

  let segment = '';
  if (input.listing_type === 'sold') {
    segment = 'sold';
  } else if (input.listing_type === 'open_houses') {
    segment = 'open-houses';
  } else if (input.listing_type === 'for_rent') {
    const typeSlug = input.property_type
      ? TYPE_TO_SLUG_RENT[input.property_type]
      : undefined;
    // homes.com only has rent-paths for the residential types.
    const rentable = new Set(['houses', 'condos', 'townhouses']);
    segment = typeSlug && rentable.has(typeSlug)
      ? `${typeSlug}-for-rent`
      : 'homes-for-rent';
  } else {
    // listing_type is undefined or 'for_sale'.
    if (input.property_type) {
      segment = `${TYPE_TO_SLUG_SALE[input.property_type]}-for-sale`;
    }
  }

  const sort = input.sort === 'newest' ? 'newest' : '';

  const parts: string[] = [slug];
  if (segment) parts.push(segment);
  if (sort) parts.push(sort);
  return `/${parts.join('/')}/`;
}
```

- [ ] **Step 4: Update the tool registration `inputSchema` and `description`.**

In `registerSearchTools`, replace the `inputSchema` block with:

```ts
      inputSchema: {
        location: z
          .string()
          .describe(
            'Free-text location: city, ZIP, neighborhood (e.g. "Atlanta, GA", "Brooklyn, NY", "30311", "Park Slope")'
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max listings to return (default 40, the search-page size).'),
        property_type: z
          .enum([
            'single_family',
            'condo',
            'townhouse',
            'land',
            'mobile',
            'multi_family',
          ])
          .optional()
          .describe(
            'Restrict to a specific homes.com property type. Composes with listing_type.'
          ),
        listing_type: z
          .enum(['for_sale', 'sold', 'for_rent', 'open_houses', 'new_construction'])
          .optional()
          .describe(
            'Search axis. Defaults to for_sale. "sold" returns recently-sold listings (useful for market context). "for_rent" returns rentals. "open_houses" returns listings with scheduled open houses. "new_construction" returns builder listings under /new-homes/.'
          ),
        sort: z
          .enum(['newest'])
          .optional()
          .describe('Sort order. Only "newest" is currently supported.'),
      },
```

Update the `description` field to mention the new filters:

```ts
      description:
        "Search homes.com listings by free-text location (city, ZIP, neighborhood). Optionally filter by property_type (single_family/condo/townhouse/land/mobile/multi_family), listing_type (for_sale/sold/for_rent/open_houses/new_construction), and sort (newest). Slugifies the location into homes.com's URL routing (e.g. 'Atlanta, GA' + condo + for_sale → /atlanta-ga/condos-for-sale/). Parses the embedded Schema.org JSON-LD to return each listing's address, price, beds/baths, sqft, primary photo, listing agent + brokerage, and the homes.com property URL. Read-only; safe to call repeatedly.",
```

- [ ] **Step 5: Run tests; expect PASS.**

```bash
npm test -- tests/tools/search.test.ts
```

Expected: every assertion in the new `describe('buildSearchPath — extended filters')` passes, and all prior assertions still pass.

- [ ] **Step 6: Typecheck.**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 7: Commit.**

```bash
git add src/tools/search.ts tests/tools/search.test.ts
git commit -m "feat(search): add property_type, listing_type, sort filters"
```

---

## Task 4: Extend `homes_get_property` with richer fields

**Files:**
- Modify: `src/tools/properties.ts`
- Modify: `tests/tools/properties.test.ts`
- Create: `tests/fixtures/property-detail-rich.html`

- [ ] **Step 1: Capture a fixture.**

```bash
mkdir -p /Users/chris/git/homes-mcp/tests/fixtures
```

Create `tests/fixtures/property-detail-rich.html` with a hand-trimmed snippet that exercises every new field. Use this exact content:

```html
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": ["RealEstateListing", "Product"],
      "@id": "https://www.homes.com/property/test-st-atlanta-ga/abc123/",
      "name": "123 Test St, Atlanta, GA 30311",
      "description": "Charming bungalow in the heart of Atlanta. Newly renovated kitchen, original hardwood floors, large backyard.",
      "url": "https://www.homes.com/property/test-st-atlanta-ga/abc123/",
      "image": "https://images.homes.com/listing/photo1.jpg",
      "datePosted": "2026-04-01",
      "dateModified": "2026-05-10",
      "offers": {
        "price": 425000,
        "priceCurrency": "USD",
        "availability": "https://schema.org/InStock",
        "offeredBy": [
          {
            "@type": "RealEstateAgent",
            "name": "Jane Smith",
            "telephone": "+1-404-555-0100",
            "email": "jane@example.com",
            "jobTitle": "Listing Agent",
            "url": "https://www.homes.com/real-estate-agents/jane-smith/",
            "memberOf": { "name": "Coldwell Banker" }
          }
        ]
      },
      "mainEntity": {
        "@type": "SingleFamilyResidence",
        "numberOfBedrooms": 4,
        "numberOfBathroomsTotal": 3,
        "floorSize": { "value": 2400, "unitCode": "FTK" },
        "yearBuilt": 1955,
        "address": {
          "streetAddress": "123 Test St",
          "addressLocality": "Atlanta",
          "addressRegion": "GA",
          "postalCode": "30311",
          "addressCountry": "US"
        },
        "geo": { "latitude": 33.74, "longitude": -84.45 }
      }
    },
    { "@type": "BreadcrumbList", "itemListElement": [] }
  ]
}
</script>
</head><body>
<div>Estimated payment <span>$1,994/month</span></div>
<div>Total Views <span>87,346</span></div>
<section>
  <h2>Highlights</h2>
  <ul>
    <li>Ranch Style House</li>
    <li>In-Law or Guest Suite</li>
    <li>Central Air</li>
    <li>No HOA</li>
  </ul>
</section>
<section>
  <h2>Home Details</h2>
  <div>
    <h3>Lot Details</h3><div>0.25 acres / 10,890 sqft</div>
    <h3>Parking</h3><div>2-car garage attached</div>
    <h3>Utilities</h3><div>Heating: Forced Air. Cooling: Central Air.</div>
    <h3>Listing and Financial Details</h3>
    <div>HOA Fee: $0 / month. MLS#: 7654321. Source: FMLS.</div>
  </div>
</section>
<a href="https://my.matterport.com/show/?m=abc123">3D Tour</a>
<img src="https://images.homes.com/floorplan/abc123-fp1.jpg" alt="Floorplan 1" />
<img src="https://images.homes.com/floorplan/abc123-fp2.jpg" alt="Floorplan 2" />
<section>
  <h3>Schools</h3>
  <ul>
    <li>Cascade Elementary School (K-5) — Atlanta Public Schools</li>
    <li>Brown Middle School (6-8) — Atlanta Public Schools</li>
    <li>Therrell High School (9-12) — Atlanta Public Schools</li>
  </ul>
</section>
</body></html>
```

- [ ] **Step 2: Add failing tests to `tests/tools/properties.test.ts`.**

Append after the existing tests (preserve existing imports — they may already have `readFileSync` available; if not, add `import { readFileSync } from 'node:fs'`):

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RICH_FIXTURE = readFileSync(
  resolve(__dirname, '../fixtures/property-detail-rich.html'),
  'utf8'
);

describe('homes_get_property — richer fields', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerPropertyTools(s, c));
  });
  afterAll(async () => h?.close());

  it('returns description from JSON-LD', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const r = await h.callTool('homes_get_property', {
      url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
    });
    const p = parseToolResult<any>(r);
    expect(p.description).toContain('Charming bungalow');
  });

  it('extracts highlights bullets from the Highlights section', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.highlights).toEqual([
      'Ranch Style House',
      'In-Law or Guest Suite',
      'Central Air',
      'No HOA',
    ]);
  });

  it('extracts estimated_monthly_payment and total_views', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.estimated_monthly_payment).toBe(1994);
    expect(p.total_views).toBe(87346);
  });

  it('extracts matterport_url', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.matterport_url).toContain('matterport.com');
  });

  it('extracts floorplan_urls', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.floorplan_urls).toHaveLength(2);
    expect(p.floorplan_urls[0]).toContain('floorplan');
  });

  it('extracts schools', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.schools).toHaveLength(3);
    expect(p.schools[0].name).toContain('Cascade Elementary');
  });

  it('extracts mls_id and mls_source from the Listing and Financial Details section', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.mls_id).toBe('7654321');
    expect(p.mls_source).toBe('FMLS');
  });

  it('extracts hoa_fee (0 when "No HOA")', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.hoa_fee).toBe(0);
  });

  it('extracts lot size and parking', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.lot_size_sqft).toBe(10890);
    expect(p.lot_size_acres).toBeCloseTo(0.25, 2);
    expect(p.parking).toContain('2-car garage');
  });

  it('extracts heating and cooling', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.heating).toContain('Forced Air');
    expect(p.cooling).toContain('Central Air');
  });

  it('preserves existing fields (address, lat, price, beds, baths, year_built)', async () => {
    fetch.mockResolvedValueOnce(RICH_FIXTURE);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property', {
        url: 'https://www.homes.com/property/test-st-atlanta-ga/abc123/',
      })
    );
    expect(p.address).toBe('123 Test St');
    expect(p.lat).toBeCloseTo(33.74, 2);
    expect(p.price).toBe(425000);
    expect(p.beds).toBe(4);
    expect(p.baths).toBe(3);
    expect(p.year_built).toBe(1955);
  });
});
```

If `beforeAll`/`afterAll` aren't already imported at the top of the test file, add them: `import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';`.

- [ ] **Step 3: Run tests; expect FAIL on every new assertion.**

```bash
npm test -- tests/tools/properties.test.ts
```

Expected: 11 new failures.

- [ ] **Step 4: Extend `FormattedProperty` and `format` in `src/tools/properties.ts`.**

Add at the top of the file (after the existing imports):

```ts
import {
  parseHtml,
  findTableByHeading,
  parseDollar,
  parseIntegerLoose,
  type HTMLElement,
} from '../html.js';
```

Wait — these helpers are needed but we also need DOM scrape primitives. Add this helper file too:

Update the import to:

```ts
import {
  parseHtml,
  parseDollar,
  parseIntegerLoose,
  type HTMLElement,
} from '../html.js';
```

Update the `FormattedProperty` interface — append these fields (all optional):

```ts
export interface School {
  name: string;
  level?: string;
  district?: string;
}

export interface FormattedProperty {
  property_id: string;
  url: string;
  name?: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  lat?: number;
  lng?: number;
  price?: number;
  price_currency?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  year_built?: number;
  primary_photo_url?: string;
  status?: string;
  date_posted?: string;
  date_modified?: string;
  listing_agent?: FormattedAgent;
  brokerage?: string;
  // NEW FIELDS:
  highlights?: string[];
  estimated_monthly_payment?: number;
  total_views?: number;
  matterport_url?: string;
  floorplan_urls?: string[];
  schools?: School[];
  hoa_fee?: number;
  lot_size_sqft?: number;
  lot_size_acres?: number;
  parking?: string;
  heating?: string;
  cooling?: string;
  mls_id?: string;
  mls_source?: string;
}
```

Modify the signature of `fetchListingRecord` — it already returns `html`, good. Now extend `format` to take optional `html`:

Replace:

```ts
export function format(listing: JsonLdListing): FormattedProperty {
```

with:

```ts
export function format(listing: JsonLdListing, html?: string): FormattedProperty {
```

And inside `format`, before the `return`, add this block:

```ts
  const extras: Partial<FormattedProperty> = html ? extractDomFields(html) : {};
```

And include `...extras` in the return object — change the return to:

```ts
  return {
    property_id: extractPropertyId(listing),
    url: listing.url ?? listing['@id'] ?? '',
    name: listing.name,
    description: listing.description,
    address: addr.streetAddress,
    city: addr.addressLocality,
    state: addr.addressRegion,
    zip: addr.postalCode,
    country: addr.addressCountry,
    lat: toNumber(geo.latitude),
    lng: toNumber(geo.longitude),
    price: toNumber(offers.price),
    price_currency: offers.priceCurrency,
    beds: toNumber(main.numberOfBedrooms),
    baths: toNumber(main.numberOfBathroomsTotal),
    sqft,
    year_built: toNumber(main.yearBuilt),
    primary_photo_url: primary,
    status: offers.availability,
    date_posted: listing.datePosted,
    date_modified: listing.dateModified,
    listing_agent: formatAgent(agent),
    brokerage: brokerageFrom(agent) ?? offers.seller?.name,
    ...extras,
  };
```

Add the `extractDomFields` function at the bottom of `src/tools/properties.ts`:

```ts
/**
 * Best-effort DOM scraping for fields that don't appear in JSON-LD.
 * Every field is optional — missing-from-this-listing is normal.
 *
 * Sections (per live probe on 2026-05-26):
 *   - "Highlights" <ul><li>…</li></ul>
 *   - Estimated payment (text "Estimated payment <amount>/month")
 *   - Total Views (text "Total Views <number>")
 *   - Matterport <a> with my.matterport.com URL
 *   - Floorplans <img> tags whose URL contains "floorplan"
 *   - "Schools" <ul><li>…</li></ul> (or "MLS Schools")
 *   - "Listing and Financial Details" <div> with HOA / MLS / Source text
 *   - "Lot Details" / "Parking" / "Utilities" <div> after their <h3>
 */
function extractDomFields(html: string): Partial<FormattedProperty> {
  const root = parseHtml(html);
  const out: Partial<FormattedProperty> = {};

  // Highlights
  const hl = findUlAfterHeading(root, 'Highlights');
  if (hl.length > 0) out.highlights = hl;

  // Estimated payment / Total Views — flat-text regex over the body.
  const bodyText = root.text;
  const est = /Estimated payment\s*\$?([0-9,]+)/i.exec(bodyText);
  if (est) {
    const n = parseDollar(est[1]);
    if (n !== undefined) out.estimated_monthly_payment = n;
  }
  const views = /Total Views\s*([0-9,]+)/i.exec(bodyText);
  if (views) {
    const n = parseIntegerLoose(views[1]);
    if (n !== undefined) out.total_views = n;
  }

  // Matterport URL
  const matter = root
    .querySelectorAll('a')
    .find((a) => (a.getAttribute('href') ?? '').includes('matterport.com'));
  if (matter) out.matterport_url = matter.getAttribute('href') ?? undefined;

  // Floorplans — <img> whose src includes "floorplan"
  const fps = root
    .querySelectorAll('img')
    .map((img) => img.getAttribute('src') ?? '')
    .filter((src) => src.includes('floorplan'));
  if (fps.length > 0) out.floorplan_urls = fps;

  // Schools
  const schoolItems = findUlAfterHeading(root, 'Schools');
  if (schoolItems.length > 0) {
    out.schools = schoolItems.map(parseSchoolLine);
  }

  // Listing and Financial Details — HOA, MLS, source.
  const finText = findDivTextAfterHeading(root, 'Listing and Financial Details');
  if (finText) {
    const hoa = /HOA Fee:\s*\$?([0-9,]+|0)/i.exec(finText);
    if (hoa) {
      const n = parseDollar(hoa[1]);
      if (n !== undefined) out.hoa_fee = n;
    } else if (/No HOA/i.test(bodyText)) {
      out.hoa_fee = 0;
    }
    const mls = /MLS#?:?\s*([A-Z0-9-]+)/i.exec(finText);
    if (mls) out.mls_id = mls[1];
    const src = /Source:\s*([A-Z][A-Za-z0-9 ]+)/.exec(finText);
    if (src) out.mls_source = src[1].trim();
  }
  // "No HOA" fallback even if no Listing+Financial section.
  if (out.hoa_fee === undefined && /No HOA/i.test(bodyText)) {
    out.hoa_fee = 0;
  }

  // Lot Details — accept "X acres / Y sqft" or "Y sqft" or "X acres".
  const lotText = findDivTextAfterHeading(root, 'Lot Details');
  if (lotText) {
    const sqft = /([0-9,]+)\s*sqft/i.exec(lotText);
    if (sqft) {
      const n = parseIntegerLoose(sqft[1]);
      if (n !== undefined) out.lot_size_sqft = n;
    }
    const acres = /([0-9.]+)\s*acres?/i.exec(lotText);
    if (acres) {
      const n = Number(acres[1]);
      if (Number.isFinite(n)) out.lot_size_acres = n;
    }
  }

  // Parking
  const parkingText = findDivTextAfterHeading(root, 'Parking');
  if (parkingText) out.parking = parkingText.replace(/\s+/g, ' ').trim();

  // Utilities — Heating / Cooling
  const util = findDivTextAfterHeading(root, 'Utilities');
  if (util) {
    const heat = /Heating:\s*([^.]+)/i.exec(util);
    if (heat) out.heating = heat[1].trim();
    const cool = /Cooling:\s*([^.]+)/i.exec(util);
    if (cool) out.cooling = cool[1].trim();
  }

  return out;
}

function findUlAfterHeading(root: HTMLElement, heading: string): string[] {
  const needle = heading.toLowerCase();
  const hs = root.querySelectorAll('h1, h2, h3, h4');
  for (const h of hs) {
    if (!h.text.toLowerCase().includes(needle)) continue;
    // Search the heading's parent for the first <ul>.
    const parent = h.parentNode as HTMLElement | null;
    const ul = parent?.querySelector('ul');
    if (ul) {
      return ul
        .querySelectorAll('li')
        .map((li) => li.text.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }
    // Walk forward siblings.
    let cur: HTMLElement | null = h.nextElementSibling as HTMLElement | null;
    while (cur) {
      if (/^H[1-4]$/.test(cur.tagName)) break;
      if (cur.tagName === 'UL') {
        return cur
          .querySelectorAll('li')
          .map((li) => li.text.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
      }
      const nested = cur.querySelector('ul');
      if (nested) {
        return nested
          .querySelectorAll('li')
          .map((li) => li.text.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
      }
      cur = cur.nextElementSibling as HTMLElement | null;
    }
  }
  return [];
}

function findDivTextAfterHeading(
  root: HTMLElement,
  heading: string
): string | null {
  const needle = heading.toLowerCase();
  const hs = root.querySelectorAll('h1, h2, h3, h4');
  for (const h of hs) {
    if (!h.text.toLowerCase().includes(needle)) continue;
    const sib = h.nextElementSibling as HTMLElement | null;
    if (sib && sib.tagName === 'DIV') {
      return sib.text.replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function parseSchoolLine(line: string): School {
  // "Cascade Elementary School (K-5) — Atlanta Public Schools"
  const m = /^(.+?)(?:\s*\(([^)]+)\))?(?:\s*[—-]\s*(.+))?$/.exec(line);
  if (!m) return { name: line };
  const [, name, level, district] = m;
  const out: School = { name: name.trim() };
  if (level) out.level = level.trim();
  if (district) out.district = district.trim();
  return out;
}
```

Finally, update the tool registration body to pass `html` through to `format`:

Replace:

```ts
    async ({ url }) => {
      const { listing } = await fetchListingRecord(client, { url });
      return textResult(format(listing));
    }
```

with:

```ts
    async ({ url }) => {
      const { listing, html } = await fetchListingRecord(client, { url });
      return textResult(format(listing, html));
    }
```

Also update the tool `description` field to mention the new fields:

```ts
      description:
        "Fetch a property's full homes.com record. Pass `url` — the full property detail URL (e.g. from a homes_search_properties result's `url` field). Parses the page's Schema.org JSON-LD plus DOM-side sections to return address, lat/lng, beds/baths, sqft, year built, price, status, listing agent + brokerage, description, highlights, estimated monthly payment, total views, Matterport tour URL, floorplan URLs, schools, HOA fee, lot size, parking, heating/cooling, MLS ID/source, and date posted/modified. Read-only; safe to call repeatedly.",
```

- [ ] **Step 5: Run tests; expect PASS.**

```bash
npm test -- tests/tools/properties.test.ts
```

Expected: all assertions pass, including pre-existing ones.

- [ ] **Step 6: Update `compare.ts` to pass html through too — it uses `format()` directly.**

Open `src/tools/compare.ts`. Find:

```ts
            const { listing } = await fetchListingRecord(client, t);
            const formatted = format(listing);
```

Replace with:

```ts
            const { listing, html } = await fetchListingRecord(client, t);
            const formatted = format(listing, html);
```

Run compare tests:

```bash
npm test -- tests/tools/compare.test.ts
```

Expected: still passes.

- [ ] **Step 7: Typecheck full project.**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 8: Commit.**

```bash
git add src/tools/properties.ts src/tools/compare.ts tests/tools/properties.test.ts tests/fixtures/property-detail-rich.html
git commit -m "feat(property): extract description, highlights, schools, HOA, MLS, lot, parking, HVAC, Matterport, floorplans"
```

---

## Task 5: `homes_get_property_history` (listing + ownership + lien events)

**Files:**
- Create: `src/tools/history.ts`
- Create: `tests/tools/history.test.ts`
- Create: `tests/fixtures/history-full.html`
- Create: `tests/fixtures/history-empty.html`

- [ ] **Step 1: Capture fixtures.**

Create `tests/fixtures/history-full.html`:

```html
<html><head>
<script type="application/ld+json">
{"@graph":[{"@type":["RealEstateListing","Product"],"url":"https://www.homes.com/property/x/abc123/","@id":"https://www.homes.com/property/x/abc123/","mainEntity":{}}]}
</script>
</head><body>
<h2>Property History</h2>
<table>
  <thead><tr><th>Date</th><th>Event</th><th>Price</th><th>List to Sale</th><th>Price per Sq Ft</th></tr></thead>
  <tbody>
    <tr><td>04/30/2026</td><td>Price Changed</td><td>$315,000</td><td>-5.8%</td><td>$149 / Sq Ft</td></tr>
    <tr><td>04/23/2026</td><td>Listed</td><td>$335,000</td><td>--</td><td>$158 / Sq Ft</td></tr>
    <tr><td>04/05/2026</td><td>Off Market</td><td>--</td><td>--</td><td>--</td></tr>
  </tbody>
</table>

<h2>Purchase History</h2>
<table>
  <thead><tr><th>Date</th><th>Type</th><th>Sale Price</th><th>Title Company</th></tr></thead>
  <tbody>
    <tr><td>05/04/22</td><td>Warranty Deed</td><td>$152,000</td><td>--</td></tr>
    <tr><td>06/02/11</td><td>Quit Claim</td><td>$0</td><td>Bay Title</td></tr>
    <tr><td>07/29/08</td><td>Warranty Deed</td><td>$95,000</td><td>--</td></tr>
  </tbody>
</table>

<h2>Mortgage History</h2>
<table>
  <thead><tr><th>Date</th><th>Status</th><th>Loan Amount</th><th>Loan Type</th></tr></thead>
  <tbody>
    <tr><td>05/04/22</td><td>Closed</td><td>$220,500</td><td>Mortgage Modification</td></tr>
    <tr><td>06/02/11</td><td>Closed</td><td>$95,000</td><td>Conventional</td></tr>
  </tbody>
</table>
</body></html>
```

Create `tests/fixtures/history-empty.html`:

```html
<html><head>
<script type="application/ld+json">
{"@graph":[{"@type":["RealEstateListing","Product"],"url":"https://www.homes.com/property/x/empty/","@id":"https://www.homes.com/property/x/empty/","mainEntity":{}}]}
</script>
</head><body>
<h2>Highlights</h2><ul><li>New Construction</li></ul>
</body></html>
```

- [ ] **Step 2: Write the failing tests `tests/tools/history.test.ts`.**

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import {
  parsePropertyHistory,
  parseOwnershipHistory,
  parseLienHistory,
  registerHistoryTools,
} from '../../src/tools/history.js';
import { parseHtml } from '../../src/html.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FULL = readFileSync(resolve(__dirname, '../fixtures/history-full.html'), 'utf8');
const EMPTY = readFileSync(resolve(__dirname, '../fixtures/history-empty.html'), 'utf8');

describe('parsePropertyHistory', () => {
  it('parses listing events with normalized dates and numeric fields', () => {
    const root = parseHtml(FULL);
    const events = parsePropertyHistory(root);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      date: '2026-04-30',
      event: 'Price Changed',
      price: 315000,
      list_to_sale_pct: -5.8,
      price_per_sqft: 149,
    });
    expect(events[1].event).toBe('Listed');
    expect(events[1].price).toBe(335000);
    expect(events[1].list_to_sale_pct).toBeUndefined();
    expect(events[2].event).toBe('Off Market');
    expect(events[2].price).toBeUndefined();
  });

  it('returns [] when the section is missing', () => {
    const root = parseHtml(EMPTY);
    expect(parsePropertyHistory(root)).toEqual([]);
  });
});

describe('parseOwnershipHistory', () => {
  it('parses Purchase History rows with MM/DD/YY → 20xx', () => {
    const root = parseHtml(FULL);
    const events = parseOwnershipHistory(root);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      date: '2022-05-04',
      deed_type: 'Warranty Deed',
      sale_price: 152000,
    });
    expect(events[1].title_company).toBe('Bay Title');
  });
});

describe('parseLienHistory', () => {
  it('parses Mortgage History rows', () => {
    const root = parseHtml(FULL);
    const events = parseLienHistory(root);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      date: '2022-05-04',
      status: 'Closed',
      loan_amount: 220500,
      loan_type: 'Mortgage Modification',
    });
  });
});

describe('homes_get_property_history tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerHistoryTools(s, c));
  });
  afterAll(async () => h?.close());

  it('returns all three series for a full-history listing', async () => {
    fetch.mockResolvedValueOnce(FULL);
    const r = await h.callTool('homes_get_property_history', {
      url: 'https://www.homes.com/property/x/abc123/',
    });
    expect(r.isError).toBeFalsy();
    const p = parseToolResult<any>(r);
    expect(p.property_id).toBe('abc123');
    expect(p.listing_events).toHaveLength(3);
    expect(p.ownership_events).toHaveLength(3);
    expect(p.lien_events).toHaveLength(2);
  });

  it('returns three empty arrays for a new-construction-style empty listing', async () => {
    fetch.mockResolvedValueOnce(EMPTY);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_property_history', {
        url: 'https://www.homes.com/property/x/empty/',
      })
    );
    expect(p.listing_events).toEqual([]);
    expect(p.ownership_events).toEqual([]);
    expect(p.lien_events).toEqual([]);
  });
});
```

- [ ] **Step 3: Run; expect FAIL with "cannot find module".**

```bash
npm test -- tests/tools/history.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement `src/tools/history.ts`.**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  parseHtml,
  findTableByHeading,
  tableRows,
  normalizeDate,
  parseDollar,
  parsePercent,
  type HTMLElement,
} from '../html.js';
import { urlToPath } from '../url.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';

export interface ListingEvent {
  date: string;
  date_raw?: string;
  event: string;
  price?: number;
  list_to_sale_pct?: number;
  price_per_sqft?: number;
}

export interface OwnershipEvent {
  date: string;
  date_raw?: string;
  deed_type?: string;
  sale_price?: number;
  title_company?: string;
}

export interface LienEvent {
  date: string;
  date_raw?: string;
  status?: string;
  loan_amount?: number;
  loan_type?: string;
}

function withDate<T extends { date: string; date_raw?: string }>(
  base: Omit<T, 'date' | 'date_raw'>,
  rawDate: string
): T {
  const n = normalizeDate(rawDate);
  const out = { ...base, date: n.iso ?? n.raw } as T;
  if (!n.iso) out.date_raw = n.raw;
  return out;
}

export function parsePropertyHistory(root: HTMLElement): ListingEvent[] {
  const t = findTableByHeading(root, 'Property History');
  if (!t) return [];
  return tableRows(t)
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [date, event, price, listToSale, ppsf] = cells;
      const base: Omit<ListingEvent, 'date' | 'date_raw'> = {
        event: (event ?? '').trim(),
      };
      if (price !== undefined) {
        const n = parseDollar(price);
        if (n !== undefined) base.price = n;
      }
      if (listToSale !== undefined) {
        const n = parsePercent(listToSale);
        if (n !== undefined) base.list_to_sale_pct = n;
      }
      if (ppsf !== undefined) {
        const n = parseDollar(ppsf);
        if (n !== undefined) base.price_per_sqft = n;
      }
      return withDate<ListingEvent>(base, date ?? '');
    });
}

export function parseOwnershipHistory(root: HTMLElement): OwnershipEvent[] {
  const t = findTableByHeading(root, 'Purchase History');
  if (!t) return [];
  return tableRows(t)
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [date, deedType, salePrice, titleCo] = cells;
      const base: Omit<OwnershipEvent, 'date' | 'date_raw'> = {};
      if (deedType) base.deed_type = deedType.trim();
      if (salePrice !== undefined) {
        const n = parseDollar(salePrice);
        if (n !== undefined) base.sale_price = n;
      }
      if (titleCo && titleCo.trim() !== '--' && titleCo.trim() !== '') {
        base.title_company = titleCo.trim();
      }
      return withDate<OwnershipEvent>(base, date ?? '');
    });
}

export function parseLienHistory(root: HTMLElement): LienEvent[] {
  const t = findTableByHeading(root, 'Mortgage History');
  if (!t) return [];
  return tableRows(t)
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [date, status, loanAmt, loanType] = cells;
      const base: Omit<LienEvent, 'date' | 'date_raw'> = {};
      if (status) base.status = status.trim();
      if (loanAmt !== undefined) {
        const n = parseDollar(loanAmt);
        if (n !== undefined) base.loan_amount = n;
      }
      if (loanType) base.loan_type = loanType.trim();
      return withDate<LienEvent>(base, date ?? '');
    });
}

function extractPropertyIdFromHtml(html: string, fallbackUrl: string): string {
  const doc = extractJsonLd(html);
  const node = findGraphNode(doc, 'RealEstateListing') as
    | { '@id'?: string; url?: string }
    | null;
  const src = node?.['@id'] ?? node?.url ?? fallbackUrl;
  const segments = src.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

export function registerHistoryTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_property_history',
    {
      title: 'Get homes.com property history (listings + ownership + liens)',
      description:
        "Three timelines for a homes.com property in one call: `listing_events` (listings, price changes, sales, off-market), `ownership_events` (deeds — recorded sales between owners), and `lien_events` (mortgage/refi origination + payoff). Pass `url` — the full property detail URL. Each event has an ISO 8601 date plus event-specific fields. Series are `[]` when the listing doesn't carry that section (common for new construction). Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get homes.com property history (listings + ownership + liens)',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().describe('homes.com property detail URL or path.'),
      },
    },
    async ({ url }) => {
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const root = parseHtml(html);
      return textResult({
        property_id: extractPropertyIdFromHtml(html, url),
        url,
        listing_events: parsePropertyHistory(root),
        ownership_events: parseOwnershipHistory(root),
        lien_events: parseLienHistory(root),
      });
    }
  );
}
```

- [ ] **Step 5: Run tests; expect PASS.**

```bash
npm test -- tests/tools/history.test.ts
```

Expected: all assertions pass.

- [ ] **Step 6: Typecheck.**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit.**

```bash
git add src/tools/history.ts tests/tools/history.test.ts tests/fixtures/history-full.html tests/fixtures/history-empty.html
git commit -m "feat: add homes_get_property_history (listing + ownership + lien events)"
```

---

## Task 6: `homes_get_tax_history`

**Files:**
- Modify: `src/tools/history.ts` (add tax parser + tool)
- Create: `tests/fixtures/tax-history.html`
- Modify: `tests/tools/history.test.ts` (append tax tests)

- [ ] **Step 1: Create `tests/fixtures/tax-history.html`.**

```html
<html><head>
<script type="application/ld+json">
{"@graph":[{"@type":["RealEstateListing","Product"],"url":"https://www.homes.com/property/x/abc123/","@id":"https://www.homes.com/property/x/abc123/","mainEntity":{}}]}
</script>
</head><body>
<h2>Tax History</h2>
<table>
  <thead><tr><th>Year</th><th>Tax Paid</th><th>Tax Assessment</th><th>Land</th><th>Improvement</th></tr></thead>
  <tbody>
    <tr><td>2025</td><td>$2,714</td><td>$72,520</td><td>$20,200</td><td>$52,320</td></tr>
    <tr><td>2024</td><td>$2,580</td><td>$68,000</td><td>$18,000</td><td>$50,000</td></tr>
    <tr><td>2023</td><td>--</td><td>$65,000</td><td>$17,500</td><td>$47,500</td></tr>
  </tbody>
</table>
</body></html>
```

- [ ] **Step 2: Append failing tests to `tests/tools/history.test.ts`.**

```ts
const TAX = readFileSync(resolve(__dirname, '../fixtures/tax-history.html'), 'utf8');

describe('parseTaxHistory', () => {
  it('parses every row with numeric fields', () => {
    const root = parseHtml(TAX);
    const events = parseTaxHistory(root);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      year: 2025,
      tax_paid: 2714,
      assessment_total: 72520,
      assessment_land: 20200,
      assessment_improvement: 52320,
    });
    expect(events[2].tax_paid).toBeUndefined();
    expect(events[2].assessment_total).toBe(65000);
  });

  it('returns [] when no Tax History section', () => {
    const root = parseHtml(EMPTY);
    expect(parseTaxHistory(root)).toEqual([]);
  });
});

describe('homes_get_tax_history tool', () => {
  let h2: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch2 = vi.fn();
  const c2 = { fetchHtml: fetch2 } as unknown as HomesClient;

  beforeAll(async () => {
    h2 = await createTestHarness((s) => registerHistoryTools(s, c2));
  });
  afterAll(async () => h2?.close());

  it('returns parsed tax records', async () => {
    fetch2.mockResolvedValueOnce(TAX);
    const p = parseToolResult<any>(
      await h2.callTool('homes_get_tax_history', {
        url: 'https://www.homes.com/property/x/abc123/',
      })
    );
    expect(p.records).toHaveLength(3);
    expect(p.records[0].year).toBe(2025);
  });
});
```

Update the import at the top of the test file to include `parseTaxHistory`:

```ts
import {
  parsePropertyHistory,
  parseOwnershipHistory,
  parseLienHistory,
  parseTaxHistory,
  registerHistoryTools,
} from '../../src/tools/history.js';
```

- [ ] **Step 3: Run; expect FAIL.**

```bash
npm test -- tests/tools/history.test.ts
```

- [ ] **Step 4: Add `parseTaxHistory` and tool registration to `src/tools/history.ts`.**

Append:

```ts
export interface TaxRecord {
  year: number;
  tax_paid?: number;
  assessment_total?: number;
  assessment_land?: number;
  assessment_improvement?: number;
}

export function parseTaxHistory(root: HTMLElement): TaxRecord[] {
  const t = findTableByHeading(root, 'Tax History');
  if (!t) return [];
  return tableRows(t)
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [yearRaw, paid, assess, land, improvement] = cells;
      const year = Number((yearRaw ?? '').trim());
      const rec: TaxRecord = { year: Number.isFinite(year) ? year : 0 };
      const p = paid !== undefined ? parseDollar(paid) : undefined;
      if (p !== undefined) rec.tax_paid = p;
      const a = assess !== undefined ? parseDollar(assess) : undefined;
      if (a !== undefined) rec.assessment_total = a;
      const l = land !== undefined ? parseDollar(land) : undefined;
      if (l !== undefined) rec.assessment_land = l;
      const i = improvement !== undefined ? parseDollar(improvement) : undefined;
      if (i !== undefined) rec.assessment_improvement = i;
      return rec;
    })
    .filter((rec) => rec.year > 0);
}
```

And register a second tool inside `registerHistoryTools`, after the first `server.registerTool` call:

```ts
  server.registerTool(
    'homes_get_tax_history',
    {
      title: 'Get homes.com property tax history',
      description:
        "Year-by-year property-tax records for a homes.com property: tax paid, total assessed value, and the land/improvement split. Pass `url` — the full property detail URL. Returns `{ property_id, url, records: [{ year, tax_paid?, assessment_total?, assessment_land?, assessment_improvement? }] }`. Useful for spotting reassessment jumps or comparing tax burdens across properties. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get homes.com property tax history',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().describe('homes.com property detail URL or path.'),
      },
    },
    async ({ url }) => {
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const root = parseHtml(html);
      return textResult({
        property_id: extractPropertyIdFromHtml(html, url),
        url,
        records: parseTaxHistory(root),
      });
    }
  );
```

- [ ] **Step 5: Run; expect PASS.**

```bash
npm test -- tests/tools/history.test.ts
```

- [ ] **Step 6: Typecheck + commit.**

```bash
npx tsc --noEmit
git add src/tools/history.ts tests/tools/history.test.ts tests/fixtures/tax-history.html
git commit -m "feat: add homes_get_tax_history"
```

---

## Task 7: `homes_get_nearby_listings`

**Files:**
- Create: `src/tools/nearby.ts`
- Create: `tests/tools/nearby.test.ts`
- Create: `tests/fixtures/nearby-listings.html`

- [ ] **Step 1: Create `tests/fixtures/nearby-listings.html`.**

```html
<html><head>
<script type="application/ld+json">
{"@graph":[{"@type":["RealEstateListing","Product"],"url":"https://www.homes.com/property/x/abc123/","@id":"https://www.homes.com/property/x/abc123/","mainEntity":{}}]}
</script>
</head><body>
<section>
  <h2>Homes for Sale Near This Property</h2>
  <div class="card-list">
    <article>
      <a href="https://www.homes.com/property/3185-delmar-ln-nw-atlanta-ga/aaa111/">
        <img src="https://images.homes.com/listing/aaa111/main.jpg" alt="3185 Delmar" />
        <span class="price">$295,000</span>
        <span class="address">3185 Delmar Ln NW Unit 1, Atlanta, GA 30311</span>
        <span class="beds">3 bd</span>
        <span class="baths">2 ba</span>
        <span class="sqft">1,800 sq ft</span>
      </a>
    </article>
    <article>
      <a href="https://www.homes.com/property/3201-delmar-ln-nw-atlanta-ga/bbb222/">
        <img src="https://images.homes.com/listing/bbb222/main.jpg" alt="3201 Delmar" />
        <span class="price">$350,000</span>
        <span class="address">3201 Delmar Ln NW, Atlanta, GA 30311</span>
        <span class="beds">4 bd</span>
        <span class="baths">3 ba</span>
        <span class="sqft">2,200 sq ft</span>
      </a>
    </article>
  </div>
</section>
</body></html>
```

- [ ] **Step 2: Write failing tests `tests/tools/nearby.test.ts`.**

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import { parseNearbyListings, registerNearbyTools } from '../../src/tools/nearby.js';
import { parseHtml } from '../../src/html.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = readFileSync(resolve(__dirname, '../fixtures/nearby-listings.html'), 'utf8');

describe('parseNearbyListings', () => {
  it('returns nearby property cards with id/url/address/price/beds/baths/sqft', () => {
    const root = parseHtml(FIX);
    const items = parseNearbyListings(root);
    expect(items).toHaveLength(2);
    expect(items[0].property_id).toBe('aaa111');
    expect(items[0].url).toBe('https://www.homes.com/property/3185-delmar-ln-nw-atlanta-ga/aaa111/');
    expect(items[0].address).toContain('3185 Delmar');
    expect(items[0].price).toBe(295000);
    expect(items[0].beds).toBe(3);
    expect(items[0].baths).toBe(2);
    expect(items[0].sqft).toBe(1800);
    expect(items[0].primary_photo_url).toContain('aaa111');
  });

  it('returns [] when no nearby section', () => {
    const root = parseHtml('<html><body><h1>Just a page</h1></body></html>');
    expect(parseNearbyListings(root)).toEqual([]);
  });
});

describe('homes_get_nearby_listings tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerNearbyTools(s, c));
  });
  afterAll(async () => h?.close());

  it('returns property_id, count, listings[]', async () => {
    fetch.mockResolvedValueOnce(FIX);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_nearby_listings', {
        url: 'https://www.homes.com/property/x/abc123/',
      })
    );
    expect(p.count).toBe(2);
    expect(p.listings).toHaveLength(2);
  });

  it('respects limit', async () => {
    fetch.mockResolvedValueOnce(FIX);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_nearby_listings', {
        url: 'https://www.homes.com/property/x/abc123/',
        limit: 1,
      })
    );
    expect(p.listings).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run; expect FAIL.**

```bash
npm test -- tests/tools/nearby.test.ts
```

- [ ] **Step 4: Implement `src/tools/nearby.ts`.**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  parseHtml,
  findLinksUnderHeading,
  parseDollar,
  parseIntegerLoose,
  type HTMLElement,
} from '../html.js';
import { urlToPath } from '../url.js';
import { extractJsonLd, findGraphNode } from '../page-state.js';

export interface NearbyListing {
  property_id: string;
  url: string;
  address?: string;
  price?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  primary_photo_url?: string;
}

const PROPERTY_LINK_RE = /\/property\/[^/]+\/([^/]+)\/?$/;

export function parseNearbyListings(root: HTMLElement): NearbyListing[] {
  // homes.com uses several headings interchangeably across listings. Try
  // each — first match wins.
  const HEADINGS = ['Homes for Sale Near', 'Homes for Sale', 'Similar Homes', 'Nearby Homes'];
  let links: HTMLElement[] = [];
  for (const h of HEADINGS) {
    links = findLinksUnderHeading(root, h);
    if (links.length > 0) break;
  }
  if (links.length === 0) return [];

  const seen = new Set<string>();
  const out: NearbyListing[] = [];
  for (const a of links) {
    const href = a.getAttribute('href') ?? '';
    const m = PROPERTY_LINK_RE.exec(href.replace(/^https?:\/\/[^/]+/, ''));
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const text = a.text;
    const priceM = /\$([0-9,]+)/.exec(text);
    const bedsM = /(\d+)\s*bd/i.exec(text);
    const bathsM = /(\d+(?:\.\d+)?)\s*ba/i.exec(text);
    const sqftM = /([0-9,]+)\s*sq\s*ft/i.exec(text);
    const addrEl = a.querySelector('.address, [class*="address" i]');
    const photoEl = a.querySelector('img');
    const item: NearbyListing = {
      property_id: id,
      url: href.startsWith('http')
        ? href
        : `https://www.homes.com${href.startsWith('/') ? href : '/' + href}`,
    };
    if (addrEl) item.address = addrEl.text.replace(/\s+/g, ' ').trim();
    if (priceM) {
      const n = parseDollar(priceM[1]);
      if (n !== undefined) item.price = n;
    }
    if (bedsM) {
      const n = parseIntegerLoose(bedsM[1]);
      if (n !== undefined) item.beds = n;
    }
    if (bathsM) {
      const n = Number(bathsM[1]);
      if (Number.isFinite(n)) item.baths = n;
    }
    if (sqftM) {
      const n = parseIntegerLoose(sqftM[1]);
      if (n !== undefined) item.sqft = n;
    }
    if (photoEl) {
      const src = photoEl.getAttribute('src');
      if (src) item.primary_photo_url = src;
    }
    out.push(item);
  }
  return out;
}

function propertyIdFromUrl(url: string): string {
  const m = PROPERTY_LINK_RE.exec(url.replace(/^https?:\/\/[^/]+/, ''));
  return m ? m[1] : '';
}

function originPropertyId(html: string, fallbackUrl: string): string {
  const doc = extractJsonLd(html);
  const node = findGraphNode(doc, 'RealEstateListing') as
    | { '@id'?: string; url?: string }
    | null;
  const src = node?.['@id'] ?? node?.url ?? fallbackUrl;
  return propertyIdFromUrl(src);
}

export function registerNearbyTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_nearby_listings',
    {
      title: 'Get nearby homes.com listings for a property',
      description:
        "Scrape the 'Homes for Sale Near This Property' section of a homes.com detail page and return the nearby active listings: id, URL, address, price, beds, baths, sqft, primary photo. Pass `url` (the property whose neighborhood to inspect). Optional `limit` caps the count. Returns `{ property_id, url, count, listings[] }`. Note: these are nearby listings homes.com chose to surface; not a true comp-sales set. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get nearby homes.com listings for a property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().describe('homes.com property detail URL or path.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max nearby listings to return (default unlimited).'),
      },
    },
    async ({ url, limit }) => {
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const root = parseHtml(html);
      const all = parseNearbyListings(root);
      const listings = limit !== undefined ? all.slice(0, limit) : all;
      return textResult({
        property_id: originPropertyId(html, url),
        url,
        count: listings.length,
        listings,
      });
    }
  );
}
```

- [ ] **Step 5: Run; expect PASS.**

```bash
npm test -- tests/tools/nearby.test.ts
```

- [ ] **Step 6: Typecheck + commit.**

```bash
npx tsc --noEmit
git add src/tools/nearby.ts tests/tools/nearby.test.ts tests/fixtures/nearby-listings.html
git commit -m "feat: add homes_get_nearby_listings"
```

---

## Task 8: `homes_get_market_report`

**Files:**
- Create: `src/tools/market.ts`
- Create: `tests/tools/market.test.ts`
- Create: `tests/fixtures/sold-page.html`

- [ ] **Step 1: Create `tests/fixtures/sold-page.html`.**

```html
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"BreadcrumbList","itemListElement":[]},
  {"@type":"CollectionPage","mainEntity":{"numberOfItems":120,"itemListElement":[
    {"@type":["RealEstateListing","Product"],"@id":"https://www.homes.com/property/a/aaa/","url":"https://www.homes.com/property/a/aaa/","offers":{"price":650000,"availability":"https://schema.org/Sold"},"mainEntity":{"address":{"streetAddress":"1 Sold St","addressLocality":"Brooklyn","addressRegion":"NY","postalCode":"11215"},"floorSize":{"value":1200,"unitCode":"FTK"},"numberOfBedrooms":2,"numberOfBathroomsTotal":1}},
    {"@type":["RealEstateListing","Product"],"@id":"https://www.homes.com/property/b/bbb/","url":"https://www.homes.com/property/b/bbb/","offers":{"price":850000,"availability":"https://schema.org/Sold"},"mainEntity":{"address":{"streetAddress":"2 Sold St","addressLocality":"Brooklyn","addressRegion":"NY","postalCode":"11215"},"floorSize":{"value":1500,"unitCode":"FTK"},"numberOfBedrooms":3,"numberOfBathroomsTotal":2}},
    {"@type":["RealEstateListing","Product"],"@id":"https://www.homes.com/property/c/ccc/","url":"https://www.homes.com/property/c/ccc/","offers":{"price":1200000,"availability":"https://schema.org/Sold"},"mainEntity":{"address":{"streetAddress":"3 Sold St","addressLocality":"Brooklyn","addressRegion":"NY","postalCode":"11215"},"floorSize":{"value":2000,"unitCode":"FTK"},"numberOfBedrooms":4,"numberOfBathroomsTotal":3}}
  ]}}
]}
</script>
</head><body><h1>Brooklyn, NY Recently Sold</h1></body></html>
```

- [ ] **Step 2: Write failing tests `tests/tools/market.test.ts`.**

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import { computeMarketSummary, registerMarketTools } from '../../src/tools/market.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLD = readFileSync(resolve(__dirname, '../fixtures/sold-page.html'), 'utf8');

describe('computeMarketSummary', () => {
  it('returns median price + count + mean $/sqft', () => {
    const s = computeMarketSummary([
      { price: 650000, sqft: 1200 },
      { price: 850000, sqft: 1500 },
      { price: 1200000, sqft: 2000 },
    ]);
    expect(s.count).toBe(3);
    expect(s.median_price).toBe(850000);
    expect(s.avg_price_per_sqft).toBeCloseTo(
      (650000 / 1200 + 850000 / 1500 + 1200000 / 2000) / 3,
      0
    );
  });

  it('handles even-count median', () => {
    const s = computeMarketSummary([{ price: 100 }, { price: 200 }, { price: 300 }, { price: 400 }]);
    expect(s.median_price).toBe(250); // (200+300)/2
  });

  it('skips entries with no price', () => {
    const s = computeMarketSummary([{ price: 100 }, {}, { price: 300 }]);
    expect(s.count).toBe(2);
    expect(s.median_price).toBe(200);
  });

  it('returns zero count when no sold listings', () => {
    const s = computeMarketSummary([]);
    expect(s.count).toBe(0);
    expect(s.median_price).toBeUndefined();
  });
});

describe('homes_get_market_report tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerMarketTools(s, c));
  });
  afterAll(async () => h?.close());

  it('fetches /<location>/sold/ and returns sold_summary + sample', async () => {
    fetch.mockResolvedValueOnce(SOLD);
    const r = await h.callTool('homes_get_market_report', {
      location: 'Brooklyn, NY',
    });
    expect(fetch.mock.calls[0][0]).toBe('/brooklyn-ny/sold/');
    const p = parseToolResult<any>(r);
    expect(p.region).toBe('Brooklyn, NY');
    expect(p.slug).toBe('brooklyn-ny');
    expect(p.sold_summary.count).toBe(3);
    expect(p.sold_summary.median_price).toBe(850000);
    expect(p.sample_sold).toHaveLength(3);
    expect(p.sample_sold[0].property_id).toBe('aaa');
  });
});
```

- [ ] **Step 3: Run; FAIL.**

```bash
npm test -- tests/tools/market.test.ts
```

- [ ] **Step 4: Implement `src/tools/market.ts`.**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractJsonLd } from '../page-state.js';
import { findListings, formatHome, type FormattedHome } from './search.js';
import { locationToSlug } from '../url.js';

export interface SoldSummary {
  count: number;
  median_price?: number;
  avg_price_per_sqft?: number;
}

export function computeMarketSummary(
  items: Array<{ price?: number; sqft?: number }>
): SoldSummary {
  const prices = items.map((i) => i.price).filter((p): p is number => typeof p === 'number');
  if (prices.length === 0) return { count: 0 };
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const ppsfs = items
    .filter((i) => typeof i.price === 'number' && typeof i.sqft === 'number' && i.sqft! > 0)
    .map((i) => i.price! / i.sqft!);
  const avgPpsf =
    ppsfs.length > 0 ? Math.round(ppsfs.reduce((a, b) => a + b, 0) / ppsfs.length) : undefined;
  return {
    count: prices.length,
    median_price: median,
    ...(avgPpsf !== undefined ? { avg_price_per_sqft: avgPpsf } : {}),
  };
}

export function registerMarketTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_market_report',
    {
      title: 'Get a homes.com market report for a location',
      description:
        "Fetch homes.com's recently-sold listings for a city/ZIP/neighborhood and derive a market summary: count, median sale price, and average $/sqft across the sample. Pass `location` — free-text (e.g. 'Brooklyn, NY', '30311'). Returns `{ region, slug, sold_summary, sample_sold }`. Note: homes.com's sold page typically returns ~40 recent listings — this is a sample-based summary, not an exhaustive market index. Read-only.",
      annotations: {
        title: 'Get a homes.com market report for a location',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        location: z
          .string()
          .describe('Free-text location: city, ZIP, neighborhood'),
      },
    },
    async ({ location }) => {
      const slug = locationToSlug(location);
      const path = `/${slug}/sold/`;
      const html = await client.fetchHtml(path);
      const doc = extractJsonLd(html);
      const { items } = findListings(doc);
      const sample = items
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null);
      return textResult({
        region: location,
        slug,
        sold_summary: computeMarketSummary(sample),
        sample_sold: sample,
      });
    }
  );
}
```

- [ ] **Step 5: Run; PASS.**

```bash
npm test -- tests/tools/market.test.ts
```

- [ ] **Step 6: Typecheck + commit.**

```bash
npx tsc --noEmit
git add src/tools/market.ts tests/tools/market.test.ts tests/fixtures/sold-page.html
git commit -m "feat: add homes_get_market_report from recently-sold listings"
```

---

## Task 9: `homes_get_saved_homes` and `homes_get_saved_searches`

**Files:**
- Create: `src/tools/saved.ts`
- Create: `tests/tools/saved.test.ts`
- Create: `tests/fixtures/saved-homes-populated.html`
- Create: `tests/fixtures/saved-homes-empty.html`
- Create: `tests/fixtures/saved-searches-populated.html`
- Create: `tests/fixtures/saved-searches-empty.html`

- [ ] **Step 1: Create the four fixtures.**

`tests/fixtures/saved-homes-populated.html`:

```html
<html><body>
<h1>Favorites</h1>
<section>
  <article class="favorite-card">
    <a href="https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/abc123/">
      <span class="address">3199 Delmar Ln NW, Atlanta, GA 30311</span>
      <span class="price">$315,000</span>
      <span class="beds">5 bd</span>
      <span class="baths">2 ba</span>
      <span class="sqft">2,116 sq ft</span>
      <span class="status">Active</span>
    </a>
  </article>
  <article class="favorite-card">
    <a href="https://www.homes.com/property/42-monroe-st-brooklyn-ny/def456/">
      <span class="address">42 Monroe St, Brooklyn, NY 11238</span>
      <span class="price">$2,150,000</span>
      <span class="beds">4 bd</span>
      <span class="baths">3.5 ba</span>
      <span class="sqft">2,800 sq ft</span>
    </a>
  </article>
</section>
</body></html>
```

`tests/fixtures/saved-homes-empty.html`:

```html
<html><body>
<h1>Favorites</h1>
<p>You haven't saved any homes yet.</p>
</body></html>
```

`tests/fixtures/saved-searches-populated.html`:

```html
<html><body>
<h1>Saved Searches</h1>
<section>
  <article class="saved-search-card">
    <a href="https://www.homes.com/atlanta-ga/condos-for-sale/">
      <h3>Atlanta condos under $500k</h3>
      <span class="filters">Condo · For Sale · $0–$500K</span>
    </a>
  </article>
  <article class="saved-search-card">
    <a href="https://www.homes.com/brooklyn-ny/townhouses-for-sale/">
      <h3>Brooklyn townhouses</h3>
      <span class="filters">Townhouse · For Sale</span>
    </a>
  </article>
</section>
</body></html>
```

`tests/fixtures/saved-searches-empty.html`:

```html
<html><body>
<h1>Saved Searches</h1>
<p>Stay in the know. Save your searches and get instant alerts when new homes hit the market.</p>
</body></html>
```

- [ ] **Step 2: Write failing tests `tests/tools/saved.test.ts`.**

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { HomesClient } from '../../src/client.js';
import {
  parseSavedHomes,
  parseSavedSearches,
  registerSavedTools,
} from '../../src/tools/saved.js';
import { parseHtml } from '../../src/html.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(resolve(__dirname, '../fixtures', n), 'utf8');
const HOMES_FULL = fx('saved-homes-populated.html');
const HOMES_EMPTY = fx('saved-homes-empty.html');
const SEARCHES_FULL = fx('saved-searches-populated.html');
const SEARCHES_EMPTY = fx('saved-searches-empty.html');

describe('parseSavedHomes', () => {
  it('returns one entry per favorite card', () => {
    const items = parseSavedHomes(parseHtml(HOMES_FULL));
    expect(items).toHaveLength(2);
    expect(items[0].property_id).toBe('abc123');
    expect(items[0].address).toContain('3199 Delmar');
    expect(items[0].price).toBe(315000);
    expect(items[0].beds).toBe(5);
    expect(items[0].baths).toBe(2);
    expect(items[0].sqft).toBe(2116);
    expect(items[0].status).toBe('Active');
    expect(items[1].baths).toBe(3.5);
  });

  it('returns [] for the empty state', () => {
    expect(parseSavedHomes(parseHtml(HOMES_EMPTY))).toEqual([]);
  });
});

describe('parseSavedSearches', () => {
  it('returns one entry per saved-search card', () => {
    const items = parseSavedSearches(parseHtml(SEARCHES_FULL));
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe('Atlanta condos under $500k');
    expect(items[0].url).toBe('https://www.homes.com/atlanta-ga/condos-for-sale/');
    expect(items[0].filters).toBe('Condo · For Sale · $0–$500K');
    expect(items[1].url).toBe('https://www.homes.com/brooklyn-ny/townhouses-for-sale/');
  });

  it('returns [] for the empty state', () => {
    expect(parseSavedSearches(parseHtml(SEARCHES_EMPTY))).toEqual([]);
  });
});

describe('homes_get_saved_homes / homes_get_saved_searches tools', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  const fetch = vi.fn();
  const c = { fetchHtml: fetch } as unknown as HomesClient;

  beforeAll(async () => {
    h = await createTestHarness((s) => registerSavedTools(s, c));
  });
  afterAll(async () => h?.close());

  it('saved_homes hits /customer/dashboard/favorites/ and returns parsed cards', async () => {
    fetch.mockResolvedValueOnce(HOMES_FULL);
    const p = parseToolResult<any>(await h.callTool('homes_get_saved_homes', {}));
    expect(fetch.mock.calls[0][0]).toBe('/customer/dashboard/favorites/');
    expect(p.count).toBe(2);
    expect(p.homes).toHaveLength(2);
  });

  it('saved_homes returns count:0 when empty', async () => {
    fetch.mockResolvedValueOnce(HOMES_EMPTY);
    const p = parseToolResult<any>(await h.callTool('homes_get_saved_homes', {}));
    expect(p.count).toBe(0);
    expect(p.homes).toEqual([]);
  });

  it('saved_searches hits /customer/dashboard/saved-searches/ and returns parsed cards', async () => {
    fetch.mockResolvedValueOnce(SEARCHES_FULL);
    const p = parseToolResult<any>(
      await h.callTool('homes_get_saved_searches', {})
    );
    expect(fetch.mock.calls[1][0]).toBe('/customer/dashboard/saved-searches/');
    expect(p.count).toBe(2);
    expect(p.searches).toHaveLength(2);
  });

  it('saved_searches returns count:0 when empty', async () => {
    fetch.mockResolvedValueOnce(SEARCHES_EMPTY);
    const p = parseToolResult<any>(await h.callTool('homes_get_saved_searches', {}));
    expect(p.count).toBe(0);
  });
});
```

- [ ] **Step 3: Run; FAIL.**

```bash
npm test -- tests/tools/saved.test.ts
```

- [ ] **Step 4: Implement `src/tools/saved.ts`.**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomesClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  parseHtml,
  parseDollar,
  parseIntegerLoose,
  type HTMLElement,
} from '../html.js';

export interface SavedHome {
  property_id: string;
  url: string;
  address?: string;
  price?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  status?: string;
}

export interface SavedSearch {
  url: string;
  name?: string;
  filters?: string;
}

const PROPERTY_LINK_RE = /\/property\/[^/]+\/([^/]+)\/?$/;

export function parseSavedHomes(root: HTMLElement): SavedHome[] {
  const cards = root.querySelectorAll(
    'article, [class*="favorite" i], [class*="saved" i]'
  );
  const seen = new Set<string>();
  const out: SavedHome[] = [];
  for (const card of cards) {
    const a = card.querySelector('a[href*="/property/"]');
    if (!a) continue;
    const href = a.getAttribute('href') ?? '';
    const m = PROPERTY_LINK_RE.exec(href.replace(/^https?:\/\/[^/]+/, ''));
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const addrEl = card.querySelector('.address, [class*="address" i]');
    const priceEl = card.querySelector('.price, [class*="price" i]');
    const bedsEl = card.querySelector('.beds, [class*="beds" i]');
    const bathsEl = card.querySelector('.baths, [class*="baths" i]');
    const sqftEl = card.querySelector('.sqft, [class*="sqft" i]');
    const statusEl = card.querySelector('.status, [class*="status" i]');
    const item: SavedHome = {
      property_id: id,
      url: href.startsWith('http')
        ? href
        : `https://www.homes.com${href.startsWith('/') ? href : '/' + href}`,
    };
    if (addrEl) item.address = addrEl.text.replace(/\s+/g, ' ').trim();
    if (priceEl) {
      const n = parseDollar(priceEl.text);
      if (n !== undefined) item.price = n;
    }
    if (bedsEl) {
      const n = parseIntegerLoose(bedsEl.text);
      if (n !== undefined) item.beds = n;
    }
    if (bathsEl) {
      const n = Number(bathsEl.text.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n)) item.baths = n;
    }
    if (sqftEl) {
      const n = parseIntegerLoose(sqftEl.text);
      if (n !== undefined) item.sqft = n;
    }
    if (statusEl) {
      const t = statusEl.text.replace(/\s+/g, ' ').trim();
      if (t) item.status = t;
    }
    out.push(item);
  }
  return out;
}

export function parseSavedSearches(root: HTMLElement): SavedSearch[] {
  const cards = root.querySelectorAll(
    'article, [class*="saved-search" i], [class*="search-card" i]'
  );
  const out: SavedSearch[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const a = card.querySelector('a[href]');
    if (!a) continue;
    const href = a.getAttribute('href') ?? '';
    if (!href || href.includes('/property/')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const item: SavedSearch = {
      url: href.startsWith('http')
        ? href
        : `https://www.homes.com${href.startsWith('/') ? href : '/' + href}`,
    };
    const titleEl = card.querySelector('h2, h3, h4');
    if (titleEl) item.name = titleEl.text.replace(/\s+/g, ' ').trim();
    const filtersEl = card.querySelector('.filters, [class*="filter" i]');
    if (filtersEl) item.filters = filtersEl.text.replace(/\s+/g, ' ').trim();
    out.push(item);
  }
  return out;
}

export function registerSavedTools(
  server: McpServer,
  client: HomesClient
): void {
  server.registerTool(
    'homes_get_saved_homes',
    {
      title: "Get the signed-in user's saved homes on homes.com",
      description:
        "The signed-in user's saved (favorited) homes on homes.com. Scrapes /customer/dashboard/favorites/. Returns `{ count, homes: [{ property_id, url, address?, price?, beds?, baths?, sqft?, status? }] }`. Requires the user to be signed in (the fetchproxy bridge handles auth automatically). Read-only; safe to call repeatedly.",
      annotations: {
        title: "Get the signed-in user's saved homes on homes.com",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/customer/dashboard/favorites/');
      const root = parseHtml(html);
      const homes = parseSavedHomes(root);
      return textResult({ count: homes.length, homes });
    }
  );

  server.registerTool(
    'homes_get_saved_searches',
    {
      title: "Get the signed-in user's saved searches on homes.com",
      description:
        "The signed-in user's saved searches on homes.com. Scrapes /customer/dashboard/saved-searches/. Returns `{ count, searches: [{ name?, url, filters? }] }`. Requires the user to be signed in. Read-only; safe to call repeatedly.",
      annotations: {
        title: "Get the signed-in user's saved searches on homes.com",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/customer/dashboard/saved-searches/');
      const root = parseHtml(html);
      const searches = parseSavedSearches(root);
      return textResult({ count: searches.length, searches });
    }
  );
}
```

- [ ] **Step 5: Run; PASS.**

```bash
npm test -- tests/tools/saved.test.ts
```

- [ ] **Step 6: Typecheck + commit.**

```bash
npx tsc --noEmit
git add src/tools/saved.ts tests/tools/saved.test.ts tests/fixtures/saved-homes-populated.html tests/fixtures/saved-homes-empty.html tests/fixtures/saved-searches-populated.html tests/fixtures/saved-searches-empty.html
git commit -m "feat: add homes_get_saved_homes and homes_get_saved_searches"
```

---

## Task 10: `homes_estimate_rent_vs_buy` (local-only)

**Files:**
- Create: `src/tools/rent-vs-buy.ts`
- Create: `tests/tools/rent-vs-buy.test.ts`

- [ ] **Step 1: Write failing tests `tests/tools/rent-vs-buy.test.ts`.**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  estimateRentVsBuy,
  registerRentVsBuyTools,
} from '../../src/tools/rent-vs-buy.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

describe('estimateRentVsBuy', () => {
  it('returns horizon-length cumulative arrays', () => {
    const r = estimateRentVsBuy({
      home_price: 500000,
      down_payment: 100000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 7,
    });
    expect(r.cumulative_buy_cost).toHaveLength(7);
    expect(r.cumulative_rent_cost).toHaveLength(7);
    expect(r.horizon_years).toBe(7);
  });

  it('cumulative buy cost starts roughly at down + closing in year 1', () => {
    const r = estimateRentVsBuy({
      home_price: 500000,
      down_payment: 100000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 1,
      closing_cost_rate: 2.5,
    });
    // year 1 cost roughly = down (100k) + closing (12.5k) + PITI*12 + maintenance - appreciation gain
    expect(r.cumulative_buy_cost[0]).toBeGreaterThan(100000 + 12000);
  });

  it('finds a finite break_even_year when buying eventually wins', () => {
    const r = estimateRentVsBuy({
      home_price: 500000,
      down_payment: 100000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 30,
    });
    expect(typeof r.break_even_year).toBe('number');
    expect(r.break_even_year).toBeGreaterThanOrEqual(1);
    expect(r.break_even_year).toBeLessThanOrEqual(30);
  });

  it('returns null break_even_year when renting wins for the whole horizon', () => {
    const r = estimateRentVsBuy({
      home_price: 5_000_000,
      down_payment: 1_000_000,
      interest_rate: 9.0,
      monthly_rent: 500, // very cheap rent → never break even
      horizon_years: 7,
      investment_return_rate: 10,
      appreciation_rate: 0,
    });
    expect(r.break_even_year).toBeNull();
  });

  it('net_difference_at_horizon = rent_cumulative - buy_cumulative at year H', () => {
    const r = estimateRentVsBuy({
      home_price: 500000,
      down_payment: 100000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 7,
    });
    const expected =
      r.cumulative_rent_cost[6] - r.cumulative_buy_cost[6];
    expect(r.net_difference_at_horizon).toBeCloseTo(expected, 0);
  });
});

describe('homes_estimate_rent_vs_buy tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  beforeAll(async () => {
    h = await createTestHarness((s) => registerRentVsBuyTools(s));
  });
  afterAll(async () => h?.close());

  it('round-trips through the tool', async () => {
    const p = parseToolResult<any>(
      await h.callTool('homes_estimate_rent_vs_buy', {
        home_price: 500000,
        down_payment: 100000,
        interest_rate: 6.5,
        monthly_rent: 2500,
        horizon_years: 5,
      })
    );
    expect(p.cumulative_buy_cost).toHaveLength(5);
    expect(p.cumulative_rent_cost).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run; FAIL.**

```bash
npm test -- tests/tools/rent-vs-buy.test.ts
```

- [ ] **Step 3: Implement `src/tools/rent-vs-buy.ts`.**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';

export interface RentVsBuyInput {
  home_price: number;
  down_payment: number;
  interest_rate: number;
  monthly_rent: number;
  horizon_years?: number;
  loan_term_years?: number;
  property_tax_rate?: number;
  insurance_annual?: number;
  hoa_monthly?: number;
  closing_cost_rate?: number;
  selling_cost_rate?: number;
  maintenance_rate?: number;
  appreciation_rate?: number;
  rent_growth_rate?: number;
  investment_return_rate?: number;
}

export interface RentVsBuyResult {
  horizon_years: number;
  cumulative_buy_cost: number[];
  cumulative_rent_cost: number[];
  break_even_year: number | null;
  net_difference_at_horizon: number;
  inputs_used: Required<Omit<RentVsBuyInput, 'home_price' | 'down_payment' | 'interest_rate' | 'monthly_rent'>> & {
    home_price: number;
    down_payment: number;
    interest_rate: number;
    monthly_rent: number;
  };
}

function monthlyPI(loan: number, annualRate: number, years: number): number {
  if (loan <= 0) return 0;
  if (annualRate <= 0) return loan / (years * 12);
  const r = annualRate / 100 / 12;
  const n = years * 12;
  return (loan * r) / (1 - Math.pow(1 + r, -n));
}

export function estimateRentVsBuy(input: RentVsBuyInput): RentVsBuyResult {
  const horizon = input.horizon_years ?? 7;
  const term = input.loan_term_years ?? 30;
  const taxRate = (input.property_tax_rate ?? 1.1) / 100;
  const insuranceAnnual = input.insurance_annual ?? 0;
  const hoaMonthly = input.hoa_monthly ?? 0;
  const closingRate = (input.closing_cost_rate ?? 2.5) / 100;
  const sellingRate = (input.selling_cost_rate ?? 6.0) / 100;
  const maintRate = (input.maintenance_rate ?? 1.0) / 100;
  const apprRate = (input.appreciation_rate ?? 3.0) / 100;
  const rentGrow = (input.rent_growth_rate ?? 3.0) / 100;
  const invReturn = (input.investment_return_rate ?? 6.0) / 100;

  const loan = Math.max(0, input.home_price - input.down_payment);
  const piMonthly = monthlyPI(loan, input.interest_rate, term);

  const buy: number[] = [];
  const rent: number[] = [];
  let homeValue = input.home_price;
  let monthlyRent = input.monthly_rent;
  let renterInvestPool = input.down_payment + input.home_price * closingRate;
  let buyOutflow = input.down_payment + input.home_price * closingRate;

  for (let y = 1; y <= horizon; y++) {
    const annualPI = piMonthly * 12;
    const annualTax = homeValue * taxRate;
    const annualMaint = homeValue * maintRate;
    buyOutflow += annualPI + annualTax + insuranceAnnual + hoaMonthly * 12 + annualMaint;
    homeValue *= 1 + apprRate;

    // Renter's parallel cost: rent + opportunity cost of the down payment kept invested.
    const annualRent = monthlyRent * 12;
    renterInvestPool *= 1 + invReturn;
    const renterCostOfCapital = renterInvestPool * (invReturn / (1 + invReturn));
    // Simpler: total renter outlay each year is just the rent. We model
    // the opportunity-cost gap by tracking the renter's investment pool
    // separately and subtracting the buyer's lost-investment equivalent
    // from buy cost at the end (= subtract the gain the renter made on
    // the same starting capital). We'll fold that into the final compare.
    rent.push((rent[y - 2] ?? 0) + annualRent);

    // Buy cost minus sale-proceeds-if-sold-now (home value - sell cost - remaining loan).
    // For an honest cumulative-cost-of-ownership view, do not subtract sale
    // proceeds for years before horizon. At horizon, compute net cost.
    if (y < horizon) {
      buy.push(buyOutflow);
    } else {
      const remainingLoanY = remainingLoanAfterYears(loan, input.interest_rate, term, y);
      const saleProceeds = homeValue * (1 - sellingRate) - remainingLoanY;
      const renterAdvantage = renterInvestPool - (input.down_payment + input.home_price * closingRate);
      buy.push(buyOutflow - saleProceeds + renterAdvantage);
    }
    monthlyRent *= 1 + rentGrow;
  }

  let breakEven: number | null = null;
  for (let i = 0; i < horizon; i++) {
    if (buy[i] <= rent[i]) {
      breakEven = i + 1;
      break;
    }
  }

  return {
    horizon_years: horizon,
    cumulative_buy_cost: buy.map(round2),
    cumulative_rent_cost: rent.map(round2),
    break_even_year: breakEven,
    net_difference_at_horizon: round2(rent[horizon - 1] - buy[horizon - 1]),
    inputs_used: {
      home_price: input.home_price,
      down_payment: input.down_payment,
      interest_rate: input.interest_rate,
      monthly_rent: input.monthly_rent,
      horizon_years: horizon,
      loan_term_years: term,
      property_tax_rate: input.property_tax_rate ?? 1.1,
      insurance_annual: insuranceAnnual,
      hoa_monthly: hoaMonthly,
      closing_cost_rate: input.closing_cost_rate ?? 2.5,
      selling_cost_rate: input.selling_cost_rate ?? 6.0,
      maintenance_rate: input.maintenance_rate ?? 1.0,
      appreciation_rate: input.appreciation_rate ?? 3.0,
      rent_growth_rate: input.rent_growth_rate ?? 3.0,
      investment_return_rate: input.investment_return_rate ?? 6.0,
    },
  };
}

function remainingLoanAfterYears(
  loan: number,
  annualRate: number,
  termYears: number,
  yearsElapsed: number
): number {
  if (loan <= 0) return 0;
  if (annualRate <= 0) {
    return Math.max(0, loan - (loan / (termYears * 12)) * (yearsElapsed * 12));
  }
  const r = annualRate / 100 / 12;
  const n = termYears * 12;
  const k = yearsElapsed * 12;
  return Math.max(
    0,
    (loan * (Math.pow(1 + r, n) - Math.pow(1 + r, k))) / (Math.pow(1 + r, n) - 1)
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function registerRentVsBuyTools(server: McpServer): void {
  server.registerTool(
    'homes_estimate_rent_vs_buy',
    {
      title: 'Project cumulative buy-vs-rent cost over N years',
      description:
        'Project the cumulative cost of buying a home versus renting a comparable place over N years. Accounts for down payment, closing costs, monthly PITI, maintenance (~1%/yr default), appreciation (~3%/yr default), rent growth (~3%/yr default), and the opportunity cost of the down payment (renter invests it at investment_return_rate, default 6%/yr). Returns year-by-year cumulative costs, break-even year, and the net difference at horizon. No network — pure local math. Same math contract as zillow_estimate_rent_vs_buy.',
      annotations: {
        title: 'Project cumulative buy-vs-rent cost over N years',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        home_price: z.number().positive(),
        down_payment: z.number().nonnegative(),
        interest_rate: z.number().nonnegative(),
        monthly_rent: z.number().nonnegative(),
        horizon_years: z.number().int().positive().optional(),
        loan_term_years: z.number().int().positive().optional(),
        property_tax_rate: z.number().nonnegative().optional(),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        closing_cost_rate: z.number().nonnegative().optional(),
        selling_cost_rate: z.number().nonnegative().optional(),
        maintenance_rate: z.number().nonnegative().optional(),
        appreciation_rate: z.number().optional(),
        rent_growth_rate: z.number().optional(),
        investment_return_rate: z.number().nonnegative().optional(),
      },
    },
    async (i) => textResult(estimateRentVsBuy(i as RentVsBuyInput))
  );
}
```

- [ ] **Step 4: Run; PASS.**

```bash
npm test -- tests/tools/rent-vs-buy.test.ts
```

- [ ] **Step 5: Typecheck + commit.**

```bash
npx tsc --noEmit
git add src/tools/rent-vs-buy.ts tests/tools/rent-vs-buy.test.ts
git commit -m "feat: add homes_estimate_rent_vs_buy (local-only)"
```

---

## Task 11: Register all new tools in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports and registrations.**

In `src/index.ts`, after the existing `import { registerHealthcheckTools }` line, add:

```ts
import { registerHistoryTools } from './tools/history.js';
import { registerNearbyTools } from './tools/nearby.js';
import { registerMarketTools } from './tools/market.js';
import { registerSavedTools } from './tools/saved.js';
import { registerRentVsBuyTools } from './tools/rent-vs-buy.js';
```

After the existing `registerHealthcheckTools(server, client);` line, add:

```ts
registerHistoryTools(server, client);
registerNearbyTools(server, client);
registerMarketTools(server, client);
registerSavedTools(server, client);
registerRentVsBuyTools(server);
```

- [ ] **Step 2: Build the bundle.**

```bash
npm run build
```

Expected: zero TS errors, `dist/bundle.js` rebuilt.

- [ ] **Step 3: Run full test suite.**

```bash
npm test
```

Expected: all tests across all files pass.

- [ ] **Step 4: Add a smoke test for the new tool count in `tests/index.test.ts`.**

Read the existing file first, then update the asserted tool-name list:

```bash
cat tests/index.test.ts
```

Look for a test that lists tools (find the snippet that calls `listTools`). Append the new tool names to the expected list. The expected names are:

```
homes_search_properties
homes_get_property
homes_get_property_photos
homes_compare_properties
homes_calculate_mortgage
homes_calculate_affordability
homes_healthcheck
homes_get_property_history
homes_get_tax_history
homes_get_nearby_listings
homes_get_market_report
homes_get_saved_homes
homes_get_saved_searches
homes_estimate_rent_vs_buy
```

Update the existing assertion to match all 14 names. If the test asserts a specific count, change it to 14.

- [ ] **Step 5: Run.**

```bash
npm test -- tests/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: register new tools in index entrypoint"
```

---

## Task 12: Update CLAUDE.md to reflect the new surface

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read the current CLAUDE.md.**

```bash
cat CLAUDE.md
```

- [ ] **Step 2: Make these edits with `Edit`:**

A. In the "Tool surface" table, append 7 new rows:

```
| `homes_get_property_history` | `tools/history.ts` | Same SSR detail page — parse Property/Purchase/Mortgage History tables | read |
| `homes_get_tax_history` | `tools/history.ts` | Same SSR detail page — parse Tax History table | read |
| `homes_get_nearby_listings` | `tools/nearby.ts` | Same SSR detail page — scrape "Homes for Sale Near" link cards | read |
| `homes_get_market_report` | `tools/market.ts` | `GET /<city-slug>/sold/` — derive median/avg from JSON-LD itemListElement | read |
| `homes_get_saved_homes` | `tools/saved.ts` | `GET /customer/dashboard/favorites/` — auth-gated DOM scrape | read (auth) |
| `homes_get_saved_searches` | `tools/saved.ts` | `GET /customer/dashboard/saved-searches/` — auth-gated DOM scrape | read (auth) |
| `homes_estimate_rent_vs_buy` | `tools/rent-vs-buy.ts` | (local; no network) | read |
```

B. Add a new file under the Architecture tree:

```
  html.ts               # shared HTML scraping helpers built on
                        #   node-html-parser (table extractor, section
                        #   finder, link list, normalizeDate/Dollar/etc).
```

C. In the "homes.com quirks" section, REMOVE this line entirely:

> **No price-history, saved-listings, or market-report surface.** These are auth-gated or unavailable in the SSR HTML, so v0.1 ships without them entirely (tools deleted, not stubbed).

D. ADD a new quirk section right after "Photos are DOM-only":

> **Path-based search filters.** homes.com routes filter facets through URL paths, not query strings — `?bed_min=2` is dropped at the edge. Supported paths verified live 2026-05-26: `/<city>/houses-for-sale/`, `/condos-for-sale/`, `/townhouses-for-sale/`, `/land-for-sale/`, `/mobile-homes-for-sale/`, `/multi-family-for-sale/`, `/sold/`, `/homes-for-rent/`, `/<type>-for-rent/`, `/open-houses/`, `/newest/`, and `/new-homes/for-sale/<city>/`. `homes_search_properties` composes these via `property_type`, `listing_type`, `sort`.

> **History + tax data are in HTML tables, not JSON-LD.** Every property detail page server-renders four tables — Property History, Purchase History, Mortgage History, Tax History — whose row schemas are stable but lack semantic markup. `src/tools/history.ts` reads them via `findTableByHeading` from `src/html.ts` (built on `node-html-parser`). Date formats are mixed: Property History uses `MM/DD/YYYY`; Purchase + Mortgage use `MM/DD/YY` (50-year window). All dates are normalized to ISO 8601 in tool output.

> **Saved homes + saved searches are auth-only.** `/customer/dashboard/favorites/` and `/customer/dashboard/saved-searches/` work from a signed-in tab and return populated HTML; not signed in → `SessionNotAuthenticatedError` (already handled by `throwIfSignInPage`).

- [ ] **Step 3: Run tests + typecheck + commit.**

```bash
npm test && npx tsc --noEmit
git add CLAUDE.md
git commit -m "docs(claude): update CLAUDE.md for v0.7 parity surface"
```

---

## Task 13: Live verification + open PR

**Files:** none

- [ ] **Step 1: Ensure fetchproxy bridge is connected.**

Run:

```bash
npm run build && node dist/bundle.js &
```

In a separate shell, run `homes_healthcheck` via the MCP client (use the actual `mcp__homes_com__homes_healthcheck` once the bridge is up).

If healthcheck still returns `ok: false`:
- Confirm the fetchproxy browser extension is installed and shows a green dot next to "homes-mcp".
- Confirm a homes.com tab is open and signed in.
- If still failing, STOP and ask the user to fix the extension before continuing.

- [ ] **Step 2: Exercise each new tool once against the live signed-in tab.**

Run each in turn and verify the response shape is non-empty:

```
homes_get_property_history { url: "https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/" }
homes_get_tax_history { url: "https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/" }
homes_get_nearby_listings { url: "https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/" }
homes_get_market_report { location: "Brooklyn, NY" }
homes_get_saved_homes {}
homes_get_saved_searches {}
homes_estimate_rent_vs_buy { home_price: 500000, down_payment: 100000, interest_rate: 6.5, monthly_rent: 2500 }
homes_search_properties { location: "Atlanta, GA", property_type: "condo", listing_type: "for_sale" }
homes_get_property { url: "https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/" }  // verify new fields present
```

If any fail (other than empty-state success — `count: 0` is fine), capture the actual HTML from the live page and update the fixture + parser before moving on.

- [ ] **Step 3: Push branch + open PR.**

The branch was created at session start (or in Task 0). Push and PR:

```bash
git push -u origin HEAD
gh pr create --label enhancement --title "feat: v0.7 — Zillow/Redfin/Compass parity" --body "$(cat <<'EOF'
## Summary

Adds 7 new tools and extends 2 existing ones to bring homes-mcp to broad
parity with the zillow-mcp / redfin-mcp / compass-mcp surfaces, where
the data is verifiably present in homes.com SSR HTML.

New tools:
- \`homes_get_property_history\` — listing + ownership (deed) + lien events in one call
- \`homes_get_tax_history\` — year-by-year tax records
- \`homes_get_nearby_listings\` — scrape "Homes for Sale Near" cards
- \`homes_get_market_report\` — median price + $/sqft from /sold/ page
- \`homes_get_saved_homes\` — auth-gated favorites
- \`homes_get_saved_searches\` — auth-gated saved searches
- \`homes_estimate_rent_vs_buy\` — local-only math, matches zillow contract

Extended:
- \`homes_search_properties\` — new \`property_type\`, \`listing_type\`, \`sort\` (path-based filters)
- \`homes_get_property\` — adds description, highlights, schools, HOA, MLS, lot, parking, HVAC, Matterport, floorplans

Adds one runtime dep: \`node-html-parser\` (~50 KB, zero transitive deps).
Existing \`photos.ts\` regex parser unchanged.

Skipped (data genuinely absent from homes.com SSR): climate risk, Walk/Transit Score, property-bound rental comparables.

## Test plan

- [ ] \`npm test\` — all green (unit tests, mocked HomesClient + captured-HTML fixtures)
- [ ] \`npx tsc --noEmit\` — zero errors
- [ ] Live: \`homes_healthcheck\` returns ok
- [ ] Live: each new tool returns a non-empty (or empty-state-as-designed) response

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Confirm PR opened.** Capture the URL and report it.

---

## Self-review checklist (already run by plan author)

- **Spec coverage:** every new tool in the spec has a task (3, 4, 5, 6, 7, 8, 9, 10). HTML helpers covered in Task 2. Search extension in Task 3. Property extension in Task 4. Index registration in Task 11. CLAUDE.md in Task 12. Live verification in Task 13.
- **Placeholders:** none — every step has the actual code or command.
- **Type consistency:** `FormattedProperty.schools` typed as `School[]`; `SavedHome`, `SavedSearch`, `NearbyListing`, `ListingEvent`, `OwnershipEvent`, `LienEvent`, `TaxRecord`, `SoldSummary`, `RentVsBuyResult` all named consistently with the spec and with each other. `parseHtml` / `findTableByHeading` / `tableRows` / `findLinksUnderHeading` exported from `src/html.ts` and imported by name in every consumer.
- **TDD discipline:** each task writes failing tests first, then implementation, then runs to PASS, then commits.
- **Frequent commits:** 12 commits across 13 tasks (Task 0 is read-only).
