// Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
// read off the MCP wire (tools/list) — what a host sees — so the shared
// registrars (realty-core calculators, the mcp-utils session trio) are
// checked exactly like the tools this repo registers itself.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { HomesClient } from '../src/client.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerPropertyTools } from '../src/tools/properties.js';
import { registerMortgageTools } from '../src/tools/mortgage.js';
import { registerCompareTools } from '../src/tools/compare.js';
import { registerAffordabilityTools } from '../src/tools/affordability.js';
import { registerPhotosTools } from '../src/tools/photos.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerHistoryTools } from '../src/tools/history.js';
import { registerNearbyTools } from '../src/tools/nearby.js';
import { registerMarketTools } from '../src/tools/market.js';
import { registerSavedTools } from '../src/tools/saved.js';
import { registerRentVsBuyTools } from '../src/tools/rent-vs-buy.js';
import { registerByAddressTools } from '../src/tools/by-address.js';
import { registerSessionsTools } from '../src/tools/sessions.js';
import { registerBulkGetTools } from '../src/tools/bulk-get.js';
import { registerResolveAddressesTools } from '../src/tools/resolve-addresses.js';
import { createSessionRegistry } from '@chrischall/mcp-utils/session';
import { createTestHarness } from './helpers.js';

const mockClient = {
  fetchHtml: vi.fn(),
  fetchJson: vi.fn(),
  runProbe: vi.fn(),
  bridgeStatus: vi.fn(),
} as unknown as HomesClient;

type Mint = {
  domain?: string;
  intent?: string;
  canonical?: unknown;
  subject?: string;
  when?: Record<string, string>;
  aliases?: string[];
};
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, unknown> };
  _meta?: { mint?: Mint };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every served tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  homes_search_properties: 'lookup',
  homes_get_property: 'lookup',
  homes_get_property_photos: 'lookup',
  homes_compare_properties: 'lookup',
  homes_get_property_history: 'lookup',
  homes_get_tax_history: 'lookup',
  homes_get_history: 'lookup',
  homes_get_nearby_listings: 'lookup',
  homes_get_market_report: 'lookup',
  homes_get_saved_homes: 'lookup',
  homes_get_saved_searches: 'lookup',
  homes_get_by_address: 'lookup',
  homes_resolve_addresses: 'lookup',
  homes_bulk_get: 'lookup',
  homes_calculate_mortgage: 'other',
  homes_calculate_affordability: 'other',
  homes_estimate_rent_vs_buy: 'other',
  homes_get_session_context: 'lookup',
  homes_register_session: 'other',
  homes_set_active_session: 'other',
};

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let tools: Listed[];

beforeAll(async () => {
  harness = await createTestHarness((server) => {
    registerSearchTools(server, mockClient);
    registerPropertyTools(server, mockClient);
    registerMortgageTools(server);
    registerCompareTools(server, mockClient);
    registerAffordabilityTools(server);
    registerPhotosTools(server, mockClient);
    registerHealthcheckTools(server, mockClient);
    registerHistoryTools(server, mockClient);
    registerNearbyTools(server, mockClient);
    registerMarketTools(server, mockClient);
    registerSavedTools(server, mockClient);
    registerRentVsBuyTools(server);
    registerByAddressTools(server, mockClient);
    registerSessionsTools(server, createSessionRegistry());
    registerBulkGetTools(server, mockClient);
    registerResolveAddressesTools(server, mockClient);
  });
  tools = (await harness.client.listTools()).tools as Listed[];
});

afterAll(async () => {
  if (harness) await harness.close();
});

describe('_meta.mint on tools/list', () => {
  it('names every served tool, so a new tool cannot skip the decision', () => {
    const hinted = tools.filter((t) => t.name !== 'homes_healthcheck').map((t) => t.name).sort();
    expect(hinted).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('leaves only the healthcheck unhinted (it joins no group)', () => {
    expect(tools.filter((t) => !t._meta?.mint).map((t) => t.name)).toEqual(['homes_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain home and intent %s', (name, intent) => {
    const mint = tools.find((t) => t.name === name)?._meta?.mint;
    expect(mint, name).toBeDefined();
    expect(mint!.domain).toBe('home');
    expect(mint!.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', () => {
    for (const t of tools) {
      const mint = t._meta?.mint;
      if (!mint) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      if ('canonical' in mint) expect(mint.canonical, t.name).toBe(true);
      if (mint.subject !== undefined) expect(props, t.name).toHaveProperty(mint.subject);
      if (mint.when !== undefined) {
        expect(Object.keys(mint.when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(mint.when.start);
        expect(props, t.name).toHaveProperty(mint.when.end);
      }
      if (mint.aliases !== undefined) {
        expect(mint.aliases.length, t.name).toBeGreaterThan(0);
        expect(mint.aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of mint.aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^homes_/);
        }
      }
    }
  });

  it('canonical only on a read-only whats-new/due/on tool, at most one per intent', () => {
    const canonical = tools.filter((t) => t._meta?.mint?.canonical === true);
    for (const t of canonical) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(t._meta!.mint!.intent);
      expect(t.inputSchema.properties ?? {}, t.name).toHaveProperty('view');
    }
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
  });

  it('declares no canonical read: nothing homes.com serves answers a dated what’s-new/due/on ask', () => {
    // Saved homes and saved searches carry no dates or change feed, and
    // homes.com publishes no person-scoped calendar — so every read is a
    // lookup, and no subject enum exists to publish.
    expect(tools.filter((t) => t._meta?.mint?.canonical === true).map((t) => t.name)).toEqual([]);
    expect(tools.filter((t) => t._meta?.mint?.subject !== undefined).map((t) => t.name)).toEqual([]);
  });

  it('carries the words a person says for the everyday asks', () => {
    const aliases = (name: string) => tools.find((t) => t.name === name)?._meta?.mint?.aliases ?? [];
    expect(aliases('homes_search_properties')).toContain('homes for sale');
    expect(aliases('homes_get_saved_homes')).toContain('saved homes');
    expect(aliases('homes_calculate_mortgage')).toContain('mortgage payment');
  });

  it('keeps the session writes non-destructive alongside their hint', () => {
    for (const name of ['homes_register_session', 'homes_set_active_session']) {
      const t = tools.find((x) => x.name === name) as Listed & { annotations?: { destructiveHint?: boolean } };
      expect(t.annotations?.destructiveHint, name).toBe(false);
    }
  });
});
