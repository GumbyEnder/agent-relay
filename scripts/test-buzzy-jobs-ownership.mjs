#!/usr/bin/env node
/**
 * test-buzzy-jobs-ownership.mjs — BZ-F002 / issue #158 E2E ownership evidence.
 *
 * Drives a RUNNING server (default http://127.0.0.1:3000) through the
 * magic-link dev-inbox auth path for two accounts, then asserts:
 *
 *   QA-05  cross-account denial: list isolation, PATCH 404, DELETE no-op,
 *          upsert 409 conflict, document 404
 *   QA-06  fresh sign-in (new cookie) still sees the job — server is SoT,
 *          no localStorage reliance
 *   QA-17  export (portability) returns a zip; owner delete removes the job
 *
 * Requires the dev mail inbox (.data/outbound-mail.jsonl in server cwd),
 * i.e. server started WITHOUT SMTP/RESEND env.
 *
 * Usage: node scripts/test-buzzy-jobs-ownership.mjs [baseUrl] [mailLogPath]
 */
import { readFileSync, existsSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const MAIL_LOG = process.argv[3] || ".data/outbound-mail.jsonl";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

async function readMailUrl(email) {
  // newest-first scan of the jsonl log for a magic-link URL to this address
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
  throw new Error(`no magic-link mail found for ${email} in ${MAIL_LOG}`);
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
  const setCookies = vres.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (!cookie.includes("session_token")) {
    throw new Error(`no session cookie from verify (status ${vres.status})`);
  }
  return cookie;
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* binary/empty */ }
  return { status: res.status, json, headers: res.headers };
}

const run = `qa${Date.now().toString(36)}`;
const emailA = `bz-owner-${run}@test.local`;
const emailB = `bz-other-${run}@test.local`;
const jobId = `job_${run}_a1`;

console.log(`base=${BASE} run=${run}`);

const cookieA = await signIn(emailA);
const cookieB = await signIn(emailB);
check("sign-in A + B via magic link", cookieA && cookieB && cookieA !== cookieB);

// ── setup: A creates and drafts a job ────────────────────────────────────
let r = await api(cookieA, "POST", "/api/buzzy/jobs", {
  id: jobId,
  title: "QA05 fence repair SOW",
  status: "Draft ready",
  data: { draft: "Statement of work body", approved: false },
});
check("A creates job", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));

// ── QA-05: cross-account denial ──────────────────────────────────────────
r = await api(cookieB, "GET", "/api/buzzy/jobs");
check("QA-05 B list excludes A's job", r.status === 200 && !(r.json?.jobs ?? []).some((j) => j.id === jobId));

r = await api(cookieB, "PATCH", `/api/buzzy/jobs/${jobId}`, { title: "hijacked" });
check("QA-05 B PATCH A's job → 404", r.status === 404, `got ${r.status}`);

r = await api(cookieB, "DELETE", `/api/buzzy/jobs/${jobId}`);
const afterDelete = await api(cookieA, "GET", "/api/buzzy/jobs");
check(
  "QA-05 B DELETE is a no-op (job survives)",
  (afterDelete.json?.jobs ?? []).some((j) => j.id === jobId),
);

r = await api(cookieB, "POST", "/api/buzzy/jobs", { id: jobId, title: "hijack", data: {} });
check("QA-05 B upsert over A's id → 409", r.status === 409, `got ${r.status}: ${JSON.stringify(r.json)}`);

r = await api(cookieB, "GET", `/api/buzzy/jobs/${jobId}/document`);
check("QA-05 B document read → 404", r.status === 404, `got ${r.status}`);

r = await api(cookieB, "GET", `/api/buzzy/jobs/${jobId}/events`);
check("QA-05 B events read leaks nothing", r.status === 200 && (r.json?.events ?? []).length === 0);

// unauthenticated
r = await api(null, "GET", "/api/buzzy/jobs");
check("QA-05 anonymous GET jobs → 401", r.status === 401, `got ${r.status}`);
r = await api(null, "PATCH", `/api/buzzy/jobs/${jobId}`, { title: "x" });
check("QA-05 anonymous PATCH → 401", r.status === 401, `got ${r.status}`);

// ── QA-06: fresh session, server is SoT ──────────────────────────────────
const cookieA2 = await signIn(emailA);
r = await api(cookieA2, "GET", "/api/buzzy/jobs");
const jobBack = (r.json?.jobs ?? []).find((j) => j.id === jobId);
check(
  "QA-06 fresh sign-in returns same job with server state",
  jobBack && jobBack.status === "Draft ready" && jobBack.data?.draft === "Statement of work body",
  JSON.stringify(jobBack),
);

// approval is server state, not browser state
r = await api(cookieA2, "PATCH", `/api/buzzy/jobs/${jobId}`, { approved: true, status: "Approved" });
check("QA-06 approve persists server-side", r.status === 200 && r.json?.job?.status === "Approved", JSON.stringify(r.json));
const cookieA3 = await signIn(emailA);
r = await api(cookieA3, "GET", "/api/buzzy/jobs");
const jobApproved = (r.json?.jobs ?? []).find((j) => j.id === jobId);
check("QA-06 approval survives another fresh session", jobApproved?.data?.approved === true, JSON.stringify(jobApproved?.data));

// ── QA-17: portability + deletion ────────────────────────────────────────
const exp = await fetch(`${BASE}/api/buzzy/export`, { headers: { cookie: cookieA3 } });
const expBuf = await exp.arrayBuffer();
check("QA-17 export returns zip", exp.status === 200 && (exp.headers.get("content-type") || "").includes("zip") && expBuf.byteLength > 200,
  `status ${exp.status} type ${exp.headers.get("content-type")} bytes ${expBuf.byteLength}`);

r = await api(cookieA3, "DELETE", `/api/buzzy/jobs/${jobId}`);
check("QA-17 owner DELETE ok", r.status === 200 && r.json?.ok === true);
r = await api(cookieA3, "GET", "/api/buzzy/jobs");
check("QA-17 job gone after delete", !(r.json?.jobs ?? []).some((j) => j.id === jobId));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
