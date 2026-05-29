import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COMMUNITIES,
  extractFeatures,
  loadCommunities,
} from '../src/features.js';

describe('extractFeatures', () => {
  describe('lake_front', () => {
    it('detects "lakefront"', () => {
      expect(extractFeatures('Beautiful lakefront home.', []).lake_front).toBe(true);
    });
    it('detects "lake front" with space', () => {
      expect(extractFeatures('Stunning lake front views.', []).lake_front).toBe(true);
    });
    it('detects "waterfront"', () => {
      expect(extractFeatures('Premier waterfront property.', []).lake_front).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(extractFeatures('LAKEFRONT estate', []).lake_front).toBe(true);
    });
    it('returns false when no waterfront language present', () => {
      expect(extractFeatures('A nice quiet inland cabin.', []).lake_front).toBe(false);
    });
  });

  describe('hot_tub', () => {
    it('detects "hot tub"', () => {
      expect(extractFeatures('Private hot tub on the deck.', []).hot_tub).toBe(true);
    });
    it('ignores "hottub" run-together', () => {
      expect(extractFeatures('Hottub included.', []).hot_tub).toBe(false);
    });
  });

  describe('basement (substring trap)', () => {
    it('classifies "unfinished basement" as unfinished (not finished)', () => {
      // PINNED REGRESSION: `finished basement` substring-matches inside
      // `unfinished basement`. Unfinished must be checked first.
      expect(
        extractFeatures(
          'Hardwood floors throughout with unfinished basement waiting for finishing.',
          []
        ).basement
      ).toBe('unfinished');
    });

    it('classifies word-reversed "basement is unfinished" (direct connector)', () => {
      // Canonical detector: the connector (is/was/,/;/:/(/dash) must
      // directly follow `basement` (modulo whitespace).
      expect(
        extractFeatures(
          'The home includes a basement, unfinished and ready to customize.',
          []
        ).basement
      ).toBe('unfinished');
    });

    it('does NOT classify when an interposed word breaks the connector (canonical delta)', () => {
      // DELTA from the prior loose `[^.!?]{0,30}?` window: "basement that
      // is unfinished" interposes "that" before the connector, so the
      // tight `BASEMENT_CONNECTOR` class no longer matches. It falls
      // through to a bare-mention `'unknown'` rather than `'unfinished'`.
      expect(
        extractFeatures(
          'The home includes a basement that is unfinished and ready to customize.',
          []
        ).basement
      ).toBe('unknown');
    });

    it('does NOT false-positive "basement with finished oak shelving" to finished (canonical delta)', () => {
      // DELTA from the prior loose window, which matched `finished`
      // anywhere within ~30 chars of `basement` and so mis-tagged this
      // as `'finished'`. The canonical connector class rejects the
      // free-floating preposition "with" — the shelving is finished, not
      // the basement — yielding a bare-mention `'unknown'`.
      expect(
        extractFeatures('Basement with finished oak shelving.', []).basement
      ).toBe('unknown');
    });

    it('classifies "finished basement" as finished', () => {
      expect(extractFeatures('Includes a finished basement.', []).basement).toBe(
        'finished'
      );
    });

    it('classifies "partial basement" as partial', () => {
      expect(extractFeatures('A partial basement provides storage.', []).basement).toBe(
        'partial'
      );
    });

    it('classifies "partially finished basement" as partial', () => {
      expect(
        extractFeatures('Spacious partially finished basement.', []).basement
      ).toBe('partial');
    });

    it('classifies bare "basement" mention as unknown', () => {
      expect(extractFeatures('The basement door is over here.', []).basement).toBe(
        'unknown'
      );
    });

    it('returns null when no basement mentioned', () => {
      expect(extractFeatures('Open-plan slab construction.', []).basement).toBe(null);
    });
  });

  describe('furnished', () => {
    it('classifies "fully furnished" as fully', () => {
      expect(extractFeatures('Sold fully furnished.', []).furnished).toBe('fully');
    });
    it('classifies "turnkey" as fully', () => {
      expect(extractFeatures('Turnkey investment opportunity.', []).furnished).toBe(
        'fully'
      );
    });
    it('classifies "sold furnished" as fully', () => {
      expect(extractFeatures('Sold furnished, move-in ready.', []).furnished).toBe(
        'fully'
      );
    });
    it('classifies "almost furnished" as partial', () => {
      expect(extractFeatures('Almost furnished — bring your taste.', []).furnished).toBe(
        'partial'
      );
    });
    it('classifies "with exceptions" as partial', () => {
      expect(
        extractFeatures('Furnished with exceptions noted by seller.', []).furnished
      ).toBe('partial');
    });
    it('classifies "furnishings negotiable" as negotiable', () => {
      expect(
        extractFeatures('Furnishings are negotiable separately.', []).furnished
      ).toBe('negotiable');
    });
    it('returns null when no furnishing language present', () => {
      expect(extractFeatures('Lovely garden home.', []).furnished).toBe(null);
    });
    it('does NOT misfire on bare "with exceptions" in non-furnishing context (false-positive pin)', () => {
      // "with exceptions" by itself shows up in title-report, HOA, and
      // disclosure prose unrelated to furnishings — the furnished token
      // must anchor the match.
      expect(
        extractFeatures(
          'Sold with exceptions per title report; modern open floor plan.',
          []
        ).furnished
      ).toBeNull();
      expect(
        extractFeatures(
          'HOA documents available with exceptions noted in section 3.',
          []
        ).furnished
      ).toBeNull();
    });
  });

  describe('dock', () => {
    it('classifies "private dock" with private specificity', () => {
      expect(extractFeatures('Private dock with deep water access.', []).dock).toBe(
        'private'
      );
    });
    it('classifies "community dock" as community', () => {
      expect(extractFeatures('Shared community dock on the cove.', []).dock).toBe(
        'community'
      );
    });
    it('classifies bare "boat slip" as boat_slip', () => {
      expect(extractFeatures('Deeded boat slip included.', []).dock).toBe('boat_slip');
    });
    it('classifies bare "marina" as marina', () => {
      expect(extractFeatures('Close to the local marina.', []).dock).toBe('marina');
    });
    it('prefers private over marina when both mentioned', () => {
      expect(
        extractFeatures('Private dock plus easy marina access.', []).dock
      ).toBe('private');
    });
  });

  describe('community', () => {
    it('matches a community name case-insensitively', () => {
      expect(
        extractFeatures('Located in rumbling bald with great views.', [
          'Rumbling Bald',
        ]).community
      ).toBe('Rumbling Bald');
    });
    it('tolerates trailing punctuation', () => {
      expect(
        extractFeatures('Welcome to Rumbling Bald, a premier community.', [
          'Rumbling Bald',
        ]).community
      ).toBe('Rumbling Bald');
    });
    it('returns the earliest community mentioned in document order', () => {
      expect(
        extractFeatures(
          'Riverbend at Lake Lure offers easy access to Rumbling Bald.',
          ['Rumbling Bald', 'Riverbend at Lake Lure']
        ).community
      ).toBe('Riverbend at Lake Lure');
    });
    it('returns null when no community matches', () => {
      expect(extractFeatures('Atlanta cottage.', ['Rumbling Bald']).community).toBe(
        null
      );
    });
  });

  describe('empty / undefined input', () => {
    it('handles undefined description', () => {
      expect(extractFeatures(undefined, [])).toEqual({
        lake_front: false,
        hot_tub: false,
        basement: null,
        furnished: null,
        dock: null,
        community: null,
      });
    });
  });
});

describe('loadCommunities', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'homes-communities-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HOMES_COMMUNITIES_FILE;
  });

  it('returns DEFAULT_COMMUNITIES when env var unset', () => {
    delete process.env.HOMES_COMMUNITIES_FILE;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('loads a valid JSON string array from the configured path', () => {
    const path = join(dir, 'communities.json');
    writeFileSync(path, JSON.stringify(['Alpha', 'Beta']));
    process.env.HOMES_COMMUNITIES_FILE = path;
    expect(loadCommunities()).toEqual(['Alpha', 'Beta']);
  });

  it('falls back to defaults + warns when the file is missing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.HOMES_COMMUNITIES_FILE = join(dir, 'no-such-file.json');
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    spy.mockRestore();
  });

  it('falls back to defaults + warns when JSON is malformed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not json');
    process.env.HOMES_COMMUNITIES_FILE = path;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('falls back when JSON is not a string array', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = join(dir, 'notarray.json');
    writeFileSync(path, JSON.stringify({ foo: 'bar' }));
    process.env.HOMES_COMMUNITIES_FILE = path;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    spy.mockRestore();
  });

  it('caches the missing-file fallback so repeated calls do not re-stat (negative cache)', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.HOMES_COMMUNITIES_FILE = join(dir, 'no-such-file.json');

    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

    // The stderr warning should fire only once — subsequent calls
    // short-circuit on the negative cache instead of re-stat+re-warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('caches the malformed-JSON fallback so repeated calls do not re-read (negative cache)', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not json');
    process.env.HOMES_COMMUNITIES_FILE = path;

    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

    // Same negative-cache shape: one warning, not three.
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('caches the non-array fallback so repeated calls do not re-read (negative cache)', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = join(dir, 'notarray.json');
    writeFileSync(path, JSON.stringify({ foo: 'bar' }));
    process.env.HOMES_COMMUNITIES_FILE = path;

    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('invalidates the negative cache when the env var path changes', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.env.HOMES_COMMUNITIES_FILE = join(dir, 'missing-a.json');
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

    // Changing the path should force a fresh filesystem check + new warning.
    process.env.HOMES_COMMUNITIES_FILE = join(dir, 'missing-b.json');
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('invalidates the negative cache when the env var is unset', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.env.HOMES_COMMUNITIES_FILE = join(dir, 'missing.json');
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

    delete process.env.HOMES_COMMUNITIES_FILE;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

    // Re-setting should re-warn (cache invalidated on the unset).
    process.env.HOMES_COMMUNITIES_FILE = join(dir, 'missing.json');
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
