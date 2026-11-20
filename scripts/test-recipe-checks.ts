/**
 * Step 1 acceptance tests: parity, determinism, sandbox, obfuscation, budget,
 * and a positive/negative fixture for every recipe.
 *
 * Run: npx tsx scripts/test-recipe-checks.ts
 */
import {
  ALL_RULES, RECIPE_RULES, compileRecipeChecks, evaluateDraft, evaluateRecipeChecks,
  loadRules, type Draft,
} from "../src/lib/recipe-checks";

// Repo convention: scripts define their own assertions (scripts/ is outside tsconfig).
const j = (v: unknown) => JSON.stringify(v);
const assert = {
  ok(cond: unknown, msg = "expected truthy"): void {
    if (!cond) throw new Error(msg);
  },
  equal(a: unknown, b: unknown, msg = "equal"): void {
    if (j(a) !== j(b)) throw new Error(`${msg}: ${j(a)} !== ${j(b)}`);
  },
  deepEqual(a: unknown, b: unknown, msg = "deepEqual"): void {
    if (j(a) !== j(b)) throw new Error(`${msg}: ${j(a)} !== ${j(b)}`);
  },
  throws(fn: () => void, msg = "expected throw"): void {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new Error(msg);
  },
};

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

const RECIPE_IDS = Object.keys(RECIPE_RULES);

// ── fixtures ──────────────────────────────────────────────────────────────────
function validDraft(recipeId: string): Draft {
  const base: Draft = { version: 1, recipeId, sections: [], claims: [], values: [], domain: {} };
  switch (recipeId) {
    case "quote-comparison":
      return { ...base,
        values: [{ id: "total-1", kind: "money", raw: "100.00", normalised: 10000, source: "calculator" }],
        domain: { units: ["ea"] } };
    case "complaint-resolution":
      return { ...base,
        claims: [{ id: "c1", text: "We are sorry this happened.", sourceId: null, suggestion: true }],
        domain: { refunds: [], dates: [] } };
    case "meeting-action-pack":
      return { ...base,
        domain: { actions: [{ id: "a1", owner: "Dana" }], attendance: [], names: [] } };
    case "bookkeeping-prep":
      return { ...base,
        values: [{ id: "total-1", kind: "money", raw: "42.00", normalised: 4200, source: "calculator" }],
        domain: { uncategorised: 3, taxAssertions: [] } };
    case "campaign-brief":
      return { ...base,
        claims: [{ id: "c1", text: "Reach grew 10%", sourceId: "src-1" }],
        values: [{ id: "v1", kind: "money", raw: "50.00", normalised: 5000, source: "source" }],
        domain: { publishingGate: "Publisher approval required before publishing" } };
    case "people-ops-paperwork":
      return { ...base,
        claims: [],
        domain: {
          policyStatements: [{ id: "p1", text: "Leave is 15 days", approvedTextId: "t1" }],
          employmentTerms: [{ id: "e1", text: "Start date 1 Nov", supplied: true }],
          legalQuestions: ["Is the notice period compliant?"],
        } };
    case "grants-rfp":
      return { ...base,
        domain: {
          eligibility: [{ id: "e1", text: "Meets size threshold", sourceId: "s1", gap: false }],
          limits: { wordCount: 100, maxWords: 200, format: "pdf", requiredFormat: "pdf" },
          filingActions: [],
        } };
    case "dispute-paperwork":
      return { ...base,
        claims: [{ id: "c1", text: "Water damage on 3 Nov", sourceId: "s1" }],
        domain: {
          sensitiveIdentifiers: [{ id: "i1", value: "POL-****-19" }],
          promisedOutcomes: [], filingActions: [],
        } };
    case "cre-deal-memo":
      // The acceptance fixture from the CR-9 spec, reduced to the shape the
      // checks read: computed money, sourced comps, three computed scenarios,
      // a runner reconciliation verdict, cited flags, the renderer's page count
      // and the advice notice.
      return { ...base,
        sections: [{
          id: "s1",
          title: "Summary",
          body: "Maple Court Retail Center (fictional). Prepared with AI from your documents. Not financial or legal advice.",
        }],
        claims: [{ id: "c1", text: "Three of four suites are leased at 81%.", sourceId: "listing" }],
        values: [
          { id: "noi", kind: "money", raw: "183400.00", normalised: 18340000, source: "calculator" },
          { id: "egi", kind: "money", raw: "264100.00", normalised: 26410000, source: "calculator" },
        ],
        domain: {
          comps: [
            { id: "C1", sourceId: "comps", excluded: false, exclusionReason: null },
            { id: "C4", sourceId: "comps", excluded: true, exclusionReason: "portfolio_sale" },
            { id: "C5", sourceId: "comps", excluded: true, exclusionReason: "too_old" },
          ],
          stress: [
            { id: "base", rateShiftBp: 0, noteRateBp: 675, dscrX100: 131, ltvBp: 6500, debtYieldBp: 1085, source: "calculator" },
            { id: "bp100", rateShiftBp: 100, noteRateBp: 775, dscrX100: 120, ltvBp: 6500, debtYieldBp: 1085, source: "calculator" },
            { id: "bp200", rateShiftBp: 200, noteRateBp: 875, dscrX100: 110, ltvBp: 6500, debtYieldBp: 1085, source: "calculator" },
          ],
          reconciliation: { ok: true, checked: 12, mismatches: 0 },
          redFlags: [{ id: "f1", category: "lease", sourceId: "listing", severity: "medium" }],
          limits: { pageCount: 2, maxPages: 2 },
        } };
    default:
      throw new Error(`no fixture for ${recipeId}`);
  }
}

const NEGATIVE: Record<string, (d: Draft) => void> = {
  "quote-comparison": (d) => { d.values![0].source = "typed"; },
  "complaint-resolution": (d) => { d.claims![0].suggestion = false; },
  "meeting-action-pack": (d) => { d.domain!.actions![0].owner = null; },
  "bookkeeping-prep": (d) => { d.domain!.taxAssertions = ["This is tax deductible"]; },
  "campaign-brief": (d) => { d.domain!.publishingGate = null; },
  "people-ops-paperwork": (d) => { d.domain!.employmentTerms![0].supplied = false; },
  "grants-rfp": (d) => { d.domain!.eligibility![0].sourceId = null; },
  "dispute-paperwork": (d) => { d.domain!.promisedOutcomes = ["You will win"]; },
  "cre-deal-memo": (d) => { d.values![0].source = "typed"; },
};

const EXPECTED_NEGATIVE_CODE: Record<string, string> = {
  "quote-comparison": "C01",
  "complaint-resolution": "C04",
  "meeting-action-pack": "C07",
  "bookkeeping-prep": "C12",
  "campaign-brief": "C15",
  "people-ops-paperwork": "C17",
  "grants-rfp": "C19",
  "dispute-paperwork": "C24",
  "cre-deal-memo": "C25",
};

/** Rule counts per family: the eight originals carry 4, the CR-9 memo carries 10. */
const EXPECTED_RULE_COUNTS: Record<string, number> = { "cre-deal-memo": 10 };
const EXPECTED_TOTAL_RULES = 42;

console.log("\nStep 1 — check DSL, sealed program, evaluation\n");

ok("every recipe has its expected rule count (3 domain checks + 1 boundary, or the 10-rule memo)", () => {
  for (const id of RECIPE_IDS) {
    assert.equal(RECIPE_RULES[id].length, EXPECTED_RULE_COUNTS[id] ?? 4, `${id} rule count`);
  }
  assert.equal(ALL_RULES.length, EXPECTED_TOTAL_RULES);
});

ok("codes are unique across the rule set", () => {
  const codes = ALL_RULES.map((r) => r.code);
  assert.equal(new Set(codes).size, codes.length);
});

ok("sealed artifact round-trips to the same rules", () => {
  for (const id of RECIPE_IDS) {
    const compiled = compileRecipeChecks(id, { salt: new Uint8Array(8) });
    const back = loadRules(compiled.wasm);
    assert.deepEqual(back, RECIPE_RULES[id], `${id} rules changed`);
  }
});

ok("parity: in-memory rules and sealed artifact give identical verdicts", () => {
  for (const id of RECIPE_IDS) {
    const compiled = compileRecipeChecks(id, { salt: new Uint8Array(8) });
    const draft = validDraft(id);
    const direct = evaluateDraft(draft, RECIPE_RULES[id]);
    const sealed = evaluateRecipeChecks(compiled.wasm, draft);
    assert.deepEqual(
      { ok: sealed.ok, codes: sealed.codes, warnings: sealed.warnings },
      { ok: direct.ok, codes: direct.codes, warnings: direct.warnings },
      id,
    );
  }
});

ok("valid fixture passes for every recipe", () => {
  for (const id of RECIPE_IDS) {
    const r = evaluateRecipeChecks(compileRecipeChecks(id, { salt: new Uint8Array(8) }).wasm, validDraft(id));
    assert.equal(r.ok, true, `${id} should pass, got ${r.codes.join(",")}`);
    assert.deepEqual(r.codes, []);
  }
});

ok("each negative fixture fails with its specific code", () => {
  for (const id of RECIPE_IDS) {
    const d = validDraft(id);
    NEGATIVE[id](d);
    const r = evaluateRecipeChecks(compileRecipeChecks(id, { salt: new Uint8Array(8) }).wasm, d);
    assert.equal(r.ok, false, `${id} should fail`);
    assert.ok(r.codes.includes(EXPECTED_NEGATIVE_CODE[id]),
      `${id} expected ${EXPECTED_NEGATIVE_CODE[id]}, got [${r.codes.join(",")}]`);
  }
});

ok("boundary rule blocks a forbidden claim (forbiddenClaimCheck exists now)", () => {
  const d = validDraft("quote-comparison");
  d.claims = [{ id: "c9", text: "We offer the guaranteed lowest price.", sourceId: "s1" }];
  const r = evaluateRecipeChecks(compileRecipeChecks("quote-comparison", { salt: new Uint8Array(8) }).wasm, d);
  assert.equal(r.ok, false);
  assert.ok(r.codes.includes("C30"));
});

ok("determinism: same salt produces byte-identical artifacts", () => {
  const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const a = compileRecipeChecks("quote-comparison", { salt });
  const b = compileRecipeChecks("quote-comparison", { salt });
  assert.deepEqual(a.wasm, b.wasm);
  assert.equal(a.manifest.sha256, b.manifest.sha256);
});

ok("determinism: 100 evaluations return identical results", () => {
  const wasm = compileRecipeChecks("grants-rfp", { salt: new Uint8Array(8) }).wasm;
  const d = validDraft("grants-rfp");
  const first = evaluateRecipeChecks(wasm, d);
  for (let i = 0; i < 99; i++) {
    const r = evaluateRecipeChecks(wasm, d);
    assert.deepEqual([r.ok, r.codes, r.warnings, r.nodes], [first.ok, first.codes, first.warnings, first.nodes]);
  }
});

ok("obfuscation: no rule text is readable in the artifact", () => {
  const wasm = compileRecipeChecks("quote-comparison", { salt: new Uint8Array(8) }).wasm;
  const latin = new TextDecoder("latin1").decode(wasm);
  for (const needle of ["calculator", "guaranteed", "totals", "rule", "quote", "C01", "description"]) {
    assert.equal(latin.toLowerCase().includes(needle.toLowerCase()), false,
      `artifact leaks "${needle}"`);
  }
});

ok("sandbox: module is exactly one custom section — no imports, no code", () => {
  const wasm = compileRecipeChecks("dispute-paperwork", { salt: new Uint8Array(8) }).wasm;
  // magic + version
  assert.deepEqual([...wasm.slice(0, 8)], [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  assert.equal(wasm[8], 0x00, "expected custom section id");
  // walk the single ULEB128 section length and assert it ends exactly at EOF
  let i = 9;
  let size = 0;
  let shift = 0;
  for (;;) {
    const b = wasm[i++];
    size |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  assert.equal(i + size, wasm.length, "trailing sections present (imports or code)");
  // declared section count is 1 by construction, so no import (id 2) can exist
  assert.equal(size > 0, true);
});

ok("budget: exceeding the node budget returns C00, never a silent pass", () => {
  const wasm = compileRecipeChecks("quote-comparison", { salt: new Uint8Array(8) }).wasm;
  const r = evaluateRecipeChecks(wasm, validDraft("quote-comparison"), { budget: 2 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.codes, ["C00"]);
  assert.equal(r.budgetExceeded, true);
});

ok("corrupt artifact is rejected, not evaluated", () => {
  const wasm = compileRecipeChecks("bookkeeping-prep", { salt: new Uint8Array(8) }).wasm;
  const bad = new Uint8Array(wasm);
  bad[bad.length - 5] ^= 0xff;
  assert.throws(() => evaluateRecipeChecks(bad, validDraft("bookkeeping-prep")));
});

ok("missing collection fails closed for allOf-based rules", () => {
  const wasm = compileRecipeChecks("meeting-action-pack", { salt: new Uint8Array(8) }).wasm;
  const r = evaluateRecipeChecks(wasm, { version: 1, domain: {} });
  assert.equal(r.ok, false);
  assert.ok(r.codes.includes("C07"));
});

ok("perf: 24-rule equivalent evaluates well under 5ms", () => {
  const wasm = compileRecipeChecks("bookkeeping-prep", { salt: new Uint8Array(8) }).wasm;
  const d = validDraft("bookkeeping-prep");
  const start = Date.now();
  for (let i = 0; i < 1000; i++) evaluateRecipeChecks(wasm, d);
  const ms = (Date.now() - start) / 1000;
  assert.ok(ms < 5, `per-draft cost ${ms.toFixed(3)}ms exceeds 5ms`);
  console.log(`       per-draft: ${ms.toFixed(3)}ms`);
});

console.log(`\nStep 1: ${checks} checks passed\n`);
