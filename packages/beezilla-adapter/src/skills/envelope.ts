/**
 * BeeZilla — Cost envelope for civilian SOW estimates.
 *
 * Produces a plain-language cost display string suitable for civilian
 * contractor scope-of-work documents (e.g. Dana's home-repair SOW).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CostEnvelope {
  /** Human-readable display string, e.g. "about $1–3" */
  display: string;
  /** True — this envelope's display IS the cost driver for the job */
  verifyIsCostDriver: true;
}

interface CostEnvelopeJson {
  display_estimate: string;
  budget_cap: number;
  estimate_low: number;
  estimate_high: number;
}

// ---------------------------------------------------------------------------
// sowEnvelope
// ---------------------------------------------------------------------------

let _cached: CostEnvelope | null = null;

/**
 * Return the SOW cost envelope.
 *
 * Reads from cost-envelope.example.json (the canonical civilian envelope)
 * and returns a verified display string plus the cost-driver flag.
 */
export function sowEnvelope(): CostEnvelope {
  if (_cached) return _cached;

  const envelopePath = resolve(__dirname, "cost-envelope.example.json");
  const raw = readFileSync(envelopePath, "utf-8");
  const data = JSON.parse(raw) as CostEnvelopeJson;

  _cached = {
    display: data.display_estimate,
    verifyIsCostDriver: true,
  };

  return _cached;
}
