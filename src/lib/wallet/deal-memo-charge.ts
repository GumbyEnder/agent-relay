/**
 * CR-9 phase F — what a finished deal memo costs.
 *
 * Three rules, all from room 7853/7865, and none of them are optional:
 *
 *  1. **Only a done transition charges.** The caller passes the job id after
 *     `finishDealMemoJob()` returned true and the row is `done`; the statement
 *     re-checks `state = 'done'` anyway, because the caller is a detached
 *     promise and the row is the only authority.
 *  2. **Keyed by job id.** `ar_wallet_entry.idempotency_key = 'dealmemo:<job>'`
 *     and the unique index on that column mean a retry — a second finish, a
 *     duplicated call after a redeploy — cannot debit twice. The job row also
 *     refuses to advance `charged_drops` from anything but 0.
 *  3. **A run that failed or was interrupted never charges.** The reaper zeroes
 *     both charge columns; this module refuses a row that is not `done`.
 *
 * The debit cannot be withheld retroactively: the memo has already been made
 * and stored by the time this runs, so an account without the balance keeps the
 * memo and is simply not charged (`insufficient_balance`). Billing that takes
 * the work back is a worse product than a free memo.
 *
 * Money is integer Honey Drops. The job row's `charged_cents` stays 0 for this
 * lane — Drops are not cents — and `charged_drops` is the number the ledger
 * actually moved.
 */
import type { Q } from "./wallet";

/** The wallet's ledger, in Drops. Zero means free: no ledger row is written. */
export interface ChargeOutcome {
  /** Whether money moved in this call. */
  applied: boolean;
  /** Drops recorded on the job row after this call (0 when nothing moved). */
  chargedDrops: number;
  /**
   * charged          — this call moved money
   * already_charged  — the job was charged before (a retry), nothing moved
   * free             — the published price is 0, nothing moved
   * not_done         — the row is not `done`; a terminal/failed run never charges
   * insufficient     — the balance is below the price; the memo is kept, uncharged
   * no_wallet        — the account has no wallet row yet
   */
  reason: "charged" | "already_charged" | "free" | "not_done" | "insufficient" | "no_wallet";
  /** The account's balance after the call, when it could be read. */
  balance: number | null;
  /** The price this call was willing to take. */
  priceDrops: number;
}

const LEDGER_KEY = (jobId: string) => `dealmemo:${jobId}`;

/**
 * The price of one memo run.
 *
 * `BZ_DEAL_MEMO_PRICE_DROPS` is the owner's knob (prices are the owner's
 * business, as `entitlements.ts` says about cost ceilings). With no override,
 * the price is the listing price of the sealed bundle that actually ran — the
 * same number a shopper sees — and with no listing at all it is 0.
 */
export async function dealMemoPriceDrops(q: Q, recipeHash: string): Promise<number> {
  const override = Number((process.env.BZ_DEAL_MEMO_PRICE_DROPS ?? "").trim());
  if (Number.isSafeInteger(override) && override > 0) return override;
  const rows = await q<{ price: number | string | null }>(
    `SELECT COALESCE((manifest->'listing'->>'price_honey_drops')::int, 0) AS price
       FROM ar_recipe_bundle WHERE hash = $1 LIMIT 1`,
    [recipeHash],
  );
  const price = Number(rows[0]?.price ?? 0);
  return Number.isSafeInteger(price) && price > 0 ? price : 0;
}

/**
 * Debit one finished run, exactly once.
 *
 * One statement: the ledger entry is inserted only when the job is `done`, has
 * not been charged, the account can pay, and the idempotency key is unused; the
 * wallet, the ledger and the job's cached `charged_drops` all move together or
 * not at all.
 */
export async function chargeDealMemoRun(
  q: Q,
  args: { userId: string; jobId: string; priceDrops: number },
): Promise<ChargeOutcome> {
  const price = Math.trunc(args.priceDrops);
  if (!Number.isSafeInteger(price) || price < 0) throw new Error("priceDrops must be a non-negative integer");
  const base = { priceDrops: price, balance: null as number | null };
  if (price === 0) return { ...base, applied: false, chargedDrops: 0, reason: "free" };

  const key = LEDGER_KEY(args.jobId);
  const rows = await q<{ charged_drops: number | null; balance: number | null; debited: number }>(
    `WITH target AS (
       SELECT job_id, user_id FROM buzzy_deal_memo_jobs
        WHERE job_id = $1 AND user_id = $2 AND state = 'done' AND charged_drops = 0
     ), debit AS (
       INSERT INTO ar_wallet_entry (user_id, delta, balance_after, reason, ref, idempotency_key)
       SELECT w.user_id, -$3::int, w.balance - $3::int, 'purchase', $4, $5
         FROM ar_wallet w
         JOIN target t ON t.user_id = w.user_id
        WHERE w.balance >= $3::int
          AND NOT EXISTS (SELECT 1 FROM ar_wallet_entry e WHERE e.idempotency_key = $5)
       RETURNING delta
     ), moved AS (
       UPDATE ar_wallet w
          SET balance = w.balance + d.delta, updated_at = now()
         FROM debit d WHERE w.user_id = $2
       RETURNING w.balance
     ), job AS (
       UPDATE buzzy_deal_memo_jobs j
          SET charged_drops = $3::int, updated_at = now()
        WHERE j.job_id = $1 AND j.state = 'done' AND j.charged_drops = 0
          AND EXISTS (SELECT 1 FROM debit)
       RETURNING j.charged_drops
     )
     SELECT (SELECT charged_drops FROM job) AS charged_drops,
            (SELECT balance FROM moved) AS balance,
            (SELECT count(*) FROM debit)::int AS debited`,
    [args.jobId, args.userId, price, `deal-memo ${args.jobId}`, key],
  );

  const row = rows[0];
  if (row && Number(row.debited) > 0) {
    return { applied: true, chargedDrops: Number(row.charged_drops ?? price), reason: "charged", priceDrops: price, balance: row.balance == null ? null : Number(row.balance) };
  }

  // Nothing moved. Say why from the row itself — never guess, never retry.
  const why = await q<{ state: string; charged_drops: number; balance: number | null; already: boolean }>(
    `SELECT j.state,
            j.charged_drops,
            w.balance,
            EXISTS (SELECT 1 FROM ar_wallet_entry e WHERE e.idempotency_key = $3) AS already
       FROM buzzy_deal_memo_jobs j
       LEFT JOIN ar_wallet w ON w.user_id = j.user_id
      WHERE j.job_id = $1 AND j.user_id = $2`,
    [args.jobId, args.userId, key],
  );
  const seen = why[0];
  if (!seen) return { ...base, applied: false, chargedDrops: 0, reason: "not_done" };
  const charged = Number(seen.charged_drops ?? 0);
  const balance = seen.balance == null ? null : Number(seen.balance);
  if (seen.state !== "done") return { applied: false, chargedDrops: charged, reason: "not_done", priceDrops: price, balance };
  if (seen.already || charged > 0) return { applied: false, chargedDrops: charged || price, reason: "already_charged", priceDrops: price, balance };
  if (balance == null) return { applied: false, chargedDrops: 0, reason: "no_wallet", priceDrops: price, balance };
  if (balance < price) return { applied: false, chargedDrops: 0, reason: "insufficient", priceDrops: price, balance };
  // A row that is done, uncharged and affordable, yet the insert did not land, is
  // a statement-level surprise. Report it as not charged rather than inventing one.
  return { applied: false, chargedDrops: 0, reason: "not_done", priceDrops: price, balance };
}

/** A sentence the chat card and the poll can show without composing money. */
export function chargeLine(outcome: ChargeOutcome): string {
  switch (outcome.reason) {
    case "charged":
      return `Charged ${outcome.chargedDrops} Honey Drops.`;
    case "already_charged":
      return `${outcome.chargedDrops} Honey Drops had already been charged for this run.`;
    case "insufficient":
      return `Kept the memo uncharged: the price is ${outcome.priceDrops} Honey Drops and the balance is ${outcome.balance ?? 0}.`;
    case "no_wallet":
      return "Kept the memo uncharged: this account has no Honey Drops wallet yet.";
    case "not_done":
      return "Nothing charged: only a finished run can be charged.";
    default:
      return "Nothing charged.";
  }
}