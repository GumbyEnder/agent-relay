/**
 * Replay test for migrations/0055_stale_sweep_backfill.sql.
 *
 * 0055 is a one-time drain that an operator may have to replay (restore a dump,
 * re-run by hand). Replay must not write a second history row, a second event,
 * or a second per-board summary — and must not re-demote a card that was moved
 * back to Running after the first run.
 *
 * Applies 0001..0054 to a fresh in-memory PGLite, seeds a stranded runner, runs
 * 0055, then re-strands the card and runs 0055 again. No DATABASE_URL needed.
 *
 * Run: node scripts/test-0055-replay.mjs   (wired into test:ci)
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(repo, "migrations");
const read = (n) => readFile(join(dir, n), "utf8");

function assert(c, m) {
  if (!c) throw new Error(m);
}

const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const backfillName = "0055_stale_sweep_backfill.sql";
const pre = files.filter((f) => f < backfillName);
assert(pre.length > 0 && files.includes(backfillName), "0055 present in migrations/");
console.log(`applying ${pre.length} migrations (through ${pre.at(-1)})`);

const db = new PGlite();
for (const f of pre) {
  // Fatal, not skipped: if a schema migration fails, the seed below proves
  // nothing and the whole "replay-safe" verdict would be vacuous.
  try {
    await db.exec(await read(f));
  } catch (e) {
    console.error(`✗ migration ${f} failed: ${e}`);
    process.exit(1);
  }
}

await db.exec(`
  insert into ar_missions (id, title, column_id, claimed_by, claimed_at, last_heartbeat, updated_at)
  values ('m_stranded', 'stranded runner', 'running', null, null,
          now() - interval '2 days', now() - interval '2 days');
  insert into ar_missions (id, title, column_id, claimed_by, last_heartbeat, updated_at, external_id)
  values ('m_165', 'epic', 'running', null,
          now() - interval '2 days', now() - interval '2 days',
          'github:gumbyender/agent-relay#165');
  -- no clocks at all, only a fresh updated_at: same rule as the poll's sweep,
  -- so 0055 must leave it alone (it is not stranded, it was just touched)
  insert into ar_missions (id, title, column_id, claimed_by, claimed_at, last_heartbeat, updated_at)
  values ('m_just_moved', 'just moved', 'running', null, null, null, now());
`);

const backfill = await read(backfillName);
const hist = async () =>
  (
    await db.query(
      `select count(*)::int as n from ar_mission_history
        where mission_id = 'm_stranded'
          and note = 'released-by-stale-sweep backfill 2026-11-10'`,
    )
  ).rows[0].n;
const evs = async () =>
  (
    await db.query(
      `select count(*)::int as n from ar_events
        where mission_id = 'm_stranded' and kind = 'mission_released'`,
    )
  ).rows[0].n;
const col = async (id) =>
  (await db.query(`select column_id from ar_missions where id = $1`, [id])).rows[0].column_id;

await db.exec(backfill);
const first = { hist: await hist(), ev: await evs(), col: await col("m_stranded") };
console.log("after run #1:", JSON.stringify(first));
assert(first.hist === 1, `run #1: one history row (got ${first.hist})`);
assert(first.ev === 1, `run #1: one event (got ${first.ev})`);
assert(first.col === "inbox", `run #1: demoted to inbox (got ${first.col})`);

// Hardest replay: the card is stranded again (operator moved it back), which is
// exactly when a naive rerun re-demotes and re-writes.
await db.exec(`
  update ar_missions
     set column_id = 'running', claimed_by = null, claimed_at = null,
         last_heartbeat = now() - interval '2 days',
         updated_at = now() - interval '2 days'
   where id = 'm_stranded';
`);
await db.exec(backfill);
const second = { hist: await hist(), ev: await evs(), col: await col("m_stranded") };
console.log("after run #2 (card re-stranded):", JSON.stringify(second));
assert(second.hist === 1, `replay: still one history row (got ${second.hist})`);
assert(second.ev === 1, `replay: still one event (got ${second.ev})`);
assert(second.col === "running", `replay: card left where the operator put it (got ${second.col})`);

const summaries = (
  await db.query(`select id, meta->>'count' as n from ar_events where id like 'ev_bf_board_%'`)
).rows;
console.log("per-board summary rows:", JSON.stringify(summaries));
assert(summaries.length === 1, `one per-board summary (got ${summaries.length})`);
assert(Number(summaries[0].n) === 1, `summary counts the card once (got ${summaries[0].n})`);

// the boot backfill uses the same clock as the poll: a fresh touch is not stale
const moved = await col("m_just_moved");
assert(moved === "running", `freshly-touched card left in running by 0055 (got ${moved})`);

const tagged = (
  await db.query(
    `select tags from ar_missions where external_id = 'github:gumbyender/agent-relay#165'`,
  )
).rows[0].tags;
assert(Array.isArray(tagged) && tagged.includes("sustained"), "#165 tagged sustained");
assert(
  tagged.filter((t) => String(t).toLowerCase() === "sustained").length === 1,
  `#165 tagged sustained exactly once (got ${JSON.stringify(tagged)})`,
);

await db.close();
console.log("✓ 0055 replay-safe: no duplicate history/event, no double-count, no re-demotion, #165 tagged");
