import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerMortgageTool } from "@chrischall/realty-core";
import { minifiedResult } from "../mcp.js";

/**
 * `homes_calculate_mortgage` — local-only PITI calculator. Schema,
 * description, math and the lean output projection (`ltv` as a 0..1
 * ratio, `monthly_total_piti`, `total_interest_over_term`, no
 * `interest_rate` echo) all live in realty-core's shared registrar
 * (fleet-audit#1090); `loan_term_years` is capped at
 * `MAX_LOAN_TERM_YEARS` there.
 */
export function registerMortgageTools(server: McpServer): void {
  registerMortgageTool(server, {
    z,
    prefix: "homes",
    shape: "lean",
    toResult: minifiedResult,
  });
}
