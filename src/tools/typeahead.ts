/**
 * homes.com's structured address typeahead — the `smartsearch`
 * autocomplete API behind the site's search box.
 *
 * Issue #55 / structured-search directive #79. The legacy resolver
 * guessed slug URLs like `/<addr-slug>-<city>-<state>-<zip>/` (and a
 * city/zip search-page fallback). For many real, indexed listings
 * homes.com routes the slug to a 404, so the resolver reported a false
 * "no listing found" for properties the live site resolves fine
 * (e.g. Lake Lure NC — 158 Raven Blvd, 155 Quail Cove Blvd Unit 1601).
 *
 * The live search box resolves addresses through this structured
 * endpoint instead. Captured live 2026-05-28 (XHR interception) against
 * a signed-in session:
 *
 *   POST /routes/res/consumer/smartsearch/autocomplete/
 *   Content-Type: application/json
 *   { "term": "158 raven blvd lake lure",
 *     "fullTerm": "158 Raven Blvd Lake Lure",
 *     "transactionType": 1,
 *     "location": { "ln": -80.846, "lt": 35.229 },
 *     "searchTermStartIndex": null }
 *
 *   → 200 application/json
 *   { "suggestions": {
 *       "places": [
 *         { "n": "158 Raven Blvd, Lake Lure, NC",
 *           "u": "/property/158-raven-blvd-lake-lure-nc/yhepckbpqstf1/",
 *           "g": { "k": { "key": "yhepckbpqstf1" },
 *                  "d": "158 Raven Blvd, Lake Lure, NC", "t": 8,
 *                  "a": { "state":"NC","city":"Lake Lure",
 *                         "postalCode":"28746","street":"158 Raven Blvd",
 *                         "other":"ForSale" },
 *                  "l": { "lt": 35.4286, "ln": -82.17019 } },
 *           "s": "Address", "sts": 0 }
 *       ],
 *       "neighborhoods": [], "schools": [], "buildings": [],
 *       "agents": [], "newhomes": [] } }
 *
 * Field facts established by live probing (2026-05-28):
 *
 *   - `term` is the load-bearing request field — `{ fullTerm }` alone
 *     returns 400; `{ term }` alone returns 200 with the right hit. We
 *     send both (mirroring the live box) plus `transactionType: 1`.
 *   - The XSRF-TOKEN / AT headers the live box adds are NOT required;
 *     a plain `Content-Type: application/json` POST returns 200. That's
 *     load-bearing — the fetchproxy bridge forwards cookies but not
 *     those custom headers.
 *   - `place.u` is the REAL detail-page path (`/property/<slug>/<hash>/`),
 *     and `place.g.k.key` is that same opaque property hash. A
 *     nonexistent address returns `places: []` (clean fall-through).
 *   - Multi-unit buildings return one place per unit; the unit lives in
 *     both `n` ("… Unit 1601, …") and `g.a.unit` ("1601"). The whole-
 *     token verifier in by-address.ts disambiguates to the right unit.
 */

import type { ByAddressInput } from './by-address.js';
import { lastPathSegment } from '../jsonld.js';

/** The structured address-suggest endpoint (POST, JSON). */
export const SMARTSEARCH_AUTOCOMPLETE_PATH =
  '/routes/res/consumer/smartsearch/autocomplete/';

/**
 * homes.com `transactionType` for sale listings. The live search box
 * sends `1`; it's not required for a 200 but mirrors the real request.
 */
const TRANSACTION_TYPE_FOR_SALE = 1;

/** A single place suggestion from the smartsearch response. */
export interface SmartsearchPlace {
  /** Display name, e.g. "158 Raven Blvd, Lake Lure, NC" (includes unit). */
  n?: string;
  /** Relative detail-page path: `/property/<slug>/<hash>/`. */
  u?: string;
  g?: {
    /** `k.key` is the opaque property hash (matches the `<hash>` URL segment). */
    k?: { key?: string };
    /** Address description, mirrors `n`. */
    d?: string;
    /** Result type code (8 = address/property). */
    t?: number;
    a?: {
      countryCode?: string;
      state?: string;
      city?: string;
      postalCode?: string;
      street?: string;
      /** Present for multi-unit buildings, e.g. "1601". */
      unit?: string;
      other?: string;
    };
    l?: { lt?: number; ln?: number };
  };
  /** Source category label, e.g. "Address". */
  s?: string;
  sts?: number;
}

interface SmartsearchSuggestions {
  places?: SmartsearchPlace[];
  neighborhoods?: unknown[];
  schools?: unknown[];
  buildings?: unknown[];
  agents?: unknown[];
  newhomes?: unknown[];
}

export interface SmartsearchResponse {
  suggestions?: SmartsearchSuggestions;
  [k: string]: unknown;
}

/** Request body for the autocomplete POST. */
export interface AutocompleteBody {
  /** The lowercased joined address — the field the endpoint requires. */
  term: string;
  /** The raw-case joined address (mirrors the live request). */
  fullTerm: string;
  transactionType: number;
  searchTermStartIndex: null;
}

/**
 * A normalized place candidate — the shape the by-address verifier
 * consumes. Carries the real detail URL + hash so a verified candidate
 * resolves straight to `/property/<slug>/<hash>/`.
 */
export interface SmartsearchCandidate {
  /** Real detail-page path: `/property/<slug>/<hash>/`. */
  url: string;
  /** Opaque property hash (from `g.k.key`, falling back to the URL tail). */
  property_hash: string;
  /** Street line, e.g. "158 Raven Blvd". */
  street?: string;
  /** Unit token for multi-unit buildings, e.g. "1601". */
  unit?: string;
  /** Full display name (street + unit + locality) used for verification. */
  display: string;
}

/**
 * Join an address record into the single free-text string the search
 * box types. `{ "158 Raven Blvd", "Lake Lure", "NC", "28746" }` →
 * `"158 Raven Blvd Lake Lure NC 28746"`.
 */
function joinAddress(input: ByAddressInput): string {
  return [input.address, input.city, input.state, input.zip ?? '']
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/**
 * Build the autocomplete request body. `term` (lowercased) is the
 * load-bearing field; `fullTerm` carries the original casing the live
 * box sends. `transactionType: 1` and `searchTermStartIndex: null`
 * mirror the captured request.
 */
export function buildAutocompleteBody(input: ByAddressInput): AutocompleteBody {
  const full = joinAddress(input);
  return {
    term: full.toLowerCase(),
    fullTerm: full,
    transactionType: TRANSACTION_TYPE_FOR_SALE,
    searchTermStartIndex: null,
  };
}

/**
 * Normalize a smartsearch response into the candidate list the
 * by-address verifier checks. Keeps only places carrying both a usable
 * property hash and a detail URL — anything else can't be turned into a
 * canonical property URL.
 */
export function extractAddressCandidates(
  resp: SmartsearchResponse | null | undefined
): SmartsearchCandidate[] {
  const places = resp?.suggestions?.places ?? [];
  const out: SmartsearchCandidate[] = [];
  for (const place of places) {
    const url = place.u;
    if (!url) continue;
    // Last non-empty path segment of a `/property/<slug>/<hash>/` URL.
    const hash = place.g?.k?.key ?? lastPathSegment(url);
    if (!hash) continue;
    out.push({
      url,
      property_hash: hash,
      street: place.g?.a?.street,
      unit: place.g?.a?.unit,
      display: place.n ?? place.g?.d ?? '',
    });
  }
  return out;
}
