/**
 * Zooming the Idea Board never moves or loses anything (owner, 2026-11-21: "when
 * zooming in and out of the board, things throw themselves around and you lose your
 * bits").
 *
 *   - A pinch follows the fingers: Chromium sends a trackpad pinch as Ctrl + wheel steps
 *     of −100·ln(scale), and the board's zoom is exactly that scale; a mouse wheel's notch
 *     zooms about 28%; no step is ever more than ×2 or less than ×½.
 *   - Cards far off the board (or with broken numbers) come back beside the rest when
 *     it opens; a group flung off together keeps its shape; a board laid out on purpose,
 *     even a full one, is never touched.
 *   - The page code: zooming is caught on the whole board (its top bar with the Talk
 *     box, the tools, the zoom buttons), never left to the browser; Safari's own pinch
 *     events too; Ctrl/⌘ + and − zoom the board; two fingers on a touch screen zoom it,
 *     registered before the board's own pointer handling, and every drag can be taken
 *     back by the second finger; BeeZilla's own new steps don't pull the view away while
 *     the person zooms; a board that opens with nothing in sight is fitted into view.
 *
 * The real thing, in a browser (pinch over each part of the board, two fingers on a
 * touch screen, a board saved far off): scripts/probe-board-zoom.mjs.
 *
 *   npx tsx scripts/test-board-zoom.ts
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";

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
const near = (a: number, b: number, tol: number, msg = "") => {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} expected ${b} ± ${tol}, got ${a}`);
};

type Card = { id: string; kind?: string; x: unknown; y: unknown };
type Move = { id: string; x: number; y: number };
type Api = {
  zoomFactor(dy: number, mode?: number): number;
  strays(cards: Card[], sizeOf?: (c: Card) => { w: number; h: number }): Move[];
};

const source = readFileSync("public/buzzy/whiteboard.js", "utf8");
const sandbox: Record<string, unknown> = { console, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, setTimeout: () => 0, clearTimeout: () => {} };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "whiteboard.js" });
const api = sandbox.BeeZillaWhiteboard as Api;

console.log("A pinch follows the fingers");

ok("a pinch to twice the size, in Chromium's steps, zooms the board exactly twice", () => {
  // Chromium turns each pinch update of scale s into a Ctrl + wheel step of −100·ln(s).
  for (const target of [2, 0.5, 1.8, 3, 0.25]) {
    const steps = 24;
    const per = Math.pow(target, 1 / steps);
    let z = 1;
    for (let i = 0; i < steps; i++) z *= api.zoomFactor(-100 * Math.log(per), 0);
    near(z, target, 1e-9, `pinch to ×${target}:`);
  }
});

ok("slow and quick pinches agree (no jump at a step size)", () => {
  // The old code zoomed 0.012 a step under 30 and 0.0025 over: a pinch of 29-unit steps
  // went four times further than one of 31-unit steps.
  const slow = api.zoomFactor(29, 0), quick = api.zoomFactor(31, 0);
  near(Math.log(quick) / Math.log(slow), 31 / 29, 1e-9, "same rate either side of 30:");
});

ok("a mouse wheel notch zooms about 28% (in or out), in pixels or in lines", () => {
  near(api.zoomFactor(-100, 0), Math.exp(0.25), 1e-9, "notch in:");
  near(api.zoomFactor(100, 0), Math.exp(-0.25), 1e-9, "notch out:");
  near(api.zoomFactor(-3, 1), Math.exp(99 * 0.0025), 1e-9, "Firefox's 3 lines:");
});

ok("no single step zooms more than ×2 or less than ×½, and nonsense zooms nothing", () => {
  eq(api.zoomFactor(-100000, 0) <= 2, true);
  eq(api.zoomFactor(100000, 0) >= 0.5, true);
  eq(api.zoomFactor(-1, 2) <= 2, true);
  eq(api.zoomFactor(Number.NaN, 0), 1);
  eq(api.zoomFactor(undefined as unknown as number, 0), 1);
});

console.log("\nCards far off the board come back");

const card = (id: string, x: unknown, y: unknown, kind = "note"): Card => ({ id, kind, x, y });

ok("a board laid out as usual is never touched", () => {
  eq(api.strays([]), []);
  eq(api.strays([card("a", 0, 0)]), []);
  eq(api.strays([card("a", 0, 0), card("b", 320, 0), card("c", 640, 400), card("d", -800, 2000)]), []);
});

ok("a full board (160 cards, side by side) is never touched", () => {
  const grid: Card[] = [];
  for (let i = 0; i < 160; i++) grid.push(card("g" + i, (i % 16) * 300, Math.floor(i / 16) * 220));
  eq(api.strays(grid), []);
});

ok("a card flung 90,000 px away comes back below the rest, at its left edge", () => {
  const moves = api.strays([card("a", 100, 50), card("b", 420, 50), card("far", 90000, -40000)], () => ({ w: 240, h: 150 }));
  eq(moves, [{ id: "far", x: 100, y: 50 + 150 + 80 }]);
});

ok("cards flung off together come back together, in the same shape", () => {
  const moves = api.strays([card("a", 0, 0), card("b", 300, 0), card("f1", 50000, 50000), card("f2", 50300, 50200)], () => ({ w: 200, h: 100 }));
  eq(moves, [{ id: "f1", x: 0, y: 180 }, { id: "f2", x: 300, y: 380 }]);
});

ok("cards with broken numbers come back in a row below the rest", () => {
  const moves = api.strays([card("a", 0, 0), card("b", 300, 0), card("n", Number.NaN, 5), card("s", "12", null), card("i", Infinity, 0)], () => ({ w: 200, h: 100 }));
  eq(moves, [{ id: "n", x: 0, y: 180 }, { id: "s", x: 240, y: 180 }, { id: "i", x: 480, y: 180 }]);
});

ok("the main part is where most cards are, not the first card", () => {
  const moves = api.strays([card("lonely", -70000, 0), card("a", 0, 0), card("b", 300, 0), card("c", 600, 0)], () => ({ w: 200, h: 100 }));
  eq(moves.map((m) => m.id), ["lonely"]);
});

ok("a board where every card is broken still comes back (from the top-left)", () => {
  const moves = api.strays([card("n1", Number.NaN, 0), card("n2", 0, Number.NaN)], () => ({ w: 200, h: 100 }));
  eq(moves, [{ id: "n1", x: 0, y: 0 }, { id: "n2", x: 240, y: 0 }]);
});

console.log("\nThe page code");

ok("zooming is caught on the whole board, never left to the browser", () => {
  truthy(/root\.addEventListener\("wheel", function \(e\) \{\s*if \(!e\.ctrlKey && !e\.metaKey\) return;\s*e\.preventDefault\(\);/.test(source),
    "a Ctrl/⌘ + wheel (a pinch) anywhere on the board is prevented and zooms the board");
  truthy(/canvas\.addEventListener\("wheel", function \(e\) \{\s*if \(e\.ctrlKey \|\| e\.metaKey\) return;/.test(source),
    "the board surface leaves the pinch to the board-wide handler (no double zoom)");
  truthy(!/Math\.abs\(e\.deltaY\) < 30 \? 0\.012 : 0\.0025/.test(source), "the old two-speed zoom is gone");
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
    truthy(new RegExp(`root\\.addEventListener\\("${ev}", function \\(e\\) \\{\\s*e\\.preventDefault\\(\\);`).test(source), `Safari's ${ev} is the board's`);
  }
  const css = readFileSync("public/buzzy/whiteboard.css", "utf8");
  truthy(/\.wb-panel \{ touch-action: pan-x pan-y; \}/.test(css), "fingers on the board's bars can scroll the page but not zoom it");
});

ok("Ctrl/⌘ + and − zoom the board, like Ctrl/⌘ 0", () => {
  truthy(/if \(mod && !e\.altKey && \(e\.key === "\+" \|\| e\.key === "=" \|\| e\.key === "-" \|\| e\.key === "_"\)\) \{\s*e\.preventDefault\(\);/.test(source));
});

ok("two fingers are caught before the board's own pointer handling, and take back the first finger's drag", () => {
  const pinchAt = source.indexOf('canvas.addEventListener("pointerdown", function (e) {\n      if (e.pointerType !== "touch") return;');
  const boardAt = source.indexOf('canvas.addEventListener("pointerdown", function (e) {\n      if (e.target.closest && (e.target.closest(".wb-card")');
  truthy(pinchAt > 0 && boardAt > pinchAt, "the two-finger handler is registered first");
  truthy(/e\.stopImmediatePropagation\(\);\s*\/\/ the second finger starts nothing of its own/.test(source));
  truthy(/if \(dragging\) dragging\.abort\(\);/.test(source), "the first finger's drag is taken back");
  // Every drag goes through follow(), so it can be taken back; no drag listens on its own.
  const raw = source.match(/\.addEventListener\("pointermove", (?!function \(e\) \{\s*if \(!fingers)[a-z]+\)/g) || [];
  eq(raw, ['.addEventListener("pointermove", mv)'], "only follow() itself adds a drag's pointermove:");
  eq((source.match(/follow\((n|canvas|cv), e\.pointerId,/g) || []).length, 7, "seven drags (line, move, connect, resize, pan, box, stroke):");
});

ok("BeeZilla's own new steps don't pull the view away while the person zooms", () => {
  truthy(/if \(auto && Date\.now\(\) - steeredAt < 4000\) return;/.test(source));
  truthy(/drawLinks\(\);\s*reveal\(c, true\);/.test(source), "a live step reveals itself only as `auto`");
});

ok("a board that opens with nothing in sight is fitted into view, and a button brings cards back", () => {
  truthy(/if \(state\.cards\.length && \(!state\.viewSet \|\| back\.length \|\| !anyInView\(\)\)\) \{ fit\(\);/.test(source));
  truthy(/var lost = el\("button", "wb-lost"\);/.test(source) && /cards are out of sight\. Show them/.test(source));
  truthy(/if \(!num\(view\.x\) \|\| !num\(view\.y\) \|\| !num\(view\.z\) \|\| view\.z < ZMIN \|\| view\.z > ZMAX\)/.test(source), "a broken saved view starts again");
});

console.log(`\nboard zoom: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
