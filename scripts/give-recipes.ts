/**
 * Publish recipes on behalf of an existing account.
 *
 * For testing: the account becomes the author (and therefore the seller) of each
 * recipe, so the shelf shows a second seller alongside the demo seeds.
 *
 *   SEAL_SEED_BASE=https://… SEAL_SEED_COOKIE="…" \
 *   RECIPIENTS='[{"email":"a@b.c","recipes":[...]}]' npx tsx scripts/give-recipes.ts
 *
 * Each recipe: { basis, title, description, price }. `basis` must be one of the
 * eight catalogue recipes, because it selects the rule set the bundle is sealed
 * with — an upload does not invent its own checks.
 */
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { generateAuthorKey, sealBundle } from "../src/lib/recipe-seal/bundle";

const BASE = process.env.SEAL_SEED_BASE ?? "http://127.0.0.1:5182";
const COOKIE = process.env.SEAL_SEED_COOKIE ?? "";
const VERSION = process.env.SEAL_SEED_VERSION ?? "1.0.0";
const KEK = new Uint8Array(32).fill(9);

export interface RecipeSpec {
  basis: string;
  title: string;
  description: string;
  price: number;
}

export interface Recipient {
  email: string;
  userId: string;
  name: string;
  recipes: RecipeSpec[];
}

const PLAN: Recipient[] = JSON.parse(process.env.RECIPIENTS ?? "[]");
const author = generateAuthorKey();

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

(async () => {
  let ok = 0;
  let failed = 0;
  for (const who of PLAN) {
    console.log(`\n${who.email} (${who.name}) — ${who.recipes.length} recipe(s)`);
    for (const spec of who.recipes) {
      const template = RECIPES.find((r) => r.id === spec.basis);
      if (!template) { console.log(`  FAIL ${spec.title}: unknown basis '${spec.basis}'`); failed++; continue; }
      const compiled = compileRecipeChecks(template.id, { salt: new Uint8Array(8) });

      let sealed;
      try {
        sealed = sealBundle({
          recipeId: `user.${who.userId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}.${spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`.slice(0, 64),
          version: VERSION,
          semantic: {
            discovery: template.discovery,
            boundary: template.boundary,
            checklist: template.checklist,
            outputContract: template.outputContract,
          },
          checksWasm: compiled.wasm,
          checks: compiled.manifest,
          capability: {
            inputs: [{ name: "sources", type: "file[]", required: true }],
            outputs: ["document"],
            tools: ["render_document"],
            forbidden_tools: ["send", "submit"],
            boundary_summary: "read-only; nothing is sent",
          },
          author: { id: who.userId, name: who.name, keyId: author.keyId, privateKey: author.privateKey },
          kek: KEK,
          listing: { title: spec.title, description: spec.description, priceHoneyDrops: spec.price },
          pricing: { amount_cents: 0 },
        });
      } catch (e) {
        console.log(`  FAIL ${spec.title}: seal refused — ${String((e as Error).message).slice(0, 160)}`);
        failed++;
        continue;
      }

      const res = await fetch(`${BASE}/api/recipes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          ...(COOKIE ? { cookie: COOKIE } : {}),
        },
        body: JSON.stringify({ bundle: b64(sealed.bytes) }),
      });
      const text = await res.text();
      if (res.status === 201) {
        console.log(`  ok   ${spec.title} — ${spec.price === 0 ? "free" : `${spec.price} Honey Drops`}`);
        ok++;
      } else {
        console.log(`  FAIL ${spec.title}: ${res.status} ${text.slice(0, 200)}`);
        failed++;
      }
    }
  }
  console.log(`\n${ok} published, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
