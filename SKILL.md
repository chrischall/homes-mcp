---
name: homes-mcp
description: Look up real-estate listings, property details, and photo galleries on homes.com via MCP. Triggers on phrases like "find homes on homes.com in", "homes.com property details for", "what does homes.com say about", or any request involving homes.com properties, prices, or photos. Requires homes-mcp installed and the fetchproxy extension active (see Setup below).
---

# homes-mcp

MCP server for homes.com — natural-language access to listings, property records, and photo galleries. Routes through your signed-in homes.com tab via the fetchproxy browser extension, so AWS WAF sees a real browser session instead of a Node process.

- **npm:** [npmjs.com/package/homes-mcp](https://www.npmjs.com/package/homes-mcp)
- **Source:** [github.com/chrischall/homes-mcp](https://github.com/chrischall/homes-mcp)

> ⚠️ homes.com does not publish a public consumer API. This server reads the Schema.org JSON-LD blob embedded in each SSR page, dispatched through your own signed-in browser tab via the fetchproxy extension. Use at your own discretion.

## Setup

### 1. Install homes-mcp

`.mcp.json` (project) or `~/.claude/mcp.json` (global):

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

### 2. Install the fetchproxy extension (one-time, shared across all fetchproxy-based MCPs)

```bash
git clone https://github.com/chrischall/fetchproxy
cd fetchproxy
npm ci
npm --workspace=@fetchproxy/extension-chrome run build
```

Then in Chrome: `chrome://extensions` → Developer mode → Load unpacked → pick `packages/extension-chrome/dist/`.

### 3. Open homes.com and sign in.

That's it. No API keys, no env vars. (Sign-in isn't strictly required for the public-listing tools, but having a real session active helps the page render the way the extractors expect.)

## Tools

- **`homes_search_properties`** — Search by free-text location (city, ZIP, neighborhood). Slugifies the input into homes.com's URL routing (e.g. "Atlanta, GA" → `/atlanta-ga/`, "30311" → `/30311/`). Returns each listing's address, price, beds/baths, sqft, primary photo, listing agent + brokerage. v0.1 does not encode price/bed filters into the URL — search by location and re-rank client-side.
- **`homes_get_property`** — Full record for a property by URL (the `url` field from a search result). Parses the JSON-LD `RealEstateListing` node — returns address, lat/lng, beds/baths, sqft, year built, price + currency, status, listing agent + brokerage, photos URL, date posted/modified.
- **`homes_get_property_photos`** — Full photo gallery, scraped from `<img>` tags on the detail page (the JSON-LD only carries one image). Returns `{ url, position, alt? }` per photo, filtered to the homes.com CDN.
- **`homes_compare_properties`** — Side-by-side comparison of 2–8 properties with an aligned summary table. Per-target errors captured per-row. Concurrent fetches.
- **`homes_calculate_mortgage`** — Local PITI calculator. No network. Provide home price, interest rate, optional down payment / taxes / insurance / HOA / PMI; returns a full monthly breakdown.
- **`homes_calculate_affordability`** — Local affordability calculator. Solves for max purchase price under standard 28/36 DTI rule.
- **`homes_healthcheck`** — Verifies the fetchproxy bridge end-to-end. Round-trips `/robots.txt` and returns a plain-English hint distinguishing "bridge down" from "extension not connected" from "homes.com-side problem."

## Trigger examples

- "Find me homes for sale in Atlanta on homes.com" → `homes_search_properties`
- "What does homes.com say about 3199 Delmar Ln NW Atlanta?" → `homes_get_property` (caller pastes the URL from a search result)
- "Show me all photos for this homes.com listing" → `homes_get_property_photos`
- "Compare these three homes.com listings side-by-side" → `homes_compare_properties`
- "Monthly payment on a $500k home, 20% down, 6.5% rate" → `homes_calculate_mortgage`
- "How much house can I afford on $9k/month income?" → `homes_calculate_affordability`

## Gotchas

- **No price-history, saved-listings, or market-report tools yet.** homes.com doesn't surface those in a stable, scrapeable form. v0.1 ships without them.
- **AWS WAF challenge.** homes.com (CoStar) gates traffic through AWS WAF and occasionally serves a challenge page to fresh sessions. Solving it in the Chrome tab once unblocks subsequent fetches; the client detects the interstitial and throws `SessionNotAuthenticatedError`.
- **No write surface.** All tools are read-only. Saving a home / contact form are not implemented.
- **Search is location-only in v0.1.** The URL-path filter shape on homes.com changes too frequently to encode reliably. Pass the location, then re-rank the results client-side.
- **Property URL is required for detail tools.** `get_property`, `get_property_photos`, and `compare_properties` all require a full property URL from a search result — there is no stable way to construct one from a property id alone.
