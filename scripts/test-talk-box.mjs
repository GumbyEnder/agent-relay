// The Talk button keeps its size however much is typed or pasted (owner, 2026-11-22):
//   "the talk to it button gets larger the more text I put in the text field, especially
//    when I copy and paste a large amount. It really goes out of proportion. Massive
//    button, little text. Maybe we just pin the button to the top of it and allow the
//    text box to grow without growing the button."
//
// A guard that needs no browser, so CI can run it. The picture itself is
// scripts/probe-talk-box.mjs (a real browser: a 40-line and a 400-line paste, the page's
// bar, the board's top edge, a phone).
//
//   1. The bar lines its parts up at the TOP (never `stretch`, which made the button as
//      tall as the box). The button, the paper clip row and Do it / Send are all given the
//      height of one line of the box (--tb-h), worked out from the box's own line and
//      padding, so they can't grow with it.
//   2. Every place the bar lives (the page, the board's top edge, a phone) sets what that
//      one-line height is made of, and nothing sets the box's own padding any other way.
//   3. The box's limit is a CSS variable (--tf-max) the script reads back; there is no
//      second, hard-coded limit that could drift from it.
//   4. fit(), the function that sizes the box, behaves: the box takes the height of the
//      words up to the limit and then scrolls; two lines make the bar a rounded box (not a
//      pill that cuts into the words); a box that is hidden is left alone (it measures 0
//      tall and would otherwise collapse to nothing).
//
//   usage: node scripts/test-talk-box.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (f) => readFileSync(path.join(root, f), "utf8");

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log("ok   ", name); }
  else { failed++; console.log("FAIL ", name, detail ? "— " + detail : ""); }
};

// ── a small stylesheet reader: every rule, with the @media it sits in ─────────────────────
function rulesOf(css, media = "") {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let depth = 0, start = 0, head = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") { if (depth === 0) { head = css.slice(start, i).trim(); start = i + 1; } depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = css.slice(start, i);
        if (head.startsWith("@media")) out.push(...rulesOf(body, head.replace(/^@media\s*/, "")));
        else if (!head.startsWith("@")) {
          const decls = {};
          for (const d of body.split(";")) {
            const at = d.indexOf(":");
            if (at > 0) decls[d.slice(0, at).trim().toLowerCase()] = d.slice(at + 1).trim().replace(/\s+/g, " ");
          }
          for (const selector of head.split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean)) out.push({ selector, media, decls });
        }
        start = i + 1;
      }
    }
  }
  return out;
}

const talkHtml = read("public/buzzy/talk.html");
const styleText = [...talkHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
const sheets = {
  "talk.html": rulesOf(styleText),
  "whiteboard.css": rulesOf(read("public/buzzy/whiteboard.css")),
  "oneboard.css": rulesOf(read("public/buzzy/oneboard.css")),
  "calm.css": rulesOf(read("public/buzzy/calm.css")),
};
const all = Object.entries(sheets).flatMap(([file, rules]) => rules.map((r) => ({ ...r, file })));
const find = (selector, media = "") => all.filter((r) => r.selector === selector && r.media === media);
const declared = (selector, prop, media = "") => find(selector, media).map((r) => r.decls[prop]).filter(Boolean).pop();

// ── 1. the parts line up at the top, at one line's height ────────────────────────────────
console.log("The bar lines its parts up at the top");
check(".talk-bar aligns at the top, not stretched", declared(".talk-bar", "align-items") === "flex-start", String(declared(".talk-bar", "align-items")));
check("nothing makes a part of the bar stretch with the box",
  !all.some((r) => /(^|\s)\.(talk-btn|talk-extras|talk-actions)\b/.test(r.selector) && r.decls["align-self"] === "stretch"));
check("the Talk button is one line tall (height: var(--tb-h))", declared(".talk-btn", "height") === "var(--tb-h)", String(declared(".talk-btn", "height")));
check("the paper clip and privacy row is one line tall and at the top",
  declared(".talk-extras", "height") === "var(--tb-h)" && declared(".talk-extras", "align-self") === "flex-start");
check("Do it and Send stay on the first line", declared(".talk-actions", "align-self") === "flex-start");
check("the box itself is at least one line (min-height: var(--tb-h))", declared(".talk-field", "min-height") === "var(--tb-h)");
check("the one-line height is the box's own line plus its padding plus its border (or the button's own least height)",
  /^max\(calc\(var\(--tf-line\) \+ var\(--tf-padt\) \+ var\(--tf-padb\) \+ 2px\), var\(--tb-min\)\)$/.test(declared(".talk-bar", "--tb-h") || ""),
  String(declared(".talk-bar", "--tb-h")));

// ── 2. every place the bar lives says what one line is made of ───────────────────────────
console.log("\nEvery place the bar lives");
check("the box's padding and line height come from the variables, in one place",
  declared(".composer-card .talk-field #chatInput", "padding") === "var(--tf-padt) 0 var(--tf-padb)" &&
  declared(".composer-card .talk-field #chatInput", "line-height") === "var(--tf-line)");
const padders = all.filter((r) => /#chatInput/.test(r.selector) && /talk-field/.test(r.selector) && r.decls["padding"] && r.decls["padding"] !== "var(--tf-padt) 0 var(--tf-padb)");
check("no other rule gives the box a padding of its own (it would break the one-line height)", padders.length === 0, padders.map((r) => `${r.file}: ${r.selector} { padding: ${r.decls.padding} }`).join("; "));
check("the board's top edge sets its own padding, limit and least button height",
  ["--tf-padt", "--tf-padb", "--tf-max", "--tb-min"].every((v) => declared(".wb-dock .talk-bar", v)));
check("the page's bar sets the button's least height", declared(".ob-start .talk-bar", "--tb-min") === declared(".ob-start .talk-btn", "min-height"),
  `${declared(".ob-start .talk-bar", "--tb-min")} vs ${declared(".ob-start .talk-btn", "min-height")}`);
check("the board's bar sets the button's least height to match the button's own",
  declared(".wb-dock .talk-bar", "--tb-min") === declared(".wb-dock .talk-btn", "min-height"));
check("a phone sets the box's padding too", ["--tf-padt", "--tf-padb"].every((v) => declared(".talk-bar", v, "(max-width: 640px)")));

// ── 3. one limit, a variable the script reads back ───────────────────────────────────────
console.log("\nThe box's limit");
check("the box's limit is var(--tf-max)", declared(".composer-card .talk-field #chatInput", "max-height") === "var(--tf-max)");
check("the box scrolls once it reaches the limit", declared(".composer-card .talk-field #chatInput", "overflow-y") === "auto");
check("the page's limit is a share of the window's height, between a floor and a ceiling", /^clamp\([\d.]+rem, [\d.]+vh, [\d.]+rem\)$/.test(declared(".talk-bar", "--tf-max") || ""));
check("the board's top edge has a lower limit than the page", (() => {
  const pg = (declared(".talk-bar", "--tf-max") || "").match(/clamp\(([\d.]+)rem, ([\d.]+)vh, ([\d.]+)rem\)/);
  const bd = (declared(".wb-dock .talk-bar", "--tf-max") || "").match(/clamp\(([\d.]+)rem, ([\d.]+)vh, ([\d.]+)rem\)/);
  return !!(pg && bd) && +bd[2] < +pg[2] && +bd[3] < +pg[3];
})());
check("no hard-coded limit in the script (it reads max-height back from the CSS)", !/Math\.min\([^)]*,\s*144\)/.test(talkHtml));

// ── 4. a bar of two lines is a rounded box ───────────────────────────────────────────────
console.log("\nA grown bar is a rounded box");
check("the page's grown bar and box have their own corners (wider windows)",
  declared(".talk-bar.is-grown", "border-radius", "(min-width: 641px)") && declared(".talk-bar.is-grown .talk-field", "border-radius", "(min-width: 641px)"));
check("the board's grown bar and box have theirs",
  declared(".wb-dock .talk-bar.is-grown", "border-radius", "(min-width: 641px)") && declared(".wb-dock .talk-bar.is-grown .talk-field", "border-radius", "(min-width: 641px)"));
check("the drop hint takes the bar's corners, whatever they are", declared(".talk-drop-hint", "border-radius") === "inherit");
const GROWN_HEAD = ".wb-head:has(.talk-bar.is-grown)";
check("the board's title and buttons stay level with the first line of a grown bar (wide windows)",
  declared(GROWN_HEAD, "align-items", "(min-width: 761px)") === "flex-start" &&
  [`${GROWN_HEAD} .wb-title`, `${GROWN_HEAD} .wb-tools`].every((s) => declared(s, "min-height", "(min-width: 761px)") === "3.75rem"));
check("…and nothing moves while the bar is one line (the rule only applies to a grown bar)",
  !find(".wb-head", "(min-width: 761px)").some((r) => r.decls["align-items"] === "flex-start") &&
  !find(".wb-title", "(min-width: 761px)").some((r) => r.decls["min-height"]));
check("3.75rem is the board's bar as one line (its box's line and padding, its padding and its border)", (() => {
  const rem = (v) => parseFloat(v) * 16;
  const dock = ".wb-dock .talk-bar";
  const oneLine = Math.max(rem(declared(".talk-bar", "--tf-line")) + rem(declared(dock, "--tf-padt")) + rem(declared(dock, "--tf-padb")) + 2, rem(declared(dock, "--tb-min")));
  const outer = oneLine + 2 * rem(declared(dock, "padding")) + 2;
  return Math.abs(outer - rem("3.75rem")) < 0.5;
})());

// ── 5. fit(), the function that sizes the box ────────────────────────────────────────────
console.log("\nfit()");
const from = talkHtml.indexOf("function fit() {");
const to = talkHtml.indexOf('input.addEventListener("input", fit);', from);
check("fit() is in the page", from > 0 && to > from);
const fitSource = talkHtml.slice(from, to);

function runFit({ scrollHeight, pad = 30.4, max = "304px", hidden = false, value = "x", scrollTop = 0, height = "55px" }) {
  const classes = new Set(["is-grown"]);
  const real = { height };
  const setLog = [];
  const input = {
    value, scrollHeight, scrollTop,
    style: new Proxy(real, { set(t, k, v) { if (k === "height") setLog.push(v); t[k] = v; return true; } }),
    getClientRects: () => (hidden ? [] : [{}]),
  };
  const bar = { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, remove: (c) => classes.delete(c) } };
  const win = { getComputedStyle: () => ({ paddingTop: String(pad / 2) + "px", paddingBottom: String(pad / 2) + "px", lineHeight: "25.6px", maxHeight: max }) };
  // the function reads input, bar and window from the code around it
  vm.runInNewContext(`(function (input, bar, window) { ${fitSource}; fit(); })`, {})(input, bar, win);
  return { height: real.height, setLog, classes: [...classes].sort(), scrollTop: input.scrollTop };
}

const one = runFit({ scrollHeight: 56 });
check("one line: the box is one line tall", parseFloat(one.height) === 25.6, JSON.stringify(one));
check("one line: has-text is set when there are words", one.classes.includes("has-text"));
const three = runFit({ scrollHeight: 30.4 + 25.6 * 3 });
check("three lines: the box is three lines tall", Math.abs(parseFloat(three.height) - 76.8) < 0.01, JSON.stringify(three));
const huge = runFit({ scrollHeight: 20505 });
check("a huge paste: the box stops at the limit (304px)", parseFloat(huge.height) === 304, JSON.stringify(huge));
const none = runFit({ scrollHeight: 20505, max: "none" });
check("if the limit can't be read the box still stops somewhere sensible (144px)", parseFloat(none.height) === 144, JSON.stringify(none));
const spaces = runFit({ scrollHeight: 56, value: "   " });
check("only spaces: no has-text", !spaces.classes.includes("has-text"));
const empty = runFit({ scrollHeight: 400, value: "" });
check("an empty box is one line whatever its hint does (a hint that wraps in a narrow box must not grow it)",
  empty.height === "" && !empty.classes.includes("has-text"), JSON.stringify(empty));
const hidden = runFit({ scrollHeight: 0, hidden: true, value: "hello" });
check("a hidden box is left alone, not collapsed to 0 tall (but still knows it has words)", hidden.setLog.length === 0 && hidden.classes.includes("has-text"), JSON.stringify(hidden));
const kept = runFit({ scrollHeight: 900, scrollTop: 321 });
check("the box keeps its scroll position while it is measured", kept.scrollTop === 321, String(kept.scrollTop));
check("fit() runs again when the window or the box's width changes",
  /window\.addEventListener\("resize", fit\)/.test(talkHtml) && /new ResizeObserver\(function \(\) \{[\s\S]*?fit\(\);/.test(talkHtml));

// paintGrown(): two lines or more make the bar a rounded box, whoever set the height
const gFrom = talkHtml.indexOf("function paintGrown() {");
const gTo = talkHtml.indexOf("// The words wrap differently when the bar moves", gFrom);
check("paintGrown() is in the page, and the observer calls it", gFrom > 0 && gTo > gFrom && /new ResizeObserver\(function \(\) \{[\s\S]*?paintGrown\(\);/.test(talkHtml));
function runGrown(clientHeight) {
  const classes = new Set();
  const input = { clientHeight };
  const bar = { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
  const win = { getComputedStyle: () => ({ paddingTop: "15.2px", paddingBottom: "15.2px", lineHeight: "25.6px" }) };
  vm.runInNewContext(`(function (input, bar, window) { ${talkHtml.slice(gFrom, gTo)}; paintGrown(); })`, {})(input, bar, win);
  return classes.has("is-grown");
}
check("one line is not 'grown'", runGrown(56) === false);
check("two lines are 'grown'", runGrown(30.4 + 25.6 * 2) === true);
check("a hidden box (0 tall) is not 'grown'", runGrown(0) === false);

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
