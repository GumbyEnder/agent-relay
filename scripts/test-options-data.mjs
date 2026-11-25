// "All options" (/buzzy/options) lists only what BeeZilla has. This test holds the list to that.
//
// public/buzzy/options-data.js gives every option a `src`: "<file>|<exact words in it>". Here
// each one is looked up. When a button is renamed or removed the words go from the file, this
// fails, and the line on the page is fixed in the same commit (a path starting src/ or scripts/
// is from the repo root, anything else is public/buzzy/). When the src is an id, a class, a
// function or an attribute (chatDoIt, aria-label="Send") it only proves the control exists, not
// what it is called, so for those the option's name (each name in a list) has to be in the file
// too: a renamed label cannot hide behind an id that stayed. An entry whose name describes the
// control and is not a label on the page says `label: false`; the test refuses that on an entry
// that does not need it. It also holds the list's shape (every entry says what, where and which
// page), that each page it opens is one the server serves (src/lib/buzzy/pages.nitro.ts), that
// the three privacy modes are drawn in the privacy button's own colours (privacy.css), and that
// the page, its script and the gear link exist.
//
// usage: node scripts/test-options-data.mjs      exit 0 = the list is true to the code
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUZZY = join(ROOT, "public", "buzzy");
let failed = 0;
const fail = (what, why) => { failed++; console.error(`FAIL  ${what}\n      ${why}`); };
const ok = (what) => console.log(`ok    ${what}`);
const read = (path) => readFileSync(path, "utf8");

// A src that names a piece of code (an id, a class, a function, an attribute, a path) and not words a
// person reads: chatDoIt, wb-sk-btn, redo.pop(), aria-label="Send", <button id="del", /buzzy/options.
const isCodeRef = (w) => /^[a-z][\w.()-]*$/.test(w) || /^\/[\w/-]+$/.test(w) || /^<\w+\s[^>]*=/.test(w) || /^[\w-]+="[^"]*"$/.test(w);
// "Undo, Clear, Done" and "Draw / Done" are several labels in one name.
const labelsOf = (name) => name.split(/\s*,\s*|\s+\/\s+/).map((n) => n.trim()).filter(Boolean);
const MODES = ["open", "advocate", "lockdown"];

// ── the data ─────────────────────────────────────────────────────────────────
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(read(join(BUZZY, "options-data.js")), sandbox, { filename: "options-data.js" });
const OPTIONS = sandbox.window.BZ_OPTIONS;
if (!Array.isArray(OPTIONS) || OPTIONS.length < 100) {
  fail("window.BZ_OPTIONS", `expected a list of at least 100 options, got ${Array.isArray(OPTIONS) ? OPTIONS.length : typeof OPTIONS}`);
  process.exit(1);
}

// Pages the server serves: the PAGES set in pages.nitro.ts.
const pagesSrc = read(join(ROOT, "src", "lib", "buzzy", "pages.nitro.ts"));
const pagesList = /const PAGES = new Set\(\[([^\]]*)\]\)/.exec(pagesSrc);
const PAGES = new Set(pagesList ? [...pagesList[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);
if (!PAGES.size) fail("pages.nitro.ts", "could not read the PAGES set");
if (!PAGES.has("options")) fail("pages.nitro.ts", 'PAGES does not list "options", so /buzzy/options would answer 404');

const cache = new Map();
const text = (file) => {
  if (!cache.has(file)) {
    const path = /^(src|scripts)\//.test(file) ? join(ROOT, file) : join(BUZZY, file);
    cache.set(file, existsSync(path) ? read(path) : null);
  }
  return cache.get(file);
};

const seen = new Set();
const blocks = [];
let sourced = 0;
let named = 0;
const modesSeen = [];
OPTIONS.forEach((o, i) => {
  const id = `#${i + 1} ${o && o.group} · ${o && o.name}`;
  for (const k of ["group", "name", "what", "where", "href", "src"]) {
    if (typeof o[k] !== "string" || !o[k].trim()) fail(id, `${k} must be a non-empty string`);
  }
  if (!Array.isArray(o.words) || o.words.length < 1 || o.words.some((w) => typeof w !== "string" || !w.trim())) {
    fail(id, "words must be a list of one or more non-empty strings");
  }
  if (o.label !== undefined && o.label !== false) fail(id, "label can only be false (the name describes the control; it is not a label on the page)");
  if (o.mode !== undefined) {
    if (!MODES.includes(o.mode)) fail(id, `mode "${o.mode}" must be one of ${MODES.join(", ")}`);
    else if (o.group !== "Privacy modes" || String(o.name).toLowerCase() !== o.mode) fail(id, `mode "${o.mode}" belongs on the Privacy modes entry named ${o.mode[0].toUpperCase() + o.mode.slice(1)}`);
    else modesSeen.push(o.mode);
  }
  if (typeof o.what === "string" && o.what.length > 420) fail(id, `what is ${o.what.length} characters: one plain line, please`);
  if (blocks[blocks.length - 1] !== o.group) {
    if (blocks.includes(o.group)) fail(id, `group "${o.group}" comes back after another group: keep each group in one block`);
    blocks.push(o.group);
  }
  const key = `${o.group}|${o.name}|${o.where}`;
  if (seen.has(key)) fail(id, "listed twice (same group, name and where)");
  seen.add(key);

  // href: a page this server serves, with no #hash (no page reacts to one) and no query.
  const m = /^\/buzzy\/([a-z-]+)$/.exec(o.href || "");
  if (!m) fail(id, `href "${o.href}" must be /buzzy/<page> with no #hash or ?query`);
  else if (!PAGES.has(m[1])) fail(id, `href "${o.href}" is not a page pages.nitro.ts serves`);
  else if (!existsSync(join(BUZZY, `${m[1]}.html`))) fail(id, `href "${o.href}" has no public/buzzy/${m[1]}.html`);

  // src: the words are in the file.
  const cut = typeof o.src === "string" ? o.src.indexOf("|") : -1;
  if (cut < 1) { fail(id, `src "${o.src}" must be "<file>|<words in it>"`); return; }
  const file = o.src.slice(0, cut);
  const words = o.src.slice(cut + 1);
  const body = text(file);
  if (body === null) fail(id, `src names ${file}, which does not exist`);
  else if (!body.includes(words)) fail(id, `${file} no longer contains "${words}": the control was renamed or removed. Fix this line.`);
  else {
    sourced++;
    if (!isCodeRef(words)) {
      if (o.label === false) fail(id, "label: false is only for an entry whose src is an id or attribute; this src is words a person reads, so drop it");
    } else if (o.label !== false) {
      // The id proves the control exists, not what it is called: the name has to be in the file too.
      for (const n of labelsOf(String(o.name))) {
        if (body.includes(n)) named++;
        else fail(id, `src "${words}" is code, and ${file} has no "${n}": the label may have been renamed. Fix the name, or write label: false if the name describes the control and is not a label on the page.`);
      }
    }
  }
});
for (const m of MODES) {
  const n = modesSeen.filter((x) => x === m).length;
  if (n !== 1) fail(`privacy mode "${m}"`, `${n} entries carry mode: "${m}"; exactly one must (the page draws its name in the mode's colour)`);
}
if (!failed) ok(`${OPTIONS.length} options in ${blocks.length} groups, each with its words found in the code (${sourced} sources checked, ${named} names of id-based entries found in their files)`);

// ── the page ─────────────────────────────────────────────────────────────────
const pagePath = join(BUZZY, "options.html");
if (!existsSync(pagePath)) fail("options.html", "public/buzzy/options.html is missing");
else {
  const page = read(pagePath);
  if (!/<script src="\/buzzy\/options-data\.js"><\/script>/.test(page)) fail("options.html", "it must load /buzzy/options-data.js");
  if (!/<title>BeeZilla — All options<\/title>/.test(page)) fail("options.html", "the title must be “BeeZilla — All options”");
  if (/document\s*\.\s*addEventListener\(\s*["'](click|mousedown|pointerdown|pointerup)["']/.test(page)) {
    fail("options.html", "BeeZilla's rule: nothing closes on a click outside it (Esc or an X only)");
  }
  ok("options.html loads the data and keeps the page rules");

  // The three privacy modes are drawn in the privacy button's colours: Open green, Advocate yellow,
  // Lockdown red (owner, 2026-11-21). A recolour in privacy.css has to reach this page too.
  const privacyCss = read(join(BUZZY, "privacy.css"));
  let colours = 0;
  for (const m of MODES) {
    const want = new RegExp(`\\.privacy-btn\\[data-mode="${m}"\\]\\s*\\{\\s*color:\\s*(#[0-9a-f]{6})\\s*;`, "i").exec(privacyCss);
    const have = new RegExp(`--bz-mode-${m}:\\s*(#[0-9a-f]{6})\\s*;`, "i").exec(page);
    const used = new RegExp(`\\.ao-item\\[data-mode="${m}"\\]\\s+\\.ao-name\\s*\\{\\s*color:\\s*var\\(--bz-mode-${m}\\)`).test(page);
    if (!want) fail(`${m} colour`, `privacy.css has no .privacy-btn[data-mode="${m}"] { color: #xxxxxx; } rule to copy the colour from`);
    else if (!have) fail(`${m} colour`, `options.html has no --bz-mode-${m}: #xxxxxx;`);
    else if (want[1].toLowerCase() !== have[1].toLowerCase()) fail(`${m} colour`, `options.html draws ${m} in ${have[1]} but the privacy button uses ${want[1]}`);
    else if (!used) fail(`${m} colour`, `options.html never uses --bz-mode-${m} for the name of the ${m} option (.ao-item[data-mode="${m}"] .ao-name)`);
    else colours++;
  }
  if (colours === MODES.length) ok("Open, Advocate and Lockdown are drawn in the privacy button's colours");
}

// ── the way in: the settings gear ────────────────────────────────────────────
if (!read(join(BUZZY, "nav.js")).includes('href="/buzzy/options"')) fail("nav.js", 'the settings gear has no link to href="/buzzy/options"');
else ok("the settings gear links to All options");

if (failed) {
  console.error(`\n${failed} problem${failed === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log("\nAll options is true to the code.");
