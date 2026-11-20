/**
 * CR-9 phase D acceptance tests — the deal-memo check family (C25–C29, C38–C42).
 *
 * The spec's mutation list, T3–T8, is the contract: each wrong Draft must fail
 * with EXACTLY its named code and nothing else. "Exactly" matters more than
 * "includes": a rule that drags a second code along makes a verdict unreadable
 * to the person holding the memo, and it hides which rule actually did the work.
 *
 * Also proven here:
 *  - the fail-closed direction: an empty domain must fail, not pass, because
 *    `noneOf` on a missing collection returns true (the VM trap);
 *  - C39 reads the renderer's page count, so a 3-page memo cannot pass by
 *    carrying a 2 in the draft;
 *  - the sealed artifact gives the same verdict as the in-memory rules;
 *  - the compiled program carries no author threshold (DSCR/LTV numbers), since
 *    checks.wasm is published.
 *
 * Run: npx tsx scripts/test-cre-checks.ts
 */
import {
  RECIPE_RULES, compileRecipeChecks, evaluateDraft, evaluateRecipeChecks, loadRules,
  type Draft,
} from "../src/lib/recipe-checks";

const j = (v: unknown) => JSON.stringify(v);
const assert = {
  equal(a: unknown, b: unknown, msg = "equal"): void {
    if (j(a) !== j(b)) throw new Error(`${msg}: ${j(a)} !== ${j(b)}`);
  },
  ok(cond: unknown, msg = "expected truthy"): void {
    if (!cond) throw new Error(msg);
  },
};

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

const RULES = RECIPE_RULES["cre-deal-memo"];
const SALT = new Uint8Array(8);
const WASM = compileRecipeChecks("cre-deal-memo", { salt: SALT }).wasm;

/** The clean Draft the runner (phase E) is expected to produce for the fixture. */
function clean(): Draft {
  return {
    version: 1,
    recipeId: "cre-deal-memo",
    sections: [{
      id: "summary",
      title: "Summary",
      body: "Maple Court Retail Center (fictional), 13,500 SF retail strip. NOI $183,400. " +
        "Prepared with AI from your documents. Not financial or legal advice.",
    }],
    claims: [{ id: "c1", text: "Three of the four suites are leased (81%).", sourceId: "listing" }],
    values: [
      { id: "egi", kind: "money", raw: "264100.00", normalised: 26410000, source: "calculator" },
      { id: "noi", kind: "money", raw: "183400.00", normalised: 18340000, source: "calculator" },
      { id: "ask", kind: "money", raw: "2600000.00", normalised: 260000000, source: "source", sourceId: "listing" },
    ],
    domain: {
      comps: [
        { id: "C1", sourceId: "comps", excluded: false, exclusionReason: null },
        { id: "C2", sourceId: "comps", excluded: false, exclusionReason: null },
        { id: "C3", sourceId: "comps", excluded: false, exclusionReason: null },
        { id: "C4", sourceId: "comps", excluded: true, exclusionReason: "portfolio_sale" },
        { id: "C5", sourceId: "comps", excluded: true, exclusionReason: "too_old" },
        { id: "C6", sourceId: "comps", excluded: true, exclusionReason: "property_type" },
        { id: "C7", sourceId: "comps", excluded: true, exclusionReason: "related_party" },
      ],
      stress: [
        { id: "base", rateShiftBp: 0, noteRateBp: 675, dscrX100: 131, ltvBp: 6500, debtYieldBp: 1085, source: "calculator" },
        { id: "bp100", rateShiftBp: 100, noteRateBp: 775, dscrX100: 120, ltvBp: 6500, debtYieldBp: 1085, source: "calculator" },
        { id: "bp200", rateShiftBp: 200, noteRateBp: 875, dscrX100: 110, ltvBp: 6500, debtYieldBp: 1085, source: "calculator" },
      ],
      reconciliation: { ok: true, checked: 12, mismatches: 0 },
      redFlags: [
        { id: "co-tenancy", category: "lease", sourceId: "listing", severity: "medium" },
        { id: "rofr", category: "lease", sourceId: "listing", severity: "medium" },
        { id: "lien", category: "title", sourceId: "listing", severity: "high" },
      ],
      limits: { pageCount: 2, maxPages: 2 },
    },
  };
}

/** Evaluate a mutated copy: both the in-memory rules and the sealed artifact. */
function verdict(mutate: (d: Draft) => void) {
  const draft = clean();
  mutate(draft);
  const direct = evaluateDraft(draft, RULES);
  const sealed = evaluateRecipeChecks(WASM, draft);
  assert.equal(
    { ok: sealed.ok, codes: sealed.codes, warnings: sealed.warnings },
    { ok: direct.ok, codes: direct.codes, warnings: direct.warnings },
    "in-memory and sealed verdicts disagree",
  );
  return direct;
}

/** Fail with exactly one code — no collateral damage from another rule. */
function failsOnly(code: string, mutate: (d: Draft) => void): void {
  const r = verdict(mutate);
  assert.equal(r.ok, false, `${code}: draft should fail`);
  assert.equal(r.codes, [code], `${code}: expected only ${code}`);
}

console.log("\nCR-9 phase D — deal-memo check family\n");

ok("the family is registered with 10 rules", () => {
  assert.equal(RULES.length, 10);
  assert.equal(
    RULES.map((r) => r.code).join(","),
    "C25,C26,C27,C28,C29,C38,C39,C40,C41,C42",
  );
});

ok("the clean fixture passes with no codes and no warnings", () => {
  const r = verdict(() => {});
  assert.equal(r.ok, true, `clean draft failed: ${r.codes.join(",")}`);
  assert.equal(r.codes, []);
  assert.equal(r.warnings, []);
});

ok("T3 invented number (money typed) fails C25 only", () => {
  failsOnly("C25", (d) => { d.values![1].source = "typed"; });
});

ok("T4 unsourced comparable fails C26 only", () => {
  failsOnly("C26", (d) => { d.domain!.comps![2].sourceId = null; });
});

ok("T5 silent exclusion (no reason code) fails C27 only", () => {
  failsOnly("C27", (d) => { d.domain!.comps![3].exclusionReason = null; });
});

ok("T6 missing +200bp scenario fails C28 only", () => {
  failsOnly("C28", (d) => { d.domain!.stress = d.domain!.stress!.filter((s) => s.rateShiftBp !== 200); });
});

ok("T7 reconciliation mismatch fails C29 only", () => {
  failsOnly("C29", (d) => { d.domain!.reconciliation = { ok: false, checked: 12, mismatches: 1 }; });
});

ok("T8 'will be approved' fails C38 only", () => {
  failsOnly("C38", (d) => {
    d.sections!.push({ id: "s2", title: "Outlook", body: "On these numbers the loan will be approved." });
  });
});

ok("typed (not computed) stress row fails C28 only", () => {
  failsOnly("C28", (d) => { d.domain!.stress![1].source = "typed"; });
});

ok("a 3-page render fails C39 only — the count is the renderer's", () => {
  failsOnly("C39", (d) => { d.domain!.limits = { pageCount: 3, maxPages: 2 }; });
});

ok("flagged issue without a document fails C40 only", () => {
  failsOnly("C40", (d) => { d.domain!.redFlags![0].sourceId = null; });
});

ok("an explicit empty redFlags list is clean — no codes, no warnings", () => {
  // The spec requires a source on every flag that exists, not that a flag
  // exists. "We found no issues", stated explicitly, is a pass.
  const r = verdict((d) => { d.domain!.redFlags = []; });
  assert.equal(r.ok, true, `empty redFlags failed: ${r.codes.join(",")}`);
  assert.equal(r.codes, []);
  assert.equal(r.warnings, []);
});

ok("a missing redFlags block still fails C40 (noneOf must not pass silently)", () => {
  failsOnly("C40", (d) => { delete d.domain!.redFlags; });
});

ok("missing advice notice fails C42 only", () => {
  failsOnly("C42", (d) => { d.sections![0].body = "Maple Court Retail Center (fictional). NOI $183,400."; });
});

ok("model boilerplate is a warning, not a block (C41)", () => {
  const r = verdict((d) => {
    d.sections![0].body += " It's important to note that this is not financial or legal advice.";
  });
  assert.equal(r.ok, true, "C41 must not block");
  assert.equal(r.warnings, ["C41"]);
});

ok("fail closed: an empty domain fails, it does not pass on noneOf", () => {
  const r = evaluateDraft({ version: 1, domain: {} }, RULES);
  assert.equal(r.ok, false);
  const codes = r.codes.join(",");
  for (const c of ["C25", "C26", "C27", "C28", "C29", "C39", "C40", "C42"]) {
    assert.ok(codes.includes(c), `${c} did not fire on an empty draft (got ${codes})`);
  }
});

ok("fail closed: a draft with no domain block fails", () => {
  const r = evaluateDraft({ version: 1 }, RULES);
  assert.equal(r.ok, false);
  assert.ok(r.codes.includes("C26"));
});

ok("comps excluded with a reason pass, kept comps with a reason also pass", () => {
  const r = verdict((d) => { d.domain!.comps![0].exclusionReason = "kept_but_noted"; });
  assert.equal(r.ok, true, r.codes.join(","));
});

ok("a text value typed directly does not trip C25 (money only)", () => {
  const r = verdict((d) => {
    d.values!.push({ id: "note", kind: "text", raw: "seller reports", normalised: null, source: "typed" });
  });
  assert.equal(r.ok, true, r.codes.join(","));
});

ok("sealed program round-trips to the same 10 rules", () => {
  assert.equal(j(loadRules(WASM)), j(RULES));
});

ok("no author threshold rides in the published artifact", () => {
  // checks.wasm ships in the bundle; a 1.25x DSCR or 65% LTV inside it is the
  // author's method given away. The rules carry codes and provenance only.
  const text = JSON.stringify(RULES);
  for (const leak of ["1.25", "0.65", "65", "125", "24 months"]) {
    assert.ok(!text.includes(leak), `rule set carries a threshold: ${leak}`);
  }
});

console.log(`\nCR-9 phase D: ${n} checks passed\n`);
