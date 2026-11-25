#!/usr/bin/env node
/**
 * probe-sketch-tools.mjs: the Sketch page's tool fixes, checked in a real browser.
 *
 * Tester feedback (2026-11-24) this guards:
 *   - "I could not find anywhere on how to export the image ... with a transparent
 *      background."                                  -> checks D (see-through export)
 *   - recolouring a picture, then wanting no background -> checks E (remove background,
 *                                                         Fill with Alt/Option erases)
 *   - "a little tricky to delete"                     -> checks B (Delete key, header
 *                                                         button and the x on a picture)
 *   - "a slight delay when it comes to moving an image" -> checks C (the picture follows
 *                                                         the pointer, no wrap rebuilds)
 *   - "it's not even clear how I get out of building the hexagon ... Escape deletes all
 *      my work"                                       -> checks A (polygon exits)
 *
 * It needs no server and no account: it serves public/ from this checkout on an ephemeral
 * port, answers the few /api/buzzy calls the page makes with stubs, and drives the page
 * with Playwright. The pass/fail is on what the page really does (pixels on the canvas,
 * the board it would save, the files it would download), not on its source text.
 *
 * Browser: set CDP_URL to an already-running Chromium's DevTools address (for example the
 * windowless one `ai-screen.sh browser` prints) and the probe uses that, opening no window
 * of its own. Without CDP_URL it launches Playwright's headless Chromium.
 *
 * usage:  node scripts/probe-sketch-tools.mjs
 * env:    CDP_URL      DevTools address of a running Chromium (optional)
 *         SKETCH_HTML  serve another copy of sketch.html (to run this against an old one)
 *         SHOTS_DIR    where screenshots of the new controls go (default: <tmp>/sketch-tools-shots)
 *         DPRS         comma list of device pixel ratios to run (default "1,2")
 *         PLAYWRIGHT_DIR  a folder whose node_modules holds playwright (default: this repo's)
 * exit:   0 all checks passed, 1 a check failed, 2 the probe could not run
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const SKETCH = process.env.SKETCH_HTML || path.join(PUBLIC, "buzzy", "sketch.html");
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "sketch-tools-shots");
const DPRS = (process.env.DPRS || "1,2").split(",").map(Number).filter((n) => n > 0);

// ── playwright ──────────────────────────────────────────────────────────────
let chromium;
try {
  const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || ROOT, "noop.js"));
  ({ chromium } = req("playwright"));
} catch (e) {
  console.error("probe-sketch-tools: cannot load playwright (" + e.message + "). Run npm ci, or set PLAYWRIGHT_DIR.");
  process.exit(2);
}

// ── a stub of the few endpoints the page calls ──────────────────────────────
const boards = {};            // jobId -> the last board the page saved
const saves = [];             // every save the page posted, in order
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://probe");
  const json = (o, code = 200) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
  if (u.pathname === "/buzzy/sketch") { res.setHeader("content-type", "text/html"); return res.end(fs.readFileSync(SKETCH)); }
  if (u.pathname === "/favicon.ico") { res.statusCode = 204; return res.end(); }
  if (u.pathname.startsWith("/api/")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let b = {};
      try { b = body ? JSON.parse(body) : {}; } catch { /* not json */ }
      if (u.pathname === "/api/buzzy/jobs") return json({ ok: true });
      if (u.pathname === "/api/buzzy/art" && req.method === "POST") {
        if (b.action === "save") { boards[b.jobId] = b.board; saves.push({ jobId: b.jobId, board: b.board }); }
        return json({ ok: true, saved: true });
      }
      if (u.pathname === "/api/buzzy/art") return json({ board: boards[u.searchParams.get("job")] || null, images: [] });
      if (u.pathname.startsWith("/api/buzzy/projects/")) return json({ project: { title: "Probe board" } });
      return json({ error: "stub" }, 404);
    });
    return;
  }
  const f = path.join(PUBLIC, u.pathname);
  if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.setHeader("content-type", TYPES[path.extname(f)] || "application/octet-stream");
    return res.end(fs.readFileSync(f));
  }
  res.statusCode = 404; res.end("not found");
});

// ── tiny test harness ───────────────────────────────────────────────────────
async function scenario(name, fn) {
  try { await fn(); } catch (e) { failed++; console.log("FAIL " + tag + name + " stopped early  <- " + String(e && e.message).split("\n")[0].slice(0, 200)); }
}
let passed = 0, failed = 0, tag = "";
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? "PASS " : "FAIL ") + tag + name + (!ok && detail !== undefined ? "  <- " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── page helpers ────────────────────────────────────────────────────────────
const state = (page) => page.evaluate(() => window.__bzSketch.state());
const board = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__bzSketch.board())));
const status = (page) => page.locator("#status").innerText();
const blur = (page) => page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
async function geom(page) {
  return page.evaluate(() => {
    const r = document.getElementById("board").getBoundingClientRect();
    const s = window.__bzSketch.state();
    return { left: r.left, top: r.top, zoom: s.zoom, panX: s.panX, panY: s.panY };
  });
}
// document coordinates -> viewport coordinates
const at = (g, x, y) => ({ x: g.left + g.panX + x * g.zoom, y: g.top + g.panY + y * g.zoom });
// the board canvas as the user sees it, at a viewport point
const screenPx = (page, x, y) => page.evaluate(([x, y]) => {
  const c = document.getElementById("board"), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const d = c.getContext("2d").getImageData(Math.round((x - r.left) * dpr), Math.round((y - r.top) * dpr), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}, [x, y]);
// pixels of an image (data URL), at image coordinates
const samples = (page, url, pts) => page.evaluate(async ([url, pts]) => {
  const im = new Image(); im.src = url; await im.decode();
  const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const g = c.getContext("2d"); g.drawImage(im, 0, 0);
  return { w: c.width, h: c.height, px: pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)) };
}, [url, pts]);
const rasterPx = async (page, pts) => {
  const r = (await board(page)).raster;
  if (!r) return pts.map(() => [0, 0, 0, 0]);          // an all-see-through layer is saved as null
  return (await samples(page, r, pts)).px;
};
async function click(page, g, x, y, opts = {}) {
  const c = at(g, x, y);
  if (opts.alt) await page.keyboard.down("Alt");
  try { await page.mouse.click(c.x, c.y); } finally { if (opts.alt) await page.keyboard.up("Alt"); }
}
async function drag(page, g, x1, y1, x2, y2) {
  const a = at(g, x1, y1), b = at(g, x2, y2);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
}
// a 160x120 test picture: flat blue background with a little noise (like a JPEG's), a red
// ring, and a hole in the middle of the ring that is the SAME blue but sealed off from the edges
const RING = { w: 160, h: 120, corner: [0, 0], ring: [110, 60], hole: [80, 60] };
const makeRing = (page) => page.evaluate(() => {
  const w = 160, h = 120, c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), im = g.createImageData(w, h), d = im.data;
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, r = Math.hypot(x - 80, y - 60);
    const ring = r >= 20 && r <= 40, n = (rnd() - 0.5) * 8;
    d[i] = Math.max(0, 40 + n); d[i + 1] = Math.max(0, 120 + n); d[i + 2] = Math.max(0, 220 + n);
    if (ring) { d[i] = 220; d[i + 1] = 30; d[i + 2] = 30; }
    d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c.toDataURL("image/png");
});
async function dropPicture(page, url, x, y) {
  const before = (await state(page)).images;
  await page.evaluate(async ([url, x, y]) => {
    const blob = await (await fetch(url)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], "picture.png", { type: blob.type }));
    const r = document.getElementById("board").getBoundingClientRect(), s = window.__bzSketch.state();
    document.getElementById("stage").dispatchEvent(new DragEvent("drop", {
      dataTransfer: dt, clientX: r.left + s.panX + x * s.zoom, clientY: r.top + s.panY + y * s.zoom, bubbles: true, cancelable: true,
    }));
  }, [url, x, y]);
  await page.waitForFunction((n) => window.__bzSketch.state().images === n, before + 1);
  await sleep(300);
}
const pictureRect = (page) => page.evaluate(() => {
  const i = window.__bzSketch.board().images[0];
  return i ? { x: i.x, y: i.y, w: i.w, h: i.h } : null;
});

let errors = [];
async function fresh(ctx, url) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(tag + "pageerror: " + String(e.message).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(tag + "console.error: " + m.text().slice(0, 160)); });
  // Downloads are what the buttons would hand the browser; capture them instead of saving files.
  await page.addInitScript(() => {
    window.__dl = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.hasAttribute("download")) return click.apply(this, arguments);
      const e = { name: this.getAttribute("download"), href: this.href, type: "", text: "", url: "" };
      window.__dl.push(e);
      fetch(this.href).then((r) => r.blob()).then(async (b) => {
        e.type = b.type;
        if (/svg/.test(b.type)) e.text = await b.text();
        else e.url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
      });
    };
  });
  await page.goto(url || origin + "/buzzy/sketch", { waitUntil: "load" });
  await page.waitForFunction(() => window.__bzSketch && window.__bzSketch.state().w > 100);
  await sleep(250);
  return page;
}
async function lastDownload(page) {
  await page.waitForFunction(() => window.__dl.length && (window.__dl[window.__dl.length - 1].url || window.__dl[window.__dl.length - 1].text));
  return page.evaluate(() => window.__dl[window.__dl.length - 1]);
}
const shot = async (page, name) => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };

let origin = "";

// ═════════════════════════════════════════════════════════════════════════════
async function checksPolygon(ctx, shots) {
  const page = await fresh(ctx);
  const g = await geom(page);
  // A mark that is selected before the polygon starts: Backspace/Delete mid-polygon must never reach it.
  await page.click('[data-tool="rect"]');
  await drag(page, g, 700, 100, 800, 170);
  await page.click('[data-tool="select"]');
  await click(page, g, 750, 135);
  check("A0 a rectangle is drawn and selected first", (await state(page)).strokes === 1 && !!(await state(page)).selectedMark, await state(page));

  await page.click('[data-tool="polygon"]');
  const bar = await page.evaluate(() => {
    const b = document.getElementById("polybar"), cs = getComputedStyle(b), btn = document.getElementById("polyFinish");
    return { vis: cs.visibility, hint: document.getElementById("polyHint").textContent, btn: btn && btn.textContent,
             tip: document.querySelector('[data-tool="polygon"]').title };
  });
  check("A1 the polygon tool shows its hint and a Finish shape button",
    bar.vis === "visible" && /first corner/.test(bar.hint) && /double-click/.test(bar.hint) && /Enter/.test(bar.hint) && /Backspace/.test(bar.hint) && bar.btn === "Finish shape", bar);
  check("A2 the tool's tooltip names the exits", /first corner/.test(bar.tip) && /Enter/.test(bar.tip) && /Esc/.test(bar.tip), bar.tip);

  const SQ = [[300, 200], [520, 200], [520, 360], [300, 360]];
  const newest = async () => { const b = await board(page); return b.strokes[b.strokes.length - 1]; };
  const draw = async (pts) => { for (const [x, y] of pts) await click(page, g, x, y); };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const minGap = (pts) => Math.min(...pts.slice(1).map((p, i) => dist(p, pts[i])));
  let st;

  // 1. a click on the first corner (about 10 screen px) closes it
  await draw(SQ);
  st = await state(page);
  check("A3 four corners are a draft, not yet a mark", st.poly === 4 && st.strokes === 1, st);
  const fin = await page.evaluate(() => document.getElementById("polyFinish").getAttribute("aria-disabled"));
  check("A4 Finish shape looks ready once there are 3+ corners", fin === "false", fin);
  if (shots) await shot(page, "1-polygon-hint-and-finish-button.png");
  const first = at(g, 300, 200);
  await page.mouse.move(first.x + 40, first.y + 40);
  await page.mouse.move(first.x + 5, first.y + 4, { steps: 3 });
  const cur = await page.evaluate(() => document.getElementById("board").style.cursor);
  check("A5 the pointer shows it is on the exit (hand cursor over the first corner)", cur === "pointer", cur);
  await page.mouse.click(first.x + 6, first.y + 5);          // ~7.8 px off the corner
  st = await state(page);
  let poly = await newest();
  check("A6 a click near the first corner closes the shape and keeps all 4 corners",
    st.poly === 0 && st.strokes === 2 && poly.tool === "polygon" && poly.points.length === 4 && poly.closed === true, { st, n: poly.points.length });

  // a click well away from the first corner is just another corner (negative control)
  await draw(SQ);
  const far = at(g, 300, 200);
  await page.mouse.click(far.x + 30, far.y);
  st = await state(page);
  check("A7 a click 30 px from the first corner adds a corner instead of closing", st.poly === 5 && st.strokes === 2, st);
  await page.keyboard.press("Backspace");
  st = await state(page);
  check("A8 Backspace takes back the last corner", st.poly === 4, st);
  check("A8b ...and did not delete the rectangle that was selected", st.strokes === 2, st);
  await page.keyboard.press("Enter");
  poly = await newest();
  check("A9 Enter closes it, with the 4 corners that are left", (await state(page)).strokes === 3 && poly.points.length === 4, poly.points.length);

  // 2. double-click closes without leaving duplicate corners
  await draw(SQ.slice(0, 3));
  const dc = at(g, SQ[3][0], SQ[3][1]);
  await page.mouse.dblclick(dc.x, dc.y);
  st = await state(page);
  poly = await newest();
  check("A10 double-click closes it with no duplicate corners",
    st.poly === 0 && st.strokes === 4 && poly.points.length === 4 && minGap(poly.points) > 20, { poly: st.poly, strokes: st.strokes, n: poly.points.length, gap: minGap(poly.points) });

  // 3. Escape keeps a shape with 3+ corners, and loses nothing else
  await draw(SQ);
  await page.keyboard.press("Escape");
  st = await state(page);
  poly = await newest();
  check("A11 Escape with 4 corners FINISHES the shape and keeps all earlier work", st.poly === 0 && st.strokes === 5 && poly.points.length === 4, { st, n: poly.points.length });
  await draw(SQ.slice(0, 2));
  await page.keyboard.press("Escape");
  st = await state(page);
  check("A12 Escape with fewer than 3 corners just cancels (nothing added, nothing lost)", st.poly === 0 && st.strokes === 5, st);

  // 4. Backspace down to nothing cancels the draft; Delete is the same key while drawing
  await draw(SQ.slice(0, 3));
  await page.keyboard.press("Backspace"); await page.keyboard.press("Delete"); await page.keyboard.press("Backspace");
  st = await state(page);
  check("A13 Backspace/Delete mid-polygon edit the draft only: the rectangle and shapes survive", st.poly === 0 && st.strokes === 5, st);

  // 5. the Finish shape button
  await draw(SQ);
  await page.click("#polyFinish");
  st = await state(page);
  poly = await newest();
  check("A14 the Finish shape button finishes it", st.poly === 0 && st.strokes === 6 && poly.points.length === 4, { st, n: poly.points.length });
  await draw(SQ.slice(0, 2));
  await page.click("#polyFinish", { force: true });
  st = await state(page);
  check("A15 Finish shape with fewer than 3 corners explains itself and keeps the draft", st.poly === 2 && /3 corners/.test(await status(page)), { st, s: await status(page) });
  await page.keyboard.press("Escape");

  // 6. one Ctrl+Z removes the whole shape
  await draw(SQ);
  await page.keyboard.press("Enter");
  await blur(page);
  const n0 = (await state(page)).strokes;
  await page.keyboard.press("Control+z");
  await sleep(150);
  check("A16 one Undo takes the finished polygon away (it used to need one per corner)", (await state(page)).strokes === n0 - 1, await state(page));

  // 7. switching tool mid-draw finishes it (kept with 3+)
  await draw(SQ);
  await page.click('[data-tool="select"]');
  st = await state(page);
  check("A17 picking another tool finishes a 4-corner draft instead of losing it", st.poly === 0 && st.strokes === n0, st);
  const vis = await page.evaluate(() => getComputedStyle(document.getElementById("polybar")).visibility);
  check("A18 the polygon hint is gone when the tool is", vis === "hidden", vis);
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════════
async function checksDelete(ctx, shots) {
  const ring = await (async () => { const p = await ctx.newPage(); await p.goto("about:blank"); const u = await makeRing(p); await p.close(); return u; })();
  const page = await fresh(ctx);
  let g = await geom(page);
  const delOff = () => page.evaluate(() => ({ off: document.getElementById("del").classList.contains("is-off"), aria: document.getElementById("del").getAttribute("aria-disabled"), label: document.getElementById("del").textContent.trim() }));

  const d0 = await delOff();
  check("B1 the header button is named Delete and looks disabled with nothing selected", d0.label === "Delete" && d0.off && d0.aria === "true", d0);
  await page.click("#del", { force: true });          // dim, not dead: a click must answer
  check("B2 clicking it with nothing selected explains itself and deletes nothing", /Nothing is selected/.test(await status(page)), await status(page));

  await dropPicture(page, ring, 100, 100);
  const pr = await pictureRect(page);
  const mid = { x: pr.x + pr.w / 2, y: pr.y + pr.h / 2 };
  await click(page, g, mid.x, mid.y);
  let d1 = await delOff();
  let st = await state(page);
  check("B3 clicking a picture selects it and the Delete button lights up", !!st.selectedImage && !d1.off && d1.aria === "false", { st: st.selectedImage, d1 });
  const x = await page.evaluate(() => {
    const b = document.querySelector(".img-wrap.selected .img-del");
    if (!b) return null;
    const r = b.getBoundingClientRect(), w = document.querySelector(".img-wrap.selected").getBoundingClientRect();
    return { w: r.width, h: r.height, text: b.textContent, label: b.getAttribute("aria-label"), cornerDist: Math.hypot(r.left + r.width / 2 - w.right, r.top + r.height / 2 - w.top) };
  });
  check("B4 a selected picture shows a small x on its top-right corner", !!x && x.w > 8 && x.text === "×" && x.cornerDist < 14, x);
  if (shots) await shot(page, "2-picture-selected-x-and-delete-button.png");

  // the Delete key
  await page.keyboard.press("Delete");
  st = await state(page);
  check("B5 the Delete key deletes the selected picture", st.images === 0, st);
  check("B5b ...and the header button is dim again", (await delOff()).off, await delOff());
  await page.keyboard.press("Control+z");
  await sleep(300);
  st = await state(page);
  const back = await pictureRect(page);
  check("B6 Undo brings the picture back, in the same place", st.images === 1 && back && Math.abs(back.x - pr.x) < 0.01 && Math.abs(back.y - pr.y) < 0.01, { st: st.images, back, pr });
  const px = await screenPx(page, at(g, mid.x, mid.y).x, at(g, mid.x, mid.y).y);
  check("B6b ...and it is drawn again on the canvas", px[2] > 150 && px[0] < 100, px);

  // Backspace does the same
  await click(page, g, mid.x, mid.y);
  await page.keyboard.press("Backspace");
  check("B7 Backspace also deletes the selected picture", (await state(page)).images === 0, await state(page));
  await page.keyboard.press("Control+z"); await sleep(300);

  // the x button
  await click(page, g, mid.x, mid.y);
  await page.click(".img-wrap.selected .img-del");
  check("B8 clicking the x deletes the picture", (await state(page)).images === 0, await state(page));
  await page.keyboard.press("Control+z"); await sleep(300);
  check("B8b ...and Undo brings it back", (await state(page)).images === 1, await state(page));

  // the header button
  await click(page, g, mid.x, mid.y);
  await page.click("#del");
  check("B9 the header Delete button deletes the selected picture", (await state(page)).images === 0, await state(page));
  await page.keyboard.press("Control+z"); await sleep(300);

  // a deleted picture returns to ITS place in the stacking order: here, behind a mark
  // drawn over it (without the order in the snapshot it came back on top of everything)
  await page.click('[data-tool="rect"]');
  await drag(page, g, mid.x - 30, mid.y - 20, mid.x + 30, mid.y + 20);        // a mark over the picture
  await page.click('[data-tool="select"]');
  await click(page, g, pr.x + 8, pr.y + 8);                                    // the picture, away from the mark
  const orderBefore = (await board(page)).order.map((o) => o.kind).join(",");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+z"); await sleep(300);
  const orderAfter = (await board(page)).order.map((o) => o.kind).join(",");
  check("B10 Undo restores the picture's place in the stacking order too (still behind the mark)", orderBefore === "image,stroke" && orderAfter === orderBefore, { orderBefore, orderAfter });

  // marks and pixel areas go through the same Delete
  await click(page, g, mid.x, mid.y);                                          // selects the mark in front
  st = await state(page);
  const marks = st.strokes;
  if (st.selectedMark) await page.keyboard.press("Delete");
  check("B11 a selected mark is still deletable with Delete", (await state(page)).strokes === marks - 1, { marks, now: (await state(page)).strokes, sel: st.selectedMark });
  await page.keyboard.press("Control+z"); await sleep(200);
  check("B11b ...and Undo brings it back", (await state(page)).strokes === marks, await state(page));
  await page.close();

  // a pixel selection
  const p2 = await fresh(ctx);
  g = await geom(p2);
  await p2.click('[data-tool="fill"]');
  await click(p2, g, 50, 50);
  await p2.click('[data-tool="selrect"]');
  await drag(p2, g, 100, 100, 200, 180);
  st = await state(p2);
  check("B12 a rectangle selection exists", !!st.sel && st.sel.w > 90, st);
  await p2.keyboard.press("Delete");
  const gone = await rasterPx(p2, [[150, 140], [50, 50]]);
  check("B13 Delete clears the pixels in a selected area (and only there)", gone[0][3] === 0 && gone[1][3] === 255, gone);
  await p2.keyboard.press("Control+z"); await sleep(300);
  const restored = await rasterPx(p2, [[150, 140]]);
  check("B14 Undo puts the pixels back", restored[0][3] === 255, restored);
  await p2.close();
}

// ═════════════════════════════════════════════════════════════════════════════
async function checksMove(ctx) {
  const ring = await (async () => { const p = await ctx.newPage(); await p.goto("about:blank"); const u = await makeRing(p); await p.close(); return u; })();
  const page = await fresh(ctx);
  const g = await geom(page);
  await dropPicture(page, ring, 100, 100);
  await page.evaluate(() => { window.__wrap = document.querySelector(".img-wrap"); window.__wrap.__tag = "same"; });
  const pr = await pictureRect(page);
  const mid = { x: pr.x + pr.w / 2, y: pr.y + pr.h / 2 };
  const c = at(g, mid.x, mid.y);
  const sampleAt = async (dx) => screenPx(page, c.x + dx, c.y);

  await sleep(1500);                                         // let the placement save settle
  const savesBefore = saves.length;
  await page.mouse.click(c.x, c.y);                          // a plain click: select, don't move
  await sleep(1700);
  check("C1 a plain click on a picture selects it without saving the board again", saves.length === savesBefore, { before: savesBefore, after: saves.length });
  const same = await page.evaluate(() => document.querySelector(".img-wrap") === window.__wrap && window.__wrap.__tag === "same");
  check("C2 selecting a picture does not rebuild its DOM wrap (that re-decoded every picture)", same, same);

  await page.mouse.move(c.x, c.y); await page.mouse.down();
  await page.mouse.move(c.x + 300, c.y + 20, { steps: 12 });
  const during = await sampleAt(300);
  const old = await sampleAt(0);
  check("C3 while the button is still down, the canvas already draws the picture at the pointer", during[0] > 150 || during[2] > 150, during);
  check("C3b ...and no longer at the old spot", old[0] < 60 && old[1] < 60 && old[2] < 60, old);
  await page.mouse.up();
  await sleep(120);
  const after = await sampleAt(300);
  check("C4 after the drop, with no other input, the picture is where it was dropped", after[0] > 150 || after[2] > 150, after);
  const moved = await pictureRect(page);
  check("C5 the board has the new position", Math.abs(moved.x - (pr.x + 300 / g.zoom)) < 1.5, { moved, pr });
  const kept = await page.evaluate(() => document.querySelector(".img-wrap") === window.__wrap);
  check("C6 dragging keeps the same DOM wrap", kept, kept);
  const sb = saves.length;
  await sleep(1700);
  check("C7 the move is saved after the drag", saves.length > sb, { sb, now: saves.length });

  // resize with the corner handle repaints the same way
  const h = await page.evaluate(() => { const r = document.querySelector(".img-wrap.selected .handle").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const before = await pictureRect(page);
  await page.mouse.move(h.x, h.y); await page.mouse.down();
  await page.mouse.move(h.x + 80, h.y + 50, { steps: 8 });
  const grown = await screenPx(page, h.x + 60, h.y + 35);
  await page.mouse.up();
  const sized = await pictureRect(page);
  check("C8 resizing with the corner handle repaints the canvas while dragging", (grown[0] > 150 || grown[2] > 150) && sized.w > before.w + 50, { grown, before, sized });
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════════
async function checksSeeThrough(ctx, shots) {
  const page = await fresh(ctx);
  const g = await geom(page);
  await page.click('[data-tool="rect"]');
  await drag(page, g, 300, 200, 500, 300);                          // outline yellow, fill white
  await page.click('[data-tool="select"]');
  await page.click("#canvasBtn");
  check("D1 the Canvas panel has a None (see-through) choice", await page.locator("#cvBgNone").count() === 1 && /see-through/.test(await page.locator('label[for="cvBgNone"]').innerText()), "missing");
  check("D2 the header has an Export see-through PNG button next to Export PNG", /see-through PNG/.test(await page.locator("#shotAlpha").innerText()) && await page.evaluate(() => document.getElementById("shot").nextElementSibling.id === "shotAlpha"), "missing");

  // paper = a colour: Export PNG keeps it, Export see-through PNG ignores it
  await page.click("#shot");
  let dl = await lastDownload(page);
  let s = await samples(page, dl.url, [[2, 2], [400, 250], [300, 250]]);
  check("D3 Export PNG with a paper colour paints it (corner #141414, opaque)", s.px[0][3] === 255 && s.px[0][0] === 20 && s.px[0][2] === 20, s.px[0]);
  await page.click("#shotAlpha");
  await page.waitForFunction(() => window.__dl.length === 2 && window.__dl[1].url);
  dl = await page.evaluate(() => window.__dl[1]);
  s = await samples(page, dl.url, [[2, 2], [400, 250], [300, 250], [1437, 602]]);
  check("D4 Export see-through PNG: corners are fully transparent", s.px[0][3] === 0 && s.px[3][3] === 0, { tl: s.px[0], br: s.px[3] });
  check("D5 ...while the drawing keeps its colours (white fill, yellow outline), opaque", s.px[1][3] === 255 && s.px[1][0] === 255 && s.px[2][3] === 255 && s.px[2][2] < 60, { fill: s.px[1], edge: s.px[2] });
  check("D6 ...and the file is named as a see-through PNG", /see-through.*\.png$/.test(dl.name) && dl.type === "image/png", dl.name);

  // JPG: always white, and the tooltip says why
  await page.click("#cvJpg");
  await page.waitForFunction(() => window.__dl.length === 3 && window.__dl[2].url);
  dl = await page.evaluate(() => window.__dl[2]);
  s = await samples(page, dl.url, [[2, 2]]);
  const jpgTip = await page.locator("#cvJpg").getAttribute("title");
  check("D7 Export JPG stays white, not transparent", dl.type === "image/jpeg" && s.px[0][3] === 255 && s.px[0][0] > 240 && s.px[0][2] > 240, { type: dl.type, px: s.px[0] });
  check("D8 ...and its tooltip says a JPG cannot be see-through", /cannot be see-through/i.test(jpgTip), jpgTip);

  // paper = none
  await page.check("#cvBgNone");
  await blur(page);
  let st = await state(page);
  check("D9 ticking None sets the paper to none", st.bg === "none", st.bg);
  const sx = await page.evaluate(() => { const r = document.getElementById("board").getBoundingClientRect(), s = window.__bzSketch.state(); return { x: r.left + s.panX, y: r.top + s.panY }; });
  const quad = [[4, 4], [12, 4], [4, 12], [12, 12]];
  const tiles = [];
  for (const [dx, dy] of quad) tiles.push(await screenPx(page, sx.x + dx, sx.y + dy));
  const grey = (p) => Math.abs(p[0] - p[1]) < 3 && Math.abs(p[1] - p[2]) < 3 && p[0] > 150;
  check("D10 the paper is shown as a checkerboard: two greys alternating in 8 px squares",
    tiles.every(grey) && tiles[0][0] !== tiles[1][0] && tiles[0][0] === tiles[3][0] && tiles[1][0] === tiles[2][0], tiles);
  if (shots) await shot(page, "3-see-through-paper-checkerboard-and-export-buttons.png");
  await page.click("#shot");
  await page.waitForFunction(() => window.__dl.length === 4 && window.__dl[3].url);
  dl = await page.evaluate(() => window.__dl[3]);
  s = await samples(page, dl.url, [[2, 2], [400, 250]]);
  check("D11 with the paper set to none, plain Export PNG is see-through too", s.px[0][3] === 0 && s.px[1][3] === 255, s.px);
  await page.click("#svg");
  await page.waitForFunction(() => window.__dl.length === 5 && window.__dl[4].text);
  dl = await page.evaluate(() => window.__dl[4]);
  check("D12 SVG export has no paper rectangle when the paper is none", /<svg/.test(dl.text) && !/<rect width="100%"/.test(dl.text), dl.text.slice(0, 200));

  // it is saved with the board, and comes back
  await sleep(1700);
  const jobId = (await state(page)).jobId;
  const saved = boards[jobId];
  check("D13 the saved board records the paper as none", !!saved && saved.bg === "none", saved && saved.bg);
  const reload = await fresh(ctx, origin + "/buzzy/sketch?job=" + encodeURIComponent(jobId));
  await sleep(500);
  const gr = await geom(reload);
  st = await state(reload);
  const t2 = await screenPx(reload, gr.left + gr.panX + 4, gr.top + gr.panY + 4);
  check("D14 reloading the board brings the see-through paper back (checkerboard, not paper colour)", st.bg === "none" && grey(t2), { bg: st.bg, t2 });
  await reload.close();

  // un-ticking returns the colour
  await page.uncheck("#cvBgNone");
  await blur(page);
  st = await state(page);
  check("D15 un-ticking None brings the previous paper colour back", st.bg === "#141414", st.bg);
  await page.close();

  // a selection made on a see-through paper must not carry a black box with it
  const p2 = await fresh(ctx);
  const g2 = await geom(p2);
  await p2.click("#canvasBtn");
  await p2.check("#cvBgNone");
  await blur(p2);
  await p2.click('[data-tool="selrect"]');
  await drag(p2, g2, 100, 100, 220, 180);
  await drag(p2, g2, 150, 130, 400, 330);                         // lift it and move it
  await p2.keyboard.press("Escape");                              // drop
  await sleep(200);
  const raster = (await board(p2)).raster;
  check("D16 moving a selection over a see-through paper adds no black (the layer stays empty)", raster === null, raster && raster.length);
  await p2.close();
}

// ═════════════════════════════════════════════════════════════════════════════
async function checksRemoveBackground(ctx, shots) {
  const ring = await (async () => { const p = await ctx.newPage(); await p.goto("about:blank"); const u = await makeRing(p); await p.close(); return u; })();
  const buf = Buffer.from(ring.split(",")[1], "base64");
  const CORNERS = [[0, 0], [159, 0], [0, 119], [159, 119]];
  const opaque = (p) => p[3] === 255;

  // 1. the pixel layer (Open image..., the way the testers worked)
  let page = await fresh(ctx);
  await page.click("#canvasBtn");
  await page.setInputFiles("#cvFile", { name: "ring.png", mimeType: "image/png", buffer: buf });
  await page.waitForFunction(() => window.__bzSketch.state().w === 160);
  await blur(page);
  check("E0 the button exists next to the Fill tolerance slider", /Remove background/.test(await page.locator("#rmBg").innerText()), "missing");
  let px = await rasterPx(page, [...CORNERS, RING.ring, RING.hole]);
  check("E1 the opened picture starts fully opaque", px.every(opaque), px);
  await page.click("#rmBg");
  await sleep(200);
  px = await rasterPx(page, [...CORNERS, RING.ring, RING.hole]);
  check("E2 Remove background makes the colour touching the edges transparent (all four corners)", px.slice(0, 4).every((p) => p[3] === 0), px.slice(0, 4));
  check("E3 ...the subject keeps its colour and opacity", opaque(px[4]) && px[4][0] > 200 && px[4][1] < 60, px[4]);
  check("E4 ...and a patch of the same colour sealed inside the subject (not touching an edge) stays", opaque(px[5]) && px[5][2] > 150, px[5]);
  check("E5 ...and it says what to do next", /see-through/i.test(await status(page)) && /Undo/.test(await status(page)), await status(page));
  if (shots) {
    await page.click("#canvasBtn");        // close the panel for the picture
    await sleep(100);
  }
  await page.keyboard.press("Control+z");
  await sleep(300);
  px = await rasterPx(page, CORNERS);
  check("E6 Undo gives the background back", px.every(opaque), px);
  await page.keyboard.press("Control+Shift+z");
  await sleep(300);
  px = await rasterPx(page, CORNERS);
  check("E7 Redo removes it again", px.every((p) => p[3] === 0), px);
  await page.close();

  // 2. tolerance: the Fill tol. slider decides what counts as the same colour
  page = await fresh(ctx);
  await page.setInputFiles("#cvFile", { name: "ring.png", mimeType: "image/png", buffer: buf });
  await page.waitForFunction(() => window.__bzSketch.state().w === 160);
  await page.evaluate(() => { const t = document.getElementById("tol"); t.value = "0"; t.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click("#rmBg");
  await sleep(200);
  px = await rasterPx(page, CORNERS);
  check("E8 with Fill tol. at 0 the noisy background is NOT swept away (and the board says so)", px.every(opaque) && /Nothing to remove/.test(await status(page)), { px, s: await status(page) });
  await page.close();

  // 3. Fill with Alt/Option erases to see-through
  page = await fresh(ctx);
  let g = await geom(page);
  await page.setInputFiles("#cvFile", { name: "ring.png", mimeType: "image/png", buffer: buf });
  await page.waitForFunction(() => window.__bzSketch.state().w === 160);
  g = await geom(page);
  await page.click('[data-tool="fill"]');
  check("E9 the Fill tool's tooltip mentions Alt/Option", /Alt\/Option/.test(await page.locator('[data-tool="fill"]').getAttribute("title")), "no mention");
  await click(page, g, 20, 20);                                       // plain click: paints a colour, as always
  px = await rasterPx(page, [[20, 20], [110, 60]]);
  check("E10 a plain Fill click still paints the colour (unchanged)", opaque(px[0]) && px[0][0] > 240 && px[0][1] > 190 && px[0][2] < 60, px[0]);
  await page.keyboard.press("Control+z"); await sleep(300);
  await click(page, g, 20, 20, { alt: true });
  px = await rasterPx(page, [[20, 20], [5, 100], [110, 60], [80, 60]]);
  check("E11 Alt/Option+click with Fill erases that area to see-through", px[0][3] === 0 && px[1][3] === 0, px.slice(0, 2));
  check("E12 ...stopping at the subject, and leaving the sealed hole alone", opaque(px[2]) && opaque(px[3]), px.slice(2));
  await page.keyboard.press("Control+z"); await sleep(300);
  px = await rasterPx(page, [[20, 20], [5, 100]]);
  check("E13 Undo restores it", px.every(opaque), px);
  await page.close();

  // 4. a picture placed on the board
  page = await fresh(ctx);
  g = await geom(page);
  await dropPicture(page, ring, 100, 100);
  const pr = await pictureRect(page);
  const original = (await board(page)).images[0].url;
  const mid = at(g, pr.x + pr.w / 2, pr.y + pr.h / 2);
  await page.mouse.click(mid.x, mid.y);                               // select it
  await page.click("#rmBg");
  await page.waitForFunction((o) => window.__bzSketch.board().images[0].url !== o, original);
  await sleep(400);
  const now = (await board(page)).images[0].url;
  const q = await samples(page, now, [...CORNERS, RING.ring, RING.hole]);
  check("E14 on a selected picture, Remove background rewrites that picture as a PNG", /^data:image\/png/.test(now), now.slice(0, 30));
  check("E15 ...its corners are transparent, the ring is intact, the sealed hole stays", q.px.slice(0, 4).every((p) => p[3] === 0) && opaque(q.px[4]) && opaque(q.px[5]), q.px);
  const shown = await screenPx(page, at(g, pr.x + 4, pr.y + 4).x, at(g, pr.x + 4, pr.y + 4).y);
  check("E16 ...and the canvas shows it: the paper (not the old blue) is behind the ring", shown[0] < 60 && shown[2] < 60, shown);
  if (shots) {
    await page.click("#canvasBtn");
    await page.check("#cvBgNone");
    await blur(page);
    await page.click("#canvasClose");
    await sleep(150);
    await shot(page, "4-remove-background-on-a-picture-over-checkerboard.png");
  }
  await page.keyboard.press("Control+z");
  await sleep(400);
  const undone = (await board(page)).images[0].url;
  check("E17 Undo puts the original picture back", undone === original, undone.slice(0, 30));
  await page.close();

  // 5. with nothing selected and an empty pixel layer, say where to click
  page = await fresh(ctx);
  await page.click("#rmBg");
  check("E18 with no picture selected and an empty pixel layer it says to click the picture first", /click the picture first/i.test(await status(page)), await status(page));
  await page.close();

  // 6. a big see-through picture must not come out of the importer with a black background
  page = await fresh(ctx);
  g = await geom(page);
  const big = await page.evaluate(() => {
    const w = 1000, h = 700, c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"), im = x.createImageData(w, h);
    let s = 7; for (let i = 0; i < im.data.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; im.data[i] = s >>> 24; im.data[i + 1] = (s >>> 16) & 255; im.data[i + 2] = (s >>> 8) & 255; im.data[i + 3] = 255; }
    x.putImageData(im, 0, 0); x.clearRect(0, 0, 100, 100);
    return c.toDataURL("image/png");
  });
  await dropPicture(page, big, 50, 50);
  const url = (await board(page)).images[0].url;
  const bp = await samples(page, url, [[10, 10], [500, 400]]);
  check("E19 a >1.5 MB see-through PNG keeps its transparent corner when it is imported", bp.px[0][3] === 0 && bp.px[1][3] === 255 && /^data:image\/png/.test(url), { url: url.slice(0, 22), corner: bp.px[0] });
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════════
await new Promise((r) => server.listen(0, "127.0.0.1", r));
origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = process.env.CDP_URL
    ? await chromium.connectOverCDP(process.env.CDP_URL)
    : await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run"] });
} catch (e) {
  console.error("probe-sketch-tools: cannot start a browser: " + e.message);
  server.close();
  process.exit(2);
}
console.log("probe-sketch-tools: serving " + path.relative(ROOT, SKETCH) + " at " + origin + (process.env.CDP_URL ? " via " + process.env.CDP_URL : " (own headless browser)"));
let crashed = false;
try {
  let first = true;
  for (const dpr of DPRS) {
    tag = "[dpr" + dpr + "] ";
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    try {
      await scenario("A polygon", () => checksPolygon(ctx, first));
      await scenario("B delete", () => checksDelete(ctx, first));
      await scenario("C move", () => checksMove(ctx));
      await scenario("D see-through", () => checksSeeThrough(ctx, first));
      await scenario("E remove background", () => checksRemoveBackground(ctx, first));
    } finally {
      await ctx.close();
    }
    first = false;
  }
  tag = "";
  check("F1 no page errors or console errors during the whole run", errors.length === 0, errors.slice(0, 5));
} catch (e) {
  crashed = true;
  console.error("probe-sketch-tools: the probe itself failed: " + (e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : e));
}
try { await browser.close(); } catch { /* a connected browser is left running */ }
server.close();
if (!crashed) console.log("screenshots: " + SHOTS);
console.log(crashed ? "RESULT: probe crashed" : "RESULT: " + passed + " passed, " + failed + " failed");
process.exit(crashed ? 2 : failed ? 1 : 0);
