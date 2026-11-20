/**
 * CR-9 phase E — the run record and the fail-closed boot sweep.
 *
 * What is proven here, on a real Postgres (PGlite) with the real migrations:
 *   1. a run is readable only by its owner (another account gets null -> 404);
 *   2. a finish writes `done` only with its charge, and clamps the charge to 0
 *      for every other terminal state;
 *   3. the sweep turns queued/running rows into `interrupted` with the exact
 *      text "interrupted, nothing charged", zeroes the charge, and interrupts
 *      the stage rows too;
 *   4. the sweep does NOT touch a live run owned by the sibling service — the
 *      console and the consumer host share one database;
 *   5. it does sweep a row that is simply too old to be alive (renamed service);
 *   6. `npm start` runs the reaper before the server binds.
 *
 * Run: npx tsx scripts/test-cre-jobs.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

import {
  createDealMemoJob,
  dealMemoJobsToday,
  finishDealMemoJob,
  finishDealMemoStage,
  markDealMemoRunning,
  newDealMemoJobId,
  readDealMemoJob,
  startDealMemoStage,
  sweepInterruptedDealMemoJobs,
  type DealMemoQuery,
} from "../src/lib/buzzy/cre/jobs";

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

const HASH = "a".repeat(64);

// 1. create + ownership
const jobA = newDealMemoJobId();
await createDealMemoJob(q, { jobId: jobA, userId: "u1", recipeHash: HASH, ownerHost: "agent-relay", title: "Maple Court" });
const owned = await readDealMemoJob(q, { userId: "u1", jobId: jobA });
ok("a run is created queued and uncharged", owned?.job.state === "queued" && owned?.job.charged_cents === 0);
ok("the owner reads their own run", owned?.job.job_id === jobA);
ok("another account cannot read it", (await readDealMemoJob(q, { userId: "u2", jobId: jobA })) === null);

// 2. terminal states and charge clamping
await markDealMemoRunning(q, jobA);
await startDealMemoStage(q, { jobId: jobA, seq: 1, key: "gate", label: "Checking the inputs" });
await finishDealMemoStage(q, { jobId: jobA, seq: 1, state: "done", note: "required inputs present" });
await finishDealMemoJob(q, { jobId: jobA, state: "done", message: "checks passed", chargedCents: 250 });
const done = await readDealMemoJob(q, { userId: "u1", jobId: jobA });
ok("done keeps its charge", done?.job.state === "done" && done?.job.charged_cents === 250);
ok("the stage row is done with its note", done?.stages[0]?.state === "done" && done?.stages[0]?.note === "required inputs present");

const jobFailed = newDealMemoJobId();
await createDealMemoJob(q, { jobId: jobFailed, userId: "u1", recipeHash: HASH, ownerHost: "agent-relay" });
await markDealMemoRunning(q, jobFailed);
await finishDealMemoJob(q, { jobId: jobFailed, state: "failed", message: "checks failed: C29", chargedCents: 500 });
const failed = await readDealMemoJob(q, { userId: "u1", jobId: jobFailed });
ok("a failed run cannot carry a charge", failed?.job.charged_cents === 0 && failed?.job.state === "failed");

// 3. sweep: this service's live run + a stage
const jobRunning = newDealMemoJobId();
await createDealMemoJob(q, { jobId: jobRunning, userId: "u1", recipeHash: HASH, ownerHost: "agent-relay" });
await markDealMemoRunning(q, jobRunning);
await startDealMemoStage(q, { jobId: jobRunning, seq: 1, key: "gate", label: "Checking the inputs" });
await startDealMemoStage(q, { jobId: jobRunning, seq: 2, key: "ingest", label: "Reading the listing" });
await finishDealMemoStage(q, { jobId: jobRunning, seq: 2, state: "done" });

// 4. sweep: a live run owned by the sibling service
const jobSibling = newDealMemoJobId();
await createDealMemoJob(q, { jobId: jobSibling, userId: "u1", recipeHash: HASH, ownerHost: "beezilla-web" });
await markDealMemoRunning(q, jobSibling);

// 5. sweep: an old row from a service name that no longer exists
const jobOld = newDealMemoJobId();
await createDealMemoJob(q, { jobId: jobOld, userId: "u1", recipeHash: HASH, ownerHost: "retired-host" });
await markDealMemoRunning(q, jobOld);
await q(`UPDATE buzzy_deal_memo_jobs SET created_at = now() - interval '3 hours' WHERE job_id = $1`, [jobOld]);

const swept = await sweepInterruptedDealMemoJobs(q, { host: "agent-relay", staleHours: 2 });
ok("the sweep interrupts exactly the dead runs it owns", swept.jobs === 2, `jobs=${swept.jobs}, stages=${swept.stages}`);
const interrupted = await readDealMemoJob(q, { userId: "u1", jobId: jobRunning });
ok("the message is the promise, word for word", interrupted?.job.message === "interrupted, nothing charged");
ok("an interrupted run is uncharged", interrupted?.job.charged_cents === 0);
ok(
  "its running stage is interrupted and its finished stage is untouched",
  interrupted?.stages.find((s) => s.seq === 1)?.state === "interrupted" &&
    interrupted?.stages.find((s) => s.seq === 2)?.state === "done",
);
const sibling = await readDealMemoJob(q, { userId: "u1", jobId: jobSibling });
ok("the sibling service's live run is untouched", sibling?.job.state === "running");
const old = await readDealMemoJob(q, { userId: "u1", jobId: jobOld });
ok("a row too old to be alive is swept whoever owns it", old?.job.state === "interrupted");

// the second sweep is a no-op: interruption is not repeated work
const again = await sweepInterruptedDealMemoJobs(q, { host: "agent-relay", staleHours: 2 });
ok("a second sweep finds nothing", again.jobs === 0 && again.stages === 0);

// daily cap reads real rows
const today = await dealMemoJobsToday(q, "u1");
ok("the daily cap counts this account's runs", today === 5, `count=${today}`);

// 6. the reaper is in the boot chain
const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
ok("npm start runs the reaper before the server", /deal-memo-reaper\.mjs && .*\.output\/server\/index\.mjs/.test(pkg.scripts.start ?? ""));

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`FAILED: ${failures.join(" | ")}`);
  process.exit(1);
}
