/**
 * Extract Schema.org JSON-LD structured data from a rendered homes.com
 * HTML page.
 *
 * homes.com is a SSR-React app with no `__NEXT_DATA__` blob and no
 * stingray-style JSON API. The reliable signal across every page type
 * (search results, property detail) is a single
 * `<script type="application/ld+json">` block that the site emits for
 * SEO. This block contains a well-formed JSON document with an
 * `@context` and `@graph` array.
 *
 * On a **search page** (e.g. `https://www.homes.com/atlanta-ga/`) the
 * graph contains a `CollectionPage` whose `mainEntity.itemListElement`
 * is the listings array, alongside a `BreadcrumbList`.
 *
 * On a **property detail page** (e.g.
 * `https://www.homes.com/property/<slug>/<id>/`) the graph contains a
 * `[RealEstateListing, Product]` node and a `BreadcrumbList`.
 *
 * Because the JSON-LD block is plain JSON (not a JS literal), a single
 * regex + `JSON.parse` is enough — no balanced-brace state machine
 * needed.
 *
 * Verified live 2026-05-24 against:
 *   - https://www.homes.com/atlanta-ga/
 *   - https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/
 */

/** A JSON-LD document as emitted by homes.com. Top-level shape: `{ "@context", "@graph" }`. */
export interface JsonLdDoc {
  '@context'?: string | string[];
  '@graph'?: JsonLdNode[];
  // Some pages emit a single root node instead of a graph wrapper. We
  // normalise this into a one-element graph in extractJsonLd.
  '@type'?: string | string[];
  [key: string]: unknown;
}

/** A node inside the `@graph` array. `@type` may be a single string or an array. */
export interface JsonLdNode {
  '@type'?: string | string[];
  '@id'?: string;
  [key: string]: unknown;
}

/**
 * Find and parse the first `<script type="application/ld+json">` block
 * in `html`. Returns the parsed JSON-LD document, or null when no such
 * block exists or it fails to parse.
 *
 * If a page emits the JSON-LD as a single root node (rather than the
 * `{ @context, @graph }` envelope), we wrap it into a synthetic graph
 * with that node as the sole element. This keeps `findGraphNode` happy
 * across both shapes.
 */
export function extractJsonLd(html: string): JsonLdDoc | null {
  // Tolerate any attribute order/whitespace around `type="application/ld+json"`.
  // The `[\s\S]*?` body is lazy so we stop at the first `</script>`.
  const re =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;
  const match = re.exec(html);
  if (!match) return null;
  const raw = match[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const doc = parsed as JsonLdDoc;
  // Normalise: if the doc has no `@graph` but does declare its own
  // `@type`, treat the whole doc as a single graph node.
  if (!doc['@graph'] && doc['@type']) {
    return { '@context': doc['@context'], '@graph': [doc as JsonLdNode] };
  }
  return doc;
}

/**
 * Check whether a node's `@type` (string or array) includes `type`.
 * homes.com tags property listings as `["RealEstateListing", "Product"]`,
 * so callers should match on whichever type name they care about.
 */
export function nodeHasType(node: JsonLdNode, type: string): boolean {
  const t = node['@type'];
  if (typeof t === 'string') return t === type;
  if (Array.isArray(t)) return t.includes(type);
  return false;
}

/**
 * Find the first node in `doc['@graph']` whose `@type` includes `type`.
 * Returns null when the document has no graph or no matching node.
 */
export function findGraphNode(
  doc: JsonLdDoc | null,
  type: string
): JsonLdNode | null {
  if (!doc) return null;
  const graph = doc['@graph'] ?? [];
  for (const node of graph) {
    if (nodeHasType(node, type)) return node;
  }
  return null;
}
