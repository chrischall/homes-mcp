import { describe, it, expect, afterAll } from 'vitest';
import {
  computeAffordability,
  registerAffordabilityTools,
} from '../../src/tools/affordability.js';
import { MAX_LOAN_TERM_YEARS } from '@chrischall/realty-core';
import { createTestHarness, parseToolResult } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('computeAffordability', () => {
  it('returns a reasonable max purchase price under 28/36 DTI', () => {
    const out = computeAffordability({
      monthly_income: 12000,
      monthly_debts: 600,
      down_payment: 120000,
      interest_rate: 6.5,
    });
    expect(out.max_home_price).toBeGreaterThan(400000);
    expect(out.max_home_price).toBeLessThan(700000);
    expect(out.binding_constraint).toBe('front_end');
    expect(out.loan_amount).toBe(
      Math.round((out.max_home_price - out.down_payment) * 100) / 100
    );
  });

  it('switches binding constraint to back_end when debts are heavy', () => {
    const out = computeAffordability({
      monthly_income: 12000,
      monthly_debts: 3000, // big car + student loans
      down_payment: 100000,
      interest_rate: 6.5,
    });
    expect(out.binding_constraint).toBe('back_end');
  });
});

describe('homes_calculate_affordability tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerAffordabilityTools(server)
    );
  });

  it('returns the JSON-serialized AffordabilityResult', async () => {
    const r = await harness.callTool('homes_calculate_affordability', {
      monthly_income: 12000,
      monthly_debts: 600,
      down_payment: 120000,
      interest_rate: 6.5,
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      max_home_price: number;
      binding_constraint: string;
    }>(r);
    expect(parsed.max_home_price).toBeGreaterThan(400000);
    expect(parsed.binding_constraint).toBe('front_end');
  });

  it('rejects loan_term_years above MAX_LOAN_TERM_YEARS at the schema', async () => {
    const r = await harness.callTool('homes_calculate_affordability', {
      monthly_income: 12000,
      down_payment: 120000,
      interest_rate: 6.5,
      loan_term_years: MAX_LOAN_TERM_YEARS + 1,
    });
    expect(r.isError).toBe(true);
  });

  it('advertises the realty-core year caps in its input schema (fleet-audit#1021)', async () => {
    const { tools } = await harness.client.listTools();
    const tool = tools.find((t) => t.name === 'homes_calculate_affordability');
    const props = tool!.inputSchema.properties as Record<string, { maximum?: number }>;
    expect(props.loan_term_years.maximum).toBe(MAX_LOAN_TERM_YEARS);
  });
});
