import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  calculateAffordability,
  registerAffordabilityTool,
  type AffordabilityInput,
  type AffordabilityResult,
} from "@chrischall/realty-core";
import { minifiedResult } from "../mcp.js";

/**
 * Local-only affordability calculator (28/36 DTI). The math, schema and
 * description are realty-core's shared registrar (fleet-audit#1090).
 * `computeAffordability` stays exported under its homes-mcp name as a
 * thin alias of `calculateAffordability`.
 */
export function computeAffordability(
  input: AffordabilityInput,
): AffordabilityResult {
  return calculateAffordability(input);
}

export function registerAffordabilityTools(server: McpServer): void {
  registerAffordabilityTool(server, {
    z,
    prefix: "homes",
    toResult: minifiedResult,
  });
}
