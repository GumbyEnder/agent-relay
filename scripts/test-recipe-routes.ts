/**
 * Route-level acceptance tests (verify tier + licence + run), against a real
 * Postgres and in-memory bundle storage.
 *
 * Run: DATABASE_URL_TEST=postgres://postgres:test@127.0.0.1:55432/recipes \
 *        npx tsx scripts/test-recipe-routes.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { generateAuthorKey, sealBundle, sha256Hex } from "../src/lib/recipe-seal/bundle";
import { MemoryStorage } from "../src/lib/recipe-seal/storage";
import { createRouteDeps, routeRecipes, type RouteDeps } from "../src/lib/recipe-seal/routes";
import { RateLimiter } from "../src/lib/recipe-seal/verify";
import { memorySink } from "../src/lib/recipe-seal/safe-log";

const j = (v: unknown) => JSON.stringify(v);
const assert = {
  ok(cond: unknown, msg = "expected truthy"): void { if (!cond) throw new Error(msg); },
  equal(a: unknown, b: unknown, msg = "equal"): void {
    if (j(a) !== j(b)) throw new Error(`${msg}: ${j(a)} !== ${j(b)}`);
  },
};
let checks = 0;
const ok = async (name: string, fn: () => Promise<void>) => { await fn(); checks++; console.log(`  ok  ${name}`); };

const url = process.env.DATABASE_URL_TEST;
if (!url) { console.error("DATABASE_URL_TEST required"); process.exit(2); }

const pool = new Pool({ connectionString: url, max: 8 });
const q = async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows as never;
const storage = new MemoryStorage();

const recipe = RECIPES[0];
const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
const key = generateAuthorKey();
const KEK = new Uint8Array(32).fill(7);

const sealed = sealBundle({
  recipeId: recipe.id,
  version: "1.0.0",
  semantic: { discovery: recipe.discovery, boundary: recipe.boundary,
    checklist: recipe.checklist, outputContract: recipe.outputContract },
  checksWasm: compiled.wasm,
  checks: compiled.manifest,
  capability: {
    inputs: [{ name: "quotes", type: "file[]", required: true }],
    outputs: recipe.outputContract, tools: recipe.tools,
    forbidden_tools: ["send", "email"], boundary_summary: recipe.boundary,
  },
  author: { id: "acct_author", name: "Author", keyId: key.keyId, privateKey: key.privateKey },
  kek: KEK,
  pricing: { amount_cents: 4 },
  createdAt: "2026-10-20T12:00:00.000Z",
});

const GOOD = {
  version: 1,
  sections: [{ id: "s1", title: "Rec", body: "Supplier B is cheaper per unit." }],
  claims: [{ id: "c1", text: "Supplier B quoted 12.40 per unit", sourceId: "q2" }],
  values: [{ id: "total-1", kind: "money", raw: "1240.00", normalised: 124000, source: "calculator" }],
  domain: { units: ["ea"] },
};
const BAD = { ...GOOD, values: [{ id: "total-1", kind: "money", raw: "1240.00", normalised: 124000, source: "typed" }] };

(async () => {
  console.log("\nRoutes — verify, license, run (real Postgres)\n");
  await pool.query(`DROP VIEW IF EXISTS ar_recipe_metering;
    DROP TABLE IF EXISTS ar_recipe_run, ar_recipe_token, ar_recipe_license, ar_recipe_bundle CASCADE;`);
  for (const f of ["0039_recipe_seal_bundles.sql", "0040_recipe_seal_licenses.sql",
                   "0041_recipe_seal_tokens.sql", "0042_recipe_seal_metering.sql"]) {
    await pool.query(readFileSync(join(process.cwd(), "migrations", f), "utf8"));
  }

  let deps: RouteDeps = createRouteDeps({
    q, storage, kek: KEK,
    model: async () => j(GOOD),
    anonymousLimiter: new RateLimiter(60, 60_000, () => 0),
    tokenLimiter: new RateLimiter(600, 60_000, () => 0),
    logSink: memorySink(),
  });

  let hash = "";

  await ok("publish is refused without an operator session", async () => {
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      body: { bundle: Buffer.from(sealed.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 403);
  });

  await ok("publish accepts a verified bundle and stores it content-addressed", async () => {
    const r = await routeRecipes({ method: "POST", path: "/api/recipes", operatorId: "op_1",
      body: { bundle: Buffer.from(sealed.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 201, `publish failed: ${j(r.body)}`);
    hash = (r.body as { hash: string }).hash;
    assert.equal(hash, sealed.digest);
    assert.ok(await storage.get(`bundles/${hash}.srb`));
  });

  await ok("catalogue lists the recipe", async () => {
    const r = await routeRecipes({ method: "GET", path: "/api/recipes" }, deps);
    assert.equal(r.status, 200);
    assert.equal((r.body as { recipes: unknown[] }).recipes.length, 1);
  });

  await ok("manifest is public and carries no prose", async () => {
    const r = await routeRecipes({ method: "GET", path: `/api/recipes/${hash}/manifest` }, deps);
    assert.equal(r.status, 200);
    const text = j(r.body);
    for (const phrase of recipe.discovery) {
      assert.equal(text.includes(phrase), false, `manifest leaked: ${phrase.slice(0, 30)}`);
    }
  });

  await ok("verify returns 200 for a good draft", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify`,
      body: { draft: GOOD }, callerKey: "1.1.1.1" }, deps);
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
  });

  await ok("verify returns the specific code for a bad draft", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify`,
      body: { draft: BAD }, callerKey: "1.1.1.1" }, deps);
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, false);
    assert.ok((r.body as { codes: string[] }).codes.includes("C01"));
    // The response must explain the code it reported.
    const desc = (r.body as { descriptions: Record<string, string> }).descriptions;
    assert.equal(typeof desc.C01, "string", "fired code returned without a description");
  });

  await ok("verify rejects a missing draft with 400", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify`,
      body: {}, callerKey: "1.1.1.1" }, deps);
    assert.equal(r.status, 400);
  });

  await ok("unknown bundle is a 404, not an empty 200", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${"a".repeat(64)}/verify`,
      body: { draft: GOOD }, callerKey: "1.1.1.1" }, deps);
    assert.equal(r.status, 404);
  });

  await ok("rate limit returns 429 with Retry-After", async () => {
    const tight: RouteDeps = createRouteDeps({
      q, storage, kek: KEK, model: async () => j(GOOD),
      anonymousLimiter: new RateLimiter(2, 60_000, () => 0),
      tokenLimiter: new RateLimiter(600, 60_000, () => 0),
      logSink: memorySink(),
    });
    const call = () => routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify`,
      body: { draft: GOOD }, callerKey: "9.9.9.9" }, tight);
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    const third = await call();
    assert.equal(third.status, 429);
    assert.ok(third.headers?.["Retry-After"]);
  });

  await ok("batch over 50 returns 413", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify/batch`,
      body: { drafts: Array(51).fill(GOOD) }, callerKey: "2.2.2.2" }, deps);
    assert.equal(r.status, 413);
  });

  await ok("batch of 3 returns 3 verdicts", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify/batch`,
      body: { drafts: [GOOD, BAD, GOOD] }, callerKey: "2.2.2.2" }, deps);
    assert.equal(r.status, 200);
    assert.equal((r.body as { results: unknown[] }).results.length, 3);
  });

  let token = "";
  await ok("operator issues a licence and receives the token exactly once", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", body: { licenseeId: "agent_a", licenseeKind: "agent", quota: 2,
        scopes: ["run", "verify", "usage"] } }, deps);
    assert.equal(r.status, 201, `license failed: ${j(r.body)}`);
    token = (r.body as { token: string }).token;
    assert.ok(token.startsWith("rcp_"));
  });

  await ok("run is refused without a token", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      body: { inputs: {} } }, deps);
    assert.equal(r.status, 401);
  });

  await ok("run returns 503 when no execution lane is configured", async () => {
    const noModel = createRouteDeps({ q, storage, kek: KEK, logSink: memorySink() });
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token, body: { inputs: {} } }, noModel);
    assert.equal(r.status, 503);
  });

  let firstRun = "";
  await ok("run executes, charges quota and records the ledger row", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token, body: { inputs: { quotes: ["a"] }, idempotencyKey: "idem-1" } }, deps);
    assert.equal(r.status, 200, `run failed: ${j(r.body)}`);
    const body = r.body as { ok: boolean; artifact: unknown; run: string; deduped: boolean };
    assert.equal(body.ok, true);
    assert.ok(body.artifact, "artifact missing");
    firstRun = body.run;
    assert.equal(body.deduped, false);
  });

  await ok("the same idempotency key does not charge or write twice", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token, body: { inputs: { quotes: ["a"] }, idempotencyKey: "idem-1" } }, deps);
    const body = r.body as { run: string; deduped: boolean };
    assert.equal(body.run, firstRun);
    assert.equal(body.deduped, true);
  });

  await ok("usage reports one run and the licence quota consumed", async () => {
    const r = await routeRecipes({ method: "GET", path: `/api/recipes/${hash}/license/usage`, token }, deps);
    assert.equal(r.status, 200);
    const u = (r.body as { usage: { runs: number; used: number; quota: number | null } }).usage;
    // two physical attempts, one ledger row (idempotent retry); quota charged twice
    assert.equal(u.runs, 1);
    assert.equal(u.used, 2);
    assert.equal(u.quota, 2);
  });

  await ok("quota exhaustion is a 402 on the next run", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token, body: { inputs: { quotes: ["b"] }, idempotencyKey: "idem-2" } }, deps);
    assert.equal(r.status, 402);
    assert.equal((r.body as { code: string }).code, "quota_exhausted");
  });

  await ok("revoked licence refuses the run with 403", async () => {
    const lic = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", body: { licenseeId: "agent_b", licenseeKind: "agent", quota: 5 } }, deps);
    const t = (lic.body as { token: string }).token;
    const id = (lic.body as { licenseId: string }).licenseId;
    await q(`UPDATE ar_recipe_license SET revoked_at = now() WHERE id = $1`, [id]);
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token: t, body: { inputs: {} } }, deps);
    assert.equal(r.status, 403);
    assert.equal((r.body as { code: string }).code, "license_revoked");
  });

  await ok("no prompt text anywhere in the run ledger", async () => {
    const rows = (await q(`SELECT verdict, inputs_hash FROM ar_recipe_run`)) as
      { verdict: unknown; inputs_hash: string }[];
    const text = j(rows);
    for (const phrase of recipe.discovery) {
      assert.equal(text.includes(phrase.slice(0, 24)), false, "ledger leaked prose");
    }
    assert.equal(rows.every((r) => /^[0-9a-f]{64}$/.test(r.inputs_hash)), true);
  });

  console.log(`\nRoutes: ${checks} checks passed\n`);
  await pool.end();
})().catch(async (e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  await pool.end();
  process.exit(1);
});
