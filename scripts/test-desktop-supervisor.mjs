#!/usr/bin/env node
/**
 * E2E: desktop supervisor contract (S5) — headless, no Electron needed.
 *
 * main.mjs is thin enough to eyeball; the part that can silently break a
 * shipped app is the supervisor: spawn the runtime, wait for a token, hand back
 * an authenticated base URL, and stop it gracefully. That is what this verifies,
 * against the real launcher and a real PGLite store.
 *
 * Run: node scripts/test-desktop-supervisor.mjs
 */
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeSupervisor, defaultDataDir } from "../desktop/supervisor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const savedDataDir = process.env.BZ_DATA_DIR;
delete process.env.BZ_DATA_DIR;
check("default data dir is per-user", /beezilla|BeeZilla/.test(defaultDataDir()), defaultDataDir());
if (savedDataDir !== undefined) process.env.BZ_DATA_DIR = savedDataDir;

const dataDir = mkdtempSync(join(tmpdir(), "bz-desktop-e2e-"));
const log = [];
const sup = new RuntimeSupervisor({ root: ROOT, dataDir, onLog: (l) => log.push(l) });

const rt = await sup.start();
check("supervisor starts the runtime", !!rt?.port, `port ${rt?.port}`);
check("runtime publishes a per-launch token", typeof sup.token === "string" && sup.token.length >= 32);
check("baseUrl points at loopback", /^http:\/\/127\.0\.0\.1:\d+$/.test(sup.baseUrl), sup.baseUrl);

// The window's auth path: the same bearer header Electron injects per request.
const anon = await fetch(`${sup.baseUrl}/api/buzzy/jobs`).then((r) => r.status).catch(() => 0);
check("unauthenticated API call refused", anon === 401, `status ${anon}`);

const auth = await fetch(`${sup.baseUrl}/api/buzzy/jobs`, {
  headers: { authorization: `Bearer ${sup.token}` },
}).then((r) => r.status).catch(() => 0);
check("authenticated API call accepted", auth === 200, `status ${auth}`);

// Second start() must be idempotent — Electron calls it again on activate.
const again = await sup.start();
check("second start() reuses the running runtime", again.port === rt.port, `port ${again.port}`);

// The window's entry point must actually render.
const page = await fetch(`${sup.baseUrl}/buzzy/talk`, {
  headers: { authorization: `Bearer ${sup.token}` },
  redirect: "manual",
}).then((r) => ({ status: r.status, body: r })).catch(() => ({ status: 0 }));
check("window entry point serves", page.status === 200, `status ${page.status}`);

await sup.stop();
check("graceful stop completes", true);
await new Promise((r) => setTimeout(r, 1500));
check("handshake file removed on stop", !existsSync(join(dataDir, "runtime.json")));
check("runtime captured no crash banners", !log.some((l) => /unexpectedly/.test(l)));

rmSync(dataDir, { recursive: true, force: true });
console.log(`\ndesktop supervisor E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
