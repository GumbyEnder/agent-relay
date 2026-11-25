/**
 * The page analytics shim must survive a page that already owns `window.op`.
 *
 * Guard for the 2026-11-23 finding on /buzzy/sketch: pages.nitro.ts injects the
 * OpenPanel snippet at the LAST </body>, i.e. after the page's own markup. sketch.html
 * carried `<select id="op">`, and an element id creates a `window.op` named-access
 * global — truthy, an object, not callable. The documented `window.op = window.op || shim`
 * therefore kept the element, and the next line threw
 * "Uncaught TypeError: window.op is not a function" at both 390 and 1280. That page
 * was invisible to OpenPanel and noisy in every QA probe.
 *
 * Two things are asserted, because either alone would let the bug back in:
 *   1. the shim installs when window.op is absent or not callable (run here in a VM,
 *      against a fake window, using the exact guard + init lines from pages.nitro.ts);
 *   2. no served page re-creates the collision — no id="op", no top-level
 *      var/let/const/function named op, no page assignment to window.op.
 *
 * Run: `npx tsx scripts/test-page-analytics-shim.ts` (wired into test:ci).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

let failed = 0;
const ok = (label: string) => console.log(`ok   ${label}`);
const fail = (label: string, detail: string) => {
  failed += 1;
  console.error(`FAIL ${label}: ${detail}`);
};

const root = join(import.meta.dirname, "..");
const pub = join(root, "public", "buzzy");
const pagesFile = join(root, "src", "lib", "buzzy", "pages.nitro.ts");
const src = readFileSync(pagesFile, "utf8");

// ── 1. the shim's own code, taken from the source that ships ─────────────────
const naked = src.includes("window.op=window.op||");
if (naked) fail("shim guard", "pages.nitro.ts still uses `window.op=window.op||…`; a page-owned window.op survives it");
else ok("shim no longer trusts any existing window.op");

const lineWith = (needle: string) => src.split("\n").find((l) => l.includes(needle)) ?? "";
/** Pull the JS out of one quoted line of the snippet array (drops the trailing quote/comma). */
const jsFromLine = (line: string, start: string) => {
  const i = line.indexOf(start);
  if (i < 0) return "";
  let body = line.slice(i).trim();
  body = body.replace(/["'`],?$/, "");
  return body.replace(/\\"/g, '"');
};

const guardLine = jsFromLine(lineWith("if(typeof window.op!=='function')"), "if(");
const initLine = jsFromLine(lineWith("window.op('init'"), "try{").replace(
  /\$\{openpanelClientId\(host\)\}/g,
  "test-client",
);
if (!initLine.startsWith("try{window.op('init'")) fail("shim init", "could not read the init call out of pages.nitro.ts");
else ok("shim init call is wrapped so one bad op cannot break the page");

// ── 2. run the shim against both windows a page can hand it ──────────────────
if (guardLine && initLine) {
  const code = `(function(){${guardLine}${initLine}})();`;
  const run = (win: Record<string, unknown>) => {
    const ctx = vm.createContext({ window: win, console: { warn() {} }, Proxy });
    vm.runInContext(code, ctx);
    return win;
  };

  // a) nothing there: the queue proxy must be installed and callable.
  const empty = run({});
  const op = empty.op as ((...args: unknown[]) => void) & { q: unknown[] } | undefined;
  if (typeof op !== "function") fail("shim installs on a bare window", `typeof window.op is ${typeof op}`);
  else if (!Array.isArray((op as unknown as { q: unknown[] }).q)) fail("shim queue", "window.op.q is not an array");
  else ok("bare window gets a callable window.op with a queue");

  // b) a page-owned element (the sketch bug): it must be replaced, not kept.
  const element = { tagName: "SELECT" };
  const shadowed = run({ op: element });
  if (typeof shadowed.op !== "function") fail("shim overrides an element id=op", "window.op is still the element");
  else ok("an element named op is replaced by the callable shim");

  // c) op1.js already loaded: a real function is left alone and not re-wrapped.
  const theirs = Object.assign(function realOp() {}, { q: ["queued"] });
  const real = run({ op: theirs });
  if (real.op !== theirs) fail("shim leaves a real op alone", "the existing function was replaced");
  else ok("an existing callable op is not replaced");
}

// ── 3. no served page may re-create the collision ────────────────────────────
const pages = readdirSync(pub).filter((f) => f.endsWith(".html"));
if (!pages.length) fail("pages", `no .html files under ${pub}`);

for (const file of pages) {
  const html = readFileSync(join(pub, file), "utf8");
  const idOp = /id\s*=\s*["']op["']/.exec(html);
  if (idOp) fail(`${file} id="op"`, "an element id of op becomes a window.op global and kills the analytics shim");

  // Top-level declarations in an inline script are globals too.
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = m[1];
    const top = /^(?:var|let|const|function)\s+op\b/m.exec(body);
    if (top) fail(`${file} top-level \`${top[0]}\``, "a global named op shadows the analytics shim");
    if (/window\.op\s*=/.test(body)) fail(`${file} assigns window.op`, "the page must leave window.op to the shared shim");
  }
}
if (failed === 0) ok(`no page among ${pages.length} shadows window.op`);

// ── 4. the sketch page still has its own shape-style control, renamed ────────
const sketch = readFileSync(join(pub, "sketch.html"), "utf8");
if (!/id="opMode"/.test(sketch)) fail("sketch control", "sketch.html has no id=opMode");
else if (!/getElementById\("opMode"\)/.test(sketch)) fail("sketch wiring", "sketch.html never reads #opMode");
else ok("sketch.html keeps the shape-style control as #opMode");

console.log(failed === 0 ? "\npage analytics shim: 0 failures" : `\npage analytics shim: ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
