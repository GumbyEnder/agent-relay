/**
 * S7 acceptance: recipe trust anchors + offline cache.
 *
 * The property under test is the one that matters for a shipped desktop client:
 * a bundle that verifies is NOT the same as a bundle signed by us. `verifyBundle`
 * trusts the key the bundle carries; `verifyTrustedBundle` additionally requires
 * that key to be pinned in this build.
 *
 * Run: npx tsx scripts/test-recipe-trust.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import {
  generateAuthorKey, sealBundle, verifyBundle,
  type Capability, type SealInput,
} from "../src/lib/recipe-seal/bundle";
import { readZip, makeZip } from "../src/lib/recipe-seal/zip";
import { verifyTrustedBundle, trustAnchorsFromEnv, defaultAnchors, type TrustAnchor } from "../src/lib/recipe-seal/trust";
import { putRecipe, listRecipes, readRecipe, cacheDir } from "../src/lib/recipe-seal/cache";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const recipe = RECIPES[0];
const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
const KEK = new Uint8Array(32).fill(7);

const capability: Capability = {
  inputs: [{ name: "quotes", type: "file[]", required: true }],
  outputs: ["comparison-table", "recommendation"],
  tools: recipe.tools,
  forbidden_tools: ["send", "email", "submit", "publish", "pay", "sign"],
  boundary_summary: "read-only; nothing is sent",
};

const SEMANTIC = {
  discovery: recipe.discovery,
  checklist: recipe.checklist,
  firstQuestion: recipe.firstQuestion,
  outputContract: recipe.outputContract,
  boundary: recipe.boundary,
};

function seal(authorKey: ReturnType<typeof generateAuthorKey>, overrides: Partial<SealInput> = {}) {
  return sealBundle({
    recipeId: recipe.id,
    version: "1.0.0",
    semantic: SEMANTIC,
    checksWasm: compiled.wasm,
    checks: compiled.manifest,
    capability,
    author: { id: "acct_beezilla", name: "BeeZilla", keyId: authorKey.keyId, privateKey: authorKey.privateKey },
    kek: KEK,
    createdAt: "2026-10-20T12:00:00.000Z",
    dek: new Uint8Array(32).fill(3),
    nonce: new Uint8Array(12).fill(5),
    dekNonce: new Uint8Array(12).fill(9),
    ...overrides,
  });
}

function mutateEntry(bytes: Uint8Array, name: string, mutate: (d: Uint8Array) => Uint8Array): Uint8Array {
  const entries = readZip(bytes);
  const list = [...entries.entries()].map(([n, d]) => ({ name: n, data: n === name ? mutate(d) : d }));
  return makeZip(list);
}

const ours = generateAuthorKey();
const theirs = generateAuthorKey();
const anchors: TrustAnchor[] = [{ keyId: ours.keyId, publicKey: ours.publicKeyRaw, label: "BeeZilla release key" }];

// ── trust ────────────────────────────────────────────────────────────────────
const good = seal(ours);
check("pinned publisher accepted", verifyTrustedBundle(good.bytes, anchors).trusted, verifyTrustedBundle(good.bytes, anchors).anchor);

const foreign = seal(theirs);
check("foreign bundle is internally valid", verifyBundle(foreign.bytes).ok);
const foreignVerdict = verifyTrustedBundle(foreign.bytes, anchors);
check("foreign bundle rejected as unpinned", !foreignVerdict.ok && foreignVerdict.reason === "UNPINNED_PUBLISHER", foreignVerdict.detail);

const noPins = verifyTrustedBundle(good.bytes, []);
check("a build with no pins trusts nothing", !noPins.ok && noPins.reason === "NO_TRUST_ANCHOR", noPins.detail);

const tampered = mutateEntry(good.bytes, "semantic.enc", (d) => {
  const copy = new Uint8Array(d);
  copy[0] = copy[0] ^ 0xff;
  return copy;
});
const tamperedVerdict = verifyTrustedBundle(tampered, anchors);
check("tampered bundle rejected before trust is considered", !tamperedVerdict.ok && !tamperedVerdict.trusted, String(tamperedVerdict.reason));

// env parsing
const envAnchors = trustAnchorsFromEnv(`${ours.keyId}:${ours.publicKeyRaw},${theirs.publicKeyRaw}`);
check("env pins parse keyId:base64 and bare keys", envAnchors.length === 2 && envAnchors[0].keyId === ours.keyId);
check("env pins are empty when unset", trustAnchorsFromEnv("").length === 0);

// pin FILE (what a release ships) — env is unset here, so resolution falls
// through to the file, exactly as it does in an installed app.
const pinDir = mkdtempSync(join(tmpdir(), "bz-pins-"));
const pinFile = join(pinDir, "publishers.json");
writeFileSync(pinFile, JSON.stringify({ publishers: [{ keyId: ours.keyId, publicKey: ours.publicKeyRaw, label: "release" }] }));
delete process.env.BZ_RECIPE_PUBLISHER_KEYS;
process.env.BZ_RECIPE_PUBLISHER_FILE = pinFile;
check("shipped pin file is loaded when env is unset", defaultAnchors().length === 1, defaultAnchors()[0]?.keyId);
check("bundle verifies against the shipped pin file", verifyTrustedBundle(good.bytes).trusted);
check("foreign bundle still refused via the pin file", verifyTrustedBundle(foreign.bytes).reason === "UNPINNED_PUBLISHER");

// An empty pin file must mean "trust nothing", never "trust anything".
writeFileSync(pinFile, JSON.stringify({ publishers: [] }));
check("an empty pin file trusts nothing", defaultAnchors().length === 0);
delete process.env.BZ_RECIPE_PUBLISHER_FILE;
rmSync(pinDir, { recursive: true, force: true });

// ── cache ────────────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "bz-recipe-cache-"));
const put = putRecipe(dataDir, good.bytes, anchors);
check("pinned bundle cached", put.ok && !!put.cached?.file, put.cached?.id);
const cachedFile = put.cached!.file;
check("cache file exists", existsSync(cachedFile));

const refused = putRecipe(dataDir, foreign.bytes, anchors);
check("unpinned bundle refused by the cache", !refused.ok && refused.verdict.reason === "UNPINNED_PUBLISHER");

const listed = listRecipes(dataDir, anchors);
check("cache lists the verified recipe", listed.valid.length === 1 && listed.rejected.length === 0, listed.valid[0]?.id);

const read = readRecipe(dataDir, recipe.id, undefined, anchors);
check("cache read returns bytes", read.ok && (read.bytes?.length ?? 0) > 0);

// A file on disk can be rewritten — the cache must not trust it blindly.
writeFileSync(cachedFile, tampered);
const afterTamper = listRecipes(dataDir, anchors);
check("rewritten cache entry rejected on read", afterTamper.valid.length === 0 && afterTamper.rejected.length === 1, afterTamper.rejected[0]?.reason);
check("rejected cache entry deleted", !existsSync(cachedFile));
check("cache dir still holds only the index", readdirSync(cacheDir(dataDir)).every((f) => f === "index.json"));

const missing = readRecipe(dataDir, recipe.id, undefined, anchors);
check("read after rejection reports NOT_CACHED", !missing.ok && missing.reason === "NOT_CACHED", missing.detail);

rmSync(dataDir, { recursive: true, force: true });
console.log(`\nrecipe trust E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
