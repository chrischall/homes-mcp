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

  it('pre-sale year-1 buy outflow covers down + closing + at least PITI*12', () => {
    // horizon=2 so cumulative_buy_cost[0] is the gross year-1 outflow
    // (sale proceeds only net out at the horizon year).
    const r = estimateRentVsBuy({
      home_price: 500000,
      down_payment: 100000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      horizon_years: 2,
      closing_cost_rate: 2.5,
    });
    // year 1 outflow >= down (100k) + closing (12.5k) + 12 months of P&I (~$30k)
    expect(r.cumulative_buy_cost[0]).toBeGreaterThan(100000 + 12000);
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
