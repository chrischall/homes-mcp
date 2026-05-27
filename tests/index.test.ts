// Smoke test for the full tool surface. Verifies every homes_* tool is
// registered and visible over the MCP wire — catches "forgot to wire it
// up in index.ts" mistakes that the per-tool tests miss.
import { describe, it, expect, afterAll, vi } from 'vitest';
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
import { SessionRegistry } from '../src/sessions.js';
import { registerSessionsTools } from '../src/tools/sessions.js';
import { createTestHarness } from './helpers.js';

const mockClient = {
  fetchHtml: vi.fn(),
  fetchJson: vi.fn(),
} as unknown as HomesClient;

const EXPECTED_TOOLS = [
  'homes_search_properties',
  'homes_get_property',
  'homes_get_property_photos',
  'homes_compare_properties',
  'homes_calculate_mortgage',
  'homes_calculate_affordability',
  'homes_healthcheck',
  'homes_get_property_history',
  'homes_get_tax_history',
  'homes_get_nearby_listings',
  'homes_get_market_report',
  'homes_get_saved_homes',
  'homes_get_saved_searches',
  'homes_estimate_rent_vs_buy',
  'homes_get_by_address',
  'homes_get_session_context',
  'homes_register_session',
  'homes_set_active_session',
];

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('tool registration', () => {
  it('registers every advertised homes_* tool', async () => {
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
      registerSessionsTools(server, new SessionRegistry());
    });
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });
});
