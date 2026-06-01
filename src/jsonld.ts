/**
 * Shared Schema.org JSON-LD coercion helpers used by the search-results
 * and property-detail extractors. These were byte-identical copies in
 * `tools/search.ts` and `tools/properties.ts`; hoisting them here
 * collapses the duplication. Pure / dependency-free.
 *
 * The agent helpers are generic over the agent shape so each caller can
 * pass its own richer `JsonLdAgent` type (the detail-page agent carries
 * `email`/`url`/`address` the search-page one doesn't) — only the
 * `memberOf` field is structurally required here.
 */

import { lastPathSegment as fpLastPathSegment } from '@chrischall/mcp-utils/fetchproxy';

/** An agent record with the only field the brokerage helper reads. */
export interface AgentWithMemberOf {
  memberOf?: { name?: string } | { name?: string }[];
}

/** Coerce a number-or-string into a finite number, or undefined. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    // Strip any non-numeric punctuation (commas, $, etc.) before parsing.
    const cleaned = v.replace(/[^0-9.-]/g, '');
    if (cleaned === '') return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Pull the first image URL out of a string-or-string-array field. */
export function firstImage(
  image: string | string[] | undefined
): string | undefined {
  if (!image) return undefined;
  if (typeof image === 'string') return image;
  return image[0];
}

/** Extract an agent record from an offeredBy field (object or array). */
export function firstAgent<A>(
  offeredBy: A | A[] | undefined
): A | undefined {
  if (!offeredBy) return undefined;
  if (Array.isArray(offeredBy)) return offeredBy[0];
  return offeredBy;
}

/** Extract the brokerage name from an agent's `memberOf` (object or array). */
export function brokerageFrom(
  agent: AgentWithMemberOf | undefined
): string | undefined {
  if (!agent?.memberOf) return undefined;
  if (Array.isArray(agent.memberOf)) return agent.memberOf[0]?.name;
  return agent.memberOf.name;
}

/**
 * Reduce a portal URL or `@id` to its last non-empty path segment — the
 * stable property-id token in homes.com's `/property/<slug>/<hash>/`
 * URLs. Strips the origin, then any `?query`/`#fragment` (homes.com's
 * `@id` carries a `#realestatelisting` fragment), then splits on `/`.
 * Returns `''` for empty / segment-less / `undefined` input.
 *
 * Thin wrapper over `@chrischall/mcp-utils/fetchproxy`'s `lastPathSegment` to preserve
 * the undefined-tolerant call sites across search.ts / properties.ts /
 * history.ts / typeahead.ts / photos.ts (fetchproxy's signature is
 * non-nullable).
 */
export function lastPathSegment(url: string | undefined): string {
  return url ? fpLastPathSegment(url) : '';
}
