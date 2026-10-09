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
 * Verified live 2026-05-26:
 *   - https://www.homes.com/atlanta-ga/
 *   - https://www.homes.com/property/3199-delmar-ln-nw-atlanta-ga/rxrzwg0kjnr32/
 *
 * **HTML-entity gotcha.** homes.com emits the script type attribute
 * with the `+` encoded as `&#x2B;`:
 *   `<script type="application/ld&#x2B;json">…</script>`
 * The browser decodes that at parse time, so DOM queries with
 * `script[type="application/ld+json"]` still match. A raw-text regex
 * looking for the literal string `application/ld+json` does NOT.
 *
 * We use `node-html-parser` here so attribute values are entity-decoded
 * before matching — that's the load-bearing reason for the dep choice.
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

import { parseHtml } from './html.js';

/**
 * Find and parse every `<script type="application/ld+json">` block in
 * `html` and merge their nodes into one `{ @context, @graph }` document.
 * Returns null when no block exists, none parses, or none carries a node.
 *
 * Uses `node-html-parser` so attribute values are HTML-entity-decoded
 * before matching — homes.com emits `application/ld&#x2B;json` in the
 * raw SSR, and a literal-text regex would miss it.
 *
 * Every block contributes (fleet-audit#496): a `WebSite` / `Organization`
 * block ahead of the listing graph must not hide the `RealEstateListing`
 * or `CollectionPage` node. Each block may be a `{ @context, @graph }`
 * envelope, a single root node (no `@graph` — kept as one node), or a
 * top-level array of either; all are flattened into one graph so
 * `findGraphNode` sees every node. `@context` comes from the first block
 * that declares one.
 */
export function extractJsonLd(html: string): JsonLdDoc | null {
  const root = parseHtml(html);
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  const graph: JsonLdNode[] = [];
  let context: JsonLdDoc['@context'];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) collect(v);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const doc = value as JsonLdDoc;
    if (context === undefined && doc['@context'] !== undefined) {
      context = doc['@context'];
    }
    if (Array.isArray(doc['@graph'])) {
      for (const node of doc['@graph']) {
        if (node && typeof node === 'object') graph.push(node);
      }
    } else if (doc['@type']) {
      graph.push(doc as JsonLdNode);
    }
  };
  for (const script of scripts) {
    const raw = script.textContent.trim();
    if (!raw) continue;
    try {
      collect(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  if (graph.length === 0) return null;
  return { '@context': context, '@graph': graph };
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
