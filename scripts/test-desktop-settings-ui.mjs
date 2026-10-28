#!/usr/bin/env node
/**
 * E2E: the settings SCREEN, driven the way a person drives it.
 *
 * The bridge test proves IPC works. This proves there is a product: the real
 * page renders, the radio switches, a key can be pasted and saved, the status
 * line reports it, and the "now configured" line updates — in a real window.
 *
 * Run: node scripts/test-desktop-settings-ui.mjs
 * Skips (does not fail) without xvfb-run.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  check("settings screen renders and saves", true, "SKIP — xvfb-run not installed");
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "bz-settings-ui-"));
const electron = join(ROOT, "desktop", "node_modules", ".bin", "electron");

const out = await new Promise((res) => {
  execFile(
    "xvfb-run",
    ["-a", "--server-args=-screen 0 1400x900x24", electron, "desktop", "--no-sandbox", "--disable-gpu"],
    {
      cwd: ROOT,
      timeout: 180_000,
      env: {
        ...process.env,
        BZ_SETTINGS_TEST: "1",
        BZ_PROBE_PATH: "/buzzy/settings.html",
        BZ_SETTINGS_DRIVE: "1",
        BZ_DATA_DIR: dataDir,
        BZ_RUNTIME: "local",
        BZ_CHAT_KEY: "",
      },
    },
    (err, stdout, stderr) => res({ code: Number(err?.code ?? 0), out: String(stdout) + String(stderr) }),
  );
});

const line = out.out.split("\n").find((l) => l.includes("SETTINGS_DRIVE_RESULT:"));
let parsed = null;
if (line) {
  try {
    parsed = JSON.parse(line.slice(line.indexOf("SETTINGS_DRIVE_RESULT:") + "SETTINGS_DRIVE_RESULT:".length));
  } catch {
    parsed = null;
  }
}

check("the settings page loads in the window", Boolean(parsed), line ? line.slice(0, 140) : "no result line — page did not load (is another BeeZilla/Electron instance holding the single-instance lock?)");
check("the page finds the preload bridge", parsed?.hasBridge === true, String(parsed?.hasBridge));
check("the form is present", parsed?.formPresent === true, String(parsed?.formPresent));
check("controls are enabled", parsed?.buttonsEnabled === true, String(parsed?.buttonsEnabled));
check("choosing 'my own key' reveals the key field", parsed?.byokFieldsShown === true, String(parsed?.byokFieldsShown));
check(
  "the empty-state copy matches the selected option",
  /paste your key/i.test(parsed?.emptyNote ?? "") && !/will refuse/i.test(parsed?.emptyNote ?? ""),
  parsed?.emptyNote ?? "(empty)",
);
check("Remove key is disabled while nothing is configured", parsed?.clearDisabledWhenEmpty === true, String(parsed?.clearDisabledWhenEmpty));
check("saving reports success in the UI", /Saved/i.test(parsed?.statusText ?? ""), parsed?.statusText ?? "(empty)");
check("the form reflects the saved key", /your own key/i.test(parsed?.currentText ?? ""), (parsed?.currentText ?? "").slice(0, 100));
check("the UI never shows the key itself", !/sk-drive-probe/.test(JSON.stringify(parsed ?? {})), "checked status + current lines");

rmSync(dataDir, { recursive: true, force: true });
console.log(`\nsettings screen E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
