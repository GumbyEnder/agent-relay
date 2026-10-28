#!/usr/bin/env node
/**
 * test-buzzy-recipes.mjs — BZ-J04…J11 E2E: configured business recipes.
 *
 * Per recipe asserts:
 *  1. GET /api/buzzy/recipes exposes it as fully configured (four universal
 *     statements + discovery + output/audience/success checklist + permitted
 *     sources/tools + output contract + domain checks + boundary)
 *  2. No permitted tool can send/submit/file (boundary is structural)
 *  3. POST /recipes/:id/start creates a Discovering job carrying the recipe,
 *     output contract and boundary
 *  4. Boundary-check BLOCKS a draft that crosses the recipe's line, and passes
 *     a clean draft — the boundary is enforced, not merely documented
 *  5. Cross-account negative: another account cannot start/check as the owner
 *
 * Usage: node scripts/test-buzzy-recipes.mjs [baseUrl] [mailLogPath]
 */
import { readFileSync, existsSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8090";
const MAIL_LOG = process.argv[3] || ".data/outbound-mail.jsonl";

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
            const url = mail.actionUrl ||
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

const run = `rc${Date.now().toString(36)}`;
const cookieA = await signIn(`bz-recipes-${run}@test.local`);
const cookieB = await signIn(`bz-recipes2-${run}@test.local`);
console.log(`base=${BASE} run=${run}`);

// ── catalogue ───────────────────────────────────────────────────────────
let r = await api(cookieA, "GET", "/api/buzzy/recipes");
const recipes = r.json?.recipes ?? [];
check(
  "BZ-J04..J11 eight recipes are exposed",
  r.status === 200 && recipes.length === 8,
  `got ${recipes.length}`,
);
check(
  "BZ-J04..J11 four universal statements are declared once, up front",
  (r.json?.universalStatements ?? []).length === 4 &&
    JSON.stringify(r.json.universalStatements).includes("challenge"),
  JSON.stringify(r.json?.universalStatements),
);
check(
  "BZ-J04..J11 every recipe reports configured=true (no half-built recipe)",
  recipes.every((x) => x.configured === true),
  JSON.stringify(recipes.filter((x) => !x.configured).map((x) => x.id)),
);

for (const rec of recipes) {
  check(
    `${rec.id}: complete recipe contract`,
    rec.outcome && rec.discovery?.length && rec.checklist?.output &&
      rec.checklist?.audience && rec.checklist?.success &&
      rec.permittedSources?.length && rec.tools?.length &&
      rec.outputContract?.length && rec.domainChecks?.length && rec.boundary,
    JSON.stringify(rec).slice(0, 200),
  );
  check(
    `${rec.id}: no permitted tool can send, submit or file`,
    (rec.tools ?? []).every((t) => !/\b(send|email|submit|file|publish|pay|sign)\b/i.test(t)),
    JSON.stringify(rec.tools),
  );
}

// ── per-recipe journeys + boundary enforcement ───────────────────────────
const probes = {
  "quote-comparison": {
    bad: "We will order from Supplier B today and guaranteed lowest price applies.",
    good: "Comparison across A and B on the same quantities; totals computed; Supplier C did not quote delivery.",
  },
  "complaint-resolution": {
    bad: "We apologise and will refund the full amount immediately.",
    good: "Facts: the order shipped 12 days late. Suggestion: offer a goodwill credit within your stated authority.",
  },
  "meeting-action-pack": {
    bad: "All attendees agreed and unanimously approved the new rota.",
    good: "Decisions recorded: rota change from 4 Nov. Actions: Priya to confirm cover by 1 Nov.",
  },
  "bookkeeping-prep": {
    bad: "These expenses are tax deductible and the return is ready to file.",
    good: "Categorised 214 transactions; 6 uncategorised flagged; totals reconcile to the statement.",
  },
  "campaign-brief": {
    bad: '"Great service!" — happy customer said. Best in the world quality.',
    good: "Claim: 48-hour dispatch — evidence: fulfilment report supplied. Audience: returning buyers.",
  },
  "people-ops-paperwork": {
    bad: "You are terminated effective today. These terms are legally binding.",
    good: "Onboarding checklist covers week 1. Policy statements traced to the approved handbook.",
  },
  "grants-rfp": {
    bad: "We certify that we meet all eligibility criteria and submitted the application.",
    good: "Requirement 3 needs turnover evidence — listed as a gap. Deadline 30 Nov; signature required.",
  },
  "dispute-paperwork": {
    bad: "Coverage is guaranteed and you will be reimbursed in full.",
    good: "Timeline: notice 3 Sep, response 18 Sep. Assertion sourced to policy §4.2. Redact policy number.",
  },
};

const started = [];
for (const rec of recipes) {
  const p = probes[rec.id];
  if (!p) continue;
  r = await api(cookieA, "POST", `/api/buzzy/recipes/${rec.id}/start`, {});
  const jobId = r.json?.job?.id;
  started.push({ id: rec.id, jobId });
  check(
    `${rec.id}: start creates a Discovering job with its recipe + contract + boundary`,
    r.status === 201 && r.json?.job?.recipe === rec.id && r.json?.job?.status === "Discovering" &&
      (r.json?.outputContract ?? []).length > 0 && typeof r.json?.boundary === "string" && r.json?.firstQuestion,
    JSON.stringify(r.json).slice(0, 250),
  );
  r = await api(cookieA, "POST", `/api/buzzy/recipes/${rec.id}/boundary-check`, { draft: p.bad });
  check(
    `${rec.id}: boundary-check BLOCKS a draft that crosses the line`,
    r.status === 200 && r.json?.blocked === true && (r.json?.violations ?? []).length > 0,
    JSON.stringify(r.json).slice(0, 200),
  );
  r = await api(cookieA, "POST", `/api/buzzy/recipes/${rec.id}/boundary-check`, { draft: p.good });
  check(
    `${rec.id}: boundary-check passes a draft that stays inside it`,
    r.status === 200 && r.json?.blocked === false,
    JSON.stringify(r.json).slice(0, 200),
  );
}

// ── ownership negatives ─────────────────────────────────────────────────
r = await api(cookieB, "POST", "/api/buzzy/recipes/quote-comparison/start", {});
const bJob = r.json?.job?.id;
check("QA-05 recipes: other account starts its own job, not the owner's", r.status === 201 && bJob && !started.some((s) => s.jobId === bJob), `got ${r.status}`);
r = await api(cookieB, "GET", "/api/buzzy/jobs");
const bJobs = (r.json?.jobs ?? []).map((j) => j.id);
check(
  "QA-05 recipes: B's job list excludes A's recipe jobs",
  bJobs.includes(bJob) && !started.some((s) => bJobs.includes(s.jobId)),
  `B has ${bJobs.length}, leaked=${started.filter((s) => bJobs.includes(s.jobId)).length}`,
);
r = await api(null, "POST", "/api/buzzy/recipes/quote-comparison/start", {});
check("recipes: anonymous start → 401", r.status === 401, `got ${r.status}`);

// ── durable: jobs survive and are retrievable from a clean session ───────
const cookieA2 = await signIn(`bz-recipes-${run}@test.local`);
r = await api(cookieA2, "GET", "/api/buzzy/jobs");
const a2Jobs = (r.json?.jobs ?? []).map((j) => j.id);
check(
  "QA-06 recipes: fresh sign-in returns the same recipe jobs (server-side)",
  started.every((s) => a2Jobs.includes(s.jobId)),
  `missing=${started.filter((s) => !a2Jobs.includes(s.jobId)).map((s) => s.id)}`,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
