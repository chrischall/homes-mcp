import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  calculateAffordability,
  type AffordabilityInput,
  type AffordabilityResult,
} from '@chrischall/realty-core';
import { minifiedResult } from '../mcp.js';

/**
 * Local-only affordability calculator. Solves for max home price under
 * the standard 28/36 DTI rule. The math is the canonical cohort helper
 * (`calculateAffordability` in `@chrischall/realty-core`, realty-mcp#1)
 * — every cohort MCP (zillow/redfin/compass/homes/onehome) shipped the
 * same closed-form 28/36 inversion. `computeAffordability` stays exported
 * under its homes-mcp name (same input/output shape) as a thin alias so
 * existing call sites + tests are unchanged.
 */
export function computeAffordability(
  input: AffordabilityInput
): AffordabilityResult {
  return calculateAffordability(input);
}

export function registerAffordabilityTools(server: McpServer): void {
  server.registerTool(
    'homes_calculate_affordability',
    {
      title: 'Calculate maximum home price you can afford',
      description:
        'Solve for the maximum home price you can afford under the standard 28/36 DTI rule. Inputs: monthly income, recurring monthly debts (car/student loans), down payment, interest rate, optional property-tax rate / insurance / HOA / loan term. Output: max home price, binding constraint (front-end vs back-end), and the PITI breakdown at that price. Identical math to zillow-mcp and redfin-mcp. No network — pure local math.',
      annotations: {
        title: 'Calculate maximum home price you can afford',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        monthly_income: z.number().positive(),
        monthly_debts: z.number().nonnegative().optional(),
        down_payment: z.number().nonnegative(),
        interest_rate: z.number().nonnegative(),
        loan_term_years: z.number().int().positive().optional(),
        property_tax_rate: z.number().nonnegative().optional(),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        front_end_dti: z.number().min(0).max(1).optional(),
        back_end_dti: z.number().min(0).max(1).optional(),
      },
    },
    async (i) => minifiedResult(computeAffordability(i))
  );
}
