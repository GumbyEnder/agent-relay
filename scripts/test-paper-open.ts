/**
 * A paper on a blank landing — CR-14, the SQL half.
 *
 * The bug: Talk's landing loaded "the company's latest paper" with no job scope, so a
 * finished letter stayed on screen forever and the page adopted its job id. On
 * shane@veanox.com that was pp_0165a978ab20406d ("Pasted letter / need to do my taxes")
 * silently binding job_283b80118dc746fb.
 *
 * The rule now: with NO job named, a landing shows only the newest paper whose job is
 * still OPEN. A named job still shows that job's paper, open or finished — you asked for
 * that job. "Open" is the Library's own completion signal: a stored status that names
 * the end, or all four board steps in Done.
 *
 * This runs the REAL queries from src/lib/buzzy/paper.ts against the REAL migrations on
 * the real Postgres engine (PGlite), so the SQL and the JS rule are checked against each
 * other rather than against my memory of them.
 *
 *   run: npx tsx scripts/test-paper-open.ts
 */
import { getSql } from "@/lib/db";
import { jobIsOpen, JOB_DONE_STATUSES, latestPaper, deletePaper } from "@/lib/buzzy/paper";

let failures = 0;
function check(name: string, cond: unknown, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

const run = Date.now().toString(36);
const USER = `cr14_${run}`;
const CO = `co_${run}a1b2c3d4`;
const OTHER_CO = `co_${run}f9e8d7c6`;

function paperRows(paper: Awaited<ReturnType<typeof latestPaper>>) {
  return paper ? { id: paper.id, jobId: paper.jobId, jobOpen: paper.jobOpen, jobTitle: paper.jobTitle } : null;
}

async function main() {
  const sql = await getSql();

  // ── the rule itself, row by row ─────────────────────────────────────────
  const cases: Array<[string, string | null, unknown, boolean]> = [
    ["Not started", "Not started", {}, true],
    ["Discovering", "Discovering", {}, true],
    ["In progress", "In progress", {}, true],
    ["Deliverable ready", "Deliverable ready", {}, false],
    ["Done", "Done", {}, false],
    ["lowercase done", "done", {}, false],
    ["padded DONE", " DONE ", {}, false],
    ["Cancelled", "Cancelled", {}, false],
    ["Archived", "archived", {}, false],
    ["blank status", "", {}, true],
    ["null status", null, {}, true],
    ["board 3 of 4 Done", "In progress", { board: { Done: [1, 2, 3] } }, true],
    ["board 4 of 4 Done", "In progress", { board: { Done: [1, 2, 3, 4] } }, false],
    ["no board", "Not started", { title: "x" }, true],
    ["board not an array", "Not started", { board: { Done: "yes" } }, true],
  ];
  for (const [name, status, data, want] of cases) {
    check(`jobIsOpen: ${name} → ${want}`, jobIsOpen(status, data) === want, `got ${jobIsOpen(status, data)}`);
  }
  for (const status of JOB_DONE_STATUSES) {
    check(`jobIsOpen: every done word closes the job (${status})`, jobIsOpen(status, {}) === false);
  }

  // ── the queries, on the real schema ────────────────────────────────────
  // Two companies for the same owner: a paper must never cross companies.
  const kept = `job_${run}kept`;
  const finishedStatus = `job_${run}done`;
  const finishedBoard = `job_${run}board`;
  const goneJob = `job_${run}gone`;

  await sql`
    INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
    VALUES
      (${kept}, ${USER}, NULL, 'Pasted letter / need to do my taxes', 'Not started', ${CO}, ${JSON.stringify({ board: { Done: [] } })}::jsonb, now()),
      (${finishedStatus}, ${USER}, NULL, 'Old letter already done', 'Done', ${CO}, ${JSON.stringify({})}::jsonb, now()),
      (${finishedBoard}, ${USER}, NULL, 'Board finished it', 'In progress', ${CO}, ${JSON.stringify({ board: { Done: [1, 2, 3, 4] } })}::jsonb, now())
  `;

  // Newest first by created_at: the DONE one is the newest, so a landing that ignores
  // openness picks the finished letter — that is the exact reported bug.
  const oldPaper = `pp_${run}old00001`;
  const donePaper = `pp_${run}done0001`;
  const boardPaper = `pp_${run}board001`;
  await sql`
    INSERT INTO buzzy_papers (id, user_id, company_id, job_id, session_id, filename, kind, place, body, created_at)
    VALUES
      (${oldPaper},  ${USER}, ${CO}, ${kept},          NULL, 'need-to-do-my-taxes.txt', 'letter', 'the letter you pasted', 'BZMETA\t{"sentence":"s","question":null,"gaps":[],"reply":"r"}\nDear me', now() - interval '3 hours'),
      (${donePaper}, ${USER}, ${CO}, ${finishedStatus}, NULL, 'finished-letter.txt',    'letter', 'the letter you pasted', 'BZMETA\t{"sentence":"s","question":null,"gaps":[],"reply":"r"}\nfinished', now() - interval '1 hour'),
      (${boardPaper},${USER}, ${CO}, ${finishedBoard},  NULL, 'board-letter.txt',       'letter', 'the letter you pasted', 'BZMETA\t{"sentence":"s","question":null,"gaps":[],"reply":"r"}\nboard', now())
  `;
  await sql`
    INSERT INTO buzzy_paper_facts (id, paper_id, user_id, company_id, job_id, fact_key, label, value, status, place, original_value)
    VALUES
      (${`pf_${run}a1`}, ${oldPaper}, ${USER}, ${CO}, ${kept}, 'amount', 'The amount', '$1,250.00', 'confirmed', 'the letter you pasted', '$1,250.00'),
      (${`pf_${run}a2`}, ${oldPaper}, ${USER}, ${CO}, ${kept}, 'due',    'The due date', '', 'proposed', 'the letter you pasted', '')
  `;
  // A paper on a second company, newest of all: it must not answer for CO.
  await sql`
    INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
    VALUES (${goneJob}, ${USER}, NULL, 'Other company job', 'Not started', ${OTHER_CO}, '{}'::jsonb, now())
  `;
  await sql`
    INSERT INTO buzzy_papers (id, user_id, company_id, job_id, session_id, filename, kind, place, body, created_at)
    VALUES (${`pp_${run}other01`}, ${USER}, ${OTHER_CO}, ${goneJob}, NULL, 'other-co.txt', 'letter', 'the letter you pasted',
            'BZMETA\t{"sentence":"s","question":null,"gaps":[],"reply":"r"}\nother', now() + interval '1 hour')
  `;

  // A blank landing: the two newest papers belong to finished jobs → the third, OPEN one.
  let paper = await latestPaper(sql, USER, CO, null);
  check(
    "blank landing skips the two finished jobs and returns the open one",
    paper && paper.id === oldPaper,
    JSON.stringify(paperRows(paper)),
  );
  check("blank landing: jobOpen is true", paper?.jobOpen === true, JSON.stringify(paperRows(paper)));
  check(
    "blank landing: the job's title comes with it (so the page can say which job)",
    paper?.jobTitle === "Pasted letter / need to do my taxes",
    JSON.stringify(paperRows(paper)),
  );
  check("blank landing never crosses companies", paper?.companyId === CO);

  // A named job still shows its own paper, finished or not — the page asked for that job.
  paper = await latestPaper(sql, USER, CO, finishedStatus);
  check("named job shows its finished paper", paper?.id === donePaper, JSON.stringify(paperRows(paper)));
  check("named job: jobOpen false is reported, not hidden", paper?.jobOpen === false);

  paper = await latestPaper(sql, USER, CO, finishedBoard);
  check("named job: board-finished paper still shows, jobOpen false", paper?.id === boardPaper && paper?.jobOpen === false);

  // Nobody open on this company? No paper, not a stale one.
  await sql`UPDATE buzzy_jobs SET status = 'Done' WHERE id = ${kept} AND user_id = ${USER}`;
  paper = await latestPaper(sql, USER, CO, null);
  check("no open job left → no paper on the landing", paper === null, JSON.stringify(paperRows(paper)));

  // Back open again, and a job whose row is GONE is not open either.
  await sql`UPDATE buzzy_jobs SET status = 'In progress' WHERE id = ${kept} AND user_id = ${USER}`;
  paper = await latestPaper(sql, USER, CO, null);
  check("job open again → the paper is back", paper?.id === oldPaper);
  await sql`UPDATE buzzy_papers SET job_id = ${goneJob + "x"} WHERE id = ${oldPaper} AND user_id = ${USER}`;
  paper = await latestPaper(sql, USER, CO, null);
  check("paper whose job row is missing is not open", paper === null, JSON.stringify(paperRows(paper)));
  await sql`UPDATE buzzy_papers SET job_id = ${kept} WHERE id = ${oldPaper} AND user_id = ${USER}`;

  // ── delete: the sheet goes, the accepted line stays ────────────────────
  const otherOwner = await deletePaper(sql, `someone_else_${run}`, oldPaper);
  check("delete: another account cannot delete it", otherOwner.ok === false && otherOwner.status === 404);

  const gone = await deletePaper(sql, USER, oldPaper);
  check("delete: the owner can", gone.ok === true, JSON.stringify(gone));

  const paperRow = await sql`SELECT id FROM buzzy_papers WHERE id = ${oldPaper} AND user_id = ${USER}`;
  check("delete: the paper row is gone", paperRow.length === 0);
  const proposed = await sql`
    SELECT id FROM buzzy_paper_facts WHERE paper_id = ${oldPaper} AND user_id = ${USER} AND status <> 'confirmed'
  `;
  check("delete: proposed lines went with it", proposed.length === 0);
  const confirmed = await sql`
    SELECT value FROM buzzy_paper_facts WHERE paper_id = ${oldPaper} AND user_id = ${USER} AND status = 'confirmed'
  `;
  check(
    "delete: the line the owner CONFIRMED stays (it is a company fact)",
    confirmed.length === 1 && String(confirmed[0].value) === "$1,250.00",
    JSON.stringify(confirmed),
  );

  const again = await deletePaper(sql, USER, oldPaper);
  check("delete twice → 404, not a 500", again.ok === false && again.status === 404);
  const badId = await deletePaper(sql, USER, "pp_not-a-real-id");
  check("delete with a malformed id → 404", badId.ok === false && badId.status === 404);

  // ── the route is wired, and wired BEFORE the catch-all ─────────────────
  const routeSrc = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/lib/buzzy/chat.nitro.ts", import.meta.url), "utf8"),
  );
  check(
    "chat.nitro.ts imports deletePaper and handles DELETE on /api/buzzy/papers/:id",
    /deletePaper/.test(routeSrc) && /method === "DELETE" && paperDelete/.test(routeSrc),
  );
  check(
    "the DELETE route sits before the unmatched-route 404",
    routeSrc.indexOf('method === "DELETE" && paperDelete') < routeSrc.indexOf("unmatched /api/buzzy route"),
  );

  console.log(`\n${failures === 0 ? "all checks passed" : failures + " FAILED"}`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
