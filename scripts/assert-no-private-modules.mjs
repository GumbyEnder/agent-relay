#!/usr/bin/env node
/**
 * Fail the build if the private modules have leaked back into the public tree.
 *
 * The split is only as good as this gate. `src/lib/private/` is populated by
 * `scripts/sync-private.mjs` and gitignored, so the two ways it comes back are:
 *
 *   1. someone force-adds a synced file (`git add -f src/lib/private/…`) — the
 *      code is in history the moment that commit is pushed, and no later commit
 *      removes it;
 *   2. someone pastes a module back into another directory, where nothing
 *      gitignores it.
 *
 * Case 1 is caught by path. Case 2 is caught by the sentinel every module in
 * beezilla-recipes carries (the sentinel comment every private module carries) and by the names of the
 * six files, which have no business existing anywhere but `src/lib/private/`.
 *
 * Run by `prebuild` (after the sync) and safe to run any time: read-only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PRIVATE_FILES = [
  "pipeline.ts",
  "useRecipe.ts",
  "registry.ts",
  "routes.ts",
  "recipes.nitro.ts",
  "deriveRecipe.ts",
];

const problems = [];
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const GITIGNORED = /^(src\/lib\/private\/|scripts\/private\/|\.private\/)/;
for (const f of tracked.filter((p) => GITIGNORED.test(p))) {
  problems.push(`${f} is tracked in git — a synced private module was committed to the public repo`);
}

// Built by concatenation so this file does not match its own scan: the marker
// has to appear in no tracked file, and the guard is a tracked file.
const sentinel = new RegExp("BZ-" + "PRIVATE module:");
for (const f of tracked) {
  if (!/\.(ts|tsx|mjs|cjs|js)$/.test(f)) continue;
  if (f.startsWith(".private-stub/")) continue;
  let body;
  try {
    body = readFileSync(join(ROOT, f), "utf8");
  } catch {
    continue;
  }
  if (sentinel.test(body)) {
    problems.push(`${f} carries the private-module sentinel — the real module was copied into the public tree`);
  }
}

for (const f of tracked) {
  if (f.startsWith(".private-stub/") || !f.startsWith("src/")) continue;
  const base = f.split("/").pop();
  if (!PRIVATE_FILES.includes(base)) continue;
  const expected = `src/lib/private/${base}`;
  if (f !== expected) problems.push(`${f} is one of the private modules but sits outside ${expected}`);
}

// A build with no sync has no marketplace at all — say which build this is.
const manifestPath = join(ROOT, "src/lib/private/.manifest.json");
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  problems.push("src/lib/private/.manifest.json is missing — run scripts/sync-private.mjs");
}
if (manifest) {
  const mode = manifest.mode === "private" ? `private @ ${String(manifest.commit).slice(0, 8)}` : "STUB (no marketplace)";
  console.log(`[guard] recipe modules: ${mode}`);
  if (manifest.mode === "stub" && process.env.BZ_REQUIRE_PRIVATE === "1") {
    problems.push("BZ_REQUIRE_PRIVATE=1 but this tree was built from stubs");
  }
}

if (problems.length > 0) {
  console.error(`[guard] ${problems.length} private-module problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`[guard] ok — no private module is tracked in the public tree (${tracked.length} files scanned)`);
