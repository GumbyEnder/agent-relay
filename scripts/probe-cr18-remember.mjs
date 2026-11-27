#!/usr/bin/env node
/**
 * probe-cr18-remember.mjs — end-to-end evidence for CR-18 ("remember that…").
 *
 * Boots the BUILT server on an ephemeral port with a local stand-in provider
 * and the dev mail inbox, signs in with a magic link, then proves:
 *
 *   - "remember that …" writes an account-scoped row (job_id NULL) and
 *     response.remembered carries the key and their words;
 *   - a later conversation's system prompt recalls that fact;
 *   - PUT edits it, DELETE removes it, and neither can touch profile_ keys;
 *   - a message without a trigger and "remember to …" write nothing, and the
 *     reply never claims a save;
 *   - the voice lane (voice: true) saves too, offers no tools, and reports
 *     ttfaMs next to a voice turn without the reminder.
 *
 * The stand-in exists so the probe proves the HARNESS path without spending a
 * provider call; the write happens before the model call, which is the point.
 * With a stand-in, ttfaMs is dominated by its immediate first frame — the delta
 * between the two turns is the pre-pass cost.
 *
 * Usage: node scripts/probe-cr18-remember.mjs   (npm run build first)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(ROOT, ".output", "server", "index.mjs");

// ── harness: own the server unless a base URL was passed in ─────────────────
let BASE = process.argv[2] || "";
let MAIL_LOG = process.argv[3] || "";
let child = null;
let mailDir = null;
let serverLog = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * The PGlite WASM files live in .output/server/_libs and `npm run build` wipes
 * that directory, so a built-but-unserved checkout 500s with ENOENT on
 * pglite.data. Copying them here makes this suite self-sufficient instead of
 * handing the next person that trap.
 */
function ensurePgliteAssets() {
  const libs = join(ROOT, ".output", "server", "_libs");
  const src = join(ROOT, "node_modules", "@electric-sql", "pglite", "dist");
  for (const file of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
    const dest = join(libs, file);
    if (!existsSync(dest) && existsSync(join(src, file))) {
      copyFileSync(join(src, file), dest);
    }
  }
}

async function boot() {
  MAIL_LOG = process.argv[3] || "";
  if (BASE) return; // external server: caller owns lifecycle

  if (!existsSync(SERVER_ENTRY)) {
    console.error(`FAIL  no built server at ${SERVER_ENTRY}\n      run: npm run build`);
    process.exit(2);
  }
  ensurePgliteAssets();

  mailDir = mkdtempSync(join(tmpdir(), "bz-jobs-"));
  MAIL_LOG = join(mailDir, "outbound-mail.jsonl");
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;

  // Drop the provider credentials: their presence alone disables the dev inbox
  // and the magic-link test has nowhere to read the URL from.
  const env = { ...process.env };
  for (const key of ["RESEND_API_KEY", "SMTP_URL", "SMTP_HOST"]) delete env[key];

  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      AGENT_RELAY_DEV_MAIL: "1",
      AGENT_RELAY_MAIL_LOG_DIR: mailDir,
      // The magic-link actionUrl is built from this, and the suite fetches it
      // directly — leave it unset and the URL says :8090 while the server
      // listens on the ephemeral port (the "Invalid origin" trap).
      BETTER_AUTH_URL: BASE,
      BETTER_AUTH_TRUSTED_ORIGINS: BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => {
    serverLog = (serverLog + chunk.toString()).slice(-8000);
  };
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
  console.error(
    `FAIL  server never became healthy on ${BASE}${child.exitCode !== null ? ` (exited ${child.exitCode})` : ""}` +
      `\n      second line of defence: run 'npm run build' and try again` +
      (tail ? `\n------ server output (tail) ------\n${tail}\n---------------------------------` : ""),
  );
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
  if (mailDir) {
    rmSync(mailDir, { recursive: true, force: true });
    mailDir = null;
  }
}

// A crash or Ctrl-C must not leave a server or a temp dir behind.
process.on("exit", () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (mailDir) rmSync(mailDir, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stop().finally(() => process.exit(130));
  });
}

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
  if (!res.ok) {
    const body = await res.text();
    // Driving a server you did not start (the `[baseUrl]` mode) only works when
    // that server trusts this origin: Better Auth compares the request's origin
    // against its baseURL/trustedOrigins, and a bare localhost:PORT server is not
    // trusted by default. Say that instead of leaking a 403 the reader has to decode.
    if (/INVALID_ORIGIN/i.test(body)) {
      throw new Error(
        `the server at ${BASE} does not trust this origin (Better Auth INVALID_ORIGIN).\n` +
          `      Start it with BETTER_AUTH_URL=${BASE} (and BETTER_AUTH_TRUSTED_ORIGINS=${BASE}), ` +
          `or run this suite with no arguments so it boots its own server.`,
      );
    }
    throw new Error(`magic-link request failed ${res.status}: ${body}`);
  }
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
const seen = [];
const AUDIO_B64 = Buffer.alloc(2400, 1).toString("base64");
const standIn = createHttpServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let p = {};
    try { p = JSON.parse(body || "{}"); } catch {}
    seen.push(p);
    if (!p.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "stand-in", choices: [{ message: { role: "assistant", content: "Noted." }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const f = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
    f({ choices: [{ delta: { content: "Noted." } }] });
    f({ choices: [{ delta: { audio: { data: AUDIO_B64 } } }] });
    f({ choices: [{ delta: {}, finish_reason: "stop" }] });
    res.end();
  });
});


async function chat(cookie, body) {
  const res = await fetch(BASE + "/api/buzzy/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    let done = null;
    for (const frame of text.split("\n\n")) {
      if (!frame.includes("event: done")) continue;
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) { try { done = JSON.parse(line.slice(6)); } catch {} }
    }
    return { status: res.status, json: done };
  }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

async function suite() {
  const run = "cr18" + Date.now().toString(36);
  const email = "bz-cr18-" + run + "@test.local";
  const cookie = await signIn(email);
  check("signed in via magic link", Boolean(cookie));
  const sA = "s_" + run + "_a";
  let r = await chat(cookie, { message: "remember that my hourly rate is $85 an hour", sessionId: sA });
  const saved = r.json?.remembered;
  check("text turn saves a fact", r.status === 200 && saved?.key?.startsWith("remembered:"), JSON.stringify(r.json).slice(0, 300));
  check("saved value is their words", saved?.value === "my hourly rate is $85 an hour", String(saved?.value));
  r = await api(cookie, "GET", "/api/buzzy/memory");
  const rows0 = (r.json?.facts ?? []).filter((f) => f.key === saved?.key);
  check("Memory shows it at job_id null", rows0.length === 1 && rows0[0].jobId === null, JSON.stringify(rows0));
  const mark = seen.length;
  r = await chat(cookie, { message: "what is my hourly rate?", sessionId: "s_" + run + "_b" });
  const recalled = seen.slice(mark).some((p) => JSON.stringify(p.messages ?? []).includes("my hourly rate is $85 an hour"));
  check("a different conversation recalls it in the system prompt", recalled);
  r = await api(cookie, "PUT", "/api/buzzy/memory", { jobId: null, key: saved.key, value: "my hourly rate is $95 an hour" });
  check("PUT edits the fact", r.status === 200 && r.json?.ok === true && r.json?.updated === true, JSON.stringify(r.json));
  r = await api(cookie, "GET", "/api/buzzy/memory");
  const edited = (r.json?.facts ?? []).find((f) => f.key === saved.key);
  check("edited value is what Memory serves", edited?.value === "my hourly rate is $95 an hour", String(edited?.value));
  r = await api(cookie, "PUT", "/api/buzzy/memory", { jobId: null, key: "profile_name", value: "Hijack" });
  check("PUT refuses a profile key (400)", r.status === 400, r.status + " " + JSON.stringify(r.json));
  async function countRemembered() {
    const g = await api(cookie, "GET", "/api/buzzy/memory");
    return (g.json?.facts ?? []).filter((f) => String(f.key || "").startsWith("remembered:")).length;
  }
  const before = await countRemembered();
  r = await chat(cookie, { message: "my hourly rate is $85", sessionId: sA });
  check("no trigger writes nothing", (await countRemembered()) === before, "rows changed");
  check("no trigger returns no remembered field", r.json?.remembered === undefined);
  r = await chat(cookie, { message: "remember to call Bob tomorrow", sessionId: sA });
  check("a reminder writes nothing", (await countRemembered()) === before);
  check("a reminder is not saved", r.json?.remembered === undefined);
  check("the reply does not claim a save", !/\b(saved|noted|stored|remembered)\b/i.test(String(r.json?.reply || "")), String(r.json?.reply));
  r = await api(cookie, "DELETE", "/api/buzzy/memory", { jobId: null, key: "profile_name" });
  check("DELETE refuses a profile key (400)", r.status === 400, r.status + " " + JSON.stringify(r.json));
  r = await api(cookie, "DELETE", "/api/buzzy/memory", { jobId: null, key: saved.key });
  check("DELETE removes the remembered fact", r.status === 200 && r.json?.forgotten === 1, JSON.stringify(r.json));
  check("it is gone from Memory", (await countRemembered()) === before - 1);
  r = await api(cookie, "DELETE", "/api/buzzy/memory", {});
  check("DELETE with no job and no key is still 400", r.status === 400, r.status);
  const v1 = await chat(cookie, { voice: true, message: "tell me a short joke", sessionId: sA });
  const ttfaBefore = v1.json?.timings?.ttfaMs;
  check("voice (no reminder) reports ttfaMs", typeof ttfaBefore === "number", JSON.stringify(v1.json).slice(0, 200));
  const v2 = await chat(cookie, { voice: true, message: "remember that my van is a blue Transit", sessionId: "s_" + run + "_v" });
  const ttfaAfter = v2.json?.timings?.ttfaMs;
  check("voice turn saves the fact", v2.json?.remembered?.value === "my van is a blue Transit", JSON.stringify(v2.json?.remembered));
  check("voice turn offers no tools", !(v2.json?.tools ?? []).length, JSON.stringify(v2.json?.tools));
  check("voice (reminder) reports ttfaMs", typeof ttfaAfter === "number", JSON.stringify(v2.json?.timings));
  console.log("VOICE ttfaMs before=" + ttfaBefore + " after=" + ttfaAfter + " delta=" + (ttfaAfter - ttfaBefore));
}

await new Promise((r) => standIn.listen(0, "127.0.0.1", r));
process.env.BZ_CHAT_BASE_URL = "http://127.0.0.1:" + standIn.address().port + "/v1";
process.env.BZ_CHAT_KEY = "stand-in-key";
process.env.BZ_CHAT_MODEL = "stand-in-model";
try {
  await boot();
  await suite();
} catch (err) {
  failures++;
  console.error("FAIL  suite threw: " + (err?.stack || err));
} finally {
  await stop();
  try { standIn.close(); } catch {}
}
console.log(failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
