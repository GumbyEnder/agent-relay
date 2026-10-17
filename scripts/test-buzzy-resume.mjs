#!/usr/bin/env node
/**
 * test-buzzy-resume.mjs — BZ-F004 E2E: resume restores structured Decisions.
 *
 * Runs its own deterministic stub LLM in-process (so the app server must be
 * started with BZ_CHAT_BASE_URL=http://127.0.0.1:4111/v1 BZ_CHAT_KEY=test).
 * The stub answers the decisions-extraction prompt with fixed JSON and every
 * other prompt with a canned reply.
 *
 * Asserts:
 *  1. A chat turn persists the extracted decision server-side
 *  2. GET /api/buzzy/transcript?jobId= returns slots + messages (BZ-F004)
 *  3. ?sessionId= resolves the session's job and returns the same slots
 *  4. Another account sees neither messages nor slots (ownership negative)
 *
 * Usage: node scripts/test-buzzy-resume.mjs [baseUrl] [mailLogPath]
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8090";
const MAIL_LOG = process.argv[3] || ".data/outbound-mail.jsonl";
const STUB_PORT = 4111;
const CHALLENGE = "Losing half my quotes before they go out";

// ── stub LLM ────────────────────────────────────────────────────────────
const stub = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("chat/completions")) {
    res.writeHead(404).end("{}");
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let content;
    try {
      const body = JSON.parse(raw);
      const sys = String(body.messages?.[0]?.content ?? "");
      const lastUser = String([...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "");
      content = sys.includes("Extract these four facts")
        ? JSON.stringify({ challenge: CHALLENGE, difficulties: null, who_involved: null, end_goal: null })
        : /friendlier/i.test(lastUser)
          ? "FRIENDLY v3 — third edition, warmer tone."
          : /more formal/i.test(lastUser)
            ? "FORMAL v2 — revised demand letter, second edition."
            : "DEMAND v1 — pay what you owe, first edition.";
    } catch {
      content = "Got it.";
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "stub",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

async function readMailUrl(email) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (existsSync(MAIL_LOG)) {
      const lines = readFileSync(MAIL_LOG, "utf8").trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const mail = JSON.parse(line);
          if (mail.to === email) {
            const url =
              mail.actionUrl ||
              (mail.html || "").match(/href="([^"]*magic-link\/verify[^"]*)"/)?.[1] ||
              (mail.text || "").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0];
            if (url) return url.replace(/&amp;/g, "&");
          }
        } catch { /* partial line */ }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic-link mail found for ${email}`);
}

async function signIn(email) {
  const res = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`magic-link request failed ${res.status}: ${await res.text()}`);
  const url = await readMailUrl(email);
  const vres = await fetch(url, { redirect: "manual" });
  const cookie = (vres.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie.includes("session_token")) throw new Error("no session cookie from verify");
  return cookie;
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* non-json */ }
  return { status: res.status, json };
}

const run = `rs${Date.now().toString(36)}`;
const emailA = `bz-resume-${run}@test.local`;
const emailB = `bz-resume2-${run}@test.local`;
const jobId = `job_${run}_resume`;

console.log(`base=${BASE} run=${run} stub=:${STUB_PORT}`);

const cookieA = await signIn(emailA);
const cookieB = await signIn(emailB);

// 1. a chat turn persists the extracted decision server-side
let r = await api(cookieA, "POST", "/api/buzzy/chat", {
  jobId,
  message: "I keep losing half my quotes before they go out",
});
check("chat turn accepted", r.status === 200 && typeof r.json?.reply === "string", JSON.stringify(r.json).slice(0, 200));

// 2. transcript?jobId restores slots + messages
r = await api(cookieA, "GET", `/api/buzzy/transcript?jobId=${jobId}`);
check(
  "BZ-F004 transcript returns stored decision slot",
  r.status === 200 && r.json?.slots?.challenge === CHALLENGE,
  JSON.stringify(r.json?.slots),
);
check(
  "BZ-F004 transcript returns both turns",
  (r.json?.messages ?? []).length >= 2,
  `messages=${(r.json?.messages ?? []).length}`,
);

// 3. session-bound restore resolves the job and returns the same slots
r = await api(cookieA, "POST", "/api/buzzy/sessions", { jobId, title: "Resume QA" });
const sessId = r.json?.session?.id;
check("session created bound to job", r.status === 201 && typeof sessId === "string", JSON.stringify(r.json));
r = await api(cookieA, "POST", "/api/buzzy/chat", {
  jobId,
  sessionId: sessId,
  message: "It happens mostly on bigger jobs",
});
check("session chat turn accepted", r.status === 200, JSON.stringify(r.json).slice(0, 200));
r = await api(cookieA, "GET", `/api/buzzy/transcript?sessionId=${sessId}`);
check(
  "BZ-F004 session transcript resolves job slots",
  r.status === 200 && r.json?.slots?.challenge === CHALLENGE,
  JSON.stringify(r.json?.slots),
);

// 4. ownership negative: B sees nothing
r = await api(cookieB, "GET", `/api/buzzy/transcript?jobId=${jobId}`);
check(
  "BZ-F004 other account gets no messages or slots",
  r.status === 200 && (r.json?.messages ?? []).length === 0 && Object.keys(r.json?.slots ?? {}).length === 0,
  JSON.stringify(r.json).slice(0, 200),
);

// 5. BZ-F011: expert suggestion from intent — first turn, confident mapping only
r = await api(cookieA, "POST", "/api/buzzy/chat", {
  jobId: `job_${run}_legal`,
  message: "I need a demand letter for a client who won't pay their invoice",
});
check(
  "BZ-F011 legal intent suggests the Legal expert with a reason",
  r.status === 200 && r.json?.expertSuggestion?.id === "legal" && typeof r.json?.expertSuggestion?.reason === "string" && r.json.expertSuggestion.reason.length > 10,
  JSON.stringify(r.json?.expertSuggestion),
);
r = await api(cookieA, "POST", "/api/buzzy/chat", {
  jobId: `job_${run}_legal`,
  message: "They owe me for three months of work",
});
check(
  "BZ-F011 suggestion fires on the first turn only",
  r.status === 200 && r.json?.expertSuggestion === undefined,
  JSON.stringify(r.json?.expertSuggestion),
);
r = await api(cookieA, "POST", "/api/buzzy/chat", {
  jobId: `job_${run}_gen`,
  message: "I need to organize my garage this weekend",
});
check(
  "BZ-F011 no suggestion without a real registry mapping",
  r.status === 200 && r.json?.expertSuggestion === undefined,
  JSON.stringify(r.json?.expertSuggestion),
);
r = await api(cookieA, "POST", "/api/buzzy/chat", {
  jobId: `job_${run}_fromexp`,
  message: "Context: the user came from the legal experts page.\n\nI need a contract reviewed",
});
check(
  "BZ-F011 no suggestion when already in an expert context",
  r.status === 200 && r.json?.expertSuggestion === undefined,
  JSON.stringify(r.json?.expertSuggestion),
);

// 6. BZ-F015: durable documents — materialize, immutable versions, lifecycle
const docJob = `job_${run}_docs`;
r = await api(cookieA, "POST", "/api/buzzy/chat", {
  jobId: docJob,
  message: "I need a demand letter for Acme who won't pay — write it up",
});
check("BZ-F015 draft produced", r.status === 200 && r.json?.draft === true, JSON.stringify(r.json).slice(0, 200));
r = await api(cookieA, "GET", `/api/buzzy/documents?jobId=${docJob}`);
const doc = (r.json?.documents ?? [])[0];
check(
  "BZ-F015 draft materialized as ready document v1 with exact output",
  doc && doc.status === "ready" && doc.current_version === 1 && doc.content === "DEMAND v1 — pay what you owe, first edition.",
  JSON.stringify(doc).slice(0, 250),
);
const docId = doc?.id;

r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: docJob, message: "make it more formal" });
check("BZ-F015 revision produced", r.status === 200 && r.json?.draft === true, JSON.stringify(r.json).slice(0, 200));
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}`);
check(
  "BZ-F015 revision bumped to v2",
  r.json?.document?.current_version === 2 && r.json?.document?.content === "FORMAL v2 — revised demand letter, second edition.",
  JSON.stringify(r.json?.document).slice(0, 250),
);
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}?version=1`);
check(
  "BZ-F015 prior version immutable (QA-12)",
  r.json?.document?.version === 1 && r.json?.document?.content === "DEMAND v1 — pay what you owe, first edition.",
  JSON.stringify(r.json?.document).slice(0, 250),
);
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}?version=99`);
check("BZ-F015 unknown version is a clean 404", r.status === 404, `got ${r.status}`);

r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${docJob}`, { approved: true });
check("BZ-F015 job approval accepted", r.status === 200, JSON.stringify(r.json).slice(0, 150));
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}`);
check("BZ-F015 approval marks document accepted", r.json?.document?.status === "accepted", JSON.stringify(r.json?.document?.status));
r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${docJob}`, { approved: false });
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}`);
check("BZ-F015 revoked approval returns document to ready", r.json?.document?.status === "ready", JSON.stringify(r.json?.document?.status));

r = await api(cookieB, "GET", "/api/buzzy/documents");
check("BZ-F015 other account's library excludes the doc", !(r.json?.documents ?? []).some((d) => d.id === docId));
r = await api(cookieB, "GET", `/api/buzzy/documents/${docId}`);
check("BZ-F015 other account doc read → 404 (QA-05)", r.status === 404, `got ${r.status}`);

// 7. BZ-F017: per-version provenance + exact-version acceptance (QA-08)
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}`);
const ledger = r.json?.versions ?? [];
const v2 = ledger.find((v) => v.version === 2);
check(
  "BZ-F017 v2 records parent version + brief snapshot + creator",
  v2 && v2.parent_version === 1 && v2.creator && v2.brief_revision && typeof v2.brief_revision === "object",
  JSON.stringify(v2).slice(0, 250),
);

r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${docJob}`, { approved: true, draft: "STALE TEXT the owner never had on screen" });
check(
  "BZ-F017 stale-version approval rejected (QA-08)",
  r.status === 409 && r.json?.code === "stale_version" && r.json?.currentVersion === 2,
  `status ${r.status} ${JSON.stringify(r.json)}`,
);
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}`);
check("BZ-F017 rejected approval left document ready", r.json?.document?.status === "ready", JSON.stringify(r.json?.document?.status));

r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${docJob}`, { approved: true, draft: "FORMAL v2 — revised demand letter, second edition." });
check("BZ-F017 exact-version approval succeeds", r.status === 200, `status ${r.status}`);
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}`);
check(
  "BZ-F017 acceptance references the exact version",
  r.json?.document?.status === "accepted" && r.json?.document?.accepted_version === 2,
  JSON.stringify({ s: r.json?.document?.status, av: r.json?.document?.accepted_version }),
);
const acceptedV2 = (r.json?.versions ?? []).find((v) => v.version === 2);
check("BZ-F017 accepted version row stamped (accepted_at/by)", Boolean(acceptedV2?.accepted_at && acceptedV2?.accepted_by), JSON.stringify(acceptedV2).slice(0, 200));

// 8. BZ-REUSE-159: on Approve, shop-floor board + agent created idempotently
// (the exact-version approval PATCH above already fired it)
r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${docJob}`, { approved: true, draft: "FORMAL v2 — revised demand letter, second edition." });
check(
  "REUSE-159 approval returns execution linkage",
  r.status === 200 && typeof r.json?.execution?.projectId === "string" && r.json.execution.projectId.length > 0,
  JSON.stringify(r.json).slice(0, 250),
);
const execProject = r.json?.execution?.projectId;
r = await api(cookieA, "GET", "/api/buzzy/jobs");
const execJob = (r.json?.jobs ?? []).find((j) => j.id === docJob);
check(
  "REUSE-159 job stores board + agent + ticket linkage",
  execJob?.data?.execution?.projectId === execProject &&
    typeof execJob?.data?.execution?.agentName === "string" &&
    typeof execJob?.data?.execution?.missionId === "string" &&
    execJob?.data?.execution?.acceptedVersion === 2,
  JSON.stringify(execJob?.data?.execution),
);
// Repeated approval must NOT duplicate the work set (QA-08/09)
r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${docJob}`, { approved: true, draft: "FORMAL v2 — revised demand letter, second edition." });
check(
  "REUSE-159 repeated approval reuses the same board (no duplicates)",
  r.status === 200 && r.json?.execution?.projectId === execProject && r.json?.execution?.created === false,
  JSON.stringify(r.json?.execution),
);
// Gate: approving a job with no versioned document creates nothing
r = await api(cookieA, "POST", "/api/buzzy/jobs", { id: `job_${run}_nodoc`, title: "No doc job", data: {} });
r = await api(cookieA, "PATCH", `/api/buzzy/jobs/job_${run}_nodoc`, { approved: true });
check(
  "REUSE-159 no versioned approval audit → no execution items",
  r.status === 200 && r.json?.execution === undefined,
  JSON.stringify(r.json).slice(0, 200),
);

// 9. BZ-F024: attempt reconciliation + pause/cancel gates
const recJob = `job_${run}_rec`;
const attId = `att_${run}_1`;
r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: recJob, message: "I need a demand letter — write it up", attemptId: attId });
check("BZ-F024 first attempt runs", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json).slice(0, 150));
const firstReply = r.json?.reply;
r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: recJob, message: "I need a demand letter — write it up", attemptId: attId });
check(
  "BZ-F024 same attemptId reconciles to the stored reply (no duplicate call)",
  r.status === 200 && r.json?.reconciled === true && r.json?.reply === firstReply,
  JSON.stringify(r.json).slice(0, 200),
);
r = await api(cookieA, "GET", `/api/buzzy/transcript?jobId=${recJob}`);
check(
  "BZ-F024 retried attempt stored no duplicate messages",
  (r.json?.messages ?? []).length === 2,
  `messages=${(r.json?.messages ?? []).length}`,
);
r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: recJob, message: "make it more formal", attemptId: `att_${run}_2` });
check("BZ-F024 a new attempt id runs normally", r.status === 200 && r.json?.ok === true && !r.json?.reconciled);

r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${recJob}`, { status: "Paused" });
r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: recJob, message: "hello?", attemptId: `att_${run}_3` });
check(
  "BZ-F024 paused job refuses new turns, consequences explained (QA-15)",
  r.status === 409 && r.json?.code === "job_paused" && /paused/i.test(r.json?.error ?? ""),
  `status ${r.status} ${JSON.stringify(r.json)}`,
);
r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${recJob}`, { status: "Cancelled" });
r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: recJob, message: "hello?", attemptId: `att_${run}_4` });
check(
  "BZ-F024 cancelled job refuses new turns, consequences explained (QA-15)",
  r.status === 409 && r.json?.code === "job_cancelled" && /cancelled/i.test(r.json?.error ?? ""),
  `status ${r.status} ${JSON.stringify(r.json)}`,
);
r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${recJob}`, { status: "Draft ready" });
r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: recJob, message: "back to work", attemptId: `att_${run}_5` });
check("BZ-F024 resumed job accepts turns again", r.status === 200 && r.json?.ok === true, `status ${r.status}`);
// A cancelled job made no further model calls: transcript holds only the turns before the gates
r = await api(cookieA, "GET", `/api/buzzy/transcript?jobId=${recJob}`);
check(
  "BZ-F024 gated turns never reached the transcript",
  (r.json?.messages ?? []).filter((m) => m.role === "user").length === 3,
  `user messages=${(r.json?.messages ?? []).filter((m) => m.role === "user").length}`,
);

// 10. BZ-F030: contacts directory — proposed→confirmed, no name-merge
r = await api(cookieA, "POST", "/api/buzzy/contacts", { name: "Acme Supplies", kind: "supplier", role: "Main vendor", contact: { email: "sales@acme.test" } });
const ct1 = r.json?.contact?.id;
check("BZ-F030 contact created as proposed", r.status === 201 && r.json?.contact?.status === "proposed" && typeof ct1 === "string", JSON.stringify(r.json).slice(0, 200));
r = await api(cookieA, "POST", "/api/buzzy/contacts", { name: "Acme Supplies", kind: "customer", role: "Other division" });
const ct2 = r.json?.contact?.id;
check(
  "BZ-F030 same name creates a NEW entity + flags the duplicate (never merges)",
  r.status === 201 && ct2 && ct2 !== ct1 && (r.json?.possibleDuplicates ?? []).some((d) => d.id === ct1),
  JSON.stringify(r.json).slice(0, 250),
);
r = await api(cookieA, "GET", "/api/buzzy/contacts");
check("BZ-F030 both same-name entities coexist", (r.json?.contacts ?? []).filter((c) => c.name === "Acme Supplies").length === 2);
r = await api(cookieA, "POST", `/api/buzzy/contacts/${ct1}/confirm`);
check("BZ-F030 owner confirms a proposed contact", r.status === 200 && r.json?.contact?.status === "confirmed", JSON.stringify(r.json));
r = await api(cookieA, "POST", `/api/buzzy/contacts/${ct1}/confirm`);
check("BZ-F030 re-confirm is a clean 404", r.status === 404);
r = await api(cookieB, "GET", "/api/buzzy/contacts");
check("BZ-F030 other account sees no contacts (QA-05)", (r.json?.contacts ?? []).length === 0);
r = await api(cookieB, "POST", `/api/buzzy/contacts/${ct1}/confirm`);
check("BZ-F030 other account cannot confirm (QA-05)", r.status === 404, `got ${r.status}`);

// 11. BZ-F031: visible memory + forget propagation
// (the first chat turn on `jobId` persisted the extracted challenge to memory)
r = await api(cookieA, "GET", "/api/buzzy/memory");
check(
  "BZ-F031 memory shows the stored fact",
  (r.json?.facts ?? []).some((f) => f.jobId === jobId && f.key === "challenge" && f.value === CHALLENGE),
  JSON.stringify(r.json?.facts).slice(0, 250),
);
r = await api(cookieA, "DELETE", "/api/buzzy/memory", { jobId });
check(
  "BZ-F031 forget reports what was removed (and the Library is untouched)",
  r.status === 200 && r.json?.ok === true && r.json?.forgotten >= 1 && /Library/i.test(r.json?.note ?? ""),
  JSON.stringify(r.json),
);
r = await api(cookieA, "GET", "/api/buzzy/memory");
check(
  "BZ-F031 forgotten facts no longer readable for that job",
  !(r.json?.facts ?? []).some((f) => f.jobId === jobId),
  JSON.stringify(r.json?.facts).slice(0, 200),
);
// propagation to retrieval: a fresh transcript for the job returns no slots either
r = await api(cookieA, "GET", `/api/buzzy/transcript?jobId=${jobId}`);
check(
  "BZ-F031 forget propagates to derived retrieval (no slots surface)",
  Object.keys(r.json?.slots ?? {}).length === 0,
  JSON.stringify(r.json?.slots),
);
// forgetting the DOC job's memory leaves its materialized document untouched
r = await api(cookieA, "DELETE", "/api/buzzy/memory", { jobId: docJob });
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}`);
check(
  "BZ-F031 job work survives a memory forget (forget ≠ delete)",
  r.status === 200 && typeof r.json?.document?.content === "string" && r.json.document.content.length > 0,
  `status ${r.status}`,
);
r = await api(cookieB, "DELETE", "/api/buzzy/memory", { jobId });
check("BZ-F031 other account cannot forget A's memory (QA-05)", r.status === 200 && r.json?.forgotten === 0, JSON.stringify(r.json));

// 12. BZ-F007: intake boundaries — unsupported types + locked PDFs
r = await api(cookieA, "POST", "/api/buzzy/companies", { name: "QA07 Intake Co" });
const coId = r.json?.company?.id;
check("BZ-F007 company for intake", r.status === 201 && typeof coId === "string", JSON.stringify(r.json).slice(0, 150));
r = await api(cookieA, "POST", "/api/buzzy/papers", { companyId: coId, fileKind: "docx", text: "some doc text" });
check(
  "BZ-F007 unsupported type → useful next action, not silent fallback (QA-11)",
  r.status === 400 && r.json?.code === "unsupported_type" && /paste the text/i.test(r.json?.error ?? ""),
  `status ${r.status} ${JSON.stringify(r.json)}`,
);
const lockedPdf = Buffer.from("%PDF-1.4\n1 0 obj<</Encrypt 2 0 R>>endobj\n%%EOF").toString("base64");
r = await api(cookieA, "POST", "/api/buzzy/papers", { companyId: coId, fileKind: "pdf", dataBase64: lockedPdf, filename: "locked.pdf" });
check(
  "BZ-F007 locked PDF detected with an explicit next action",
  r.status === 422 && r.json?.code === "locked_pdf" && /paste the text/i.test(r.json?.error ?? ""),
  `status ${r.status} ${JSON.stringify(r.json)}`,
);
r = await api(cookieA, "POST", "/api/buzzy/papers", { companyId: coId, fileKind: "pdf", dataBase64: Buffer.from("%PDF-1.1\n%%EOF").toString("base64"), filename: "blank.pdf" });
check(
  "BZ-F007 unreadable PDF → lines stay unknown, nothing final-ready (QA-11)",
  r.status === 200 && (r.json?.paper?.accepted ?? []).length === 0 && /couldn't read/i.test(r.json?.paper?.sentence ?? ""),
  JSON.stringify(r.json?.paper).slice(0, 250),
);
r = await api(cookieB, "POST", "/api/buzzy/papers", { companyId: coId, fileKind: "paste", text: "snooping" });
check("BZ-F007 other account cannot file papers on A's company (QA-05)", r.status === 400 || r.status === 404, `got ${r.status}`);

// A new revision after acceptance re-opens review and clears the pointer (QA-20)
 r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: docJob, message: "actually make it friendlier" });
r = await api(cookieA, "GET", `/api/buzzy/documents/${docId}`);
check(
  "BZ-F017 revision after acceptance re-opens review, clears accepted_version (QA-20)",
  r.json?.document?.status === "ready" && r.json?.document?.accepted_version === null && r.json?.document?.current_version === 3,
  JSON.stringify({ s: r.json?.document?.status, av: r.json?.document?.accepted_version, cv: r.json?.document?.current_version }),
);

stub.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
