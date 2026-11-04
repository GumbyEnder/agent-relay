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
import { dirname, join, posix, resolve } from "node:path";
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

  // Always rebuild. `vite build` takes under a second here, and skipping it when
  // `.output` merely EXISTS ships whatever was built last — that is how the
  // packaged app ended up running pre-pin-file server code and reporting zero
  // publisher keys while the shipped publishers.json had one.
  log("building the runtime (vite build)…");
  run("npx", ["vite", "build"], { env: { ...process.env, NODE_ENV: "production" } });

  // `migrations/` is not optional: the schema comes from those .sql files at
  // boot. A stage without them starts, listens, and fails every DB route with
  // 'relation "ar_missions" does not exist' — which looks like a data bug.
  for (const dir of [".output", "bin", "migrations", "public"]) {
    if (!existsSync(join(ROOT, dir))) continue;
    log(`copying ${dir}`);
    cpSync(join(ROOT, dir), join(APP, dir), { recursive: true });
  }
  // `scripts/` used to be copied wholesale: 89 files of test probes, seeds and
  // TypeScript sources rode along with the launcher, so every installer shipped
  // the recipe-seal sources, the check corpus and the internal test harness in
  // readable form. Stage the import closure of the three scripts the runtime
  // actually starts instead, and refuse the build if anything else appears.
  stageRuntimeScripts();
  cpSync(join(ROOT, "package.json"), join(APP, "package.json"));

  // Publisher pins travel with the app. A build that ships zero pins trusts no
  // recipe — correct-but-useless, so `all` (the release path) refuses outright.
  // Production pins should NOT live in the repo — they come from a build secret.
  // Same resolution order the runtime uses (env file -> repo file), so what the
  // installer trusts is exactly what the build was told to trust.
  const pinsFile = process.env.BZ_RECIPE_PUBLISHER_FILE || join(ROOT, "publishers.json");
  if (existsSync(pinsFile)) {
    cpSync(pinsFile, join(APP, "publishers.json"));
    const pins = JSON.parse(readFileSync(pinsFile, "utf8")).publishers ?? [];
    log(`publisher pins: ${pins.length} (from ${pinsFile})`);
    if (pins.length === 0 && mode === "all") {
      throw new Error(
        "refusing to build a release with no publisher pins — point BZ_RECIPE_PUBLISHER_FILE at the production key set",
      );
    }
  } else if (mode === "all") {
    throw new Error("refusing to build a release with no publishers.json");
  }

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
  const pgliteSrc = join(APP, "node_modules", "@electric-sql", "pglite", "dist");
  // Ship the payloads instead of letting the launcher copy them on first start:
  // that restore WRITES into the install folder, which a per-machine NSIS install
  // cannot do, and a read-only install must not need to write to start.
  for (const f of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
    const target = join(libs, f);
    if (!existsSync(target) && existsSync(join(pgliteSrc, f))) {
      mkdirSync(libs, { recursive: true });
      cpSync(join(pgliteSrc, f), target);
    }
  }
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

  // The gate that would have caught 0.2.0. See assertPackagedImports for what it
  // checks and why the failure is invisible in a dev run.
  assertPackagedImports();

  const size = du(APP);
  writeFileSync(join(STAGE, "MANIFEST.json"), JSON.stringify({
    stagedAt: new Date().toISOString(),
    version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
    productionPackages: copied,
    megabytes: Math.round(size / 1e6),
  }, null, 2) + "\n");
  log(`staged tree: ${Math.round(size / 1e6)} MB at ${APP}`);
}

/**
 * Stage only the scripts the installed runtime starts, plus their relative
 * import closure.
 *
 * The rule this enforces is "the installer carries behaviour, not sources".
 * `scripts/` holds 89 files on the dev line: TypeScript test harnesses, seeds,
 * probes and the whole recipe-seal test corpus. Copying the directory shipped
 * all of it — readable `.ts` included — inside every 454 MB install.
 *
 * Entries are the three things that actually run in the installed tree
 * (`scripts/beezilla-local.mjs` is spawned by supervisor.mjs, `scripts/migrate.mjs`
 * by the start command, `bin/beezilla.mjs` is the CLI). `parent-watchdog.cjs` is
 * named by a string in NODE_OPTIONS, so it cannot be found by following imports.
 */
const RUNTIME_SCRIPT_ENTRIES = [
  "scripts/beezilla-local.mjs",
  "scripts/migrate.mjs",
  "bin/beezilla.mjs",
  "scripts/lib/parent-watchdog.cjs",
  // Loaded at call time through runtimeLib() from the shell, never imported.
  "scripts/lib/inference.mjs",
  "scripts/lib/search-keys.mjs",
  "scripts/lib/music-keys.mjs",
];

/** Files that must never be staged, whatever the closure says. */
const FORBIDDEN_STAGED = /(^|\/)(test-|seed-|give-|probe|purity-check|parity-check|run-local-suites|dev-fake-cloud|verify-installer|mcp-server)|\.ts$/;

function stageRuntimeScripts() {
  const seen = new Set();
  const queue = [...RUNTIME_SCRIPT_ENTRIES];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const full = join(ROOT, rel);
    if (!existsSync(full)) throw new Error(`runtime script entry is missing: ${rel}`);
    seen.add(rel);
    if (!/\.[mc]?js$/.test(rel)) continue;
    const src = readFileSync(full, "utf8");
    for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g)) {
      const spec = m[1];
      const resolved = posix.normalize(posix.join(posix.dirname(rel), spec));
      if (resolved.startsWith("..")) continue;
      if (existsSync(join(ROOT, resolved))) queue.push(resolved);
    }
  }

  const staged = [...seen].sort();
  const forbidden = staged.filter((f) => FORBIDDEN_STAGED.test(f));
  if (forbidden.length > 0) {
    throw new Error(`refusing to ship source/test files in the runtime tree: ${forbidden.join(", ")}`);
  }
  for (const rel of staged) {
    const target = join(APP, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, rel), target);
  }
  log(`staged ${staged.length} runtime scripts (was the whole scripts/ tree: 89 files)`);
}

/** Package files the shell loads out of the runtime tree at call time. */
const REQUIRED_RUNTIME_FILES = [
  "scripts/lib/inference.mjs",
  "scripts/lib/search-keys.mjs",
  "scripts/lib/music-keys.mjs",
  "bin/beezilla.mjs",
];

/**
 * Prove every relative import in the packaged shell resolves in the INSTALLED
 * layout, not just in this repo.
 *
 * 0.2.0 shipped `import { loadInference } from "../scripts/lib/inference.mjs"`.
 * In the repo that file is `<repo>/scripts/lib/inference.mjs`, so every dev run
 * passed. Packaged, the shell lives at `resources/app.asar/main.mjs`, so `..` is
 * `resources/` and the import asked for `resources/scripts/lib/inference.mjs` —
 * never shipped (the tree is at `resources/app/scripts`). Electron dies at
 * module-LINK time, before a line of main.mjs runs, so the app shows a bare
 * "A JavaScript error occurred in the main process" with no log at all.
 *
 * Rules encoded here:
 *   - a specifier that stays inside the asar must name another build.files entry
 *     (a file that is not listed is silently absent from the asar);
 *   - a specifier that climbs out with `../` must exist in the staged tree, i.e.
 *     be something the installer actually ships;
 *   - the runtime libraries the shell loads dynamically must be staged.
 */
function assertPackagedImports() {
  const pkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
  const asarFiles = (pkg.build?.files ?? []).filter((f) => typeof f === "string");
  const problems = [];

  for (const file of asarFiles.filter((f) => /\.(mjs|cjs|js)$/.test(f))) {
    const full = join(DESKTOP, file);
    if (!existsSync(full)) {
      problems.push(`${file}: listed in build.files but missing from desktop/`);
      continue;
    }
    const src = readFileSync(full, "utf8");
    const specs = [
      ...src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g),
    ].map((m) => m[1]);

    for (const spec of new Set(specs)) {
      // Every build.files entry is flat at the asar root, so resolve against it.
      const rel = posix.normalize(spec);
      if (!rel.startsWith("../")) {
        if (!asarFiles.includes(rel.replace(/^\.\//, ""))) {
          problems.push(
            `${file}: imports "${spec}" but "${rel.replace(/^\.\//, "")}" is not in build.files — it would be absent from app.asar`,
          );
        }
        continue;
      }
      // Escaped the asar: from resources/app.asar/<file>, ../.. is resources/.
      const escaped = rel.replace(/^(\.\.\/)+/, "");
      if (!existsSync(join(STAGE, escaped))) {
        problems.push(
          `${file}: imports "${spec}" → <install>/resources/${escaped}, which the installer does not ship ` +
            `(the runtime tree is at <install>/resources/app/${escaped}). Load it with runtimeLib() from paths.mjs.`,
        );
      }
    }
  }

  for (const rel of REQUIRED_RUNTIME_FILES) {
    if (!existsSync(join(APP, rel))) problems.push(`runtime tree is missing ${rel} — the packaged shell cannot start`);
  }

  if (problems.length > 0) {
    throw new Error(
      `packaged layout is broken (${problems.length}):\n  - ${problems.join("\n  - ")}\n` +
        `A dev run cannot see any of these; only the installed layout can.`,
    );
  }
  log(`packaged imports: ok (${asarFiles.length} shell files, ${REQUIRED_RUNTIME_FILES.length} runtime libs)`);
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
