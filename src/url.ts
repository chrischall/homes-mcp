/**
 * Small URL helpers shared across tools.
 *
 * Homes's pages are served from a fixed `https://www.homes.com`
 * origin, and the FetchproxyTransport prepends that for us — tools
 * work in terms of paths, not URLs. When a tool accepts a `url` arg
 * from the user, we need to reduce it down to a path before handing
 * it off.
 *
 * Both helpers are canonical cohort helpers hoisted into
 * `@chrischall/realty-core` (realty-mcp#1): `urlToPath` was
 * byte-identical across zillow/redfin/compass/homes, and
 * `locationToSlug` byte-identical between compass and homes. We
 * re-export them here so the existing `../url.js` import sites stay
 * unchanged.
 */
import { locationToSlug } from '@chrischall/realty-core';

export { urlToPath, locationToSlug } from '@chrischall/realty-core';

/**
 * `locationToSlug` that refuses an empty result (fleet-audit#497).
 * A location that is blank or written only in non-Latin script /
 * punctuation slugs to `''`, which would build `//` (the homes.com
 * homepage) and come back as a silent zero-result search or market.
 */
export function requireLocationSlug(location: string): string {
  const slug = locationToSlug(location);
  if (!slug) {
    throw new Error(
      `homes.com: could not turn location ${JSON.stringify(location)} into a homes.com location slug — pass a city + state ("Atlanta, GA"), a ZIP, or a neighborhood name in Latin script.`,
    );
  }
  return slug;
}
