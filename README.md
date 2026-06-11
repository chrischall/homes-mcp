# homes-mcp

[![CI](https://github.com/chrischall/homes-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/homes-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/homes-mcp)](https://www.npmjs.com/package/homes-mcp)
[![license](https://img.shields.io/npm/l/homes-mcp)](LICENSE)

homes.com real-estate access as an MCP server for Claude — search listings, resolve addresses, fetch property details, price/tax history, market reports, saved homes, photo galleries, and run affordability/mortgage math, all via natural language.

> ⚠️ homes.com does not publish a public consumer API. This server reads the same server-rendered HTML and Schema.org JSON-LD that homes.com itself ships to your browser, routed through your own signed-in browser tab via the [fetchproxy](https://github.com/chrischall/fetchproxy) extension. Every request acts on behalf of your existing session — your cookies, your TLS, your JS context — exactly as if you'd clicked it in the browser yourself. Treat this as informal use of homes.com. Use at your own discretion.

## Tools

| Tool | Purpose |
| --- | --- |
| `homes_search_properties` | Search listings by free-text location (city/ZIP/neighborhood). Slugifies the input into homes.com's URL routing and parses the JSON-LD `CollectionPage.mainEntity.itemListElement[]`. Filters by `property_type`, `listing_type`, `sort`, and a `price_min`/`price_max` band. Returns address, price, beds/baths, sqft, primary photo, listing agent + brokerage; flags `truncated`/`total_estimated` past the ~40-listing SSR cap. |
| `homes_get_by_address` | Resolve one US street address to its canonical homes.com property URL + opaque hash. Walks structured typeahead → slug → city/zip search-fallback with whole-token street + unit verification. Returns `matched_via`; degrades to `{ resolved: false }`. |
| `homes_resolve_addresses` | Bulk `homes_get_by_address` (up to 100 addresses, input order preserved, per-row outcomes). Prefer for batches ≥ 3. |
| `homes_get_property` | Full record for a property by URL. Parses JSON-LD + DOM-side sections: address, lat/lng, beds/baths, sqft, year built, price, status, agent + brokerage, highlights, schools, HOA (raw + monthly), lot size (sqft + acres), parking, heating/cooling, MLS id/source, tax, days-on-market, price drops, `extracted_features`. Optional inline `price_history`/`tax_history`. |
| `homes_get_property_photos` | Full photo gallery scraped from `<img>` tags on the detail page (JSON-LD only carries one image). Returns `{ url, position, alt? }` per photo, filtered to the homes.com CDN. |
| `homes_bulk_get` | Fetch up to 200 properties' structured records in one call (per-row errors, input order preserved). |
| `homes_compare_properties` | Side-by-side comparison of 2–8 properties with an aligned summary table. Per-target errors captured per-row. Concurrent fetches. |
| `homes_get_nearby_listings` | The "Homes for Sale Near This Property" cross-link cards from a detail page (For Sale, optionally Rentals). URL + address only. |
| `homes_get_history` | Combined price + tax history in one fetch: `listing_events`, `ownership_events`, `lien_events`, normalized `events_normalized`, and `tax_records`. |
| `homes_get_property_history` | *Deprecated* — price/ownership/lien timelines only. Prefer `homes_get_history`. |
| `homes_get_tax_history` | *Deprecated* — year-by-year tax records only. Prefer `homes_get_history`. |
| `homes_get_market_report` | Median / average / $-per-sqft for a market, derived from the `sold` search page's JSON-LD. |
| `homes_get_saved_homes` | The signed-in user's saved (favorited) homes. Auth-gated. |
| `homes_get_saved_searches` | The signed-in user's saved searches. Auth-gated. |
| `homes_calculate_affordability` | Local affordability calculator — max purchase price from income + DTI + rates. No network. |
| `homes_calculate_mortgage` | Local PITI calculator — principal+interest, taxes, insurance, HOA, PMI. No network. |
| `homes_estimate_rent_vs_buy` | Local rent-vs-buy model — you supply `monthly_rent` (homes.com has no rental signal to impute it; see below). No network. |
| `homes_healthcheck` | Round-trips `/robots.txt` through the fetchproxy bridge and returns diagnostics + a plain-English hint distinguishing "bridge down" from "extension not connected" from "homes.com-side problem." |
| `homes_get_session_context` / `homes_register_session` / `homes_set_active_session` | List / register / switch logical homes.com sessions. |

### Known data gap: rental estimates

homes.com does NOT publish rental estimates anywhere on its consumer site — there's no `rent_zestimate` analogue, no "estimated rent" widget on property detail pages, and no comparable-rentals endpoint. The `homes_estimate_rent_vs_buy` tool exists for the math, but it requires the caller to pass `monthly_rent` directly (you can't fetch a rent estimate from homes.com to plug in).

For rental signals, use a sibling MCP: **`zillow_get_property`** carries `rent_zestimate` on detail records, and **`redfin_get_comparable_rentals`** returns rental comps by URL. See [issue #28](https://github.com/chrischall/homes-mcp/issues/28) for the feasibility investigation.

## Acknowledgement of Terms

By using this MCP server, you acknowledge and agree to the following:

**1. This server accesses your own homes.com session.** Every request is dispatched through your own browser tab via the fetchproxy extension — your cookies, your TLS, your session. It does not — and cannot — access anyone else's account.

**2. [homes.com's Terms of Use](https://www.homes.com/about/terms-of-use) govern your use of this server**, just as they govern your direct use of homes.com. The terms prohibit automated crawling without written permission, and IDX listing data is licensed for personal, non-commercial use only. You are agreeing to those terms every time you invoke a tool in this server.

**3. Personal, non-commercial use only.** This project is not affiliated with, endorsed by, sponsored by, or in partnership with homes.com or CoStar Group. It is a personal automation tool that reads the same server-rendered HTML and Schema.org JSON-LD homes.com ships to your browser. Do not use it to bulk-extract listings, redistribute IDX data, train AI models, populate a competing real-estate product, or for any commercial purpose.

**4. Stability is not guaranteed.** This server reads Schema.org JSON-LD (`<script type="application/ld+json">`) and DOM-side `<img>` tags from SSR pages whose URL conventions (`/<city>-<state>/`, `/property/<slug>/<id>/`) may change without notice. It may break. It may stop working. That's by design — the surface is not theirs to maintain on our behalf.

**5. You accept full responsibility** for any consequences of using this server in connection with your homes.com access — rate limiting, account suspension, IP blocks, AWS WAF challenges, or any enforcement action homes.com takes. If homes.com objects to your use, stop using this server.

This section is the maintainer's good-faith summary of the terms — it is not legal advice and does not modify or supersede homes.com's actual ToU.

## Install

### Option A — npx (after first publish)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "homes": {
      "command": "npx",
      "args": ["-y", "homes-mcp"]
    }
  }
}
```

### Option B — from source

```bash
git clone https://github.com/chrischall/homes-mcp
cd homes-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "homes": {
      "command": "node",
      "args": ["/path/to/homes-mcp/dist/bundle.js"]
    }
  }
}
```

### One-time browser setup

homes-mcp talks to your browser through the [fetchproxy](https://github.com/chrischall/fetchproxy) extension, which is shared across every fetchproxy-based MCP (zillow-mcp, opentable-mcp, resy-mcp, …). It lives in its own repo and is installed separately — it is **not** bundled here. Follow the install instructions at [github.com/chrischall/fetchproxy](https://github.com/chrischall/fetchproxy), then load the built extension in Chrome via `chrome://extensions` → toggle Developer mode → Load unpacked.

Open homes.com and sign in. That's all the auth this server needs.

## How it works

```
┌────────────────┐  stdio   ┌──────────────────┐   WS   ┌──────────────────┐    fetch()    ┌─────────────┐
│ MCP client     │◀────────▶│  dist/bundle.js  │◀──────▶│  fetchproxy      │◀────────────▶│ homes.com  │
│ (Claude, etc.) │          │  (Homes MCP)    │ :37149 │  extension       │   (real TLS, │ (your tab)  │
└────────────────┘          └──────────────────┘        │  (separate)      │   cookies)    └─────────────┘
```

The MCP server runs in Node, but every HTTP call to homes.com is dispatched into your live browser tab through the fetchproxy extension. Each request rides your existing session — TLS fingerprint, cookies, and JS execution context all match the page that's already on screen. No headless browser stand-in, no separate identity, no third-party proxy: just your real browser, acting on its own behalf, with the MCP server picking what to ask for.

homes.com's pages are SSR React with no public JSON API — every tool extracts data from the Schema.org JSON-LD block embedded in each page (`<script type="application/ld+json">`). Search pages put listings in `CollectionPage.mainEntity.itemListElement[]`; detail pages emit a `RealEstateListing` graph node with `mainEntity` (address, size, geo) and `offers.offeredBy[]` (listing agent). Photos are scraped from the DOM since the JSON-LD only carries one primary image. The client wraps that into the tool surface so callers never have to parse HTML themselves.

## Commands

```bash
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm run dev            # node dist/bundle.js (after build)
```

## License

MIT
