#!/usr/bin/env node
/**
 * E2E: "search is off" vs "your BeeZilla search session lapsed" must never be the
 * same message.
 *
 * Inference has had this distinction since s6b (an expired managed token says
 * "reconnect", never "bad key"). Search now gets the same treatment, because a
 * signed-in user who is told "search: off — paste a Brave key" will go hunting for a
 * credential they were never meant to need.
 *
 * Proves the whole chain of signals:
 *   store (managed token + expiry)  ->  launcher (BZ_SEARCH_EXPIRED)  ->  runtime
 *   (/api/buzzy/search-status needsReconnect)  ->  settings bridge  ->  CLI doctor
 *
 * Run: node scripts/test-search-reconnect.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { saveManagedSearch } = await import("../scripts/lib/search-keys.mjs");

async function boot(dataDir) {
  const child = spawn(process.execPath, [join(ROOT, "scripts", "beezilla-local.mjs")], {
    cwd: ROOT,
    env: { ...process.env, BZ_RUNTIME: "local", BZ_DATA_DIR: dataDir, HOST: "127.0.0.1", BZ_BRAVE_KEY: "", BZ_SEARCH_TOKEN: "" },
    stdio: "ignore",
  });
  let rt = null;
  for (let i = 0; i < 120 && !rt; i++) {
    try {
      const parsed = JSON.parse(readFileSyncSafe(join(dataDir, "runtime.json")));
      if (parsed?.port) rt = parsed;
    } catch {}
    if (!rt) await sleep(500);
  }
  return { child, rt };
}
function readFileSyncSafe(path) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(path, "utf8");
}
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

const status = async (rt) => {
  const res = await fetch(`http://${rt.host}:${rt.port}/api/buzzy/search-status`, {
    headers: { authorization: `Bearer ${rt.token}` },
  });
  return res.json();
};

// ── 1. a live managed credential ────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "bz-rc-live-"));
  saveManagedSearch(dir, {
    token: "bz1.live.search.token",
    gateway: "https://search.beezilla.ai/v1/search",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const { child, rt } = await boot(dir);
  check("runtime boots with a live managed credential", Boolean(rt));
  if (rt) {
    const s = await status(rt);
    check("search is available through our gateway", s.available === true && s.provider === "beezilla", JSON.stringify(s));
    check("a live credential is not flagged for reconnect", !s.needsReconnect, JSON.stringify(s));
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dir, { recursive: true, force: true });
}

// ── 2. the same credential, expired ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "bz-rc-stale-"));
  saveManagedSearch(dir, {
    token: "bz1.stale.search.token",
    gateway: "https://search.beezilla.ai/v1/search",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const { child, rt } = await boot(dir);
  if (rt) {
    const s = await status(rt);
    check("an expired session is NOT available", s.available === false, JSON.stringify(s));
    check("...and is reported as needing a reconnect", s.needsReconnect === true, JSON.stringify(s));

    const doctor = execFileSync(process.execPath, [join(ROOT, "bin", "beezilla.mjs"), "doctor"], {
      cwd: ROOT,
      env: { ...process.env, BZ_DATA_DIR: dir, BZ_RUNTIME: "local" },
      encoding: "utf8",
    });
    check("doctor says 'session expired', not 'not configured'", /session expired/i.test(doctor), firstLine(doctor, /web search/i));
    check("doctor tells the user to reconnect", /reconnect/i.test(doctor), "named the fix");
    check("doctor still offers the BYOK escape hatch", /your own Brave key/i.test(doctor), "byok mentioned");
  } else {
    check("runtime boots with an expired credential", false, "no runtime.json");
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. never configured at all ──────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "bz-rc-none-"));
  const { child, rt } = await boot(dir);
  if (rt) {
    const s = await status(rt);
    check("a fresh install is unavailable", s.available === false, JSON.stringify(s));
    check("a fresh install is not 'expired'", !s.needsReconnect, JSON.stringify(s));

    const doctor = execFileSync(process.execPath, [join(ROOT, "bin", "beezilla.mjs"), "doctor"], {
      cwd: ROOT,
      env: { ...process.env, BZ_DATA_DIR: dir, BZ_RUNTIME: "local" },
      encoding: "utf8",
    });
    check("doctor says 'not configured' for a fresh install", /not configured/i.test(doctor), firstLine(doctor, /web search/i));
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dir, { recursive: true, force: true });
}

// ── 4. the settings bridge exposes the same distinction ─────────────────────
{
  const { createSettingsHandlers } = await import("../desktop/settings.mjs");
  const dir = mkdtempSync(join(tmpdir(), "bz-rc-bridge-"));
  saveManagedSearch(dir, {
    token: "bz1.stale.search.token",
    gateway: "https://search.beezilla.ai/v1/search",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const handlers = createSettingsHandlers({
    dataDir: () => dir,
    cipher: {},
    restart: async () => ({ restarted: false, started: false }),
  });
  const described = await handlers.status();
  check("the bridge reports needs-reconnect", described?.searchNeedsReconnect === true, JSON.stringify(described?.searchNeedsReconnect));
  check("the bridge does not pretend search is configured", described?.search === null, JSON.stringify(described?.search));
  rmSync(dir, { recursive: true, force: true });
}

function firstLine(text, re) {
  const line = text.split("\n").find((l) => re.test(l)) ?? "";
  return line.trim().slice(0, 90);
}

console.log(`\nsearch reconnect E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
