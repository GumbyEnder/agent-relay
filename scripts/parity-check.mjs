#!/usr/bin/env node
/**
 * parity-check — does the desktop line still do what the web line does?
 *
 * Two release lines serve one product:
 *
 *   web     ~/agents/agent-relay-recipes  → github main → app.devboards.ai
 *   desktop ~/agents/agent-relay-local    → branch feat/local-runtime → BeeZilla installer
 *
 * They are the same codebase on different clocks, and that is fine — drift is
 * only a bug when nobody wrote it down. So this tool does NOT try to make the
 * two trees identical. It fails when a page, an API family or a migration
 * exists on one side and is missing from `docs/parity/functions.json`. Every
 * divergence has to be a declared, owned function state:
 *
 *   both          present on both surfaces
 *   web-only      deliberately not shipped to desktop yet (and says who owns it)
 *   desktop-only  exists only in the local runtime / shell
 *   drift         present on both but behaviour is known to differ — needs a note
 *
 * It also checks a built/installed app against its own source tree, because an
 * installer that lags its branch is the failure a user actually feels.
 *
 * Usage
 *   node scripts/parity-check.mjs                        # table + gate
 *   node scripts/parity-check.mjs --json out.json        # machine report
 *   node scripts/parity-check.mjs --inventory            # dump both inventories
 *   node scripts/parity-check.mjs --bundle /path/to/BeeZilla/resources/app
 *
 * Exit codes: 0 = every divergence declared, 1 = unregistered drift or a
 * register entry that no longer matches the tree, 2 = a tree could not be read.
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, resolve, extname, relative } from "node:path";
import { homedir } from "node:os";

const HERE = resolve(new URL(".", import.meta.url).pathname, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const WEB = resolve(opt("--web", join(homedir(), "agents/agent-relay-recipes")));
const DESK = resolve(opt("--desktop", join(homedir(), "agents/agent-relay-local")));
const BUNDLE = opt("--bundle", join(homedir(), ".wine-install/drive_c/users/gumbyender/AppData/Local/Programs/BeeZilla/resources/app"));
const REGISTER = resolve(opt("--register", join(HERE, "docs/parity/functions.json")));

const SKIP_DIRS = new Set(["node_modules", ".output", ".git", "dist", "dist-desktop", ".nitro", "cache", "stage"]);

/* ---------------------------------------------------------------- inventory */

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), out);
    } else {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const ROUTE_RE = /["'`](\/api\/[a-zA-Z0-9/_:.\-]*)["'`]/g;

/**
 * Route family: /api/buzzy/graphs/:<id> → /api/buzzy/graphs
 *
 * /api/recipes/local is its own family: collapsing it into /api/recipes would
 * hide the desktop's local recipe cache, which is the whole desktop-only
 * capability and the exact thing this tool exists to see.
 */
function family(route) {
  const clean = route.replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean); // ["api", ...]
  if (parts[0] !== "api") return null;
  if (parts[1] === "buzzy") return `/api/buzzy/${parts[2] ?? ""}`.replace(/\/$/, "");
  if (parts[1] === "recipes" && parts[2] === "local") return "/api/recipes/local";
  return `/api/${parts[1]}`.replace(/\/$/, "");
}

function pagesOf(root) {
  const dir = join(root, "public/buzzy");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => extname(f) === ".html")
    .map((f) => basename(f, ".html"))
    .sort();
}

function pageSetOf(root) {
  const file = join(root, "src/lib/buzzy/pages.nitro.ts");
  if (!existsSync(file)) return { declared: [], file: null };
  const src = readFileSync(file, "utf8");
  const m = src.match(/const PAGES = new Set\(\[([^\]]*)\]\)/);
  const declared = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort() : [];
  return { declared, file };
}

function migrationsOf(root) {
  const dir = join(root, "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function routesOf(root) {
  const files = [];
  const srcDir = join(root, "src");
  if (existsSync(srcDir)) walk(srcDir, files).filter((f) => /\.(ts|tsx|mjs)$/.test(f)).forEach((f) => files.push(f));
  for (const extra of ["vite.config.ts", "routes"]) {
    const p = join(root, extra);
    if (existsSync(p)) {
      if (statSync(p).isDirectory()) walk(p, files);
      else files.push(p);
    }
  }
  const routes = new Set();
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(ROUTE_RE)) {
      // `${...}` inside a quoted string greps as a literal "undefined"/"${x}"
      // segment; that is an artefact of this tool, not a route.
      if (/undefined|\$\{/.test(m[1])) continue;
      const fam = family(m[1]);
      if (fam && fam !== "/api/buzzy" && fam !== "/api") routes.add(fam);
    }
  }
  return [...routes].sort();
}

function versionOf(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

function gitHead(root) {
  // Shell out: a worktree's .git is a pointer file, refs can be packed, and
  // re-implementing that resolution is how this printed "?" the first time.
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
}

/** Behaviour markers that are cheap to prove and expensive to lose. */
const MARKERS = {
  "canonical nav (#bzNav)": (root) => countIn(join(root, "public/buzzy"), "bzNav"),
  "listen mode persisted": (root) => countIn(join(root, "public/buzzy"), "bz_listen_mode"),
  "recorder / ASR client": (root) => countIn(join(root, "public/buzzy"), "startRecording"),
  "server transcription": (root) => countIn(join(root, "src"), "api/buzzy/transcribe"),
  "asset shelf": (root) => countIn(join(root, "src"), "buzzy_assets"),
  "local runtime flag": (root) => countIn(join(root, "src"), "BZ_RUNTIME"),
};

function countIn(dir, needle) {
  if (!existsSync(dir)) return 0;
  const files = walk(dir).filter((f) => /\.(ts|tsx|mjs|cjs|js|html)$/.test(f));
  let n = 0;
  for (const f of files) {
    try {
      if (readFileSync(f, "utf8").includes(needle)) n++;
    } catch {
      /* unreadable file is not a hit */
    }
  }
  return n;
}

function hashFiles(root, list, subdir) {
  const out = {};
  for (const f of list) {
    const p = subdir ? join(root, subdir, f) : join(root, f);
    try {
      out[f] = readFileSync(p).length;
    } catch {
      out[f] = -1;
    }
  }
  return out;
}

function inventory(root, label) {
  if (!existsSync(root)) return null;
  const pages = pagesOf(root);
  const pageSet = pageSetOf(root);
  return {
    label,
    root,
    head: gitHead(root),
    version: versionOf(root),
    pages,
    pageSet: pageSet.declared,
    /** pages that exist on disk but are not routable — a real defect class */
    unroutable: pages.filter((p) => !pageSet.declared.includes(p)),
    migrations: migrationsOf(root),
    routes: routesOf(root),
  };
}

/* ------------------------------------------------------------------- report */

const web = inventory(WEB, "web");
const desk = inventory(DESK, "desktop");

if (!web || !desk) {
  console.error(`cannot read ${!web ? WEB : DESK}`);
  process.exit(2);
}

if (flag("--inventory")) {
  console.log(JSON.stringify({ web, desktop: desk }, null, 2));
  process.exit(0);
}

let register = null;
if (existsSync(REGISTER)) {
  try {
    register = JSON.parse(readFileSync(REGISTER, "utf8"));
  } catch (err) {
    console.error(`register is not valid JSON: ${REGISTER}\n${err.message}`);
    process.exit(2);
  }
}

const onlyWebPages = web.pages.filter((p) => !desk.pages.includes(p));
const onlyDeskPages = desk.pages.filter((p) => !web.pages.includes(p));
const onlyWebMigrations = web.migrations.filter((m) => !desk.migrations.includes(m));
const onlyDeskMigrations = desk.migrations.filter((m) => !web.migrations.includes(m));
const onlyWebRoutes = web.routes.filter((r) => !desk.routes.includes(r));
const onlyDeskRoutes = desk.routes.filter((r) => !web.routes.includes(r));

const pad = (s, n) => String(s).padEnd(n);
const rule = (c = "─") => c.repeat(78);

const lines = [];
lines.push(`PARITY  web ${web.head} (${web.version}) · desktop ${desk.head} (${desk.version})`);
lines.push(rule());

/* --- per-function table from the register ------------------------------- */

/**
 * Evidence is a path, optionally with a marker: "public/buzzy/talk.html#bzNav".
 * With the marker the file must exist AND contain it, so "we have this feature"
 * cannot rot into "this file still exists".
 */
const evidenceOk = (root, list) =>
  Array.isArray(list) &&
  list.length > 0 &&
  list.every((spec) => {
    const [rel, marker] = spec.split("#");
    const p = join(root, rel);
    if (!existsSync(p)) return false;
    if (!marker) return true;
    try {
      return readFileSync(p, "utf8").includes(marker);
    } catch {
      return false;
    }
  });

const problems = [];
const warnings = [];
if (register) {
  const entries = register.functions ?? [];
  lines.push(pad("function", 36) + pad("web", 10) + pad("desktop", 10) + "state");
  for (const f of entries) {
    const okWeb = evidenceOk(WEB, f.web?.evidence);
    const okDesk = evidenceOk(DESK, f.desktop?.evidence);
    const computed = okWeb && okDesk ? "both" : okWeb ? "web-only" : okDesk ? "desktop-only" : "absent";
    const declared = f.state ?? "?";

    for (const p of f.web?.pages ?? []) if (!web.pages.includes(p)) problems.push(`${f.id}: web page ${p}.html is not in the tree`);
    for (const p of f.desktop?.pages ?? []) if (!desk.pages.includes(p)) problems.push(`${f.id}: desktop page ${p}.html is not in the tree`);
    for (const r of f.web?.routes ?? []) if (!web.routes.includes(r)) problems.push(`${f.id}: web route ${r} is not in the tree`);
    for (const r of f.desktop?.routes ?? []) if (!desk.routes.includes(r)) problems.push(`${f.id}: desktop route ${r} is not in the tree`);

    if (computed !== declared) problems.push(`${f.id}: register says ${declared}, evidence says ${computed}`);
    const mark = computed === declared ? "" : `  ← evidence says ${computed}`;
    lines.push(pad(f.id, 36) + pad(okWeb ? "ok" : "—", 10) + pad(okDesk ? "ok" : "—", 10) + declared + mark);
  }
  lines.push(rule());
}

for (const p of web.unroutable) warnings.push(`web page ${p}.html exists but is not in PAGES — it will 404`);
for (const p of desk.unroutable) warnings.push(`desktop page ${p}.html is not in PAGES — reachable only as a static file`);

/* --- unregistered divergence -------------------------------------------- */
function undeclared(list, surface, kind) {
  const declared = new Set();
  for (const f of register?.functions ?? []) {
    for (const item of f[surface]?.[kind] ?? []) declared.add(item);
  }
  return list.filter((x) => !declared.has(x));
}

const orphans = [
  ...undeclared(onlyWebPages, "web", "pages").map((p) => `page ${p}.html is web-only and undeclared`),
  ...undeclared(onlyDeskPages, "desktop", "pages").map((p) => `page ${p}.html is desktop-only and undeclared`),
  ...undeclared(onlyWebRoutes, "web", "routes").map((r) => `route family ${r} is web-only and undeclared`),
  ...undeclared(onlyDeskRoutes, "desktop", "routes").map((r) => `route family ${r} is desktop-only and undeclared`),
  ...undeclared(onlyWebMigrations, "web", "migrations").map((m) => `migration ${m} is web-only and undeclared`),
  ...undeclared(onlyDeskMigrations, "desktop", "migrations").map((m) => `migration ${m} is desktop-only and undeclared`),
];

lines.push(`web-only pages      ${onlyWebPages.join(", ") || "none"}`);
lines.push(`desktop-only pages  ${onlyDeskPages.join(", ") || "none"}`);
lines.push(`web-only routes     ${onlyWebRoutes.join(", ") || "none"}`);
lines.push(`desktop-only routes ${onlyDeskRoutes.join(", ") || "none"}`);
lines.push(`web-only migrations ${onlyWebMigrations.length}  ${onlyWebMigrations.join(" ") || ""}`);
lines.push(`desktop-only migrations ${onlyDeskMigrations.length} ${onlyDeskMigrations.join(" ") || ""}`);
lines.push(rule());

/* --- marker drift -------------------------------------------------------- */
lines.push(pad("behaviour marker", 34) + pad("web", 10) + "desktop");
for (const [name, fn] of Object.entries(MARKERS)) {
  const a = fn(WEB);
  const b = fn(DESK);
  const flagMarker = (a > 0) !== (b > 0) ? "  ← one-sided" : "";
  lines.push(pad(name, 34) + pad(a > 0 ? `yes(${a})` : "no", 10) + (b > 0 ? `yes(${b})` : "no") + flagMarker);
}
lines.push(rule());

/* --- installed bundle vs its own source tree ---------------------------- */
let bundleReport = null;
if (BUNDLE && existsSync(BUNDLE)) {
  const bPages = pagesOf(BUNDLE);
  const bMigrations = migrationsOf(BUNDLE);
  const stalePages = desk.pages.filter((p) => !bPages.includes(p));
  const staleMigrations = desk.migrations.filter((m) => !bMigrations.includes(m));
  const extraPages = bPages.filter((p) => !desk.pages.includes(p));
  const payload = join(BUNDLE, ".output/server");
  let builtAt = "?";
  try {
    builtAt = statSync(payload).mtime.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    /* not built */
  }
  bundleReport = { pages: bPages.length, migrations: bMigrations.length, builtAt, stalePages, staleMigrations, extraPages };
  lines.push(`INSTALLED BUNDLE ${BUNDLE}`);
  lines.push(`  pages ${bPages.length} · migrations ${bMigrations.length} · payload mtime ${builtAt}`);
  lines.push(`  behind its source tree: pages ${stalePages.join(", ") || "none"} · migrations ${staleMigrations.length}`);
  lines.push(`  not in source tree: ${extraPages.join(", ") || "none"}`);
  if (stalePages.length || staleMigrations.length) problems.push(`installed bundle is behind feat/local-runtime (${stalePages.length} pages, ${staleMigrations.length} migrations)`);
  lines.push(rule());
}

/* --- verdict ------------------------------------------------------------- */
for (const p of problems) lines.push(`REGISTER  ${p}`);
for (const o of orphans) lines.push(`ORPHAN    ${o}`);
for (const w of warnings) lines.push(`WARN      ${w}`);
if (!register) lines.push(`REGISTER  ${REGISTER} not found — every divergence is undeclared`);

const failed = problems.length > 0 || orphans.length > 0 || !register;
lines.push(failed ? `RESULT: FAIL — ${problems.length + orphans.length + (register ? 0 : 1)} to resolve` : `RESULT: PASS — every divergence is declared and every declaration still matches`);
console.log(lines.join("\n"));

if (opt("--json")) {
  writeFileSync(
    resolve(opt("--json")),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        web: { root: web.root, head: web.head, version: web.version },
        desktop: { root: desk.root, head: desk.head, version: desk.version },
        divergence: { onlyWebPages, onlyDeskPages, onlyWebRoutes, onlyDeskRoutes, onlyWebMigrations, onlyDeskMigrations },
        bundle: bundleReport,
        problems,
        orphans,
        pass: !failed,
      },
      null,
      2,
    ),
  );
}
process.exit(failed ? 1 : 0);
