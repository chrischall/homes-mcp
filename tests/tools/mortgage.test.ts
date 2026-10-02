import { describe, it, expect, afterAll } from 'vitest';
import { registerMortgageTools } from '../../src/tools/mortgage.js';
import { MAX_LOAN_TERM_YEARS } from '@chrischall/realty-core';
import { createTestHarness, parseToolResult } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('homes_calculate_mortgage tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerMortgageTools(server)
    );
  });

  it('returns PITI breakdown for a 20%-down loan at 6.5% / 30yr', async () => {
    const r = await harness.callTool('homes_calculate_mortgage', {
      home_price: 1_000_000,
      interest_rate: 6.5,
      down_payment_percent: 20,
      property_tax_rate: 1.1,
      insurance_annual: 1800,
    });
    const parsed = parseToolResult<{
      loan_amount: number;
      monthly_principal_interest: number;
      monthly_total_piti: number;
      total_interest_over_term: number;
    }>(r);
    expect(parsed.loan_amount).toBe(800000);
    // ~6.5% / 30yr / 800K loan should be ~$5057/mo
    expect(parsed.monthly_principal_interest).toBeGreaterThan(4900);
    expect(parsed.monthly_principal_interest).toBeLessThan(5200);
    expect(parsed.monthly_total_piti).toBeGreaterThan(parsed.monthly_principal_interest);
    expect(parsed.total_interest_over_term).toBeGreaterThan(800_000);
  });

  it('applies PMI when LTV > 80% and pmi_rate provided', async () => {
    const r = await harness.callTool('homes_calculate_mortgage', {
      home_price: 500_000,
      interest_rate: 7,
      down_payment_percent: 10,
      pmi_rate: 1,
    });
    const parsed = parseToolResult<{ monthly_pmi: number }>(r);
    expect(parsed.monthly_pmi).toBeGreaterThan(0);
  });

  it('keeps the lean output contract (ltv as 0..1, no interest_rate echo)', async () => {
    const r = await harness.callTool('homes_calculate_mortgage', {
      home_price: 500_000,
      interest_rate: 6,
      down_payment_percent: 20,
    });
    const parsed = parseToolResult<Record<string, unknown>>(r);
    expect(parsed.ltv).toBe(0.8);
    expect(parsed).toHaveProperty('monthly_total_piti');
    expect(parsed).toHaveProperty('total_interest_over_term');
    expect(parsed).not.toHaveProperty('interest_rate');
    expect(parsed).not.toHaveProperty('total_paid_over_loan');
  });

  it('rejects loan_term_years above MAX_LOAN_TERM_YEARS at the schema (fleet-audit#1021)', async () => {
    const r = await harness.callTool('homes_calculate_mortgage', {
      home_price: 500_000,
      interest_rate: 6,
      loan_term_years: MAX_LOAN_TERM_YEARS + 1,
    });
    expect(r.isError).toBe(true);
  });

  it('advertises the realty-core year caps in its input schema (fleet-audit#1021)', async () => {
    const { tools } = await harness.client.listTools();
    const tool = tools.find((t) => t.name === 'homes_calculate_mortgage');
    const props = tool!.inputSchema.properties as Record<string, { maximum?: number }>;
    expect(props.loan_term_years.maximum).toBe(MAX_LOAN_TERM_YEARS);
  });
});
