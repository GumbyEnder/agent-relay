/**
 * Seal — call-site probe.
 *
 * The 164-check suite proves the library: `sealBundle`, `manifestPublishErrors`,
 * the rule DSL, licences and metering, all as functions. It does not prove the
 * thing a customer relies on, which is what the *deployed door* serves. This
 * probe speaks HTTP to a running server and checks the claim from outside:
 *
 *   publish a sealed bundle  ->  GET the manifest  ->  no window of the sealed
 *   half appears in the response, and the stored bundle does not carry the prose
 *   in clear.
 *
 * Usage:
 *   SEAL_PROBE_BASE=http://127.0.0.1:3999 npx tsx scripts/seal-http-probe.ts
 *
 * Exits non-zero if the claim does not hold.
 */
import { sign } from "node:crypto";
import { generateAuthorKey, sealBundle, sha256Hex } from "../src/lib/recipe-seal/bundle";
import { canonicalise } from "../src/lib/recipe-seal/jcs";
import { makeZip, readZip } from "../src/lib/recipe-seal/zip";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { RECIPES } from "../src/lib/buzzy/recipes";

const BASE = process.env.SEAL_PROBE_BASE ?? "http://127.0.0.1:3999";
const KEK = new Uint8Array(32).fill(9);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** The claim, restated as a machine test: no run of 10+ characters of the sealed
 *  prose may appear in a served manifest, ignoring case and spacing. */
function leaks(haystack: string, prose: string): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const h = norm(haystack);
  const p = norm(prose);
  const out: string[] = [];
  for (let i = 0; i + 10 <= p.length; i++) {
    const w = p.slice(i, i + 10);
    if (h.includes(w)) out.push(w);
  }
  return [...new Set(out)].slice(0, 5);
}

const recipe = RECIPES[0];
const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
const key = generateAuthorKey();

// A fixture whose sealed half is distinctive. The shared recipe fixtures are full
// of vocabulary the manifest is *allowed* to use ("comparison-table"), and a probe
// that flags those reports the documented exemption as a leak. This marker cannot
// be vocabulary: if it appears in a served manifest, the seal is broken.
const MARKER = [
  "corvid logistics quoted eleven thousand two hundred dollars for the north field",
  "the reserve line runs under the western fence posts",
].join("; ");

const semantic = {
  discovery: "the household holds three bids and no shared basis for judging them",
  boundary: MARKER,
  checklist: ["confirm the north field price in writing", "check the reserve line is priced"],
  outputContract: "one ranked table, with the winning bid at the top",
};

const sealed = sealBundle({
  recipeId: recipe.id,
  version: process.env.SEAL_PROBE_VERSION ?? `0.0.${Math.floor(Date.now() / 1000) % 100000}`,
  semantic,
  checksWasm: compiled.wasm,
  checks: compiled.manifest,
  capability: {
    inputs: [{ name: "quotes", type: "file[]", required: true }],
    outputs: ["comparison-table", "recommendation"],
    tools: recipe.tools,
    forbidden_tools: ["send", "email"],
    boundary_summary: "read-only; nothing is sent",
  },
  author: { id: "acct_probe", name: "Probe", keyId: key.keyId, privateKey: key.privateKey },
  kek: KEK,
  listing: {
    title: "Bid Sorter — probe",
    description: "Sorts contractor quotes by price and completeness.",
    priceHoneyDrops: 25,
  },
  pricing: { amount_cents: 4 },
  createdAt: new Date().toISOString(),
});

const sealedProse = [
  MARKER,
  ...(Array.isArray(semantic.checklist) ? semantic.checklist.map(String) : []),
].join(" ");

function b64(u: Uint8Array): string {
  return Buffer.from(u).toString("base64");
}

async function req(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", origin: BASE },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

/**
 * Take the genuine sealed bundle, mutate and re-sign its manifest, rebuild the zip.
 * This is the only way to test the door: sealBundle refuses these manifests by
 * design, so a forged-but-validly-signed bundle is what an attacker would send.
 */
function forge(mutate: (m: Record<string, unknown>) => void) {
  const m = JSON.parse(JSON.stringify(sealed.manifest)) as Record<string, unknown>;
  mutate(m);
  delete m.signature;
  const digest = sha256Hex(canonicalise(m));
  m.signature = sign(null, Buffer.from(digest, "hex"), key.privateKey).toString("base64");
  const entries = readZip(sealed.bytes);
  const bytes = makeZip([
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(m)) },
    { name: "semantic.enc", data: entries.get("semantic.enc")! },
    { name: "checks.wasm", data: entries.get("checks.wasm")! },
  ]);
  return bytes;
}

(async () => {
  console.log(`\nSeal call-site probe — ${BASE}\n`);

  const list = await req("GET", "/api/recipes");
  check("GET /api/recipes answers", list.status === 200, `status ${list.status}`);

  const pub = await req("POST", "/api/recipes", { bundle: b64(sealed.bytes) });
  check(
    "publishing an honest sealed bundle is accepted",
    pub.status === 201,
    `${pub.status} ${pub.text.slice(0, 200)}`,
  );
  const hash = pub.json?.hash as string | undefined;
  if (!hash) {
    console.log("\ncannot continue without a published hash");
    process.exit(1);
  }

  // ── the claim, from outside ────────────────────────────────────────────────
  const man = await req("GET", `/api/recipes/${hash}/manifest`);
  check("GET manifest answers", man.status === 200, `status ${man.status}`);
  const found = leaks(man.text, sealedProse);
  check("served manifest reproduces no window of the sealed half", found.length === 0, found.join(", "));

  // There is no endpoint that serves bundle bytes: the sealed half leaves the
  // server only as a licence-gated decrypt. If one ever appears, this fails.
  const bun = await req("GET", `/api/recipes/${hash}/bundle`);
  check("the sealed bundle is not downloadable", bun.status === 404, `status ${bun.status}`);

  // ── tampering must not be a shortcut ──────────────────────────────────────
  const tampered = new Uint8Array(sealed.bytes);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  const t = await req("POST", "/api/recipes", { bundle: b64(tampered) });
  check("a tampered bundle is refused", t.status === 400 || t.status === 422, `status ${t.status}`);

  const junk = await req("POST", "/api/recipes", { bundle: b64(new Uint8Array([1, 2, 3, 4])) });
  check("junk is refused", junk.status === 400 || junk.status === 422, `status ${junk.status}`);

  const ver = await req("POST", `/api/recipes/${hash}/verify`, { input: { quotes: [] } });
  check("verify answers and does not echo sealed prose", [200, 422, 400].includes(ver.status) && leaks(ver.text, sealedProse).length === 0, `status ${ver.status}`);

  // ── the shopfront, as a shopper receives it ───────────────────────────────
  const cat = await req("GET", "/api/recipes");
  const row = (cat.json?.recipes ?? []).find((x: any) => x.hash === hash);
  check("the catalogue lists the published recipe", !!row);
  if (row) {
    check("the shelf shows a title", row.title === "Bid Sorter — probe", String(row.title));
    check("the shelf shows a description", typeof row.description === "string" && row.description.length > 0);
    check("the shelf shows the price in Honey Drops", row.price_honey_drops === 25, String(row.price_honey_drops));
    check("a priced recipe is not marked free", row.is_free === false);
    check("the shelf shows the author", !!row.author?.id);
    check("the shelf shows when it last changed", typeof row.updated_at === "string");
    check("the shelf does not leak sealed prose", leaks(JSON.stringify(row), sealedProse).length === 0,
      leaks(JSON.stringify(row), sealedProse).join(", "));
  }

  // ── the door must refuse a leak, or "no leak" only means "nothing checked" ──
  const attacks: Array<[string, (m: Record<string, unknown>) => void]> = [
    ["sealed prose copied into a check code", (m) => {
      const c = m.checks as Record<string, unknown>;
      c.codes = { ...(c.codes as Record<string, string>), C99: MARKER };
    }],
    ["sealed prose in the boundary summary", (m) => {
      (m.capability as Record<string, unknown>).boundary_summary = MARKER;
    }],
    ["sealed prose split across two fields", (m) => {
      const cap = m.capability as Record<string, unknown>;
      const half = Math.floor(MARKER.length / 2);
      cap.boundary_summary = MARKER.slice(0, half);
      (cap.inputs as Array<Record<string, unknown>>)[0].description = MARKER.slice(half);
    }],
    ["sealed prose hidden in a manifest object key", (m) => {
      (m.capability as Record<string, unknown>)[MARKER] = "placeholder";
    }],
    ["homoglyph copy (Cyrillic е/о)", (m) => {
      (m.capability as Record<string, unknown>).boundary_summary =
        MARKER.replace(/e/g, "\u0435").replace(/o/g, "\u043E");
    }],
  ];

  for (const [name, mutate] of attacks) {
    let bytes: Uint8Array;
    try { bytes = forge(mutate); } catch (e) {
      check(`${name} is refused at the door`, false, `could not forge: ${String(e).slice(0, 80)}`);
      continue;
    }
    const r = await req("POST", "/api/recipes", { bundle: b64(bytes) });
    const code = r.json?.code ?? "";
    // 422 = refused by the leak gate; 400 = refused earlier by the schema, which is
    // stricter, not weaker: the manifest never reaches the gate to be judged.
    check(`${name} is refused at the door`,
      (r.status === 422 && code === "invalid_manifest") || (r.status === 400 && code === "MANIFEST_SCHEMA"),
      `${r.status} ${code} ${r.text.slice(0, 120)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
