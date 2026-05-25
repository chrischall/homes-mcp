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
    });
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });
});
