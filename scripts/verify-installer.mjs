#!/usr/bin/env node
/**
 * Verify a built Windows installer — the checks that were being done by hand.
 *
 * Building an installer successfully says nothing about what is inside it. Every
 * failure below has actually shipped at some point in this project's history:
 *
 *   - a stage missing `settings.mjs`/`connect.mjs` → window with no bridge
 *   - a stage with no `migrations/` → app starts, listens, 500s every DB route
 *   - a stale `.output` → packaged app runs pre-change server code
 *   - zero publisher pins → every fetched recipe is untrusted
 *
 * Run: node scripts/verify-installer.mjs [--allow-zero-pins]
 * Requires a previous `node desktop/dist.mjs all` (or `stage`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-desktop");
const UNPACKED = join(OUT, "win-unpacked", "resources");
const ASAR = join(UNPACKED, "app.asar");
const APP = join(UNPACKED, "app");

const allowZeroPins = process.argv.includes("--allow-zero-pins");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(OUT)) {
  console.error("no dist-desktop/ — run: node desktop/dist.mjs all");
  process.exit(2);
}

// ── the installer itself ────────────────────────────────────────────────────
const exe = readdirSync(OUT).find((f) => f.toLowerCase().endsWith(".exe"));
check("an installer was produced", Boolean(exe), exe ?? "none");
if (exe) {
  const size = statSync(join(OUT, exe)).size;
  check("the installer is not a stub", size > 50 * 1024 * 1024, `${(size / 1024 / 1024).toFixed(0)} MB`);
  const kind = execFileSync("file", ["-b", join(OUT, exe)], { encoding: "utf8" }).trim();
  check("the installer is a PE executable", /PE32/.test(kind), kind.slice(0, 60));
}

// ── the app shell inside the asar ───────────────────────────────────────────
if (!existsSync(ASAR)) {
  check("app.asar exists", false, "missing");
} else {
  const listing = execFileSync("npx", ["asar", "list", ASAR], { encoding: "utf8", cwd: ROOT });
  for (const file of ["main.mjs", "preload.cjs", "settings.mjs", "supervisor.mjs", "connect.mjs"]) {
    check(`the shell ships ${file}`, listing.split("\n").includes(`/${file}`), file);
  }
  // The connect flow is the only thing that can obtain OUR credentials, so a stage
  // that ships it without the search half would silently ship BYOK-only behaviour.
  // asar stores file bodies uncompressed, so the bytes of connect.mjs are searchable
  // in the archive itself — no extraction, no temp files, no cwd surprises.
  try {
    const archive = readFileSync(ASAR, "latin1");
    check("the connect flow also asks for a search token", archive.includes("api/search-token"));
    // s9g: without a baked default the Connect item is dead on every real install.
    check("the app knows the BeeZilla address without env", /https:\/\/beezilla[a-z0-9.-]*\.(railway\.app|beezilla\.ai)/.test(archive));
    // These two live OUTSIDE app.asar (scripts/ and .output/ are staged as real files
    // in resources/app), so searching the archive finds nothing and lies about a good
    // build — the same mistake as the earlier PGLite check.
    const launcherText = existsSync(join(APP, "scripts", "beezilla-local.mjs"))
      ? readFileSync(join(APP, "scripts", "beezilla-local.mjs"), "utf8")
      : "";
    const serverText = existsSync(join(APP, ".output", "server", "index.mjs"))
      ? readFileSync(join(APP, ".output", "server", "index.mjs"), "utf8")
      : "";
    // s9i: the shipped shell must degrade honestly when our cloud is unreachable.
    check("the app says so when BeeZilla is unreachable", archive.includes("could not reach BeeZilla at"));
    // s9f: the shipped launcher must be able to say "expired", not "off".
    check("the launcher can distinguish an expired session", launcherText.includes("BZ_SEARCH_EXPIRED"));
    check("the runtime API reports needsReconnect", serverText.includes("needsReconnect"));
  } catch (err) {
    check("the connect flow also asks for a search token", false, `could not read the asar: ${err instanceof Error ? err.message : err}`);
  }
}

// ── the runtime tree inside the asar's extraResources ───────────────────────
if (!existsSync(APP)) {
  check("the runtime tree exists (resources/app)", false, "missing");
} else {
  const server = join(APP, ".output", "server", "index.mjs");
  check("the server bundle exists", existsSync(server));

  if (existsSync(server)) {
    const code = readFileSync(server, "utf8");
    check("the server bundle is this build (not a stale .output)", code.length > 500_000, `${Math.round(code.length / 1024)} KB`);
    // Feature markers: each one is a route the packaged app must actually contain.
    check("the recipe catalog client is present", code.includes("BZ_CATALOG_URL"));
    check("managed search routing is present", code.includes("BZ_SEARCH_GATEWAY_URL"));
    check("the managed-expiry refusal is present", code.includes("BZ_MANAGED_EXPIRED"));
  }

  const migrations = join(APP, "migrations");
  const sql = existsSync(migrations) ? readdirSync(migrations).filter((f) => f.endsWith(".sql")).length : 0;
  check("migrations are staged", sql > 0, `${sql} .sql file(s)`);

  // PGLite's data/wasm files are restored into .output/server/_libs by the launcher
  // at boot, from the package that ships them. Either location is correct; what
  // matters is that the bytes are present somewhere the launcher can find them.
  const libs = join(APP, ".output", "server", "_libs");
  const pkgDist = join(APP, "node_modules", "@electric-sql", "pglite", "dist");
  const assets = ["pglite.data", "pglite.wasm", "initdb.wasm"].filter(
    (f) => existsSync(join(libs, f)) || existsSync(join(pkgDist, f)),
  );
  check("PGLite assets are available to the launcher", assets.length === 3, `${assets.length}/3`);
  check(
    "the launcher restores them at boot",
    readFileSync(join(APP, "scripts", "beezilla-local.mjs"), "utf8").includes("ensurePgliteAssets"),
  );

  const settingsPage = join(APP, "public", "buzzy", "settings.html");
  const page = existsSync(settingsPage) ? readFileSync(settingsPage, "utf8") : "";
  check("the settings page is staged", page.length > 5000, `${page.length} bytes`);
  check("the settings page can connect an account", page.includes("connect-account"));

  const pinsFile = join(APP, "publishers.json");
  let pins = -1;
  try {
    pins = JSON.parse(readFileSync(pinsFile, "utf8")).publishers?.length ?? -1;
  } catch {}
  check("the publisher pin file is staged", pins >= 0, pins >= 0 ? `${pins} pin(s)` : "missing/unreadable");
  if (allowZeroPins) {
    console.log(`NOTE  ${pins} pins — allowed by --allow-zero-pins; a real release must refuse this`);
  } else {
    check("at least one publisher is pinned (or every recipe is untrusted)", pins > 0, `${pins} pin(s)`);
  }

  const scripts = join(APP, "scripts", "beezilla-local.mjs");
  check("the launcher is staged", existsSync(scripts));
  check("the parent watchdog is staged", existsSync(join(APP, "scripts", "lib", "parent-watchdog.cjs")));
  check("the CLI is staged", existsSync(join(APP, "bin", "beezilla.mjs")));

  // The installer carries behaviour, not sources. `scripts/` was copied wholesale
  // until desktop/dist.mjs grew a closure walk, so every install shipped the
  // recipe-seal sources, the check corpus and the test harness as readable .ts.
  const staged = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else staged.push(p);
    }
  };
  if (existsSync(join(APP, "scripts"))) walk(join(APP, "scripts"));
  const sources = staged.filter((p) => p.endsWith(".ts"));
  const harness = staged.filter((p) => /(^|\/)(test-|seed-|give-)/.test(p));
  check("no TypeScript sources ride along in the runtime tree", sources.length === 0, `${sources.length} .ts file(s)`);
  check("no test/seed harness rides along", harness.length === 0, `${harness.length} file(s)`);
  check("the runtime script closure is small", staged.length <= 12, `${staged.length} files`);
}

console.log(`\ninstaller verification: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
