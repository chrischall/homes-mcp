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
import type {
  BridgeStatus,
  FetchInit,
  FetchResult,
  HomesTransport,
} from './transport.js';

export class SessionNotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not signed in to homes.com (or AWS WAF challenge interstitial returned). ' +
        'Open homes.com in your browser, complete sign-in / WAF challenge, then try again.'
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

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
   * non-2xx, invalid JSON, or sign-in page. Currently unused — kept for
   * forward compatibility if homes.com exposes a usable JSON API.
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
    const serialised: FetchInit = {
      path,
      method,
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' && init.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers ?? {}),
      },
      body:
        method === 'GET' || init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
    };
    const result = await this.transport.fetch(serialised);
    this.throwIfNotOk(result, method, path);
    this.throwIfSignInPage(result);
    if (result.status === 204 || result.body === '') {
      return null as T;
    }
    try {
      return JSON.parse(result.body) as T;
    } catch (e) {
      throw new Error(
        `Homes ${method} ${path} — response was not JSON: ${String(
          (e as Error).message
        )}`
      );
    }
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    const bodyPreview = result.body
      ? ` — ${result.body.slice(0, 500).replace(/\s+/g, ' ').trim()}${
          result.body.length > 500 ? '…' : ''
        }`
      : '';
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
    const looksLikeSignIn =
      /\/sign-in(\?|$)/.test(result.url) ||
      (result.body.includes('awswaf.com') &&
        result.body.includes('challenge.js') &&
        result.body.length < 80_000);
    if (looksLikeSignIn) throw new SessionNotAuthenticatedError();
  }
}
