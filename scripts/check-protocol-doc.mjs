#!/usr/bin/env node
/**
 * Gate for docs/RECIPE-MARKETPLACE-PROTOCOL.md.
 *
 * The protocol document is a claim about the code. This script keeps it from
 * drifting away from the code and from quietly growing a secret in it.
 *
 * Three checks:
 *   1. every endpoint heading names a route the server actually answers
 *   2. every `code` string the document promises exists in the source tree
 *   3. no secret-shaped material and no private-module sentinel
 *
 * When the private modules are not present (the open-source build), checks 1 and
 * 2 can only run against the public sources, so the private-only routes are
 * reported as skipped rather than passed. Silently treating "not here" as "fine"
 * is how a documentation gate becomes decoration.
 *
 * Usage: node scripts/check-protocol-doc.mjs [--doc <path>]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const docPath = args[0] === "--doc" ? args[1] : join(root, "docs/RECIPE-MARKETPLACE-PROTOCOL.md");
const doc = readFileSync(docPath, "utf8");

/**
 * `stubs/*.ts` from the private clone, wherever sync-private.mjs found it.
 *
 * The env var comes first: sync-private.mjs resolves the clone from
 * BZ_PRIVATE_LOCAL_PATH, so when that is set the stubs are next to THAT clone,
 * not next to this worktree. Before this, a local private build (real modules in
 * src/lib/private) failed this check even though the code it wanted was one
 * directory away — `test:protocol-doc` could not pass in the dev layout at all.
 */
function stubFiles() {
  const dirs = [
    process.env.BZ_PRIVATE_LOCAL_PATH ? join(process.env.BZ_PRIVATE_LOCAL_PATH, "stubs") : null,
    join(root, ".private-stub"),
    join(root, ".private/beezilla-recipes/stubs"),
    join(root, "../beezilla-recipes/stubs"),
  ].filter(Boolean);
  for (const d of dirs) {
    if (existsSync(d)) return readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => join(d, f));
  }
  return [];
}

const sources = [];
const privateRoutes = join(root, "src/lib/private/routes.ts");
const privateNitro = join(root, "src/lib/private/recipes.nitro.ts");
const privateRegistry = join(root, "src/lib/private/registry.ts");
const privatePipeline = join(root, "src/lib/private/pipeline.ts");
const hasPrivate = existsSync(privateRoutes) && existsSync(privateNitro);

for (const p of [
  privateRoutes, privateNitro, privateRegistry, privatePipeline,
  join(root, "src/lib/recipe-seal/verify.ts"),
  join(root, "src/lib/recipe-seal/bundle.ts"),
  join(root, "src/lib/recipe-checks/rules.ts"),
  join(root, "src/lib/recipe-checks/vm.ts"),
  // Whatever sync-private.mjs put there: the real modules, or the stub that
  // answers `marketplace_disabled` in an open build. Both must satisfy the doc.
  ...(existsSync(join(root, "src/lib/private"))
    ? readdirSync(join(root, "src/lib/private")).filter((f) => f.endsWith(".ts")).map((f) => join(root, "src/lib/private", f))
    : []),
  // The stub itself lives in the private repo (it is only synced in when there is
  // no credential), so an open build cannot confirm the code it answers with.
  ...stubFiles(),
]) if (existsSync(p)) sources.push([p, readFileSync(p, "utf8")]);

const privateText = sources
  .filter(([p]) => p.includes("/private/"))
  .map(([, t]) => t)
  .join("\n");
const allText = sources.map(([, t]) => t).join("\n");

const failures = [];
const skips = [];

// ── 1. endpoints ──────────────────────────────────────────────────────────────
// Headings look like: ### 4.5 `POST /api/recipes/:hash/run` — paid execution
const endpoints = [...doc.matchAll(/^###\s+[\d.]+\s+`([A-Z]+)\s+(\S+)`/gm)]
  .map((m) => ({ method: m[1], path: m[2] }));

if (endpoints.length === 0) failures.push("no endpoint headings found — did the format change?");

const known = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
for (const { method, path } of endpoints) {
  if (!known.has(method)) failures.push(`unknown method in heading: ${method}`);
  // A path placeholder (`:hash`) has no literal in the code — the handler reads
  // rest[0] and validates it elsewhere. So check the named segments, in order,
  // and treat a placeholder as "matches anything, but must be segment-aligned".
  const segments = path.split("/").filter(Boolean);
  // A segment is "in the code" as a quoted string compare (`rest[1] === "run"`) or
  // as part of a path literal or regex (`"/api/recipes/upload"`, `/rate$`).
  const present = (text) => {
    let cursor = 0;
    for (const seg of segments) {
      if (seg.startsWith(":")) continue;                 // wildcard: skip
      const hits = [`"${seg}"`, `/${seg}/`, `/${seg}$`, `/${seg}"`, `/${seg}\``]
        .map((needle) => text.indexOf(needle, cursor))
        .filter((i) => i >= 0);
      if (hits.length === 0) return false;
      cursor = Math.min(...hits) + seg.length;
    }
    return true;
  };
  // No fallback on the first segment: "api"/"recipes" alone would let any invented
  // sub-route pass, which is exactly the drift this gate exists to catch.
  if (present(privateText) || present(allText)) continue;
  if (hasPrivate) failures.push(`documented endpoint not found in code: ${method} ${path}`);
  else skips.push(`endpoint ${method} ${path} (private modules absent)`);
}

// ── 2. error/verdict codes ────────────────────────────────────────────────────
// Codes are written both bare and inside a status sentence (`402 quota_exhausted`,
// `410 bundle_revoked`), so every token inside a code span is a candidate. Taking
// only spans that are exactly one code silently checked a fraction of the list.
const documented = new Set();
const TOKEN = /^(C\d{2}|[A-Z][A-Z0-9_]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;
for (const span of doc.matchAll(/`([^`\n]+)`/g)) {
  // Split on whitespace: `402 quota_exhausted` is a status plus a code, while
  // `author.private_key` is a field path and must not be read as one.
  for (const tok of span[1].trim().split(/\s+/)) if (TOKEN.test(tok)) documented.add(tok);
}

// Codes that are prose, not protocol values. Kept short on purpose: a long
// allow-list here would let a dead code hide.
const prose = new Set([
  "AUTHORIZATION", "CONTENT_TYPE", "RETRY_AFTER", "X_FORWARDED_FOR",
  // environment variables a self-hoster sets, not protocol values
  "DATABASE_URL", "RECIPE_SEAL_ALLOW_OPEN", "RECIPE_SEAL_KEK", "RECIPE_SEAL_STORAGE_DIR",
  // SQL keywords quoted while describing the one metering step that must be atomic
  "SELECT", "INSERT", "UPDATE", "WHERE", "RETURNING",
]);

// Snake_case names that are manifest *fields*, not response codes. Derived from
// the public schema file rather than listed by hand, so adding a manifest key
// does not mean editing this gate.
const manifestKeys = new Set(
  (existsSync(join(root, "src/lib/recipe-seal/bundle.ts"))
    ? readFileSync(join(root, "src/lib/recipe-seal/bundle.ts"), "utf8")
    : ""
  ).match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [],
);

for (const code of documented) {
  if (prose.has(code)) continue;
  if (manifestKeys.has(code)) continue;
  // A protocol code is a string literal the server can actually emit. Matching
  // any occurrence in the tree passed on identifiers and comments; quoting it is
  // the difference between "the word appears" and "this value exists".
  if (allText.includes(`"${code}"`) || allText.includes(`'${code}'`) || allText.includes(`\`${code}\``)) continue;
  if (hasPrivate) failures.push(`documented code not found as a string literal in source: ${code}`);
  else skips.push(`code ${code} (private modules absent)`);
}

// ── 3. section references ─────────────────────────────────────────────────────
// A document that points at "§12" when it has nine sections is worse than one with
// no cross-references: every pointer has to land.
const headings = new Set(
  [...doc.matchAll(/^#{2,3}\s+(\d+(?:\.\d+)?)\.?\s/gm)].map((m) => m[1]),
);
for (const m of doc.matchAll(/§(\d+(?:\.\d+)?)/g)) {
  if (!headings.has(m[1])) failures.push(`dangling section reference: §${m[1]}`);
}

// ── 4. secrets ────────────────────────────────────────────────────────────────
const forbidden = [
  [/BZ-PRIVATE module/i, "private-module sentinel"],
  [/\brcp_[A-Za-z0-9_-]{24,}/, "a token that looks real"],
  [/\b[0-9a-f]{64}\b(?!`)/, "a bare 64-hex literal outside a code span"],
  [/RECIPE_SEAL_KEK\s*=\s*[A-Za-z0-9+/]{20,}/, "a KEK value"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bsk-[A-Za-z0-9]{16,}/, "a provider key"],
  // Names of private implementation symbols must not appear; the contract is
  // described in behaviour, not by pointing at the code that is withheld.
  [/\b(renderPrompt|runSealedRecipe|methodBlock|redactDraft|filterLeak|gatherEvidence|deriveRecipe|reserveRun|splitCost)\b/, "a private implementation symbol"],
];
for (const [re, why] of forbidden) {
  const hit = doc.match(re);
  if (hit) failures.push(`${why} in the document: ${String(hit[0]).slice(0, 60)}`);
}

// ── report ────────────────────────────────────────────────────────────────────
console.log(`protocol doc: ${docPath.replace(root + "/", "")}`);
console.log(`  endpoints documented: ${endpoints.length}`);
console.log(`  codes documented:     ${documented.size}`);
console.log(`  private modules:      ${hasPrivate ? "present" : "absent (open-source build)"}`);
for (const s of skips) console.log(`  SKIP ${s}`);

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nOK — every documented endpoint and code exists in the tree, and nothing secret-shaped is in it.");
