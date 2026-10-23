/**
 * Step 5 acceptance tests: parity with the run path, the no-plaintext property,
 * rate limits, batch cap, and the offline (KEK-less) path.
 *
 * Run: npx tsx scripts/test-recipe-verify.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rulesFor } from "../src/lib/recipe-checks";
import { PIPELINE_CODES, runSealedRecipe } from "../src/lib/recipe-seal/pipeline";
import { createSafeLogger, memorySink } from "../src/lib/recipe-seal/safe-log";
import { LIMITS, RateLimiter, bucketMs, verifyBatch, verifyDraft } from "../src/lib/recipe-seal/verify";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import type { SemanticHalf } from "../src/lib/recipe-seal/pipeline";

const j = (v: unknown) => JSON.stringify(v);
const assert = {
  ok(cond: unknown, msg = "expected truthy"): void { if (!cond) throw new Error(msg); },
  equal(a: unknown, b: unknown, msg = "equal"): void {
    if (j(a) !== j(b)) throw new Error(`${msg}: ${j(a)} !== ${j(b)}`);
  },
};
let checks = 0;
const ok = async (name: string, fn: () => Promise<void> | void) => { await fn(); checks++; console.log(`  ok  ${name}`); };

const compiled = compileRecipeChecks("quote-comparison", { salt: new Uint8Array(8) });
const DESCRIPTIONS = compiled.codes;

const GOOD = {
  version: 1,
  sections: [{ id: "s1", title: "Rec", body: "Supplier B is cheaper per unit." }],
  claims: [{ id: "c1", text: "Supplier B quoted 12.40 per unit", sourceId: "q2" }],
  values: [{ id: "total-1", kind: "money", raw: "1240.00", normalised: 124000, source: "calculator" }],
  domain: { units: ["ea"] },
};
const BAD = {
  ...GOOD,
  values: [{ id: "total-1", kind: "money", raw: "1240.00", normalised: 124000, source: "typed" }],
};

(async () => {
  console.log("\nStep 5 — verify tier\n");

  await ok("a valid draft verifies clean", () => {
    const r = verifyDraft({ checksWasm: compiled.wasm, draft: GOOD, descriptions: DESCRIPTIONS });
    assert.equal(r.ok, true);
    assert.equal(r.codes, []);
  });

  await ok("a bad draft returns its specific code plus a public description", () => {
    const r = verifyDraft({ checksWasm: compiled.wasm, draft: BAD, descriptions: DESCRIPTIONS });
    assert.equal(r.ok, false);
    assert.ok(r.codes.includes("C01"));
    assert.ok(typeof r.descriptions.C01 === "string");
  });

  await ok("regression: descriptions resolve from the SEALED manifest codes map", () => {
    // The bug this guards: compile() once emitted codes as a string[] so the
    // manifest could not explain a fired code, and every response carried {}.
    const fromManifest = compiled.manifest.codes;
    assert.equal(typeof (fromManifest as Record<string, string>).C01, "string",
      "manifest.checks.codes is not a code->description map");
    const r = verifyDraft({ checksWasm: compiled.wasm, draft: BAD, descriptions: fromManifest });
    assert.equal(typeof r.descriptions.C01, "string", "C01 fired but was not described");
  });

  await ok("only fired codes are described (no rule inventory in the response)", () => {
    const r = verifyDraft({ checksWasm: compiled.wasm, draft: GOOD, descriptions: DESCRIPTIONS });
    assert.equal(Object.keys(r.descriptions).length, 0);
  });

  await ok("timing is bucketed, never raw", () => {
    const r = verifyDraft({ checksWasm: compiled.wasm, draft: GOOD, descriptions: DESCRIPTIONS });
    assert.ok(["<5", "<20", "<50", ">=50"].includes(r.ms_bucket));
    assert.equal(bucketMs(0), "<5");
    assert.equal(bucketMs(49), "<50");
    assert.equal(bucketMs(50), ">=50");
  });

  await ok("NO-PLAINTEXT: verify works with RECIPE_SEAL_KEK unset", () => {
    // Prove the property at the environment level: the opener needs this key.
    const saved = process.env.RECIPE_SEAL_KEK;
    delete process.env.RECIPE_SEAL_KEK;
    try {
      const r = verifyDraft({ checksWasm: compiled.wasm, draft: GOOD, descriptions: DESCRIPTIONS });
      assert.equal(r.ok, true);
    } finally {
      if (saved !== undefined) process.env.RECIPE_SEAL_KEK = saved;
    }
  });

  await ok("NO-PLAINTEXT: verify.ts does not reference the bundle opener at all", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/recipe-seal/verify.ts"), "utf8");
    for (const forbidden of ["openSemantic", "dek_wrapped", "process.env.RECIPE_SEAL_KEK", 'from "./bundle"']) {
      assert.equal(src.includes(forbidden), false, `verify.ts references ${forbidden}`);
    }
  });

  await ok("PARITY: verify codes equal the codes produced inside the run path", async () => {
    const semantic: SemanticHalf = {
      discovery: ["Which quotes are in play"], checklist: { output: "table" },
      outputContract: ["table"], boundary: "Never invents a price or a term.",
    };
    const rules = rulesFor("quote-comparison");
    const sink = memorySink();
    const log = createSafeLogger(sink, { level: "error" });

    for (const draft of [GOOD, BAD]) {
      const run = await runSealedRecipe({
        semantic, inputs: {}, rules, model: async () => j(draft), log, recipeHash: "sha256:test",
      });
      const verify = verifyDraft({ checksWasm: compiled.wasm, draft, descriptions: DESCRIPTIONS });
      assert.equal(verify.codes, run.verdict?.codes ?? [], `parity broke on ${j(draft).slice(0, 40)}`);
      assert.equal(verify.ok, run.verdict?.ok ?? false);
    }
  });

  await ok("rate limit: 60 anonymous calls pass, the 61st is refused with a retry hint", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(LIMITS.anonymousPerMinute, 60_000, () => now);
    for (let i = 0; i < LIMITS.anonymousPerMinute; i++) {
      assert.equal(limiter.take("1.2.3.4").allowed, true, `call ${i} should pass`);
    }
    const refused = limiter.take("1.2.3.4");
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterMs > 0);
    // window resets
    now += 60_001;
    assert.equal(limiter.take("1.2.3.4").allowed, true);
  });

  await ok("rate limit is per caller, not global", () => {
    const limiter = new RateLimiter(2, 60_000, () => 0);
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, false);
    assert.equal(limiter.take("b").allowed, true);
  });

  await ok("batch: cap is 50, 51 is a 413", () => {
    const one: VerifyInput = { checksWasm: compiled.wasm, draft: GOOD, descriptions: DESCRIPTIONS };
    assert.equal(verifyBatch(Array(50).fill(one)).status, 200);
    const over = verifyBatch(Array(51).fill(one));
    assert.equal(over.status, 413);
    assert.equal(over.ok, false);
  });

  await ok("batch: empty body is a 400, not an empty success", () => {
    assert.equal(verifyBatch([]).status, 400);
  });

  await ok("offline CLI path: no network, no licence, no KEK", () => {
    // verifyDraft is the offline path's entire dependency surface.
    const r = verifyDraft({ checksWasm: compiled.wasm, draft: BAD, descriptions: DESCRIPTIONS });
    assert.equal(r.ok, false);
    assert.ok(r.codes.length > 0);
  });

  console.log(`\nStep 5: ${checks} checks passed\n`);
})().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});

type VerifyInput = Parameters<typeof verifyDraft>[0];
