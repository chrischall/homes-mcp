# CLAUDE.md — homes-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.1.0: homes.com MCP server. Default and only transport: localhost WebSocket via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the companion browser extension is installed separately rather than embedded. Every HTTP call to homes.com is dispatched through the user's signed-in Chrome tab — each request rides their existing session (cookies, TLS, JS context) exactly as if they'd clicked it themselves.

This is a "Pattern A" fetchproxy MCP (every call rides through fetchproxy), not "Pattern B" (one bootstrap call then direct fetch). homes.com gates traffic through AWS WAF at the session level, so the in-session routing has to be per-call.

## Tool surface

| Tool | File | Endpoint | Kind |
| --- | --- | --- | --- |
| `homes_search_properties` | `tools/search.ts` | `GET /<city-slug>-<state>/` SSR — parse JSON-LD `CollectionPage.mainEntity.itemListElement[]` | read |
| `homes_get_property` | `tools/properties.ts` | `GET /property/<slug>/<propertyId>/` SSR — parse JSON-LD `RealEstateListing` node | read |
| `homes_get_property_photos` | `tools/photos.ts` | Same SSR page as `get_property` — scrape `<img>` tags filtered to the homes.com CDN | read |
| `homes_compare_properties` | `tools/compare.ts` | Concurrent `get_property` calls across N targets | read |
| `homes_calculate_mortgage` | `tools/mortgage.ts` | (local; no network) | read |
| `homes_calculate_affordability` | `tools/affordability.ts` | (local; no network) | read |
| `homes_healthcheck` | `tools/healthcheck.ts` | `/robots.txt` round-trip + bridge diagnostics | read |
| `homes_get_property_history` | `tools/history.ts` | Same SSR detail page — parse Property/Purchase/Mortgage History tables | read |
| `homes_get_tax_history` | `tools/history.ts` | Same SSR detail page — parse Tax History table | read |
| `homes_get_nearby_listings` | `tools/nearby.ts` | Same SSR detail page — scrape "Homes for Sale Near" link cards | read |
| `homes_get_market_report` | `tools/market.ts` | `GET /<city-slug>/sold/` — derive median/avg from JSON-LD itemListElement | read |
| `homes_get_saved_homes` | `tools/saved.ts` | `GET /customer/dashboard/favorites/` — auth-gated DOM scrape | read (auth) |
| `homes_get_saved_searches` | `tools/saved.ts` | `GET /customer/dashboard/saved-searches/` — auth-gated DOM scrape | read (auth) |
| `homes_estimate_rent_vs_buy` | `tools/rent-vs-buy.ts` | (local; no network) | read |

## Architecture

```
src/
  index.ts              # entry — builds FetchproxyTransport, HomesClient,
                        #   registers tool groups, connects stdio transport
  transport.ts          # HomesTransport interface
  transport-fetchproxy.ts # adapter over @fetchproxy/server's FetchproxyServer
  client.ts             # HomesClient.fetchHtml / fetchJson
                        #   + sign-in detection (WAF challenge / /sign-in redirect)
  page-state.ts         # extractJsonLd + findGraphNode helpers
  url.ts                # urlToPath + locationToSlug
  mcp.ts                # textResult() result-wrapper
  html.ts               # shared HTML scraping helpers built on
                        #   node-html-parser (findTableByHeading,
                        #   tableRows, findLinksUnderHeading,
                        #   normalizeDate/Dollar/Percent/IntegerLoose).
  tools/
    search.ts           # homes_search_properties (buildSearchPath +
                        #   path-based property_type/listing_type/sort)
    properties.ts       # homes_get_property (JSON-LD + DOM-side scrape:
                        #   description, highlights, schools, HOA, MLS, …)
    photos.ts           # homes_get_property_photos (<img> scrape, CDN-filtered)
    compare.ts          # homes_compare_properties (concurrent get_property)
    mortgage.ts         # homes_calculate_mortgage (local PITI)
    affordability.ts    # homes_calculate_affordability (local DTI math)
    healthcheck.ts      # homes_healthcheck (round-trips /robots.txt)
    history.ts          # homes_get_property_history + homes_get_tax_history
                        #   (scrape Property/Purchase/Mortgage/Tax tables)
    nearby.ts           # homes_get_nearby_listings (scrape "Homes for
                        #   Sale Near" link cards on detail page)
    market.ts           # homes_get_market_report (fetch /<slug>/sold/,
                        #   median + $/sqft from JSON-LD itemListElement)
    saved.ts            # homes_get_saved_homes + homes_get_saved_searches
                        #   (auth-gated /customer/dashboard/* scrape)
    rent-vs-buy.ts      # homes_estimate_rent_vs_buy (local; no network)

tests/                  # 1:1 mirror of src/, plus tests/helpers.ts harness.
                        #   All tests mock HomesClient.fetchHtml.
```

Each `tools/*.ts` file exports `registerXxxTools(server, client)` (or `(server)` for the local-only tools); `src/index.ts` calls all of them.

## Commands

```bash
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage  # v8 coverage, no thresholds
npx tsc --noEmit       # typecheck only
node dist/bundle.js    # launch the MCP server over stdio (also opens WS)
```

## Environment

No env vars required. Auth lives in the user's signed-in homes.com tab via the fetchproxy extension.

Optional:

```
HOMES_WS_PORT=37149   # override the fetchproxy WebSocket port
```

## Conventions

- All tools prefixed `homes_*`.
- Tool return shape: `textResult(data)` from `src/mcp.ts` → `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`. Don't hand-roll the wrapper.
- Tool annotations: every tool sets `title`, `readOnlyHint: true`, `idempotentHint: true`, and `openWorldHint`. The last is `true` for network-bound tools and `false` for `homes_calculate_mortgage` / `homes_calculate_affordability` (pure local computation).
- Path-only inputs to `HomesClient`: pass `/some/path?with=query`, never a full URL. `FetchproxyTransport` prepends `https://www.homes.com`. When a tool takes a `url` arg from the user, reduce it via `urlToPath` from `src/url.ts`.
- Write a failing test before implementation (TDD).
- ESM + NodeNext: imports use `.js` extensions even for `.ts` source.
- stdio transport: log warnings/banners to **stderr** only — stdout is reserved for JSON-RPC.

## homes.com quirks

- **No JSON API.** homes.com doesn't expose `/api/...` endpoints we can call directly from a signed-in browser. Every tool extracts state from the SSR HTML.
- **One JSON-LD blob per page.** Every page type (search results and property detail) embeds exactly one `<script type="application/ld+json">` with an `@graph` array. `src/page-state.ts` parses it with `extractJsonLd(html)` and walks the graph with `findGraphNode(doc, type)`.
- **Search vs. detail shape.** Search pages put the listings in `CollectionPage.mainEntity.itemListElement[]`; each item is tagged `[RealEstateListing, Product]` with a nested `mainEntity` carrying address/size. Search items LACK `geo` — lat/lng appears only on the property detail page. Detail pages emit a single `[RealEstateListing, Product]` graph node with `datePosted`, `dateModified`, `mainEntity.geo`, `mainEntity.yearBuilt`, and `offers.offeredBy[]` (the listing agent).
- **Property URL shape.** Detail URLs look like `https://www.homes.com/property/<address-slug>/<propertyId>/`, where `<propertyId>` is a base36-ish token (e.g. `rxrzwg0kjnr32`). We treat the last non-empty path segment as the stable identifier.
- **Photos are DOM-only.** The JSON-LD only carries one primary image (plus `primaryImageOfPage`). The real gallery lives in `<img>` tags on the detail page — `tools/photos.ts` scrapes those and filters to URLs containing `homes.com` (the CDN host).
- **Path-based search filters.** homes.com routes filter facets through URL paths, not query strings — `?bed_min=2` is dropped at the edge. Supported paths verified live 2026-05-26: `/<city>/houses-for-sale/`, `/condos-for-sale/`, `/townhouses-for-sale/`, `/land-for-sale/`, `/mobile-homes-for-sale/`, `/multi-family-for-sale/`, `/sold/`, `/homes-for-rent/`, `/<type>-for-rent/`, `/open-houses/`, `/newest/`, and `/new-homes/for-sale/<city>/`. `homes_search_properties` composes these via `property_type`, `listing_type`, `sort`.
- **History + tax data are in HTML tables, not JSON-LD.** Every property detail page server-renders four tables — Property History, Purchase History, Mortgage History, Tax History — whose row schemas are stable but lack semantic markup. `src/tools/history.ts` reads them via `findTableByHeading` from `src/html.ts` (built on `node-html-parser`). Date formats are mixed: Property History uses `MM/DD/YYYY`; Purchase + Mortgage use `MM/DD/YY` (50-year window). All dates are normalized to ISO 8601 in tool output.
- **Saved homes + saved searches are auth-only.** `/customer/dashboard/favorites/` and `/customer/dashboard/saved-searches/` work from a signed-in tab and return populated HTML; not signed in → `SessionNotAuthenticatedError` (already handled by `throwIfSignInPage`).
- **Sign-in detection.** `src/client.ts::throwIfSignInPage` flags `/sign-in` URL redirects and the AWS WAF challenge interstitial (body matches both `awswaf.com` AND `challenge.js` AND body < 80 KB). CoStar (homes.com's parent) sits behind AWS WAF.

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Version appears in SEVEN places — all must match. `release-please-config.json` registers them as `extra-files` and bumps them in one PR per release:

1. `package.json` → `"version"`
2. `package-lock.json` → kept in sync by `npm install --package-lock-only`
3. `src/index.ts` → `VERSION` const (annotated with `// x-release-please-version`) + startup banner
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version`
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → `metadata.version` + `plugins[].version`

### Release flow

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`) opens or updates a release PR whenever Conventional-Commit messages (`feat:`, `fix:`, etc.) accumulate. Merging the release PR creates the tag and a GitHub Release; the `publish` job then packs `.mcpb` + `.skill`, publishes to npm with provenance, and pushes to the MCP Registry.

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. release-please owns versioning.

## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* the auto-generated release notes block (configured in `.github/release.yml`).

For every PR, apply exactly one label:

| Label                  | Section in release notes |
|------------------------|--------------------------|
| `enhancement`          | Features                 |
| `bug`                  | Bug Fixes                |
| `security`             | Security                 |
| `refactor`             | Refactor                 |
| `documentation`        | Documentation            |
| `test`                 | Tests                    |
| `dependencies`         | Dependencies             |
| `ci` / `github_actions`| CI & Build               |
| *(none / unmatched)*   | Other Changes            |
| `ignore-for-release`   | Hidden from notes        |

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). On a `pass` verdict it adds the `ready-to-merge` label.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `warn`/`fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## What to not do

- Don't add IP-rotation or TLS-impersonation libraries. The whole design is "every request rides the user's own browser session via fetchproxy." Adding cycletls / curl-impersonate / Playwright would replace that with a separate stand-in identity — which both defeats the design and adds engineering surface.
- Don't paste cookies or env-configure auth. Auth lives in the browser.
- Don't register tools that can't be tested against a mock `HomesClient`. All tool logic should be behind `fetchHtml` so tests can drive it without a real WS.
- Don't bump versions speculatively. release-please owns that.
