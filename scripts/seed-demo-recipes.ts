/**
 * Seed the recipe shelf with real sealed recipes.
 *
 * "Real" means the same path a paying author takes: compile the checks, seal the
 * bundle with an author key, and publish it through `POST /api/recipes`. Nothing
 * here writes to the database directly — if the door refuses, the shelf stays empty
 * and that is the correct outcome.
 *
 *   SEAL_SEED_BASE=http://127.0.0.1:4189 npx tsx scripts/seed-demo-recipes.ts
 *   SEAL_SEED_BASE=https://app.devboards.ai SEAL_SEED_TOKEN=… npx tsx scripts/seed-demo-recipes.ts
 */
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { generateAuthorKey, sealBundle } from "../src/lib/recipe-seal/bundle";

const BASE = process.env.SEAL_SEED_BASE ?? "http://127.0.0.1:4189";
const TOKEN = process.env.SEAL_SEED_TOKEN ?? "";
const KEK = new Uint8Array(32).fill(9);

/** What we put on the shelf. Price 0 is free; the client renders "Free". */
const SHELF: Array<{ id: string; title: string; description: string; price: number; updated: string }> = [
  {
    id: "quote-comparison",
    title: "Pick Between Bids",
    description:
      "Put two or three offers side by side on the same basis, see what each one left out, and get a plain call on which to take — with the reason in one sentence.",
    price: 25,
    updated: "2026-10-20T09:00:00.000Z",
  },
  {
    id: "dispute-paperwork",
    title: "Deposit Refund Letter",
    description:
      "For the landlord who keeps a deposit and will not say why: this lays out the dates, the money owed, and one clear deadline to put it right. Free, because everyone should have it.",
    price: 0,
    updated: "2026-10-12T14:30:00.000Z",
  },
  {
    id: "bookkeeping-prep",
    title: "Month-End Books",
    description:
      "Turns a shoebox of receipts into an organised month that files cleanly: every line sorted, every gap listed as a question for you instead of a guess.",
    price: 40,
    updated: "2026-09-28T11:15:00.000Z",
  },
];

const author = generateAuthorKey();
const authorName = "Shane Barron";

function b64(u: Uint8Array): string {
  return Buffer.from(u).toString("base64");
}

(async () => {
  console.log(`\nSeeding ${SHELF.length} recipe(s) to ${BASE}\n`);
  let ok = 0;
  let failed = 0;

  for (const item of SHELF) {
    const recipe = RECIPES.find((r) => r.id === item.id);
    if (!recipe) { console.log(`  FAIL ${item.id}: no such recipe fixture`); failed++; continue; }

    const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
    let sealed;
    try {
      sealed = sealBundle({
        recipeId: recipe.id,
        version: process.env.SEAL_SEED_VERSION ?? "1.0.3",
        semantic: {
          discovery: recipe.discovery,
          boundary: recipe.boundary,
          checklist: recipe.checklist,
          outputContract: recipe.outputContract,
        },
        checksWasm: compiled.wasm,
        checks: compiled.manifest,
        capability: {
          inputs: [{ name: "sources", type: "file[]", required: true }],
          outputs: ["document", "comparison-table", "recommendation"],
          tools: ["render_document"],
          forbidden_tools: ["send", "submit"],
          boundary_summary: "read-only; nothing is sent",
        },
        author: { id: "acct_shane", name: authorName, keyId: author.keyId, privateKey: author.privateKey },
        kek: KEK,
        listing: {
          title: item.title,
          description: item.description,
          updatedAt: item.updated,
          priceHoneyDrops: item.price,
        },
        pricing: { amount_cents: 0 },
        createdAt: "2026-10-27T12:00:00.000Z",
      });
    } catch (e) {
      console.log(`  FAIL ${item.id}: seal refused — ${String((e as Error).message).slice(0, 140)}`);
      failed++;
      continue;
    }

    const res = await fetch(`${BASE}/api/recipes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ bundle: b64(sealed.bytes) }),
    });
    const text = await res.text();
    if (res.status === 201) {
      const j = JSON.parse(text);
      console.log(`  ok   ${item.title} → ${j.hash.slice(0, 12)}… ${item.price === 0 ? "free" : `${item.price} Honey Drops`}`);
      ok++;
    } else {
      console.log(`  FAIL ${item.title}: ${res.status} ${text.slice(0, 160)}`);
      failed++;
    }
  }

  console.log(`\n${ok} published, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
