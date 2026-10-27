/**
 * Honey Drops — wallet, ledger, purchases, privacy.
 *
 *   DATABASE_URL_TEST=postgres://… npx tsx scripts/test-wallet.ts
 */
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { grant, ledger, ownsRecipe, purchase, salesSummary, splitPrice, walletSummary } from "../src/lib/wallet/wallet";

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  console.error("DATABASE_URL_TEST is required (see scripts/recipe-seal-pg.sh)");
  process.exit(2);
}
const pool = new Pool({ connectionString: url });
const q = <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
  pool.query<T>(text, params ?? []).then((r) => r.rows);

let pass = 0;
let fail = 0;
const ok = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};
const eq = (a: unknown, b: unknown, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };

const BUYER = "acct_buyer";
const SELLER = "acct_seller";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function migrate() {
  const files = ["0045_honey_drops_wallet.sql"];
  for (const f of files) {
    const sql = readFileSync(join(process.cwd(), "migrations", f), "utf8");
    await q(sql);
  }
}

(async () => {
  console.log("\nHoney Drops — wallet and ledger\n");
  await q(`DROP TABLE IF EXISTS ar_recipe_entitlement, ar_recipe_purchase, ar_wallet_entry, ar_wallet CASCADE`);
  await migrate();

  await ok("a new wallet starts at zero", async () => {
    eq(await walletSummary(q, BUYER), { balance: 0, earned: 0, spent: 0 });
  });

  await ok("a grant credits the wallet and writes one ledger row", async () => {
    const g = await grant(q, { userId: BUYER, amount: 200, ref: "seed" });
    eq(g, { applied: true, balance: 200 });
    const entries = await ledger(q, BUYER);
    eq(entries.length, 1);
    eq(entries[0].delta, 200);
    eq(entries[0].balance_after, 200);
    eq(entries[0].reason, "grant");
  });

  await ok("a repeated grant with the same key pays once", async () => {
    const again = await grant(q, { userId: BUYER, amount: 200, ref: "seed", idempotencyKey: "grant-1" });
    eq(again.applied, true);
    const second = await grant(q, { userId: BUYER, amount: 200, ref: "seed", idempotencyKey: "grant-1" });
    eq(second.applied, false, "second attempt must not apply");
    eq(second.balance, 400);
    eq((await ledger(q, BUYER)).length, 2);
  });

  await ok("the split accounts for every Drop", async () => {
    eq(splitPrice(25, 2000), { seller: 20, platform: 5 });
    eq(splitPrice(1, 2000), { seller: 1, platform: 0 });
    eq(splitPrice(0, 2000), { seller: 0, platform: 0 });
    const p = splitPrice(999, 3333);
    eq(p.seller + p.platform, 999);
  });

  await ok("a purchase debits the buyer, credits the seller, and records ownership", async () => {
    const out = await purchase(q, {
      buyerId: BUYER, sellerId: SELLER, hash: HASH_A,
      recipeId: "pick-between-bids", version: "1.0.0", price: 25,
    });
    truthy(out.ok, `purchase failed: ${JSON.stringify(out)}`);
    eq((await walletSummary(q, BUYER)).balance, 375);
    eq((await walletSummary(q, SELLER)).balance, 20);
    truthy(await ownsRecipe(q, BUYER, HASH_A));
    const rows = await q<{ seller_credit: number; platform_credit: number; price_honey_drops: number }>(
      `SELECT seller_credit, platform_credit, price_honey_drops FROM ar_recipe_purchase WHERE hash = $1`, [HASH_A]);
    eq(rows[0].seller_credit + rows[0].platform_credit, rows[0].price_honey_drops);
  });

  await ok("buying the same recipe twice does not move money again", async () => {
    const before = (await walletSummary(q, BUYER)).balance;
    const out = await purchase(q, {
      buyerId: BUYER, sellerId: SELLER, hash: HASH_A,
      recipeId: "pick-between-bids", version: "1.0.0", price: 25,
    });
    eq(out.ok, false);
    if (!out.ok) eq(out.reason, "already_owned");
    eq((await walletSummary(q, BUYER)).balance, before);
  });

  await ok("a purchase the buyer cannot afford leaves no trace", async () => {
    await q(`INSERT INTO ar_wallet (user_id, balance) VALUES ('acct_broke', 5) ON CONFLICT DO NOTHING`);
    const out = await purchase(q, {
      buyerId: "acct_broke", sellerId: SELLER, hash: HASH_B,
      recipeId: "expensive", version: "1.0.0", price: 50,
    });
    eq(out.ok, false);
    if (!out.ok) eq(out.reason, "insufficient_funds");
    eq((await walletSummary(q, "acct_broke")).balance, 5);
    const rows = await q(`SELECT 1 FROM ar_recipe_purchase WHERE buyer_id = 'acct_broke'`);
    eq(rows.length, 0, "no purchase row for an unpaid attempt");
    eq(await ownsRecipe(q, "acct_broke", HASH_B), false, "no entitlement without payment");
  });

  await ok("a free recipe records ownership without moving money", async () => {
    const out = await purchase(q, {
      buyerId: BUYER, sellerId: SELLER, hash: "c".repeat(64),
      recipeId: "free-one", version: "1.0.0", price: 0,
    });
    eq(out.ok, false);
    if (!out.ok) eq(out.reason, "free_recipe");
    truthy(await ownsRecipe(q, BUYER, "c".repeat(64)));
    eq((await walletSummary(q, SELLER)).balance, 20, "seller earns nothing from a free copy");
  });

  await ok("a seller sees counts and totals, never buyers", async () => {
    const s = await salesSummary(q, SELLER);
    eq(s.sales, 1);
    eq(s.earned, 20);
    const json = JSON.stringify(s);
    truthy(!/buyer/i.test(json), "the sales payload mentions a buyer");
    truthy(!json.includes(BUYER), "the sales payload leaks the buyer id");
  });

  await ok("the ledger balances for both accounts", async () => {
    for (const [user, expected] of [[BUYER, 375], [SELLER, 20]] as const) {
      const rows = await q<{ sum: string }>(
        `SELECT COALESCE(SUM(delta), 0)::text AS sum FROM ar_wallet_entry WHERE user_id = $1`, [user]);
      eq(Number(rows[0].sum), expected, `ledger sum for ${user}`);
      eq((await walletSummary(q, user)).balance, Number(rows[0].sum), `cached balance for ${user}`);
    }
  });

  await ok("a balance cannot go negative even by direct write", async () => {
    let threw = false;
    try { await q(`UPDATE ar_wallet SET balance = -1 WHERE user_id = $1`, [BUYER]); }
    catch { threw = true; }
    truthy(threw, "the CHECK constraint did not fire");
  });

  await ok("the split stored on the purchase is the split that was applied", async () => {
    const rows = await q<{ seller_credit: number }>(
      `SELECT seller_credit FROM ar_recipe_purchase WHERE buyer_id = $1 AND hash = $2`, [BUYER, HASH_A]);
    eq(rows[0].seller_credit, 20);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
})();
