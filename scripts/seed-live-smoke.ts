/**
 * Seed a sealed bundle for a LIVE HTTP smoke test.
 *
 * Writes the bundle blobs into the server's storage dir and registers the row in
 * the test Postgres, so the running server can serve GET manifest and POST verify
 * over real HTTP. Not part of the product; a verification harness.
 *
 * Run: DATABASE_URL_TEST=postgres://postgres:test@127.0.0.1:55432/recipes \
 *        npx tsx scripts/seed-live-smoke.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { generateAuthorKey, sealBundle } from "../src/lib/recipe-seal/bundle";
import { FsStorage, bundleKey, semanticKey, checksKey } from "../src/lib/recipe-seal/storage";
import { publishBundle } from "../src/lib/recipe-seal/registry";
import type { QueryFn } from "../src/lib/recipe-seal/registry";

const url = process.env.DATABASE_URL_TEST;
if (!url) { console.error("DATABASE_URL_TEST required"); process.exit(2); }

const pool = new Pool({ connectionString: url, max: 4 });
const q: QueryFn = async (text, params) => (await pool.query(text, params as unknown[])).rows as never;

(async () => {
  for (const f of ["0039_recipe_seal_bundles.sql", "0040_recipe_seal_licenses.sql",
                   "0041_recipe_seal_tokens.sql", "0042_recipe_seal_metering.sql"]) {
    await pool.query(readFileSync(join(process.cwd(), "migrations", f), "utf8"));
  }

  const recipe = RECIPES[0];
  const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
  const key = generateAuthorKey();
  const sealed = sealBundle({
    recipeId: recipe.id,
    version: "1.0.2-smoke",
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
    kek: new Uint8Array(32).fill(7),
    pricing: { amount_cents: 4 },
    createdAt: "2026-10-21T00:00:00.000Z",
  });

  const storage = new FsStorage(process.env.RECIPE_SEAL_STORAGE_DIR ?? ".data/recipe-seal");
  const parts = sealed.bytes;
  await storage.put(bundleKey(sealed.digest), parts);
  await storage.put(semanticKey(sealed.digest), (await import("../src/lib/recipe-seal/bundle")).partsOf(parts)!.semanticEnc);
  await storage.put(checksKey(sealed.digest), compiled.wasm);

  await publishBundle(q, {
    hash: sealed.digest, recipeId: recipe.id, version: "1.0.2-smoke", authorId: "acct_author",
    manifest: sealed.manifest, bundleRef: bundleKey(sealed.digest),
    semanticRef: semanticKey(sealed.digest), checksRef: checksKey(sealed.digest),
  });

  console.log(`HASH=${sealed.digest}`);
  console.log(`CODES=${Object.keys(compiled.manifest.codes).sort().join(",")}`);
  await pool.end();
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
