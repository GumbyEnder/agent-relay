/**
 * CR-9 — commercial real-estate arithmetic, in integers.
 *
 * Conventions, the same ones the manifest and the checks use:
 *   money        cents            (integer)
 *   percentages  basis points     (integer; 1% = 100bp, 7.05% = 705bp)
 *   ratios       x100             (integer; 1.31x = 131)
 *   area         square feet      (integer)
 *
 * Nothing here reads a file, calls a model or knows about a route. A wrong
 * number in this file poisons every downstream step of the deal memo, so the
 * module is pure, total for valid inputs, and loud for invalid ones: every
 * helper throws a RangeError rather than returning NaN, Infinity or a
 * plausible-looking zero. `undefined` from a missing input stays missing —
 * a missing rent is never treated as a rent of zero (see rentRoll.ts).
 *
 * ROUND-ONCE, AT THE END. A monthly payment rounded to the cent before
 * multiplying by 12 loses money: on the acceptance fixture that reads
 * 140,116.80 instead of the correct 140,116.86. So the annual debt service is
 * the only rounded figure and the monthly payment — the one number the memo
 * might also print — is derived back from it as `ads / 12` with its own
 * documented rounding (roundMonthly: true).
 */

export type Cents = number;
export type Bp = number;
export type X100 = number;

/** A finite integer. Everything in this module passes through here first. */
export function assertInt(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be a finite integer, got ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} is outside the safe integer range: ${String(value)}`);
  }
  return value;
}

/** Dollars (already a number, e.g. from a JSON file) to cents. Rounds once. */
export function dollarsToCents(dollars: number): Cents {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) {
    throw new RangeError(`dollars must be a finite number, got ${String(dollars)}`);
  }
  return assertInt("cents", Math.round(dollars * 100));
}

export function pctToBp(pct: number): Bp {
  if (typeof pct !== "number" || !Number.isFinite(pct)) {
    throw new RangeError(`percentage must be a finite number, got ${String(pct)}`);
  }
  return assertInt("bp", Math.round(pct * 100));
}

export function xToX100(x: number): X100 {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new RangeError(`ratio must be a finite number, got ${String(x)}`);
  }
  return assertInt("x100", Math.round(x * 100));
}

/** 1.31x — the form the checks and the stress table print. */
export function formatX100(x100: X100): string {
  return (assertInt("x100", x100) / 100).toFixed(2);
}

/** 705bp — the form the memo prints (2 decimal places of a percentage). */
export function formatBp(bp: Bp): string {
  return (assertInt("bp", bp) / 100).toFixed(2);
}

export function formatCents(cents: Cents): string {
  const c = assertInt("cents", cents);
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function nonNegative(name: string, value: number): number {
  assertInt(name, value);
  if (value < 0) throw new RangeError(`${name} cannot be negative, got ${value}`);
  return value;
}

// ── Occupancy ───────────────────────────────────────────────────────

export function occupancyBp(occupiedSf: number, totalSf: number): Bp {
  nonNegative("occupiedSf", occupiedSf);
  assertInt("totalSf", totalSf);
  if (totalSf <= 0) throw new RangeError("totalSf must be greater than zero");
  if (occupiedSf > totalSf) throw new RangeError(`occupiedSf ${occupiedSf} exceeds totalSf ${totalSf}`);
  return Math.round((occupiedSf * 10000) / totalSf);
}

// ── Income ──────────────────────────────────────────────────────────

export interface EgiInput {
  /** In-place annual base rent, cents. */
  inPlaceRentCents: Cents;
  /** Reimbursements actually collected, cents. */
  reimbursementsCents: Cents;
  /** Vacancy and credit loss, bp. 500 = 5%. */
  vacancyBp: Bp;
}

/**
 * EGI = (in-place rent + reimbursements) x (1 - vacancy).
 *
 * The vacancy haircut is applied to the reimbursements too, because a vacant
 * suite pays no rent and no CAM — treating reimbursements as vacancy-free
 * overstates income by exactly the vacant share.
 */
export function effectiveGrossIncomeCents(input: EgiInput): Cents {
  const rent = nonNegative("inPlaceRentCents", input.inPlaceRentCents);
  const reimb = nonNegative("reimbursementsCents", input.reimbursementsCents);
  const vacancy = nonNegative("vacancyBp", input.vacancyBp);
  if (vacancy > 10000) throw new RangeError(`vacancyBp must be 0..10000, got ${vacancy}`);
  return Math.round(((rent + reimb) * (10000 - vacancy)) / 10000);
}

/** Reserves = SF x cents per SF. Integer in, integer out, no float drift. */
export function replacementReservesCents(buildingSf: number, centsPerSf: Cents): Cents {
  nonNegative("buildingSf", buildingSf);
  nonNegative("centsPerSf", centsPerSf);
  return buildingSf * centsPerSf;
}

export interface NoiInput {
  egiCents: Cents;
  opexCents: Cents;
  reservesCents: Cents;
}

/** NOI = EGI - opex - reserves. May legitimately be negative; that is a finding. */
export function netOperatingIncomeCents(input: NoiInput): Cents {
  const egi = nonNegative("egiCents", input.egiCents);
  const opex = nonNegative("opexCents", input.opexCents);
  const reserves = nonNegative("reservesCents", input.reservesCents);
  return assertInt("noiCents", egi - opex - reserves);
}

// ── Ratios ──────────────────────────────────────────────────────────

function ratioBp(numerator: Cents, denominator: Cents, what: string): Bp {
  assertInt("numerator", numerator);
  assertInt("denominator", denominator);
  if (denominator <= 0) throw new RangeError(`${what}: denominator must be greater than zero`);
  return Math.round((numerator * 10000) / denominator);
}

/** Cap rate = NOI / value, bp. */
export function capRateBp(noiCents: Cents, valueCents: Cents): Bp {
  return ratioBp(noiCents, valueCents, "cap rate");
}

/** LTV = loan / value, bp. 6500 = 65.00%. */
export function loanToValueBp(loanCents: Cents, valueCents: Cents): Bp {
  return ratioBp(loanCents, valueCents, "loan to value");
}

/** Debt yield = NOI / loan, bp. */
export function debtYieldBp(noiCents: Cents, loanCents: Cents): Bp {
  return ratioBp(noiCents, loanCents, "debt yield");
}

/** DSCR = NOI / annual debt service, x100. 131 = 1.31x. */
export function dscrX100(noiCents: Cents, annualDebtServiceCents: Cents): X100 {
  assertInt("noiCents", noiCents);
  assertInt("annualDebtServiceCents", annualDebtServiceCents);
  if (annualDebtServiceCents <= 0) throw new RangeError("annual debt service must be greater than zero");
  return assertInt("dscrX100", Math.round((noiCents * 100) / annualDebtServiceCents));
}

// ── Debt service ────────────────────────────────────────────────────

export interface AmortizationInput {
  principalCents: Cents;
  /** Base note rate, bp. 675 = 6.75%. */
  noteRateBp: Bp;
  amortizationYears: number;
}

export interface DebtService {
  /** The figure the memo and the stress table print: rounded once, from the exact payment. */
  annualDebtServiceCents: Cents;
  /** Derived back from the annual figure so the memo's monthly and annual rows agree. */
  monthlyPaymentCents: Cents;
  payments: number;
}

/**
 * Level-payment amortization, annual debt service for one year.
 *
 *   r = noteRateBp / 10000 / 12
 *   n = amortizationYears * 12
 *   pmt = P * r / (1 - (1 + r)^-n)
 *   ADS = round(pmt * 12)          <- the only rounding
 *
 * A zero-rate loan is principal / years, exactly.
 */
export function amortizedDebtService(input: AmortizationInput): DebtService {
  const principal = nonNegative("principalCents", input.principalCents);
  const noteRateBp = nonNegative("noteRateBp", input.noteRateBp);
  const years = assertInt("amortizationYears", input.amortizationYears);
  if (years < 1 || years > 50) throw new RangeError(`amortizationYears must be 1..50, got ${years}`);

  const payments = years * 12;
  let annual: number;
  if (noteRateBp === 0) {
    annual = Math.round(principal / years);
  } else {
    const r = noteRateBp / 10000 / 12;
    const pmt = (principal * r) / (1 - Math.pow(1 + r, -payments));
    annual = Math.round(pmt * 12);
  }
  const annualDebtServiceCents = assertInt("annualDebtServiceCents", annual);
  return {
    annualDebtServiceCents,
    monthlyPaymentCents: Math.round(annualDebtServiceCents / 12),
    payments,
  };
}

export function amortizedAnnualDebtServiceCents(input: AmortizationInput): Cents {
  return amortizedDebtService(input).annualDebtServiceCents;
}
