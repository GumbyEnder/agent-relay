#!/usr/bin/env node
/**
 * Release staging for the desktop app.
 *
 * `stage` builds the self-contained runtime tree that ships beside the window:
 * the Nitro output, the launcher, the CLI and — crucially — only the PRODUCTION
 * dependency closure. Copying node_modules wholesale ships ~700 MB of test and
 * build tooling and every Windows user pays for it in download size.
 *
 * `all` then hands that tree to electron-builder (NSIS on Windows).
 *
 * Layout it produces (and that main.mjs expects when packaged):
 *   <install>/resources/app.asar        main.mjs, supervisor.mjs
 *   <install>/resources/app/            .output/ scripts/ bin/ package.json node_modules/
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DESKTOP, "..");
const STAGE = join(DESKTOP, "stage");
const APP = join(STAGE, "app");

const log = (msg) => console.log(`[dist] ${msg}`);

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

function stage() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });

  if (!existsSync(join(ROOT, ".output", "server", "index.mjs"))) {
    log("building the runtime (vite build)…");
    run("npx", ["vite", "build"], { env: { ...process.env, NODE_ENV: "production" } });
  }

  // `migrations/` is not optional: the schema comes from those .sql files at
  // boot. A stage without them starts, listens, and fails every DB route with
  // 'relation "ar_missions" does not exist' — which looks like a data bug.
  for (const dir of [".output", "scripts", "bin", "migrations", "public"]) {
    if (!existsSync(join(ROOT, dir))) continue;
    log(`copying ${dir}`);
    cpSync(join(ROOT, dir), join(APP, dir), { recursive: true });
  }
  cpSync(join(ROOT, "package.json"), join(APP, "package.json"));

  // Production dependency closure.
  //
  // `npm ls --omit=dev` was the obvious tool and it is the wrong one: it prints
  // the installed tree, so a local `npm install --no-save electron` (269 MB) and
  // stray dev packages ended up in the release — 714 MB instead of ~150 MB. Walk
  // the manifest's `dependencies` instead, resolving each name the way Node does.
  log("resolving the production dependency closure");
  const closure = prodClosure(ROOT);
  let copied = 0;
  for (const dir of closure) {
    const target = join(APP, dir.slice(ROOT.length + 1));
    if (existsSync(target) || /[\\/]node_modules[\\/]electron([\\/]|$)/.test(dir)) continue;
    try {
      cpSync(dir, target, { recursive: true, dereference: true });
      copied++;
    } catch (err) {
      log(`skipped ${dir.slice(ROOT.length + 1)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  log(`staged ${copied} packages`);

  // A staged tree without the PGLite runtime assets boots and then 500s every DB
  // route, so check for them here rather than after install.
  const libs = join(APP, ".output", "server", "_libs");
  const assets = ["pglite.data", "pglite.wasm", "initdb.wasm"].filter((f) => !existsSync(join(libs, f)));
  const pgliteInModules = existsSync(join(APP, "node_modules", "@electric-sql", "pglite", "dist"));
  if (assets.length > 0 && !pgliteInModules) {
    throw new Error(`staged tree is missing PGLite assets (${assets.join(", ")}) and the pglite package — the app would 500 on every DB route`);
  }
  const migrations = existsSync(join(APP, "migrations"))
    ? readdirSync(join(APP, "migrations")).filter((f) => f.endsWith(".sql")).length
    : 0;
  if (migrations === 0) {
    throw new Error("staged tree has no migrations/*.sql — the runtime would boot with an empty schema");
  }
  log(`${migrations} migrations staged`);

  const size = du(APP);
  writeFileSync(join(STAGE, "MANIFEST.json"), JSON.stringify({
    stagedAt: new Date().toISOString(),
    version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
    productionPackages: copied,
    megabytes: Math.round(size / 1e6),
  }, null, 2) + "\n");
  log(`staged tree: ${Math.round(size / 1e6)} MB at ${APP}`);
}

function prodClosure(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {});
  const seen = new Set();
  const out = [];
  const queue = deps.map((name) => ({ name, from: root }));

  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const dir = resolvePackage(name, from, root);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
    let childPkg;
    try {
      childPkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    for (const dep of Object.keys({ ...childPkg.dependencies, ...childPkg.optionalDependencies })) {
      queue.push({ name: dep, from: dir });
    }
  }
  return out;
}

/** Node's lookup: nearest node_modules from `from` upward, never above the repo. */
function resolvePackage(name, from, root) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir || parent.length < root.length) return null;
    dir = parent;
  }
}

function du(dir) {
  try {
    return Number(execFileSync("du", ["-sb", dir], { encoding: "utf8" }).split("\t")[0]);
  } catch {
    return 0;
  }
}

const mode = process.argv[2] ?? "stage";
if (mode === "stage" || mode === "all") stage();
if (mode === "all") {
  log("running electron-builder…");
  execFileSync("npx", ["electron-builder", "--win", "nsis", "--publish", "never"], {
    cwd: DESKTOP, stdio: "inherit",
  });
  log("installer written to dist-desktop/");
}
