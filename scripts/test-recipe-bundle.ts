/**
 * Step 2 acceptance tests: seal → verify round trip, determinism, tamper matrix,
 * key handling, and "no plaintext in the artifact".
 *
 * Run: npx tsx scripts/test-recipe-bundle.ts
 */
import { randomBytes, sign } from "node:crypto";
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import {
  generateAuthorKey, inspectBundle, openSemantic, partsOf, sealBundle, sha256Hex, verifyBundle,
  type Capability, type SealInput,
} from "../src/lib/recipe-seal/bundle";
import { readZip, makeZip } from "../src/lib/recipe-seal/zip";
import { canonicalise } from "../src/lib/recipe-seal/jcs";

const j = (v: unknown) => JSON.stringify(v);
const assert = {
  ok(cond: unknown, msg = "expected truthy"): void { if (!cond) throw new Error(msg); },
  equal(a: unknown, b: unknown, msg = "equal"): void {
    if (j(a) !== j(b)) throw new Error(`${msg}: ${j(a)} !== ${j(b)}`);
  },
  throws(fn: () => void, msg = "expected throw"): void {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new Error(msg);
  },
};
let checks = 0;
const ok = (name: string, fn: () => void) => { fn(); checks++; console.log(`  ok  ${name}`); };

const recipe = RECIPES[0];
const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
const key = generateAuthorKey();
const KEK = new Uint8Array(32).fill(7);

const capability: Capability = {
  inputs: [{ name: "quotes", type: "file[]", required: true }],
  outputs: recipe.outputContract,
  tools: recipe.tools,
  forbidden_tools: ["send", "email", "submit", "publish", "pay", "sign"],
  boundary_summary: recipe.boundary,
};

const SEMANTIC = {
  discovery: recipe.discovery,
  checklist: recipe.checklist,
  firstQuestion: recipe.firstQuestion,
  outputContract: recipe.outputContract,
  boundary: recipe.boundary,
};

function input(overrides: Partial<SealInput> = {}): SealInput {
  return {
    recipeId: recipe.id,
    version: "1.0.0",
    semantic: SEMANTIC,
    checksWasm: compiled.wasm,
    checks: compiled.manifest,
    capability,
    author: { id: "acct_test", name: "Test author", keyId: key.keyId, privateKey: key.privateKey },
    kek: KEK,
    createdAt: "2026-10-20T12:00:00.000Z",
    dek: new Uint8Array(32).fill(3),
    nonce: new Uint8Array(12).fill(5),
    dekNonce: new Uint8Array(12).fill(9),
    ...overrides,
  };
}

function mutateEntry(bytes: Uint8Array, name: string, mutate: (data: Uint8Array) => Uint8Array): Uint8Array {
  const entries = readZip(bytes);
  const list = [...entries.entries()].map(([n, d]) => ({ name: n, data: n === name ? mutate(d) : d }));
  return makeZip(list);
}

function editManifest(bytes: Uint8Array, edit: (m: Record<string, unknown>) => void, reorder = false): Uint8Array {
  const entries = readZip(bytes);
  const m = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")!)) as Record<string, unknown>;
  edit(m);
  let json: string;
  if (reorder) {
    // Reverse key order deliberately: canonicalisation must neutralise this.
    const rev: Record<string, unknown> = {};
    for (const k of Object.keys(m).reverse()) rev[k] = m[k];
    json = JSON.stringify(rev);
  } else {
    json = JSON.stringify(m);
  }
  const list = [...entries.entries()].map(([n, d]) => ({
    name: n, data: n === "manifest.json" ? new TextEncoder().encode(json) : d,
  }));
  return makeZip(list);
}

console.log("\nStep 2 — bundle compiler and signer\n");

const sealed = sealBundle(input());

ok("seal → verify round trip", () => {
  assert.equal(sealed.bytes.length > 0, true);
  const r = verifyBundle(sealed.bytes);
  assert.equal(r.ok, true, `verify failed: ${r.reason} ${r.detail ?? ""}`);
  assert.equal(r.manifest?.id, recipe.id);
  assert.equal(r.manifest?.protocol, "recipe-seal/1");
});

ok("digest is stable and equals the returned digest", () => {
  const r = verifyBundle(sealed.bytes);
  assert.equal(r.digest, sealed.digest);
  assert.equal(sealed.digest.length, 64);
});

ok("semantic half round-trips through the DEK", () => {
  const parts = partsOf(sealed.bytes);
  assert.ok(parts);
  const opened = openSemantic(parts!, KEK);
  assert.equal(opened.ok, true, `open failed: ${opened.ok ? "" : opened.reason}`);
  if (opened.ok) assert.equal(opened.semantic, SEMANTIC);
});

ok("determinism: identical inputs produce byte-identical bundles", () => {
  const a = sealBundle(input());
  const b = sealBundle(input());
  assert.equal(sha256Hex(a.bytes), sha256Hex(b.bytes));
  assert.equal(a.digest, b.digest);
});

ok("tamper: flipping a byte in checks.wasm is detected", () => {
  const bad = mutateEntry(sealed.bytes, "checks.wasm", (d) => { const c = new Uint8Array(d); c[20] ^= 0xff; return c; });
  const r = verifyBundle(bad);
  assert.equal(r.reason, "HASH_MISMATCH_CHECKS");
});

ok("tamper: flipping a byte in semantic.enc is detected", () => {
  const bad = mutateEntry(sealed.bytes, "semantic.enc", (d) => { const c = new Uint8Array(d); c[13] ^= 0xff; return c; });
  const r = verifyBundle(bad);
  assert.equal(r.reason, "HASH_MISMATCH_SEMANTIC");
});

ok("tamper: editing the version invalidates the signature", () => {
  const bad = editManifest(sealed.bytes, (m) => { m.version = "9.9.9"; });
  assert.equal(verifyBundle(bad).reason, "BAD_SIGNATURE");
});

ok("tamper: editing pricing invalidates the signature", () => {
  const bad = editManifest(sealed.bytes, (m) => {
    // must be an actual change: the default is already 0
    (m.pricing as Record<string, unknown>).amount_cents = 999;
  });
  assert.equal(verifyBundle(bad).reason, "BAD_SIGNATURE");
});

ok("tamper: replacing the nonce invalidates the signature", () => {
  const bad = editManifest(sealed.bytes, (m) => {
    (m.semantic as Record<string, unknown>).nonce = Buffer.alloc(12, 1).toString("base64");
  });
  assert.equal(verifyBundle(bad).reason, "BAD_SIGNATURE");
});

ok("canonicalisation: reordering manifest keys does NOT invalidate the bundle", () => {
  // This is the point of JCS — key order is not part of the document's identity.
  const reordered = editManifest(sealed.bytes, () => {}, true);
  const r = verifyBundle(reordered);
  assert.equal(r.ok, true, `reordered manifest failed: ${r.reason}`);
});

ok("tamper: a semantic blob lifted from another bundle fails to decrypt (AAD)", () => {
  const other = sealBundle(input({ version: "2.0.0" }));
  const otherParts = partsOf(other.bytes)!;
  const thisParts = partsOf(sealed.bytes)!;
  const crossed = { ...thisParts, semanticEnc: otherParts.semanticEnc };
  const opened = openSemantic(crossed, KEK);
  assert.equal(opened.ok, false);
  assert.ok(opened.ok === false && ["SEMANTIC_AAD_MISMATCH", "SEMANTIC_DECRYPT_FAILED"].includes(opened.reason));
});

ok("wrong KEK fails closed (no partial plaintext)", () => {
  const parts = partsOf(sealed.bytes)!;
  const opened = openSemantic(parts, new Uint8Array(32).fill(1));
  assert.equal(opened.ok, false);
  assert.ok(opened.ok === false && opened.reason === "DEK_UNWRAP_FAILED");
});

ok("refuses to seal a recipe with no checks module", () => {
  assert.throws(() => sealBundle(input({ checksWasm: new Uint8Array(0), checks: { ...compiled.manifest, sha256: "" } })));
});

ok("inspect returns the manifest and never the prose", () => {
  const m = inspectBundle(sealed.bytes);
  assert.ok(m);
  const text = j(m);
  for (const phrase of recipe.discovery) {
    assert.equal(text.includes(phrase), false, `manifest leaks discovery text: ${phrase}`);
  }
  assert.equal(text.includes("discovery"), false, "manifest has a discovery field");
});

ok("the bundle carries no readable semantic text", () => {
  const latin = new TextDecoder("latin1").decode(sealed.bytes);
  for (const phrase of recipe.discovery) {
    const probe = phrase.slice(0, 24).toLowerCase();
    assert.equal(latin.toLowerCase().includes(probe), false, `plaintext in bundle: ${probe}`);
  }
});

ok("missing checks entry is rejected", () => {
  const entries = readZip(sealed.bytes);
  const without = makeZip([...entries.entries()]
    .filter(([n]) => n !== "checks.wasm")
    .map(([name, data]) => ({ name, data })));
  assert.equal(verifyBundle(without).reason, "NO_CHECKS");
});

ok("non-zip input is rejected as NOT_ZIP", () => {
  assert.equal(verifyBundle(randomBytes(64)).reason, "NOT_ZIP");
});

// A self-signed manifest is only trustworthy if it is in shape: otherwise
// "verified" means merely "self-consistent" and a publisher can sign a manifest
// carrying prose under an invented key. Review probe: {"guidance": "ASK IF NEEDED…"}.
ok("a correctly SIGNED manifest with an invented key is rejected as MANIFEST_SCHEMA", () => {
  const author = generateAuthorKey();
  const sealed = sealBundle({
    recipeId: "r-shape", version: "1.0.0",
    semantic: { discovery: ["d"], boundary: "b" },
    checksWasm: compiled.wasm, checks: compiled.manifest,
    capability: { inputs: [], outputs: [], tools: [], forbidden_tools: [], boundary_summary: "b" },
    author: { id: "acct_author", name: "Author", keyId: author.keyId, privateKey: author.privateKey },
    kek: new Uint8Array(32).fill(3),
    createdAt: "2026-10-23T00:00:00.000Z",
  });
  const smuggled: Record<string, unknown> = {
    ...sealed.manifest,
    guidance: "ASK IF NEEDED: which quotes are in play. BOUNDARY: never invent a price.",
  };
  delete smuggled.signature;
  const digest = sha256Hex(canonicalise(smuggled));
  smuggled.signature = sign(null, Buffer.from(digest, "hex"), author.privateKey).toString("base64");
  // Rebuild from the original entries so only manifest.json differs.
  const entries = readZip(sealed.bytes);
  const rebuilt = makeZip([
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(smuggled)) },
    { name: "semantic.enc", data: entries.get("semantic.enc")! },
    { name: "checks.wasm", data: entries.get("checks.wasm")! },
  ]);
  const verdict = verifyBundle(rebuilt);
  assert.equal(verdict.ok, false, "a manifest with an invented key verified");
  assert.equal(verdict.reason, "MANIFEST_SCHEMA");
  assert.equal(String(verdict.detail).includes("guidance"), true);
});

console.log(`\nStep 2: ${checks} checks passed\n`);
