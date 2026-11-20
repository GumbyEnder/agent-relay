/**
 * CR-9 phase F — the debit of a finished deal memo.
 *
 * What is proven on a real Postgres (PGlite) with the real migrations:
 *   1. a done run debits once, in Drops, keyed by job id, and caches it on the row;
 *   2. a retry (same job, second call) does not debit again;
 *   3. a run that is not `done` — failed or interrupted — never debits;
 *   4. an account without the balance keeps the memo and is not charged;
 *   5. a zero price writes no ledger row at all (a zero entry is noise, not money);
 *   6. another account's job id is not chargeable (no ownership holes);
 *   7. the boot reaper zeroes `charged_drops` when it interrupts a row.
 *
 * Run: npx tsx scripts/test-cre-charge.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

import {
  createDealMemoJob,
  finishDealMemoJob,
  markDealMemoRunning,
  newDealMemoJobId,
  sweepInterruptedDealMemoJobs,
  type DealMemoQuery,
} from "../src/lib/buzzy/cre/jobs";
import { chargeDealMemoRun, chargeLine, dealMemoPriceDrops } from "../src/lib/wallet/deal-memo-charge";

let passes = 0;
const failures: string[] = [];
function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    passes++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(repo, "migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const db = new PGlite();
for (const f of files) {
  try {
    await db.exec(await readFile(join(dir, f), "utf8"));
  } catch (e) {
    console.error(`✗ migration ${f} failed: ${e}`);
    process.exit(1);
  }
}
console.log(`applied ${files.length} migrations (last ${files.at(-1)})`);

const q: DealMemoQuery = <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
  db.query<T>(text, params ?? []).then((r) => r.rows);

const HASH = "c".repeat(64);

async function wallet(userId: string, balance: number) {
  await q(`INSERT INTO ar_wallet (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = $2`, [userId, balance]);
}
async function balanceOf(userId: string): Promise<number> {
  const rows = await q<{ balance: number }>(`SELECT balance FROM ar_wallet WHERE user_id = $1`, [userId]);
  return Number(rows[0]?.balance ?? 0);
}
async function entriesFor(jobId: string) {
  return q<{ delta: number; reason: string; idempotency_key: string }>(
    `SELECT delta, reason, idempotency_key FROM ar_wallet_entry WHERE idempotency_key = $1`,
    [`dealmemo:${jobId}`],
  );
}
async function startDoneJob(userId: string): Promise<string> {
  const jobId = newDealMemoJobId();
  await createDealMemoJob(q, { jobId, userId, recipeHash: HASH, title: "Maple Court" });
  await markDealMemoRunning(q, jobId);
  const applied = await finishDealMemoJob(q, { jobId, state: "done", message: "checks passed" });
  if (!applied) throw new Error("fixture: done transition refused");
  return jobId;
}

// 0. the price comes from the published listing, and an explicit override wins
const priceDefault = await dealMemoPriceDrops(q, HASH);
ok("no listing means a free run", priceDefault === 0, `price=${priceDefault}`);
await q(
  `INSERT INTO ar_recipe_bundle (hash, recipe_id, version, author_id, manifest, bundle_ref, semantic_ref, checks_ref)
   VALUES ($1, 'cre-deal-memo', '1.0.0', 'acct_owner',
           jsonb_build_object('protocol','recipe-seal/1','id','cre-deal-memo','version','1.0.0',
                              'created_at','2026-11-20T00:00:00.000Z',
                              'listing', jsonb_build_object('title','Deal memo','updated_at','2026-11-20T00:00:00.000Z',
                                                            'price_honey_drops', 40)),
           'bundle-deals', 'semantic-deals', 'checks-deals')
   ON CONFLICT (hash) DO NOTHING`,
  [HASH],
).catch((e) => {
  console.log(`  note: bundle fixture skipped (${e instanceof Error ? e.message.split("\n")[0] : e})`);
});
const priceListed = await dealMemoPriceDrops(q, HASH);
ok("the listing price is the default price", priceListed === 40, `price=${priceListed}`);
process.env.BZ_DEAL_MEMO_PRICE_DROPS = "75";
ok("BZ_DEAL_MEMO_PRICE_DROPS overrides the listing", (await dealMemoPriceDrops(q, HASH)) === 75);
delete process.env.BZ_DEAL_MEMO_PRICE_DROPS;

// 1. a done run debits exactly once
await wallet("u1", 100);
const jobA = await startDoneJob("u1");
const chargeA = await chargeDealMemoRun(q, { userId: "u1", jobId: jobA, priceDrops: 40 });
ok("a done run is charged", chargeA.applied && chargeA.reason === "charged" && chargeA.chargedDrops === 40);
ok("the wallet moved by the price", (await balanceOf("u1")) === 60, "100 -> 60");
const ledA = await entriesFor(jobA);
ok("one ledger row, keyed by the job", ledA.length === 1 && ledA[0]!.delta === -40 && ledA[0]!.reason === "purchase");
const rowA = await q<{ charged_drops: number }>(`SELECT charged_drops FROM buzzy_deal_memo_jobs WHERE job_id = $1`, [jobA]);
ok("the row caches what moved", Number(rowA[0]?.charged_drops) === 40);

// 2. a retry cannot debit twice
const chargeA2 = await chargeDealMemoRun(q, { userId: "u1", jobId: jobA, priceDrops: 40 });
ok("a second call is not a second debit", !chargeA2.applied && chargeA2.reason === "already_charged");
ok("the balance is unchanged by the retry", (await balanceOf("u1")) === 60);
ok("still one ledger row", (await entriesFor(jobA)).length === 1);

// 3. a failed run never charges
await wallet("u2", 100);
const jobFailed = newDealMemoJobId();
await createDealMemoJob(q, { jobId: jobFailed, userId: "u2", recipeHash: HASH });
await markDealMemoRunning(q, jobFailed);
await finishDealMemoJob(q, { jobId: jobFailed, state: "failed", message: "the listing would not parse" });
const chargeFailed = await chargeDealMemoRun(q, { userId: "u2", jobId: jobFailed, priceDrops: 40 });
ok("a failed run is not charged", !chargeFailed.applied && chargeFailed.reason === "not_done");
ok("the failed row stays at 0 drops", (await entriesFor(jobFailed)).length === 0 && (await balanceOf("u2")) === 100);

// 4. an interrupted run never charges
const jobSwept = newDealMemoJobId();
await createDealMemoJob(q, { jobId: jobSwept, userId: "u2", recipeHash: HASH, ownerHost: "agent-relay" });
await markDealMemoRunning(q, jobSwept);
const swept = await sweepInterruptedDealMemoJobs(q, { host: "agent-relay" });
ok("the sweep interrupts the queued run", swept.jobs === 1);
const chargeSwept = await chargeDealMemoRun(q, { userId: "u2", jobId: jobSwept, priceDrops: 40 });
ok("an interrupted run is not charged", !chargeSwept.applied && chargeSwept.reason === "not_done");
const sweptRow = await q<{ charged_drops: number; charged_cents: number }>(
  `SELECT charged_drops, charged_cents FROM buzzy_deal_memo_jobs WHERE job_id = $1`,
  [jobSwept],
);
ok("the interrupted row carries no charge at all", Number(sweptRow[0]?.charged_drops) === 0 && Number(sweptRow[0]?.charged_cents) === 0);

// 5. no balance: the memo is kept, the account is not charged
await wallet("u3", 10);
const jobPoor = await startDoneJob("u3");
const chargePoor = await chargeDealMemoRun(q, { userId: "u3", jobId: jobPoor, priceDrops: 40 });
ok("a short balance is not charged", !chargePoor.applied && chargePoor.reason === "insufficient", chargePoor.reason);
ok("the balance is untouched", (await balanceOf("u3")) === 10);
ok("the product says it in words", chargeLine(chargePoor).includes("uncharged"));

// 6. a zero price writes no ledger row
await wallet("u4", 100);
const jobFree = await startDoneJob("u4");
const chargeFree = await chargeDealMemoRun(q, { userId: "u4", jobId: jobFree, priceDrops: 0 });
ok("a free run writes nothing", !chargeFree.applied && chargeFree.reason === "free" && (await entriesFor(jobFree)).length === 0);
ok("the free run leaves the balance alone", (await balanceOf("u4")) === 100);

// 7. another account cannot charge this run
const chargeOther = await chargeDealMemoRun(q, { userId: "u2", jobId: jobA, priceDrops: 40 });
ok("a stranger's job id charges nothing", !chargeOther.applied && chargeOther.reason === "not_done");

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  ✗ ${f}`).join("\n"));
  process.exit(1);
}
