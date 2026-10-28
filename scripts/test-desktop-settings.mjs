#!/usr/bin/env node
/**
 * E2E: the settings bridge — how a non-technical user enters a key.
 *
 * Two layers, because they fail differently:
 *   1. handler contract (no display): save -> status -> clear -> status, with a
 *      fake supervisor proving the runtime is restarted, not merely reconfigured.
 *   2. the real bridge in a real sandboxed renderer: a Electron window whose
 *      preload exposes `window.beezilla` and whose page round-trips a credential.
 *      This is the part that broke before with fetch patching, so it is tested
 *      in the same conditions (sandbox: true, contextIsolation: true).
 *
 * Run: node scripts/test-desktop-settings.mjs
 * The Electron layer is skipped (not failed) if no display/xvfb is available.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSettingsHandlers } from "../desktop/settings.mjs";
import { resolveInference } from "./lib/inference.mjs";
import { resolveSearch } from "./lib/search-keys.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "bz-settings-e2e-"));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── 1. handler contract ─────────────────────────────────────────────────────
const calls = { start: 0, stop: 0 };
const fakeSupervisor = {
  isHealthy: async () => true,
  stop: async () => {
    calls.stop++;
  },
  start: async () => {
    calls.start++;
    return { port: 7399 };
  },
};

const handlers = createSettingsHandlers({ dataDir: () => dataDir, supervisor: fakeSupervisor });

check("initial status reports nothing configured", (await handlers.status()).inference === null);

const savedInference = await handlers.saveInference({ provider: "byok", key: "sk-bridge-probe-1234567890" });
check("saving inference restarts the runtime", savedInference.restarted === true && calls.start === 1, `start=${calls.start}`);
check("saving inference reports the provider", savedInference.status.inference?.provider === "byok");
check("status redacts the key", !JSON.stringify(savedInference.status).includes("sk-bridge-probe-1234567890"));

const savedSearch = await handlers.saveSearch({ key: "BSA-bridge-probe-key" });
check("saving search restarts the runtime", savedSearch.restarted === true && calls.start === 2);
check("search resolves from the store", resolveSearch(dataDir)?.source === "store");

// A supervisor that fails must not be reported as success.
const brokenHandlers = createSettingsHandlers({
  dataDir: () => dataDir,
  supervisor: {
    isHealthy: async () => true,
    stop: async () => {
      throw new Error("port still busy");
    },
    start: async () => ({ port: 7400 }),
  },
});
const broken = await brokenHandlers.saveSearch({ key: "BSA-bridge-probe-key-2" });
check("a failed restart is reported, not swallowed", broken.restarted === false && /port still busy/.test(broken.reason ?? ""), broken.reason);

// Refusals are by name.
let threw = "";
try {
  await handlers.saveInference({ provider: "byok", key: "   " });
} catch (err) {
  threw = err.message;
}
check("an empty key refuses by name", /key is required/.test(threw), threw);

const cleared = await handlers.clear("search");
check("clearing search removes it", cleared.status.search === null && resolveSearch(dataDir) === null);
check("clearing inference removes it", (await handlers.clear("inference")).status.inference === null && resolveInference(dataDir) === null);

// ── 2. real bridge in a sandboxed renderer ──────────────────────────────────
const hasXvfb = (() => {
  try {
    execFileSync("which", ["xvfb-run"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!hasXvfb) {
  check("bridge works inside a sandboxed renderer", true, "SKIP — xvfb-run not installed");
} else {
  const probeDir = mkdtempSync(join(tmpdir(), "bz-settings-probe-"));
  const electron = join(ROOT, "desktop", "node_modules", ".bin", "electron");
  const run = () =>
    new Promise((res) => {
      execFile(
        "xvfb-run",
        ["-a", "--server-args=-screen 0 1280x800x24", electron, "desktop", "--no-sandbox", "--disable-gpu"],
        {
          cwd: ROOT,
          timeout: 120_000,
          env: { ...process.env, BZ_SETTINGS_TEST: "1", BZ_DATA_DIR: probeDir, BZ_RUNTIME: "local" },
        },
        (err, stdout, stderr) => res({ code: Number(err?.code ?? 0), out: String(stdout) + String(stderr) }),
      );
    });

  const result = await run();
  const line = result.out.split("\n").find((l) => l.includes("SETTINGS_RESULT:"));
  let parsed = null;
  if (line) {
    try {
      parsed = JSON.parse(line.slice(line.indexOf("SETTINGS_RESULT:") + "SETTINGS_RESULT:".length));
    } catch {
      parsed = null;
    }
  }
  check("the renderer can reach the bridge", Boolean(parsed), line?.slice(0, 120) ?? "no SETTINGS_RESULT line");
  check("the bridge reports state", parsed?.ok === true, JSON.stringify(parsed?.before ?? null));
  check("the bridge saves a credential", parsed?.saveOk === true && parsed?.searchAfterSave?.provider === "brave");
  check("the bridge clears a credential", parsed?.clearOk === true && parsed?.searchAfterClear === null);
  check("the bridge exposes the app version", typeof parsed?.version === "string", String(parsed?.version));
  rmSync(probeDir, { recursive: true, force: true });
}

// ── 3. the whole chain: save a key -> restart -> a real answer ─────────────
// The product promise is not "the key is stored", it is "the user gets answers".
// This runs the real supervisor against the real runtime and a real model call.
const testKey = (process.env.BZ_TEST_KEY ?? "").trim();
if (!testKey) {
  check("saving a key through the bridge produces real answers", true, "SKIP — BZ_TEST_KEY not set");
} else {
  const { RuntimeSupervisor } = await import("../desktop/supervisor.mjs");
  const chainDir = mkdtempSync(join(tmpdir(), "bz-chain-"));
  const supervisor = new RuntimeSupervisor({ root: ROOT, dataDir: chainDir });
  const chain = createSettingsHandlers({ dataDir: () => chainDir, supervisor });

  const t0 = Date.now();
  const saved = await chain.saveInference({
    provider: "byok",
    key: testKey,
    baseUrl: "https://inference-api.nousresearch.com/v1",
    model: "z-ai/glm-5.3-flash",
  });
  check("the bridge started a stopped runtime", saved.started === true, `started=${saved.started}`);

  const rt = JSON.parse(readFileSync(join(chainDir, "runtime.json"), "utf8"));
  const reply = await fetch(`http://${rt.host}:${rt.port}/api/buzzy/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${rt.token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: "In one short sentence: what are you?", fresh: true }),
  })
    .then((r) => r.json())
    .catch((err) => ({ ok: false, error: String(err) }));

  const text = typeof reply?.reply === "string" ? reply.reply : "";
  check("the runtime answers after the bridge saved a key", reply?.ok !== false && text.length > 10, `${Math.round((Date.now() - t0) / 1000)}s`);
  check("the answer is not the connection-failure copy", !/trouble connecting|could not reach/i.test(text), text.slice(0, 90));

  await supervisor.stop();
  rmSync(chainDir, { recursive: true, force: true });
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\ndesktop settings E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
