/**
 * The local production boot must not need a manual copy.
 *
 * Reproduced off faefaff in a clean worktree (2026-11-26): `npm run build` exits 0,
 * `node .output/server/index.mjs` boots and answers /buzzy/talk 200, and then every
 * DB call dies with
 *   ENOENT: .../.output/server/_libs/pglite.data
 * because nitro externalises @electric-sql/pglite and emits only its JS. The only
 * thing that ever made a local boot work was a `cp` line in
 * docs/beezilla/LOCAL-TESTING.md — a step a person has to remember, in a doc, with
 * a failure that looks like a broken sign-in.
 *
 * This test holds the fix at both ends:
 *   - the copy script actually lands the three files, byte-identical, and is a
 *     no-op when there is no PGlite bundle to sit next to;
 *   - the build runs it (package.json postbuild) and the manual step is gone from
 *     the doc that taught it.
 * If a real `.output` exists here, it also asserts the build left the files in
 * place — that catches "postbuild never ran" in CI, where the build runs first.
 *
 * Hermetic apart from a temp dir and the repo's own node_modules.
 *   npx tsx scripts/test-pglite-assets.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let pass = 0;
let fail = 0;
const check = (cond: boolean, name: string, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/copy-pglite-assets.mjs");
const srcDir = resolve(root, "node_modules/@electric-sql/pglite/dist");
const ASSETS = ["pglite.data", "pglite.wasm", "initdb.wasm"];
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

check(existsSync(script), "scripts/copy-pglite-assets.mjs exists");

// ── it lands the files, byte for byte ─────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "bz-pglite-assets-"));
const libs = join(tmp, "_libs");
mkdirSync(libs, { recursive: true });
writeFileSync(join(libs, "electric-sql__pglite.mjs"), "// fake bundle: the copy only cares that one is here\n");

const out = execFileSync(process.execPath, [script, "--libs", libs], { encoding: "utf8" });
check(out.includes("done"), "the script reports done", out.trim().slice(-120));

for (const name of ASSETS) {
  const dest = join(libs, name);
  check(existsSync(dest), `${name} landed in the libs dir`);
  check(existsSync(dest) && sha(dest) === sha(resolve(srcDir, name)), `${name} is byte-identical to the installed package`);
}

// ── a second build must not care ──────────────────────────────────────────
const before = sha(join(libs, "pglite.data"));
const again = execFileSync(process.execPath, [script, "--libs", libs], { encoding: "utf8" });
check(again.includes("already correct"), "a second run is a no-op, not a rewrite");
check(sha(join(libs, "pglite.data")) === before, "the file is unchanged after the second run");

// ── no bundle, no complaint ───────────────────────────────────────────────
const empty = join(tmp, "empty_libs");
mkdirSync(empty, { recursive: true });
const quietOut = execFileSync(process.execPath, [script, "--libs", empty], { encoding: "utf8" });
check(quietOut.includes("nothing to do"), "a build with no PGlite bundle is a no-op");
check(readdirSync(empty).length === 0, "nothing is copied when there is no bundle",
  readdirSync(empty).join(",") || "empty");

// ── the build runs it ─────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
check(
  (pkg.scripts.postbuild ?? "").includes("copy-pglite-assets.mjs"),
  "postbuild runs the copy, so `npm run build` alone produces a bootable tree",
  pkg.scripts.postbuild ?? "(no postbuild)",
);
check(
  (pkg.scripts["test:ci"] ?? "").includes("test-pglite-assets.ts"),
  "test:ci runs this test",
);

// ── the manual step is gone from the doc that taught it ───────────────────
const doc = readFileSync(resolve(root, "docs/beezilla/LOCAL-TESTING.md"), "utf8");
check(
  !/cp\s+node_modules\/@electric-sql\/pglite\/dist/.test(doc),
  "LOCAL-TESTING.md no longer tells a person to cp the PGlite files by hand",
);
check(
  /copy-pglite-assets|build (copies|lands|places)/i.test(doc),
  "LOCAL-TESTING.md says the build lands them",
);

// ── a real build in this worktree is bootable ─────────────────────────────
const realLibs = resolve(root, ".output/server/_libs");
const hasRealBundle =
  existsSync(realLibs) && readdirSync(realLibs).some((f) => /pglite/i.test(f) && f.endsWith(".mjs"));
if (hasRealBundle) {
  for (const name of ASSETS) {
    check(existsSync(join(realLibs, name)), `this build left ${name} next to the bundle`);
  }
} else {
  console.log("  skip no .output PGlite bundle in this worktree (run npm run build to check that end)");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
