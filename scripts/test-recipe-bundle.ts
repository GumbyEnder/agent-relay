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
import { compile, loadRules } from "../src/lib/recipe-checks/seal";

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
  // Machine-readable descriptor only — never the prose itself (the seal path
  // refuses a manifest that reproduces the semantic half).
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
    // Real prose, not a stub: a sealed half too short to guard is refused
    // outright (semantic_payload:unsearchable), so fixtures must be realistic.
    semantic: { discovery: ["which quotes are in play"], boundary: "never invent a price or a payment term" },
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

// ── seal gate: the manifest must not carry the prose it seals ────────────────
ok("seal refuses a manifest that reproduces the sealed boundary", () => {
  let threw = "";
  try {
    sealBundle(input({ capability: { ...capability, boundary_summary: recipe.boundary } }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `seal accepted prose in the manifest: ${threw}`);
});

ok("seal refuses capability.outputs copied from the output contract", () => {
  let threw = "";
  try {
    sealBundle(input({ capability: { ...capability, outputs: recipe.outputContract } }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `seal accepted prose outputs: ${threw}`);
});

// ── the gate covers every field, every width, and split secrets ──────────────
const gateCases: Array<[string, (cap: Record<string, unknown>) => Record<string, unknown>]> = [
  ["4-token summary", () => ({ ...capability, boundary_summary: "Never invents a price." })],
  ["secret split across two fields", () => ({ ...capability,
    boundary_summary: "Never invents a price", forbidden_tools: ["or a term. No supplier is contacted"] })],
];
for (const [label, build] of gateCases) {
  ok(`seal refuses the sealed boundary as ${label}`, () => {
    let threw = "";
    try { sealBundle(input({ capability: build(capability) as never })); }
    catch (err) { threw = String(err instanceof Error ? err.message : err); }
    assert.equal(threw.includes("leaks_sealed_text"), true, `seal accepted ${label}: ${threw}`);
  });
}

ok("seal refuses a boundary hidden in checks.codes", () => {
  // checks.codes used to be excluded from the gate, so a rule description could
  // carry the boundary and be served in the public manifest.
  let threw = "";
  try {
    sealBundle(input({ checks: { ...compiled.manifest,
      codes: { ...compiled.manifest.codes, C99: recipe.boundary } } }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `seal accepted codes prose: ${threw}`);
  assert.equal(threw.includes("checks.codes.C99"), true, `the gate did not name the field: ${threw}`);
});

ok("seal refuses the boundary split into reordered 3-token chunks", () => {
  // The concatenation pass joins fields in walk order, so permuting short chunks
  // beat it: 15 tokens in 3-token chunks, reordered, contains no 4-gram match but
  // reassembles the sentence. The vocabulary pass is order-independent.
  const chunks = ["never invents a", "price or a", "term no supplier", "is contacted and", "nothing is ordered"];
  const shuffled = [chunks[2], chunks[0], chunks[4], chunks[1], chunks[3]];
  let threw = "";
  try { sealBundle(input({ capability: { ...capability, forbidden_tools: shuffled } })); }
  catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `permuted chunks sealed: ${threw}`);
  assert.equal(threw.includes("<vocabulary>"), true, `the vocabulary pass did not fire: ${threw}`);
});

ok("seal refuses a split_bp that over-allocates", () => {
  let threw = "";
  try { sealBundle(input({ pricing: { split_bp: { author: 10000, platform: 10000 } } })); }
  catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("pricing.split_bp:over_allocated"), true, `over-allocation sealed: ${threw}`);
});

ok("seal refuses a rules count below the number of codes it ships", () => {
  let threw = "";
  try { sealBundle(input({ checks: { ...compiled.manifest, rules: 1 } })); }
  catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("checks.rules:below_code_count"), true, `rules below codes sealed: ${threw}`);
});

// ── round-6: malformed expressions and short/array boundaries ────────────────
ok("a compiled program with a malformed expression is refused at load", () => {
  // `{op:"and", args:"not-an-array"}` parses as JSON, loads, then throws on
  // `.every` at evaluation — which used to publish 201 and burn model spend.
  let threw = "";
  try {
    const bad = [{ id: "bad", code: "C99", severity: "block", description: "d",
      expr: { op: "and", args: "not-an-array" } }] as never;
    const badCompiled = compile(bad, { salt: new Uint8Array(8) });
    loadRules(badCompiled.wasm);
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.length > 0, true, "a malformed expression loaded without error");
  assert.equal(/args|expression/i.test(threw), true, `unhelpful error: ${threw}`);
});

ok("seal refuses a SHORT boundary split into 2-token chunks", () => {
  // 4 content tokens: below the 5-token threshold that used to skip the
  // vocabulary pass, and split so no 4-gram survives.
  const chunks = ["price term", "never invents"];
  let threw = "";
  try {
    sealBundle(input({
      semantic: { discovery: ["d"], boundary: "never invents price term" } as never,
      capability: { ...capability, forbidden_tools: chunks },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `short boundary split sealed: ${threw}`);
});

ok("seal refuses a boundary supplied as an array of single words", () => {
  // An array of one-word strings produced no n-grams at all, emptying the guard
  // set and letting the whole boundary publish.
  let threw = "";
  try {
    sealBundle(input({
      semantic: { discovery: ["d"], boundary: ["never", "invents", "price", "term"] } as never,
      capability: { ...capability, boundary_summary: "never invents", forbidden_tools: ["price term"] },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `array boundary sealed: ${threw}`);
});

// ── round-7: keys are strings too, and flags is a string ─────────────────────
ok("seal refuses the boundary hidden in a checks.codes KEY", () => {
  // Values-only walking let the boundary ride in as a map key and be served by
  // GET /manifest. Independent review.
  let threw = "";
  try {
    sealBundle(input({ checks: { ...compiled.manifest, codes: { [recipe.boundary]: "x" } } }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `key-borne boundary sealed: ${threw}`);
  assert.equal(threw.includes("<key>"), true, `the gate did not name a key path: ${threw}`);
});

ok("seal refuses the boundary hidden in a pricing.split_bp KEY", () => {
  let threw = "";
  try {
    sealBundle(input({ pricing: { split_bp: { [recipe.boundary]: 7000 } } }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `split_bp key sealed: ${threw}`);
});

ok("a boundary of short words is still caught when reordered", () => {
  // "no vat due now" has no 4+ character content tokens; the ratio test had
  // nothing to measure, so only the short-token fallback catches it.
  let threw = "";
  try {
    sealBundle(input({
      semantic: { discovery: ["d"], boundary: "no vat due now" } as never,
      capability: { ...capability, forbidden_tools: ["due now", "no vat"] },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `short-token boundary sealed: ${threw}`);
});

// ── round-8: the SEALED half's keys are strings too ──────────────────────────
ok("seal refuses the boundary hidden in a SEMANTIC object KEY", () => {
  // collect() walked Object.values only. Prose living in a semantic KEY never
  // entered the guard set, so a manifest reproducing that prose published clean
  // and was served by GET /manifest. Round-7 fixed keys on the manifest side and
  // missed them on the semantic side.
  let threw = "";
  try {
    sealBundle(input({
      semantic: { [recipe.boundary]: "placeholder" } as never,
      checks: { ...compiled.manifest, codes: { [recipe.boundary]: "x" } },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `semantic-key boundary sealed: ${threw}`);
});

ok("a semantic payload with no readable text refuses to publish (fails closed)", () => {
  // An empty guard set means the no-plaintext promise cannot be evaluated. It must
  // not read as "clean".
  let threw = "";
  try { sealBundle(input({ semantic: {} as never })); }
  catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("semantic_payload:empty"), true, `empty sealed half sealed cleanly: ${threw}`);
});

ok("a null semantic payload refuses to publish", () => {
  let threw = "";
  try { sealBundle(input({ semantic: null as never })); }
  catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("semantic_payload:empty"), true, `null sealed half sealed cleanly: ${threw}`);
});

ok("an array-only semantic payload is guarded by its elements, not refused", () => {
  // A payload with no prose still has keys/elements acting as guard strings, so
  // there is nothing to protect and nothing to leak. Refusing here would be
  // theatre; the gate must still run and come back clean.
  const sealed = sealBundle(input({
    semantic: { discovery: ["ok"], boundary: "pricing stays exactly as the owner wrote it" } as never,
  }));
  assert.equal(sealed.bytes.length > 0, true, "a legitimate sealed half failed to seal");
});

// ── round-9: the guard must tokenise whatever text exists ────────────────────
ok("seal refuses a boundary written in Cyrillic", () => {
  // tokens() was split(/[^a-z0-9]+/), so non-ASCII letters tokenised to [] and the
  // guard set was empty: the prose published and served verbatim.
  const cyr = "Резерв не меняет цену никогда и ничего не заказывает";
  let threw = "";
  try {
    sealBundle(input({
      semantic: { boundary: cyr } as never,
      checks: { ...compiled.manifest, codes: { [cyr]: "C97" } },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `Cyrillic boundary sealed: ${threw}`);
});

ok("seal refuses a boundary written in Chinese", () => {
  // No word boundaries at all: the whole sentence is one token, so no 4-gram
  // exists. Only the normalised character-window pass catches this.
  const cjk = "从不发明价格或付款条件";
  let threw = "";
  try {
    sealBundle(input({
      semantic: { boundary: cjk } as never,
      checks: { ...compiled.manifest, codes: { [cjk]: "C98" } },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `CJK boundary sealed: ${threw}`);
});

ok("seal refuses CJK prose carried in a semantic KEY", () => {
  const cjk = "从不发明价格或付款条件";
  let threw = "";
  try {
    sealBundle(input({
      semantic: { [cjk]: "placeholder" } as never,
      checks: { ...compiled.manifest, codes: { [cjk]: "C99" } },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `CJK key boundary sealed: ${threw}`);
});

ok("seal refuses a punctuated Chinese sentence", () => {
  // Round-10 hole: 。 is a non-letter, so a real CJK paragraph split into four
  // tokens, failed the old `< 4 tokens` scoping, and produced no 4-gram either —
  // so it published and served a whole clause verbatim.
  const clause = "金鑰輪換。簽章驗證。版本鎖定。授權檢查。";
  let threw = "";
  try {
    sealBundle(input({
      semantic: { boundary: clause } as never,
      capability: { ...capability, boundary_summary: "金鑰輪換。簽章驗證。" },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `punctuated CJK sealed: ${threw}`);
});

ok("seal refuses a short Chinese clause (six-character window)", () => {
  const short = "金鑰輪換簽章版";
  let threw = "";
  try {
    sealBundle(input({
      semantic: { boundary: short } as never,
      checks: { ...compiled.manifest, codes: { [short]: "C96" } },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `short CJK sealed: ${threw}`);
});

ok("a single long sealed token is comparable and caught when copied", () => {
  // The two-token rule left one-word values permanently uncomparable. A single
  // word longer than the window is compared like any other string.
  const word = "Vertraulichkeit";
  let threw = "";
  try {
    sealBundle(input({
      semantic: { boundary: word } as never,
      checks: { ...compiled.manifest, codes: { [word]: "C95" } },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `single token copied and sealed: ${threw}`);
});

ok("seal refuses prose atomised one word per field", () => {
  // Round-12 hole: judging field by field meant a payload storing the boundary one
  // word per field produced no window and no 4-gram, and published verbatim.
  const phrase = recipe.boundary as string;
  const words = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const atomised: Record<string, string> = { note: "assess supplier quotes and lead times" };
  words.forEach((w, i) => { atomised[`w${i}`] = w; });
  let threw = "";
  try {
    sealBundle(input({
      semantic: atomised as never,
      capability: { ...capability, boundary_summary: phrase },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `atomised prose sealed: ${threw}`);
});

ok("seal refuses a sealed value that is a fragment of a vocabulary word", () => {
  // A sealed "recommendat" against outputs ["recommendation"] used to publish: the
  // excusal matched a fragment of the public identifier. The exemption now requires
  // the sealed half to contain the WHOLE term.
  let threw = "";
  try { sealBundle(input({ semantic: { boundary: "recommendat" } as never })); }
  catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `fragment excused: ${threw}`);
});

ok("a metadata-only payload is refused as unsearchable, not as a leak", () => {
  // Collecting semantic keys made a one-word guard look like 100% coverage, so
  // {"version": 3} was reported as leaks_sealed_text:<vocabulary> — a wrong
  // diagnosis. The honest answer is that the sealed half is too short to guard.
  let threw = "";
  try { sealBundle(input({ semantic: { version: 3 } as never })); }
  catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("semantic_payload:unsearchable"), true, `metadata payload: ${threw}`);
  assert.equal(threw.includes("leaks_sealed_text"), false, `misdiagnosed as a leak: ${threw}`);
});

ok("a short Latin boundary is still searchable and still caught", () => {
  let threw = "";
  try {
    sealBundle(input({
      semantic: { discovery: ["d"], boundary: "no vat due now" } as never,
      capability: { ...capability, forbidden_tools: ["due now", "no vat"] },
    }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("leaks_sealed_text"), true, `short boundary lost: ${threw}`);
});

ok("a rule with non-string matches flags is refused at load", () => {
  let threw = "";
  try {
    const bad = [{ id: "bad-flags", code: "C98", severity: "block", description: "d",
      expr: { op: "matches", path: "sections[0].body", pattern: "x", flags: 5 } }] as never;
    loadRules(compile(bad, { salt: new Uint8Array(8) }).wasm);
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(/flags/i.test(threw), true, `non-string flags not refused: ${threw}`);
});

const valueCases: Array<[string, (cap: Record<string, unknown>) => Record<string, unknown>, string]> = [
  ["negative price", () => ({ ...capability }), "pricing.amount_cents:range"],
];
for (const [label, , expected] of valueCases) {
  ok(`seal refuses ${label}`, () => {
    let threw = "";
    try {
      sealBundle(input({ pricing: { amount_cents: -1 } }));
    } catch (err) { threw = String(err instanceof Error ? err.message : err); }
    assert.equal(threw.includes(expected), true, `seal accepted ${label}: ${threw}`);
  });
}

ok("seal refuses an empty code description and an empty id", () => {
  let threw = "";
  try {
    sealBundle(input({ recipeId: "", checks: { ...compiled.manifest, codes: { C01: "" } } }));
  } catch (err) { threw = String(err instanceof Error ? err.message : err); }
  assert.equal(threw.includes("id:empty"), true, `empty id accepted: ${threw}`);
  assert.equal(threw.includes("checks.codes.C01:empty"), true, `empty description accepted: ${threw}`);
});

// ── verifyBundle must REJECT malformed manifests, never throw ────────────────
function reSign(mutate: (m: Record<string, unknown>) => void): Uint8Array {
  const author = generateAuthorKey();
  const sealed = sealBundle(input({ author: { id: "acct_author", name: "Author",
    keyId: author.keyId, privateKey: author.privateKey } }));
  const m = JSON.parse(JSON.stringify(sealed.manifest)) as Record<string, unknown>;
  mutate(m);
  delete m.signature;
  const digest = sha256Hex(canonicalise(m));
  m.signature = sign(null, Buffer.from(digest, "hex"), author.privateKey).toString("base64");
  const entries = readZip(sealed.bytes);
  return makeZip([
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(m)) },
    { name: "semantic.enc", data: entries.get("semantic.enc")! },
    { name: "checks.wasm", data: entries.get("checks.wasm")! },
  ]);
}

const malformed: Array<[string, (m: Record<string, unknown>) => void]> = [
  ["capability as an array of prose", (m) => { m.capability = ["never invents a price"]; }],
  ["capability as a string", (m) => { m.capability = "never invents a price or a term"; }],
  ["pricing as prose", (m) => { m.pricing = "free for everyone, no limits"; }],
  ["capability.inputs[].description", (m) => {
    (m.capability as { inputs: unknown[] }).inputs = [{ name: "quotes", type: "file[]", required: true, description: "ask which quotes" }];
  }],
  ["author.public_key missing", (m) => { delete (m.author as Record<string, unknown>).public_key; }],
  ["checks.codes as an array", (m) => { (m.checks as Record<string, unknown>).codes = ["C01"]; }],
  ["extra nested key in pricing", (m) => { (m.pricing as Record<string, unknown>).note = "ask which quotes"; }],
];
for (const [label, mutate] of malformed) {
  ok(`verifyBundle rejects ${label} as MANIFEST_SCHEMA (no throw)`, () => {
    let result;
    try { result = verifyBundle(reSign(mutate)); }
    catch (err) { throw new Error(`verifyBundle THREW on ${label}: ${err instanceof Error ? err.message : err}`); }
    assert.equal(result.ok, false, `${label} verified`);
    assert.equal(result.reason, "MANIFEST_SCHEMA", `${label} -> ${result.reason}`);
  });
}

console.log(`\nStep 2: ${checks} checks passed\n`);
