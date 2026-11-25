#!/usr/bin/env node
/**
 * test-buzzy-art-cap.mjs — the board save route's size guard (issue #296 follow-up).
 *
 * WHY THIS EXISTS: `/api/buzzy/art` had no suite at all. Every number quoted for the
 * 8 MB board cap came from curl and a browser against a built server, which is real
 * evidence but not a repeatable gate — nothing would catch the guard being deleted.
 *
 * OWNS ITS OWN SERVER, like test-buzzy-jobs-ownership.mjs: no arguments builds
 * nothing, boots `.output/server/index.mjs` on an ephemeral port, waits for health,
 * and tears it down on success and on failure. `npm run build` must have run first.
 * Pass `[baseUrl] [mailLogPath]` to drive an already-running server instead.
 *
 * Asserts:
 *   CAP-1  a small board saves: 200 {ok:true,saved:true}
 *   CAP-2  the board comes back from GET with the same image count and order
 *   CAP-3  a board just under the limit (7 MB) still saves — no off-by-one refusal
 *   CAP-4  a board over the limit (9 MB) is refused: 413 payload_too_large + bytes
 *   CAP-5  the refusal writes nothing: the stored board is still the 7 MB one
 *   CAP-6  an unauthenticated save is 401 before any size logic runs
 *   REPAINT-1…8  the 3D painter's texture repaint is refused in Lockdown (from the account's saved
 *          mode), and only there
 *
 * The mutant to run against this: delete the MAX_BOARD_BYTES block in
 * src/lib/buzzy/art.nitro.ts — CAP-4 goes red while CAP-1..3 stay green, which is
 * exactly the "the guard is doing the work" signal.
 *
 * Usage: node scripts/test-buzzy-art-cap.mjs [baseUrl] [mailLogPath]
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(ROOT, ".output", "server", "index.mjs");
const MB = 1024 * 1024;

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

// `npm run build` wipes .output/server/_libs, so a built-but-unserved checkout 500s
// with ENOENT on pglite.data. Copying the WASM here keeps the suite self-sufficient.
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
  if (BASE) return; // external server: caller owns lifecycle

  if (!existsSync(SERVER_ENTRY)) {
    console.error(`FAIL  no built server at ${SERVER_ENTRY}\n      run: npm run build`);
    process.exit(2);
  }
  ensurePgliteAssets();

  mailDir = mkdtempSync(join(tmpdir(), "bz-art-cap-"));
  MAIL_LOG = join(mailDir, "outbound-mail.jsonl");
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;

  // Provider credentials disable the dev inbox, and the magic link has to be readable
  // from somewhere for the suite to sign in.
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
      // The actionUrl is built from this; leave it unset and the URL says :8090 while
      // the server listens on the ephemeral port (that is also the INVALID_ORIGIN trap).
      BETTER_AUTH_URL: BASE,
      BETTER_AUTH_TRUSTED_ORIGINS: BASE,
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
  console.error(
    `FAIL  server never became healthy on ${BASE}${child.exitCode !== null ? ` (exited ${child.exitCode})` : ""}` +
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

process.on("exit", () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (mailDir) rmSync(mailDir, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { stop().finally(() => process.exit(130)); });
}

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
    await sleep(500);
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
    if (/INVALID_ORIGIN/i.test(body)) {
      throw new Error(
        `the server at ${BASE} does not trust this origin (Better Auth INVALID_ORIGIN).\n` +
          `      Start it with BETTER_AUTH_URL=${BASE} and BETTER_AUTH_TRUSTED_ORIGINS=${BASE}, ` +
          `or run this suite with no arguments so it boots its own server.`,
      );
    }
    throw new Error(`magic-link request failed ${res.status}: ${body}`);
  }
  const url = await readMailUrl(email);
  const vres = await fetch(url, { redirect: "manual" });
  const setCookies = vres.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error(`magic-link verify returned ${vres.status} with no session cookie`);
  return cookie;
}

/** A board whose serialised size is `targetBytes`: one image with a long data URL. */
function boardOfSize(targetBytes, imageId = "im_cap") {
  const head = "data:image/jpeg;base64,";
  const url = head + "A".repeat(Math.max(1, targetBytes - head.length));
  return {
    version: 3, w: 1400, h: 900, bg: "#141414", raster: null, strokes: [],
    images: [{ id: imageId, url, x: 0, y: 0, w: 400, h: 300 }],
    order: [{ kind: "image", id: imageId }],
  };
}

async function saveBoard(cookie, jobId, board) {
  const body = JSON.stringify({ action: "save", jobId, board });
  const res = await fetch(`${BASE}/api/buzzy/art`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, bytes: body.length, text };
}

async function main() {
  await boot();
  console.log(`# art save cap — ${BASE}`);

  const email = `art-cap-${Date.now().toString(36)}@example.test`;
  const cookie = await signIn(email);

  // A job row must exist before a board may be saved against it.
  const jobId = `job_cap_${Date.now().toString(36)}`;
  const created = await fetch(`${BASE}/api/buzzy/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify({ id: jobId, title: "cap test", status: "In progress", data: {} }),
  });
  check("CAP-0  a job can be opened to save against", created.ok, `HTTP ${created.status}`);

  // CAP-6 first: no cookie, straight to the route.
  const anon = await saveBoard("", jobId, boardOfSize(2 * MB));
  check("CAP-6  an unauthenticated save is 401", anon.status === 401, `HTTP ${anon.status}`);

  const small = await saveBoard(cookie, jobId, boardOfSize(2 * MB));
  check(
    "CAP-1  a 2 MB board saves",
    small.status === 200 && small.json?.ok === true && small.json?.saved === true,
    `HTTP ${small.status} ${small.text.slice(0, 120)}`,
  );

  const got = await fetch(`${BASE}/api/buzzy/art?job=${jobId}`, { headers: { cookie } });
  const gotJson = await got.json().catch(() => null);
  const gotBoard = gotJson?.board;
  check(
    "CAP-2  the saved board comes back with its image and order",
    got.status === 200 && gotBoard?.images?.length === 1 && gotBoard?.order?.length === 1,
    `HTTP ${got.status} images=${gotBoard?.images?.length} order=${gotBoard?.order?.length}`,
  );

  const under = await saveBoard(cookie, jobId, boardOfSize(7 * MB, "im_under"));
  check(
    "CAP-3  a 7 MB board still saves (no off-by-one refusal)",
    under.status === 200 && under.json?.saved === true,
    `HTTP ${under.status} ${under.text.slice(0, 120)}`,
  );

  const over = await saveBoard(cookie, jobId, boardOfSize(9 * MB, "im_over"));
  check(
    "CAP-4  a 9 MB board is refused as payload_too_large",
    over.status === 413 && over.json?.code === "payload_too_large" && Number(over.json?.bytes) > 8 * MB,
    `HTTP ${over.status} ${over.text.slice(0, 160)}`,
  );

  const after = await fetch(`${BASE}/api/buzzy/art?job=${jobId}`, { headers: { cookie } });
  const afterJson = await after.json().catch(() => null);
  const afterBoard = afterJson?.board;
  check(
    "CAP-5  the refusal wrote nothing (stored board is still the 7 MB one)",
    afterBoard?.images?.[0]?.id === "im_under" && (afterBoard?.images?.[0]?.url || "").length > 7 * MB - 4096,
    `stored id=${afterBoard?.images?.[0]?.id} urlLen=${(afterBoard?.images?.[0]?.url || "").length}`,
  );

  // CAP-7: the page's own 413 branch is not reachable from the UI while both caps agree,
  // so nothing above would notice it being reverted to the client-cap message (which,
  // measured on a divergence build, printed "Board is 0.4 MB - over the 8 MB save limit").
  // Pin the wiring in the served bytes instead of trusting a walk nobody can repeat.
  const page = await fetch(`${BASE}/buzzy/sketch`, { headers: { cookie } });
  const pageText = await page.text();
  const branch = /if \(r\.status === 413\) \{ rejectedByServer\(bytes\); return; \}/.test(pageText);
  const misleading = /if \(r\.status === 413\) \{ tooBig\(/.test(pageText);
  check(
    "CAP-7  the served page reports a 413 as a server refusal, not the client cap",
    page.status === 200 && branch && !misleading,
    `HTTP ${page.status} branch=${branch} tooBigOn413=${misleading}`,
  );

  // CAP-8: the two #296 review must-fixes. Neither is reachable from the cap walk:
  //   * imageEl must re-point its cached element when a URL changes — shrinkLargestImage
  //     rewrites im.url in place, and a cache keyed only by id kept painting the old,
  //     larger bitmap until reload (the save carried the new URL, so the board lied);
  //   * the image wrap must not take the pointer, or a mark in front of an image paints
  //     correctly and still cannot be clicked — the wrap stole every press in its rect.
  // Pin the served bytes; the behaviour itself is measured in a browser (CDP).
  const srcRepoint = /el\.getAttribute\("src"\) !== url[\s\S]{0,400}?el\.src = url;/.test(pageText);
  const wrapPassive = /\.img-wrap \{ position:absolute; pointer-events:none;/.test(pageText);
  const wrapTakesPress = /\.img-wrap \{ position:absolute; pointer-events:auto;/.test(pageText);
  const orderedHit = /function hitTestOrdered\(/.test(pageText);
  const selectUsesOrdered = /var pick = hitTestOrdered\(p\);/.test(pageText);
  check(
    "CAP-8  the served page re-points a changed image URL and takes the press on top",
    srcRepoint && wrapPassive && !wrapTakesPress && orderedHit && selectUsesOrdered,
    `srcRepoint=${srcRepoint} wrapPassive=${wrapPassive} wrapAuto=${wrapTakesPress} orderedHit=${orderedHit} select=${selectUsesOrdered}`,
  );

  // REPAINT: the 3D painter's repaint (public/buzzy/model-paint.js) sends a model's texture to the
  // image provider, so Lockdown ("nothing leaves BeeZilla") must refuse it, from the ACCOUNT's saved
  // mode (not from anything the page says). Local edits never reach this route. This build has no
  // image provider, so a request that gets past the privacy gate stops at "not configured": that is
  // what tells "refused for Lockdown" from "refused for nothing in particular".
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const repaint = async (ck) => {
    const res = await fetch(`${BASE}/api/buzzy/art`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...(ck ? { cookie: ck } : {}) },
      body: JSON.stringify({ action: "repaint3d", crop: PNG, mask: PNG, instruction: "add rust" }),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json: j, text };
  };
  const setMode = (mode) => fetch(`${BASE}/api/buzzy/privacy`, { method: "PUT", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ mode }) });

  const anon3d = await repaint("");
  check("REPAINT-1  a repaint without a session is 401", anon3d.status === 401, `HTTP ${anon3d.status}`);

  const openMode = await repaint(cookie);
  check(
    "REPAINT-2  with no privacy mode saved, the request gets past the gate (and stops at the missing provider)",
    openMode.status === 503 && openMode.json?.code === "not_configured",
    `HTTP ${openMode.status} ${openMode.text.slice(0, 140)}`,
  );

  check("REPAINT-3  Lockdown can be saved", (await setMode("lockdown")).ok);
  const locked = await repaint(cookie);
  check(
    "REPAINT-4  in Lockdown the repaint is refused: 403, code lockdown, and the message says how to switch it off",
    locked.status === 403 && locked.json?.code === "lockdown" && /Lockdown/.test(locked.json?.error || "") && /Talk bar/.test(locked.json?.error || ""),
    `HTTP ${locked.status} ${locked.text.slice(0, 200)}`,
  );

  check("REPAINT-5  Advocate can be saved", (await setMode("advocate")).ok);
  const advocate = await repaint(cookie);
  check("REPAINT-6  Advocate is not Lockdown: the repaint is not refused for privacy", advocate.json?.code !== "lockdown" && advocate.status === 503, `HTTP ${advocate.status} ${advocate.text.slice(0, 140)}`);

  check("REPAINT-7  Lockdown can be switched off again", (await setMode("open")).ok);
  const reopened = await repaint(cookie);
  check("REPAINT-8  …and the repaint is no longer refused for privacy", reopened.json?.code !== "lockdown" && reopened.status === 503, `HTTP ${reopened.status} ${reopened.text.slice(0, 140)}`);

  await stop();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`FAIL  ${err.message}`);
  await stop();
  process.exit(1);
});
