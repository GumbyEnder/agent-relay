#!/usr/bin/env node
/**
 * The Idea Board's DOM pass, at 390 and 1280 (CR-12).
 *
 * `desktop/smoke.mjs` proves the packaged runtime *serves* the mount and that the
 * store answers. This proves the board actually MOUNTS in a browser at both widths:
 * folded at rest, opens on a turn, the Talk bar moves into it (and only it), folds
 * again, and nothing spills past the viewport.
 *
 * usage:
 *   BZ_LOCAL_TOKEN=<token> node scripts/probe-idea-board.mjs [origin]
 *     origin   default http://127.0.0.1:7613 (a built runtime, BZ_RUNTIME=local)
 *
 * The token is required, not a fallback: the desktop shell puts it on every request
 * from the window (desktop/main.mjs), and without it /buzzy/talk is a signed-out
 * page — the probe would then be measuring a document that has no board at all and
 * reporting "the feature is missing".
 *
 * exit 0 = every case passed, 1 = a measured failure, 2 = could not run.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("playwright is not resolvable here — run from a checkout with `npm ci`, or set NODE_PATH");
  process.exit(2);
}

const BASE = (process.argv[2] || "http://127.0.0.1:7613").replace(/\/$/, "");
const TOKEN = (process.env.BZ_LOCAL_TOKEN || "").trim();
if (!TOKEN) {
  console.error("BZ_LOCAL_TOKEN is required: without it the page is signed out and there is no board to measure");
  process.exit(2);
}
const WIDTHS = [390, 1280];

const failures = [];
const note = (ok, width, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${width}px  ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(`${width}px ${what}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    await context.setExtraHTTPHeaders({ Authorization: `Bearer ${TOKEN}` });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

    const res = await page.goto(`${BASE}/buzzy/talk`, { waitUntil: "load", timeout: 45_000 });
    note(res?.status() === 200, width, "/buzzy/talk answers 200", String(res?.status()));

    // A visit starts on a blank folded board, not an empty panel.
    const rest = await page.evaluate(() => {
      const b = document.getElementById("obBoard");
      return b ? { present: true, display: getComputedStyle(b).display, hidden: b.classList.contains("hidden") } : { present: false };
    });
    note(rest.present, width, "#obBoard is in the DOM");
    note(rest.display === "none" && rest.hidden, width, "the board is folded at rest", `display=${rest.display} hidden=${rest.hidden}`);

    // The chrome is measured BEFORE the board opens. #bzHead holds three rows on
    // this line — the hero (#obStart), the bar + search + places (#bzBrowse), and
    // the board's mount — so its total height is not a header-bar number; the row
    // that must not grow is #bzBrowse.
    const layout = await page.evaluate(() => {
      const h = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().height) : null;
      };
      return {
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        headH: h("#bzHead"),
        barH: h("#bzBrowse"),
        heroH: h("#obStart"),
      };
    });
    note(layout.barH !== null && layout.barH <= (width === 390 ? 340 : 200), width, "the bar row (#bzBrowse) is one bar, not a stack", `${layout.barH}px`);
    note(layout.scrollW <= layout.innerW + 1, width, "no horizontal overflow at rest", `scrollWidth ${layout.scrollW} vs ${layout.innerW}`);

    // Open it the way a turn does, then measure what a person would see.
    await page.evaluate(() => window.__bzTurnStart && window.__bzTurnStart());
    await page.waitForTimeout(600);
    const open = await page.evaluate(() => {
      const b = document.getElementById("obBoard");
      const panel = b && b.querySelector(".wb-panel");
      const bar = document.querySelector(".talk-card") || document.querySelector(".talk-bar");
      const r = b ? b.getBoundingClientRect() : null;
      return {
        display: b ? getComputedStyle(b).display : null,
        hidden: b ? b.classList.contains("hidden") : null,
        panel: !!panel,
        panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
        barInside: !!(bar && b && b.contains(bar)),
        rect: r ? { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null,
        pressed: (document.getElementById("boardToggle") || {}).getAttribute
          ? document.getElementById("boardToggle").getAttribute("aria-pressed")
          : null,
        obOpen: document.documentElement.classList.contains("ob-open"),
      };
    });
    note(open.display !== "none" && open.hidden === false, width, "a turn opens the board", `display=${open.display}`);
    note(open.obOpen, width, "html.ob-open is set while the board is open");
    note(open.panel, width, "whiteboard.js mounted a .wb-panel inside #obBoard", `panel ${open.panelW}px`);
    note(open.barInside, width, "the Talk bar moved into the board's top edge");
    note(open.pressed === "true", width, "#boardToggle reports aria-pressed=true", String(open.pressed));
    note(open.rect && open.rect.x >= 0 && open.rect.x + open.rect.w <= width + 1, width, "the board is inside the viewport", JSON.stringify(open.rect));
    note(open.rect && open.rect.h >= (width === 390 ? 500 : 480), width, "the board has real height", open.rect ? `${open.rect.h}px` : "no rect");

    // With the board open, horizontal spill must still be zero — the board is the
    // widest thing this slice added — and there must be exactly ONE Talk bar: the
    // stage moves the composer into the board, it does not clone it.
    const layoutOpen = await page.evaluate(() => {
      const start = document.querySelector("#obStart");
      const bar = document.querySelector(".talk-card") || document.querySelector(".talk-bar");
      const b = document.getElementById("obBoard");
      return {
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        bars: document.querySelectorAll("#talkBar").length,
        barInHero: !!(start && bar && start.contains(bar)),
        barInBoard: !!(b && bar && b.contains(bar)),
      };
    });
    note(layoutOpen.scrollW <= layoutOpen.innerW + 1, width, "no horizontal overflow with the board open", `scrollWidth ${layoutOpen.scrollW} vs ${layoutOpen.innerW}`);
    note(layoutOpen.bars === 1 && layoutOpen.barInBoard && !layoutOpen.barInHero, width, "exactly one Talk bar, and it is the one in the board", `${layoutOpen.bars} bar(s), in board: ${layoutOpen.barInBoard}, in hero: ${layoutOpen.barInHero}`);

    // Fold through the board's own control: the board goes, the bar comes back.
    await page.evaluate(() => document.getElementById("boardToggle").click());
    await page.waitForTimeout(400);
    const folded = await page.evaluate(() => {
      const b = document.getElementById("obBoard");
      const start = document.querySelector("#obStart");
      const bar = document.querySelector(".talk-card") || document.querySelector(".talk-bar");
      return {
        display: getComputedStyle(b).display,
        pressed: document.getElementById("boardToggle").getAttribute("aria-pressed"),
        barInHero: !!(start && bar && start.contains(bar)),
      };
    });
    note(folded.display === "none", width, "folding closes the board again", `display=${folded.display}`);
    note(folded.pressed === "false", width, "#boardToggle reports aria-pressed=false after folding", String(folded.pressed));
    note(folded.barInHero, width, "the Talk bar goes back to the top of the page when the board folds");

    note(errors.length === 0, width, "no page or console errors", errors.slice(0, 3).join(" | "));
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nidea-board probe: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nidea-board probe: all checks passed at ${WIDTHS.join(" and ")} against ${BASE}`);
