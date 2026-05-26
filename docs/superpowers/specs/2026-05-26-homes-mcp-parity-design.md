# homes-mcp v0.7 — feature parity with Zillow / Redfin / Compass

Spec author: Claude (Opus 4.7)
Date: 2026-05-26
Status: approved by user (pre-approval, 2026-05-26)

## Goal

Bring `homes-mcp` from 7 tools to 14 tools with broad parity to the
`zillow-mcp` / `redfin-mcp` / `compass-mcp` surfaces, where the data is
verifiably available in homes.com server-rendered HTML (signed-in
session, fetched via the user's existing `@fetchproxy/server` bridge).

Skips features that homes.com genuinely doesn't expose — climate risk,
Walk/Transit Score, property-bound rental comparables — rather than
shipping placeholder tools.

## Live-probed feasibility (2026-05-26)

Verified against a signed-in tab at
`/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/`,
`/brooklyn-ny/`, `/customer/dashboard/favorites/`,
`/customer/dashboard/saved-searches/`.

| Capability | homes.com SSR availability | Shape |
|---|---|---|
| Property history (listings/price-changes/sales) | `<table>` "Property History" | Date · Event · Price · List-to-Sale % · $/sqft |
| Tax history | `<table>` "Tax History" | Year · Tax Paid · Assessment · Land · Improvement |
| Purchase history (deeds) | `<table>` "Purchase History" | Date · Type · Sale Price · Title Company |
| Mortgage/lien history | `<table>` "Mortgage History" | Date · Status · Loan Amount · Loan Type |
| Saved homes | `/customer/dashboard/favorites/` (auth) | property cards |
| Saved searches | `/customer/dashboard/saved-searches/` (auth) | search cards |
| Nearby listings | "Homes for Sale" section on detail page | property links |
| Area market summary | "Average Home Value in this Area" + `/<city>/sold/` page | scrape |
| Richer search filters | path-based slugs: `houses-for-sale/`, `condos-for-sale/`, `townhouses-for-sale/`, `land-for-sale/`, `mobile-homes-for-sale/`, `open-houses/`, `sold/`, `newest/`, `homes-for-rent/`, `apartments-for-rent/`, `townhouses-for-rent/`, `condos-for-rent/`, `new-homes/for-sale/<city>/` | URL composition |
| Richer property fields | already in fetched detail HTML | DOM scrape |

Not available — explicitly skipped:
- Climate risk / flood / fire (no First Street partnership).
- Walk Score / Transit Score (no third-party widget).
- Redfin-style nearby rental comparables tied to a specific property's rent estimate.

## Tool surface

### New tools (7)

| Tool | Inputs | Returns |
|---|---|---|
| `homes_get_property_history` | `url` | `{ property_id, url, listing_events[], ownership_events[], lien_events[] }` |
| `homes_get_tax_history` | `url` | `{ property_id, url, records: [{ year, tax_paid, assessment_total, assessment_land, assessment_improvement }] }` |
| `homes_get_nearby_listings` | `url`, `limit?` | `{ property_id, url, count, listings: FormattedHome[] }` |
| `homes_get_market_report` | `location` | `{ region, slug, median_home_value?, sold_summary?: { count, median_price, avg_price_per_sqft, period }, sample_sold: FormattedHome[] }` |
| `homes_get_saved_homes` | none | `{ count, homes: [{ url, address, city, state, zip, price?, beds?, baths?, sqft?, saved_at?, status? }] }` |
| `homes_get_saved_searches` | none | `{ count, searches: [{ name?, location?, url, filters?: string[], created_at?, last_notified_at? }] }` |
| `homes_estimate_rent_vs_buy` | `home_price`, `down_payment`, `interest_rate`, `monthly_rent`, optional growth/return rates (identical shape to `zillow_estimate_rent_vs_buy`) | year-by-year cumulative cost arrays + break-even year + net difference at horizon |

### Extended tools (2)

`homes_search_properties` — new optional inputs:

| Input | Values | Effect on URL |
|---|---|---|
| `property_type` | `single_family` \| `condo` \| `townhouse` \| `land` \| `mobile` \| `multi_family` | inserts `/houses-for-sale/`, `/condos-for-sale/`, `/townhouses-for-sale/`, `/land-for-sale/`, `/mobile-homes-for-sale/`, `/multi-family-for-sale/` |
| `listing_type` | `for_sale` (default) \| `sold` \| `for_rent` \| `open_houses` \| `new_construction` | inserts `/sold/`, `/homes-for-rent/`, `/open-houses/`, or rewrites root to `/new-homes/for-sale/<city>/` |
| `sort` | `newest` | appends `/newest/` |

`property_type` × `listing_type` composes correctly for the combinations homes.com supports (e.g. `condo` + `for_rent` → `/condos-for-rent/`). Unsupported combinations fall back to the broader URL (e.g. `mobile` + `for_rent` is not a homes.com path — use `mobile` + `for_sale`).

`homes_get_property` — new optional output fields (all `?` because they vary by listing):

```
description, highlights[], estimated_monthly_payment, total_views,
matterport_url, floorplan_urls[], schools: [{ name, level, district? }],
hoa_fee, lot_size_sqft, lot_size_acres, parking, heating, cooling,
mls_id, mls_source, days_on_market
```

Backward-compat: existing fields keep their names and types.

### Unchanged (5)

`homes_get_property_photos`, `homes_compare_properties`, `homes_calculate_mortgage`, `homes_calculate_affordability`, `homes_healthcheck`.

## File layout

```
src/
  tools/
    history.ts        # homes_get_property_history + homes_get_tax_history
                      #   (one file — both scrape the same detail page)
    nearby.ts         # homes_get_nearby_listings
    market.ts         # homes_get_market_report
    saved.ts          # homes_get_saved_homes + homes_get_saved_searches
    rent-vs-buy.ts    # homes_estimate_rent_vs_buy (local-only)
    search.ts         # EXTEND — new optional inputs, new path composer
    properties.ts     # EXTEND — additional fields on FormattedProperty
  html.ts             # NEW — small HTML-parsing helpers shared across tools
                      #   (table extractor, text-of-section finder, link list)
tests/
  tools/
    history.test.ts
    nearby.test.ts
    market.test.ts
    saved.test.ts
    rent-vs-buy.test.ts
  fixtures/           # NEW — captured HTML snippets used by table-parser tests
    property-history-table.html
    tax-history-table.html
    purchase-history-table.html
    mortgage-history-table.html
    saved-homes-page.html
    saved-searches-page.html
    sold-page.html
```

Index changes: `src/index.ts` registers the 7 new tool groups alongside the existing 7.

## Architecture decisions

### HTML parsing library

**Decision:** add `node-html-parser` (~50 KB, zero runtime deps, fast, returns a queryable DOM-ish tree).

Why not regex like `photos.ts`: scraping `<table>` rows with nested `<td><span>…</span></td>` markup is brittle in regex (multi-line, ordering, escapes). Saved-homes cards have similar nested markup. node-html-parser is the smallest credible option that still gives us `querySelector` / `querySelectorAll` semantics.

Why not cheerio: jQuery API surface, several MB of deps, much heavier than the need.

Why not a hand-rolled DOM walker: real time spent on edge cases (HTML entities, malformed tags, comments) we'd get for free.

`photos.ts` keeps its current regex — its job (one attribute per `<img>` tag) is well-suited to regex and the test surface is already proven.

### Tool registration pattern

Each new tool file follows the existing pattern (`registerXxxTools(server, client)`). `src/index.ts` calls them in order. No registry abstraction — explicit registration matches the project's stated convention.

### Path composition for search

A pure function `buildSearchPath(input)` in `search.ts` composes the URL slug:

```
location_slug = locationToSlug(location)                  // "atlanta-ga", "94110"
type_slug     = property_type_to_slug(property_type)      // "houses", "condos", …
listing_slug  = listing_type_to_slug(listing_type)        // "for-sale", "for-rent", …
sort_slug     = sort_to_slug(sort)                        // "newest" or ""

// Special case: new_construction rewrites the root path
if listing_type === 'new_construction':
  return `/new-homes/for-sale/${location_slug}/`

// Otherwise: /<location>/<type-listing>/[sort]/
segment = type_slug ? `${type_slug}-${listing_slug}` : listing_slug
return sort_slug
  ? `/${location_slug}/${segment}/${sort_slug}/`
  : `/${location_slug}/${segment}/`
```

This is a pure function — fully unit-testable, no network.

### History tool shape

One call, three series (matches what's on the page):

```typescript
{
  property_id: string,
  url: string,
  listing_events: [
    { date: string, event: string, price?: number, list_to_sale_pct?: number, price_per_sqft?: number }
  ],
  ownership_events: [
    { date: string, deed_type?: string, sale_price?: number, title_company?: string }
  ],
  lien_events: [
    { date: string, status?: string, loan_amount?: number, loan_type?: string }
  ]
}
```

When a table is missing on a listing (e.g. new construction has no mortgage history), the corresponding array is `[]` — never null.

**Date normalization.** homes.com mixes formats across tables: `MM/DD/YYYY` (Property History), `MM/DD/YY` (Purchase / Mortgage History). All date fields are normalized to ISO 8601 `YYYY-MM-DD` in output. Two-digit years use the 50-year sliding window: `00–49` → `20xx`, `50–99` → `19xx`. Unparseable dates pass through as the raw string with a `date_raw` field added.

### Auth-gated tools

`homes_get_saved_homes` and `homes_get_saved_searches` rely on `HomesClient.fetchHtml` already throwing `SessionNotAuthenticatedError` on the sign-in interstitial. Tests verify both the populated and empty-state pages — empty state still loads (not a sign-in redirect), so the tools return `count: 0` cleanly.

### Market report

Single tool: `homes_get_market_report(location)`. Internally:

1. Resolve `location → slug`.
2. Fetch `/<slug>/sold/` page.
3. Parse JSON-LD `CollectionPage.mainEntity.itemListElement[]` for recent sold listings.
4. Derive `sold_summary` (count, median price, mean $/sqft, time period from listing dates).
5. If the sold page or area-overview block exposes a homes.com-published median value (TBD during implementation — probe before relying on it), surface it as `median_home_value`. Otherwise omit the field rather than fabricate one.

The output shape lists `median_home_value` as **optional**. Tests cover both the `with_median` and `without_median` cases — fixture files for each.

### Rent-vs-buy

Pure local math. Same shape as `zillow_estimate_rent_vs_buy` for cross-tool consistency. Lives in `src/tools/rent-vs-buy.ts`. No network. Tests are pure-function tests with known fixtures.

### Error handling

Existing patterns continue:
- Non-2xx → `Error` with status code and body preview.
- Sign-in interstitial → `SessionNotAuthenticatedError` (already in `client.ts`).
- Missing JSON-LD on a page that should have it → `Error("Could not locate JSON-LD at <path>…")`.
- Missing table on a detail page → corresponding array is `[]` (not an error — it just means that property has no history of that kind yet).

## Testing approach

**TDD throughout.** Write the failing test first, then the implementation.

- **Unit tests** mock `HomesClient.fetchHtml` (existing harness in `tests/helpers.ts`) and feed fixture HTML.
- **Fixture files** under `tests/fixtures/` are static snippets captured from real homes.com responses, trimmed to the relevant section (not full pages — bytes matter).
- **Path-composer tests** for `buildSearchPath` cover every supported `property_type` × `listing_type` × `sort` combination plus invalid inputs.
- **History parser tests** cover: full listing with all 4 tables, listing with only some tables, listing with empty tables, table with malformed rows (graceful skip).
- **Saved-homes parser tests** cover: populated state, empty state, sign-in interstitial (re-throws `SessionNotAuthenticatedError`).
- **Rent-vs-buy tests** are pure-function fixture tests (no mocking needed) — verify break-even year for several scenarios with hand-computed expected values.
- **`vitest`** as the test runner, matching existing convention.
- **Coverage** target: keep at parity with current (no new untested branches).

No live homes.com traffic in unit tests. Live verification (run `homes_healthcheck`, then exercise each new tool against a real signed-in tab) happens at the end of implementation.

## Versioning + release

- **No manual version bumps.** release-please owns versioning. The accumulated `feat:` commits will trigger a minor bump (0.6.0 → 0.7.0) automatically.
- **CLAUDE.md updates:** rewrite the "What to not do" / "homes.com quirks" sections to remove the now-incorrect "No price-history, saved-listings, or market-report surface" claim. Add a section documenting the path-based filter scheme and the table-scraping pattern.
- **README/SKILL.md/server.json descriptions:** keep tight; the per-tool descriptions already explain what each does.
- **One PR per logical change** is the project default, but the scope here (~7 new tools sharing infrastructure) warrants one cohesive PR labelled `enhancement`.

## Out of scope

- Climate risk, Walk Score, Transit Score — not in homes.com SSR.
- Property-bound rental comparables (Redfin-style join). homes.com doesn't compute this.
- Polygon / map-bounds search. URL shape not stable enough to commit to.
- Co-shopping (collaboration) endpoints (`/customer/account/co-shopping/`). Out of scope for read-only v0.7.
- Listing-agent profile pages and "Other Listings" tool. Not requested.
- Mortgage rate lookups. No homes.com SSR endpoint exposes raw rates.

## Risks

- **homes.com page structure can change.** The table-based scrapers are fragile by definition. Mitigation: each scraper has a `findSectionByHeading('Tax History')`-style fallback that scans the DOM for a near-match heading before bailing out. When parsing fails entirely, return `[]` and log to stderr (never throw — let the rest of the tool succeed).
- **Some listings genuinely lack some tables.** Handle as `[]`, not an error.
- **AWS WAF challenges.** Existing `throwIfSignInPage` already catches the WAF interstitial. New tools inherit this for free via `client.fetchHtml`.
- **Saved-homes/searches pages render via client-side React for some viewports.** SSR HTML may or may not include the populated list. Mitigation: tests cover both populated and empty states from real captured HTML; if the populated state arrives empty for some users, document as a known limitation.
