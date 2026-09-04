import { describe, it, expect } from 'vitest';
import { HM_VIEWS, viewArg, viewResponse } from '../src/view.js';

/** The text a tool result actually carries, which is the thing under test. */
function textOf(result: ReturnType<typeof viewResponse>): string {
  return (result.content[0] as { text: string }).text;
}

/** …parsed back, for the assertions that are about content rather than bytes. */
function parse<T = Record<string, unknown>>(result: ReturnType<typeof viewResponse>): T {
  return JSON.parse(textOf(result)) as T;
}

describe('viewResponse', () => {
  // The entire claim of the compact-view rollout is that the CHEAP rung is what
  // a caller gets without asking. A `view` parameter that had to be passed is an
  // efficiency nobody uses; if this ever regresses to full-by-default the feature
  // is inert while still looking shipped, so it is pinned first and separately.
  it('answers in compact when no view is passed at all', () => {
    const payload = { property_id: 'aaa', primary_photo_url: 'https://images.homes.com/a.jpg' };
    expect(parse(viewResponse(undefined, payload))).toEqual({ property_id: 'aaa' });
  });

  // The opposite rung, and the escape hatch: a caller who needs the URL we
  // stripped must have a way to get it back. Equality against the input object
  // (not a subset check) is deliberate — `full` means untouched.
  it("returns homes.com's payload untouched under view: \"full\"", () => {
    const payload = {
      property_id: 'aaa',
      primary_photo_url: 'https://images.homes.com/a.jpg',
      photos: ['https://images.homes.com/1.jpg'],
      nested: { image: 'https://images.homes.com/x.jpg', price: 500000 },
    };
    expect(parse(viewResponse('full', payload))).toEqual(payload);
  });

  // The subtractive promise, and the reason src/view.ts refuses to invent a field
  // list. Compact here strips media and NOTHING else, so a field this repo has
  // never heard of — a key homes.com adds next month — must arrive intact. A
  // projection built from a guessed allowlist would silently drop it and the
  // record would read like a verified answer with a hole in it.
  it('passes through a field nobody anticipated, at every depth', () => {
    const payload = {
      property_id: 'aaa',
      somethingNobodyAnticipated: 'keep me',
      nested: { alsoUnanticipated: [1, 2, 3], deeper: { brandNewField: false } },
    };
    expect(parse(viewResponse(undefined, payload))).toEqual(payload);
  });

  // `primary_photo_url` is a key THIS repo mints (formatHome / format build it),
  // and it is prefixed, so the fleet's start-anchored MEDIA_KEY rule does not
  // match it. Before the explicit `drop` rule it was removed only when its VALUE
  // happened to end in an image extension — true of every fixture in this repo,
  // and therefore invisible to every test. This asserts the field goes on a URL
  // shape that MEDIA_URL cannot help with: extension-less, query-string CDN form.
  it('drops primary_photo_url even when the URL carries no image extension', () => {
    const payload = {
      property_id: 'aaa',
      primary_photo_url: 'https://images.homes.com/render?id=aaa&w=1024',
      price: 500000,
    };
    expect(parse(viewResponse(undefined, payload))).toEqual({
      property_id: 'aaa',
      price: 500000,
    });
  });

  // …and nested, since it rides on every row of a search / bulk / compare result
  // rather than at the top level.
  it('drops primary_photo_url on every row of a listing array', () => {
    const payload = {
      count: 2,
      results: [
        { property_id: 'aaa', primary_photo_url: 'https://images.homes.com/a.jpg', price: 1 },
        { property_id: 'bbb', primary_photo_url: 'https://images.homes.com/render?id=b', price: 2 },
      ],
    };
    expect(parse(viewResponse(undefined, payload))).toEqual({
      count: 2,
      results: [
        { property_id: 'aaa', price: 1 },
        { property_id: 'bbb', price: 2 },
      ],
    });
  });

  // A `null` is data, not absence: homes.com reports "no lot" and "we did not
  // tell you" differently, and `lot_size_acres: null` is documented in this repo
  // as meaningful (never 0). Compact must not collapse the two.
  it('keeps nulls and empty strings, which are answers rather than absences', () => {
    const payload = { lot_size_acres: null, description: '', hoa_fee: 0 };
    expect(parse(viewResponse(undefined, payload))).toEqual(payload);
  });

  // Formatting whitespace is ours to drop; whitespace INSIDE a value is the
  // caller's content. A listing description is exactly where that bites —
  // paragraph breaks carry the shape of the text — so the round trip is asserted
  // byte-for-byte, not merely "looks similar". Any hand-rolled minifier (a regex
  // over the serialised text, a collapse of \s+) fails this and nothing else.
  it('leaves whitespace inside a value byte-identical', () => {
    const description = 'Charming ranch.\n\n  Updated kitchen.\n\tNew roof 2024.\n\nMotivated seller.';
    for (const view of [undefined, 'compact', 'full']) {
      expect(parse<{ description: string }>(viewResponse(view, { description })).description).toBe(
        description
      );
    }
  });

  // The saving itself. Indentation is ~a fifth of a large response and nothing
  // downstream reads it, so the emitted text must be one line — checked on the
  // serialised bytes, because a pretty-printed result parses identically and
  // would sail past every content assertion above.
  it('emits a single line of text on every rung', () => {
    const payload = { a: 1, b: { c: [1, 2, 3] }, d: 'x' };
    for (const view of [undefined, 'compact', 'full']) {
      const text = textOf(viewResponse(view, payload));
      expect(text.split('\n')).toHaveLength(1);
      expect(text).not.toMatch(/\n|\r/);
      expect(text).toBe(JSON.stringify(payload));
    }
  });

  // This server honours two rungs, not the fleet's three. A caller that names
  // `raw` — a rung that exists elsewhere in the fleet and is an easy thing to
  // reach for — gets the cheap answer, not an exception: a small correct response
  // beats a failed tool call for a mistake the caller cannot see they made. The
  // schema is the first line of defence (below); this is the second.
  it('falls back to compact for a rung this server does not honour', () => {
    const payload = { property_id: 'aaa', primary_photo_url: 'https://images.homes.com/a.jpg' };
    expect(HM_VIEWS).not.toContain('raw');
    expect(parse(viewResponse('raw', payload))).toEqual({ property_id: 'aaa' });
    expect(parse(viewResponse('nonsense', payload))).toEqual({ property_id: 'aaa' });
  });

  // The input is live scraped data that callers and other tools also hold a
  // reference to; stripping must copy rather than mutate.
  it('does not mutate the payload it was handed', () => {
    const payload = { property_id: 'aaa', primary_photo_url: 'https://images.homes.com/a.jpg' };
    viewResponse(undefined, payload);
    expect(payload.primary_photo_url).toBe('https://images.homes.com/a.jpg');
  });
});

describe('viewArg', () => {
  // The schema must advertise only what src/view.ts can honour, or a host shows
  // the model a rung that silently aliases to another one.
  it('accepts the honoured rungs, rejects the ones this server has no answer for', () => {
    const schema = viewArg();
    expect(schema.parse(undefined)).toBeUndefined();
    for (const rung of HM_VIEWS) expect(schema.parse(rung)).toBe(rung);
    expect(schema.safeParse('raw').success).toBe(false);
  });

  // The description is the only place a caller learns what compact costs them.
  // `.describe()` has to land on the OPTIONAL wrapper — applied to the inner enum
  // it comes back blank, which is a parameter documented to nobody.
  it('carries the per-tool note on the wrapper a host actually reads', () => {
    expect(viewArg().description).toContain('image/avatar URLs');
  });
});
