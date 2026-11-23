/**
 * Boxes and panels you can drag bigger or smaller (owner, 2026-11-22):
 *   "If I have a box like the conversation history, I could just grab the side or the
 *    corner and grow the size of that so I can see it bigger if I want to. Make it so."
 * ...and, as a BeeZilla design rule from now on, every box that holds something worth
 * reading works this way (docs/BEEZILLA-SCREEN-RULES.md).
 *
 * A guard that needs no browser, so CI can run it. The real thing, in a browser (the corner,
 * every side, zoomed out, Esc, undo, the keyboard, the board, History, Feedback folded up):
 * scripts/probe-resizable-boxes.mjs.
 *
 *   1. The sums (public/buzzy/resize.js, run here without a page): a drag changes the box by
 *      exactly the distance moved; a box held by its left or top edge keeps the opposite edge
 *      where it was, even at its smallest size; a box held by its right or bottom edge grows
 *      toward the other side; a centred box grows both ways; nothing leaves [min, max].
 *   2. The wiring: the page shell loads resize.js on every page; every box in its list is
 *      really there in the page code; the conversation card keeps its size in the card, goes
 *      through undo, and the server keeps the size when the board is saved.
 *   3. The manners: no click-away listener of any kind (nothing closes because a drag ended
 *      somewhere else), Esc during a drag is the drag's own and stops there.
 *   4. The rule is written down, with its question in "Before you ship a screen".
 *
 *   npx tsx scripts/test-resizable-boxes.ts
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { cleanWhiteboard } from "../src/lib/buzzy/whiteboards";

let pass = 0;
let fail = 0;
const ok = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const eq = (a: unknown, b: unknown, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const near = (a: number, b: number, tol = 1e-9, msg = "") => {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} expected ${b} ± ${tol}, got ${a}`);
};

type Box = { w: number; h: number; x: number; y: number };
type Opts = { ax: string; ay: string; minW: number; minH: number; maxW: number; maxH: number };
type Sums = {
  dragBox(start: Box, edge: string, d: { x: number; y: number }, o: Opts): Box;
  sizeBy(start: Box, dw: number, dh: number, o: Opts): Box;
  clamp(v: number, lo: number, hi: number): number;
};

const read = (f: string) => readFileSync(f, "utf8");
const source = read("public/buzzy/resize.js");
// No document here, so the file runs only as far as its sums and hands them over.
const mod: { exports: Partial<Sums> } = { exports: {} };
vm.runInNewContext(source, { module: mod });
const sums = mod.exports as Sums;

const START: Box = { w: 360, h: 480, x: 100, y: 50 };
const O: Opts = { ax: "start", ay: "start", minW: 260, minH: 220, maxW: 3000, maxH: 4000 };
const o = (extra: Partial<Opts> = {}): Opts => ({ ...O, ...extra });

console.log("The sums");

ok("the file hands over its sums when there is no page", () => {
  truthy(typeof sums.dragBox === "function" && typeof sums.sizeBy === "function" && typeof sums.clamp === "function");
});

ok("a box held by its left and top: the corner and each side change it by exactly the distance moved", () => {
  eq(sums.dragBox(START, "se", { x: 120, y: 60 }, o()), { w: 480, h: 540, x: 100, y: 50 }, "corner");
  eq(sums.dragBox(START, "e", { x: 80, y: 99 }, o()), { w: 440, h: 480, x: 100, y: 50 }, "right side");
  eq(sums.dragBox(START, "s", { x: 99, y: -40 }, o()), { w: 360, h: 440, x: 100, y: 50 }, "bottom side");
});

ok("a box held by its left and top: its left and top sides move the edge and keep the opposite one still", () => {
  eq(sums.dragBox(START, "w", { x: -70, y: 0 }, o()), { w: 430, h: 480, x: 30, y: 50 }, "left side");
  eq(sums.dragBox(START, "n", { x: 0, y: -30 }, o()), { w: 360, h: 510, x: 100, y: 20 }, "top side");
  eq(sums.dragBox(START, "nw", { x: -20, y: -20 }, o()), { w: 380, h: 500, x: 80, y: 30 }, "top-left corner");
  eq(sums.dragBox(START, "ne", { x: 25, y: -25 }, o()), { w: 385, h: 505, x: 100, y: 25 }, "top-right corner");
  eq(sums.dragBox(START, "sw", { x: -25, y: 25 }, o()), { w: 385, h: 505, x: 75, y: 50 }, "bottom-left corner");
});

ok("it stops at its smallest size, and the held-still edge never moves once it is reached", () => {
  const r = sums.dragBox(START, "w", { x: 5000, y: 0 }, o());
  eq(r.w, 260);
  eq(r.x + r.w, START.x + START.w, "right edge");
  const t = sums.dragBox(START, "n", { x: 0, y: 5000 }, o());
  eq(t.h, 220);
  eq(t.y + t.h, START.y + START.h, "bottom edge");
  eq(sums.dragBox(START, "e", { x: -5000, y: 0 }, o()).w, 260);
  eq(sums.dragBox(START, "s", { x: 0, y: -5000 }, o()).h, 220);
});

ok("it stops at the room there is, however far the pointer goes", () => {
  eq(sums.dragBox(START, "se", { x: 9000, y: 9000 }, o({ maxW: 700, maxH: 900 })), { w: 700, h: 900, x: 100, y: 50 });
  const r = sums.dragBox(START, "w", { x: -9000, y: 0 }, o({ maxW: 700 }));
  eq(r.w, 700);
  eq(r.x + r.w, START.x + START.w, "right edge");
  // a room smaller than the smallest size still gives the smallest size
  eq(sums.dragBox(START, "e", { x: 500, y: 0 }, o({ maxW: 100 })).w, 260);
});

ok("a box held by its right and bottom (History, Feedback) grows toward the other side and never moves", () => {
  const held = o({ ax: "end", ay: "end" });
  eq(sums.dragBox(START, "w", { x: -80, y: 0 }, held), { w: 440, h: 480, x: 100, y: 50 }, "left side out");
  eq(sums.dragBox(START, "n", { x: 0, y: -60 }, held), { w: 360, h: 540, x: 100, y: 50 }, "top side out");
  eq(sums.dragBox(START, "nw", { x: -90, y: -60 }, held), { w: 450, h: 540, x: 100, y: 50 }, "top-left corner out");
  eq(sums.dragBox(START, "w", { x: 50, y: 0 }, held), { w: 310, h: 480, x: 100, y: 50 }, "left side in");
  // the side it is held by has no strip; if one were pulled it does nothing
  eq(sums.dragBox(START, "e", { x: 80, y: 0 }, held).w, 360);
  eq(sums.dragBox(START, "s", { x: 0, y: 80 }, held).h, 480);
});

ok("a box held by its right edge across and its top down (Feedback) mixes the two", () => {
  const fb = o({ ax: "end", ay: "start" });
  eq(sums.dragBox(START, "sw", { x: -120, y: 100 }, fb), { w: 480, h: 580, x: 100, y: 50 });
});

ok("a centred box grows both ways, so the pointer moves twice as far as the edge it holds", () => {
  const mid = o({ ax: "center", ay: "center" });
  eq(sums.dragBox(START, "e", { x: 50, y: 0 }, mid), { w: 460, h: 480, x: 100, y: 50 }, "right side");
  eq(sums.dragBox(START, "w", { x: -50, y: 0 }, mid), { w: 460, h: 480, x: 100, y: 50 }, "left side");
  eq(sums.dragBox(START, "s", { x: 0, y: 30 }, mid), { w: 360, h: 540, x: 100, y: 50 }, "bottom side");
  eq(sums.dragBox(START, "se", { x: 25, y: 10 }, mid), { w: 410, h: 500, x: 100, y: 50 }, "corner");
});

ok("the keyboard's sums change the size and leave the place alone, inside the same limits", () => {
  eq(sums.sizeBy(START, 16, 16, o()), { w: 376, h: 496, x: 100, y: 50 });
  eq(sums.sizeBy(START, -64, 0, o()), { w: 296, h: 480, x: 100, y: 50 });
  eq(sums.sizeBy(START, -5000, -5000, o()), { w: 260, h: 220, x: 100, y: 50 });
  eq(sums.sizeBy(START, 5000, 5000, o({ maxW: 800, maxH: 900 })), { w: 800, h: 900, x: 100, y: 50 });
});

ok("5000 random drags, every way a box can be held: inside [min, max] always, and the held-still edge never moves", () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  const anchors = ["start", "end", "center"];
  for (let i = 0; i < 5000; i++) {
    const start = { w: 200 + rand() * 800, h: 150 + rand() * 800, x: rand() * 900 - 200, y: rand() * 900 - 200 };
    const op = { ax: anchors[Math.floor(rand() * 3)], ay: anchors[Math.floor(rand() * 3)], minW: 100 + rand() * 120, minH: 100 + rand() * 80, maxW: 300 + rand() * 1500, maxH: 300 + rand() * 1500 };
    start.w = Math.min(Math.max(start.w, op.minW), op.maxW);
    start.h = Math.min(Math.max(start.h, op.minH), op.maxH);
    const edge = edges[Math.floor(rand() * 8)];
    const d = { x: (rand() - 0.5) * 3000, y: (rand() - 0.5) * 3000 };
    const r = sums.dragBox(start, edge, d, op);
    const label = JSON.stringify({ start, edge, d, op });
    truthy(r.w >= op.minW - 1e-9 && r.w <= op.maxW + 1e-9, "width out of its limits " + label);
    truthy(r.h >= op.minH - 1e-9 && r.h <= op.maxH + 1e-9, "height out of its limits " + label);
    // A start-held box keeps the edge opposite the one dragged still: dragging a side with
    // an "e" (or "s") leaves x (y) alone, dragging "w" (or "n") keeps x + w (y + h).
    if (op.ax === "start" && edge.includes("w")) near(r.x + r.w, start.x + start.w, 1e-6, "right edge " + label);
    if (op.ax === "start" && !edge.includes("w")) near(r.x, start.x, 1e-9, "left edge " + label);
    if (op.ay === "start" && edge.includes("n")) near(r.y + r.h, start.y + start.h, 1e-6, "bottom edge " + label);
    if (op.ay === "start" && !edge.includes("n")) near(r.y, start.y, 1e-9, "top edge " + label);
    // Held by the end or the middle, a box never changes place: the page puts it there.
    if (op.ax !== "start") near(r.x, start.x, 1e-9, "x " + label);
    if (op.ay !== "start") near(r.y, start.y, 1e-9, "y " + label);
    // An axis that was not dragged does not change.
    if (!/[ew]/.test(edge)) near(r.w, start.w, 1e-9, "width " + label);
    if (!/[ns]/.test(edge)) near(r.h, start.h, 1e-9, "height " + label);
  }
});

console.log("\nThe wiring");

const nav = read("public/buzzy/nav.js");
const board = read("public/buzzy/whiteboard.js");
const boardCss = read("public/buzzy/whiteboard.css");
const talk = read("public/buzzy/talk.html");

ok("the page shell loads resize.js on every page, once", () => {
  truthy(/function loadResize\(\)[\s\S]*?"\/buzzy\/resize\.js"/.test(nav), "no loader in nav.js");
  truthy(/loadCompanies\(\);\s*loadResize\(\);/.test(nav), "loadResize() is not called with the other loaders");
  truthy(/if \(window\.BeeZillaResize\) return;/.test(nav) && /script\[src="\/buzzy\/resize\.js"\]/.test(nav), "it would load twice");
});

const listed = [...source.matchAll(/\{ sel: "([^"]+)"/g)].map((m) => m[1]);
ok("every box in the list is something that is really in the page code", () => {
  eq(listed.sort(), [".wb-card.wb-k-chat", ".wb-editor", ".wb-history", "#bzFeedback", "#obBoard"].sort(), "the list of boxes");
  truthy(/wb-k-chat/.test(board), "no conversation card");
  truthy(/el\("div", "wb-history"\)|"wb-history"/.test(board), "no History panel");
  truthy(/el\("form", "wb-editor"\)/.test(board), "no step editor");
  truthy(/id="obBoard"/.test(talk), "no Idea Board");
  truthy(/panel\.id = "bzFeedback"|id = "bzFeedback"/.test(nav), "no Feedback panel");
});

ok("the conversation card keeps its size in the card, and the size goes through undo", () => {
  truthy(/function sizeChat\(c, n\)/.test(board));
  truthy(/fillChat[\s\S]*?sizeChat\(c, n\);\s*\}/.test(board), "fillChat does not apply the size (a redrawn card would lose it)");
  const h = board.slice(board.indexOf('n.addEventListener("bz:resized"'));
  truthy(h.indexOf("snapshot();") > 0 && h.indexOf("snapshot();") < h.indexOf("c.w = Math.round"), "the old size must be saved for undo BEFORE the card changes");
  truthy(/bz:resize"[\s\S]{0,60}drawLinks\(\)/.test(board), "the lines on the board do not follow while it is pulled");
  truthy(/if \(d\.reset\) \{ delete c\.w; delete c\.h; \}/.test(board), "a double-click must put it back at the default size");
  truthy(/\.wb-card\.wb-k-chat \{\s*box-sizing: border-box;/.test(boardCss), "its size must be the outside one (box-sizing)");
});

ok("while a card is pulled the board is busy, as for any drag (an update from the account waits, and Ctrl+Z does not run)", () => {
  truthy(/"bz:resizestart", pointerDown\)/.test(board) && /"bz:resizeend", pointerDone\)/.test(board), "the board is not told when a drag begins and ends");
  truthy(/emit\(el, "bz:resizestart"/.test(source) && /emit\(el, "bz:resizeend"/.test(source), "resize.js does not say when a drag begins and ends");
  // resizeend must come at the end of EVERY drag, kept or taken back, or the board would stay busy for ever
  const fin = source.slice(source.indexOf("function finish(ev, keep)"), source.indexOf("function up(ev)"));
  truthy(/emit\(el, "bz:resizeend", \{\}\);\s*\}$/.test(fin.trim()), "resizeend must be the last thing finish() does, whichever way the drag ended");
});

ok("the server keeps the size when the board is saved", () => {
  const clean = cleanWhiteboard({
    v: 2, links: [], view: { x: 0, y: 0, z: 1 },
    cards: [{ id: "chat", kind: "chat", title: "Conversation", x: 10, y: 20, w: 612.4, h: 731 }],
  }) as { ok: boolean; state?: { cards: Array<Record<string, unknown>> } };
  truthy(clean.ok, "refused");
  const c = clean.state!.cards[0];
  eq([c.w, c.h, c.x, c.y], [612.4, 731, 10, 20]);
});

ok("a bigger conversation card is more of what the board saves, nowhere near its limit", () => {
  // 4000 characters a card is the cap, not the size of the card: a card of 3000 x 4000 adds a few bytes.
  const small = JSON.stringify([{ id: "chat", kind: "chat", x: 1, y: 2 }]).length;
  const big = JSON.stringify([{ id: "chat", kind: "chat", x: 1, y: 2, w: 3000, h: 4000 }]).length;
  truthy(big - small < 30, String(big - small));
});

console.log("\nThe manners");

const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
ok("nothing here listens for a click, a press or a release away from the box: a drag that ends elsewhere closes and moves nothing", () => {
  const away = [...code.matchAll(/(document|window|document\.documentElement|document\.body)\.addEventListener\(\s*["'](\w+)["']/g)].map((m) => `${m[1]} ${m[2]}`);
  eq(away.sort(), ["document DOMContentLoaded", "document keydown", "window resize"].sort(), "document and window listeners");
});

ok("Esc, while dragging, is the drag's own: caught first, takes the drag back, and goes no further", () => {
  truthy(/document\.addEventListener\("keydown", esc, true\)/.test(code), "Esc must be caught in the capture phase");
  const e = code.slice(code.indexOf("function esc(ev)"), code.indexOf('h.addEventListener("pointermove", move)'));
  truthy(/ev\.key !== "Escape"/.test(e) && /ev\.stopPropagation\(\)/.test(e) && /ev\.preventDefault\(\)/.test(e) && /finish\(null, false\)/.test(e), e);
  truthy(/document\.removeEventListener\("keydown", esc, true\)/.test(code), "the Esc catcher must be taken off when the drag ends");
});

ok("a press on a strip is the resize's own: nothing under it (a card's drag, a selection) sees it", () => {
  truthy(/function onDown\(e\)[\s\S]*?e\.preventDefault\(\);\s*e\.stopPropagation\(\);/.test(code));
  truthy(/addEventListener\("click", function \(e\) \{ e\.stopPropagation\(\); \}\)/.test(code), "a click on a strip must not reach the card");
});

ok("the keyboard's arrows are the corner's own (the board would nudge the selected card too)", () => {
  const k = code.slice(code.indexOf("function onKey(e)"), code.indexOf("// ── Finding boxes"));
  truthy(/e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*var cfg = st\.cfg/.test(k));
  truthy(/"Home"/.test(k) && /reset\(el\)/.test(k), "Home must put the size back");
});

ok("the strips are drawn inside the box (a box that clips its children still shows them), never over the whole page", () => {
  truthy(/\.bz-rs\{position:absolute;/.test(source));
  truthy(!/position:fixed/.test(source.slice(source.indexOf("var CSS ="), source.indexOf("function paint()"))), "a strip must not be fixed to the window");
});

console.log("\nThe rule");

const rules = read("docs/BEEZILLA-SCREEN-RULES.md");
ok("the rule is written down: who asked, what it means, how a new box joins", () => {
  truthy(/Owner, 2026-11-22/.test(rules) && /grab(bing)? .{0,40}(side|corner)/i.test(rules) || /side or a corner/.test(rules), "the owner's words are missing");
  truthy(/data-bz-resize/.test(rules), "how a new box joins (data-bz-resize) is not written down");
  truthy(/resize\.js/.test(rules) && /probe-resizable-boxes/.test(rules), "the code and the real test are not named");
});
ok("\"Before you ship a screen\" asks about it", () => {
  const tail = rules.slice(rules.indexOf("## Before you ship a screen"));
  truthy(/dragged bigger or smaller|resize/i.test(tail), "no question about resizing in the checklist");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
