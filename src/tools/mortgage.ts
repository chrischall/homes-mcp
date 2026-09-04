import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculateMortgage } from '@chrischall/realty-core';
import { minifiedResult } from '../mcp.js';

/**
 * Local-only mortgage / PITI calculator. No network — fully
 * deterministic. The math is the canonical cohort helper
 * (`calculateMortgage` in `@chrischall/realty-core`, realty-mcp#1) —
 * every cohort MCP shipped the same PMT/PITI computation. The tool keeps
 * homes-mcp's leaner output contract (`monthly_total_piti`,
 * `total_interest_over_term`, `ltv` as a 0..1 ratio, no `interest_rate`
 * echo), so we project the core's richer zillow-union breakdown back to
 * that shape here.
 */

export function registerMortgageTools(server: McpServer): void {
  server.registerTool(
    'homes_calculate_mortgage',
    {
      title: 'Calculate mortgage PITI',
      description:
        'Local-only mortgage payment calculator. Returns a full PITI breakdown (principal + interest, property tax, insurance, HOA, PMI) and total interest over the life of the loan. No network call. Provide either `down_payment` OR `down_payment_percent`; defaults to 20%. Property tax can be given as `property_tax_annual` or `property_tax_rate` (% of home price). PMI applies automatically when LTV > 80% and `pmi_rate` is provided.',
      annotations: {
        title: 'Calculate mortgage PITI',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        home_price: z.number().positive(),
        interest_rate: z.number().nonnegative().describe('Annual %, e.g. 6.5'),
        down_payment: z.number().nonnegative().optional(),
        down_payment_percent: z.number().min(0).max(100).optional(),
        loan_term_years: z.number().int().positive().optional().describe('Default 30'),
        property_tax_annual: z.number().nonnegative().optional(),
        property_tax_rate: z
          .number()
          .nonnegative()
          .optional()
          .describe('Annual % of home price'),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        pmi_rate: z
          .number()
          .nonnegative()
          .optional()
          .describe('Annual %, applied when LTV > 80%'),
      },
    },
    async (i) => {
      const m = calculateMortgage(i);
      // Project the canonical zillow-union breakdown back onto homes-mcp's
      // leaner contract: `ltv` as a 0..1 ratio (not the core's 0..100
      // percent), and the `monthly_total_piti` / `total_interest_over_term`
      // field names. `interest_rate` / `total_paid_over_loan` are dropped
      // (homes-mcp never surfaced them).
      return minifiedResult({
        home_price: m.home_price,
        down_payment: m.down_payment,
        loan_amount: m.loan_amount,
        ltv: m.ltv_percent / 100,
        monthly_principal_interest: m.monthly_principal_interest,
        monthly_property_tax: m.monthly_property_tax,
        monthly_insurance: m.monthly_insurance,
        monthly_hoa: m.monthly_hoa,
        monthly_pmi: m.monthly_pmi,
        monthly_total_piti: m.monthly_total,
        total_interest_over_term: m.total_interest_paid,
        loan_term_years: m.loan_term_years,
      });
    }
  );
}
