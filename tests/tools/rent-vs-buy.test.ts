import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  estimateRentVsBuy,
  registerRentVsBuyTools,
} from '../../src/tools/rent-vs-buy.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

describe('estimateRentVsBuy', () => {
  it('returns horizon-length cumulative arrays', () => {
    const r = estimateRentVsBuy({
      home_price: 500000,
      down_payment: 100000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 7,
    });
    expect(r.cumulative_buy_cost).toHaveLength(7);
    expect(r.cumulative_rent_cost).toHaveLength(7);
    expect(r.horizon_years).toBe(7);
  });

  it('break_even_year does not depend on the chosen horizon (chrischall/fleet-audit#129)', () => {
    const base = {
      home_price: 400000,
      down_payment: 80000,
      interest_rate: 6.5,
      monthly_rent: 2500,
    };
    const years = [7, 10, 15].map(
      (horizon_years) => estimateRentVsBuy({ ...base, horizon_years }).break_even_year,
    );
    expect(years[0]).not.toBeNull();
    expect(years[0]).toBeLessThan(7);
    expect(new Set(years).size).toBe(1);
  });

  it('cumulative_buy_cost is a continuous net series, with no drop at the horizon year', () => {
    const r7 = estimateRentVsBuy({
      home_price: 400000,
      down_payment: 80000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 7,
    });
    const r10 = estimateRentVsBuy({
      home_price: 400000,
      down_payment: 80000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 10,
    });
    // The first 7 years must be identical whatever the horizon.
    expect(r10.cumulative_buy_cost.slice(0, 7)).toEqual(r7.cumulative_buy_cost);
    expect(r10.cumulative_rent_cost.slice(0, 7)).toEqual(r7.cumulative_rent_cost);
  });

  it('stops charging P&I once the loan term ends (chrischall/fleet-audit#130)', () => {
    const r = estimateRentVsBuy({
      home_price: 400000,
      down_payment: 80000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      loan_term_years: 15,
      horizon_years: 30,
    });
    // Annual P&I on a $320k 15y loan at 6.5% is ~$33.4k. After payoff the
    // year-over-year growth in the buyer's net cost must not include it:
    // the step from year 16 to 17 is only tax + maintenance (~$17k at a
    // ~$640k home) minus appreciation equity gained.
    const step = r.cumulative_buy_cost[16] - r.cumulative_buy_cost[15];
    expect(step).toBeLessThan(20000);
    // And the step in the last loan year does include P&I.
    const loanStep = r.cumulative_buy_cost[14] - r.cumulative_buy_cost[13];
    expect(loanStep).toBeGreaterThan(step);
  });

  it('finds a finite break_even_year when buying eventually wins', () => {
    const r = estimateRentVsBuy({
      home_price: 500000,
      down_payment: 100000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 30,
    });
    expect(typeof r.break_even_year).toBe('number');
    expect(r.break_even_year as number).toBeGreaterThanOrEqual(1);
    expect(r.break_even_year as number).toBeLessThanOrEqual(30);
  });

  it('returns null break_even_year when renting wins for the whole horizon', () => {
    const r = estimateRentVsBuy({
      home_price: 5_000_000,
      down_payment: 1_000_000,
      interest_rate: 9.0,
      monthly_rent: 500, // very cheap rent → never break even
      horizon_years: 7,
      investment_return_rate: 10,
      appreciation_rate: 0,
    });
    expect(r.break_even_year).toBeNull();
  });

  it('net_difference_at_horizon = rent_cumulative - buy_cumulative at year H', () => {
    const r = estimateRentVsBuy({
      home_price: 500000,
      down_payment: 100000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 7,
    });
    const expected = r.cumulative_rent_cost[6] - r.cumulative_buy_cost[6];
    expect(r.net_difference_at_horizon).toBeCloseTo(expected, 0);
  });
});

describe('homes_estimate_rent_vs_buy tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  beforeAll(async () => {
    h = await createTestHarness((s) => registerRentVsBuyTools(s));
  });
  afterAll(async () => h?.close());

  it('round-trips through the tool', async () => {
    const p = parseToolResult<any>(
      await h.callTool('homes_estimate_rent_vs_buy', {
        home_price: 500000,
        down_payment: 100000,
        interest_rate: 6.5,
        monthly_rent: 2500,
        horizon_years: 5,
      })
    );
    expect(p.cumulative_buy_cost).toHaveLength(5);
    expect(p.cumulative_rent_cost).toHaveLength(5);
  });
});
