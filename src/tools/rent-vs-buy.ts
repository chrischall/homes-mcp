import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';

/**
 * Local-only rent-vs-buy projection. Same input/output contract as
 * `zillow_estimate_rent_vs_buy` so consumers can substitute it without
 * touching their downstream consumers.
 *
 * Cost model:
 *   - Buyer pays: down + closing + (PITI + maintenance) every year +
 *     loses sale proceeds at horizon (home value × (1 − selling rate)
 *     − remaining loan balance). Buyer's "lost opportunity cost"
 *     surfaces at horizon as the gain a renter would have made on the
 *     same starting capital (down + closing) invested at
 *     investment_return_rate.
 *   - Renter pays: rent (which grows at rent_growth_rate) every year.
 *     Their starting capital (= down + closing) keeps compounding.
 *
 * Break-even is the first year where cumulative_buy_cost <=
 * cumulative_rent_cost. If buying never wins within horizon, returns
 * null.
 */

export interface RentVsBuyInput {
  home_price: number;
  down_payment: number;
  interest_rate: number;
  monthly_rent: number;
  horizon_years?: number;
  loan_term_years?: number;
  property_tax_rate?: number;
  insurance_annual?: number;
  hoa_monthly?: number;
  closing_cost_rate?: number;
  selling_cost_rate?: number;
  maintenance_rate?: number;
  appreciation_rate?: number;
  rent_growth_rate?: number;
  investment_return_rate?: number;
}

export interface RentVsBuyResult {
  horizon_years: number;
  cumulative_buy_cost: number[];
  cumulative_rent_cost: number[];
  break_even_year: number | null;
  net_difference_at_horizon: number;
  inputs_used: {
    home_price: number;
    down_payment: number;
    interest_rate: number;
    monthly_rent: number;
    horizon_years: number;
    loan_term_years: number;
    property_tax_rate: number;
    insurance_annual: number;
    hoa_monthly: number;
    closing_cost_rate: number;
    selling_cost_rate: number;
    maintenance_rate: number;
    appreciation_rate: number;
    rent_growth_rate: number;
    investment_return_rate: number;
  };
}

function monthlyPI(loan: number, annualRate: number, years: number): number {
  if (loan <= 0) return 0;
  if (annualRate <= 0) return loan / (years * 12);
  const r = annualRate / 100 / 12;
  const n = years * 12;
  return (loan * r) / (1 - Math.pow(1 + r, -n));
}

function remainingLoanAfterYears(
  loan: number,
  annualRate: number,
  termYears: number,
  yearsElapsed: number
): number {
  if (loan <= 0) return 0;
  if (annualRate <= 0) {
    return Math.max(0, loan - (loan / (termYears * 12)) * (yearsElapsed * 12));
  }
  const r = annualRate / 100 / 12;
  const n = termYears * 12;
  const k = yearsElapsed * 12;
  return Math.max(
    0,
    (loan * (Math.pow(1 + r, n) - Math.pow(1 + r, k))) / (Math.pow(1 + r, n) - 1)
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateRentVsBuy(input: RentVsBuyInput): RentVsBuyResult {
  const horizon = input.horizon_years ?? 7;
  const term = input.loan_term_years ?? 30;
  const taxRate = (input.property_tax_rate ?? 1.1) / 100;
  const insuranceAnnual = input.insurance_annual ?? 0;
  const hoaMonthly = input.hoa_monthly ?? 0;
  const closingRate = (input.closing_cost_rate ?? 2.5) / 100;
  const sellingRate = (input.selling_cost_rate ?? 6.0) / 100;
  const maintRate = (input.maintenance_rate ?? 1.0) / 100;
  const apprRate = (input.appreciation_rate ?? 3.0) / 100;
  const rentGrow = (input.rent_growth_rate ?? 3.0) / 100;
  const invReturn = (input.investment_return_rate ?? 6.0) / 100;

  const loan = Math.max(0, input.home_price - input.down_payment);
  const piMonthly = monthlyPI(loan, input.interest_rate, term);
  const startingCapital = input.down_payment + input.home_price * closingRate;

  const buy: number[] = [];
  const rent: number[] = [];
  let homeValue = input.home_price;
  let monthlyRent = input.monthly_rent;
  let renterPool = startingCapital;
  let buyOutflow = startingCapital;
  let rentTotal = 0;

  for (let y = 1; y <= horizon; y++) {
    const annualPI = piMonthly * 12;
    const annualTax = homeValue * taxRate;
    const annualMaint = homeValue * maintRate;
    buyOutflow += annualPI + annualTax + insuranceAnnual + hoaMonthly * 12 + annualMaint;
    homeValue *= 1 + apprRate;
    renterPool *= 1 + invReturn;

    rentTotal += monthlyRent * 12;
    rent.push(rentTotal);

    if (y < horizon) {
      buy.push(buyOutflow);
    } else {
      const remainingLoanY = remainingLoanAfterYears(loan, input.interest_rate, term, y);
      const saleProceeds = homeValue * (1 - sellingRate) - remainingLoanY;
      const renterAdvantage = renterPool - startingCapital;
      buy.push(buyOutflow - saleProceeds + renterAdvantage);
    }
    monthlyRent *= 1 + rentGrow;
  }

  let breakEven: number | null = null;
  for (let i = 0; i < horizon; i++) {
    if (buy[i] <= rent[i]) {
      breakEven = i + 1;
      break;
    }
  }

  return {
    horizon_years: horizon,
    cumulative_buy_cost: buy.map(round2),
    cumulative_rent_cost: rent.map(round2),
    break_even_year: breakEven,
    net_difference_at_horizon: round2(rent[horizon - 1] - buy[horizon - 1]),
    inputs_used: {
      home_price: input.home_price,
      down_payment: input.down_payment,
      interest_rate: input.interest_rate,
      monthly_rent: input.monthly_rent,
      horizon_years: horizon,
      loan_term_years: term,
      property_tax_rate: input.property_tax_rate ?? 1.1,
      insurance_annual: insuranceAnnual,
      hoa_monthly: hoaMonthly,
      closing_cost_rate: input.closing_cost_rate ?? 2.5,
      selling_cost_rate: input.selling_cost_rate ?? 6.0,
      maintenance_rate: input.maintenance_rate ?? 1.0,
      appreciation_rate: input.appreciation_rate ?? 3.0,
      rent_growth_rate: input.rent_growth_rate ?? 3.0,
      investment_return_rate: input.investment_return_rate ?? 6.0,
    },
  };
}

export function registerRentVsBuyTools(server: McpServer): void {
  server.registerTool(
    'homes_estimate_rent_vs_buy',
    {
      title: 'Project cumulative buy-vs-rent cost over N years',
      description:
        'Project the cumulative cost of buying a home versus renting a comparable place over N years. Accounts for down payment, closing costs, monthly PITI, maintenance (~1%/yr default), appreciation (~3%/yr default), rent growth (~3%/yr default), and the opportunity cost of the down payment (renter invests it at investment_return_rate, default 6%/yr). Returns year-by-year cumulative costs, break-even year, and the net difference at horizon. No network — pure local math. Same math contract as zillow_estimate_rent_vs_buy. NOTE: caller must supply `monthly_rent` — homes.com does not publish rental estimates anywhere on its consumer site (no rent_zestimate analogue, no comparable-rentals endpoint). For a rent estimate to plug in here, use `zillow_get_property` (its `rent_zestimate` field) or `redfin_get_comparable_rentals`.',
      annotations: {
        title: 'Project cumulative buy-vs-rent cost over N years',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        home_price: z.number().positive(),
        down_payment: z.number().nonnegative(),
        interest_rate: z.number().nonnegative(),
        monthly_rent: z.number().nonnegative(),
        horizon_years: z.number().int().positive().optional(),
        loan_term_years: z.number().int().positive().optional(),
        property_tax_rate: z.number().nonnegative().optional(),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        closing_cost_rate: z.number().nonnegative().optional(),
        selling_cost_rate: z.number().nonnegative().optional(),
        maintenance_rate: z.number().nonnegative().optional(),
        appreciation_rate: z.number().optional(),
        rent_growth_rate: z.number().optional(),
        investment_return_rate: z.number().nonnegative().optional(),
      },
    },
    async (i) => textResult(estimateRentVsBuy(i as RentVsBuyInput))
  );
}
