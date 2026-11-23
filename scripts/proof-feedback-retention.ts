/**
 * CR-6 retention proof — the arms, against a real Postgres, with seeded rows.
 *
 * Run: npx tsx scripts/proof-feedback-retention.ts
 *
 * Uses scripts/retention.mjs's exported sweepFeedback (the same function the boot
 * line runs), not a copy of its SQL. Seeds one row per arm, plus the two extra
 * arms frodo asked for: a 12-months-minus-a-day row whose diagnostic must not be
 * touched, and a deleted account's row that must appear in the deletion
 * receipt's count and be gone from the table.
 *
 * The database is created fresh (feedback_proof) so the numbers are the seed's,
 * not whatever was already there.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — plain-JS module, deliberately shared with the boot script.
import { sweepFeedback } from "./retention.mjs";
import { DELETION_STATEMENTS } from "../src/lib/buzzy/portability";

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = process.env.PROOF_PG_ADMIN || "postgres://postgres:test@127.0.0.1:55432/postgres";
const DB = "feedback_proof";
const URL = ADMIN.replace(/\/postgres(\?|$)/, `/${DB}$1`);

let failed = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`ok   ${label}`);
  else {
    failed += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
};

async function main() {
  {
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
  }
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  const sql = readFileSync(join(here, "..", "migrations", "0059_buzzy_feedback.sql"), "utf8");
  await client.query(sql);

  const insert = (id: string, months: number, opts: { diag?: string | null; ip?: string | null; user?: string | null } = {}) =>
    client.query(
      `INSERT INTO buzzy_feedback (id, ref, created_at, user_id, body, page_url, route, app_sha, diag, ip_hash, ua)
       VALUES ($1, $2, now() - ($3::text || ' months')::interval, $4, $5, '/buzzy/talk', 'talk', 'testsha',
               $6::jsonb, $7, 'test-agent')
       RETURNING created_at`,
      [id, `BZ-FB-${id.slice(-6).toUpperCase()}`, String(months), opts.user ?? null, `words for ${id}`, opts.diag ?? null, opts.ip ?? "iphash"],
    );

  await insert("aaaaaaaa-0001-4aaa-8aaa-000000000001", 25, { diag: '{"a":1}' }); // deleted by arm 1
  await insert("bbbbbbbb-0002-4bbb-8bbb-000000000002", 13, { diag: '{"b":2}' }); // diag nulled
  await insert("cccccccc-0003-4ccc-8ccc-000000000003", 4, { diag: '{"c":3}', ip: "oldhash" }); // ip nulled (91d)
  await client.query(
    `UPDATE buzzy_feedback SET created_at = now() - interval '91 days' WHERE id = 'cccccccc-0003-4ccc-8ccc-000000000003'`,
  );
  await client.query(
    `INSERT INTO buzzy_feedback (id, ref, created_at, body, page_url, route, app_sha, diag, ip_hash, ua)
     VALUES ('dddddddd-0004-4ddd-8ddd-000000000004', 'BZ-FB-FRESH1', now(), 'fresh words', '/buzzy/talk', 'talk', 'testsha', '{"d":4}'::jsonb, 'freshhash', 'ua')`,
  );
  // 12 months minus a day: diag MUST survive.
  await client.query(
    `INSERT INTO buzzy_feedback (id, ref, created_at, body, page_url, route, app_sha, diag, ip_hash, ua)
     VALUES ('eeeeeeee-0005-4eee-8eee-000000000005', 'BZ-FB-EDGE12', now() - interval '12 months' + interval '1 day',
             'edge words', '/buzzy/talk', 'talk', 'testsha', '{"e":5}'::jsonb, 'edgehash', 'ua')`,
  );
  // Account-deletion arm.
  await client.query(
    `INSERT INTO buzzy_feedback (id, ref, created_at, user_id, body, page_url, route, app_sha, ip_hash, ua)
     VALUES ('ffffffff-0006-4fff-8fff-000000000006', 'BZ-FB-DELACC', now(), 'usr_delete_me', 'delete me',
             '/buzzy/talk', 'talk', 'testsha', 'delhash', 'ua')`,
  );
  // ASR throttle rows: one old, one fresh.
  await client.query(`INSERT INTO buzzy_feedback_asr_hits (ip_hash, created_at) VALUES ('h', now() - interval '3 days')`);
  await client.query(`INSERT INTO buzzy_feedback_asr_hits (ip_hash, created_at) VALUES ('h', now())`);

  const freshBefore = (await client.query(`SELECT * FROM buzzy_feedback WHERE ref = 'BZ-FB-FRESH1'`)).rows[0];
  const edgeBefore = (await client.query(`SELECT * FROM buzzy_feedback WHERE ref = 'BZ-FB-EDGE12'`)).rows[0];

  const first = await sweepFeedback(client);
  console.log("     sweep#1 " + JSON.stringify(first));
  ok("25-month row deleted", first.feedback_rows === 1, first.feedback_rows);
  ok("13-month diag nulled", first.diag_nulled === 1, first.diag_nulled);
  // Three hashes are older than 90 days: the 25-month row, the 13-month row and
  // the 4-month row backdated to 91 days. All three are past the limiter's only
  // use, so all three are nulled — the arm counts rows, not "rows that have an
  // ip_hash and nothing else wrong with them".
  ok("91-day ip hash nulled", first.ip_nulled === 3, first.ip_nulled);
  ok("old asr hit deleted", first.asr_hits === 1, first.asr_hits);

  const rows = (await client.query(`SELECT id, ref, body, created_at, diag, ip_hash FROM buzzy_feedback ORDER BY id`)).rows;
  const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]));
  ok("25-month row gone", !rows.some((r) => r.id.startsWith("aaaaaaaa")), rows.map((r) => r.id));
  const b = rows.find((r) => r.id.startsWith("bbbbbbbb"));
  ok("13-month words survive", b?.body === "words for bbbbbbbb-0002-4bbb-8bbb-000000000002", b?.body);
  ok("13-month ref survives", b?.ref === "BZ-FB-000002", b?.ref);
  ok("13-month date survives", Boolean(b?.created_at), b?.created_at);
  ok("13-month diag is NULL", b?.diag === null, b?.diag);
  const c = rows.find((r) => r.id.startsWith("cccccccc"));
  ok("91-day ip_hash is NULL", c?.ip_hash === null, c?.ip_hash);
  ok("91-day body intact", c?.body === "words for cccccccc-0003-4ccc-8ccc-000000000003", c?.body);
  const freshAfter = (await client.query(`SELECT * FROM buzzy_feedback WHERE ref = 'BZ-FB-FRESH1'`)).rows[0];
  ok(
    "fresh row byte-identical",
    JSON.stringify(freshBefore) === JSON.stringify(freshAfter),
    { before: freshBefore, after: freshAfter },
  );
  const edgeAfter = (await client.query(`SELECT * FROM buzzy_feedback WHERE ref = 'BZ-FB-EDGE12'`)).rows[0];
  ok("12-months-minus-a-day diag untouched", JSON.stringify(edgeBefore.diag) === JSON.stringify(edgeAfter.diag), edgeAfter.diag);
  ok("2-day asr row kept", ((await client.query(`SELECT count(*)::int AS n FROM buzzy_feedback_asr_hits`)).rows[0] as any).n === 1);

  // Serial rerun is not the claim — the advisory lock is — but a rerun must be a
  // no-op, so the counts below are the "nothing left to do" reading.
  const second = await sweepFeedback(client);
  console.log("     sweep#2 " + JSON.stringify(second));
  ok("rerun does nothing", Object.values(second).every((n) => n === 0), second);

  // Account deletion: the actual statement from the actual map, counted like the
  // receipt counts it.
  const stmt = DELETION_STATEMENTS["buzzy_feedback"];
  ok("buzzy_feedback is in DELETION_STATEMENTS", Boolean(stmt), Object.keys(DELETION_STATEMENTS).length);
  const removed = await client.query(stmt!, ["usr_delete_me"]);
  const receipt = { buzzy_feedback: removed.rows.length };
  ok("deletion receipt counts the feedback row", receipt.buzzy_feedback === 1, receipt);
  const left = (await client.query(`SELECT count(*)::int AS n FROM buzzy_feedback WHERE user_id = 'usr_delete_me'`)).rows[0] as any;
  ok("deleted account's row is gone", left.n === 0, left);
  const anon = (await client.query(`SELECT count(*)::int AS n FROM buzzy_feedback WHERE user_id IS NULL`)).rows[0] as any;
  ok("anonymous rows are untouched by deletion", anon.n === 4, anon);

  await client.end();
  if (failed) {
    console.error(`\nretention proof: FAILED — ${failed} case(s)`);
    process.exit(1);
  }
  console.log("\nretention proof: all checks passed");
}

main().catch((e) => {
  console.error("retention proof: ERROR", e?.message || e);
  process.exit(1);
});
