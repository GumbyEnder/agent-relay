/**
 * The shopfront — what a shopper sees before buying.
 *
 * A listing is published in clear: title, description, author, dates, price in
 * Honey Drops. It is the only part of the manifest an author writes *about* the
 * recipe rather than *of* it, which makes the description the most tempting place
 * in the protocol to paste the recipe. These checks pin both halves: the shelf
 * works, and the shelf cannot become a side door.
 *
 *   npx tsx scripts/test-recipe-listing.ts
 */
import { generateAuthorKey, manifestShapeErrors, sealBundle, verifyBundle } from "../src/lib/recipe-seal/bundle";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { RECIPES } from "../src/lib/buzzy/recipes";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const recipe = RECIPES[0];
const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
const key = generateAuthorKey();
const KEK = new Uint8Array(32).fill(3);

const MARKER = "corvid logistics quoted eleven thousand two hundred dollars for the north field";

function seal(opts: { listing?: any; semantic?: unknown } = {}) {
  return sealBundle({
    recipeId: "quote-comparison",
    version: "1.0.0",
    semantic: opts.semantic ?? {
      boundary: MARKER,
      checklist: ["confirm the north field price in writing", "check the reserve line is priced"],
      outputContract: "one ranked table, with the winning bid at the top",
      discovery: "the household holds three bids and no shared basis for judging them",
    },
    checksWasm: compiled.wasm,
    checks: compiled.manifest,
    capability: {
      inputs: [{ name: "quotes", type: "file[]", required: true }],
      outputs: ["comparison-table"],
      tools: recipe.tools,
      forbidden_tools: ["send"],
      boundary_summary: "read-only; nothing is sent",
    },
    author: { id: "acct_a", name: "Author", keyId: key.keyId, privateKey: key.privateKey },
    kek: KEK,
    listing: opts.listing,
    createdAt: "2026-10-27T12:00:00.000Z",
  });
}

// ── the shelf works ──────────────────────────────────────────────────────────
const free = seal({ listing: { title: "Quote Comparison", description: "Compare three contractor bids on the same basis." } });
check("a listing survives sealing", free.manifest.listing.title === "Quote Comparison", free.manifest.listing.title);
check("an unpriced listing is free", free.manifest.listing.price_honey_drops === 0);
check("description round-trips", free.manifest.listing.description.startsWith("Compare three"));
check("updated_at defaults to created_at", free.manifest.listing.updated_at === "2026-10-27T12:00:00.000Z");

const verified = verifyBundle(free.bytes);
check("a listed bundle still verifies", verified.ok && !!verified.manifest);
check("the listing survives verification", verified.manifest?.listing.title === "Quote Comparison");

const priced = seal({ listing: { title: "Quote Comparison Pro", priceHoneyDrops: 25, updatedAt: "2026-10-27T18:30:00.000Z" } });
check("a priced listing carries Honey Drops", priced.manifest.listing.price_honey_drops === 25);
check("the update date is the author's, not now", priced.manifest.listing.updated_at === "2026-10-27T18:30:00.000Z");

// ── the shelf is not a side door ────────────────────────────────────────────
let refused = "";
try {
  seal({ listing: { title: "Quote Comparison", description: MARKER } });
} catch (e) { refused = String((e as Error).message ?? e); }
check("sealed prose in the description is refused", /leaks_sealed_text|INVALID_MANIFEST/.test(refused), refused.slice(0, 90));

let refusedTitle = "";
try {
  seal({ listing: { title: MARKER } });
} catch (e) { refusedTitle = String((e as Error).message ?? e); }
check("sealed prose in the title is refused", /leaks_sealed_text|INVALID_MANIFEST/.test(refusedTitle), refusedTitle.slice(0, 90));

// ── shape rules ─────────────────────────────────────────────────────────────
const shape = (l: Record<string, unknown>) => manifestShapeErrors({ ...free.manifest, listing: l });
check("an empty title is a shape error", shape({ ...free.manifest.listing, title: "  " }).includes("listing.title:empty"));
check("an over-long title is refused", shape({ ...free.manifest.listing, title: "x".repeat(121) }).includes("listing.title:too_long"));
check("a 120-char title is allowed", !shape({ ...free.manifest.listing, title: "x".repeat(120) }).includes("listing.title:too_long"));
check("an over-long description is refused", shape({ ...free.manifest.listing, description: "x".repeat(601) }).includes("listing.description:too_long"));
check("a negative price is refused", shape({ ...free.manifest.listing, price_honey_drops: -1 }).includes("listing.price_honey_drops:invalid"));
check("a fractional price is refused", shape({ ...free.manifest.listing, price_honey_drops: 2.5 }).includes("listing.price_honey_drops:invalid"));
check("a nonsense date is refused", shape({ ...free.manifest.listing, updated_at: "whenever" }).includes("listing.updated_at:not_a_date"));
check("an honest listing has no shape errors", shape(free.manifest.listing as Record<string, unknown>).filter((e) => e.startsWith("listing.")).length === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
