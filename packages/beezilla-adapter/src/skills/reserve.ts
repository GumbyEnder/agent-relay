/**
 * BeeZilla — Envelope reserve, budget cap, and cap status.
 *
 * Reads cost-envelope.example.json and returns the reserve, cap, and
 * cap-status values used to enforce spending limits.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Load the envelope once
// ---------------------------------------------------------------------------

let _cached: { verificationReserve: number; budgetCap: number; capStatus: string } | null = null;

/**
 * Return the reserve / cap / cap-status tuple from cost-envelope.example.json.
 *
 * - `verificationReserve` is the amount held back for verification checks.
 * - `budgetCap` is the maximum spend before a hard stop.
 * - `capStatus` is always `"hard_stop"` for civilian envelopes.
 */
export function reserveEnvelope(): {
  verificationReserve: number;
  budgetCap: number;
  capStatus: string;
} {
  if (_cached) return _cached;

  const envelopePath = resolve(__dirname, "cost-envelope.example.json");
  const raw = readFileSync(envelopePath, "utf-8");
  const data = JSON.parse(raw) as {
    verification_reserve: number;
    budget_cap: number;
    cap_status: string;
  };

  _cached = {
    verificationReserve: data.verification_reserve,
    budgetCap: data.budget_cap,
    capStatus: data.cap_status,
  };

  return _cached;
}

/**
 * Return the verification reserve amount (e.g. 0.5).
 */
export function verificationReserve(): number {
  return reserveEnvelope().verificationReserve;
}

/**
 * Return the budget cap (e.g. 3.5).
 */
export function budgetCap(): number {
  return reserveEnvelope().budgetCap;
}

/**
 * Return the cap status — always `"hard_stop"` for civilian envelopes.
 */
export function capStatus(): string {
  return reserveEnvelope().capStatus;
}
