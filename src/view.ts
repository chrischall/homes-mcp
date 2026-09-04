import { minifiedResult, resolveView, stripMediaUrls, viewParam, type View } from '@chrischall/mcp-utils';

/**
 * The rungs this server honours (`@chrischall/mcp-utils`' `view` vocabulary;
 * `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * **What compact does here, and what it deliberately does NOT do.**
 *
 * The read tools in this server hand back Homes.com's payload close to
 * verbatim, and the repo holds no verified record of what those payloads
 * contain — no captured fixture, no documented field list. So nothing here can
 * honestly say which of Homes.com's fields matter and which are noise.
 *
 * Compact therefore does the one projection that needs no such knowledge: it
 * strips image and avatar URLs. That is SUBTRACTIVE, so it cannot lose a field
 * nobody knew about — the failure an invented field list would risk, where a
 * record comes back with holes in it and reads like a verified answer.
 *
 * When a real payload can be captured, a field projection belongs here beside
 * this one and will save considerably more. Until then this is the honest
 * ceiling, and this docblock says so rather than implying a shape was checked.
 */
export const HM_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact strips image/avatar URLs from the response; "full" returns Homes.com\'s payload untouched. ' +
  'No field projection: this server has no verified record of which Homes.com fields matter, and inventing ' +
  'one would risk dropping a field a caller needs.';

/** The `view` parameter every read tool in this server takes. */
export const viewArg = (): ReturnType<typeof viewParam> => viewParam(HM_VIEWS, { note: NOTE });

/**
 * Keys THIS repo mints, which the fleet's media rule cannot be expected to know.
 *
 * Neither entry is a homes.com field: `formatHome` / `format` construct
 * `primary_photo_url`, and `scrapeExtras` builds `floorplan_urls` out of the
 * page's own `<img>` tags. Naming keys this repo MINTS needs no knowledge of
 * the upstream payload and carries none of the risk a guessed field list does.
 *
 * They are here because the fleet's `MEDIA_KEY` is anchored at the START of the
 * key (deliberately: that anchor is what keeps `hasThumbnail: false` alive), so
 * a PREFIXED key does not match — and `floorplan` is not a media noun the rule
 * knows at all.
 *
 * What each key falls back to without its rule is DIFFERENT, and the weaker
 * case is the one that looks fine:
 *
 * - `primary_photo_url` holds a string, so `MEDIA_URL` catches it — but only
 *   when the value ends in an image extension. True of every URL in this repo's
 *   fixtures, so every test would have passed, and false the day homes.com
 *   serves an extension-less CDN URL.
 * - `floorplan_urls` holds an ARRAY, and `MEDIA_URL` is tested against object
 *   values, never against array ELEMENTS. So it was not "sometimes kept" — it
 *   was never stripped at all, `.jpg` and all. Naming the key is the only thing
 *   that reaches it.
 *
 * A rule that holds because of what the data looks like today is not a rule,
 * and one that never fired is not a rule either.
 *
 * The bar for adding an entry: this repo mints the key, and its value is an
 * image a model cannot see. `matterport_url` fails the second half — it is a
 * link to a PAGE, and a caller can act on it — so it stays.
 */
const DROP = ['primary_photo_url', 'floorplan_urls'] as const;

/**
 * Answer in the requested rung.
 *
 * Only ever called from a READ tool. A write's response is a receipt — an id,
 * a status — with nothing to strip and everything to keep.
 *
 * **Never wire this onto a tool whose PRODUCT is the image.**
 * `homes_get_property_photos` exists to return exactly these URLs; compact
 * there would not shrink the response, it would empty it (`photos` is itself a
 * media key). That tool returns `minifiedResult` directly and must keep doing so.
 */
export function viewResponse(view: string | undefined, data: unknown): ReturnType<typeof minifiedResult> {
  const rung: View = resolveView(view, HM_VIEWS);
  return minifiedResult(rung === 'compact' ? stripMediaUrls(data, { drop: DROP }) : data);
}
