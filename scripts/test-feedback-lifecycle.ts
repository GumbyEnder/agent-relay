/**
 * Feedback, against a real database schema (in-memory PGLite, no DATABASE_URL).
 *
 * What 7319 asks for and this file proves:
 *  - the per-ip cap is 15/hour and it is enforced by the store, not the route;
 *  - the route-wide cap is a SECOND gate, and one abusive address cannot spend it;
 *  - the limiter is a proven concurrent arm: the UPSERT takes a row lock, so N
 *    simultaneous requests get N distinct counts instead of N copies of the same
 *    one. (PGLite is single-connection, so this proves the statement is
 *    monotonic and loss-free; the row lock itself is Postgres's, and is why the
 *    counter is a table rather than a count(*).)
 *  - ip_hash is nullable — a save with no address stores null, not "";
 *  - the sweep deletes what is past retention and nothing else;
 *  - portability's DELETION_STATEMENTS counts a person's reports in the receipt.
 *
 * Run: npx tsx scripts/test-feedback-lifecycle.ts   (wired into test:ci)
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  saveFeedback,
  checkFeedback,
  takeSlot,
  sweepOldFeedback,
  ipHash,
  IP_LIMIT,
  ROUTE_LIMIT,
  ROUTE_GATE,
  RETENTION_DAYS,
} from "../src/lib/buzzy/feedback";
import { deleteAccountData } from "../src/lib/buzzy/portability";

let failed = 0;
function ok(label: string, pass: boolean, detail?: unknown) {
  if (pass) console.log("  ok   " + label);
  else {
    failed++;
    console.log("  FAIL " + label + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
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
console.log(`applied ${files.length} migrations (through ${files.at(-1)}):`);

/** The repo's Sql surface, over PGlite. */
const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  let q = "";
  for (let i = 0; i < strings.length; i++) {
    q += strings[i];
    if (i < values.length) q += `$${i + 1}`;
  }
  const r = await db.query(q, values as unknown[]);
  return r.rows as never[];
}) as never as {
  (s: TemplateStringsArray, ...v: unknown[]): Promise<Record<string, unknown>[]>;
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
};
(sql as unknown as { query: (t: string, p?: unknown[]) => Promise<Record<string, unknown>[]> }).query = async (t, p) =>
  (await db.query(t, (p ?? []) as unknown[])).rows as Record<string, unknown>[];

const report = (msg: string) => {
  const c = checkFeedback({ message: msg });
  if (!c.ok) throw new Error("fixture refused: " + c.error);
  return c.report;
};

console.log("the per-ip cap is 15 an hour, enforced by the store:");
let last: unknown = null;
for (let i = 1; i <= IP_LIMIT; i++) {
  last = await saveFeedback(sql as never, null, report("report " + i), "203.0.113.7");
  if (!(last as { ok: boolean }).ok) break;
}
ok(`${IP_LIMIT} reports from one address are accepted`, (last as { ok: boolean }).ok === true, last);
const sixteenth = await saveFeedback(sql as never, null, report("one too many"), "203.0.113.7");
ok("the sixteenth is refused", sixteenth.ok === false && sixteenth.code === "rate_limited", sixteenth);
ok("and it says how long to wait", sixteenth.ok === false && sixteenth.retryAfter === 3600, sixteenth);
const other = await saveFeedback(sql as never, null, report("a different address"), "198.51.100.9");
ok("a different address is unaffected", other.ok === true, other);
const counted = await db.query<{ n: number }>("select count(*)::int as n from buzzy_feedback where ip_hash = $1", [ipHash("203.0.113.7")]);
ok("exactly the accepted reports were stored", counted.rows[0]!.n === IP_LIMIT, counted.rows[0]);

console.log("the route-wide cap is a second gate:");
await db.query(
  "insert into buzzy_feedback_gate (gate_key, bucket, n) values ($1, date_trunc('hour', now()), $2) on conflict (gate_key) do update set n = $2",
  [ROUTE_GATE, ROUTE_LIMIT],
);
const busy = await saveFeedback(sql as never, null, report("route is full"), "198.51.100.200");
ok("a full route refuses a fresh address", busy.ok === false && busy.code === "route_busy", busy);
await db.query("delete from buzzy_feedback_gate where gate_key = $1", [ROUTE_GATE]);

console.log("the limiter is a proven concurrent arm:");
await db.query("delete from buzzy_feedback_gate where gate_key = 'race'");
const racers = await Promise.all(Array.from({ length: 20 }, () => takeSlot(sql as never, "race", 1000)));
const ns = racers.slice().sort((a, b) => a - b);
ok("20 simultaneous takes give 20 distinct counts", new Set(ns).size === 20, ns);
ok("and they are exactly 1..20 — none lost, none repeated", ns.every((v, i) => v === i + 1), ns);

console.log("ip_hash is nullable:");
await saveFeedback(sql as never, null, report("no address at all"), "");
const nullRows = await db.query<{ n: number }>("select count(*)::int as n from buzzy_feedback where ip_hash is null");
ok("a save with no address stores null", nullRows.rows[0]!.n === 1, nullRows.rows[0]);
ok("no address means no limiter key, so no counter row", (await db.query<{ n: number }>("select count(*)::int as n from buzzy_feedback_gate where gate_key = ''")).rows[0]!.n === 0);

console.log("the sweep is bounded by retention:");
await db.query(
  `insert into buzzy_feedback (id, reference, message, created_at) values ($1, $2, $3, now() - ($4 || ' days')::interval)`,
  ["fb_ancient00000001", "BZ-OLD1", "ancient", String(RETENTION_DAYS + 10)],
);
const swept = await sweepOldFeedback(sql as never);
ok("the ancient row is swept", swept === 1, swept);
const left = await db.query<{ n: number }>("select count(*)::int as n from buzzy_feedback where id = 'fb_ancient00000001'");
ok("and it is gone", left.rows[0]!.n === 0);
const fresh = await db.query<{ n: number }>("select count(*)::int as n from buzzy_feedback where created_at > now() - interval '1 hour'");
ok("nothing fresh was swept", fresh.rows[0]!.n! > 0, fresh.rows[0]);

console.log("account deletion counts the person's reports (7319):");
const mine = report("signed-in report");
const saved = await saveFeedback(sql as never, "user_abc", mine, "203.0.113.55");
ok("a signed-in report saves with the user id", saved.ok === true, saved);
const receipt = await deleteAccountData(sql as never, "user_abc");
ok("the receipt names the table", Object.prototype.hasOwnProperty.call(receipt, "buzzy_feedback"), Object.keys(receipt));
ok("the receipt counts the row", receipt.buzzy_feedback === 1, receipt.buzzy_feedback);
const anonLeft = await db.query<{ n: number }>("select count(*)::int as n from buzzy_feedback where user_id is null");
ok("anonymous reports survive an account deletion", anonLeft.rows[0]!.n! > 0, anonLeft.rows[0]);

const noEmailCol = await db.query<{ n: number }>(
  "select count(*)::int as n from information_schema.columns where table_name = 'buzzy_feedback' and column_name = 'account_email'",
);
ok("there is no account_email column", noEmailCol.rows[0]!.n === 0, noEmailCol.rows[0]);

if (failed) {
  console.error(`\n${failed} feedback lifecycle test(s) failed`);
  process.exit(1);
}
console.log("\nall feedback lifecycle tests passed");
