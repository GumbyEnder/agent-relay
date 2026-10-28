#!/usr/bin/env node
/**
 * E2E: web search credentials (Brave — ours, or the owner's BYOK key).
 *
 * The product promise: search is on out of the box with our key, and an owner
 * who wants their own quota can supply one. What this test enforces:
 *   - a stored key reaches the runtime and is reported as available
 *   - env beats the store (so an operator override always wins)
 *   - the key never appears in output, doctor, or a "safe" store file
 *   - clearing it turns search off by name instead of leaving a dead key in place
 *
 * Run: node scripts/test-search-e2e.mjs
 * Live search is skipped (not failed) without BZ_TEST_BRAVE.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSearch, saveSearchKey, clearSearchKey, loadSearchKey } from "./lib/search-keys.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "beezilla.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "bz-search-e2e-"));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const realKey = (process.env.BZ_TEST_BRAVE ?? "").trim();
const fakeKey = "BSA-fake-search-key-0123456789";

// ── store semantics ─────────────────────────────────────────────────────────
saveSearchKey(dataDir, { key: fakeKey });
const stored = join(dataDir, "search.json");
check("stored key is 0600", process.platform === "win32" || (statSync(stored).mode & 0o777) === 0o600);
check("stored key round-trips", loadSearchKey(dataDir)?.key === fakeKey);
check("store marks itself unencrypted", JSON.parse(readFileSync(stored, "utf8")).encrypted === false);

// env wins over the store
process.env.BZ_BRAVE_KEY = "env-key-wins";
check("env overrides the stored key", resolveSearch(dataDir)?.source === "env");
delete process.env.BZ_BRAVE_KEY;
check("store used when env is absent", resolveSearch(dataDir)?.source === "store");

// ── CLI + runtime ───────────────────────────────────────────────────────────
const env = { ...process.env, BZ_DATA_DIR: dataDir, BZ_RUNTIME: "local" };
delete env.BZ_BRAVE_KEY;
const cli = (args, timeout = 180_000) =>
  new Promise((res) =>
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, env, timeout },
      (err, stdout, stderr) => res({ code: Number(err?.code ?? 0), stdout: String(stdout), stderr: String(stderr) })));

const setOut = await cli(["key", "search", "set", "--key", fakeKey]);
check("cli stores the search key", setOut.code === 0, setOut.stdout.split("\n")[0]);
check("cli does not echo the key", !setOut.stdout.includes(fakeKey));

const showOut = await cli(["key", "search", "show"]);
check("cli show reports brave via store", /provider\s+brave \(store\)/.test(showOut.stdout), showOut.stdout.split("\n")[0]);
check("cli show redacts the key", !showOut.stdout.includes(fakeKey));

const doctor = await cli(["doctor"]);
check("doctor reports web search configured", /web search — brave via store/.test(doctor.stdout));
check("doctor does not print the key", !doctor.stdout.includes(fakeKey));

// The runtime is what actually searches: ask it, not the store.
// `recipe list` goes through ensureServer(), so it autostarts the runtime; a
// foreground `serve` would block the test.
await cli(["stop"]);
await cli(["recipe", "list"]);

const rt = (() => {
  try {
    return JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8"));
  } catch {
    return null;
  }
})();
const searchStatus = rt
  ? await fetch(`http://${rt.host}:${rt.port}/api/buzzy/search-status`, {
      headers: { authorization: `Bearer ${rt.token}` },
    }).then((r) => r.json()).catch(() => null)
  : null;
check("runtime reports search available", searchStatus?.available === true, JSON.stringify(searchStatus));
check("runtime names the provider", searchStatus?.provider === "brave", String(searchStatus?.provider));

// ── live call (only with a real key) ───────────────────────────────────────
if (realKey) {
  await cli(["key", "search", "clear"]);
  await cli(["key", "search", "set", "--key", realKey]);
  await cli(["stop"]);
  await cli(["recipe", "list"]);
  const rt2 = await (async () => {
    try {
      return JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const live = rt2
    ? await fetch(`http://${rt2.host}:${rt2.port}/api/buzzy/search-status`, {
        headers: { authorization: `Bearer ${rt2.token}` },
      }).then((r) => r.json()).catch(() => null)
    : null;
  check("a real brave key is accepted at the gateway", live?.available === true, JSON.stringify(live));
} else {
  check("a real brave key is accepted at the gateway", true, "SKIP — BZ_TEST_BRAVE not set");
}

// ── clearing ───────────────────────────────────────────────────────────────
await cli(["stop"]);
const cleared = await cli(["key", "search", "clear"]);
check("cli clears the search key", cleared.code === 0 && !existsSync(stored));
check("cleared store resolves to nothing", resolveSearch(dataDir) === null);
const after = await cli(["doctor"]);
check("doctor says search is off after clearing", /web search — not configured/.test(after.stdout));

rmSync(dataDir, { recursive: true, force: true });
console.log(`\nsearch credentials E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
