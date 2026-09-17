/**
 * BeeZilla — Civilian envelope fields.
 *
 * Reads cost-envelope.example.json and returns the plain-language fields
 * suitable for display to a civilian contractor (no model ids, no raw JSON).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape returned to the civilian-facing SOW display layer. */
export interface EnvelopeFields {
  estimate_low: number;
  estimate_high: number;
  display: string;
  noModelIds: true;
}

// ---------------------------------------------------------------------------
// envelopeFields
// ---------------------------------------------------------------------------

let _cached: EnvelopeFields | null = null;

/**
 * Return the civilian envelope fields.
 *
 * - `display` is the plain-language string (starts with "about $").
 * - `noModelIds` is always `true` — civilians never see model ids.
 */
export function envelopeFields(): EnvelopeFields {
  if (_cached) return _cached;

  const envelopePath = resolve(__dirname, "cost-envelope.example.json");
  const raw = readFileSync(envelopePath, "utf-8");
  const data = JSON.parse(raw) as {
    estimate_low: number;
    estimate_high: number;
    display_estimate: string;
  };

  _cached = {
    estimate_low: data.estimate_low,
    estimate_high: data.estimate_high,
    display: data.display_estimate,
    noModelIds: true,
  };

  return _cached;
}
