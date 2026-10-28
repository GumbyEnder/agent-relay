/**
 * Honey Drops — a wallet with a ledger, and purchases that move money exactly once.
 *
 * Design notes that are not obvious from the code:
 *
 * - **The ledger is the truth.** `ar_wallet.balance` is a cache that a CHECK keeps
 *   non-negative; every movement also writes `ar_wallet_entry` with `balance_after`
 *   so an account can be reconstructed and audited.
 * - **A purchase is one SQL statement.** The deployed database is Neon over HTTP —
 *   there is no interactive transaction to hold open. Everything that must happen
 *   atomically happens in a single data-modifying CTE: the purchase row is inserted
 *   only if the buyer can pay, and it is deleted again if the debit did not land.
 *   A purchase therefore cannot exist unpaid, and money cannot leave without one.
 * - **The buyer is private.** `buyer_id` is written because refunds and audits need
 *   it, and it is never returned by any seller-facing or public query. Sellers get
 *   counts and totals.
 * - **Money is integer Drops.** No floats: rounding a split is how a marketplace
 *   loses a Drop per sale and never reconciles.
 */

export type LedgerReason = "grant" | "purchase" | "sale" | "platform_fee" | "refund" | "adjustment";

/** Same shape as the recipe registry's QueryFn: a callable over (sql, params). */
export type Q = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

export interface WalletSummary {
  balance: number;
  earned: number;
  spent: number;
}

export interface LedgerEntry {
  id: string;
  delta: number;
  balance_after: number;
  reason: LedgerReason;
  ref: string | null;
  created_at: string;
}

export interface PurchaseRequest {
  buyerId: string;
  sellerId: string;
  hash: string;
  recipeId: string;
  version: string;
  price: number;
  /** Platform share in basis points (10000 = all of it). Defaults to 20%. */
  splitBp?: number;
}

export type PurchaseOutcome =
  | { ok: true; purchaseId: string; price: number; balanceAfter: number; alreadyOwned: false }
  | { ok: false; reason: "already_owned" | "insufficient_funds" | "free_recipe"; balance: number };

export const DEFAULT_PLATFORM_SPLIT_BP = 2000;

/** Round once, in one place: the seller gets the floor, the platform gets the rest. */
export function splitPrice(price: number, splitBp = DEFAULT_PLATFORM_SPLIT_BP): { seller: number; platform: number } {
  if (!Number.isSafeInteger(price) || price < 0) throw new Error("price must be a non-negative integer");
  const bp = Math.max(0, Math.min(10000, Math.trunc(splitBp)));
  const platform = Math.floor((price * bp) / 10000);
  return { seller: price - platform, platform };
}

/** A wallet row must exist before it can be locked or debited. */
export async function ensureWallet(q: Q, userId: string): Promise<number> {
  const rows = await q<{ balance: number }>(
    `INSERT INTO ar_wallet (user_id, balance) VALUES ($1, 0)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING balance`,
    [userId],
  );
  return Number(rows[0]?.balance ?? 0);
}

export async function walletSummary(q: Q, userId: string): Promise<WalletSummary> {
  const rows = await q<{ balance: number; earned: string; spent: string }>(
    `SELECT w.balance,
            COALESCE(SUM(CASE WHEN e.delta > 0 AND e.reason IN ('sale','refund','grant') THEN e.delta END), 0)::text AS earned,
            COALESCE(SUM(CASE WHEN e.delta < 0 AND e.reason = 'purchase' THEN -e.delta END), 0)::text AS spent
       FROM ar_wallet w
       LEFT JOIN ar_wallet_entry e ON e.user_id = w.user_id
      WHERE w.user_id = $1
      GROUP BY w.balance`,
    [userId],
  );
  if (!rows[0]) return { balance: 0, earned: 0, spent: 0 };
  return { balance: Number(rows[0].balance), earned: Number(rows[0].earned), spent: Number(rows[0].spent) };
}

export async function ledger(q: Q, userId: string, limit = 25): Promise<LedgerEntry[]> {
  const n = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = await q<LedgerEntry>(
    `SELECT id::text AS id, delta, balance_after, reason, ref, created_at::text AS created_at
       FROM ar_wallet_entry
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT ${n}`,
    [userId],
  );
  return rows;
}

/**
 * Grant Drops. Idempotent when a key is supplied, so a retried admin request or a
 * re-run script cannot pay twice.
 */
export async function grant(
  q: Q,
  args: { userId: string; amount: number; reason?: LedgerReason; ref?: string; idempotencyKey?: string },
): Promise<{ applied: boolean; balance: number }> {
  const amount = Math.trunc(args.amount);
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error("amount must be a non-zero integer");
  await ensureWallet(q, args.userId);

  const rows = await q<{ balance: number }>(
    `WITH entry AS (
       INSERT INTO ar_wallet_entry (user_id, delta, balance_after, reason, ref, idempotency_key)
       SELECT $1, $2, w.balance + $2, COALESCE($3, 'grant'), $4, $5
         FROM ar_wallet w
        WHERE w.user_id = $1
          AND ($5::text IS NULL OR NOT EXISTS (
                SELECT 1 FROM ar_wallet_entry WHERE idempotency_key = $5))
       RETURNING user_id, delta
     ), upd AS (
       UPDATE ar_wallet w SET balance = w.balance + e.delta, updated_at = now()
         FROM entry e WHERE w.user_id = e.user_id
       RETURNING w.balance
     )
     SELECT balance FROM upd`,
    [args.userId, amount, args.reason ?? null, args.ref ?? null, args.idempotencyKey ?? null],
  );
  if (!rows[0]) {
    const cur = await q<{ balance: number }>(`SELECT balance FROM ar_wallet WHERE user_id = $1`, [args.userId]);
    return { applied: false, balance: Number(cur[0]?.balance ?? 0) };
  }
  return { applied: true, balance: Number(rows[0].balance) };
}

/**
 * Buy a recipe. One statement; see the header for why.
 *
 * The purchase row is inserted first (guarded by the balance snapshot and the
 * one-per-buyer unique index), the debit is attempted with its own `balance >= price`
 * guard, and any purchase row whose debit did not land is deleted again in the same
 * statement. The entitlement, both ledger entries and the seller credit are all
 * gated on the debit having succeeded.
 */
export async function purchase(q: Q, req: PurchaseRequest): Promise<PurchaseOutcome> {
  const price = Math.trunc(req.price);
  if (!Number.isSafeInteger(price) || price < 0) throw new Error("price must be a non-negative integer");

  await ensureWallet(q, req.buyerId);
  if (req.sellerId !== req.buyerId) await ensureWallet(q, req.sellerId);

  if (price === 0) {
    // Free: no money moves, but ownership is still recorded.
    await q(
      `INSERT INTO ar_recipe_entitlement (user_id, hash, purchase_id)
       VALUES ($1, $2, NULL) ON CONFLICT (user_id, hash) DO NOTHING`,
      [req.buyerId, req.hash],
    );
    return { ok: false, reason: "free_recipe", balance: (await walletSummary(q, req.buyerId)).balance };
  }

  // The platform share is recorded on the purchase row. It is not credited to a
  // wallet here: the platform is not a peer account, and crediting "every other
  // user" is how a fee becomes a bug that pays strangers.
  const { seller, platform } = splitPrice(price, req.splitBp);

  const rows = await q<{ purchase_id: string | null; balance_after: number | null }>(
    `WITH snapshot AS (
       SELECT balance FROM ar_wallet WHERE user_id = $1
     ), purch AS (
       INSERT INTO ar_recipe_purchase
         (hash, recipe_id, version, buyer_id, seller_id, price_honey_drops, seller_credit, platform_credit)
       SELECT $2, $3, $4, $1, $5, $6, $7, $8
        WHERE (SELECT balance FROM snapshot) >= $6
       ON CONFLICT DO NOTHING
       RETURNING id, price_honey_drops AS price
     ), debit AS (
       UPDATE ar_wallet w
          SET balance = w.balance - (SELECT price FROM purch), updated_at = now()
        WHERE w.user_id = $1
          AND EXISTS (SELECT 1 FROM purch)
          AND w.balance >= (SELECT price FROM purch)
       RETURNING w.balance
     ), orphan AS (
       DELETE FROM ar_recipe_purchase p
        WHERE p.id IN (SELECT id FROM purch)
          AND NOT EXISTS (SELECT 1 FROM debit)
       RETURNING p.id
     ), credit AS (
       UPDATE ar_wallet w
          SET balance = w.balance + $7, updated_at = now()
        WHERE w.user_id = $5 AND EXISTS (SELECT 1 FROM debit)
       RETURNING w.balance
     ), e_buy AS (
       INSERT INTO ar_wallet_entry (user_id, delta, balance_after, reason, ref)
       SELECT $1, -price, (SELECT balance FROM debit), 'purchase', $2 FROM purch
        WHERE EXISTS (SELECT 1 FROM debit)
       RETURNING 1
     ), e_sell AS (
       INSERT INTO ar_wallet_entry (user_id, delta, balance_after, reason, ref)
       SELECT $5, $7, (SELECT balance FROM credit), 'sale', $2
        WHERE EXISTS (SELECT 1 FROM debit) AND $7 > 0
       RETURNING 1
     ), ent AS (
       INSERT INTO ar_recipe_entitlement (user_id, hash, purchase_id)
       SELECT $1, $2, (SELECT id FROM purch)
        WHERE EXISTS (SELECT 1 FROM debit)
       ON CONFLICT (user_id, hash) DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT id::text FROM purch) AS purchase_id,
            (SELECT balance FROM debit) AS balance_after`,
    [req.buyerId, req.hash, req.recipeId, req.version, req.sellerId, price, seller, platform],
  );

  const row = rows[0];
  if (row?.purchase_id && row.balance_after !== null) {
    return {
      ok: true,
      purchaseId: String(row.purchase_id),
      price,
      balanceAfter: Number(row.balance_after),
      alreadyOwned: false,
    };
  }

  const owned = await ownsRecipe(q, req.buyerId, req.hash);
  const { balance } = await walletSummary(q, req.buyerId);
  return { ok: false, reason: owned ? "already_owned" : "insufficient_funds", balance };
}

export async function ownsRecipe(q: Q, userId: string, hash: string): Promise<boolean> {
  const rows = await q<{ ok: number }>(
    `SELECT 1 AS ok FROM ar_recipe_entitlement WHERE user_id = $1 AND hash = $2 LIMIT 1`,
    [userId, hash],
  );
  return rows.length > 0;
}

export async function ownedHashes(q: Q, userId: string): Promise<string[]> {
  const rows = await q<{ hash: string }>(
    `SELECT hash FROM ar_recipe_entitlement WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.hash);
}

/**
 * Seller-facing sales figures. Deliberately aggregated: a seller learns how many
 * copies sold and what they earned, never who bought them.
 */
export interface SaleRow {
  /** When it sold. Not who bought it — that never leaves the server. */
  sold_at: string;
  recipeId: string;
  hash: string;
  paid: number;
  credit: number;
}

export interface SalesSummary {
  sales: number;
  earned: number;
  /** Distinct buyers as a number. A count is a business fact; a list is a customer list. */
  distinctBuyers: number;
  byRecipe: Array<{ hash: string; recipeId: string; sales: number; earned: number; avgRating: number | null; ratingCount: number }>;
  /** Newest first, capped: a ledger, not an export. */
  recent: SaleRow[];
}

export async function salesSummary(q: Q, sellerId: string): Promise<SalesSummary> {
  const totals = await q<{ sales: string; earned: string }>(
    `SELECT COUNT(*)::text AS sales, COALESCE(SUM(seller_credit), 0)::text AS earned
       FROM ar_recipe_purchase WHERE seller_id = $1`,
    [sellerId],
  );
  const per = await q<{ hash: string; recipe_id: string; sales: string; earned: string; avg: string | null; ratings: string }>(
    `SELECT p.hash, p.recipe_id, COUNT(*)::text AS sales,
            COALESCE(SUM(p.seller_credit), 0)::text AS earned,
            (SELECT ROUND(AVG(r.stars)::numeric, 2)::text FROM ar_recipe_rating r WHERE r.hash = p.hash) AS avg,
            (SELECT COUNT(*)::text FROM ar_recipe_rating r WHERE r.hash = p.hash) AS ratings
       FROM ar_recipe_purchase p WHERE p.seller_id = $1
      GROUP BY p.hash, p.recipe_id ORDER BY COUNT(*) DESC`,
    [sellerId],
  );
  const distinct = await q<{ n: string }>(
    `SELECT COUNT(DISTINCT buyer_id)::text AS n FROM ar_recipe_purchase WHERE seller_id = $1`,
    [sellerId],
  );
  const recent = await q<{ sold_at: string; recipe_id: string; hash: string; paid: number; credit: number }>(
    `SELECT created_at::text AS sold_at, recipe_id, hash, price_honey_drops AS paid, seller_credit AS credit
       FROM ar_recipe_purchase WHERE seller_id = $1
      ORDER BY created_at DESC LIMIT 100`,
    [sellerId],
  );
  return {
    sales: Number(totals[0]?.sales ?? 0),
    earned: Number(totals[0]?.earned ?? 0),
    distinctBuyers: Number(distinct[0]?.n ?? 0),
    byRecipe: per.map((r) => ({
      hash: r.hash,
      recipeId: r.recipe_id,
      sales: Number(r.sales),
      earned: Number(r.earned),
      avgRating: r.avg === null ? null : Number(r.avg),
      ratingCount: Number(r.ratings ?? 0),
    })),
    recent: recent.map((r) => ({
      sold_at: r.sold_at,
      recipeId: r.recipe_id,
      hash: r.hash,
      paid: Number(r.paid),
      credit: Number(r.credit),
    })),
  };
}

export interface RatingSummary {
  average: number | null;
  count: number;
}

export async function ratingsFor(q: Q, hashes: string[]): Promise<Record<string, RatingSummary>> {
  if (!hashes.length) return {};
  const rows = await q<{ hash: string; avg: string | null; n: string }>(
    `SELECT hash, ROUND(AVG(stars)::numeric, 2)::text AS avg, COUNT(*)::text AS n
       FROM ar_recipe_rating WHERE hash = ANY($1::text[]) GROUP BY hash`,
    [hashes],
  );
  const out: Record<string, RatingSummary> = {};
  for (const r of rows) out[r.hash] = { average: r.avg === null ? null : Number(r.avg), count: Number(r.n) };
  return out;
}

/** Upsert one rating from someone who owns the recipe. Returns their stars. */
export async function rateRecipe(q: Q, hash: string, raterId: string, stars: number): Promise<{ stars: number }> {
  const n = Math.trunc(stars);
  if (!Number.isSafeInteger(n) || n < 1 || n > 5) throw new Error("stars must be 1..5");
  const rows = await q<{ stars: number }>(
    `INSERT INTO ar_recipe_rating (hash, rater_id, stars)
     VALUES ($1, $2, $3)
     ON CONFLICT (hash, rater_id)
     DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()
     RETURNING stars`,
    [hash, raterId, n],
  );
  return { stars: Number(rows[0].stars) };
}
