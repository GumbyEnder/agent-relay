#!/usr/bin/env node
/**
 * test-library-job-merge.mjs — CR-20. Two properties, both halves of the fix:
 *
 *   1. LIBRARY MAY NOT WRITE WHAT IT DID NOT READ. Before this, mergeServerJobs()
 *      set serverMerged = true on a non-ok GET (and in its catch), so a 500, a
 *      timeout, or an ok-but-empty list left the thin localStorage catalogue in
 *      place with the write gate open. The next navigation saved it, and
 *      pushJob() posted the whole local job as `data`.
 *
 *   2. A POST MERGES THE FIELDS IT OWNS. POST /api/buzzy/jobs used to write
 *      `data = EXCLUDED.data`, so that one save deleted every key another
 *      surface had written on the row — the Sketch canvas (`board`) and its
 *      `sources`, the Studio plan (`music`), the filed `document`, the
 *      `approved` state behind the acceptance gate. An owner who had drawn a
 *      board against a job and then clicked once in the Library lost the
 *      drawing.
 *
 * The page half is a source witness plus a sandbox run of the page's OWN
 * functions (extracted by brace count and executed with a stubbed fetch), so it
 * tests the code that ships, not a copy. The server half boots the built server
 * on an ephemeral port with a dev mail inbox, signs in through a real magic
 * link, and drives the real routes.
 *
 * The mutant to run against it: put `data: j` back in pushJob(), or move
 * `serverMerged = true` above the `Array.isArray(d.jobs)` check — LIB-1..LIB-4
 * go red. Put `data = EXCLUDED.data` back in the POST upsert — SRV-1..SRV-4 go
 * red.
 *
 * Usage: node scripts/test-library-job-merge.mjs [baseUrl] [mailLogPath]
 * (`npm run build` must have run; with no arguments the suite boots its own
 * server, otherwise it drives the one you point it at.)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(ROOT, ".output", "server", "index.mjs");
const PAGE = join(ROOT, "public", "buzzy", "library.html");
const SRC = readFileSync(PAGE, "utf8");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

// ── extracting the page's own code ──────────────────────────────────────────
// The body of a top-level `function NAME(` in the page's second inline script,
// by brace count. -1-safe: a missing function is a FAIL in the checks below,
// never a crash in the harness.
function body(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start < 0) return "";
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  return "";
}
// `body()` returns only the braces, which is what the witness wants for a
// containment check but not what an evaluator wants. fn() rebuilds a declaration.
function fn(name) {
  const start = SRC.indexOf("function " + name + "(");
  const b = body(name);
  if (start < 0 || !b) return "";
  return SRC.slice(start, SRC.indexOf(b, start) + b.length);
}
function varDecl(name) {
  const start = SRC.indexOf("var " + name + " =");
  if (start < 0) return "";
  const end = SRC.indexOf("];", start);
  return end < 0 ? "" : SRC.slice(start, end + 2);
}

const FIELDS_DECL = varDecl("LIBRARY_FIELDS");
const NEEDED = ["emptyJob", "flowBoard", "ensureFlowBoard", "jobComplete", "jobTitle",
  "jobStatus", "snapshotCurrent", "saveState", "syncServerJob", "libraryPayload",
  "pushJob", "normalizeServerJob", "mergeServerJobs",
  "applyActiveCompanyToFreshJob", "assignUnassignedToFirstCompany"];
const missing = NEEDED.filter((n) => !body(n));

// One sandbox per case, so a run cannot inherit another case's gate or stubs.
// fetch is a parameter: the page's functions are called unmodified.
const SANDBOX = [
  'var STORAGE_KEY = "bz-test";',
  "var BZCompanies = null;",
  'var catalog = { currentId: null, hideCompleted: true, jobs: [], userId: null };',
  'var state = emptyJob("job_local");',
  'state.screen = "jobs";',
  "var serverMerged = false;",
  "var _syncTimer = null;",
  "var localStorage = { setItem: function () {}, getItem: function () { return null; } };",
  "var window = {};",
  "function goDocs() {}",
  "function goJobs() {}",
  "function firstCompanyId() { return null; }",
  "function workspaceCompanyId() { return null; }",
  FIELDS_DECL,
  varDecl("FLOW_COLUMNS"),
  fn("emptyJob"),
  fn("flowBoard"),
  fn("ensureFlowBoard"),
  fn("jobComplete"),
  fn("jobTitle"),
  fn("jobStatus"),
  fn("snapshotCurrent"),
  fn("saveState"),
  fn("syncServerJob"),
  fn("libraryPayload"),
  fn("pushJob"),
  fn("applyActiveCompanyToFreshJob"),
  fn("assignUnassignedToFirstCompany"),
  fn("normalizeServerJob"),
  fn("mergeServerJobs"),
  "return { state: function () { return state; }, setState: function (s) { state = s; },",
  "  jobs: function () { return catalog.jobs; }, merged: function () { return serverMerged; },",
  "  payload: libraryPayload, flow: flowBoard, normalize: normalizeServerJob,",
  "  merge: mergeServerJobs, save: saveState, title: jobTitle, status: jobStatus };",
].join("\n");

const PAGE_LOCAL_JOB = {
  id: "job_local", createdAt: 1, updatedAt: 2, template: "legal",
  problem: "Fence damage after the storm", messages: [{ who: "me", text: "Fence damage" }],
  screen: "jobs", q: 3, answers: { what_happened: "storm" }, skipped: {},
  version: 0, approved: false, pause: null,
  flow: { Waiting: [], Working: [], "Needs you": [], Done: [] }, events: [],
};
// What a Sketch + Studio + Talk owner has on the same row.
const FOREIGN_KEYS = ["board", "music", "sources", "document", "approved", "draft", "artifact", "due_date"];
const FULL_ROW_DATA = {
  board: { version: 3, w: 900, h: 600, bg: "#fff", strokes: [{ id: "s1", pts: [1, 2, 3, 4], color: "#000" }], images: [] },
  music: { plan: { prompt: "a slow blues", lyrics: "", instruments: ["bass"], seconds: 30 } },
  sources: [{ kind: "board", label: "Sketch board — 1 marks, 0 images", url: "/buzzy/sketch?job=x" }],
  document: { filename: "sow.docx", currentVersion: 2 },
  approved: true,
  draft: "Statement of work body",
  ownedElsewhere: 42,
  flow: { Waiting: [], Working: [], "Needs you": [], Done: [{ title: "Write the draft" }] },
};

function makeFetch(handler) {
  const calls = [];
  const fetch = (url, opts) => {
    const call = { url, method: (opts && opts.method) || "GET", body: opts && opts.body };
    calls.push(call);
    try { return Promise.resolve(handler(call)); }
    catch (e) { return Promise.reject(e); }
  };
  return { fetch, calls };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonRes = (value, ok = true) => ({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(value) });

async function libraryHalf() {
  console.log(`\n── library.html — the write gate and what a save may contain (${PAGE})`);
  check("LIB-0 the functions this witness runs still exist in the page", missing.length === 0,
    "missing: " + missing.join(", "));

  const posts = (calls) => calls.filter((c) => c.method === "POST");
  const parse = (call) => JSON.parse(call.body);

  // A read that failed must not open the gate: 500, and a dropped request.
  for (const [label, handler] of [
    ["a 500 answer", () => jsonRes({ error: "boom" }, false)],
    ["a dropped request", () => Promise.reject(new Error("network down"))],
    ["an ok body with no jobs array", () => jsonRes({ error: "not a list" })],
  ]) {
    const fetchImpl = makeFetch(handler);
    const box = new Function("fetch", SANDBOX)(fetchImpl.fetch);
    box.merge();
    await sleep(5);
    check(`LIB-1 ${label} leaves the gate shut`, box.merged() === false,
      "serverMerged became true after a read that returned nothing");
    box.setState(Object.assign({}, PAGE_LOCAL_JOB));
    box.save();
    await sleep(450);
    check(`LIB-2 ${label} then a save posts nothing`, posts(fetchImpl.calls).length === 0,
      "posted: " + JSON.stringify(posts(fetchImpl.calls).map((c) => c.body)));
  }

  // An honest empty list may open the gate (a new job still has to be savable)…
  {
    const f = makeFetch(() => jsonRes({ jobs: [] }));
    const box = new Function("fetch", SANDBOX)(f.fetch);
    box.merge();
    await sleep(5);
    check("LIB-3 an ok, honest empty list opens the gate", box.merged() === true);
    box.setState(Object.assign({}, PAGE_LOCAL_JOB));
    box.save();
    await sleep(450);
    const post = posts(f.calls)[0];
    check("LIB-4 …and that save still carries the interview fields", Boolean(post) &&
      parse(post).data.problem === PAGE_LOCAL_JOB.problem, post ? post.body : "no POST");
    // …and it still may not send a foreign key.
    const keys = Object.keys(parse(post).data);
    check("LIB-5 a save sends no key another surface owns",
      keys.every((k) => !FOREIGN_KEYS.includes(k)), "sent: " + keys.join(", "));
    check("LIB-6 a save sends companyId only when there is one",
      !Object.prototype.hasOwnProperty.call(parse(post), "companyId"),
      "companyId: " + JSON.stringify(parse(post).companyId));
  }

  // A full row read back: the merge must not be mistaken for permission to
  // write it all again.
  {
    const serverJob = { id: "job_local", title: "Fence", status: "Approved", template: "legal",
      companyId: null, data: JSON.parse(JSON.stringify(FULL_ROW_DATA)),
      createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" };
    const f = makeFetch(() => jsonRes({ jobs: [serverJob] }));
    const box = new Function("fetch", SANDBOX)(f.fetch);
    box.merge();
    await sleep(5);
    const cur = box.state();
    check("LIB-7 the read is adopted as the current job", cur && cur.id === "job_local");
    // Library's own `flow` is adopted; the canvas stays a canvas. A row that
    // carries ONLY a canvas must not be read as an empty flow board either.
    check("LIB-8 the flow board loads and the sketch canvas is left alone",
      cur && cur.flow?.Done?.length === 1 && cur.board?.strokes?.length === 1,
      "flow=" + JSON.stringify(cur && cur.flow) + " board=" + JSON.stringify(cur && cur.board));
    const canvasOnly = box.normalize({ id: "job_canvas", title: "Sketch board",
      data: { board: { version: 3, w: 10, h: 10, strokes: [{ id: "a" }], images: [] } } });
    check("LIB-8b a canvas with no flow key becomes an empty flow board, not a broken one",
      canvasOnly && ["Waiting", "Working", "Needs you", "Done"].every((k) =>
        Array.isArray(canvasOnly.flow[k]) && canvasOnly.flow[k].length === 0) &&
      canvasOnly.board.strokes.length === 1,
      "flow=" + JSON.stringify(canvasOnly && canvasOnly.flow));
    box.save();
    await sleep(450);
    const post = posts(f.calls)[0];
    const sent = post ? parse(post).data : {};
    check("LIB-9 saving that job keeps every foreign key out of the POST",
      post && FOREIGN_KEYS.every((k) => !Object.prototype.hasOwnProperty.call(sent, k)),
      "sent data keys: " + Object.keys(sent).join(", "));
    check("LIB-10 the merge payload carries only LIBRARY_FIELDS",
      Object.keys(sent).every((k) => FIELDS_DECL.includes('"' + k + '"')),
      "unexpected: " + Object.keys(sent).filter((k) => !FIELDS_DECL.includes('"' + k + '"')).join(", "));
  }

  // companyId: present ⇒ sent, absent ⇒ omitted (an absent one unfiled rows).
  {
    const withCompany = Object.assign({}, PAGE_LOCAL_JOB, { companyId: "co_abcdef0123456789" });
    const without = Object.assign({}, PAGE_LOCAL_JOB, { companyId: null });
    const box = new Function("fetch", SANDBOX)(makeFetch(() => jsonRes({ jobs: [] })).fetch);
    check("LIB-12 a filed job sends its companyId",
      box.payload(withCompany).companyId === "co_abcdef0123456789",
      JSON.stringify(box.payload(withCompany).companyId));
    check("LIB-13 an unfiled job omits companyId instead of sending null",
      !("companyId" in box.payload(without)), "companyId key present: " + JSON.stringify(box.payload(without)));
  }
}

// ── the server half ────────────────────────────────────────────────────────
let BASE = process.argv[2] || "";
let MAIL_LOG = process.argv[3] || "";
let child = null;
let mailDir = null;
let serverLog = "";

async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

function ensurePgliteAssets() {
  const libs = join(ROOT, ".output", "server", "_libs");
  const src = join(ROOT, "node_modules", "@electric-sql", "pglite", "dist");
  for (const file of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
    const dest = join(libs, file);
    if (!existsSync(dest) && existsSync(join(src, file))) copyFileSync(join(src, file), dest);
  }
}

async function boot() {
  if (BASE) return;
  if (!existsSync(SERVER_ENTRY)) {
    console.error(`FAIL  no built server at ${SERVER_ENTRY}\n      run: npm run build`);
    process.exit(2);
  }
  ensurePgliteAssets();
  mailDir = mkdtempSync(join(tmpdir(), "bz-libmerge-"));
  MAIL_LOG = join(mailDir, "outbound-mail.jsonl");
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of ["RESEND_API_KEY", "SMTP_URL", "SMTP_HOST"]) delete env[key];
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production",
      AGENT_RELAY_DEV_MAIL: "1", AGENT_RELAY_MAIL_LOG_DIR: mailDir,
      BETTER_AUTH_URL: BASE, BETTER_AUTH_TRUSTED_ORIGINS: BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => { serverLog = (serverLog + chunk.toString()).slice(-8000); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  const tail = serverLog.trim().split("\n").slice(-25).join("\n");
  console.error(`FAIL  server never became healthy on ${BASE}` +
    (tail ? `\n------ server output (tail) ------\n${tail}\n---------------------------------` : ""));
  await stop();
  process.exit(3);
}

async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  child = null;
  if (mailDir) { rmSync(mailDir, { recursive: true, force: true }); mailDir = null; }
}
process.on("exit", () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (mailDir) rmSync(mailDir, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { stop().finally(() => process.exit(130)); });
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
    await sleep(500);
  }
  throw new Error(`no magic-link mail for ${email} in ${MAIL_LOG}`);
}

async function signIn(email) {
  const res = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`magic-link request failed ${res.status}: ${await res.text()}`);
  const url = await readMailUrl(email);
  const vres = await fetch(url, { redirect: "manual" });
  const cookie = (vres.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie.includes("session_token")) throw new Error(`no session cookie (status ${vres.status})`);
  return cookie;
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, json };
}

async function serverHalf() {
  console.log(`\n── POST /api/buzzy/jobs — a thin writer may not delete the rest of the row (${BASE})`);
  const run = `cr20${Date.now().toString(36)}`;
  const cookieA = await signIn(`bz-libmerge-${run}@test.local`);
  const cookieB = await signIn(`bz-libmerge-other-${run}@test.local`);
  check("SRV-0 sign-in via magic link (two accounts)", Boolean(cookieA && cookieB && cookieA !== cookieB));

  const jobId = `job_${run}_merge`;
  let r = await api(cookieA, "POST", "/api/buzzy/companies", { name: "CR20 Fence Co" });
  const companyId = r.json?.company?.id;
  check("SRV-1 a company to file the job under", r.status === 201 && Boolean(companyId),
    `status ${r.status} ${JSON.stringify(r.json)}`);

  // The owner's other surfaces have already written the row.
  r = await api(cookieA, "POST", "/api/buzzy/jobs", {
    id: jobId, title: "Fence SOW", status: "Approved", companyId,
    data: JSON.parse(JSON.stringify(FULL_ROW_DATA)),
  });
  check("SRV-2 a full-blob write creates the row", r.status === 200 && r.json?.ok === true,
    JSON.stringify(r.json));
  r = await api(cookieA, "PATCH", `/api/buzzy/jobs/${jobId}`, { approved: true, draft: "v1 body" });
  check("SRV-3 the approval route records approved + draft", r.status === 200, `status ${r.status}`);

  // …then the Library saves with only its own fields, built by the page itself.
  const box = new Function("fetch", SANDBOX)(makeFetch(() => jsonRes({ jobs: [] })).fetch);
  const libraryJob = Object.assign({}, PAGE_LOCAL_JOB, {
    id: jobId, title: "Fence SOW", companyId, problem: "Fence flattened by the storm",
    flow: { Waiting: [], Working: [], "Needs you": [], Done: [{ title: "Write the draft" }] },
  });
  const payload = box.payload(libraryJob);
  check("SRV-4 the page's payload names no foreign key",
    FOREIGN_KEYS.every((k) => !Object.prototype.hasOwnProperty.call(payload.data, k)),
    "sent: " + Object.keys(payload.data).join(", "));

  r = await api(cookieA, "POST", "/api/buzzy/jobs", payload);
  check("SRV-5 the thin write is accepted", r.status === 200 && r.json?.ok === true,
    `status ${r.status} ${JSON.stringify(r.json)}`);

  r = await api(cookieA, "GET", `/api/buzzy/jobs/${jobId}`);
  const data = r.json?.job?.data ?? {};
  check("SRV-6 the sketch canvas survives the Library save",
    data.board && data.board.strokes?.length === 1 && data.board.w === 900,
    "board=" + JSON.stringify(data.board));
  check("SRV-7 the studio plan survives", data.music?.plan?.prompt === "a slow blues",
    "music=" + JSON.stringify(data.music));
  check("SRV-8 the sources survive", Array.isArray(data.sources) && data.sources.length === 1,
    "sources=" + JSON.stringify(data.sources));
  check("SRV-9 the filed document survives", data.document?.filename === "sow.docx",
    "document=" + JSON.stringify(data.document));
  check("SRV-10 the approval survives", data.approved === true, "approved=" + JSON.stringify(data.approved));
  check("SRV-11 the approved draft text survives", data.draft === "v1 body", "draft=" + JSON.stringify(data.draft));
  check("SRV-12 a key this suite invented survives (nothing is pruned)",
    data.ownedElsewhere === 42, "ownedElsewhere=" + JSON.stringify(data.ownedElsewhere));
  check("SRV-13 the Library's own fields did land",
    data.problem === "Fence flattened by the storm" && data.flow?.Done?.[0]?.title === "Write the draft",
    "problem=" + JSON.stringify(data.problem) + " flow=" + JSON.stringify(data.flow));
  check("SRV-14 the company column is untouched", r.json?.job?.companyId === companyId,
    "companyId=" + JSON.stringify(r.json?.job?.companyId));
  check("SRV-15 the row still reads as one job (title + a status)",
    r.json?.job?.title === "Fence SOW" && typeof r.json?.job?.status === "string" && r.json.job.status.length > 0,
    "title=" + JSON.stringify(r.json?.job?.title) + " status=" + JSON.stringify(r.json?.job?.status));

  // An honest empty list in front of a page that never read the row: the save
  // that follows must still be field-scoped.
  const emptyBox = new Function("fetch", SANDBOX)(makeFetch(() => jsonRes({ jobs: [] })).fetch);
  emptyBox.merge();
  await sleep(5);
  emptyBox.setState(Object.assign({}, PAGE_LOCAL_JOB, { id: jobId, title: "Fence SOW" }));
  emptyBox.save();
  await sleep(450);
  const stray = emptyBox.payload(emptyBox.state());
  check("SRV-16 the page's post-empty-list payload is field-scoped too",
    FOREIGN_KEYS.every((k) => !Object.prototype.hasOwnProperty.call(stray.data, k)),
    "sent: " + Object.keys(stray.data).join(", "));
  r = await api(cookieA, "POST", "/api/buzzy/jobs", stray);
  check("SRV-16b the post-empty-list save is accepted", r.status === 200, `status ${r.status}`);
  const after = await api(cookieA, "GET", `/api/buzzy/jobs/${jobId}`);
  const problemBeforeHijack = after.json?.job?.data?.problem;
  check("SRV-17 …and the row is still whole after it",
    after.json?.job?.data?.music?.plan?.prompt === "a slow blues" &&
    after.json?.job?.data?.board?.strokes?.length === 1 &&
    after.json?.job?.data?.document?.filename === "sow.docx",
    "data=" + JSON.stringify(Object.keys(after.json?.job?.data ?? {})));

  // Ownership still fences the merge: another account cannot merge into it.
  r = await api(cookieB, "POST", "/api/buzzy/jobs", { id: jobId, title: "hijack", data: { problem: "mine" } });
  check("SRV-18 another account still gets 409, not a merge", r.status === 409, `status ${r.status}`);
  const still = await api(cookieA, "GET", `/api/buzzy/jobs/${jobId}`);
  check("SRV-19 …and cannot have written anything",
    still.json?.job?.data?.problem === problemBeforeHijack,
    "before=" + JSON.stringify(problemBeforeHijack) + " after=" + JSON.stringify(still.json?.job?.data?.problem));

  // Clean up the two rows this suite made.
  await api(cookieA, "DELETE", `/api/buzzy/jobs/${jobId}`);
}

(async () => {
  await libraryHalf();
  await boot();
  await serverHalf();
  await stop();
  console.log(`\n${failures === 0 ? "ALL LIBRARY-JOB-MERGE CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error("FAIL  suite crashed:", err && err.stack ? err.stack : err);
  await stop();
  process.exit(1);
});
