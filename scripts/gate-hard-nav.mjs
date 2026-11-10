// BZ-16 gate — a same-origin /buzzy/ URL must never be pushed into location.
//
// Inside /buzzy/* the page shell (nav.js) keeps Talk's document alive, and that
// document owns the speech recogniser. Assigning location.href to a /buzzy/ URL
// is a full document load: the mic dies, silently, and the chrome still claims
// it is listening. So every intra-product hop goes through BeeZillaShell.go(),
// or renders in place (BeeZillaTalk.openJob).
//
// Two enumerations, both deliberate:
//   HARD_NAV_ALLOW — the only hard loads permitted, with a reason each. Every
//     one of them is a "the session or the shell is already gone" path.
//   ROUTE_TEMPLATES — JSDoc/template strings that legitimately interpolate a
//     /buzzy/ path (a PDF viewer URL, a document download link) but never
//     assign it to location.
//
// usage: node scripts/gate-hard-nav.mjs [origin]     (origin optional: also
// gate the served bytes; omit to gate the working tree only)
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ORIGIN = process.argv[2];

// Path-level exceptions, valid in ANY page: the session is already gone, so the
// engine in this document must die with it. Nothing else qualifies.
const AUTH_EJECT = {
  "/buzzy/landing": "401/403 from the API: the session is gone, so the recogniser must die with it",
};

// File-level exceptions, each one a deliberate end-of-session hop.
const HARD_NAV_ALLOW = {
  "public/buzzy/nav.js": {
    "/buzzy/": "explicit sign-out: the session is gone, the engine must die with it",
  },
};

// `location.href = "..."`, `location.assign("...")`, `window.location.replace("...")`
const ASSIGN = /(?:window\.)?location\s*(?:\.href\s*=\s*|\.assign\(\s*|\.replace\(\s*)["'`](\/buzzy[^"'`]*)/g;

const files = (await fs.readdir(path.join(root, "public/buzzy")))
  .filter((f) => /\.(html|js)$/.test(f))
  .sort();

const hits = [];
for (const f of files) {
  const rel = `public/buzzy/${f}`;
  const text = await fs.readFile(path.join(root, rel), "utf8");
  text.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    // A comment can name the trap without committing it.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const m of line.matchAll(ASSIGN)) {
      const target = m[1];
      const allow = HARD_NAV_ALLOW[rel] || {};
      const fileReason = Object.keys(allow).find((p) => target === p || target.startsWith(p + "?"));
      const authReason = Object.keys(AUTH_EJECT).find((p) => target === p || target.startsWith(p + "?"));
      hits.push({ file: rel, line: i + 1, target, reason: fileReason ? allow[fileReason] : authReason ? AUTH_EJECT[authReason] : null });
    }
  });
}

const bad = hits.filter((h) => !h.reason);
console.log("hard navigation to /buzzy/* in the working tree:");
console.log(
  hits.length
    ? hits
        .map((h) => `  ${h.file}:${h.line}  ${h.target}  ${h.reason ? "allowed — " + h.reason : "STRAY — route it through BeeZillaShell.go"}`)
        .join("\n")
    : "  none"
);

let servedBad = [];
if (ORIGIN) {
  const pages = files.filter((f) => f.endsWith(".html"));
  console.log(`\nserved bytes at ${ORIGIN}:`);
  for (const f of pages) {
    const route = "/buzzy/" + f.replace(/\.html$/, "");
    let html;
    try {
      const res = await fetch(ORIGIN + route, { headers: { "cache-control": "no-cache" } });
      if (!res.ok) { console.log(`  ${route}  HTTP ${res.status}`); continue; }
      html = await res.text();
    } catch (e) {
      console.log(`  ${route}  fetch failed: ${e.message}`);
      continue;
    }
    const found = [...html.matchAll(ASSIGN)].map((m) => m[1]);
    const isAllowed = (t) =>
      Object.keys(AUTH_EJECT).some((p) => t === p || t.startsWith(p + "?")) ||
      Object.keys(HARD_NAV_ALLOW[`public/buzzy/${f}`] || {}).some((p) => t === p || t.startsWith(p + "?"));
    const strays = found.filter((t) => !isAllowed(t));
    console.log(`  ${route}  assignments=${found.length}  ${strays.length ? "STRAY: " + strays.join(", ") : "ok"}`);
    if (strays.length) servedBad.push({ route, strays });
  }
  const nav = await (await fetch(ORIGIN + "/buzzy/nav.js", { headers: { "cache-control": "no-cache" } })).text();
  const navStrays = [...nav.matchAll(ASSIGN)]
    .map((m) => m[1])
    .filter((t) => !Object.keys(HARD_NAV_ALLOW["public/buzzy/nav.js"]).some((p) => t === p || t.startsWith(p + "?")));
  console.log(`  /buzzy/nav.js  ${navStrays.length ? "STRAY: " + navStrays.join(", ") : "ok"}`);
  if (navStrays.length) servedBad.push({ route: "/buzzy/nav.js", strays: navStrays });
}

const fail = bad.length > 0 || servedBad.length > 0;
console.log(`\nVERDICT ${fail ? "FAIL" : "PASS"}  tree_strays=${bad.length} served_strays=${servedBad.length}`);
process.exit(fail ? 1 : 0);
