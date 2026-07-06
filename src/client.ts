// HomesClient is the thin, tool-facing API over a HomesTransport.
//
// homes.com is a fully SSR React app — there's no public JSON API
// surface exposed to the browser, and the data we need lives in one
// place on each rendered page:
//
//   - `<script type="application/ld+json">` — Schema.org structured
//     data (CollectionPage on search, RealEstateListing on detail).
//
// So the client surface is intentionally minimal: `fetchHtml` for SSR
// pages, plus `fetchJson` kept for any direct API endpoints we find
// later. Both ride through fetchproxy so the user's signed-in
// homes.com session does the actual HTTP.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it.
import {
  SessionNotAuthenticatedError,
  truncateErrorMessage,
} from '@chrischall/mcp-utils';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchResult,
  HomesTransport,
} from './transport.js';

// The canonical parameterized SessionNotAuthenticatedError lives in
// @chrischall/mcp-utils; re-exported so existing `./client.js`
// importers keep working. Thrown below as
// `new SessionNotAuthenticatedError('Homes.com', 'homes.com')` — the
// message names Homes.com + the sign-in host and the instance carries
// a machine-readable `hint`. The homes-specific AWS WAF guidance the
// old local class baked into its message is appended at the throw site
// (`throwIfSignInPage`) when the WAF signal is what tripped.
export { SessionNotAuthenticatedError };

export interface HomesClientOptions {
  /** Transport used to relay fetches to the user's browser. */
  transport: HomesTransport;
}

export class HomesClient {
  private readonly transport: HomesTransport;

  constructor(opts: HomesClientOptions) {
    this.transport = opts.transport;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Diagnostic snapshot of the bridge — surfaced by `homes_healthcheck`. */
  bridgeStatus(): BridgeStatus {
    return this.transport.status();
  }

  /**
   * 0.10.0+: run a single healthcheck probe through the transport's
   * `runProbe` (which delegates to `@fetchproxy/server`'s probe loop):
   * run `fetchFn`, measure elapsed ms, classify any error, and project
   * the post-probe bridge state. `homes_healthcheck` supplies its own
   * probe call + path and keeps the homes-specific hint text.
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.transport.runProbe(fetchFn, probePath);
  }

  /**
   * GET a homes.com path, return the HTML body. Throws on non-2xx or
   * sign-in interstitial. The primary primitive for homes-mcp tools —
   * every homes.com page server-renders its data into a JSON-LD block
   * that the tool layer parses (and an HTML body for the photo gallery).
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    return result.body;
  }

  /**
   * POST/PUT/DELETE a JSON body, return the parsed JSON. Throws on
   * non-2xx, invalid JSON, or sign-in page. Used by the smartsearch
   * typeahead rung in by-address.ts.
   *
   * 0.10.0+: serialization + Accept/Content-Type defaults + 204/empty →
   * null + JSON.parse are owned by `@fetchproxy/server`'s `requestJson`
   * (surfaced through the transport). The dep deliberately does NOT run
   * the HTTP-status assertion or the sign-in interstitial check — those
   * are homes.com-specific — so we keep `throwIfNotOk` / `throwIfSignInPage`
   * here, run over the raw `result` the transport returns alongside `data`.
   */
  async fetchJson<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const method = init.method ?? 'POST';
    const { data, result } = await this.transport.requestJson<T>({
      path,
      method,
      headers: init.headers,
      body: init.body,
    });
    this.throwIfNotOk(result, method, path);
    this.throwIfSignInPage(result);
    return data as T;
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    // truncateErrorMessage (mcp-utils) redacts any bearer/JWT secrets BEFORE
    // truncating at the fleet-wide 500-char budget; we collapse internal
    // whitespace first so multi-line HTML error pages stay one line. Same
    // shape as the opentable/musescore siblings.
    const collapsed = result.body
      ? result.body.replace(/\s+/g, ' ').trim()
      : '';
    const bodyPreview = collapsed ? ` — ${truncateErrorMessage(collapsed)}` : '';
    throw new Error(
      `homes.com error: ${result.status} for ${method} ${path}${bodyPreview}`
    );
  }

  private throwIfSignInPage(result: FetchResult): void {
    // homes.com signals a missing session via:
    //   1. Redirect to /sign-in (URL match). homes.com uses this path
    //      for the sign-in flow rather than /login.
    //   2. AWS WAF challenge interstitial. Marker: the AWS WAF
    //      `awswaf.com/...challenge.js` script is referenced inline.
    //      CoStar (homes.com's parent) gates traffic through AWS WAF
    //      so this body-content check is still load-bearing.
    //
    // We deliberately do NOT body-match `/sign-in` since every signed-in
    // homes.com page has a "Sign in" link in its nav.
    const isSignInRedirect = /\/sign-in(\?|$)/.test(result.url);
    const isWafChallenge =
      result.body.includes('awswaf.com') &&
      result.body.includes('challenge.js') &&
      result.body.length < 80_000;
    if (!isSignInRedirect && !isWafChallenge) return;
    const err = new SessionNotAuthenticatedError('Homes.com', 'homes.com');
    if (isWafChallenge) {
      // Load-bearing homes.com-specific guidance (formerly baked into the
      // local error class): the block may be the AWS WAF interstitial
      // rather than a missing session, and the fix is to clear the
      // challenge in the browser, not just sign in.
      err.message +=
        ' An AWS WAF challenge interstitial was returned — open homes.com' +
        ' in your browser and complete the challenge, then retry.';
    }
    throw err;
  }
}
