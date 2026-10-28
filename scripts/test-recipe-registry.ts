/**
 * Step 4 acceptance tests against a REAL Postgres.
 *
 * Boots nothing itself: expects DATABASE_URL_TEST to point at a disposable
 * database (see scripts/recipe-seal-pg.sh). Quota correctness cannot be proven
 * in memory, which is why this suite runs against the server.
 *
 * Run: DATABASE_URL_TEST=postgres://postgres:test@127.0.0.1:55432/recipes \
 *        npx tsx scripts/test-recipe-registry.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import {
  authenticate, getBundle, getUsage, issueLicense, publishBundle, recordRun,
  reserveRun, revokeBundle, revokeLicense, splitCost, type QueryFn,
} from "../src/lib/recipe-seal/registry";
import { sha256Hex } from "../src/lib/recipe-seal/bundle";

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
if (!url) {
  console.error("DATABASE_URL_TEST is required (see scripts/recipe-seal-pg.sh)");
  process.exit(2);
}

const pool = new Pool({ connectionString: url, max: 24 });
const q: QueryFn = async (text, params) => (await pool.query(text, params as unknown[])).rows as never;

async function migrate() {
  for (const f of ["0039_recipe_seal_bundles.sql", "0040_recipe_seal_licenses.sql",
                   "0041_recipe_seal_tokens.sql", "0042_recipe_seal_metering.sql",
                   "0043_recipe_seal_structural_guards.sql", "0044_recipe_listing.sql"]) {
    const sql = readFileSync(join(process.cwd(), "migrations", f), "utf8");
    await pool.query(sql);
  }
}

async function reset() {
  await pool.query(`DROP VIEW IF EXISTS ar_recipe_metering;
    DROP TABLE IF EXISTS ar_recipe_run, ar_recipe_token, ar_recipe_license, ar_recipe_bundle CASCADE;`);
}

// Realistic shape: codes live under `checks`, and there are no keys outside the
// protocol's allow-list (0043 rejects anything else, including the old fixture's
// top-level `codes`).
const MANIFEST = { protocol: "recipe-seal/1", id: "quote-comparison", version: "1.0.0",
  created_at: "2026-10-27T12:00:00.000Z",
  // A published row must be shelf-ready: 0044 makes the listing structural, so a
  // manifest without one cannot reach the table at all.
  listing: { title: "Quote Comparison", description: "Compare contractor bids.", 
             updated_at: "2026-10-27T12:00:00.000Z", price_honey_drops: 0 },
  checks: { module: "checks.wasm", sha256: "0".repeat(64), rules: 24, codes: { C01: "x" }, engine: "srb-vm/1" } };

(async () => {
  console.log("\nStep 4 — registry, licensing, metering (real Postgres)\n");
  await reset();
  await migrate();

  const hashA = sha256Hex("bundle-a");
  const hashB = sha256Hex("bundle-b");

  await ok("migrations apply and are re-runnable", async () => {
    await migrate();
    const rows = await q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'ar_recipe_%' ORDER BY 1`);
    const names = rows.map((r) => r.table_name);
    for (const t of ["ar_recipe_bundle", "ar_recipe_license", "ar_recipe_token", "ar_recipe_run"]) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });

  await ok("publish is content-addressed and idempotent", async () => {
    const a = await publishBundle(q, { hash: hashA, recipeId: "quote-comparison", version: "1.0.0",
      authorId: "acct_1", manifest: MANIFEST, bundleRef: "s3://b/a.srb",
      semanticRef: "s3://b/a.enc", checksRef: "s3://b/a.wasm" });
    const again = await publishBundle(q, { hash: hashA, recipeId: "quote-comparison", version: "1.0.0",
      authorId: "acct_1", manifest: MANIFEST, bundleRef: "s3://b/a.srb",
      semanticRef: "s3://b/a.enc", checksRef: "s3://b/a.wasm" });
    assert.equal(a.hash, hashA);
    assert.equal(again.hash, hashA);
    const count = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ar_recipe_bundle`);
    assert.equal(Number(count[0].n), 1);
  });

  await ok("a second version of the same recipe is a new hash, not an update", async () => {
    await publishBundle(q, { hash: hashB, recipeId: "quote-comparison", version: "1.0.1",
      authorId: "acct_1", manifest: MANIFEST, bundleRef: "s3://b/b.srb",
      semanticRef: "s3://b/b.enc", checksRef: "s3://b/b.wasm" });
    const count = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ar_recipe_bundle`);
    assert.equal(Number(count[0].n), 2);
  });

  const issued = await issueLicense(q, { bundleHash: hashA, licenseeKind: "agent",
    licenseeId: "agent_x", quota: 10, priceCents: 4 });

  await ok("licence issues an opaque token; only the hash is stored", async () => {
    assert.ok(issued.tokenSecret.startsWith("rcp_"));
    const rows = await q<{ token_hash: string }>(`SELECT token_hash FROM ar_recipe_token`);
    assert.equal(rows[0].token_hash.length, 64);
    assert.equal(rows[0].token_hash.includes(issued.tokenSecret), false);
  });

  await ok("token authenticates and carries the granted scopes", async () => {
    const auth = await authenticate(q, issued.tokenSecret, "run");
    assert.ok(auth.ok, `auth failed: ${auth.ok ? "" : auth.reason}`);
    if (auth.ok) {
      assert.equal(auth.bundleHash, hashA);
      assert.equal(auth.scopes, ["run", "verify"]);
    }
  });

  await ok("a bad token is rejected, never matched loosely", async () => {
    const auth = await authenticate(q, "rcp_not_a_real_token", "run");
    assert.equal(auth.ok, false);
    assert.ok(auth.ok === false && auth.reason === "invalid_token");
  });

  await ok("scope is enforced (usage scope not granted)", async () => {
    const auth = await authenticate(q, issued.tokenSecret, "usage");
    assert.ok(auth.ok === false && auth.reason === "scope_missing");
  });

  await ok("QUOTA: 50 concurrent reserves against quota 10 issue exactly 10", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => reserveRun(q, issued.licenseId)));
    const granted = results.filter((r) => r.ok).length;
    const exhausted = results.filter((r) => !r.ok && r.reason === "quota_exhausted").length;
    assert.equal(granted, 10, `granted ${granted}`);
    assert.equal(exhausted, 40, `exhausted ${exhausted}`);
    const lic = await q<{ used: number }>(`SELECT used FROM ar_recipe_license WHERE id=$1`, [issued.licenseId]);
    assert.equal(lic[0].used, 10);
  });

  await ok("idempotency: one key costs one row and one charge", async () => {
    const before = await getUsage(q, issued.licenseId);
    const a = await recordRun(q, { licenseId: issued.licenseId, bundleHash: hashA, idemKey: "k1",
      inputsHash: "i1", verdict: { ok: true, codes: [], warnings: [] }, costCents: 4 });
    const b = await recordRun(q, { licenseId: issued.licenseId, bundleHash: hashA, idemKey: "k1",
      inputsHash: "i1", verdict: { ok: true, codes: [], warnings: [] }, costCents: 4 });
    assert.equal(b.deduped, true);
    assert.equal(a.id, b.id);
    const after = await getUsage(q, issued.licenseId);
    assert.equal(after.runs, before.runs + 1);
    assert.equal(after.costCents, before.costCents + 4);
  });

  await ok("metering view agrees with the ledger", async () => {
    const rows = await q<{ runs: string; cost_cents: number }>(
      `SELECT runs::text, cost_cents FROM ar_recipe_metering WHERE license_id = $1`, [issued.licenseId]);
    const usage = await getUsage(q, issued.licenseId);
    assert.equal(Number(rows[0].runs), usage.runs);
    assert.equal(Number(rows[0].cost_cents), usage.costCents);
  });

  await ok("isolation: licence B's usage does not see licence A's runs", async () => {
    const b = await issueLicense(q, { bundleHash: hashB, licenseeKind: "account",
      licenseeId: "acct_other", quota: 5 });
    const usage = await getUsage(q, b.licenseId);
    assert.equal(usage.runs, 0);
    assert.equal(usage.used, 0);
  });

  await ok("revocation takes effect immediately", async () => {
    const lic = await issueLicense(q, { bundleHash: hashA, licenseeKind: "agent",
      licenseeId: "agent_rev", quota: 5 });
    assert.equal((await reserveRun(q, lic.licenseId)).ok, true);
    assert.equal(await revokeLicense(q, lic.licenseId, "operator"), true);
    const after = await reserveRun(q, lic.licenseId);
    assert.ok(after.ok === false && after.reason === "revoked");
    const auth = await authenticate(q, lic.tokenSecret, "run");
    assert.ok(auth.ok === false && auth.reason === "revoked");
  });

  await ok("expiry is enforced, not a 500", async () => {
    const lic = await issueLicense(q, { bundleHash: hashA, licenseeKind: "agent",
      licenseeId: "agent_exp", quota: 5, expiresAt: new Date(Date.now() - 1000) });
    const r = await reserveRun(q, lic.licenseId);
    assert.ok(r.ok === false && r.reason === "expired");
  });

  await ok("revoking the bundle blocks new runs through existing licences", async () => {
    const lic = await issueLicense(q, { bundleHash: hashB, licenseeKind: "agent",
      licenseeId: "agent_bundle_rev", quota: 5 });
    await revokeBundle(q, hashB);
    const auth = await authenticate(q, lic.tokenSecret, "run");
    assert.ok(auth.ok === false && auth.reason === "bundle_revoked");
    const b = await getBundle(q, hashB);
    assert.equal(b?.status, "revoked");
  });

  await ok("the schema cannot store prose: no prompt/text/draft columns", async () => {
    const rows = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name LIKE 'ar_recipe_%'`);
    for (const r of rows) {
      assert.equal(["prompt", "text", "draft", "semantic_text"].includes(r.column_name), false,
        `unexpected column ${r.column_name}`);
    }
  });

  // 0039's guard was a naming ban: it rejected semantic_text/prompt/discovery and
  // let {"guidance": …} through. 0043 replaces it with a key allow-list, so this
  // asserts the actual attack the reviewer used, not a column-name lookup.
  await ok("a manifest carrying prose under an invented key is rejected by the DB", async () => {
    let threw = false;
    try {
      await q(`UPDATE ar_recipe_bundle SET manifest = manifest || $2::jsonb WHERE hash = $1`,
        [hashA, JSON.stringify({ guidance: "ASK IF NEEDED: which quotes are in play. BOUNDARY: never invent a price." })]);
    } catch { threw = true; }
    assert.ok(threw, "a manifest with an unexpected top-level key was stored");
    const still = await q<{ manifest: unknown }>(`SELECT manifest FROM ar_recipe_bundle WHERE hash = $1`, [hashA]);
    assert.equal(JSON.stringify(still[0]?.manifest ?? {}).includes("ASK IF NEEDED"), false);
  });

  await ok("quota cannot be overspent, even by a direct UPDATE", async () => {
    let threw = false;
    try {
      await q(`UPDATE ar_recipe_license SET used = quota + 1 WHERE id = $1`, [issued.licenseId]);
    } catch { threw = true; }
    assert.ok(threw, "used > quota was accepted by the database");
  });

  await ok("the run verdict constraint rejects prose payloads", async () => {
    let threw = false;
    try {
      await q(`INSERT INTO ar_recipe_run (id, license_id, bundle_hash, inputs_hash, verdict)
               VALUES ('run_bad', $1, $2, 'i', '{"ok":true,"codes":[],"prompt":"secret"}'::jsonb)`,
        [issued.licenseId, hashA]);
    } catch { threw = true; }
    assert.ok(threw, "prose in verdict was accepted");
  });

  await ok("split arithmetic is integer and sums to the charge", async () => {
    assert.equal(splitCost(4, { author: 7000, platform: 3000 }), { author: 2, platform: 2 });
    assert.equal(splitCost(101, { author: 7000, platform: 3000 }), { author: 70, platform: 31 });
    assert.equal(splitCost(0, { author: 7000, platform: 3000 }), { author: 0, platform: 0 });
  });

  console.log(`\nStep 4: ${checks} checks passed\n`);
  await pool.end();
})().catch(async (err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
