/**
 * CR-9 — the rate stress table.
 *
 * Three scenarios on the note rate (base, +100bp, +200bp), the same loan, the
 * same NOI. Each row is computed here, in integers, from the debt service and
 * the value — never typed by a model. That is what check C28 is about: three
 * rows, all `source: "calculator"`, shifts 0 / 100 / 200.
 *
 * Thresholds arrive from the sealed half (`cre.stress.dscr_min_x100`,
 * `ltv_max_bp`, `debt_yield_min_bp`) and are applied here only to produce the
 * pass/fail the memo prints. The numbers themselves are the author's; the
 * placeholder set in the fixtures is not advice.
 *
 * A negative or zero NOI is allowed through: a deal that does not cover its
 * debt is a finding, and DSCR below 1.00 must show as such rather than being
 * clamped away.
 */

import type { Bp, Cents, X100 } from "./math";
import {
  amortizedDebtService,
  assertInt,
  capRateBp,
  dscrX100,
  debtYieldBp,
  loanToValueBp,
} from "./math";

export interface StressThresholds {
  dscrMinX100: X100;
  ltvMaxBp: Bp;
  debtYieldMinBp: Bp;
}

export interface StressInput {
  noiCents: Cents;
  loanCents: Cents;
  /** Value used for LTV. Normally the asking price or the indicated value. */
  valueCents: Cents;
  noteRateBp: Bp;
  amortizationYears: number;
  /** 0, 100, 200 by default; kept as an input so the sealed half decides. */
  rateShiftsBp?: Bp[];
  thresholds: StressThresholds;
  /**
   * Cap-rate expansion per 100bp of rate, bp. 0 / null = hold value constant.
   * When set, `baseCapRateBp` is required: the value is re-derived at
   * (base cap + expansion) on each row.
   */
  capRateExpansionBp?: Bp | null;
  baseCapRateBp?: Bp;
}

export interface StressRow {
  /** 0, 100, 200. */
  rateShiftBp: Bp;
  noteRateBp: Bp;
  annualDebtServiceCents: Cents;
  monthlyPaymentCents: Cents;
  noiCents: Cents;
  valueCents: Cents;
  dscrX100: X100;
  ltvBp: Bp;
  debtYieldBp: Bp;
  passDscr: boolean;
  passLtv: boolean;
  passDebtYield: boolean;
  passesAll: boolean;
  source: "calculator";
}

export interface StressTable {
  rows: StressRow[];
  thresholds: StressThresholds;
  /** True when every row fails nothing — the memo's one-line verdict. */
  passesAll: boolean;
  /** The first scenario that fails, for the memo's headline; null when all pass. */
  firstFailureRateShiftBp: Bp | null;
  notes: string[];
}

const DEFAULT_SHIFTS: Bp[] = [0, 100, 200];

export function buildStressTable(input: StressInput): StressTable {
  const noi = assertInt("noiCents", input.noiCents);
  const loan = assertInt("loanCents", input.loanCents);
  const value = assertInt("valueCents", input.valueCents);
  if (loan <= 0) throw new RangeError("loanCents must be greater than zero");
  if (value <= 0) throw new RangeError("valueCents must be greater than zero");

  const shifts = input.rateShiftsBp ?? DEFAULT_SHIFTS;
  const notes: string[] = [];
  const expansion = input.capRateExpansionBp ?? 0;
  if (expansion !== 0) {
    if (input.baseCapRateBp === undefined) {
      throw new RangeError("capRateExpansionBp needs baseCapRateBp to re-derive value");
    }
    assertInt("baseCapRateBp", input.baseCapRateBp);
  }

  const rows: StressRow[] = shifts.map((shift) => {
    assertInt("rateShiftBp", shift);
    const noteRateBp = assertInt("noteRateBp", input.noteRateBp + shift);
    if (noteRateBp < 0) throw new RangeError(`note rate went negative at shift ${shift}bp`);

    const debt = amortizedDebtService({
      principalCents: loan,
      noteRateBp,
      amortizationYears: input.amortizationYears,
    });

    // Optional cap-rate expansion: value falls as the rate rises, which hurts LTV.
    let rowValue = value;
    if (expansion !== 0 && input.baseCapRateBp !== undefined) {
      const cap = input.baseCapRateBp + Math.round((expansion * shift) / 100);
      if (cap <= 0) throw new RangeError(`expanded cap rate is not positive at shift ${shift}bp`);
      rowValue = Math.round((noi * 10000) / cap);
      if (rowValue <= 0) throw new RangeError(`re-derived value is not positive at shift ${shift}bp`);
    }

    const dscr = dscrX100(noi, debt.annualDebtServiceCents);
    const ltv = loanToValueBp(loan, rowValue);
    const debtYield = debtYieldBp(noi, loan);

    const passDscr = dscr >= input.thresholds.dscrMinX100;
    const passLtv = ltv <= input.thresholds.ltvMaxBp;
    const passDebtYield = debtYield >= input.thresholds.debtYieldMinBp;

    return {
      rateShiftBp: shift,
      noteRateBp,
      annualDebtServiceCents: debt.annualDebtServiceCents,
      monthlyPaymentCents: debt.monthlyPaymentCents,
      noiCents: noi,
      valueCents: rowValue,
      dscrX100: dscr,
      ltvBp: ltv,
      debtYieldBp: debtYield,
      passDscr,
      passLtv,
      passDebtYield,
      passesAll: passDscr && passLtv && passDebtYield,
      source: "calculator",
    };
  });

  if (expansion === 0) {
    notes.push("value held constant across scenarios (cap-rate expansion is 0)");
  }

  const failure = rows.find((r) => !r.passesAll) ?? null;
  return {
    rows,
    thresholds: input.thresholds,
    passesAll: rows.every((r) => r.passesAll),
    firstFailureRateShiftBp: failure ? failure.rateShiftBp : null,
    notes,
  };
}

/** Implied cap rate on the indicated value — the memo's cross-check line. */
export function indicatedCapRateBp(noiCents: Cents, valueCents: Cents): Bp {
  return capRateBp(noiCents, valueCents);
}
