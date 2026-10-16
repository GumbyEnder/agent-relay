/**
 * OpenAPI spec-sync check (API-6 follow-up).
 * Asserts every path in src/lib/openapi.ts corresponds to a route handled in
 * src/lib/agent-api.server.ts. Static-path routes are matched literally;
 * /missions/{id}/<verb> routes are matched against the verb dispatch
 * (`parts[2] === "<verb>"` in the server source).
 * Run: npm run test:openapi-sync
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specSrc = readFileSync(join(root, "src/lib/openapi.ts"), "utf8");
const serverSrc = readFileSync(join(root, "src/lib/agent-api.server.ts"), "utf8");

// Extract path keys from the spec (the object literal keys under `paths:`)
const pathsBlock = specSrc.slice(specSrc.indexOf("paths: {"));
const specPaths = [...pathsBlock.matchAll(/"\/api\/agent([^"]*)":\s*\{/g)].map((m) => m[1]);

let failures = 0;
for (const rawPath of specPaths) {
  const p = rawPath.replace(/\{[^}]+\}/g, "*"); // normalize {id} → *
  const segs = p.split("/").filter(Boolean);
  if (segs[0] === "missions" && segs.length === 2 && segs[1] === "*") {
    // /missions/{id} — static route parts[0]==="missions" && parts.length===2
    const ok = serverSrc.includes('parts[0] === "missions"');
    if (!ok) { console.error(`✗ /api/agent${p} — no missions route`); failures++; }
  } else if (segs[0] === "missions" && segs.length === 3 && segs[1] === "*") {
    // verb sub-route: matched against the verb dispatch
    const verb = segs[2];
    const ok = serverSrc.includes(`verb === "${verb}"`) || serverSrc.includes(`parts[2] === "${verb}"`);
    if (!ok) {
      console.error(`✗ spec verb route /api/agent${p} — no 'verb === "${verb}"' dispatch in server`);
      failures++;
    }
  } else {
    // static route: match the literal path parts in the server source
    const literal = segs[segs.length - 1];
    const ok = serverSrc.includes(`"${literal}"`) || serverSrc.includes(`'${literal}'`);
    if (!ok) {
      console.error(`✗ spec path /api/agent${p} — no matching route literal in server`);
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} spec/route mismatch(es) — update src/lib/openapi.ts or the server routes.`);
  process.exit(1);
}
console.log(`✓ ${specPaths.length} spec paths all match server routes`);

// Leak assertion (REVIEW-F13): the spec must never embed deployment-specific
// hostnames or internal addresses — only relative paths and the reflected
// origin placeholder are acceptable.
const LEAK_PATTERNS = [
  /railway\.app/i,
  /railway\.internal/i,
  /up\.rlt\.net/i,
  /\b10\.\d+\.\d+\.\d+\b/,
  /\b192\.168\.\d+\.\d+\b/,
  /\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/,
  /127\.0\.0\.1/,
  /localhost/,
];
const leaks = LEAK_PATTERNS.filter((re) => re.test(specSrc));
if (leaks.length) {
  console.error(`✗ spec contains deployment-specific strings: ${leaks.map((r) => r.source).join(", ")}`);
  process.exit(1);
}
console.log("✓ no deployment-specific hosts/addresses in spec");
