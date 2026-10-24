/**
 * Route-level acceptance tests (verify tier + licence + run), against a real
 * Postgres and in-memory bundle storage.
 *
 * Run: DATABASE_URL_TEST=postgres://postgres:test@127.0.0.1:55432/recipes \
 *        npx tsx scripts/test-recipe-routes.ts
 */
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { compile } from "../src/lib/recipe-checks/seal";
import { defineRule, matches } from "../src/lib/recipe-checks/author";
import { generateAuthorKey, sealBundle, sha256Hex } from "../src/lib/recipe-seal/bundle";
import { canonicalise } from "../src/lib/recipe-seal/jcs";
import { makeZip, readZip } from "../src/lib/recipe-seal/zip";
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
    // Capability is a machine-readable descriptor, NOT a copy of the prose. The
    // seal path now refuses a manifest that reproduces the semantic half, and
    // these fixtures used to copy outputContract/boundary verbatim into it.
    inputs: [{ name: "quotes", type: "file[]", required: true }],
    outputs: ["comparison-table", "recommendation"], tools: recipe.tools,
    forbidden_tools: ["send", "email"], boundary_summary: "read-only; nothing is sent",
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
                   "0041_recipe_seal_tokens.sql", "0042_recipe_seal_metering.sql",
                   "0043_recipe_seal_structural_guards.sql"]) {
    await pool.query(readFileSync(join(process.cwd(), "migrations", f), "utf8"));
  }

  let modelCalls = 0;
  let deps: RouteDeps = createRouteDeps({
    q, storage, kek: KEK,
    model: async () => { modelCalls++; return j(GOOD); },
    anonymousLimiter: new RateLimiter(60, 60_000, () => 0),
    tokenLimiter: new RateLimiter(600, 60_000, () => 0),
    logSink: memorySink(),
  });

  let hash = "";

  await ok("publish is refused without an operator session", async () => {
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      body: { bundle: Buffer.from(sealed.bytes).toString("base64") } }, deps);
    // No session at all is 401 (signed_out); a session without `manage_keys` is 403.
    assert.equal(r.status, 401);
    assert.equal((r.body as { code: string }).code, "signed_out");
  });

  // ── the publish boundary is the gate that actually holds ───────────────────
  /** Take the genuine sealed bundle, mutate+re-sign its manifest, rebuild the zip. */
  function forge(mutate: (m: Record<string, unknown>) => void, checksOverride?: Uint8Array) {
    const m = JSON.parse(JSON.stringify(sealed.manifest)) as Record<string, unknown>;
    mutate(m);
    delete m.signature;
    const digest = sha256Hex(canonicalise(m));
    m.signature = sign(null, Buffer.from(digest, "hex"), key.privateKey).toString("base64");
    const entries = readZip(sealed.bytes);
    const checks = checksOverride ?? entries.get("checks.wasm")!;
    const bytes = makeZip([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(m)) },
      { name: "semantic.enc", data: entries.get("semantic.enc")! },
      { name: "checks.wasm", data: checks },
    ]);
    return { bytes, hash: sha256Hex(canonicalise({ ...m })) };
  }

  await ok("a hand-signed manifest that sealBundle refuses cannot be published", async () => {
    // sealBundle is a library function; publish is the door that serves the
    // manifest. A forged bundle used to verify (self-consistent signature), publish
    // 201, and serve the sealed boundary verbatim from GET /manifest.
    const forged = forge((m) => {
      (m.checks as Record<string, unknown>).codes = {
        ...((m.checks as { codes: Record<string, string> }).codes),
        C99: recipe.boundary,
      };
    });
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { bundle: Buffer.from(forged.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 422, `forged manifest published: ${r.status} ${j(r.body)}`);
    const hashOfForged = (await import("../src/lib/recipe-seal/bundle")).verifyBundle(forged.bytes).digest!;
    const served = await routeRecipes({ method: "GET", path: `/api/recipes/${hashOfForged}/manifest` }, deps);
    assert.equal(served.status, 404, "the refused manifest is being served anyway");
  });

  await ok("publish refuses the boundary split into reordered 3-token chunks", async () => {
    const chunks = ["never invents a", "price or a", "term no supplier", "is contacted and", "nothing is ordered"];
    const forged = forge((m) => {
      (m.capability as Record<string, unknown>).forbidden_tools = [chunks[2], chunks[0], chunks[4], chunks[1], chunks[3]];
    });
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { bundle: Buffer.from(forged.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 422, `permuted chunks published: ${r.status} ${j(r.body)}`);
  });

  await ok("a checks module that LOADS but throws when evaluated is refused at publish", async () => {
    // new RegExp() happens at evaluation, not load, so an invalid pattern sailed
    // through publish: verify then 500'd, batch threw uncaught, and run burned a
    // unit with no ledger row.
    const badRules = [defineRule({ id: "bad", code: "C99", severity: "error",
      description: "invalid pattern", expr: matches("sections[0].body", "(") })];
    const compiledBad = compile(badRules, { salt: new Uint8Array(8) });
    const throwing = sealBundle({
      recipeId: "throwing-checks", version: "1.0.0",
      semantic: { discovery: ["d"], boundary: "b" },
      checksWasm: compiledBad.wasm, checks: compiledBad.manifest,
      capability: { inputs: [], outputs: [], tools: [], forbidden_tools: [], boundary_summary: "read-only" },
      author: { id: "acct_author", name: "Author", keyId: key.keyId, privateKey: key.privateKey },
      kek: KEK, createdAt: "2026-10-23T00:00:00.000Z",
    });
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { bundle: Buffer.from(throwing.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 422, `throwing checks module published: ${r.status} ${j(r.body)}`);
    assert.equal((r.body as { code: string }).code, "invalid_checks");
  });

  await ok("a bundle whose checks module does not load is refused at publish", async () => {
    // Swapping the module after sealing is caught earlier (the AAD binds
    // semantic.enc to checks.sha256), so this seals junk properly: a producer can
    // seal any non-empty bytes, and that bundle used to 500 the free tier and burn
    // a paid unit per attempt.
    const junk = new Uint8Array(64).fill(0x41);
    const junkBundle = sealBundle({
      recipeId: "junk-checks", version: "1.0.0",
      semantic: { discovery: ["d"], boundary: "b" },
      checksWasm: junk, checks: { ...compiled.manifest, sha256: sha256Hex(junk) },
      capability: { inputs: [], outputs: [], tools: [], forbidden_tools: [], boundary_summary: "read-only" },
      author: { id: "acct_author", name: "Author", keyId: key.keyId, privateKey: key.privateKey },
      kek: KEK, createdAt: "2026-10-23T00:00:00.000Z",
    });
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { bundle: Buffer.from(junkBundle.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 422, `unloadable checks module published: ${r.status} ${j(r.body)}`);
    assert.equal((r.body as { code: string }).code, "invalid_checks");
  });

  await ok("publish accepts a verified bundle and stores it content-addressed", async () => {
    const r = await routeRecipes({ method: "POST", path: "/api/recipes", operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { bundle: Buffer.from(sealed.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 201, `publish failed: ${j(r.body)}`);
    hash = (r.body as { hash: string }).hash;
    assert.equal(hash, sealed.digest);
    assert.ok(await storage.get(`bundles/${hash}.srb`));
  });

  await ok("republishing the same version with different content is a 409, not a 500", async () => {
    // Independent review finding: the unique (recipe_id, version) violation
    // surfaced as an unhandled Postgres 23505 -> Nitro 500.
    const { sealBundle: reseal, generateAuthorKey: genKey } = await import("../src/lib/recipe-seal/bundle");
    const k2 = genKey();
    const other = reseal({
      recipeId: recipe.id, version: "1.0.0",   // same recipe + version ...
      semantic: { discovery: ["different content"], boundary: "b" },
      checksWasm: compiled.wasm, checks: compiled.manifest,
      capability: { inputs: [], outputs: [], tools: [], forbidden_tools: [], boundary_summary: "b" },
      author: { id: "acct_author", name: "Author", keyId: k2.keyId, privateKey: k2.privateKey },
      kek: new Uint8Array(32).fill(7),
      createdAt: "2026-10-22T00:00:00.000Z",   // ... different hash
    });
    const r = await routeRecipes({ method: "POST", path: "/api/recipes", operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { bundle: Buffer.from(other.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${j(r.body)}`);
    assert.equal((r.body as { code: string }).code, "version_exists");
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

  // ── authorisation: a signed-in viewer is not an operator ───────────────────
  await ok("a viewer cannot publish", async () => {
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      operatorId: "user_viewer", operatorRole: "viewer", authRequired: true,
      body: { bundle: Buffer.from(sealed.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 403, `viewer published: ${j(r.body)}`);
  });

  await ok("a viewer cannot mint a licence (the unlimited-quota probe)", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "user_viewer", operatorRole: "viewer", authRequired: true,
      body: { licenseeId: "attacker", quota: 1_000_000, priceCents: 0 } }, deps);
    assert.equal(r.status, 403, `viewer minted a licence: ${j(r.body)}`);
  });

  await ok("open mode is not a master key: authRequired=false alone is refused", async () => {
    // humanAuthRequired() is false whenever BETTER_AUTH_URL is unset, so relying
    // on it would hand publish to anyone if that var went missing. The routes
    // require an explicit opt-in AND a real role.
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      operatorId: null, operatorRole: null, authRequired: false,
      body: { bundle: Buffer.from(sealed.bytes).toString("base64") } }, deps);
    assert.equal(r.status, 401, `open mode let an anonymous publish through: ${j(r.body)}`);
  });

  await ok("open mode with an explicit opt-in and an admin role publishes", async () => {
    const openDeps = createRouteDeps({
      q, storage, kek: KEK, model: async () => j(GOOD), allowOpen: true,
      anonymousLimiter: new RateLimiter(60, 60_000, () => 0),
      tokenLimiter: new RateLimiter(600, 60_000, () => 0), logSink: memorySink(),
    });
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      operatorId: "dev_user", operatorRole: "admin", authRequired: false,
      body: { bundle: Buffer.from(sealed.bytes).toString("base64") } }, openDeps);
    // 201 on a fresh store, 409 if this recipe+version already exists: either way
    // the gate opened, which is what this check is about.
    assert.equal([201, 409].includes(r.status), true, `opt-in open mode refused: ${r.status} ${j(r.body)}`);
  });

  let token = "";
  await ok("operator issues a licence and receives the token exactly once", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { licenseeId: "agent_a", licenseeKind: "agent", quota: 2,
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
    // Two physical attempts, one ledger row, and ONE unit charged: the retry's
    // reservation is refunded when the duplicate is detected. (An earlier
    // revision asserted used === 2, i.e. it enshrined double-charging.)
    assert.equal(u.runs, 1);
    assert.equal(u.used, 1, `idempotent retry double-charged: used=${u.used}`);
    assert.equal(u.quota, 2);
  });

  await ok("a replayed idempotency key runs no inference and charges nothing", async () => {
    const lic = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { licenseeId: "agent_replay", licenseeKind: "agent", quota: 3 } }, deps);
    const t = (lic.body as { token: string }).token;
    const before = modelCalls;
    const first = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token: t, body: { inputs: { quotes: ["a"] }, idempotencyKey: "replay-1" } }, deps);
    assert.equal(first.status, 200);
    assert.equal(modelCalls, before + 1, "the first run did not call the model");
    // Replaying used to re-run inference and refund afterwards: free compute.
    for (let i = 0; i < 3; i++) {
      const again = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
        token: t, body: { inputs: { quotes: ["a"] }, idempotencyKey: "replay-1" } }, deps);
      assert.equal(again.status, 200);
      assert.equal((again.body as { deduped: boolean }).deduped, true);
      assert.equal((again.body as { replay?: boolean }).replay, true);
    }
    assert.equal(modelCalls, before + 1, `replays ran inference: ${modelCalls - before - 1} extra model calls`);
    const u = await routeRecipes({ method: "GET", path: `/api/recipes/${hash}/license/usage`, token: t }, deps);
    assert.equal((u.body as { usage: { used: number; runs: number } }).usage.used, 1);
    assert.equal((u.body as { usage: { runs: number } }).usage.runs, 1);
  });

  await ok("a replay at exact exhaustion returns the original result, not 402", async () => {
    const lic = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { licenseeId: "agent_last", licenseeKind: "agent", quota: 1 } }, deps);
    const t = (lic.body as { token: string }).token;
    const first = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token: t, body: { inputs: { quotes: ["a"] }, idempotencyKey: "last-1" } }, deps);
    assert.equal(first.status, 200);
    const again = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token: t, body: { inputs: { quotes: ["a"] }, idempotencyKey: "last-1" } }, deps);
    assert.equal(again.status, 200, `replay at exhaustion -> ${again.status} ${j(again.body)}`);
    assert.equal((again.body as { deduped: boolean }).deduped, true);
  });

  await ok("licence input is validated instead of reaching a 500", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["fractional quota", { quota: 1.5 }],
      ["astronomical quota", { quota: 1e20 }],
      ["unknown scope", { scopes: ["root"] }],
      ["garbage expiry", { expiresAt: "not-a-date" }],
      ["negative price", { priceCents: -1 }],
    ];
    for (const [label, extra] of bad) {
      const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
        operatorId: "op_1", operatorRole: "admin", authRequired: true,
        body: { licenseeId: "agent_bad", ...extra } }, deps);
      assert.equal(r.status, 400, `${label} -> ${r.status} ${j(r.body)}`);
    }
  });

  await ok("a licence cannot exceed the recipe's own quota", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { licenseeId: "agent_greedy", quota: 1_000_000, priceCents: 4 } }, deps);
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${j(r.body)}`);
    assert.equal((r.body as { code: string }).code, "quota_exceeds_recipe");
  });

  await ok("batch rejects non-object drafts like single verify does", async () => {
    const b = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify/batch`,
      body: { drafts: [null] } }, deps);
    assert.equal(b.status, 400, `batch accepted [null]: ${j(b.body)}`);
    const s1 = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify`,
      body: { draft: null } }, deps);
    assert.equal(s1.status, 400);
  });

  await ok("quota exhaustion is a 402 on the next run", async () => {
    // One unit remains after the refunded retry: this run spends it …
    const last = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token, body: { inputs: { quotes: ["b"] }, idempotencyKey: "idem-2" } }, deps);
    assert.equal(last.status, 200, `expected the final unit to be spendable: ${j(last.body)}`);
    // … and the next distinct run is refused.
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/run`,
      token, body: { inputs: { quotes: ["c"] }, idempotencyKey: "idem-3" } }, deps);
    assert.equal(r.status, 402);
    assert.equal((r.body as { code: string }).code, "quota_exhausted");
  });

  await ok("revoked licence refuses the run with 403", async () => {
    const lic = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", operatorRole: "admin", authRequired: true, body: { licenseeId: "agent_b", licenseeKind: "agent", quota: 5 } }, deps);
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

  // ── withdrawal must stop serving, not just hide the catalogue row ──────────
  await ok("batch verify is rate limited per draft, like single verify", async () => {
    // The batch route was a second door to the same oracle: a caller whose
    // single-verify budget was exhausted could send 50 drafts per call forever.
    const tight = createRouteDeps({
      q, storage, kek: KEK, model: async () => j(GOOD),
      anonymousLimiter: new RateLimiter(10, 60_000, () => 0),
      tokenLimiter: new RateLimiter(10, 60_000, () => 0), logSink: memorySink(),
    });
    const drafts = Array.from({ length: 20 }, () => ({ sections: [{ id: "s", title: "t", body: "b" }] }));
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify/batch`,
      body: { drafts }, callerKey: "1.2.3.4" }, tight);
    assert.equal(r.status, 429, `batch bypassed the limiter: ${r.status}`);
  });

  await ok("a content-addressed collision is a 409, not a 500", async () => {
    const colliding = {
      get: async () => null,
      put: async () => { throw new Error("content-addressed key collision: bundles/x.srb"); },
      has: async () => false,
    } as unknown as typeof storage;
    const cDeps = createRouteDeps({
      q, storage: colliding, kek: KEK, model: async () => j(GOOD),
      anonymousLimiter: new RateLimiter(60, 60_000, () => 0),
      tokenLimiter: new RateLimiter(600, 60_000, () => 0), logSink: memorySink(),
    });
    const r = await routeRecipes({ method: "POST", path: "/api/recipes",
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { bundle: Buffer.from(sealed.bytes).toString("base64") } }, cDeps);
    assert.equal(r.status, 409, `collision -> ${r.status} ${j(r.body)}`);
    assert.equal((r.body as { code: string }).code, "bundle_collision");
  });

  await ok("single verify and batch share one budget", async () => {
    // Different key namespaces made the batch an unlimited second door.
    const shared = createRouteDeps({
      q, storage, kek: KEK, model: async () => j(GOOD),
      anonymousLimiter: new RateLimiter(5, 60_000, () => 0),
      tokenLimiter: new RateLimiter(5, 60_000, () => 0), logSink: memorySink(),
    });
    const draft = { sections: [{ id: "s", title: "t", body: "b" }] };
    for (let i = 0; i < 5; i++) {
      const okr = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify`,
        body: { draft }, callerKey: "9.9.9.9" }, shared);
      assert.equal(okr.status, 200, `single ${i} -> ${okr.status}`);
    }
    const exhausted = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify`,
      body: { draft }, callerKey: "9.9.9.9" }, shared);
    assert.equal(exhausted.status, 429, "single verify was not limited");
    const batch = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify/batch`,
      body: { drafts: [draft] }, callerKey: "9.9.9.9" }, shared);
    assert.equal(batch.status, 429, "batch used a separate budget from single verify");
  });

  await ok("scopes must be an array, not a string", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { licenseeId: "x", scopes: "run" } }, deps);
    assert.equal(r.status, 400, `scopes string granted ${r.status}`);
  });

  await ok("an unknown licensee kind is a 400, not a 500", async () => {
    const r = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/license`,
      operatorId: "op_1", operatorRole: "admin", authRequired: true,
      body: { licenseeId: "x", licenseeKind: "root" } }, deps);
    assert.equal(r.status, 400, `licenseeKind root -> ${r.status} ${j(r.body)}`);
  });

  await ok("a revoked bundle stops serving verify, batch and manifest", async () => {
    await q(`UPDATE ar_recipe_bundle SET status = 'revoked' WHERE hash = $1`, [hash]);
    const draft = { sections: [{ id: "s1", title: "T", body: "B" }] };
    const v = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify`, body: { draft } }, deps);
    assert.equal(v.status, 410, `verify served a withdrawn recipe: ${j(v.body)}`);
    const b = await routeRecipes({ method: "POST", path: `/api/recipes/${hash}/verify/batch`, body: { drafts: [draft] } }, deps);
    assert.equal(b.status, 410);
    const m = await routeRecipes({ method: "GET", path: `/api/recipes/${hash}/manifest` }, deps);
    assert.equal(m.status, 410, `manifest served a withdrawn recipe: ${j(m.body)}`);
  });

  console.log(`\nRoutes: ${checks} checks passed\n`);
  await pool.end();
})().catch(async (e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  await pool.end();
  process.exit(1);
});
