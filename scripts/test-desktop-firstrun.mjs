#!/usr/bin/env node
/**
 * E2E: first run with nothing configured.
 *
 * A brand-new install has no key, so every message gets the "I can't connect"
 * refusal. Handing a non-technical user a window that cannot do anything is how a
 * desktop app feels broken on day one — so a first run with no inference opens
 * Settings instead.
 *
 * Two launches, because the interesting assertion is the negative one:
 *   1. empty data dir        -> onboarding fires, Settings window opens
 *   2. seeded inference.json -> no onboarding (a configured user is not nagged)
 *
 * Run: node scripts/test-desktop-firstrun.mjs   (SKIPs without xvfb-run)
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveInference } from "./lib/inference.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const hasXvfb = (() => {
  try {
    execFileSync("which", ["xvfb-run"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!hasXvfb) {
  check("first run opens Settings", true, "SKIP — xvfb-run not installed");
  process.exit(0);
}

const electron = join(ROOT, "desktop", "node_modules", ".bin", "electron");

const launch = (dataDir) =>
  new Promise((res) => {
    execFile(
      "xvfb-run",
      ["-a", "--server-args=-screen 0 1280x800x24", electron, "desktop", "--no-sandbox", "--disable-gpu"],
      {
        cwd: ROOT,
        timeout: 150_000,
        env: {
          ...process.env,
          BZ_FIRSTRUN_TEST: "1",
          BZ_DATA_DIR: dataDir,
          BZ_RUNTIME: "local",
          BZ_CHAT_KEY: "",
          BZ_CHAT_BASE_URL: "",
          BZ_CHAT_MODEL: "",
        },
      },
      (err, stdout, stderr) => res(String(stdout) + String(stderr)),
    );
  });

// ── 1. empty install ────────────────────────────────────────────────────────
const freshDir = mkdtempSync(join(tmpdir(), "bz-firstrun-"));
const firstOut = await launch(freshDir);
const noWindowHint = " (no onboarding log — is another BeeZilla/Electron instance holding the single-instance lock?)";
check("a fresh install reports no inference", /onboarding: no inference configured/.test(firstOut), firstOut.includes("onboarding") ? "logged" : noWindowHint);
check("a fresh install opens the Settings window", /settings window opened .*\/buzzy\/settings\.html/.test(firstOut));
check("the chat window still loads under it", /loadURL resolved/.test(firstOut));
rmSync(freshDir, { recursive: true, force: true });

// ── 2. configured install is left alone ─────────────────────────────────────
const configuredDir = mkdtempSync(join(tmpdir(), "bz-firstrun-ok-"));
saveInference(configuredDir, { provider: "byok", key: "sk-configured-probe-123456", baseUrl: "https://example.test/v1", model: "" });
const secondOut = await launch(configuredDir);
check("a configured install does not open onboarding", !/onboarding: no inference/.test(secondOut), secondOut.includes("onboarding") ? "still onboarded" : "clean start");
check("a configured install does not open Settings", !/settings window opened/.test(secondOut));
rmSync(configuredDir, { recursive: true, force: true });

console.log(`\nfirst-run E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
