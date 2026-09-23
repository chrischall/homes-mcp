import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  estimateRentVsBuy as coreEstimateRentVsBuy,
  type RentVsBuyInput,
  type RentVsBuyInputsUsed,
} from "@chrischall/realty-core";
import { minifiedResult } from "../mcp.js";

export type { RentVsBuyInput };

/**
 * Local-only rent-vs-buy projection. The math is the canonical cohort
 * helper (`estimateRentVsBuy` in `@chrischall/realty-core`) — the same
 * model zillow_estimate_rent_vs_buy uses. homes-mcp keeps its original
 * output contract (parallel `cumulative_buy_cost[]` /
 * `cumulative_rent_cost[]` arrays, `net_difference_at_horizon`,
 * `inputs_used`, default horizon 7y), projected from the core's rows.
 *
 * Every year is the NET position if the buyer sold that year (cash out
 * minus equity-if-sold) versus the renter's net cost (rent minus the
 * gain on the invested down payment + closing costs), so the series is
 * continuous and `break_even_year` does not depend on the horizon.
 * P&I stops accruing once the loan is paid off.
 *
 * The local model this replaced only netted sale proceeds in the final
 * year and charged P&I past the loan term (chrischall/fleet-audit#129,
 * #130).
 */

const DEFAULT_HORIZON_YEARS = 7;

export interface RentVsBuyResult {
  horizon_years: number;
  cumulative_buy_cost: number[];
  cumulative_rent_cost: number[];
  break_even_year: number | null;
  net_difference_at_horizon: number;
  inputs_used: RentVsBuyInputsUsed;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateRentVsBuy(input: RentVsBuyInput): RentVsBuyResult {
  const core = coreEstimateRentVsBuy({
    ...input,
    horizon_years: input.horizon_years ?? DEFAULT_HORIZON_YEARS,
  });
  const buy = core.years.map((y) => y.cumulative_buy_cost);
  const rent = core.years.map((y) => y.cumulative_rent_cost);
  const last = core.horizon_years - 1;
  return {
    horizon_years: core.horizon_years,
    cumulative_buy_cost: buy,
    cumulative_rent_cost: rent,
    break_even_year: core.break_even_year,
    net_difference_at_horizon: round2(rent[last] - buy[last]),
    inputs_used: core.inputs,
  };
}

export function registerRentVsBuyTools(server: McpServer): void {
  server.registerTool(
    "homes_estimate_rent_vs_buy",
    {
      title: "Project cumulative buy-vs-rent cost over N years",
      description:
        "Project the cumulative cost of buying a home versus renting a comparable place over N years. Accounts for down payment, closing costs, monthly PITI, maintenance (~1%/yr default), appreciation (~3%/yr default), rent growth (~3%/yr default), and the opportunity cost of the down payment + closing costs (renter invests it at investment_return_rate, default 6%/yr). P&I stops once the loan term ends. Each year is the buyer's net position if they sold that year (cash out minus equity) versus the renter's net cost, so break-even year is independent of the horizon. Returns year-by-year cumulative net costs, break-even year, and the net difference at horizon (default horizon 7y). No network — pure local math. Same math contract as zillow_estimate_rent_vs_buy. NOTE: caller must supply `monthly_rent` — homes.com does not publish rental estimates anywhere on its consumer site (no rent_zestimate analogue, no comparable-rentals endpoint). For a rent estimate to plug in here, use `zillow_get_property` (its `rent_zestimate` field) or `redfin_get_comparable_rentals`.",
      annotations: {
        title: "Project cumulative buy-vs-rent cost over N years",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        home_price: z.number().positive(),
        down_payment: z.number().nonnegative(),
        interest_rate: z.number().nonnegative(),
        monthly_rent: z.number().positive(),
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
      }),
    },
    async (i) => minifiedResult(estimateRentVsBuy(i as RentVsBuyInput)),
  );
}
