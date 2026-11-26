/**
 * Put PGlite's data + wasm files next to its bundle, so `npm run build` alone
 * produces a tree a local production boot can start.
 *
 * The trap this closes, reproduced 2026-11-26 off faefaff:
 *
 *   NODE_ENV=production npm run build      # exits 0
 *   node .output/server/index.mjs          # boots, /buzzy/talk answers 200
 *   -> [unhandledRejection] Error: ENOENT: no such file or directory, open
 *      '.../.output/server/_libs/pglite.data'
 *
 * `vite.config.ts` externalises `@electric-sql/pglite` (nitro `externals`), so
 * nitro copies the JS into `.output/server/_libs/electric-sql__pglite.mjs` and
 * stops there. PGlite loads pglite.data / pglite.wasm / initdb.wasm relative to
 * its own module URL, i.e. from `_libs/`. Without them the server still listens
 * — the failure is an unhandled rejection per DB call, so it looks like "sign-in
 * is broken" instead of "the build is incomplete". The manual `cp` in
 * docs/beezilla/LOCAL-TESTING.md was the only thing papering over it.
 *
 * The runner image does not carry dev dependencies (`npm ci --omit=dev`), so the
 * copy has to happen at build time, not at boot.
 *
 * Copies only when the bundle is actually there; a build with no PGlite bundle
 * (or no `.output`) is a no-op, not an error. Every copy is verified by sha256
 * against the source, because a truncated wasm file fails at query time.
 *
 * Usage:
 *   node scripts/copy-pglite-assets.mjs [--libs <dir>] [--quiet]
 *   BZ_PGLITE_LIBS=<dir> node scripts/copy-pglite-assets.mjs
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS = ["pglite.data", "pglite.wasm", "initdb.wasm"];

const argv = process.argv.slice(2);
const quiet = argv.includes("--quiet");
const libsFlag = argv.indexOf("--libs");
const root = resolve(import.meta.dirname, "..");
const libsDir = resolve(
  (libsFlag >= 0 && argv[libsFlag + 1]) || process.env.BZ_PGLITE_LIBS || resolve(root, ".output/server/_libs"),
);
const srcDir = resolve(root, "node_modules/@electric-sql/pglite/dist");

const say = (msg) => {
  if (!quiet) console.log(`[pglite-assets] ${msg}`);
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

if (!existsSync(libsDir)) {
  say(`no build output at ${libsDir} — nothing to do`);
  process.exit(0);
}

const hasBundle = readdirSync(libsDir).some((f) => /pglite/i.test(f) && f.endsWith(".mjs"));
if (!hasBundle) {
  say(`no PGlite bundle in ${libsDir} — nothing to do`);
  process.exit(0);
}

for (const name of ASSETS) {
  const src = resolve(srcDir, name);
  const dest = resolve(libsDir, name);
  if (!existsSync(src)) {
    console.error(
      `[pglite-assets] FAIL ${name} missing from ${srcDir} — ` +
        "is @electric-sql/pglite installed? A build without these is not bootable locally.",
    );
    process.exit(1);
  }
  const srcHash = sha256(src);
  if (existsSync(dest) && sha256(dest) === srcHash) {
    say(`${name} already correct (${statSync(dest).size}B)`);
    continue;
  }
  copyFileSync(src, dest);
  const destHash = sha256(dest);
  if (destHash !== srcHash) {
    console.error(`[pglite-assets] FAIL ${name} copied but hashes differ (${srcHash} vs ${destHash})`);
    process.exit(1);
  }
  say(`${name} -> ${dest.replace(root + "/", "")} (${statSync(dest).size}B, sha256 ${destHash.slice(0, 12)})`);
}
say("done — a production boot without DATABASE_URL can open PGlite");
