/**
 * CR-9 phase E — the loan request read from a sentence.
 *
 * The rule: parse only what the person wrote. Every field that is absent is
 * reported, and the turn asks. A guessed rate under a credit memo is the worst
 * output this lane can produce, so the missing-field path is tested first.
 *
 * Run: npx tsx scripts/test-cre-loan.ts
 */
import { asksForDealMemo, parseLoanRequest } from "../src/lib/buzzy/cre/loan";

let passes = 0;
const failures: string[] = [];
function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    passes++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const AS_OF = "2026-11-19";

const full = parseLoanRequest(
  "Make a deal memo for Maple Court. The loan is $1,690,000 at 6.75%, 25-year amortization, 10-year term. Asking price $2,600,000.",
  AS_OF,
);
ok("a complete sentence parses", full.ok);
if (full.ok) {
  ok("amount is integer cents", full.loan.loanAmountCents === 169_000_000, String(full.loan.loanAmountCents));
  ok("rate is basis points", full.loan.noteRateBp === 675, String(full.loan.noteRateBp));
  ok("amortisation years", full.loan.amortizationYears === 25);
  ok("term years", full.loan.termYears === 10);
  ok("the asking price is not the loan amount", full.loan.askingPriceCents === 260_000_000, String(full.loan.askingPriceCents));
  ok("the analysis date is the caller's", full.loan.asOf === AS_OF);
}

const short = parseLoanRequest("deal memo for 1.69M at 6.75%, 25 yr amort, 10 yr term", AS_OF);
ok("a shorthand sentence parses", short.ok && short.loan.loanAmountCents === 169_000_000 && short.loan.noteRateBp === 675);

const missing = parseLoanRequest("Make a deal memo. Loan $1,690,000, 25-year amortization, 10-year term.", AS_OF);
ok("a missing rate is refused, not guessed", !missing.ok);
if (!missing.ok) {
  ok("the missing field is named", missing.missing.includes("rate"), missing.missing.join(","));
  ok("the question asks for it", /note rate/i.test(missing.question), missing.question);
  ok("the question does not claim a run started", !/started|making/i.test(missing.question));
}

const noAmount = parseLoanRequest("deal memo at 6.75%, 25-year amortization, 10-year term", AS_OF);
ok("a missing amount is refused", !noAmount.ok && noAmount.missing.includes("amount"));

ok("'deal memo' asks for one", asksForDealMemo("Make the deal memo now"));
ok("'credit memo' asks for one", asksForDealMemo("I need a credit memo for the lender"));
ok("talking about a loan is not a request", !asksForDealMemo("What interest rates are typical for retail?"));
ok("a rent roll question is not a request", !asksForDealMemo("Read this rent roll and tell me the vacancy"));

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`FAILED: ${failures.join(" | ")}`);
  process.exit(1);
}
