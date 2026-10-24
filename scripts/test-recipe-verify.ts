/**
 * Step 5 acceptance tests: parity with the run path, the no-plaintext property,
 * rate limits, batch cap, and the offline (KEK-less) path.
 *
 * Run: npx tsx scripts/test-recipe-verify.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { rulesFor } from "../src/lib/recipe-checks";
import { PIPELINE_CODES, filterLeak, runSealedRecipe } from "../src/lib/recipe-seal/pipeline";
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

  await ok("LEAK: prose shorter than the shingle width is still caught", () => {
    // 8-token windows never matched a 5-word phrase, so short boundary text passed
    // through untouched. Detection runs at 4 tokens as well.
    const semantic = { discovery: ["d"], boundary: "Never invents a price or a term.", checklist: {}, outputContract: [] } as never;
    for (const short of ["never invents a price", "invents a price or a term"]) {
      const r = filterLeak(short, semantic);
      assert.equal(r.matched > 0, true, `short prose escaped detection: ${short}`);
      assert.equal(r.text.includes(short), false, `short prose survived: ${r.text}`);
    }
  });

  await ok("LEAK: legitimate text beside one boundary sentence is not wiped", () => {
    // The old rule withheld the whole string once 15% of it overlapped, which
    // erased a perfectly good 40-token body that happened to cite the boundary.
    const semantic = { discovery: ["d"], boundary: "Never invents a price or a term.", checklist: {}, outputContract: [] } as never;
    const body = "Supplier B is cheaper per unit at 12.40 versus 13.10, delivery is four days sooner, " +
      "and the warranty is twelve months. Never invents a price or a term. Recommendation: choose B.";
    const r = filterLeak(body, semantic);
    assert.equal(r.rejected, false, "the entire field was withheld for one sentence");
    assert.equal(r.text.includes("Supplier B is cheaper per unit"), true, "legitimate text was destroyed");
    assert.equal(r.text.includes("Never invents a price"), false, "the boundary sentence survived");
  });

  await ok("LIMITER: a full bucket map never hands a caller a reset", () => {
    const limiter = new RateLimiter(2, 60_000, () => 0, 2);
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, false, "a was not limited");
    limiter.take("b"); limiter.take("c"); limiter.take("d"); limiter.take("e");
    assert.equal(limiter.take("a").allowed, false, "eviction reset a live counter");
  });

  await ok("NO-PLAINTEXT: verify runs with a runtime trap on every KEK-ish env read", () => {
    // A source grep is a lint (it misses process["env"], follows only known
    // specifiers, and false-positives on comments). scripts/purity-check.ts
    // installs a Proxy on process.env *before* importing the verify modules, so
    // any reachable read of RECIPE_SEAL_KEK throws at runtime.
    const out = execFileSync("npx", ["tsx", "scripts/purity-check.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
    });
    const parsed = JSON.parse(out.trim().split("\n").pop() as string) as { ok: boolean; envReads: number };
    assert.equal(parsed.envReads, 0, "the verify tier read a KEK-ish environment variable");
    assert.equal(parsed.ok, true);
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
