// The privacy modes keep their own colours (owner, 2026-11-21): "open should be green,
// advocate should be yellow, lockdown should be red. But right now, the open icon is yellow…
// So be careful with that."
//
// A guard that needs no browser, so CI can run it: it reads public/buzzy/privacy.css and holds
// it to three rules.
//   1. Every colour a rule gives to ONE mode (its selector names data-mode="open" / "advocate" /
//      "lockdown") is that mode's: green, yellow, red. Greys (white or dark label text) are fine.
//   2. The button has a colour for each mode in every state a person can put it in: at rest,
//      pointer over it, its picker open, keyboard focus, and the same in the light theme.
//      (Hover and the open picker once painted EVERY mode yellow, and Open had none of its own.)
//   3. The states that belong to no mode (.privacy-btn:hover, [aria-expanded], :focus-visible)
//      set no hue at all, because a hue there lands on all three modes.
// The picture itself is scripts/probe-mode-colors.mjs (a real browser, both themes).
//   usage: node scripts/test-mode-colors.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "public/buzzy/privacy.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log("ok   ", name);
  else { failed++; console.log("FAIL ", name, detail ? "— " + detail : ""); }
};

// ── a small rule reader: top-level blocks, and the blocks inside an @media ───────────────
function blocks(text) {
  const out = [];
  let depth = 0, start = 0, head = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") { if (depth === 0) { head = text.slice(start, i).trim(); start = i + 1; } depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = text.slice(start, i);
        if (head.startsWith("@")) { if (/^@media/.test(head)) out.push(...blocks(body)); }
        else out.push({ selector: head, body });
        start = i + 1;
      }
    }
  }
  return out;
}
const rules = [];
for (const b of blocks(css)) {
  const decls = {};
  for (const d of b.body.split(";")) {
    const at = d.indexOf(":");
    if (at > 0) decls[d.slice(0, at).trim().toLowerCase()] = d.slice(at + 1).trim();
  }
  for (const sel of b.selector.split(",").map((s) => s.trim()).filter(Boolean)) rules.push({ selector: sel, decls });
}

// ── colours → family ─────────────────────────────────────────────────────────────────────
const COLOR_PROPS = ["color", "background", "background-color", "border-color", "border", "outline", "outline-color"];
function hexes(value) {
  return [...String(value || "").matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)].map((m) => {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  });
}
function family([r8, g8, b8]) {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return "grey";
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h >= 85 && h <= 170) return "green";
  if (h >= 38 && h < 65) return "yellow";
  if (h >= 340 || h <= 14) return "red";
  return "other";
}
const WANT = { open: "green", advocate: "yellow", lockdown: "red" };
const modeOf = (sel) => {
  const m = [...sel.matchAll(/data-mode="(open|advocate|lockdown)"/g)].map((x) => x[1]);
  return m.length === 1 ? m[0] : null;
};
const hued = (decls) => COLOR_PROPS.flatMap((p) => hexes(decls[p]).map((rgb) => ({ prop: p, family: family(rgb) }))).filter((c) => c.family !== "grey");

// 1. a colour given to one mode is that mode's
const wrong = [];
let seen = 0;
for (const r of rules) {
  const mode = modeOf(r.selector);
  if (!mode) continue;
  for (const c of hued(r.decls)) {
    seen++;
    if (c.family !== WANT[mode]) wrong.push(`${r.selector} { ${c.prop} } is ${c.family}, a ${mode} colour must be ${WANT[mode]}`);
  }
}
check("every colour given to one mode is that mode's colour (" + seen + " checked)", wrong.length === 0, wrong.join("; "));
check("the stylesheet colours all three modes", ["open", "advocate", "lockdown"].every((m) => rules.some((r) => modeOf(r.selector) === m && hued(r.decls).length)));

// 2. the button, in every state, in both themes
const STATES = [
  ["at rest", (s, m, light) => s === `${light}.privacy-btn[data-mode="${m}"]`],
  ["pointer over it", (s, m, light) => s === `${light}.privacy-btn[data-mode="${m}"]:hover`],
  ["picker open", (s, m, light) => s === `${light}.privacy-btn[data-mode="${m}"][aria-expanded="true"]`],
  ["keyboard focus", (s, m, light) => s === `${light}.privacy-btn[data-mode="${m}"]:focus-visible`],
];
for (const [themeName, light] of [["dark", ""], ["light", ':root[data-theme="light"] ']]) {
  for (const mode of ["open", "advocate", "lockdown"]) {
    for (const [state, match] of STATES) {
      const found = rules.filter((r) => match(r.selector, mode, light) && hued(r.decls).length);
      check(`${themeName}: ${mode} button has its colour ${state}`, found.length > 0 && found.every((r) => hued(r.decls).every((c) => c.family === WANT[mode])));
    }
  }
}

// 3. the states that belong to no mode set no hue
const shared = rules.filter((r) => /^(?::root\[data-theme="light"\] )?\.privacy-btn(:hover|\[aria-expanded="true"\]|:focus-visible)?$/.test(r.selector) && !modeOf(r.selector));
check("the button's mode-free states exist", shared.length >= 3);
check("the button's mode-free states set no hue (it would land on all three modes)", shared.every((r) => hued(r.decls).length === 0), shared.filter((r) => hued(r.decls).length).map((r) => r.selector).join("; "));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
