/**
 * BZ-F014 — separate risk-aware review.
 *
 * Verification that matches the output contract, run as its OWN check with
 * tool evidence — not "the writer says this is correct." The arithmetic
 * cross-check re-computes stated totals with the deterministic calculator;
 * a mismatch is named, never smoothed over (QA-11).
 */

import { calculate } from "./calc";

export interface ReviewCheck {
  label: string;
  verdict: "verified" | "stated" | "warning";
  detail?: string;
}

const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;

function toCents(s: string): number {
  return Math.round(Number(s.replace(/,/g, "")) * 100);
}

/**
 * Cross-check line items against a stated total.
 * Looks for lines that END in an amount (line items), and a total/sum line.
 * Returns null when the draft has no checkable arithmetic (missing stays
 * missing — that is not a failure).
 */
export function checkArithmetic(text: string): ReviewCheck | null {
  const lines = String(text ?? "").split("\n");
  const itemCents: number[] = [];
  let totalCents: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const amounts = [...line.matchAll(AMOUNT)].map((m) => toCents(m[1]));
    if (!amounts.length) continue;
    if (/total|sum|amount due|balance due|grand total/i.test(line)) {
      totalCents = amounts[amounts.length - 1];
      continue;
    }
    // A line item: dash/bullet/numbered line ending with an amount.
    if (/^([-*•]|\d+[.)])\s/.test(line)) {
      itemCents.push(amounts[amounts.length - 1]);
    }
  }
  if (itemCents.length < 2 || totalCents == null) return null;
  const expr = itemCents.map((c) => (c / 100).toFixed(2)).join("+");
  const calc = calculate(expr);
  if (!calc.ok) {
    return { label: "Line items add up to the stated total", verdict: "warning", detail: `The calculator could not verify the sum: ${calc.error}` };
  }
  const sumCents = Math.round(calc.value * 100);
  if (sumCents === totalCents) {
    return { label: "Line items add up to the stated total", verdict: "verified", detail: `${itemCents.length} items recomputed by the calculator: ${expr} = ${calc.value}` };
  }
  return {
    label: "Line items add up to the stated total",
    verdict: "warning",
    detail: `The calculator gets $${(sumCents / 100).toFixed(2)} from the ${itemCents.length} line items, but the draft says $${(totalCents / 100).toFixed(2)}. Check the numbers before this goes out.`,
  };
}

/** Party presence: a letter/proposal should name who it's from and to. */
export function checkParties(text: string): ReviewCheck {
  const hasFrom = /\bfrom\b|^[-*•]?\s*(from|vendor|supplier|issued by)\s*[:\-]/im.test(text);
  const hasTo = /\bto\b|^[-*•]?\s*(to|bill to|billed to|customer|client)\s*[:\-]/im.test(text);
  if (hasFrom && hasTo) {
    return { label: "Both parties are named", verdict: "verified" };
  }
  return { label: "Both parties are named", verdict: "warning", detail: "I can't see a clear from AND to. A business letter names both sides." };
}

/** Regulated-domain posture: no fabricated legal threats / medical promises. */
export function checkRegulatedTone(text: string): ReviewCheck {
  if (/guaranteed (refund|outcome|win|approval)|we will sue|legal action will be taken against you|diagnos(e|is|ed) you|prescrib/i.test(text)) {
    return {
      label: "No fabricated legal threats or regulated promises",
      verdict: "warning",
      detail: "This draft makes a legal threat or regulated-domain promise the owner may not have stated. Review it line by line.",
    };
  }
  return { label: "No fabricated legal threats or regulated promises", verdict: "verified" };
}

/** The separate check: contract-matched, calculator-backed, named limits. */
export function reviewSeparately(text: string): ReviewCheck[] {
  const checks: ReviewCheck[] = [checkParties(text), checkRegulatedTone(text)];
  const arithmetic = checkArithmetic(text);
  if (arithmetic) checks.push(arithmetic);
  return checks;
}
