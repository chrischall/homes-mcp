import { describe, it, expect } from 'vitest';
import {
  toNumber,
  firstImage,
  firstAgent,
  brokerageFrom,
  lastPathSegment,
} from '../src/jsonld.js';

describe('toNumber', () => {
  it('passes finite numbers through', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(3.5)).toBe(3.5);
  });
  it('rejects non-finite numbers', () => {
    expect(toNumber(NaN)).toBeUndefined();
    expect(toNumber(Infinity)).toBeUndefined();
  });
  it('strips punctuation from numeric strings', () => {
    expect(toNumber('$1,250,000')).toBe(1250000);
    expect(toNumber('1500')).toBe(1500);
  });
  it('returns undefined for empty / non-numeric / non-string-non-number', () => {
    expect(toNumber('')).toBeUndefined();
    expect(toNumber('abc')).toBeUndefined();
    expect(toNumber(undefined)).toBeUndefined();
    expect(toNumber({})).toBeUndefined();
  });
});

describe('firstImage', () => {
  it('returns a bare string image', () => {
    expect(firstImage('a.jpg')).toBe('a.jpg');
  });
  it('returns the first element of an array', () => {
    expect(firstImage(['a.jpg', 'b.jpg'])).toBe('a.jpg');
  });
  it('returns undefined for missing/empty', () => {
    expect(firstImage(undefined)).toBeUndefined();
    expect(firstImage([])).toBeUndefined();
  });
});

describe('firstAgent', () => {
  it('returns a bare agent object', () => {
    expect(firstAgent({ name: 'A' })).toEqual({ name: 'A' });
  });
  it('returns the first of an array', () => {
    expect(firstAgent([{ name: 'A' }, { name: 'B' }])).toEqual({ name: 'A' });
  });
  it('returns undefined when absent', () => {
    expect(firstAgent(undefined)).toBeUndefined();
  });
});

describe('brokerageFrom', () => {
  it('reads memberOf object name', () => {
    expect(brokerageFrom({ memberOf: { name: 'Acme Realty' } })).toBe('Acme Realty');
  });
  it('reads first memberOf array name', () => {
    expect(brokerageFrom({ memberOf: [{ name: 'First' }, { name: 'Second' }] })).toBe(
      'First'
    );
  });
  it('returns undefined when no memberOf', () => {
    expect(brokerageFrom({})).toBeUndefined();
    expect(brokerageFrom(undefined)).toBeUndefined();
  });
});

describe('lastPathSegment', () => {
  it('strips origin and returns the final segment', () => {
    expect(
      lastPathSegment('https://www.homes.com/property/3199-delmar-ln/rxrzwg0kjnr32/')
    ).toBe('rxrzwg0kjnr32');
  });
  it('strips a #fragment before taking the segment (homes.com @id case)', () => {
    expect(
      lastPathSegment('https://www.homes.com/property/x/abc123/#realestatelisting')
    ).toBe('abc123');
  });
  it('strips a ?query before taking the segment', () => {
    expect(lastPathSegment('/property/x/abc123/?ref=foo')).toBe('abc123');
  });
  it('handles a bare path', () => {
    expect(lastPathSegment('/property/x/abc123/')).toBe('abc123');
  });
  it('returns "" for empty / undefined / segment-less input', () => {
    expect(lastPathSegment('')).toBe('');
    expect(lastPathSegment(undefined)).toBe('');
    expect(lastPathSegment('https://www.homes.com/')).toBe('');
  });
});
