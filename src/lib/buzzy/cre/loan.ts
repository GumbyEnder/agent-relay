/**
 * CR-9 phase E — reading a loan request out of a sentence.
 *
 * The deal memo needs four numbers: amount, note rate, amortisation and term.
 * Phase F gives them a form; until then this module is how a plain sentence
 * starts a run ("the 1.69M loan at 6.75%, 25-year am, 10-year term"). It parses
 * ONLY what the person wrote: every field it cannot find is reported as missing
 * and the turn asks for it. A guessed rate is a fabricated memo.
 */

import { dollarsToCents, pctToBp } from "./math";

export interface LoanRequest {
  loanAmountCents: number;
  noteRateBp: number;
  amortizationYears: number;
  termYears: number;
  askingPriceCents: number | null;
  asOf: string;
  purpose?: string;
}

export type LoanParse =
  | { ok: true; loan: LoanRequest }
  | { ok: false; missing: Array<"amount" | "rate" | "amortization" | "term">; question: string };

/** "1,690,000" / "$1.69M" / "1.69 million" -> cents, or null. */
export function moneyFromText(raw: string): number | null {
  const m = raw.match(/\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(m|mm|million|k|thousand)?\b/i);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const dollars = unit === "m" || unit === "mm" || unit === "million" ? n * 1_000_000 : unit === "k" || unit === "thousand" ? n * 1_000 : n;
  return dollarsToCents(Math.round(dollars));
}

function numberBefore(text: string, pattern: RegExp): number | null {
  const m = text.match(pattern);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a loan request from prose. `asOf` is supplied by the caller (the
 * analysis date), never inferred from the sentence.
 */
export function parseLoanRequest(text: string, asOf: string): LoanParse {
  const t = text.replace(/\s+/g, " ");

  // Amount: prefer a figure explicitly attached to "loan"; otherwise the first
  // money figure in the sentence that is not the asking price.
  let amount: number | null = null;
  const loanClause = t.match(/loan[^.$]{0,40}?\$?\s?(\d[\d,]*(?:\.\d+)?\s*(?:m|mm|million|k|thousand)?)/i);
  if (loanClause) amount = moneyFromText(loanClause[1]!);
  if (amount === null) {
    // A dollar figure first; then a bare million/thousand shorthand ("1.69M").
    // A bare decimal is never money — "6.75%" must not become the loan amount.
    const dollar = t.match(/\$\s?\d[\d,]*(?:\.\d+)?\s*(?:m|mm|million|k|thousand)?/i);
    const unit = t.match(/\b(\d+(?:\.\d+)?)\s*(?:m|mm|million|k|thousand)\b/i);
    const picked = dollar && !/asking|price|value/i.test(t.slice(Math.max(0, (dollar.index ?? 0) - 24), dollar.index ?? 0))
      ? dollar[0]
      : unit
        ? unit[0]
        : null;
    if (picked) amount = moneyFromText(picked);
  }

  const rate = numberBefore(t, /(\d+(?:\.\d+)?)\s*%/);
  const amortization = numberBefore(t, /(\d{1,2})\s*[- ]?\s*(?:year|yr)s?\s*(?:amort|amortization|amortisation|am\b)/i);
  const term = numberBefore(t, /(\d{1,2})\s*[- ]?\s*(?:year|yr)s?\s*term/i);

  const missing: Array<"amount" | "rate" | "amortization" | "term"> = [];
  if (amount === null) missing.push("amount");
  if (rate === null) missing.push("rate");
  if (amortization === null) missing.push("amortization");
  if (term === null) missing.push("term");
  if (missing.length) {
    const ask: Record<string, string> = {
      amount: "the loan amount",
      rate: "the note rate",
      amortization: "the amortisation (years)",
      term: "the loan term (years)",
    };
    return {
      ok: false,
      missing,
      question: `I need ${missing.map((m) => ask[m]).join(", ")} before I can underwrite this.`,
    };
  }

  const asking = moneyFromText(
    (t.match(/(?:asking|price|value)[^.$]{0,40}?(\$\s?\d[\d,]*(?:\.\d+)?\s*(?:m|mm|million|k|thousand)?)/i) ?? [])[1] ?? "",
  );

  return {
    ok: true,
    loan: {
      loanAmountCents: amount!,
      noteRateBp: pctToBp(rate!),
      amortizationYears: Math.trunc(amortization!),
      termYears: Math.trunc(term!),
      askingPriceCents: asking,
      asOf,
      purpose: /refinanc/i.test(t) ? "refinance" : /acquisition|purchase|buy/i.test(t) ? "acquisition" : undefined,
    },
  };
}

/** True when the message is asking for a deal memo, not merely mentioning loans. */
export function asksForDealMemo(message: string): boolean {
  const t = String(message ?? "");
  return /\b(deal memo|credit memo|lender[- ]ready|loan memo|underwriting memo|memo for (?:the )?lender)\b/i.test(t);
}
