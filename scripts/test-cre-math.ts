/**
 * CR-9 phase A — the arithmetic gate for the Lender-Ready Deal Memo.
 *
 * Every number below is asserted against the spec's §14 acceptance fixture
 * (`src/lib/buzzy/cre/fixtures/`), and every expectation is a figure the spec
 * itself states — not a figure this code produced and then blessed. A wrong
 * number in `cre/math.ts` poisons the model, the memo and the checks, so this
 * file runs before any model call exists.
 *
 * Two spec figures are corrected here rather than copied, and the corrections
 * are printed:
 *   - The stress ADS row in `expected_stress_table.csv` is rounded to whole
 *     dollars; the code asserts within $1 of it and prints the exact cents.
 *   - §14 says rollover concentration is "Demo Fitness ≈ 43% of base rent,
 *     inside the 10-yr term". 43% is Demo Fitness alone; ALL THREE leases
 *     expire before a 10-year term ends, so rollover-inside-term is 100%. The
 *     43% is the 24-month figure, and both are asserted separately.
 *
 * Run: npx tsx scripts/test-cre-math.ts
 */
import { readFileSync } from "node:fs";

import {
  amortizedDebtService,
  capRateBp,
  debtYieldBp,
  dscrX100,
  dollarsToCents,
  effectiveGrossIncomeCents,
  loanToValueBp,
  netOperatingIncomeCents,
  occupancyBp,
  replacementReservesCents,
} from "../src/lib/buzzy/cre/math";
import { parseRentRollCsv, rolloverWithinMonths, summariseRentRoll } from "../src/lib/buzzy/cre/rentRoll";
import { evaluateComps, parseCompsCsv, type CompRules } from "../src/lib/buzzy/cre/comps";
import { buildStressTable } from "../src/lib/buzzy/cre/stress";
import { parseAssumptions } from "../src/lib/buzzy/cre/assumptions";

const fixture = (name: string): string =>
  readFileSync(new URL(`../src/lib/buzzy/cre/fixtures/${name}`, import.meta.url), "utf8");

let passes = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    passes++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label: string, actual: unknown, want: unknown) {
  ok(label, actual === want, `got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
}

function near(label: string, actual: number, want: number, tolerance: number) {
  ok(label, Math.abs(actual - want) <= tolerance, `got ${actual}, want ${want} ±${tolerance}`);
}

function throws(label: string, fn: () => unknown, match: RegExp) {
  try {
    fn();
    ok(label, false, "did not throw");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ok(label, match.test(message), message);
  }
}

const AS_OF = "2026-11-19";

// ── Rent roll ───────────────────────────────────────────────────────
console.log("\nrent roll — the fixture package");
const rentRoll = parseRentRollCsv(fixture("rent_roll.csv"));
eq("four suites parsed", rentRoll.rows.length, 4);
eq("no parse issues", rentRoll.issues.length, 0);
const rr = summariseRentRoll(rentRoll.rows, { asOf: AS_OF, termYears: 10, issues: rentRoll.issues });
eq("total SF", rr.totalSf, 13_500);
eq("occupied SF", rr.occupiedSf, 11_000);
eq("vacant SF (Suite 130)", rr.vacantSf, 2_500);
eq("occupancy 81.48%", rr.occupancyBp, occupancyBp(11_000, 13_500));
eq("occupancy is 8148bp", rr.occupancyBp, 8148);
eq("in-place annual base rent $224,000", rr.annualBaseRentCents, dollarsToCents(224_000));
eq("vacant suites", JSON.stringify(rr.vacantSuites), JSON.stringify(["130"]));
eq("WALT 2.45 years", rr.waltYearsX100, 245);

const nearTerm = rolloverWithinMonths(rentRoll.rows, AS_OF, 24);
eq("24-month rollover: one lease", nearTerm.leases.length, 1);
eq("24-month rollover: Demo Fitness", nearTerm.leases[0]?.tenant, "Demo Fitness Inc. (fictional)");
eq("24-month rollover $96,000", nearTerm.cents, dollarsToCents(96_000));
eq("24-month rollover 42.86% of base rent", nearTerm.bp, 4286);

// The correction, not the spec's wording:
eq("10-year term rollover: all three leases", rr.rolloverInsideTerm.length, 3);
eq("10-year term rollover is 100% of base rent", rr.rolloverInsideTermBp, 10000);

// ── Assumptions ─────────────────────────────────────────────────────
console.log("\nassumptions — placeholders, converted once");
const assumptions = parseAssumptions(JSON.parse(fixture("assumptions.placeholder.json")));
eq("vacancy 5% = 500bp", assumptions.vacancyBp, 500);
eq("reserves $0.20/SF = 20 cents", assumptions.reservesCentsPerSf, 20);
eq("DSCR floor 1.25x = 125", assumptions.dscrMinX100, 125);
eq("LTV cap 65% = 6500bp", assumptions.ltvMaxBp, 6500);
eq("debt yield floor 9% = 900bp", assumptions.debtYieldMinBp, 900);
eq("flagged as placeholder", assumptions.placeholderOnly, true);
throws(
  "vacancy above 100% is refused",
  () => parseAssumptions({ ...JSON.parse(fixture("assumptions.placeholder.json")), vacancy_and_credit_loss_pct: 120 }),
  /vacancy/,
);

// ── Income and value ────────────────────────────────────────────────
console.log("\nincome, NOI and the asking-price ratios");
const egiCents = effectiveGrossIncomeCents({
  inPlaceRentCents: rr.annualBaseRentCents,
  reimbursementsCents: dollarsToCents(54_000),
  vacancyBp: assumptions.vacancyBp,
});
eq("EGI $264,100", egiCents, dollarsToCents(264_100));

const reservesCents = replacementReservesCents(rr.totalSf, assumptions.reservesCentsPerSf);
eq("replacement reserves $2,700", reservesCents, dollarsToCents(2_700));

const noiCents = netOperatingIncomeCents({
  egiCents,
  opexCents: dollarsToCents(78_000),
  reservesCents,
});
eq("NOI $183,400", noiCents, dollarsToCents(183_400));

const askingCents = dollarsToCents(2_600_000);
const loanCents = dollarsToCents(1_690_000);
eq("cap rate on ask 7.05%", capRateBp(noiCents, askingCents), 705);
eq("LTV 65.00%", loanToValueBp(loanCents, askingCents), 6500);
eq("debt yield 10.85%", debtYieldBp(noiCents, loanCents), 1085);

// ── Debt service ────────────────────────────────────────────────────
console.log("\ndebt service — rounded once, at the annual figure");
const expectedStress = fixture("expected_stress_table.csv")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.split(","));

const debt = amortizedDebtService({ principalCents: loanCents, noteRateBp: 675, amortizationYears: 25 });
eq("base ADS 140,116.86", debt.annualDebtServiceCents, 14_011_686);
eq("base monthly 11,676.41", debt.monthlyPaymentCents, 1_167_641);
eq("300 payments", debt.payments, 300);
for (const [index, row] of expectedStress.entries()) {
  const wantDollars = Number(row[2]);
  near(
    `ADS row ${index} agrees with the spec table within $1`,
    debtCentsFor(Number(row[1])) / 100,
    wantDollars,
    1,
  );
}
function debtCentsFor(ratePct: number): number {
  return amortizedDebtService({
    principalCents: loanCents,
    noteRateBp: Math.round(ratePct * 100),
    amortizationYears: 25,
  }).annualDebtServiceCents;
}
eq("+100bp ADS 153,180.67", debtCentsFor(7.75), 15_318_067);
eq("+200bp ADS 166,730.73", debtCentsFor(8.75), 16_673_073);
const zeroRate = amortizedDebtService({ principalCents: 25_000_000, noteRateBp: 0, amortizationYears: 25 });
eq("a zero-rate loan is principal / years", zeroRate.annualDebtServiceCents, 1_000_000);
eq("DSCR 1.31x", dscrX100(noiCents, 14_011_686), 131);

// ── Stress ──────────────────────────────────────────────────────────
console.log("\nstress table — three scenarios, all calculator");
const stress = buildStressTable({
  noiCents,
  loanCents,
  valueCents: askingCents,
  noteRateBp: 675,
  amortizationYears: 25,
  thresholds: {
    dscrMinX100: assumptions.dscrMinX100,
    ltvMaxBp: assumptions.ltvMaxBp,
    debtYieldMinBp: assumptions.debtYieldMinBp,
  },
  capRateExpansionBp: 0,
});
eq("three scenarios", stress.rows.length, 3);
eq("shifts 0/100/200", JSON.stringify(stress.rows.map((r) => r.rateShiftBp)), JSON.stringify([0, 100, 200]));
eq("DSCR 131/120/110", JSON.stringify(stress.rows.map((r) => r.dscrX100)), JSON.stringify([131, 120, 110]));
eq("LTV 65.00% in every scenario", JSON.stringify(stress.rows.map((r) => r.ltvBp)), JSON.stringify([6500, 6500, 6500]));
eq("debt yield 10.85% in every scenario", JSON.stringify(stress.rows.map((r) => r.debtYieldBp)), JSON.stringify([1085, 1085, 1085]));
eq(
  "base passes, +100 and +200 fail the 1.25x floor",
  JSON.stringify(stress.rows.map((r) => r.passesAll)),
  JSON.stringify([true, false, false]),
);
eq("every row is calculator-sourced", stress.rows.every((r) => r.source === "calculator"), true);
eq("first failure is +100bp", stress.firstFailureRateShiftBp, 100);
eq("whole table does not pass", stress.passesAll, false);
for (const [index, row] of expectedStress.entries()) {
  const want = row;
  near(`DSCR row ${index} vs spec ${want[4]}`, stress.rows[index].dscrX100 / 100, Number(want[4]), 0.01);
  near(`LTV row ${index} vs spec ${want[5]}`, stress.rows[index].ltvBp / 100, Number(want[5]), 0.01);
  near(`debt yield row ${index} vs spec ${want[6]}`, stress.rows[index].debtYieldBp / 100, Number(want[6]), 0.01);
}

// ── Comps ───────────────────────────────────────────────────────────
console.log("\ncomps — keep C1-C3, exclude C4-C7 for stated reasons");
const parsedComps = parseCompsCsv(fixture("comps.csv"));
eq("seven comps parsed", parsedComps.comps.length, 7);
eq("none rejected at parse time", parsedComps.rejected.length, 0);

const compRules: CompRules = {
  maxAgeMonths: 24,
  radiusMiles: 5,
  sizeBandPct: 25,
  samePropertyTypeRequired: true,
  minKeptComps: 3,
  excludeTransactionTypes: ["portfolio sale", "related-party transfer", "distressed", "sale-leaseback"],
  outlierRule: null,
};
const comps = evaluateComps({
  comps: parsedComps.comps,
  rules: compRules,
  subject: { buildingSf: rr.totalSf, propertyType: "retail strip", asOf: AS_OF },
  noiCents,
});
eq("kept C1, C2, C3", JSON.stringify(comps.kept.map((c) => c.compId)), JSON.stringify(["C1", "C2", "C3"]));
const reasonOf = (id: string) => comps.comps.find((c) => c.compId === id)?.exclusionReason;
eq("C4 excluded as a portfolio sale", reasonOf("C4"), "transaction_type");
eq("C5 excluded as older than 24 months", reasonOf("C5"), "older_than_max_age");
eq("C6 excluded as a different property type", reasonOf("C6"), "different_property_type");
eq("C7 excluded as related-party", reasonOf("C7"), "transaction_type");
eq("C4 also records the size failure", comps.comps.find((c) => c.compId === "C4")?.exclusionReasons.includes("outside_size_band"), true);
eq("every excluded comp carries a reason", comps.excluded.every((c) => c.exclusionReason !== null), true);
eq("every kept comp carries a source", comps.kept.every((c) => c.source !== ""), true);
eq("kept average $209.69/SF", comps.avgPricePerSfCents, 20_969);
near("indicated value $2,830,819", (comps.indicatedValueCents ?? 0) / 100, 2_830_819, 1);
eq("min-kept rule satisfied", comps.minKeptMet, true);
ok("radius rule reported as not applied", comps.notes.some((n) => /radius/.test(n)), comps.notes.join("; "));

// Too few comps: no invented value.
const thin = evaluateComps({
  comps: parsedComps.comps,
  rules: { ...compRules, minKeptComps: 4 },
  subject: { buildingSf: rr.totalSf, propertyType: "retail strip", asOf: AS_OF },
});
eq("two kept under a 4-comp floor", thin.keptCount, 3);
eq("floor not met", thin.minKeptMet, false);
eq("no indicated value when the floor is not met", thin.indicatedValueCents, null);

// A comp with no source never counts.
const unsourced = evaluateComps({
  comps: parsedComps.comps.map((c) => (c.compId === "C1" ? { ...c, source: "" } : c)),
  rules: compRules,
  subject: { buildingSf: rr.totalSf, propertyType: "retail strip", asOf: AS_OF },
});
eq("C1 without a source is excluded", unsourced.comps.find((c) => c.compId === "C1")?.exclusionReason, "missing_source");
eq("two kept after the unsourced comp drops out", unsourced.keptCount, 2);

// ── Fail-closed edges ───────────────────────────────────────────────
console.log("\nrefusals — a missing fact is never a zero");
throws("vacancy over 100% throws", () => effectiveGrossIncomeCents({ inPlaceRentCents: 1, reimbursementsCents: 0, vacancyBp: 12000 }), /vacancyBp/);
throws("a zero value cannot yield a cap rate", () => capRateBp(noiCents, 0), /denominator/);
throws(
  "a rent roll without a rent column is refused, not read as zero",
  () => parseRentRollCsv("suite,tenant,sf\n100,Example,2000\n"),
  /RENT_ROLL_HEADER missing base_rent_per_sf_yr/,
);
const missingLeaseEnd = parseRentRollCsv("suite,tenant,sf,base_rent_per_sf_yr\n100,Example,2000,28\n");
ok(
  "a rented suite with no lease end is reported as an issue",
  missingLeaseEnd.issues.some((i) => i.code === "rented_without_lease_end"),
  JSON.stringify(missingLeaseEnd.issues),
);
throws(
  "a comps file missing a source column is refused",
  () => parseCompsCsv("comp_id,name,sale_date,price_usd,building_sf,property_type,transaction_type\nC1,x,2026-01-01,1,1,retail,arm's length\n"),
  /COMPS_HEADER missing source/,
);

// ── Determinism ─────────────────────────────────────────────────────
console.log("\ndeterminism — same inputs, same integers");
const again = buildStressTable({
  noiCents,
  loanCents,
  valueCents: askingCents,
  noteRateBp: 675,
  amortizationYears: 25,
  thresholds: {
    dscrMinX100: assumptions.dscrMinX100,
    ltvMaxBp: assumptions.ltvMaxBp,
    debtYieldMinBp: assumptions.debtYieldMinBp,
  },
  capRateExpansionBp: 0,
});
eq("stress table is byte-identical on a second run", JSON.stringify(again), JSON.stringify(stress));
ok("every stress figure is an integer", stress.rows.every((r) =>
  [r.rateShiftBp, r.noteRateBp, r.annualDebtServiceCents, r.monthlyPaymentCents, r.dscrX100, r.ltvBp, r.debtYieldBp]
    .every((n) => Number.isInteger(n)),
));

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`failed: ${failures.join(" | ")}`);
  process.exit(1);
}
