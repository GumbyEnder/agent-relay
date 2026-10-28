#!/usr/bin/env node
/**
 * Local-runtime regression lane.
 *
 * The cloud suites (run-beezilla-suites) prove the hosted product still works;
 * this proves the desktop/CLI lane does. Run both before a release: they cover
 * different servers, and a change like the get-session branch touches both.
 *
 * Run: node scripts/run-local-suites.mjs
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LADDER = [
  { name: "local runtime", cmd: "node", args: ["scripts/test-local-e2e.mjs"] },
  { name: "cli", cmd: "node", args: ["scripts/test-cli-e2e.mjs"] },
  { name: "runtime orphans", cmd: "node", args: ["scripts/test-runtime-orphans.mjs"] },
  { name: "desktop supervisor", cmd: "node", args: ["scripts/test-desktop-supervisor.mjs"] },
  { name: "desktop settings bridge", cmd: "node", args: ["scripts/test-desktop-settings.mjs"] },
  { name: "desktop settings screen", cmd: "node", args: ["scripts/test-desktop-settings-ui.mjs"] },
  { name: "desktop first run", cmd: "node", args: ["scripts/test-desktop-firstrun.mjs"] },
  { name: "desktop connect", cmd: "node", args: ["scripts/test-desktop-connect.mjs"] },
  { name: "inference credentials", cmd: "node", args: ["scripts/test-inference-e2e.mjs"] },
  { name: "managed expiry", cmd: "node", args: ["scripts/test-managed-expiry.mjs"] },
  { name: "search credentials", cmd: "node", args: ["scripts/test-search-e2e.mjs"] },
  { name: "search live", cmd: "node", args: ["scripts/test-search-live.mjs"] },
  { name: "search managed", cmd: "node", args: ["scripts/test-search-managed.mjs"] },
  { name: "search reconnect", cmd: "node", args: ["scripts/test-search-reconnect.mjs"] },
  { name: "recipe trust + cache", cmd: "npx", args: ["tsx", "scripts/test-recipe-trust.ts"] },
  { name: "recipe catalog", cmd: "npx", args: ["tsx", "scripts/test-recipe-catalog.ts"] },
  { name: "local recipe API", cmd: "npx", args: ["tsx", "scripts/test-recipe-local-api.ts"] },
];

const only = process.argv.slice(2).map((s) => s.toLowerCase());
const results = [];

for (const step of LADDER) {
  if (only.length > 0 && !only.some((o) => step.name.toLowerCase().includes(o))) continue;
  const started = Date.now();
  process.stdout.write(`\n=== ${step.name} ===\n`);
  try {
    execFileSync(step.cmd, step.args, { cwd: ROOT, stdio: "inherit", timeout: 600_000 });
    results.push({ name: step.name, ok: true, ms: Date.now() - started });
  } catch (err) {
    results.push({ name: step.name, ok: false, ms: Date.now() - started, detail: err instanceof Error ? err.message : String(err) });
  }
}

console.log("\n── summary ─────────────────────────────────────────────");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : ` — ${r.detail ?? "failed"}`}  (${Math.round(r.ms / 1000)}s)`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nRESULT: ${failed === 0 ? "LOCAL LANE PASSED" : `${failed} SUITE(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
