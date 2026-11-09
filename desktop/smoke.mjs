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
const CANDIDATES = [
  process.argv[2],
  join(ROOT, "dist-desktop/win-unpacked/resources/app"),
  join(ROOT, "dist-desktop/linux-unpacked/resources/app"),
  join(ROOT, "dist-desktop/mac/BeeZilla.app/Contents/Resources/app"),
  join(ROOT, "stage/app"),
].filter(Boolean);

const APP = CANDIDATES.find((p) => existsSync(join(p, ".output/server/index.mjs")));
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

const fail = (msg) => { console.error(`FAIL  ${msg}`); console.error(`smoke: app dir ${APP}`); process.exit(1); };

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

const stop = (code) => {
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 1500).unref();
  process.exit(code);
};

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
try {
  const health = await get("/api/agent/health");
  if (health.status !== 200) fail(`/api/agent/health -> ${health.status}`);
  console.log(`PASS  health 200`);
  ok++;

  const talk = await get("/buzzy/talk");
  if (talk.status !== 200) fail(`/buzzy/talk -> ${talk.status}`);
  if (!talk.body.includes('id="chatInput"')) fail("/buzzy/talk rendered without #chatInput");
  console.log(`PASS  /buzzy/talk ${talk.body.length} B, composer present`);
  ok++;

  const caps = await get("/api/buzzy/capabilities");
  if (caps.status !== 200) fail(`/api/buzzy/capabilities -> ${caps.status}`);
  const parsed = JSON.parse(caps.body);
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) fail("capabilities returned no tools");
  console.log(`PASS  /api/buzzy/capabilities: ${parsed.tools.length} tools, ${parsed.capabilities.length} capabilities`);
  ok++;

  const lib = await get("/buzzy/library");
  if (lib.status !== 200) fail(`/buzzy/library -> ${lib.status}`);
  console.log(`PASS  /buzzy/library 200`);
  ok++;
} catch (err) {
  fail(`threw: ${err?.message ?? err}`);
}

console.log(`\nsmoke: ${ok}/4 checks passed against ${APP}`);
stop(0);
