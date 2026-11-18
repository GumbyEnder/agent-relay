#!/usr/bin/env node
/**
 * The BeeZilla ⇄ Dev Boards boundary check.
 *
 * Two products live in one repo and one Postgres. They are allowed to be that
 * close only while the seam stays a seam, so this script makes the seam a rule
 * that CI enforces instead of a convention that the next big PR forgets.
 *
 * Rules, in the order they are checked:
 *
 *   1. IMPORT FENCE — a file under `src/lib/buzzy/` may import its own subtree
 *      and the modules on ALLOWED below, nothing else. Relative escapes
 *      (`../../board-store.server`) are refused exactly like alias imports.
 *   2. NO SCHEMA LEAK — nothing under `src/lib/buzzy/` names an `ar_*` table.
 *      Console schema knowledge belongs behind a console module
 *      (`@/lib/operator-prefs.server` is the worked example).
 *   3. ONE DIRECTION — nothing outside `src/lib/buzzy/` imports from
 *      `@/lib/buzzy`. The console must never depend on the consumer product;
 *      that dependency is what would make the split impossible later.
 *
 * Why these and not more: measured 2026-11-17, 357 Buzzy commits in 90 days
 * against 121 console commits, and only 18 commits touched both sides. The
 * coupling that exists is this short list. Enforce what exists, so the number
 * stays 18.
 *
 * Run: `node scripts/check-buzzy-boundary.mjs` (also wired into `test:ci`).
 * Exit 1 with file:line for every violation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const LIB = join(ROOT, "src", "lib");
const BUZZY = join(LIB, "buzzy");

/**
 * Modules `src/lib/buzzy/**` is permitted to import from outside itself.
 *
 * Keep this list short and deliberate. Every entry is a contract the consumer
 * product depends on, and each one is a thing the two products would have to
 * agree on after a split:
 *   db                    — the driver + `Sql` type
 *   auth/verify.server    — session verification (one identity for both products)
 *   operator-prefs.server — the account's prefs row, so `ar_*` never leaks into buzzy
 *   board-server          — DELIBERATE product integration, not drift: an approved
 *                           draft is cut into board work (execution.ts). This is the
 *                           one write path from the consumer product into the
 *                           console. After a split it has to become a board API
 *                           call; it is on this list so that day is a decision, not
 *                           a surprise.
 */
const ALLOWED = new Set(["db", "auth/verify.server", "operator-prefs.server", "board-server"]);

/**
 * The console may import exactly one thing from `src/lib/buzzy`: the package
 * surface, `buzzy/public`.
 *
 * It used to be four internals (`inferenceToken`, `entitlements`, `music`,
 * `modelPrefs`) imported straight out of six console files. Stage 2 collapsed them
 * behind `src/lib/buzzy/public.ts` — the contract the console actually needs (mint
 * and verify capability tokens, read the plan and quotas, gate music, validate a
 * model-prefs patch) — so stage 3 can copy that directory into another repo without
 * six broken paths, and so a new dependency is an edit to the surface rather than an
 * import that happens to resolve.
 *
 * No other module name is accepted. If the console needs something new from
 * BeeZilla, it goes through the surface file first.
 */
const ALLOWED_INBOUND = new Set(["buzzy/public"]);



/** Files under src/lib/buzzy that are scanned. */
const SRC = /\.(ts|tsx|mts)$/;

/** Table-prefix leak: `ar_foo` inside a consumer-side file. */
const AR_TABLE = /\bar_[a-z][a-z0-9_]*/g;

const IMPORT_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g, // import … from "x" / export … from "x"
  /\bimport\s+["']([^"']+)["']/g, // side-effect import "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("x")
];

const violations = [];
/** Allowlist hits, so drift is visible in the passing output too. */
const allowlistUse = new Map();

function walk(dir, filter = () => true, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "private") continue;
      walk(path, filter, out);
    } else if (filter(path)) {
      out.push(path);
    }
  }
  return out;
}

const isInside = (child, parent) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep + "..");
};

/** "…/src/lib/buzzy/chat.nitro.ts" → "buzzy/chat.nitro" (extension stripped). */
const moduleKey = (absPath) =>
  relative(LIB, absPath)
    .replace(SRC, "")
    .replace(/\/index$/, "")
    .split(sep)
    .join("/");

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Resolve an import specifier to a lib-relative module key, or a marker. */
function resolveSpec(spec, fromFile) {
  if (spec.startsWith("@/lib/")) return { kind: "lib", key: spec.slice("@/lib/".length) };
  if (spec.startsWith("@/lib")) return { kind: "lib", key: "" };
  if (spec.startsWith("@/")) return { kind: "outside-alias", key: spec.slice(2) };
  if (spec.startsWith(".")) {
    const abs = resolve(dirname(fromFile), spec);
    if (isInside(abs, BUZZY)) return { kind: "self", key: moduleKey(abs) };
    return { kind: "relative-escape", key: relative(LIB, abs).split(sep).join("/") };
  }
  return { kind: "package", key: spec };
}

// ── rules 1 and 2: inside src/lib/buzzy ──────────────────────────────────────
const buzzyFiles = walk(BUZZY, (p) => SRC.test(p));

for (const file of buzzyFiles) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);

  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1];
      const at = lineOf(text, match.index ?? 0);
      const r = resolveSpec(spec, file);

      if (r.kind === "self" || r.kind === "package") continue;

      if (r.kind === "lib") {
        const key = r.key.replace(SRC, "").replace(/\/index$/, "");
        if (key.startsWith("buzzy/") || key === "buzzy") continue;
        if (ALLOWED.has(key)) {
          allowlistUse.set(key, (allowlistUse.get(key) ?? 0) + 1);
          continue;
        }
        violations.push({
          rule: "import fence",
          at: `${rel}:${at}`,
          detail: `imports "${spec}" — outside the allowlist (${[...ALLOWED].join(", ")})`,
        });
        continue;
      }

      violations.push({
        rule: "import fence",
        at: `${rel}:${at}`,
        detail:
          r.kind === "relative-escape"
            ? `imports "${spec}" — escapes src/lib/buzzy into src/lib/${r.key}${ALLOWED.has(r.key.replace(SRC, "")) ? " (that module IS allowlisted — import it as @/lib/" + r.key.replace(SRC, "") + ")" : ""}`
            : `imports "${spec}" — aliased to ${r.key}, outside src/lib/buzzy`,
      });
    }
  }

  for (const match of text.matchAll(AR_TABLE)) {
    violations.push({
      rule: "schema leak",
      at: `${rel}:${lineOf(text, match.index ?? 0)}`,
      detail: `names the console table "${match[0]}" — read it through a console module instead`,
    });
  }
}

// ── rule 3: nothing outside buzzy imports buzzy ──────────────────────────────
const outsideSources = [
  ...walk(LIB, (p) => SRC.test(p) && !isInside(p, BUZZY)),
  ...walk(join(ROOT, "src", "components"), (p) => SRC.test(p)),
  ...walk(join(ROOT, "src", "routes"), (p) => SRC.test(p)),
];

for (const file of outsideSources) {
  const text = readFileSync(file, "utf8");
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1];
      const r = resolveSpec(spec, file);
      const key = r.kind === "lib" ? r.key : r.kind === "relative-escape" || r.kind === "self" ? r.key : null;
      if (!key) continue;
      const mod = key.replace(SRC, "").replace(/\/index$/, "");
      if (mod !== "buzzy" && !mod.startsWith("buzzy/")) continue;
      if (ALLOWED_INBOUND.has(mod)) {
        allowlistUse.set(`↩ ${mod}`, (allowlistUse.get(`↩ ${mod}`) ?? 0) + 1);
        continue;
      }
      violations.push({
        rule: "inbound fence",
        at: `${relative(ROOT, file)}:${lineOf(text, match.index ?? 0)}`,
        detail: `imports "${spec}" — a new console→buzzy dependency; see ALLOWED_INBOUND`,
      });
    }
  }
}


// ── report ──────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error(`buzzy boundary: FAILED — ${violations.length} violation(s)\n`);
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, list] of byRule) {
    console.error(`  ${rule} (${list.length})`);
    for (const v of list) console.error(`    ${v.at}  ${v.detail}`);
    console.error("");
  }
  console.error("The rule and its reason: scripts/check-buzzy-boundary.mjs header.");
  process.exit(1);
}

const used = [...allowlistUse.entries()].sort((a, b) => b[1] - a[1]);
console.log(
  `buzzy boundary: ok — ${buzzyFiles.length} files scanned, ${outsideSources.length} console files checked, ` +
    `${used.reduce((n, [, c]) => n + c, 0)} allowlisted import(s)`,
);
for (const [key, count] of used) console.log(`  ${key} ×${count}`);
