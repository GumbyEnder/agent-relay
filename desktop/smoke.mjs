#!/usr/bin/env node
/**
 * Packaged-app smoke test.
 *
 * Every desktop release so far was verified by hand, and two release-blocking
 * defects shipped anyway: 0.2.0 could not launch (an in-asar import resolved to a
 * path that only exists on the build machine), and every build up to 0.2.11 failed
 * its readiness probe whenever loopback name resolution was unavailable.
 *
 * This starts the runtime **from the packaged tree** — the same bytes the window
 * loads — and asserts the three things a person would notice first:
 *
 *   1. the runtime answers /api/agent/health with 200
 *   2. /buzzy/talk renders (it contains #chatInput)
 *   3. /buzzy/capabilities answers with a JSON tool list
 *
 * Exit codes: 0 pass, 1 failure (with the reason), 2 could not even start.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `node desktop/dist.mjs stage` writes desktop/stage/app (there is no <root>/stage),
// so both spellings are here: the documented one and the one that exists.
const CANDIDATES = [
  process.argv[2],
  join(ROOT, "dist-desktop/win-unpacked/resources/app"),
  join(ROOT, "dist-desktop/linux-unpacked/resources/app"),
  join(ROOT, "dist-desktop/mac/BeeZilla.app/Contents/Resources/app"),
  join(ROOT, "desktop/stage/app"),
  join(ROOT, "stage/app"),
].filter(Boolean);

// An app dir passed on the command line may be relative, and the child runs with
// cwd = that dir: a relative path then resolves a second time inside the app and
// PGlite lands in `…/desktop/stage/app/.smoke-data` (the runtime answers 500 on
// health instead of failing honestly). Absolute from here on.
const APP =
  CANDIDATES.map((p) => resolve(p)).find((p) => existsSync(join(p, ".output/server/index.mjs")));
if (!APP) {
  console.error(`smoke: no packaged runtime found. Looked in:\n  ${CANDIDATES.join("\n  ")}`);
  process.exit(2);
}

const PORT = Number(process.env.SMOKE_PORT || 7599);
const TOKEN = process.env.SMOKE_TOKEN || "smoke-token";

const reachable = (port, host = "127.0.0.1") =>
  new Promise((done) => {
    const sock = connect(port, host);
    const finish = (ok) => { try { sock.destroy(); } catch { /* closed */ } done(ok); };
    sock.setTimeout(800);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });

const fail = (msg) => { console.error(`FAIL  ${msg}`); console.error(`smoke: app dir ${APP}`); };

const child = spawn(process.execPath, [".output/server/index.mjs"], {
  cwd: APP,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    BZ_RUNTIME: "local",
    BZ_RUNTIME_TOKEN: TOKEN,
    BZ_DATA_DIR: join(APP, ".smoke-data"),
    BZ_LOCAL_OWNER_NAME: "Smoke Test",
    BZ_LOCAL_OWNER_EMAIL: "smoke@example.invalid",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (b) => { output += String(b); });
child.stderr.on("data", (b) => { output += String(b); });

// Exit only after the child is gone. The old version fired SIGTERM and called
// process.exit() in the same tick, so the 1.5 s SIGKILL escalation was an unref'd
// timer that never ran: a runtime that ignored SIGTERM kept 127.0.0.1:PORT and the
// next smoke run found the port taken (and then measured the previous build).
const stop = async (code) => {
  const gone = () => new Promise((done) => setTimeout(done, 50));
  const alive = child.exitCode === null && child.signalCode === null;
  if (!alive) {
    await gone();
    process.exit(code);
  }
  await new Promise((done) => {
    const hard = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, 3000);
    child.once("exit", () => { clearTimeout(hard); done(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(hard); done(); }
  });
  process.exit(code);
};

// A failure must take the runtime down with it, or the next attempt talks to a
// zombie on the port and reports the previous build's health.
const die = async (msg) => { fail(msg); await stop(1); };

// 60 s: the first boot also runs every migration.
const deadline = Date.now() + 60_000;
let up = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.error(output.slice(-2000));
    fail(`the runtime exited with code ${child.exitCode} before answering — this is the 0.2.0 defect`);
  }
  if (await reachable(PORT)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) {
  console.error(output.slice(-2000));
  fail(`the runtime never listened on 127.0.0.1:${PORT} within 60 s`);
}

const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.text() };
};

let ok = 0;
const TOTAL = 6;
try {
  const health = await get("/api/agent/health");
  if (health.status !== 200) await die(`/api/agent/health -> ${health.status}`);
  console.log(`PASS  health 200`);
  ok++;

  const talk = await get("/buzzy/talk");
  if (talk.status !== 200) await die(`/buzzy/talk -> ${talk.status}`);
  if (!talk.body.includes('id="chatInput"')) await die("/buzzy/talk rendered without #chatInput");
  console.log(`PASS  /buzzy/talk ${talk.body.length} B, composer present`);
  ok++;

  const caps = await get("/api/buzzy/capabilities");
  if (caps.status !== 200) await die(`/api/buzzy/capabilities -> ${caps.status}`);
  const parsed = JSON.parse(caps.body);
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) await die("capabilities returned no tools");
  console.log(`PASS  /api/buzzy/capabilities: ${parsed.tools.length} tools, ${parsed.capabilities.length} capabilities`);
  ok++;

  const lib = await get("/buzzy/library");
  if (lib.status !== 200) await die(`/buzzy/library -> ${lib.status}`);
  console.log(`PASS  /buzzy/library 200`);
  ok++;

  // CR-8: the desktop's chrome must be the website's chrome, not a lookalike. Since
  // this increment the row is not written into page markup at all — nav.js builds it
  // from LINKS, exactly as it does on the website — so the contract to hold is the
  // file every page loads. Assert the served nav.js declares the places in web order
  // (minus the ones this line declares absent), and that every page links it.
  const NAV_ORDER = [
    ["talk", "Talk"],
    ["library", "Library"],
    ["memory", "Memory"],
    ["experts", "Experts"],
    ["recipes", "Recipes"],
    ["sketch", "Sketch"],
    ["studio", "Music studio"],
    ["capabilities", "What BeeZilla can do"],
    ["download", "Download"],
    ["wallet", "Honey"],
    ["publish", "Publish"],
  ];
  const navjs = await get("/buzzy/nav.js");
  if (navjs.status !== 200) await die(`/buzzy/nav.js -> ${navjs.status}`);
  const absentBlock = /var DESKTOP_ABSENT = \{([^}]*)\}/.exec(navjs.body);
  const absent = new Set(
    absentBlock ? [...absentBlock[1].matchAll(/([a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1]) : [],
  );
  const linksBlock = /var LINKS = \[([\s\S]*?)\]\.filter\(/.exec(navjs.body);
  if (!linksBlock) await die("/buzzy/nav.js has no LINKS table to read (nav rebuilt by hand?)");
  const links = [...linksBlock[1].matchAll(/\{ id: "([^"]+)", href: "([^"]+)", label: "([^"]+)"/g)].map(
    (m) => ({ id: m[1], href: m[2], label: m[3] }),
  );
  const row = links.filter((l) => !absent.has(l.id));
  if (row.length !== NAV_ORDER.length) {
    await die(
      `nav.js LINKS carries ${row.length} places after DESKTOP_ABSENT, expected ${NAV_ORDER.length}: ${JSON.stringify(row.map((l) => [l.id, l.label]))}`,
    );
  }
  NAV_ORDER.forEach(([id, label], i) => {
    if (row[i].id !== id || row[i].label !== label) {
      throw new Error(`nav.js slot ${i + 1} is ${JSON.stringify([row[i].id, row[i].label])}, expected ${JSON.stringify([id, label])}`);
    }
  });
  if (!talk.body.includes('src="/buzzy/nav.js"')) await die("/buzzy/talk never loads nav.js");
  if (!talk.body.includes('href="/buzzy/nav.css"')) await die("/buzzy/talk never loads nav.css");
  console.log(
    `PASS  nav.js declares ${row.length} places in web order (absent: ${[...absent].join(", ") || "none"}), /buzzy/talk links nav.js + nav.css`,
  );
  ok++;

  // CR-8: every place the row names must answer 200 on this line. The row is shared
  // with the website, so a 404 here is the desktop having inherited a word it cannot
  // keep — /buzzy/studio and /buzzy/download were exactly that until this increment.
  for (const { id, href } of row) {
    const page = await get(href);
    if (page.status !== 200) await die(`nav link ${id} → ${href} answered ${page.status}`);
    if (!page.body.includes('id="bzNav"')) await die(`${href} rendered without the nav`);
    if (!page.body.includes('src="/buzzy/nav.js"')) await die(`${href} never loads nav.js`);
  }
  console.log(`PASS  every nav link answers 200, carries the nav, and loads nav.js`);
  ok++;
} catch (err) {
  await die(`threw: ${err?.message ?? err}`);
}

console.log(`\nsmoke: ${ok}/${TOTAL} checks passed against ${APP}`);
await stop(0);
