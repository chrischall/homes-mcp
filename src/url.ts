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
import { locationToSlug, urlToPath } from '@chrischall/realty-core';

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


/**
 * `/property/<slug>/<id>/` (trailing slash and query string optional).
 * Each segment must start alphanumeric and contain only URL-safe slug
 * characters, so `.` / `..` / percent-encoded dot segments can't walk
 * out of `/property/`.
 */
const PROPERTY_DETAIL_PATH_RE =
  /^\/property\/[A-Za-z0-9][A-Za-z0-9_.~-]*\/[A-Za-z0-9][A-Za-z0-9_.~-]*\/?(?:\?.*)?$/;

/**
 * Reduce a user-supplied homes.com property URL to its path, refusing
 * anything that isn't a property detail page (fleet-audit#501).
 *
 * The property-detail tools are read-only and run in the user's signed-in
 * session, so an unconstrained path would let them GET account pages
 * (`/customer/...`) or any state-changing GET endpoint — and a
 * prompt-injected listing description could steer a call there. It also
 * turns a mis-pasted search/agent URL into a clear error instead of a
 * confusing "No RealEstateListing node".
 */
export function propertyPath(url: string): string {
  const path = urlToPath(url);
  if (!PROPERTY_DETAIL_PATH_RE.test(path)) {
    throw new Error(
      `${JSON.stringify(url)} is not a homes.com property detail URL — expected https://www.homes.com/property/<slug>/<id>/ (e.g. a homes_search_properties result's \`url\`).`,
    );
  }
  return path;
}
