#!/usr/bin/env node
/**
 * E2E: the `beezilla` CLI against a REAL local runtime (S4).
 *
 * Proves the CLI is a real client of the same runtime the window will use —
 * not a second implementation: autostart, doctor, a genuine model turn through
 * the extracted orchestrator, export, and graceful stop.
 *
 * Run:
 *   BZ_CHAT_KEY=… BZ_CHAT_BASE_URL=… BZ_CHAT_MODEL=… node scripts/test-cli-e2e.mjs
 * The model check SKIPs (and does not fail) when no key is present.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "beezilla.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "bz-cli-e2e-"));
const env = { ...process.env, BZ_DATA_DIR: dataDir, BZ_RUNTIME: "local" };

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function cli(args, timeout = 180_000) {
  return new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, env, timeout }, (err, stdout, stderr) => {
      res({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// 1. doctor diagnoses a clean install
const doctor = await cli(["doctor"]);
check("doctor passes preflight", doctor.code === 0, doctor.stdout.split("\n")[0]);
check("doctor reports pglite assets", /PASS {2}pglite assets/.test(doctor.stdout));
check(
  "doctor refuses inference by name when unset",
  /inference configured/.test(doctor.stdout),
  (doctor.stdout.match(/inference configured.*/) ?? [""])[0].slice(0, 80),
);

// 2. run autostarts the runtime and completes a real turn
const hasKey = Boolean((process.env.BZ_CHAT_KEY ?? "").trim());
const run = await cli(["run", "In one short sentence, what are you?"]);
if (hasKey) {
  check("run completes a real model turn", run.code === 0 && run.stdout.trim().length > 10, run.stdout.trim().slice(0, 90));
} else {
  check("run refuses by name without a key", run.code !== 0, run.stderr.trim().slice(0, 90));
}

// 3. status sees the autostarted runtime
const status = await cli(["status"]);
check("status reports the running runtime", /running/.test(status.stdout), status.stdout.split("\n")[0]);
check("runtime.json carries a token", Boolean(JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8")).token));

// 4. export is a real, complete archive (ZIP — not JSON text)
const out = join(dataDir, "export.zip");
const exp = await cli(["export", out]);
const head = existsSync(out) ? readFileSync(out).subarray(0, 2).toString("latin1") : "";
check("export writes a ZIP archive", exp.code === 0 && head === "PK", `magic=${head || "none"}`);

// 5. stop is graceful and removes the handshake file
const stop = await cli(["stop"]);
check("stop shuts the runtime down", stop.code === 0 && /stopped/.test(stop.stdout), stop.stdout.trim());
await new Promise((r) => setTimeout(r, 1200));
check("runtime.json removed after stop", !existsSync(join(dataDir, "runtime.json")));

const after = await cli(["status"]);
check("status reports not running", /not running/.test(after.stdout), after.stdout.trim());

rmSync(dataDir, { recursive: true, force: true });
console.log(`\nCLI E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
