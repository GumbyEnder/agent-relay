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
 * Case 1 is caught by path. Case 2 is caught by the sentinel comment every module
 * in beezilla-recipes carries, and by the names of the six files, which have no
 * business existing anywhere but `src/lib/private/`.
 *
 * **git is optional.** The Railway build image ships no git binary, and a gate
 * that dies on `spawnSync git ENOENT` turns a leak check into a failed deploy —
 * which is exactly what happened five times before this was written. Without git
 * the scan covers the filesystem, i.e. what the build actually ships; with git it
 * also covers what is tracked.
 *
 * Run by `prebuild` (after the sync) and safe to run any time: read-only.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
const PRIVATE_DIRS = /^(src\/lib\/private|scripts\/private|\.private)(\/|$)/;

const problems = [];

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch {
    return null; // no git in this image — the filesystem scan below still runs
  }
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const tracked = trackedFiles();
if (tracked) {
  for (const f of tracked.filter((p) => PRIVATE_DIRS.test(p))) {
    problems.push(`${f} is tracked in git — a synced private module was committed to the public repo`);
  }
}

// Sentinel scan over the source tree. Filesystem-based on purpose: it covers what
// the build compiles whether or not git is present.
// Built by concatenation so this file does not match its own scan.
const sentinel = new RegExp("BZ-" + "PRIVATE module:");
const scanned = walk(join(ROOT, "src")).concat(walk(join(ROOT, "scripts")));
for (const abs of scanned) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  if (!/\.(ts|tsx|mjs|cjs|js)$/.test(rel)) continue;
  if (rel.startsWith(".private-stub/") || rel.startsWith("scripts/private/") || rel.startsWith("src/lib/private/")) continue;
  let body;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (sentinel.test(body)) {
    problems.push(`${rel} carries the private-module sentinel — the real module was copied into the public tree`);
  }
}

// Name check, restricted to src/ so a legitimate `registry.ts` elsewhere (there is
// one in packages/beezilla-adapter) is not reported as a leak.
if (tracked) {
  for (const f of tracked) {
    if (f.startsWith(".private-stub/") || !f.startsWith("src/")) continue;
    const base = f.split("/").pop();
    if (!PRIVATE_FILES.includes(base)) continue;
    const expected = `src/lib/private/${base}`;
    if (f !== expected) problems.push(`${f} is one of the private modules but sits outside ${expected}`);
  }
}

// Say which build this is, and refuse a stub build where one is not acceptable.
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
  // The synced files must be exactly what the manifest recorded: a module edited
  // in place after the sync is drift nobody notices until a bug.
  const dir = join(ROOT, "src/lib/private");
  for (const [name, digest] of Object.entries(manifest.files ?? {})) {
    const abs = join(dir, name);
    if (!existsSync(abs)) {
      problems.push(`src/lib/private/${name} is in the manifest but missing from the tree`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (actual !== digest) problems.push(`src/lib/private/${name} does not match the manifest (edited after sync?)`);
  }
}

if (problems.length > 0) {
  console.error(`[guard] ${problems.length} private-module problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `[guard] ok — no private module in the public tree (${scanned.length} source files scanned${
    tracked ? `, ${tracked.length} tracked` : ", no git in this image"
  })`,
);
