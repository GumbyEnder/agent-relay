/**
 * BZ-F042 — model policy control-surface tests.
 *
 * Standalone: `npx tsx scripts/test-model-policy.ts`. No server, no database,
 * no network. Every control is pinned with at least one negative, and the
 * REASON TEXT is asserted — a control that picks the right model for the wrong
 * reason is still a bug.
 */

import { selectModel, MODEL_POLICY_VERSION, type ModelPreference } from "../src/lib/buzzy/modelPolicy";
import { budgetVerdict, defaultAskWithinCents } from "../src/lib/buzzy/money";
import { __resetModelCatalogForTests, type CatalogModel } from "../src/lib/buzzy/llm";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function has(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// ── Catalogs ─────────────────────────────────────────────────────────
const RICH: CatalogModel[] = [
  { label: "Marvin", model: "z-ai/glm-5.3-flash", provider: "nous", local: false, priceInPerMTok: 0.1, priceOutPerMTok: 0.3 },
  { label: "Fast Tina", model: "fast-1", provider: "nous", local: false, priceInPerMTok: 0.05, priceOutPerMTok: 0.05 },
  { label: "Deep Thinker", model: "reason-1", provider: "openai", local: false, priceInPerMTok: 2, priceOutPerMTok: 8 },
  { label: "Local Llama", model: "llama-local", provider: "local", local: true },
];

const CLOUD_ONLY: CatalogModel[] = [
  { label: "Marvin", model: "z-ai/glm-5.3-flash", provider: "nous", local: false, priceInPerMTok: 0.1, priceOutPerMTok: 0.3 },
];

const NO_PRICES: CatalogModel[] = [
  { label: "Marvin", model: "z-ai/glm-5.3-flash", provider: "nous", local: false },
];

const BASE = { jobType: "marketing", phase: "discovery" as const };

console.log(`model policy ${MODEL_POLICY_VERSION}\n`);

// ── 1. Preferences ───────────────────────────────────────────────────
console.log("preferences");
__resetModelCatalogForTests(RICH);

{
  const d = selectModel({ ...BASE });
  check("value → first eligible entry", d.model === "z-ai/glm-5.3-flash", d.model);
  check("value → reason names the default policy", has(d.reason, "default Value policy"), d.reason);
  check("decision carries policy version", d.policyVersion === MODEL_POLICY_VERSION, d.policyVersion);
  check("decision carries phase", d.phase === "discovery", d.phase);
}

{
  const d = selectModel({ ...BASE, preference: "faster" });
  check("faster → fast-labelled entry", d.model === "fast-1", d.model);
  check("faster → reason names the preference", has(d.reason, "Faster"), d.reason);
}

{
  const d = selectModel({ ...BASE, preference: "thorough" });
  check("thorough → reasoning-capable entry", d.model === "reason-1", d.model);
  check("thorough → reason names reasoning", has(d.reason, "reasoning-capable"), d.reason);
}

{
  const d = selectModel({ ...BASE, preference: "cheapest" });
  check("cheapest → lowest declared price", d.model === "fast-1", d.model);
  check("cheapest → reason states the price", has(d.reason, "0.1/Mtok"), d.reason);
}

// thorough with no reasoning entry must NOT silently escalate
{
  __resetModelCatalogForTests([
    { label: "Marvin", model: "m", provider: "nous", local: false },
    { label: "Fast Tina", model: "f", provider: "nous", local: false },
  ]);
  const d = selectModel({ ...BASE, preference: "thorough" });
  check("thorough with no reasoning entry → default, not a guess", d.model === "m", d.model);
  check("thorough with no reasoning entry → reason says so", has(d.reason, "no silent escalation") || has(d.reason, "has none"), d.reason);
  check("thorough with no reasoning entry → not refused", d.refused !== true, String(d.refused));

  // faster with no fast label
  const d2 = selectModel({ ...BASE, preference: "faster", jobType: "technical", phase: "verification" });
  check("technical/verification → reasoning rule still wins over faster", d2.model === "m", d2.model);
}

// ── 2. Provider ──────────────────────────────────────────────────────
console.log("\nprovider");
__resetModelCatalogForTests(RICH);

{
  const d = selectModel({ ...BASE, provider: "openai" });
  check("known provider → that provider's entry", d.model === "reason-1", d.model);
  check("known provider → decision records provider", d.provider === "openai", String(d.provider));
  check("known provider → reason is a selection, not a refusal", d.refused !== true, String(d.refused));
}

{
  const d = selectModel({ ...BASE, provider: "anthropic" });
  check("unknown provider → refused", d.refused === true, String(d.refused));
  check("unknown provider → refusal code", d.refusedReason === "unknown_provider", String(d.refusedReason));
  check("unknown provider → names the provider", has(d.reason, "anthropic"), d.reason);
  check("unknown provider → routes nowhere", d.model === "", d.model);
}

// ── 3. localOnly ─────────────────────────────────────────────────────
console.log("\nlocalOnly");
__resetModelCatalogForTests(RICH);

{
  const d = selectModel({ ...BASE, localOnly: true });
  check("localOnly with a local entry → local model", d.model === "llama-local", d.model);
  check("localOnly → decision is answered by local provider", d.provider === "local", String(d.provider));
  check("localOnly with local entry → not refused", d.refused !== true, String(d.refused));
}

__resetModelCatalogForTests(CLOUD_ONLY);
{
  const d = selectModel({ ...BASE, localOnly: true });
  check("localOnly with no local entry → refused", d.refused === true, String(d.refused));
  check("localOnly with no local entry → refusal code", d.refusedReason === "no_local_models", String(d.refusedReason));
  check("localOnly refusal → never a cloud model", d.model === "", d.model);
  check("localOnly refusal → reason states no local models", has(d.reason, "no local models"), d.reason);
}

// ── 4. cheapest without a price map ──────────────────────────────────
console.log("\ncheapest without prices");
__resetModelCatalogForTests(NO_PRICES);
{
  const d = selectModel({ ...BASE, preference: "cheapest" });
  check("cheapest with no prices → refused", d.refused === true, String(d.refused));
  check("cheapest with no prices → refusal code", d.refusedReason === "no_price_map", String(d.refusedReason));
  check("cheapest with no prices → never guesses a model", d.model === "", d.model);
  check("cheapest with no prices → reason states the missing map", has(d.reason, "price map"), d.reason);
}

// ── 5. Budget ────────────────────────────────────────────────────────
console.log("\nbudget");
{
  const noCap = budgetVerdict(500, 0);
  check("no cap → allow", noCap.verdict === "allow", noCap.verdict);
  check("no cap → reason says so", has(noCap.reason, "no spend cap"), noCap.reason);

  const under = budgetVerdict(100, 1000);
  check("well under cap → allow", under.verdict === "allow", under.verdict);
  check("well under cap → remaining is exact", under.remainingCents === 900, String(under.remainingCents));

  const band = defaultAskWithinCents(1000);
  check("ask band = 10% of cap", band === 100, String(band));
  check("ask band floor = 50c", defaultAskWithinCents(100) === 50, String(defaultAskWithinCents(100)));

  const near = budgetVerdict(900, 1000);
  check("at the ask band edge → ask", near.verdict === "ask", near.verdict);
  check("at the ask band edge → reason states remaining", has(near.reason, "100c left"), near.reason);

  const justUnder = budgetVerdict(899, 1000);
  check("one cent above the band → allow", justUnder.verdict === "allow", justUnder.verdict);

  const atCap = budgetVerdict(1000, 1000);
  check("spent == cap → refuse (stop AT the cap)", atCap.verdict === "refuse", atCap.verdict);

  const over = budgetVerdict(1001, 1000);
  check("spent > cap → refuse", over.verdict === "refuse", over.verdict);

  const negative = budgetVerdict(-50, 1000);
  check("negative spend treated as zero", negative.spentCents === 0 && negative.verdict === "allow", `${negative.spentCents}/${negative.verdict}`);

  const custom = budgetVerdict(970, 1000, { askWithinCents: 10 });
  check("custom ask band honoured", custom.verdict === "allow", custom.verdict);
}

// ── 6. Budget integrated with selection ──────────────────────────────
console.log("\nbudget × selection");
__resetModelCatalogForTests(RICH);
{
  const d = selectModel({ ...BASE, budgetCapCents: 1000, spentCents: 1000 });
  check("budget at cap → refused", d.refused === true, String(d.refused));
  check("budget at cap → refusal code", d.refusedReason === "budget_refused", String(d.refusedReason));
  check("budget at cap → routes nowhere", d.model === "", d.model);
  check("budget at cap → decision carries the verdict", d.budget?.verdict === "refuse", String(d.budget?.verdict));

  const d2 = selectModel({ ...BASE, budgetCapCents: 1000, spentCents: 950 });
  check("budget near cap → still selects", d2.refused !== true && d2.model === "z-ai/glm-5.3-flash", d2.model);
  check("budget near cap → verdict is ask", d2.budget?.verdict === "ask", String(d2.budget?.verdict));
}

// ── 7. Explicit override ─────────────────────────────────────────────
console.log("\noverride");
__resetModelCatalogForTests(RICH);
{
  const d = selectModel({ ...BASE, overrideModel: "reason-1" });
  check("in-catalog override honoured", d.model === "reason-1", d.model);
  check("in-catalog override → reason names the pick", has(d.reason, "owner picked"), d.reason);

  const d2 = selectModel({ ...BASE, overrideModel: "not-a-model" });
  check("out-of-catalog override → falls back to default", d2.model === "z-ai/glm-5.3-flash", d2.model);
  check("out-of-catalog override → reason says why", has(d2.reason, "not in the approved catalog"), d2.reason);

  const d3 = selectModel({ ...BASE, overrideModel: "llama-local", provider: "nous" });
  check("override excluded by provider constraint → refused, not substituted", d3.refused === true, String(d3.refused));
}

// ── 8. High-stakes rule still works ──────────────────────────────────
console.log("\nhigh-stakes routing");
__resetModelCatalogForTests(RICH);
{
  const d = selectModel({ jobType: "legal", phase: "deliverable" });
  check("legal deliverable → reasoning entry", d.model === "reason-1", d.model);
  const d2 = selectModel({ jobType: "legal", phase: "discovery" });
  check("legal discovery → default entry", d2.model === "z-ai/glm-5.3-flash", d2.model);
}

// ── 9. Empty catalog ─────────────────────────────────────────────────
console.log("\nempty catalog");
__resetModelCatalogForTests([]);
{
  const d = selectModel({ ...BASE });
  check("empty catalog → refused", d.refused === true, String(d.refused));
  check("empty catalog → refusal code", d.refusedReason === "empty_catalog", String(d.refusedReason));
}

// ── 10. Operator prefs → policy (BZ-F043) ────────────────────────────
console.log("\noperator prefs");
{
  // Minimal tag-function stub: the reader issues exactly two queries.
  const stub = (rows: { prefs?: unknown; usd?: unknown }) =>
    (async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("ar_operator_prefs")) return [{ prefs: rows.prefs }];
      if (text.includes("buzzy_chat_messages")) return [{ usd: rows.usd }];
      return [];
    }) as never;

  const { readModelPrefs, validateModelPrefsPatch } = await import("../src/lib/buzzy/modelPrefs");

  const stored = await readModelPrefs(stub({ prefs: { modelPreference: "cheapest" }, usd: 0 }), "u1");
  check("stored preference is used", stored.preference === "cheapest", stored.preference);
  check("stored preference → source is stored", stored.preferenceSource === "stored", stored.preferenceSource);
  check("stored preference → no degradation", stored.degradation === undefined, String(stored.degradation));

  const garbage = await readModelPrefs(stub({ prefs: { modelPreference: "turbo" }, usd: 0 }), "u1");
  check("unknown stored preference → falls back to value", garbage.preference === "value", garbage.preference);
  check("unknown stored preference → source is default", garbage.preferenceSource === "default", garbage.preferenceSource);
  check("unknown stored preference → degradation recorded", has(String(garbage.degradation), "turbo"), String(garbage.degradation));

  const empty = await readModelPrefs(stub({ prefs: {}, usd: 0 }), "u1");
  check("no pref → value", empty.preference === "value", empty.preference);
  check("no pref → no degradation", empty.degradation === undefined, String(empty.degradation));

  const controls = await readModelPrefs(
    stub({ prefs: { provider: "nous", localOnly: true, budgetCapCents: 500 }, usd: 0 }),
    "u1",
  );
  check("provider read through", controls.provider === "nous", String(controls.provider));
  check("localOnly read through", controls.localOnly === true, String(controls.localOnly));
  check("budget cap read through", controls.budgetCapCents === 500, String(controls.budgetCapCents));

  const zeroCap = await readModelPrefs(stub({ prefs: { budgetCapCents: 0 }, usd: 0 }), "u1");
  check("cap of 0 means no cap", zeroCap.budgetCapCents === undefined, String(zeroCap.budgetCapCents));

  const spend = await readModelPrefs(stub({ prefs: {}, usd: 12.345 }), "u1");
  check("spend converts USD → cents", spend.spentCents === 1235, String(spend.spentCents));

  const nullSpend = await readModelPrefs(stub({ prefs: {}, usd: null }), "u1");
  check("null spend counts as zero", nullSpend.spentCents === 0, String(nullSpend.spentCents));

  // patch validation — the write path must not store a control the policy cannot honour
  const good = validateModelPrefsPatch({ modelPreference: "thorough", localOnly: true, budgetCapCents: 250 });
  check("valid patch accepted", good.ok === true, JSON.stringify(good));
  const badPref = validateModelPrefsPatch({ modelPreference: "turbo" });
  check("invalid preference rejected at write", badPref.ok === false, JSON.stringify(badPref));
  const badBool = validateModelPrefsPatch({ localOnly: "yes" });
  check("non-boolean localOnly rejected", badBool.ok === false, JSON.stringify(badBool));
  const badCap = validateModelPrefsPatch({ budgetCapCents: -5 });
  check("negative cap rejected", badCap.ok === false, JSON.stringify(badCap));
  const floatCap = validateModelPrefsPatch({ budgetCapCents: 12.5 });
  check("fractional cap rejected", floatCap.ok === false, JSON.stringify(floatCap));
  const cleared = validateModelPrefsPatch({ modelPreference: null, budgetCapCents: null });
  check("null clears a control", cleared.ok === true, JSON.stringify(cleared));
}

// reset so a later importer of this script's process is unaffected
__resetModelCatalogForTests();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
