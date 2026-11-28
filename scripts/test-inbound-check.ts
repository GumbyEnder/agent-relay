/**
 * CR-21 — the inbound check, facts-only v0.
 *
 * What this proves, in the order the review asked for it:
 *   1. two GETs write nothing (row counts AND job.updated_at unchanged);
 *   2. another user's paper is a 404;
 *   3. a locked PDF has no row to check (savePaper refuses it before the INSERT);
 *   4. an unread paper, and a readable paper with nothing confirmed, are both
 *      no_confirmed_fact with the accepted sentence;
 *   5. every finding carries a place — a confirmed line with no place is named
 *      in `uncited` and never quoted;
 *   6. the tool gate: "paper" is on the union, check_paper is free / read-only /
 *      no egress, and it is offered only while a paper is on the job.
 *
 * Runs the REAL module against the REAL migrations on PGlite, so the SQL and the
 * rules are checked against each other rather than against my memory of them.
 *
 *   run: npx tsx scripts/test-inbound-check.ts
 */
import { readFileSync } from "node:fs";
import { getSql } from "@/lib/db";
import { readPaper, savePaper, updatePaperLine } from "@/lib/buzzy/paper";
import {
  inboundCheck,
  inboundReport,
  inboundCards,
  INBOUND_COLUMNS,
  INBOUND_NO_FACTS,
  INBOUND_NOTE,
  type InboundReport,
} from "@/lib/buzzy/inboundCheck";
import { offeredToolNames, policyFor, refusalFor } from "@/lib/buzzy/toolRegistry";

let failures = 0;
function check(name: string, cond: unknown, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

const run = Date.now().toString(36);
const USER = `cr21_${run}`;
const OTHER = `cr21other_${run}`;
const CO = `co_${run}a1b2c3d4`;

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

async function main() {
  const sql = await getSql();

  // ── 1. the report, from confirmed rows only (pure) ─────────────────────
  const full = inboundReport({
    paperId: `pp_${run}full0001`,
    jobId: `job_${run}full`,
    kind: "invoice",
    filename: "invoice-118.pdf",
    place: "the file invoice-118.pdf",
    facts: [
      { fact_key: "parties", label: "Who it's between", value: "From Northwind Ltd to Shane", place: "the file invoice-118.pdf" },
      { fact_key: "date", label: "The date", value: "2026-11-02", place: "the file invoice-118.pdf" },
      { fact_key: "amount", label: "The amount", value: "$1,250.00", place: "the file invoice-118.pdf" },
      { fact_key: "asked", label: "What's being asked", value: "Pay the November retainer", place: "page 1 of the file invoice-118.pdf" },
      { fact_key: "due", label: "The due date", value: "2026-12-01", place: "the file invoice-118.pdf" },
    ],
  });
  check("five confirmed lines → five findings", full.findings.length === 5, JSON.stringify(full.findings.map((f) => f.key)));
  check("every finding has a place", full.findings.every((f) => f.place.trim().length > 0), JSON.stringify(full.findings));
  check("every finding quotes the value exactly", full.findings.every((f) => f.sentence.includes(f.value)), JSON.stringify(full.findings));
  check("amount/asked/due are obligations, parties/date are facts",
    full.findings.filter((f) => f.kind === "obligation").map((f) => f.key).join() === "amount,asked,due");
  check("nothing confirmed is missing → no gaps", full.gaps.length === 0);
  check("no arithmetic verdict in v0", full.arithmetic === null);
  check("the note says what it does not do", full.note === INBOUND_NOTE && /no arithmetic verdict/.test(full.note));
  check("the reply quotes each place", full.findings.every((f) => full.reply.includes(f.place)));
  check("nothing claims to be sent or filed", /Nothing is sent or filed from this\./.test(full.reply));

  // A gap stays a gap, and says so without claiming anything about the prose.
  const gapped = inboundReport({
    paperId: `pp_${run}gap00001`,
    jobId: null,
    kind: "letter",
    filename: "",
    place: "the letter you pasted",
    facts: [
      { fact_key: "asked", label: "What's being asked", value: "Fix the fence by Friday", place: "the letter you pasted" },
      { fact_key: "due", label: "The due date", value: "", place: "the letter you pasted" }, // proposed/blank: the DB filter excludes it, the pure fn must too
    ],
  });
  check("a blank value is not a finding", gapped.findings.length === 1 && gapped.findings[0].key === "asked");
  check("blank value → the key is a gap, not a finding", gapped.gaps.map((g) => g.key).includes("due"));
  check("the gap sentence is about the confirmation, not the page",
    gapped.gaps.find((g) => g.key === "due")?.sentence === "No due date is confirmed on this paper.");
  check("questions are capped at three", gapped.questions.length <= 3, String(gapped.questions.length));
  check("each question stands on a confirmed line with a place",
    gapped.questions.every((q) => q.fact !== null && q.fact.place.trim().length > 0), JSON.stringify(gapped.questions));
  check("each question is about a missing key",
    gapped.questions.every((q) => gapped.gaps.some((g) => g.key === q.about)), JSON.stringify(gapped.questions));

  // A line kind we do not know is not quoted, and a confirmed line with no place
  // is named in `uncited` — never a finding without a place.
  const odd = inboundReport({
    paperId: `pp_${run}odd00001`,
    jobId: null,
    kind: "paper",
    filename: "",
    place: "the letter you pasted",
    facts: [
      { fact_key: "amount", label: "The amount", value: "$40.00", place: "" },
      { fact_key: "notes", label: "Notes", value: "call first", place: "the letter you pasted" },
      { fact_key: "asked", label: "What's being asked", value: "Book the van", place: "the letter you pasted" },
    ],
  });
  check("an unknown key is never quoted", odd.findings.every((f) => f.key !== "notes"));
  check("a confirmed line with no place is not a finding", odd.findings.length === 1 && odd.findings[0].key === "asked");
  check("…it is named in uncited", odd.uncited.length === 1 && odd.uncited[0].key === "amount");
  check("…and it is not also called a gap (that would be false)", !odd.gaps.some((g) => g.key === "amount"));

  // Cards: built here, written nowhere. Findings wait; questions need you; a gap is no card.
  const cards = inboundCards(gapped);
  check("cards use the four board columns", cards.every((c) => (INBOUND_COLUMNS as readonly string[]).includes(c.column)));
  check("a confirmed obligation waits", cards.some((c) => c.column === "Waiting"));
  check("a question needs you", cards.filter((c) => c.column === "Needs you").length === gapped.questions.length);
  check("a gap makes no card", cards.length === gapped.findings.length + gapped.questions.length);
  check("card ids are deterministic", JSON.stringify(inboundCards(gapped)) === JSON.stringify(cards));

  // ── 2. the real queries, on the real schema ────────────────────────────
  await sql`
    INSERT INTO buzzy_companies (id, user_id, name) VALUES (${CO}, ${USER}, 'Fence work')
  `;
  const jobId = `job_${run}check1`;
  await sql`
    INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
    VALUES (${jobId}, ${USER}, NULL, 'Invoice you dropped', 'Not started', ${CO}, ${JSON.stringify({
      board: { Waiting: [], Working: [], "Needs you": [], Done: [] },
    })}::jsonb, now())
  `;
  const paperId = `pp_${run}real0001`;
  await sql`
    INSERT INTO buzzy_papers (id, user_id, company_id, job_id, session_id, filename, kind, place, body)
    VALUES (${paperId}, ${USER}, ${CO}, ${jobId}, NULL, 'invoice-118.pdf', 'invoice',
            'the file invoice-118.pdf', ${'BZMETA\t{"sentence":"s","question":null,"gaps":[],"reply":"r"}\n' + "Invoice from Northwind Ltd. Total due $1,250.00 by 2026-12-01. Line item prose that is NOT a confirmed fact."})
  `;
  await sql`
    INSERT INTO buzzy_paper_facts (id, paper_id, user_id, company_id, job_id, fact_key, label, value, status, place, original_value)
    VALUES
      (${`pf_${run}a1`}, ${paperId}, ${USER}, ${CO}, ${jobId}, 'parties', 'Who it''s between', 'From Northwind Ltd to Shane', 'confirmed', 'the file invoice-118.pdf', 'From Northwind Ltd to Shane'),
      (${`pf_${run}a2`}, ${paperId}, ${USER}, ${CO}, ${jobId}, 'amount',  'The amount', '$1,250.00', 'confirmed', 'the file invoice-118.pdf', '$1,250.00'),
      (${`pf_${run}a3`}, ${paperId}, ${USER}, ${CO}, ${jobId}, 'asked',   'What''s being asked', 'Pay the November retainer', 'confirmed', 'the file invoice-118.pdf', 'Pay the November retainer'),
      (${`pf_${run}a4`}, ${paperId}, ${USER}, ${CO}, ${jobId}, 'due',     'The due date', '2026-12-01', 'proposed', 'the file invoice-118.pdf', '2026-12-01'),
      (${`pf_${run}a5`}, ${paperId}, ${USER}, ${CO}, ${jobId}, 'date',    'The date', '', 'unknown', 'the file invoice-118.pdf', '')
  `;

  const before = {
    papers: (await sql`SELECT count(*)::int AS n FROM buzzy_papers WHERE user_id = ${USER}`)[0].n,
    facts: (await sql`SELECT count(*)::int AS n FROM buzzy_paper_facts WHERE user_id = ${USER}`)[0].n,
    jobs: (await sql`SELECT count(*)::int AS n FROM buzzy_jobs WHERE user_id = ${USER}`)[0].n,
    jobUpdated: (await sql`SELECT updated_at::text AS t FROM buzzy_jobs WHERE id = ${jobId}`)[0].t,
    jobData: (await sql`SELECT data::text AS d FROM buzzy_jobs WHERE id = ${jobId}`)[0].d,
  };

  const first = await inboundCheck(sql, USER, paperId);
  const second = await inboundCheck(sql, USER, paperId);

  const after = {
    papers: (await sql`SELECT count(*)::int AS n FROM buzzy_papers WHERE user_id = ${USER}`)[0].n,
    facts: (await sql`SELECT count(*)::int AS n FROM buzzy_paper_facts WHERE user_id = ${USER}`)[0].n,
    jobs: (await sql`SELECT count(*)::int AS n FROM buzzy_jobs WHERE user_id = ${USER}`)[0].n,
    jobUpdated: (await sql`SELECT updated_at::text AS t FROM buzzy_jobs WHERE id = ${jobId}`)[0].t,
    jobData: (await sql`SELECT data::text AS d FROM buzzy_jobs WHERE id = ${jobId}`)[0].d,
  };

  check("the check answers", first.ok === true, JSON.stringify(first));
  const report = (first.ok ? first.check : null) as InboundReport | null;
  check("two GETs write nothing (rows)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  check("two GETs return the same report", JSON.stringify(first) === JSON.stringify(second));
  check("only confirmed lines are quoted (3)", report?.confirmed === 3, JSON.stringify(report?.findings.map((f) => f.key)));
  check("the proposed due date is a gap, not a finding",
    !!report && !report.findings.some((f) => f.key === "due") && report.gaps.some((g) => g.key === "due"));
  check("the unknown (blank) date is a gap too", !!report && report.gaps.some((g) => g.key === "date"));
  check("the paper's prose is never quoted", !!report && !/Line item prose/.test(JSON.stringify(report)));
  check("every finding has a place", !!report && report.findings.every((f) => f.place.trim().length > 0));
  check("the amount's place is the file it came from",
    !!report && report.findings.find((f) => f.key === "amount")?.place === "the file invoice-118.pdf");
  check("no arithmetic verdict", !!report && report.arithmetic === null);

  // ── 3. another account, a missing paper, a malformed id ────────────────
  const otherUser = await inboundCheck(sql, OTHER, paperId);
  check("another user's paper is 404", otherUser.ok === false && otherUser.status === 404, JSON.stringify(otherUser));
  const missing = await inboundCheck(sql, USER, `pp_${run}missing1`);
  check("a paper that does not exist is 404", missing.ok === false && missing.status === 404);
  const malformed = await inboundCheck(sql, USER, "pp_not-a-real-id");
  check("a malformed id is 404", malformed.ok === false && malformed.status === 404);
  const afterOther = (await sql`SELECT count(*)::int AS n FROM buzzy_paper_facts WHERE user_id = ${USER}`)[0].n;
  check("a refused read writes nothing either", afterOther === before.facts);

  // ── 4. unread: a saved paper with nothing confirmed ────────────────────
  const unreadId = `pp_${run}unread01`;
  const unreadRead = readPaper({ text: "", filename: "scan.pdf", fileKind: "photo" });
  await sql`
    INSERT INTO buzzy_papers (id, user_id, company_id, job_id, session_id, filename, kind, place, body)
    VALUES (${unreadId}, ${USER}, ${CO}, ${jobId}, NULL, 'scan.pdf', 'photo', ${unreadRead.place},
            ${'BZMETA\t{"sentence":"s","question":null,"gaps":[],"reply":"r"}\n'})
  `;
  // paper.ts's unread sentence is the one the owner sees; the check adds none of its own.
  check("the unread sentence is the full line", /^I couldn't read the words on this\. The lines stay unknown until you fill them in\.$/.test(unreadRead.sentence), unreadRead.sentence);
  await sql`
    INSERT INTO buzzy_paper_facts (id, paper_id, user_id, company_id, job_id, fact_key, label, value, status, place, original_value)
    VALUES (${`pf_${run}b1`}, ${unreadId}, ${USER}, ${CO}, ${jobId}, 'amount', 'The amount', '', 'unknown', ${unreadRead.place}, '')
  `;
  const unread = await inboundCheck(sql, USER, unreadId);
  check("an unread paper is no_confirmed_fact", unread.ok === false && unread.code === "no_confirmed_fact", JSON.stringify(unread));
  check("…with the accepted sentence", unread.ok === false && unread.error === INBOUND_NO_FACTS);
  check("…and it is not a crash (200)", unread.ok === false && unread.status === 200);

  // A blank line cannot be confirmed at all — so a confirmed line always has words.
  const blankConfirm = await updatePaperLine(sql, USER, unreadId, `pf_${run}b1`, "confirm");
  check("a blank line cannot be confirmed", blankConfirm.ok === false && /still blank/i.test(blankConfirm.error ?? ""), JSON.stringify(blankConfirm));
  const stillUnknown = await sql`SELECT status FROM buzzy_paper_facts WHERE id = ${`pf_${run}b1`}`;
  check("…its status stays unknown", String(stillUnknown[0].status) === "unknown");

  // ── 5. a locked PDF has no row to check ────────────────────────────────
  const lockedBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Page >>\n2 0 obj << /Encrypt 3 0 R >>\ntrailer << /Root 1 0 R /Encrypt 3 0 R >>\n%%EOF\n");
  const locked = await savePaper(sql, USER, {
    companyId: CO,
    jobId,
    sessionId: null,
    filename: "locked.pdf",
    text: "",
    fileKind: "pdf",
    pdfBytes: lockedBytes,
  });
  check("savePaper refuses a locked PDF by name", locked.ok === false && locked.code === "locked_pdf" && locked.status === 422, JSON.stringify(locked));
  const lockedRows = await sql`SELECT id FROM buzzy_papers WHERE user_id = ${USER} AND filename = 'locked.pdf'`;
  check("…and writes no row", lockedRows.length === 0);
  const lockedCheck = await inboundCheck(sql, USER, `pp_${run}locked01`);
  check("a locked PDF has nothing to check → 404", lockedCheck.ok === false && lockedCheck.status === 404);

  // ── 6. the tool gate ───────────────────────────────────────────────────
  const pol = policyFor("check_paper");
  check("check_paper is registered on the paper gate", pol?.gate === "paper", JSON.stringify(pol));
  check("check_paper is free", pol?.cost === "free");
  check("check_paper is read-only", pol?.sideEffects === "read-only");
  check("check_paper has no egress (Lockdown does not withhold it)", !pol?.egress);
  check("withheld without a paper", !offeredToolNames({ draftGateOpen: true }).includes("check_paper"));
  check("offered while a paper is on the job", offeredToolNames({ draftGateOpen: true, paper: true }).includes("check_paper"));
  check("still offered in Lockdown (nothing leaves BeeZilla)",
    offeredToolNames({ draftGateOpen: true, paper: true, lockdown: true }).includes("check_paper"));
  check("it explains itself when withheld", /no paper on this job/.test(refusalFor("check_paper", { draftGateOpen: true }) ?? ""));

  // The tool the model calls resolves the job's paper itself, and the route reads
  // the same module — no second copy of the rules.
  const serverSrc = src("src/lib/buzzy/server.ts");
  check("server.ts runs the same module for the tool", /if \(tc\.name === "check_paper"\)/.test(serverSrc) && /inboundCheck\(sql, userId, on\[0\]\.id\)/.test(serverSrc));
  check("the tool is offered only when a paper exists on the job", /paper: paperOnJob/.test(serverSrc) && /SELECT 1 FROM buzzy_papers WHERE job_id = \$\{jobId\}/.test(serverSrc));

  // ── 7. the route, and the two files that must stay as they were ────────
  const routeSrc = src("src/lib/buzzy/chat.nitro.ts");
  check("chat.nitro.ts imports inboundCheck", /import \{ inboundCheck \} from "\.\/inboundCheck"/.test(routeSrc));
  check("GET /api/buzzy/papers/:id/check is wired", /method === "GET" && paperCheck/.test(routeSrc));
  check("the check route sits before the unmatched-route 404",
    routeSrc.indexOf('method === "GET" && paperCheck') > 0 &&
      routeSrc.indexOf('method === "GET" && paperCheck') < routeSrc.indexOf("unmatched /api/buzzy route"));

  const moduleSrc = src("src/lib/buzzy/inboundCheck.ts");
  check("the module writes nothing", !/\b(INSERT\s+INTO|UPDATE\s+buzzy|DELETE\s+FROM)\b/i.test(moduleSrc));
  check("the module never selects the paper body", !/\bbody\b/.test(moduleSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  check("the module imports no arithmetic checker", !/from "\.\/review"|from "\.\/calc"/.test(moduleSrc));

  const reviewSrc = src("src/lib/buzzy/review.ts");
  check("review.ts is still the outbound checker", /export function checkArithmetic/.test(reviewSrc) && /itemCents\.length < 2 \|\| totalCents == null/.test(reviewSrc));
  check("review.ts was not touched by this CR", !/inboundCheck/.test(reviewSrc));

  const registrySrc = src("src/lib/buzzy/toolRegistry.ts");
  check('the gate union gained "paper"', /export type ToolGate = "always" \| "draft" \| "browser" \| "paper"/.test(registrySrc));
  check("ToolContext carries paper", /paper\?: boolean/.test(registrySrc));

  console.log(`\n${failures === 0 ? "all checks passed" : failures + " FAILED"}`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
