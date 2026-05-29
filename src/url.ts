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
export { urlToPath, locationToSlug } from '@chrischall/realty-core';
