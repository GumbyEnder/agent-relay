/**
 * BeeZilla — Tier breakdown (civilian-facing cost envelope).
 *
 * Reads cost-envelope.example.json and returns the tier_breakdown as a
 * plain-Record<string,string> where every value is a civilian string
 * containing "about" or "pennies" — never a model id.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Load the envelope once
// ---------------------------------------------------------------------------

let _cached: Record<string, string> | null = null;

/**
 * Return the tier_breakdown from the cost-envelope example JSON.
 *
 * Values are civilian strings: "pennies", "about $0.50–1", etc.
 * No model ids are ever exposed.
 */
export function tierBreakdown(): Record<string, string> {
  if (_cached) return _cached;

  const envelopePath = resolve(__dirname, "cost-envelope.example.json");
  const raw = readFileSync(envelopePath, "utf-8");
  const data = JSON.parse(raw) as { tier_breakdown: Record<string, string> };

  _cached = data.tier_breakdown;
  return _cached;
}
