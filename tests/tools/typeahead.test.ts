import { describe, it, expect } from 'vitest';
import {
  SMARTSEARCH_AUTOCOMPLETE_PATH,
  buildAutocompleteBody,
  extractAddressCandidates,
  type SmartsearchResponse,
} from '../../src/tools/typeahead.js';

/**
 * Unit tests for the homes.com structured-search typeahead module.
 *
 * Fixtures are the REAL request body + response captured live from
 * homes.com's search box on 2026-05-28 (XHR interception). See the
 * module header for the full capture.
 */

describe('SMARTSEARCH_AUTOCOMPLETE_PATH', () => {
  it('is the POST autocomplete endpoint the live search box fires', () => {
    expect(SMARTSEARCH_AUTOCOMPLETE_PATH).toBe(
      '/routes/res/consumer/smartsearch/autocomplete/'
    );
  });
});

describe('buildAutocompleteBody', () => {
  it('sends `term` (lowercased) — the load-bearing field — plus `fullTerm` and transactionType', () => {
    const body = buildAutocompleteBody({
      address: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    // term is the field the endpoint actually requires (fullTerm-only → 400).
    expect(body.term).toBe('158 raven blvd lake lure nc 28746');
    expect(body.fullTerm).toBe('158 Raven Blvd Lake Lure NC 28746');
    expect(body.transactionType).toBe(1);
    expect(body.searchTermStartIndex).toBeNull();
  });

  it('omits an absent zip cleanly', () => {
    const body = buildAutocompleteBody({
      address: '3199 Delmar Ln NW',
      city: 'Atlanta',
      state: 'GA',
    });
    expect(body.term).toBe('3199 delmar ln nw atlanta ga');
    expect(body.fullTerm).toBe('3199 Delmar Ln NW Atlanta GA');
  });
});

// Real captured response — 158 Raven Blvd, Lake Lure NC.
const RAVEN_RESPONSE: SmartsearchResponse = {
  suggestions: {
    places: [
      {
        n: '158 Raven Blvd, Lake Lure, NC',
        u: '/property/158-raven-blvd-lake-lure-nc/yhepckbpqstf1/',
        g: {
          k: { key: 'yhepckbpqstf1' },
          d: '158 Raven Blvd, Lake Lure, NC',
          t: 8,
          a: {
            countryCode: 'US',
            state: 'NC',
            city: 'Lake Lure',
            postalCode: '28746',
            street: '158 Raven Blvd',
            other: 'ForSale',
          },
          l: { lt: 35.4286, ln: -82.17019 },
        },
        s: 'Address',
        sts: 0,
      },
    ],
    neighborhoods: [],
    schools: [],
    buildings: [],
    agents: [],
    newhomes: [],
  },
};

describe('extractAddressCandidates', () => {
  it('pulls the place candidates (street, unit, url, hash) out of the real response', () => {
    const candidates = extractAddressCandidates(RAVEN_RESPONSE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      url: '/property/158-raven-blvd-lake-lure-nc/yhepckbpqstf1/',
      property_hash: 'yhepckbpqstf1',
      street: '158 Raven Blvd',
      display: '158 Raven Blvd, Lake Lure, NC',
    });
  });

  it('carries the unit through for multi-unit buildings', () => {
    const resp: SmartsearchResponse = {
      suggestions: {
        places: [
          {
            n: '155 Quail Cove Blvd Unit 1601, Lake Lure, NC',
            u: '/property/155-quail-cove-blvd-lake-lure-nc-unit-1601/lgt0s6vpv9cln/',
            g: {
              k: { key: 'lgt0s6vpv9cln' },
              d: '155 Quail Cove Blvd Unit 1601, Lake Lure, NC',
              t: 8,
              a: {
                state: 'NC',
                city: 'Lake Lure',
                postalCode: '28746',
                street: '155 Quail Cove Blvd',
                unit: '1601',
                other: 'ForSale',
              },
            },
            s: 'Address',
            sts: 0,
          },
        ],
      },
    };
    const candidates = extractAddressCandidates(resp);
    expect(candidates[0].unit).toBe('1601');
    expect(candidates[0].property_hash).toBe('lgt0s6vpv9cln');
  });

  it('returns an empty array for a no-match response (places: [])', () => {
    const empty: SmartsearchResponse = {
      suggestions: {
        places: [],
        neighborhoods: [],
        schools: [],
        buildings: [],
        agents: [],
        newhomes: [],
      },
    };
    expect(extractAddressCandidates(empty)).toEqual([]);
  });

  it('skips places missing a usable hash', () => {
    const resp: SmartsearchResponse = {
      suggestions: {
        places: [
          // No `u`, no `g.k.key` — can't build a property URL.
          { n: '1 Bad Pl, Nowhere, NC', s: 'Address', sts: 0 } as never,
        ],
      },
    };
    expect(extractAddressCandidates(resp)).toEqual([]);
  });

  it('tolerates a null / undefined response', () => {
    expect(extractAddressCandidates(null)).toEqual([]);
    expect(extractAddressCandidates(undefined)).toEqual([]);
  });
});
