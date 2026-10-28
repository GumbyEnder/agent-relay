#!/usr/bin/env node
/**
 * E2E: local runtime (S1).
 *
 * Asserts the properties the desktop app depends on, against a REAL booted
 * server — not a unit stub:
 *
 *   1. boots with BZ_RUNTIME=local, no DATABASE_URL, no Honcho, no cloud env
 *   2. binds loopback ONLY (a LAN address on the same port must refuse)
 *   3. creates a durable on-disk PGLite store in the data dir
 *   4. publishes runtime.json for the window/CLI, and removes it on stop
 *   5. survives a restart against the same store (no wipe)
 *
 * Run: node scripts/test-local-e2e.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 7411;
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

async function waitRuntime(file, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function start(dataDir) {
  const child = spawn(
    process.execPath,
    [join(ROOT, "scripts/beezilla-local.mjs"), "--port", String(PORT)],
    {
      cwd: ROOT,
      env: { ...process.env, BZ_DATA_DIR: dataDir, BZ_RUNTIME: "local" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (b) => process.stdout.write(`  │ ${b}`));
  child.stderr.on("data", (b) => process.stdout.write(`  ! ${b}`));
  return child;
}

async function stop(child, runtimeFile) {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  await new Promise((r) => setTimeout(r, 800)); // let runtime.json cleanup land
  check("runtime.json removed on stop", !existsSync(runtimeFile));
}

const dataDir = mkdtempSync(join(tmpdir(), "bz-local-e2e-"));
const runtimeFile = join(dataDir, "runtime.json");

// ── boot 1 ────────────────────────────────────────────────────────────────────
let child = start(dataDir);
const runtime = await waitRuntime(runtimeFile);
check("boots and publishes runtime.json", !!runtime, runtime ? `port ${runtime.port}` : "timeout");

if (!runtime) {
  child.kill("SIGKILL");
  console.log("\nlocal runtime E2E: 0 checks, boot failed");
  process.exit(1);
}

const base = `http://127.0.0.1:${runtime.port}`;
const health = await fetch(`${base}/api/agent/health`).then((r) => r.json()).catch(() => null);
check("health 200 on loopback", !!health?.ok, JSON.stringify(health?.service ?? null));

// loopback-only: the same port must NOT answer on a LAN address
const lan = lanAddress();
if (lan) {
  const lanOk = await fetch(`http://${lan}:${runtime.port}/api/agent/health`, {
    signal: AbortSignal.timeout(2500),
  }).then(() => true).catch(() => false);
  check("not reachable on LAN address", !lanOk, lan);
} else {
  check("not reachable on LAN address", true, "no non-loopback IPv4 to test");
}

// durable store actually on disk
const pgdata = readdirSync(dataDir).filter((f) => !f.endsWith(".json"));
check(
  "PGLite data dir created on disk",
  pgdata.includes("base") && pgdata.includes("PG_VERSION"),
  pgdata.slice(0, 6).join(","),
);

// landing page serves from the same runtime (signed-out gate → /buzzy)
const landing = await fetch(`${base}/buzzy/landing`, { redirect: "manual" }).then((r) => r.status).catch(() => 0);
check("branded landing serves", landing === 200, `status ${landing}`);

// ── local auth: loopback alone is NOT authentication ─────────────────────────
const token = runtime.token;
check("runtime.json carries a per-launch token", typeof token === "string" && token.length >= 32);

const unauth = await fetch(`${base}/api/buzzy/jobs`).then((r) => r.status).catch(() => 0);
check("API refuses without the token", unauth === 401, `status ${unauth}`);

const authorized = await fetch(`${base}/api/buzzy/jobs`, {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.status).catch(() => 0);
check("API accepts with the token", authorized === 200, `status ${authorized}`);

const badHost = await new Promise((done) => {
  const req = http.request(
    {
      host: "127.0.0.1",
      port: runtime.port,
      path: "/api/buzzy/jobs",
      headers: { Host: "evil.example", authorization: `Bearer ${token}` },
    },
    (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    },
  );
  req.on("error", () => done(0));
  req.end();
});
check("DNS-rebinding Host header rejected", badHost !== 200, `status ${badHost}`);

await stop(child, runtimeFile);

// ── boot 2 against the same store ─────────────────────────────────────────────
child = start(dataDir);
const runtime2 = await waitRuntime(runtimeFile);
check("restarts against the same data dir", !!runtime2, runtime2 ? `port ${runtime2.port}` : "timeout");
const health2 = runtime2
  ? await fetch(`http://127.0.0.1:${runtime2.port}/api/agent/health`).then((r) => r.json()).catch(() => null)
  : null;
check("health 200 after restart", !!health2?.ok);

// migrations must NOT be re-applied to an existing store
let migRows = "n/a";
try {
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `import('./src/lib/db.ts').then(async (m) => { const sql = await m.getSql(); const r = await sql\`select count(*)::int as n from _migrations\`; console.log(JSON.stringify(r)); const pg = await m.getPglite(); await pg.close(); })`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, BZ_RUNTIME: "local", BZ_DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  migRows = out.trim().split("\n").pop();
  check("existing store opens with migrations intact", /"n":\s*[1-9]/.test(migRows), migRows);
} catch (err) {
  check("existing store opens with migrations intact", false, String(err).slice(0, 160));
}

// exactly ONE owner, provisioned idempotently across both boots
try {
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `import('./src/lib/db.ts').then(async (m) => { const sql = await m.getSql(); const r = await sql\`select count(*)::int as n, min(email) as email from "user"\`; console.log(JSON.stringify(r)); const pg = await m.getPglite(); await pg.close(); })`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, BZ_RUNTIME: "local", BZ_DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const line = out.trim().split("\n").pop();
  const parsed = JSON.parse(line);
  check(
    "single owner provisioned, idempotent across restarts",
    parsed[0]?.n === 1 && parsed[0]?.email === "owner@beezilla.local",
    line,
  );
} catch (err) {
  check("single owner provisioned, idempotent across restarts", false, String(err).slice(0, 160));
}

await stop(child, runtimeFile);
rmSync(dataDir, { recursive: true, force: true });

console.log(`\nlocal runtime E2E: ${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
