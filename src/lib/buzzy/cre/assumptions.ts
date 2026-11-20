/**
 * CR-9 — the author's assumptions, as this code sees them.
 *
 * In production these values come out of the sealed half (`semantic.cre.
 * underwriting`, `semantic.cre.stress`): the author replaces every placeholder
 * in the template. The JSON parser here exists for the acceptance fixture and
 * for tests, so that the placeholder set is one file rather than constants
 * scattered through the code.
 *
 * Placeholders are marked as such. `placeholderOnly` is true when the source
 * note says PLACEHOLDER — the memo prints "PLACEHOLDER ASSUMPTIONS" in its
 * sources section on that basis, so a test run can never be mistaken for a
 * real underwriting standard.
 */

import type { Bp, Cents, X100 } from "./math";
import { assertInt, dollarsToCents, pctToBp, xToX100 } from "./math";

export interface CreAssumptions {
  vacancyBp: Bp;
  reservesCentsPerSf: Cents;
  dscrMinX100: X100;
  ltvMaxBp: Bp;
  debtYieldMinBp: Bp;
  /** The author's note, carried through to the memo's sources section. */
  note: string;
  /** True when the note says PLACEHOLDER — a test set, not a standard. */
  placeholderOnly: boolean;
}

function num(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`ASSUMPTIONS ${key} must be a number, got ${JSON.stringify(v)}`);
  }
  return v;
}

export function parseAssumptions(raw: unknown): CreAssumptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ASSUMPTIONS must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const note = typeof obj._note === "string" ? obj._note : "";
  const vacancyBp = pctToBp(num(obj, "vacancy_and_credit_loss_pct"));
  if (vacancyBp < 0 || vacancyBp > 10000) throw new Error(`ASSUMPTIONS vacancy ${vacancyBp}bp is outside 0..10000`);

  const reserves = num(obj, "replacement_reserves_usd_per_sf");
  if (reserves < 0) throw new Error("ASSUMPTIONS reserves cannot be negative");

  const ltvMaxBp = pctToBp(num(obj, "ltv_max_pct"));
  if (ltvMaxBp <= 0 || ltvMaxBp > 10000) throw new Error(`ASSUMPTIONS ltv_max_pct ${ltvMaxBp}bp is outside 0..100%`);

  const debtYieldMinBp = pctToBp(num(obj, "debt_yield_min_pct"));
  const dscrMinX100 = xToX100(num(obj, "dscr_min_x"));
  if (dscrMinX100 <= 0) throw new Error("ASSUMPTIONS dscr_min_x must be greater than zero");

  return {
    vacancyBp,
    reservesCentsPerSf: assertInt("reservesCentsPerSf", dollarsToCents(reserves)),
    dscrMinX100,
    ltvMaxBp,
    debtYieldMinBp,
    note,
    placeholderOnly: /placeholder/i.test(note),
  };
}
