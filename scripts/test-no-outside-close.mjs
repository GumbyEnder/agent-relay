// Nothing closes on a click outside it: only Esc or an X (owner, 2026-11-21: "That's a
// fundamental principle of our design: no click-outside-to-close. Escape key or an X
// closes anything that opens up").
//
// A source guard for the pages and scripts in public/buzzy. It fails when a dialog,
// pop-up or panel is written so that a press on the page around it closes it:
//   1. a click handler on a backdrop / scrim / overlay that closes the box, and
//   2. a document-level click listener that checks `contains(e.target)` and closes.
// The few that remain are menus that hold nothing to lose (they close when you choose
// something, on Esc, or on a press away) and the QR code pop-up that the share window
// replaces; each is listed below with its reason. A new one is a decision: fix it, or add
// it here with the reason, where a reviewer sees it.
//
// usage: node scripts/test-no-outside-close.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../public/buzzy/", import.meta.url).pathname;

/** Menus (nothing typed in them) and the QR pop-up awaiting its replacement. */
const ALLOWED = [
  { file: "nav.js", has: "!more.contains(e.target)", why: "the More menu (no longer shown: the places row replaced it)" },
  { file: "nav.js", has: "a.contains(e.target) || menu.contains(e.target)", why: "the account menu: a plain menu, nothing typed in it" },
  { file: "talk.html", has: "menu.contains(e.target)", why: "Talk's More menu (hidden since the places row)" },
  { file: "browse.js", has: "qrPop.contains(e.target)", why: "the QR code pop-up; the share window (page-share.js) replaces it and asks first" },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "brand" && name !== "zillas" && name !== "icons") walk(p, out); }
    else if (/\.(js|html)$/.test(name)) out.push(p);
  }
  return out;
}

let fails = 0;
let files = 0;
const fail = (msg) => { fails++; console.log("FAIL " + msg); };

// 1. A backdrop that closes the box when pressed.
const BACKDROP_HANDLER = /\b(backdrop|scrim|overlay|veil|shade)\b\s*\.addEventListener\(\s*["']click["']/;
const TARGET_IS_BOX = /addEventListener\(\s*["']click["']\s*,\s*(?:function\s*)?\(?\s*(\w+)\s*\)?\s*(?:=>)?\s*\{?\s*if\s*\(\s*\1\.target\s*===\s*\w+\s*\)\s*\{?\s*(?:close|dismiss|done|hide|remove|fold)\w*\s*\(/;
// 2. A press anywhere on the page that checks it is outside the box.
const OUTSIDE_PRESS = /(?:document|window)\.addEventListener\(\s*["'](?:click|mousedown|pointerdown|mouseup|touchstart)["']/;

for (const file of walk(ROOT)) {
  files++;
  const rel = relative(ROOT, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (BACKDROP_HANDLER.test(line) || TARGET_IS_BOX.test(line)) {
      fail(`${rel}:${i + 1} closes a box when its backdrop is pressed: ${line.trim().slice(0, 110)}`);
    }
    if (OUTSIDE_PRESS.test(line)) {
      // The listener body is the next few lines; the sign of an "outside" close is a contains(e.target) test.
      const body = lines.slice(i, i + 7).join("\n");
      const m = body.match(/\.contains\(\s*(?:e|ev|event)\.target\s*\)/);
      if (m) {
        const ok = ALLOWED.find((a) => rel.endsWith(a.file) && body.includes(a.has));
        if (!ok) fail(`${rel}:${i + 1} closes something when the page around it is pressed (add it to ALLOWED only if nothing typed can be lost in it): ${body.split("\n").slice(0, 3).join(" ").trim().slice(0, 130)}`);
      }
    }
  });
}

// The allowlist stays honest: an entry whose code has gone is removed.
for (const a of ALLOWED) {
  const hit = walk(ROOT).some((f) => f.endsWith(a.file) && readFileSync(f, "utf8").includes(a.has));
  if (!hit) fail(`ALLOWED entry no longer matches any code (remove it): ${a.file} / ${a.has}`);
}

// What this change fixed stays fixed: each of these has its X or Esc and no outside close.
const MUST = [
  ["voice-stage.js", 'document.addEventListener("keydown", onEsc, true)', "the AI key dialog answers Esc wherever focus is"],
  ["privacy.js", 'document.addEventListener("keydown", function (e) {\n    if (e.key !== "Escape"', "the privacy pop-up answers Esc wherever focus is"],
  ["nav.js", 'e.key === "Escape" && isOpen()', "the settings panel answers Esc"],
  ["recipes.html", 'e.key === "Escape"', "the recipe dialogs answer Esc"],
  ["share.js", 'e.key === "Escape"', "the share window answers Esc"],
];
for (const [f, needle, what] of MUST) {
  const found = walk(ROOT).find((p) => p.endsWith("/" + f));
  if (!found || !readFileSync(found, "utf8").includes(needle)) fail(what);
}

console.log(fails ? `${fails} problem(s) in ${files} files` : `no-outside-close: ${files} files read, nothing closes on an outside press`);
process.exit(fails ? 1 : 0);
