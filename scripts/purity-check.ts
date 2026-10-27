/**
 * Runtime proof that the free verify tier cannot reach the sealing key.
 *
 * A source grep is a lint: it follows only the specifiers it recognises, misses
 * `process["env"]`, and false-positives on a comment. So this script installs a
 * *runtime trap* on `process.env` before the verify modules are imported, then
 * evaluates a draft. If any reachable module reads a key-ish environment variable
 * at import or call time, the trap throws and this script exits non-zero.
 *
 * Run: npx tsx scripts/purity-check.ts   (exit 0 = clean)
 */
const hits: string[] = [];
const real = process.env;
const trap = new Proxy(real, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && /kek|recipe|seal/i.test(prop)) {
      hits.push(prop);
      throw new Error(`verify tier read environment variable ${prop}`);
    }
    return Reflect.get(target, prop, receiver);
  },
  has(target, prop) {
    return Reflect.has(target, prop);
  },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).env = trap;

const { verifyDraft } = await import("../src/lib/recipe-seal/verify");
const { compileRecipeChecks, rulesFor } = await import("../src/lib/recipe-checks");

const compiled = compileRecipeChecks("quote-comparison", { salt: new Uint8Array(8) });
const codes = rulesFor("quote-comparison").reduce<Record<string, string>>((acc, r) => {
  acc[r.code] = r.description;
  return acc;
}, {});

const draft = {
  version: 1,
  sections: [{ id: "s1", title: "Recommendation", body: "Supplier B is cheaper per unit." }],
  claims: [{ id: "c1", text: "Supplier B quoted 12.40 per unit", sourceId: "q2" }],
  values: [{ id: "total-1", kind: "money", raw: "1240.00", normalised: 124000,
    source: "calculator", sourceId: null }],
  domain: { units: ["ea"] },
};

const result = verifyDraft({ checksWasm: compiled.wasm, draft, descriptions: codes });

if (hits.length > 0) {
  console.error(`FAIL: verify tier touched ${hits.join(",")}`);
  process.exit(1);
}
if (typeof result.ok !== "boolean" || !Array.isArray(result.codes)) {
  console.error("FAIL: verify produced no verdict");
  process.exit(1);
}
console.log(JSON.stringify({ ok: result.ok, codes: result.codes.length, envReads: hits.length }));
