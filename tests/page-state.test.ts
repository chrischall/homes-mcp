import { describe, it, expect } from 'vitest';
import {
  extractJsonLd,
  findGraphNode,
  nodeHasType,
} from '../src/page-state.js';

describe('extractJsonLd', () => {
  it('parses a single application/ld+json script block', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"CollectionPage"}]}</script>
    </head></html>`;
    const doc = extractJsonLd(html);
    expect(doc?.['@context']).toBe('https://schema.org');
    expect(doc?.['@graph']).toHaveLength(1);
  });

  it('returns null when no JSON-LD script is present', () => {
    const html = '<html><head><script>var x = 1;</script></head></html>';
    expect(extractJsonLd(html)).toBeNull();
  });

  it('returns null when the JSON-LD body is malformed', () => {
    const html =
      '<html><script type="application/ld+json">{not valid json}</script></html>';
    expect(extractJsonLd(html)).toBeNull();
  });

  it('tolerates whitespace and attribute reordering around the script tag', () => {
    const html = `<script  data-rh="true"  type='application/ld+json'>
      {"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"}]}
    </script>`;
    const doc = extractJsonLd(html);
    expect(doc?.['@graph']?.[0]?.['@type']).toBe('BreadcrumbList');
  });

  it('wraps a graph-less single-node doc into a synthetic one-element graph', () => {
    // homes.com today always emits a `@graph` envelope, but the spec
    // allows a single root node. We normalise so findGraphNode works
    // either way.
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"RealEstateListing","name":"X"}
    </script>`;
    const doc = extractJsonLd(html);
    expect(doc?.['@graph']).toHaveLength(1);
    expect(doc?.['@graph']?.[0]?.['@type']).toBe('RealEstateListing');
  });
});

describe('nodeHasType', () => {
  it('matches a string @type', () => {
    expect(nodeHasType({ '@type': 'CollectionPage' }, 'CollectionPage')).toBe(true);
    expect(nodeHasType({ '@type': 'BreadcrumbList' }, 'CollectionPage')).toBe(false);
  });

  it('matches when @type is an array containing the type', () => {
    expect(
      nodeHasType({ '@type': ['RealEstateListing', 'Product'] }, 'RealEstateListing')
    ).toBe(true);
    expect(
      nodeHasType({ '@type': ['RealEstateListing', 'Product'] }, 'Product')
    ).toBe(true);
    expect(
      nodeHasType({ '@type': ['RealEstateListing', 'Product'] }, 'CollectionPage')
    ).toBe(false);
  });

  it('returns false when @type is missing', () => {
    expect(nodeHasType({}, 'Anything')).toBe(false);
  });
});

describe('findGraphNode', () => {
  it('finds a node by its @type in the @graph array', () => {
    const doc = {
      '@graph': [
        { '@type': 'BreadcrumbList', name: 'crumbs' },
        { '@type': 'CollectionPage', name: 'page' },
      ],
    };
    expect(findGraphNode(doc, 'CollectionPage')?.name).toBe('page');
  });

  it('finds a node whose @type array contains the requested type', () => {
    const doc = {
      '@graph': [
        { '@type': 'BreadcrumbList' },
        { '@type': ['RealEstateListing', 'Product'], name: 'listing' },
      ],
    };
    expect(findGraphNode(doc, 'RealEstateListing')?.name).toBe('listing');
  });

  it('returns null when no matching node exists', () => {
    expect(findGraphNode({ '@graph': [] }, 'CollectionPage')).toBeNull();
    expect(findGraphNode(null, 'CollectionPage')).toBeNull();
  });
});
