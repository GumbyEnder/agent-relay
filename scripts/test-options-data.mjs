// "All options" (/buzzy/options) lists only what BeeZilla has. This test holds the list to that.
//
// public/buzzy/options-data.js gives every option a `src`: "<file>|<exact words in it>". Here
// each one is looked up. When a button is renamed or removed the words go from the file, this
// fails, and the line on the page is fixed in the same commit (a path starting src/ or scripts/
// is from the repo root, anything else is public/buzzy/). When the src is code (an id, a class,
// an attribute or a link's address: chatDoIt, aria-label="Send") it only proves the control
// exists, not what it is called, so the test finds that control and looks for the option's name
// (each name in a list) ON it: the words inside it, its aria-label, title, placeholder or alt, a
// field's <label>. Words elsewhere in the file, a comment included, do not count, so a renamed
// label cannot hide behind an id that stayed; code that names no control (a function) is refused.
// An entry whose control has no words of its own (the swatches) says `label: false`; the test
// refuses that on a control that has words, and checks itself on made-up samples. It also holds
// the list's shape (every entry says what, where and which page), that each page it opens is one
// the server serves (src/lib/buzzy/pages.nitro.ts), that the three privacy modes are drawn in the
// privacy button's own colours (privacy.css), and that the page, its script and the gear link exist.
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

// ── the control a code src names, and the words on it ────────────────────────
const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const FIELDS = new Set(["input", "select", "textarea"]);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// Attributes, also in markup written inside a script's strings (class=\"x\").
const attrsOf = (raw) => {
  const out = {};
  for (const m of raw.matchAll(/([\w:-]+)\s*=\s*(\\?["'])([\s\S]*?)\2/g)) out[m[1].toLowerCase()] = m[3];
  return out;
};
const textOf = (html) => html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const literals = (code) => [...code.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1] ?? m[2]);
// What a code src points at: <button id="del" (a tag), aria-label="Send" (an attribute),
// /buzzy/options (a link's address) or chatDoIt / wb-sk-btn (an id or a class). A function
// (removeSelected, redo.pop()) is no control: null.
function refMatcher(ref) {
  if (/^<\w/.test(ref)) return (tag) => tag.raw.startsWith(ref);
  const attr = /^([\w-]+)="([^"]*)"$/.exec(ref);
  if (attr) return (tag) => tag.attrs[attr[1].toLowerCase()] === attr[2];
  if (ref.startsWith("/")) return (tag) => tag.attrs.href === ref;
  if (/^[a-zA-Z][\w-]*$/.test(ref)) return (tag) => tag.attrs.id === ref || String(tag.attrs.class || "").split(/\s+/).includes(ref);
  return null;
}
// The words inside an element: up to its own closing tag (nested ones of the same name counted),
// and only when that is near (markup pieced together in a script may not close at all).
function innerText(body, name, from) {
  const re = new RegExp(`<(/?)${escRe(name)}\\b[^<>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(body); m && m.index - from < 1500; m = re.exec(body)) {
    depth += m[1] ? -1 : 1;
    if (!depth) return textOf(body.slice(from, m.index));
  }
  return "";
}
// Every control in `body` that `ref` names, each with the words a person sees on it or hears for
// it: its text, aria-label, title, placeholder or alt (a button-like input's value; a field's
// <label>, named by for= or right before it). whiteboard.js builds its controls with
// el("tag", "classes", text) and may give one words on the lines after, until it is put in place.
function controlsIn(body, ref) {
  const match = refMatcher(ref);
  if (!match) return [];
  const found = [];
  for (const t of body.matchAll(/<([a-zA-Z][\w-]*)(\s[^<>]*?)?\/?>/g)) {
    const tag = { name: t[1].toLowerCase(), raw: t[0], attrs: attrsOf(t[2] || "") };
    if (!match(tag)) continue;
    const words = ["aria-label", "title", "placeholder", "alt"].map((a) => tag.attrs[a]);
    if (tag.name === "input" && /^(button|submit|reset)$/i.test(tag.attrs.type || "")) words.push(tag.attrs.value);
    if (!VOID.has(tag.name)) words.push(innerText(body, tag.name, t.index + t[0].length));
    if (FIELDS.has(tag.name)) {
      const id = tag.attrs.id;
      const named = id && new RegExp(`<label\\b[^<>]*\\bfor=\\\\?["']${escRe(id)}\\\\?["'][^<>]*>([\\s\\S]*?)</label>`).exec(body);
      const before = /<label\b[^<>]*>((?:(?!<label\b)[\s\S])*?)<\/label>\s*$/.exec(body.slice(Math.max(0, t.index - 400), t.index));
      const label = named || before;
      if (label) words.push(textOf(label[1]));
    }
    found.push({ tag: tag.name, words: words.filter(Boolean) });
  }
  const lines = body.split("\n");
  lines.forEach((line, i) => {
    for (const e of line.matchAll(/(?:\b(\w+)\s*=\s*)?\bel\(\s*(["'])([\w-]+)\2\s*,\s*(["'])([^"']*)\4([^;]*)/g)) {
      if (!match({ name: e[3], raw: "", attrs: { class: e[5] } })) continue;
      const words = literals(e[6]);
      const v = e[1] && escRe(e[1]);
      for (const next of v ? lines.slice(i + 1, i + 20) : []) {
        if (new RegExp(`\\.appendChild\\(\\s*${v}\\s*\\)`).test(next)) break;
        const set = new RegExp(`\\b${v}\\.(?:title|textContent|innerText|placeholder)\\s*=([^;]*)|\\b${v}\\.setAttribute\\(\\s*["'](?:aria-label|title|placeholder)["']\\s*,([^;]*)|\\b${v}\\.appendChild\\(\\s*el\\([^,]*,[^,]*,([^;]*)`).exec(next);
        if (set) words.push(...literals(set[1] ?? set[2] ?? set[3]));
      }
      found.push({ tag: e[3], words: words.filter(Boolean) });
    }
  });
  return found;
}
// What is wrong with an entry whose src is code, or null: its name is not on the control the code
// names, the code names no control, or it says label: false on a control that has words.
function nameProblem(o, ref, body, file) {
  const controls = controlsIn(body, ref);
  if (!controls.length) return `src "${ref}" is code that names no control in ${file} (no element with that id, class, attribute or address): point src at the control, or at the words on it.`;
  const words = controls.flatMap((c) => c.words);
  const says = words.length ? words.map((w) => `“${w.slice(0, 50)}”`).join(", ") : "nothing";
  if (o.label === false) {
    return words.length ? `label: false, but the control "${ref}" names has words of its own (${says}): drop label: false and give the option the name on it.` : null;
  }
  const missing = labelsOf(String(o.name)).filter((n) => !words.some((w) => w.includes(n)));
  if (!missing.length) return null;
  return `the control "${ref}" names in ${file} does not say "${missing.join('", "')}" (it says ${says}): the label may have been renamed. Fix the name` +
    (words.length ? "." : ", or write label: false if the control has no words and the name describes it.");
}

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
let described = 0;
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
      if (o.label === false) fail(id, "label: false is only for an entry whose src is code naming a control with no words; this src is words a person reads, so drop it");
    } else {
      // The code proves the control exists, not what it is called: the name has to be ON it.
      const problem = nameProblem(o, words, body, file);
      if (problem) fail(id, problem);
      else if (o.label === false) described++;
      else named++;
    }
  }
});
for (const m of MODES) {
  const n = modesSeen.filter((x) => x === m).length;
  if (n !== 1) fail(`privacy mode "${m}"`, `${n} entries carry mode: "${m}"; exactly one must (the page draws its name in the mode's colour)`);
}
if (!failed) ok(`${OPTIONS.length} options in ${blocks.length} groups, each with its words found in the code (${sourced} sources checked; ${named} names found on the control their code names, ${described} controls with no words of their own)`);

// ── the name check itself, on made-up samples ────────────────────────────────
// A label renamed behind an id that stayed is caught although a comment still says the old
// name; label: false is refused on a control that has words; a function is no control. And it
// still finds the names the real files carry: in a script's strings, in a field's <label>, in el().
const SAMPLES = [
  ["a label renamed behind an id that stayed (a comment still says the old name)", { name: "Do it" }, "chatDoIt",
    '<!-- the Do it button -->\n<button id="chatDoIt" type="button" title="Stop asking">Go</button>\n<script>// Do it: stop asking</script>', false],
  ["label: false on a control that has words", { name: "Do it", label: false }, "chatDoIt", '<button id="chatDoIt">Do it</button>', false],
  ["a function, not a control", { name: "Remove" }, "removeSelected", 'function removeSelected() {}\nb.textContent = "Remove";', false],
  ["label: false on an el() control a later line gives a title", { name: "Colours", label: false }, "wb-sk-swatches",
    'var sw = el("span", "wb-sk-swatches");\nsw.title = "Ink colours";\nstrip.appendChild(sw);', false],
  ["the name on the control, over two lines", { name: "Do it" }, "chatDoIt", '<button id="chatDoIt" class="secondary"\n    title="Stop asking">Do it</button>', true],
  ["markup in a script's strings", { name: "Open" }, "fw-open", 'h += "<button type=\\"button\\" class=\\"secondary fw-open\\" data-key=\\"" + k + "\\">Open</button>";', true],
  ["a field named by the <label> before it", { name: "Background" }, "cvBg",
    '<div class="row"><label>Width</label><input id="cvW" /></div><div class="row"><label>Background</label><input id="cvBg" type="color" value="#141414" /></div>', true],
  ["el() with its words", { name: "Draw / Done" }, "wb-sk-btn", 'var b = el("button", "wb-sk-btn", on ? "Done" : "Draw");', true],
  ["label: false on an el() control with no words", { name: "Colours", label: false }, "wb-sk-swatches",
    'var sw = el("span", "wb-sk-swatches");\nINK.forEach(function (c) { var b = el("button", "wb-sk-ink"); b.title = c; sw.appendChild(b); });\nstrip.appendChild(sw);', true],
];
let samplesRight = 0;
for (const [what, o, ref, body, passes] of SAMPLES) {
  const problem = nameProblem(o, ref, body, "the sample");
  if (!problem === passes) samplesRight++;
  else fail(`the name check: ${what}`, passes ? `refused it: ${problem}` : "let it through");
}
if (samplesRight === SAMPLES.length) ok(`the name check catches a renamed label, a needless label: false and a function, and passes the right ones (${SAMPLES.length} samples)`);

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
