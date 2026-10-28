#!/usr/bin/env node
/**
 * E2E: a runtime must not outlive whoever started it.
 *
 * This was a real leak: a harness that timed out, or an Electron crash, left the
 * Nitro child running forever — holding its port and its PGLite directory, with
 * nothing on disk pointing at it. 11 orphans had accumulated before anyone
 * noticed, because the symptom is absence, not an error.
 *
 * Two cases, both SIGKILL (the case a shutdown handler cannot cover):
 *   1. kill the launcher       -> the server child must exit on its own
 *   2. kill the launcher's parent -> the launcher and the child must exit
 *
 * Run: node scripts/test-runtime-orphans.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "scripts", "beezilla-local.mjs");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Alive = the pid exists (signal 0 does not require permission to succeed). */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitGone = async (pid, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(400);
  }
  return false;
};

const readJson = (file) => {
  try {
    // Quiet on purpose: a missing runtime.json is the expected state while the
    // launcher boots, not an error worth printing 40 times.
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const startLauncher = (dataDir) =>
  spawn(process.execPath, [LAUNCHER], {
    cwd: ROOT,
    env: { ...process.env, BZ_RUNTIME: "local", BZ_DATA_DIR: dataDir, BZ_CHAT_KEY: "sk-orphan-probe", HOST: "127.0.0.1" },
    stdio: "ignore",
    detached: false,
  });

const waitForRuntime = async (dataDir, ms = 60_000) => {
  const file = join(dataDir, "runtime.json");
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rt = readJson(file);
    if (rt?.pid && rt?.port) return rt;
    await sleep(500);
  }
  return null;
};

// ── case 1: SIGKILL the launcher, the server child must die ─────────────────
{
  const dataDir = mkdtempSync(join(tmpdir(), "bz-orphan-a-"));
  const launcher = startLauncher(dataDir);
  const rt = await waitForRuntime(dataDir);
  check("case 1: runtime came up", Boolean(rt), rt ? `port ${rt.port}` : "no runtime.json");

  if (rt) {
    // runtime.json names the SERVER pid; the launcher pid is our own child.
    const serverPid = rt.pid;
    launcher.kill("SIGKILL");
    const gone = await waitGone(serverPid, 20_000);
    check("case 1: killing the launcher stops the server", gone, alive(serverPid) ? `pid ${serverPid} still alive` : "server exited");
    if (alive(serverPid)) {
      try {
        process.kill(serverPid, "SIGKILL");
      } catch {}
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
}

// ── case 2: SIGKILL the launcher's PARENT, everything must die ──────────────
{
  const dataDir = mkdtempSync(join(tmpdir(), "bz-orphan-b-"));
  // A tiny shim plays the role of Electron/harness: it spawns the launcher and
  // then sits there, so we can kill it and watch the clean chain exit.
  const shim = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [${JSON.stringify(LAUNCHER)}], { stdio: "ignore" });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ["-e", shim], {
    cwd: ROOT,
    env: { ...process.env, BZ_RUNTIME: "local", BZ_DATA_DIR: dataDir, BZ_CHAT_KEY: "sk-orphan-probe", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "ignore"],
  });

  const launcherPid = await new Promise((res) => {
    let buf = "";
    parent.stdout.on("data", (d) => {
      buf += String(d);
      const line = buf.split("\n")[0];
      if (/^\d+$/.test((line ?? "").trim())) res(Number(line.trim()));
    });
    setTimeout(() => res(null), 10_000);
  });

  const rt = await waitForRuntime(dataDir);
  check("case 2: runtime came up under a parent", Boolean(rt) && Boolean(launcherPid), rt ? `port ${rt.port}` : "no runtime.json");

  if (rt && launcherPid) {
    const serverPid = rt.pid;
    parent.kill("SIGKILL"); // the harness died — nobody will ever clean up
    const launcherGone = await waitGone(launcherPid, 20_000);
    check("case 2: the launcher exits when its parent dies", launcherGone, alive(launcherPid) ? `launcher ${launcherPid} alive` : "exited");
    const serverGone = await waitGone(serverPid, 25_000);
    check("case 2: the server exits too (no orphan)", serverGone, alive(serverPid) ? `server ${serverPid} alive` : "exited");
    for (const pid of [launcherPid, serverPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\nruntime orphan E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
