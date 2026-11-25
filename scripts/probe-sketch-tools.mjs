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
 * Review fixes (an independent review of the first version found these; each has checks):
 *   A19-A33  polygon: corners survive a zoom change; Undo takes back a corner and keeps Redo;
 *            a held Backspace never walks on into deleting a picture; a corner takes the
 *            keyboard focus from a slider or a menu
 *   B15-B29  Delete acts on what was picked, not on an old pixel area; the picture's x answers
 *            only to Select; deleting a lifted area is an undo step of its own
 *   D8b-D23  the paper colour survives a reload beside "none"; the Canvas panel follows
 *            Undo/Redo and stays inside a short stage
 *   E8-E8e   Remove background's key is a real edge pixel: an exact, a two-shade and a
 *            half-see-through background all clear
 *   E20-E31  Fill that changes nothing changes nothing; a touch switch for Fill-to-erase
 *   E32-E43  Remove background: a pixel budget, a size budget for the cleared picture, and a
 *            refusal that keeps the board saveable
 *   G1-G2    the new controls fit at phone width
 *   F2       a DPRS with no device pixel ratio in it makes this probe exit non-zero
 *
 * Second review (an independent review of the review fixes found these; each has checks):
 *   A34-A38  Redo while a polygon is open puts back the corner Undo took, never an earlier
 *            board edit under the open shape; a new corner ends that Redo
 *   B30-B34  a lifted area is part of the history: Undo past a mark drawn while it floated
 *            brings it back floating, and Undo of a flip leaves no flipped copy behind
 *   D20d-D20e the remembered paper colour follows Redo back to "none"
 *   D23-D25  a real mouse wheel scrolls the Canvas panel over a zoomed board (which does not
 *            pan), and its Close button stays in sight however far it is scrolled
 *   D26-D27  a width typed in the panel and not applied survives an Undo that keeps the size
 *   E40-E40b the near-limit board is really saved: the stub, which refuses what the route
 *            refuses (over 8 MB), accepted it with both pictures, and a reload has both
 *   E44-E49  Remove background: a background split across a bucket edge (alpha 191/192, grey
 *            127/128) still wins over a subject on the edge; a see-through gap stops the flood
 *   E50-E51  a board that is still over the limit after a clear says so
 *   E52-E53  Space presses the Fill switch when the keyboard reached it, and still pans after
 *            a click on it
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
 * exit:   0 all checks passed, 1 a check failed, 2 the probe could not run (including a DPRS
 *         that holds no device pixel ratio: a run with nothing in it must never pass)
 */
import { spawnSync } from "node:child_process";
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
const DPR_TOKENS = (process.env.DPRS || "1,2").split(",").map((t) => t.trim()).filter((t) => t !== "");
const DPRS = DPR_TOKENS.map(Number);
if (!DPRS.length || DPRS.some((n) => !(n > 0))) {
  // An empty list used to run no scenario at all and report "1 passed, 0 failed" (exit 0), and
  // a typo in a list ("1,two") quietly ran fewer checks than asked for. Neither may pass.
  console.error("probe-sketch-tools: DPRS=" + JSON.stringify(process.env.DPRS) + " is not a comma list of device pixel ratios above 0 (such as \"1,2\"), so the run would be empty or partial.");
  process.exit(2);
}

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
const boards = {};            // jobId -> the last board the page saved (and the stub accepted)
const saves = [];             // every save the page posted, in order, with the status it got
// The route's own backstop (src/lib/buzzy/art.nitro.ts): a board over 8 MB as JSON is refused
// with a 413 and not stored. The stub refuses it too, so a save it records as accepted (200)
// is one the real server would have kept.
const ROUTE_MAX_BOARD = 8 * 1024 * 1024;
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
        if (b.action === "save") {
          const size = JSON.stringify(b.board === undefined ? null : b.board).length;
          if (size > ROUTE_MAX_BOARD) {
            saves.push({ jobId: b.jobId, board: null, status: 413 });
            return json({ error: "Board is too large to save", code: "payload_too_large", bytes: size }, 413);
          }
          boards[b.jobId] = b.board; saves.push({ jobId: b.jobId, board: b.board, status: 200 });
        }
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
async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await sleep(50); }
  throw new Error("timed out waiting for " + what);
}
// waitFor for a check: whether it came true in time, instead of stopping the scenario.
async function cameTrue(fn, ms) {
  try { await waitFor(fn, ms, "a condition"); return true; } catch { return false; }
}

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
// ring, and a hole in the middle of the ring that is the SAME blue but sealed off from the edges.
// Options: noise (0 = a perfectly flat background), bgAlpha (a translucent background),
// shades (10% of the background pixels are one step lighter: two shades in one colour family).
const RING = { w: 160, h: 120, corner: [0, 0], ring: [110, 60], hole: [80, 60] };
const makeRing = (page, opts = {}) => page.evaluate((o) => {
  const w = 160, h = 120, c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), im = g.createImageData(w, h), d = im.data;
  const amp = o.noise === undefined ? 8 : o.noise, bgAlpha = o.bgAlpha === undefined ? 255 : o.bgAlpha;
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, r = Math.hypot(x - 80, y - 60);
    const ring = r >= 20 && r <= 40, n = (rnd() - 0.5) * amp, up = o.shades && rnd() < 0.1 ? 1 : 0;
    d[i] = Math.max(0, 40 + n + up); d[i + 1] = Math.max(0, 120 + n + up); d[i + 2] = Math.max(0, 220 + n + up);
    if (ring) { d[i] = 220; d[i + 1] = 30; d[i + 2] = 30; }
    d[i + 3] = ring ? 255 : bgAlpha;
  }
  g.putImageData(im, 0, 0);
  return c.toDataURL("image/png");
}, opts);
// Fraction of the picture's edge pixels (in the pixel layer) that ended up see-through.
const EDGE_PTS = (() => { const a = []; for (let x = 0; x < 160; x += 4) { a.push([x, 0], [x, 119]); } for (let y = 0; y < 120; y += 4) { a.push([0, y], [159, y]); } return a; })();
const seeThroughShare = async (page) => (await rasterPx(page, EDGE_PTS)).filter((p) => p[3] === 0).length / EDGE_PTS.length;
// A picture made INSIDE the page and dropped on the board through the importer, so a
// many-megabyte picture never has to cross the wire. kind "noise": a flat background with a block of
// random pixels in it (incompressible, so its PNG is large); kind "bytes": n random bytes that
// are not an image at all (the importer keeps such a file as it is: a cheap way to fill the board).
async function dropMade(page, spec, x, y) {
  const before = (await state(page)).images;
  await page.evaluate(async ([spec, x, y]) => {
    let blob;
    if (spec.kind === "noise") {
      const c = document.createElement("canvas"); c.width = spec.w; c.height = spec.h;
      const g = c.getContext("2d"); g.fillStyle = "rgb(" + spec.bg.join(",") + ")"; g.fillRect(0, 0, spec.w, spec.h);
      const [bx, by, bw, bh] = spec.block, im = g.createImageData(bw, bh);
      let s = 99; for (let i = 0; i < im.data.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; im.data[i] = s >>> 24; im.data[i + 1] = (s >>> 16) & 255; im.data[i + 2] = (s >>> 8) & 255; im.data[i + 3] = 255; }
      g.putImageData(im, bx, by);
      // spec.clear: a see-through patch [x, y, w, h], so the importer keeps the picture a PNG
      if (spec.clear) g.clearRect(spec.clear[0], spec.clear[1], spec.clear[2], spec.clear[3]);
      blob = await new Promise((r) => c.toBlob(r, spec.type, spec.q));
    } else {
      const bytes = new Uint8Array(spec.n); let s = 5;
      for (let i = 0; i < bytes.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; bytes[i] = s >>> 24; }
      blob = new Blob([bytes], { type: "image/png" });
    }
    const dt = new DataTransfer(); dt.items.add(new File([blob], "made", { type: blob.type }));
    const r = document.getElementById("board").getBoundingClientRect(), st = window.__bzSketch.state();
    document.getElementById("stage").dispatchEvent(new DragEvent("drop", {
      dataTransfer: dt, clientX: r.left + st.panX + x * st.zoom, clientY: r.top + st.panY + y * st.zoom, bubbles: true, cancelable: true,
    }));
  }, [spec, x, y]);
  await page.waitForFunction((n) => window.__bzSketch.state().images === n, before + 1, { timeout: 30000 });
  await sleep(300);
}
const setTol = (page, v) => page.evaluate((v) => { const t = document.getElementById("tol"); t.value = String(v); t.dispatchEvent(new Event("input", { bubbles: true })); }, v);
// Open a data-URL picture into the pixel layer (Canvas > Open image...), the way the testers did.
const openPic = async (page, url, w = 160) => {
  await page.setInputFiles("#cvFile", { name: "pic.png", mimeType: "image/png", buffer: Buffer.from(url.split(",")[1], "base64") });
  await page.waitForFunction((w) => window.__bzSketch.state().w === w, w);
};
const selectBoardPicture = async (page, p) => { const g = await geom(page), c = at(g, p.x + p.w / 2, p.y + p.h / 2); await page.mouse.click(c.x, c.y); };
const pictureAt = (page, i) => page.evaluate((i) => { const p = window.__bzSketch.board().images[i]; return p ? { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, len: p.url.length, head: p.url.slice(0, 22) } : null; }, i);
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
// Review fixes for the polygon: zoom, Undo, key repeat and keyboard focus.
async function checksPolygonMore(ctx) {
  const ring = await (async () => { const p = await ctx.newPage(); await p.goto("about:blank"); const u = await makeRing(p); await p.close(); return u; })();
  let page = await fresh(ctx);
  let g = await geom(page);
  const newest = async () => { const b = await board(page); return b.strokes[b.strokes.length - 1]; };
  const draw = async (pts) => { for (const [x, y] of pts) await click(page, g, x, y); };
  let st;

  // 1. corners placed zoomed in must survive finishing zoomed out
  await page.click('[data-tool="polygon"]');
  await page.selectOption("#zoomSel", "4");
  g = await geom(page);
  const s0 = await state(page), cx = Math.round(s0.w / 2), cy = Math.round(s0.h / 2);
  await draw([[cx - 10, cy - 10], [cx + 10, cy - 10], [cx + 10, cy + 10], [cx - 10, cy + 10]]);
  st = await state(page);
  check("A19 four corners 20 px apart are placed with the board zoomed in to 400%", st.poly === 4 && st.zoom === 4, st);
  await page.selectOption("#zoomSel", "0.25");                    // ...then zoom out to 25% before finishing
  await page.click("#polyFinish");
  const sq = await newest();
  check("A20 finishing after zooming out keeps all 4 corners (at 25% they are 5 screen px apart; that is not a 'duplicate')",
    (await state(page)).poly === 0 && !!sq && sq.tool === "polygon" && sq.points.length === 4, sq && sq.points && sq.points.length);
  await page.close();

  // 2. Undo while a polygon is open takes back its last corner, and Redo survives it
  page = await fresh(ctx);
  g = await geom(page);
  await page.click('[data-tool="rect"]');
  await drag(page, g, 100, 100, 200, 160);                        // mark A
  await drag(page, g, 300, 100, 400, 160);                        // mark B
  await page.click("#undo");                                      // B is undone: Redo has something
  st = await state(page);
  check("A21 setup: two marks drawn, one undone (A stays, B can be redone)", st.strokes === 1, st);
  await page.click('[data-tool="polygon"]');
  await draw([[500, 300], [650, 300], [650, 420]]);
  check("A22 setup: a polygon with 3 corners is open", (await state(page)).poly === 3, await state(page));
  await page.click("#undo");                                      // the header button: the touch way
  st = await state(page);
  check("A23 Undo takes back the polygon's last corner (and not the earlier mark)", st.poly === 2 && st.strokes === 1, st);
  await page.keyboard.press("Control+z");
  st = await state(page);
  check("A24 Ctrl+Z does the same, down to nothing", st.poly === 1 && st.strokes === 1, st);
  await page.keyboard.press("Control+z");
  st = await state(page);
  check("A25 the last corner goes too, and the polygon is gone with no mark lost", st.poly === 0 && st.strokes === 1, st);
  await page.click("#redo");
  check("A26 Redo still brings back the mark that was undone before the polygon (Undo did not wipe it)", (await state(page)).strokes === 2, await state(page));
  await page.close();

  // 3. a held Backspace must not run on into deleting the selected picture
  page = await fresh(ctx);
  g = await geom(page);
  await dropPicture(page, ring, 100, 100);
  const pr = await pictureRect(page);
  await click(page, g, pr.x + pr.w / 2, pr.y + pr.h / 2);          // select the picture
  check("A27 setup: the picture is selected", !!(await state(page)).selectedImage, await state(page));
  await page.click('[data-tool="polygon"]');
  await draw([[600, 200], [800, 200]]);
  await page.keyboard.down("Backspace");                           // held: the first is a press, the rest repeat
  for (let i = 0; i < 5; i++) await page.keyboard.down("Backspace");
  await page.keyboard.up("Backspace");
  st = await state(page);
  check("A28 holding Backspace takes the two corners back and then stops: the picture is still there", st.poly === 0 && st.images === 1, st);
  await page.keyboard.press("Backspace");                          // a new press is a request to delete
  check("A29 a separate Backspace press still deletes the selected picture", (await state(page)).images === 0, await state(page));
  await page.close();

  // 4. placing a corner takes the keyboard focus from a slider or a menu
  page = await fresh(ctx);
  g = await geom(page);
  await page.click('[data-tool="polygon"]');
  await page.focus("#size");                                       // a slider has the keyboard
  await draw([[300, 200], [520, 200], [520, 360]]);
  const act = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check("A30 placing a corner hands the keyboard to the board (not the slider)", act === "board", act);
  await page.keyboard.press("Enter");
  st = await state(page);
  check("A31 Enter then finishes the shape even though a slider had the focus", st.poly === 0 && st.strokes === 1, st);
  const outline = await page.evaluate(() => getComputedStyle(document.getElementById("board")).outlineStyle);
  check("A32 the focused board shows no focus ring", outline === "none", outline);
  await page.close();

  page = await fresh(ctx);                                         // a menu has the keyboard (a page of its own: no leftovers)
  g = await geom(page);
  await page.click('[data-tool="polygon"]');
  await page.focus("#opMode");
  await draw([[300, 200], [520, 200], [520, 360]]);
  await page.keyboard.press("Backspace");
  st = await state(page);
  check("A33 Backspace takes back a corner even though a menu had the focus", st.poly === 2, st);
  await page.close();

  // 5. (second review) Redo while a polygon is open belongs to the polygon: it puts back the
  //    corner Undo took, and an earlier board edit waiting on the Redo stack is not redone (and
  //    saved) under the open shape
  page = await fresh(ctx);
  g = await geom(page);
  await page.click('[data-tool="rect"]');
  await drag(page, g, 100, 100, 200, 160);                        // mark A
  await drag(page, g, 300, 100, 400, 160);                        // mark B
  await page.click("#undo");                                      // B is undone: the board's Redo has it
  await page.click('[data-tool="polygon"]');
  await draw([[500, 300], [650, 300], [650, 420]]);
  await page.click("#undo");                                      // takes back the third corner
  st = await state(page);
  check("A34 setup: a polygon is open, Undo took back its third corner, and mark B waits on the board's Redo", st.poly === 2 && st.strokes === 1, st);
  await page.click("#redo");
  st = await state(page);
  check("A35 Redo puts the corner back (it used to redo mark B under the open shape instead)", st.poly === 3 && st.strokes === 1, st);
  await page.click("#redo");
  st = await state(page);
  const said = await status(page);
  check("A36 with no corner left to put back, Redo says so and still leaves the board alone", st.poly === 3 && st.strokes === 1 && /Nothing to redo in the polygon/.test(said), { st, said });
  await page.click("#undo");                                      // the third corner is taken back again...
  await click(page, g, 560, 420);                                 // ...and a different one is placed instead
  await page.click("#redo");
  st = await state(page);
  check("A37 a new corner is a new edit: the corner taken back before it is not redone on top of it", st.poly === 3 && st.strokes === 1, st);
  await page.keyboard.press("Enter");
  const shape = await newest();
  const corners = shape && shape.points ? shape.points.map((p) => [Math.round(p.x), Math.round(p.y)].join(",")).join(" ") : "";
  check("A38 Enter finishes the shape with the corners on screen: the new third corner, not the one taken back",
    (await state(page)).strokes === 2 && shape.tool === "polygon" && corners === "500,300 650,300 560,420", corners);
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
// Review fixes for Delete: it acts on what was picked; the x belongs to Select; a lifted
// area's delete is an undo step of its own.
async function checksDeleteMore(ctx) {
  const ring = await (async () => { const p = await ctx.newPage(); await p.goto("about:blank"); const u = await makeRing(p); await p.close(); return u; })();
  let page = await fresh(ctx);
  let g = await geom(page);
  let st;

  // 1. an old pixel area must not outrank the mark that was just picked
  await page.click('[data-tool="fill"]');
  await click(page, g, 50, 50);                                    // the whole pixel layer is yellow
  await page.click('[data-tool="selrect"]');
  await drag(page, g, 100, 100, 200, 180);                         // an area is selected
  check("B15 setup: a rectangle area is selected", !!(await state(page)).sel, await state(page));
  await page.click('[data-tool="rect"]');
  await drag(page, g, 400, 300, 480, 360);                         // a mark OUTSIDE the area
  await page.click('[data-tool="select"]');
  await click(page, g, 440, 330);                                  // pick that mark
  st = await state(page);
  check("B16 picking the mark puts the old area away: nothing but the mark is selected", st.sel === null && !!st.selectedMark, st);
  await page.click("#del");
  st = await state(page);
  check("B17 the header Delete deletes the picked mark", st.strokes === 0, st);
  const px = await rasterPx(page, [[150, 140], [440, 330]]);
  check("B18 ...and leaves the old area's pixels alone", px[0][3] === 255, px[0]);
  check("B19 ...and the mark was deleted, not flattened into the pixels first (the yellow shows, not the mark's white fill)", px[1][0] > 240 && px[1][1] > 190 && px[1][2] < 60, px[1]);
  await page.close();

  // 2. the x on a selected picture answers to Select only
  page = await fresh(ctx);
  g = await geom(page);
  await dropPicture(page, ring, 100, 100);
  const pr = await pictureRect(page);
  await click(page, g, pr.x + pr.w / 2, pr.y + pr.h / 2);
  const xDisplay = () => page.evaluate(() => { const b = document.querySelector(".img-wrap.selected .img-del"); return b ? getComputedStyle(b).display : "missing"; });
  check("B20 with Select in hand a selected picture shows its x", (await xDisplay()) === "block", await xDisplay());
  const xc = await page.evaluate(() => { const r = document.querySelector(".img-wrap.selected .img-del").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.click('[data-tool="polygon"]');
  check("B21 with the polygon tool in hand the x is gone", (await xDisplay()) === "none", await xDisplay());
  await page.mouse.click(xc.x, xc.y);                              // a corner, placed exactly where the x was
  st = await state(page);
  check("B22 a polygon corner placed on that spot is a corner: the picture is not deleted", st.images === 1 && st.poly === 1, st);
  await page.keyboard.press("Escape");
  await page.click('[data-tool="pencil"]');
  check("B23 with a drawing tool in hand the x is gone too", (await xDisplay()) === "none", await xDisplay());
  await page.click('[data-tool="select"]');
  check("B24 picking Select brings the x back", (await xDisplay()) === "block", await xDisplay());
  await page.close();

  // 3. deleting a lifted area is one undo step of its own, even after other edits while it floated
  page = await fresh(ctx);
  g = await geom(page);
  await page.click('[data-tool="fill"]');
  await click(page, g, 50, 50);                                    // the whole pixel layer is yellow
  await page.click('[data-tool="selrect"]');
  await drag(page, g, 100, 100, 200, 180);
  await page.click("#flipH");                                      // the area is lifted and floats, flipped
  check("B25 setup: the area is lifted (floating)", (await state(page)).floating === true, await state(page));
  await page.click('[data-tool="rect"]');
  await drag(page, g, 400, 300, 480, 360);                         // something else is done while it floats
  await page.click("#del");
  st = await state(page);
  check("B26 Delete lets the lifted area go", st.floating === false && st.strokes === 1, st);
  check("B27 ...the hole it left is still a hole", (await rasterPx(page, [[150, 140]]))[0][3] === 0, await rasterPx(page, [[150, 140]]));
  await page.click("#undo");
  await sleep(300);
  st = await state(page);
  const back = await rasterPx(page, [[150, 140]]);
  check("B28 one Undo gives the lifted area back (and keeps the mark drawn meanwhile): the delete was its own step", back[0][3] === 255 && st.strokes === 1, { back: back[0], strokes: st.strokes });
  await page.click("#undo");
  await sleep(300);
  check("B29 the next Undo takes the mark away, as it would have anyway", (await state(page)).strokes === 0, await state(page));
  // (second review) ...and that Undo must not take the lifted area with it: the step from when
  // the mark was drawn had the area floating, and it used to come back as only the hole
  st = await state(page);
  const mid30 = at(g, 150, 140), shown30 = await screenPx(page, mid30.x, mid30.y);
  check("B30 ...and the lifted area is still there: it floats where it was when the mark was drawn",
    st.floating === true && shown30[0] > 200 && shown30[1] > 150 && shown30[2] < 80, { floating: st.floating, shown: shown30 });
  await page.keyboard.press("Escape");                             // drop it
  await sleep(150);
  const laid = await rasterPx(page, [[150, 140]]);
  check("B31 Esc lays it into the pixel layer: nothing was lost", laid[0][3] === 255 && laid[0][0] > 200 && laid[0][2] < 80, laid[0]);

  // Undo of a flip puts the area back as it was: no flipped copy is left floating over it
  await page.click('[data-tool="selrect"]');
  await drag(page, g, 90, 90, 210, 190);                           // a new area, around the old one
  await page.click("#flipH");                                      // flipped: lifted, floating over its hole
  check("B32 setup: the flipped area floats over its hole", (await state(page)).floating === true && (await rasterPx(page, [[150, 140]]))[0][3] === 0, await state(page));
  await page.click("#undo");
  await sleep(300);
  st = await state(page);
  const unflipped = await rasterPx(page, [[150, 140]]);
  check("B33 Undo of the flip puts the area back in the pixel layer, with no flipped copy left floating over it (it used to stay)",
    st.floating === false && unflipped[0][3] === 255, { floating: st.floating, px: unflipped[0] });
  await page.click("#redo");
  await sleep(300);
  st = await state(page);
  const hole = await rasterPx(page, [[150, 140]]), over = await screenPx(page, mid30.x, mid30.y);
  check("B34 Redo flips it again: the area floats over its hole, and shows", st.floating === true && hole[0][3] === 0 && over[0] > 200 && over[2] < 80, { floating: st.floating, hole: hole[0], over });
  await page.close();
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

  // paper = none (after the user has chosen a paper colour of their own)
  await page.fill("#cvBg", "#3366cc");
  await blur(page);
  check("D8b setup: the paper is a colour of the user's choice", (await state(page)).bg === "#3366cc", (await state(page)).bg);
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
  check("D13b ...and the last real paper colour beside it", !!saved && saved.paper === "#3366cc", saved && saved.paper);
  const reload = await fresh(ctx, origin + "/buzzy/sketch?job=" + encodeURIComponent(jobId));
  await sleep(500);
  const gr = await geom(reload);
  st = await state(reload);
  const t2 = await screenPx(reload, gr.left + gr.panX + 4, gr.top + gr.panY + 4);
  check("D14 reloading the board brings the see-through paper back (checkerboard, not paper colour)", st.bg === "none" && grey(t2), { bg: st.bg, t2 });
  // ...and after that reload, un-ticking None must bring back the colour that was chosen, not the default
  await reload.click("#canvasBtn");
  await reload.uncheck("#cvBgNone");
  await blur(reload);
  const afterReload = (await state(reload)).bg;
  check("D14b after a reload, un-ticking None restores the chosen paper colour (not #141414)", afterReload === "#3366cc", afterReload);
  const picker = await reload.inputValue("#cvBg");
  check("D14c ...and the colour box shows it", picker === "#3366cc", picker);
  await reload.close();

  // un-ticking returns the colour
  await page.uncheck("#cvBgNone");
  await blur(page);
  st = await state(page);
  check("D15 un-ticking None brings the previous paper colour back", st.bg === "#3366cc", st.bg);
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
// Review fixes for the Canvas panel: it follows Undo/Redo, and it fits a short stage.
async function checksCanvasPanel(ctx, shots) {
  // Undo restores a paper colour while the panel shows None...
  let page = await fresh(ctx);
  let g = await geom(page);
  await page.click('[data-tool="rect"]');
  await drag(page, g, 300, 200, 500, 300);                         // an edit: its snapshot holds the paper as it is now (#141414)
  await page.click("#canvasBtn");
  await page.fill("#cvBg", "#3366cc");
  await page.check("#cvBgNone");
  await blur(page);
  check("D17 setup: the panel is open, the paper is none (and was #3366cc before)", (await state(page)).bg === "none" && await page.isChecked("#cvBgNone"), await state(page));
  await page.click("#undo");
  await sleep(300);
  let st = await state(page);
  check("D18 after Undo restores the paper colour, the None box is un-ticked", st.bg === "#141414" && !(await page.isChecked("#cvBgNone")), { bg: st.bg, none: await page.isChecked("#cvBgNone") });
  check("D19 ...and the colour box shows that colour, not the one it was left on", (await page.inputValue("#cvBg")) === "#141414", await page.inputValue("#cvBg"));
  await page.click("#redo");
  await sleep(300);
  st = await state(page);
  check("D20 after Redo restores 'none', the None box is ticked again", st.bg === "none" && await page.isChecked("#cvBgNone"), { bg: st.bg, none: await page.isChecked("#cvBgNone") });
  // (second review) the colour remembered beside "none" comes back with the Redo too: it used
  // to stay the grey the Undo had restored, and that grey was what the board then saved
  const shownColour = await page.inputValue("#cvBg"), savedPaper = (await board(page)).paper;
  check("D20d ...and the remembered colour comes back with it: the colour box shows the blue chosen before None, and the board saves that blue",
    shownColour === "#3366cc" && savedPaper === "#3366cc", { shownColour, savedPaper });
  await page.uncheck("#cvBgNone");
  await blur(page);
  check("D20e ...so un-ticking None gives that blue back, not the grey from before it", (await state(page)).bg === "#3366cc", (await state(page)).bg);
  await page.close();

  // ...and Undo restores 'none' while the panel shows a colour
  page = await fresh(ctx);
  g = await geom(page);
  await page.click("#canvasBtn");
  await page.check("#cvBgNone");
  await blur(page);
  await page.click('[data-tool="rect"]');
  await drag(page, g, 300, 200, 500, 300);                         // an edit: its snapshot holds the paper as none
  await page.uncheck("#cvBgNone");
  await blur(page);
  check("D20b setup: the paper was made a colour again after the edit", (await state(page)).bg === "#141414" && !(await page.isChecked("#cvBgNone")), await state(page));
  await page.click("#undo");
  await sleep(300);
  st = await state(page);
  check("D20c after Undo restores 'none', the None box is ticked", st.bg === "none" && await page.isChecked("#cvBgNone"), { bg: st.bg, none: await page.isChecked("#cvBgNone") });
  await page.close();

  // a short stage (a small laptop, a phone held sideways): the panel must stay inside it and scroll
  page = await fresh(ctx);
  await page.setViewportSize({ width: 1440, height: 560 });
  await sleep(300);
  // The board is zoomed in: a wheel over the board then pans it, and the wheel over the panel
  // used to be taken for that too (setting scrollTop from a script could not show it).
  await page.selectOption("#zoomSel", "2");
  await page.click("#canvasBtn");
  const m = await page.evaluate(() => {
    const p = document.getElementById("canvasPanel"), s = document.getElementById("stage").getBoundingClientRect(), r = p.getBoundingClientRect();
    return { stageH: Math.round(s.height), inside: r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5, overflowY: getComputedStyle(p).overflowY, taller: p.scrollHeight > p.clientHeight + 1 };
  });
  check("D21 on a short stage the Canvas panel stays inside it", m.stageH < 330 && m.inside, m);
  check("D22 ...and scrolls, so nothing in it is out of reach", /auto|scroll/.test(m.overflowY) && m.taller, m);
  const v0 = await state(page);
  const pc = await page.evaluate(() => { const r = document.getElementById("canvasPanel").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(pc.x, pc.y);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await sleep(60); }     // a real wheel, over the panel
  await cameTrue(() => page.evaluate(() => { const p = document.getElementById("canvasPanel"); return p.scrollTop + p.clientHeight >= p.scrollHeight - 1; }), 3000);
  const last = await page.evaluate(() => {
    const p = document.getElementById("canvasPanel"), s = document.getElementById("stage").getBoundingClientRect(),
          r = p.getBoundingClientRect(), b = document.getElementById("cvJpg").getBoundingClientRect();
    return { scrollTop: Math.round(p.scrollTop), inStage: b.top >= s.top - 0.5 && b.bottom <= s.bottom + 0.5, inPanel: b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5 };
  });
  check("D23 a real mouse wheel over the panel scrolls it to its end with the board zoomed in, so the last button (Export JPG) comes into reach", last.scrollTop > 0 && last.inStage && last.inPanel, last);
  const v1 = await state(page);
  check("D24 ...and the wheel stayed with the panel: the board behind it did not pan or zoom",
    v1.panX === v0.panX && v1.panY === v0.panY && v1.zoom === v0.zoom, { before: [v0.zoom, v0.panX, v0.panY], after: [v1.zoom, v1.panX, v1.panY] });
  if (shots) await shot(page, "5-canvas-panel-on-a-short-screen.png");
  // the way out stays in sight however far the panel is scrolled
  await page.evaluate(() => { const p = document.getElementById("canvasPanel"); p.scrollTop = p.scrollHeight; });
  const exit = await page.evaluate(() => {
    const p = document.getElementById("canvasPanel"), b = document.getElementById("canvasClose"), head = b.parentElement;
    const r = p.getBoundingClientRect(), c = b.getBoundingClientRect(), x = c.left + c.width / 2, y = c.top + c.height / 2;
    const top = r.top + p.clientTop;                               // the panel's inside top edge
    return { scrolled: p.scrollTop > 0, inPanel: c.top >= r.top - 0.5 && c.bottom <= r.bottom + 0.5, onTop: document.elementFromPoint(x, y) === b,
             // nothing that scrolled shows above the title row: the panel's top strip is the row
             headAtTop: Math.abs(head.getBoundingClientRect().top - top) < 1 && head.contains(document.elementFromPoint(r.left + 40, top + 3)), x, y };
  });
  await page.mouse.click(exit.x, exit.y);
  const shut = await page.evaluate(() => !document.getElementById("canvasPanel").classList.contains("on"));
  check("D25 scrolled to the end, the panel's Close button is still in sight at its top (nothing scrolled shows above or over it), and a click on it closes the panel",
    exit.scrolled && exit.inPanel && exit.onTop && exit.headAtTop && shut, { exit, shut });
  await page.close();

  // a width typed into the panel but not applied yet is the person's: an Undo of a mark keeps it
  page = await fresh(ctx);
  g = await geom(page);
  await page.click('[data-tool="rect"]');
  await drag(page, g, 100, 200, 300, 300);                         // a mark, away from the panel
  await page.click("#canvasBtn");
  const w0 = (await state(page)).w, h0 = (await state(page)).h;
  await page.fill("#cvW", "1234");                                 // typed, not applied
  await page.click("#undo");
  await sleep(300);
  st = await state(page);
  const typed = await page.inputValue("#cvW");
  check("D26 a width typed into the panel and not applied survives an Undo that does not change the canvas size (the mark goes, the 1234 stays)",
    st.strokes === 0 && st.w === w0 && typed === "1234", { strokes: st.strokes, w: st.w, box: typed });
  await page.fill("#cvW", "800"); await page.fill("#cvH", "600");
  await page.click("#cvApply");
  await page.waitForFunction(() => window.__bzSketch.state().w === 800);
  await page.click("#undo");
  await sleep(300);
  const boxes = { w: await page.inputValue("#cvW"), h: await page.inputValue("#cvH"), doc: [(await state(page)).w, (await state(page)).h] };
  check("D27 an Undo that does change the size still puts the restored size in the boxes",
    boxes.doc[0] === w0 && boxes.doc[1] === h0 && boxes.w === String(Math.round(w0)) && boxes.h === String(Math.round(h0)), { boxes, w0, h0 });
  await page.close();
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
  await openPic(page, ring);
  await setTol(page, 0);
  await page.click("#rmBg");
  await sleep(200);
  let share = await seeThroughShare(page);
  check("E8 with Fill tol. at 0 a NOISY background is mostly NOT swept away (only pixels exactly like the key go)", share < 0.35, share);
  await page.close();

  // ...but a background that is ONE exact colour clears at tolerance 0: the key is a real pixel of it, so it matches itself
  page = await fresh(ctx);
  await openPic(page, await makeRing(page, { noise: 0 }));
  await setTol(page, 0);
  await page.click("#rmBg");
  await sleep(200);
  px = await rasterPx(page, [...CORNERS, RING.ring, RING.hole]);
  check("E8b with Fill tol. at 0 a background of one exact colour clears completely (the ring and the sealed hole stay)",
    px.slice(0, 4).every((p) => p[3] === 0) && opaque(px[4]) && opaque(px[5]) && (await seeThroughShare(page)) === 1, px);
  await page.close();

  // ...and so does a background that is mostly one colour with a few pixels one step lighter
  // (the average of those is a colour no pixel has: at tolerance 0 it matched nothing at all)
  page = await fresh(ctx);
  await openPic(page, await makeRing(page, { noise: 0, shades: true }));
  await setTol(page, 0);
  await page.click("#rmBg");
  await sleep(200);
  share = await seeThroughShare(page);
  check("E8c with Fill tol. at 0 a background of one colour plus a few lighter pixels clears (the common colour is the key)", share >= 0.8, share);
  await page.close();

  // a translucent background is a colour with an alpha, and it matches itself (the key used to be forced opaque)
  page = await fresh(ctx);
  await openPic(page, await makeRing(page, { bgAlpha: 128 }));
  await page.click("#rmBg");
  await sleep(200);
  px = await rasterPx(page, [...CORNERS, RING.ring, RING.hole]);
  check("E8d a half-see-through background clears at the default tolerance (all four corners)", px.slice(0, 4).every((p) => p[3] === 0), px.slice(0, 4));
  check("E8e ...the opaque ring stays, and the sealed hole keeps its own half-see-through colour", opaque(px[4]) && px[5][3] > 100 && px[5][3] < 160, px.slice(4));
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
// Review fixes for Fill: a click that changes nothing changes nothing, and a touch switch for erase-fill.
async function checksFill(ctx, shots) {
  const ring = await (async () => { const p = await ctx.newPage(); await p.goto("about:blank"); const u = await makeRing(p); await p.close(); return u; })();
  const opaque = (p) => p[3] === 255;
  let page = await fresh(ctx);
  let g = await geom(page);
  let st;

  // 1. Alt+Fill on an area that is already see-through: no flattening, no undo step, no save
  const savesBefore = saves.length;
  await page.click('[data-tool="rect"]');
  await drag(page, g, 300, 200, 400, 260);                         // a vector mark over an empty (see-through) pixel layer
  await page.click('[data-tool="fill"]');
  await waitFor(() => saves.length > savesBefore, 8000, "the mark's autosave");
  await sleep(700);                                                // ...and nothing else is queued behind it
  const saves0 = saves.length;
  await click(page, g, 800, 450, { alt: true });                   // Alt+Fill far from the mark, on empty pixels
  st = await state(page);
  check("E20 Alt+Fill on an area that is already see-through leaves the vector mark a mark", st.strokes === 1, st);
  check("E21 ...and says the area is already see-through", /already see-through/.test(await status(page)), await status(page));
  await sleep(1800);
  check("E22 ...and saves nothing", saves.length === saves0, { saves0, now: saves.length });
  await page.click("#undo");
  check("E23 ...and adds no undo step: one Undo takes the mark away", (await state(page)).strokes === 0, await state(page));
  await page.close();

  // 2. a plain Fill onto the colour that is already there is a no-op too
  page = await fresh(ctx);
  g = await geom(page);
  await page.click('[data-tool="fill"]');
  await click(page, g, 50, 50);                                    // paints the layer yellow: one undo step
  await page.waitForFunction(() => !!window.__bzSketch.state().jobId);      // the board's project exists (its "ready" note comes in late)
  await sleep(150);
  await click(page, g, 50, 50);                                    // the same again: nothing changes
  check("E24 Fill on an area that is already that colour says so", /already that colour/.test(await status(page)), await status(page));
  await page.click("#undo");
  await sleep(300);
  check("E25 ...and adds no undo step: one Undo already empties the layer", (await rasterPx(page, [[50, 50]]))[0][3] === 0, await rasterPx(page, [[50, 50]]));
  await page.close();

  // 3. the touch way to erase-fill: the Fill makes see-through switch
  page = await fresh(ctx);
  await openPic(page, ring);
  g = await geom(page);
  const bars = () => page.evaluate(() => {
    const el = (id) => document.getElementById(id), vis = (id) => (el(id) ? getComputedStyle(el(id)).visibility : "missing"), sw = el("fillClear");
    return { fill: vis("fillbar"), text: vis("textbar"), poly: vis("polybar"), label: sw ? sw.textContent.trim() : "missing", pressed: sw ? sw.getAttribute("aria-pressed") : "missing", on: !!sw && sw.classList.contains("on") };
  });
  let b = await bars();
  check("E26 the Fill options bar is out of sight while another tool is in hand", b.fill === "hidden", b);
  await page.click('[data-tool="fill"]');
  b = await bars();
  check("E27 with Fill in hand, a 'Fill makes see-through' switch shows, off to begin with, and no other options bar shares its row",
    b.fill === "visible" && b.text === "hidden" && b.poly === "hidden" && b.label === "Fill makes see-through" && b.pressed === "false" && !b.on, b);
  if (shots) await shot(page, "6-fill-makes-see-through-switch.png");
  await page.click("#fillClear");
  b = await bars();
  check("E28 pressing it turns it on (it reads as pressed)", b.pressed === "true" && b.on, b);
  await click(page, g, 20, 20);                                    // a plain click, no Alt key
  let px = await rasterPx(page, [[20, 20], [5, 100], [110, 60], [80, 60]]);
  check("E29 with the switch on, a plain click makes the area see-through (what Alt+click does)", px[0][3] === 0 && px[1][3] === 0 && opaque(px[2]) && opaque(px[3]), px);
  await page.click("#fillClear");
  await click(page, g, 20, 20);
  px = await rasterPx(page, [[20, 20]]);
  check("E30 switched off again, a plain click paints the colour", opaque(px[0]) && px[0][0] > 240 && px[0][2] < 60, px[0]);
  // a text mark that is selected shows the text bar; Fill must still own the row
  await page.click('[data-tool="text"]');
  await click(page, g, 120, 80);
  await page.keyboard.type("hi");
  await page.keyboard.press("Escape");                             // finishes the text; the mark stays selected
  await page.click('[data-tool="fill"]');
  b = await bars();
  check("E31 with a text mark selected, Fill still owns the options row (the text bar does not show over it)", b.fill === "visible" && b.text === "hidden", b);
  await page.close();

  // 4. (second review) Space presses the switch when the keyboard reached it (Tab), as Enter
  //    does; and after a click on it, Space is still the hold-to-pan key
  page = await fresh(ctx);
  g = await geom(page);
  await page.click('[data-tool="fill"]');
  await page.focus("#opMode");                                     // the control just before the Fill bar
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  await page.keyboard.press(" ");
  b = await bars();
  check("E52 with the keyboard on the Fill switch (reached with Tab), Space presses it: it turns on and reads as pressed", focused === "fillClear" && b.pressed === "true" && b.on, { focused, b });
  await page.click("#fillClear");                                  // a click on the switch, which leaves the focus on it
  const clicked = (await bars()).pressed;
  const pan0 = (await state(page)).panX;
  await page.keyboard.down(" ");
  await drag(page, g, 500, 300, 560, 330);                         // Space held: a drag pans the board
  await page.keyboard.up(" ");
  const pan1 = (await state(page)).panX;
  b = await bars();
  const layer = (await board(page)).raster;
  check("E53 after a click on the switch, Space is still the hold-to-pan key: the board pans, nothing is filled, and the switch is not pressed again",
    Math.abs(pan1 - pan0 - 60) < 2 && layer === null && b.pressed === clicked, { pan0, pan1, clicked, b, filled: layer !== null });
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════════
// Review fixes for Remove background: a pixel budget, a size budget for the cleared picture,
// and a refusal that keeps the board saveable.
async function checksRemoveBudgets(ctx) {
  const LIMIT = 8 * 1024 * 1024;
  let page = await fresh(ctx);
  // 1. a canvas over the pixel budget is refused at once, with a message, before anything is allocated
  await page.click("#canvasBtn");
  await page.fill("#cvW", "4100"); await page.fill("#cvH", "4100");
  await page.click("#cvApply");
  await page.waitForFunction(() => window.__bzSketch.state().w === 4100, null, { timeout: 20000 });
  let t0 = Date.now();
  await page.click("#rmBg");
  let took = Date.now() - t0, msg = await status(page);
  check("E32 Remove background on a 4100x4100 canvas (over 16 million pixels) is refused with a message", /too big/.test(msg) && /4100×4100/.test(msg) && /Apply size|Crop/.test(msg), msg);
  check("E33 ...at once: the flood that would need hundreds of MB never starts", took < 1500, took);
  await page.fill("#cvW", "4096"); await page.fill("#cvH", "4096");
  await page.click("#cvApply");
  await page.waitForFunction(() => window.__bzSketch.state().w === 4096, null, { timeout: 20000 });
  await page.click("#rmBg");
  msg = await status(page);
  check("E34 a 4096x4096 canvas is within the budget (it is not refused)", !/too big/.test(msg) && /Nothing to remove/.test(msg), msg);
  await page.close();

  // 2. a big picture's cleared PNG is made smaller to fit its share of the board, alpha kept
  page = await fresh(ctx);
  await dropMade(page, { kind: "noise", w: 1600, h: 1200, block: [100, 100, 1400, 1000], bg: [40, 120, 220], type: "image/png" }, 100, 50);
  let p0 = await pictureAt(page, 0);
  await selectBoardPicture(page, p0);
  await page.click("#rmBg");
  await page.waitForFunction((h) => window.__bzSketch.board().images[0].url.slice(0, 22) !== h, p0.head, { timeout: 60000 });
  await sleep(300);
  const done = await page.evaluate(async () => {
    const u = window.__bzSketch.board().images[0].url, im = new Image(); im.src = u; await im.decode();
    const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext("2d"); g.drawImage(im, 0, 0);
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
    return { len: u.length, head: u.slice(0, 22), w: c.width, h: c.height, corner: px(1, 1), mid: px(c.width >> 1, c.height >> 1), boardLen: JSON.stringify(window.__bzSketch.board()).length };
  });
  check("E35 clearing the background of a big picture keeps its PNG within the per-picture budget (2 MB)", /image\/png/.test(done.head) && done.len <= 2 * 1024 * 1024, { head: done.head, len: done.len });
  check("E36 ...by making the picture smaller in proportion, with its see-through corner and its opaque middle intact",
    done.w < 1600 && Math.abs(done.w / done.h - 4 / 3) < 0.02 && done.corner[3] === 0 && done.mid[3] === 255, done);
  check("E37 ...and it says so", /made smaller/.test(await status(page)), await status(page));
  check("E38 ...so the whole board is still under the 8 MB save limit", done.boardLen < LIMIT, done.boardLen);
  await page.close();

  // 3. a cleared picture that would push the board over the save limit is refused, and nothing changes
  const SMALL = { kind: "noise", w: 700, h: 700, block: [100, 100, 500, 500], bg: [40, 120, 220], type: "image/jpeg", q: 0.4 };
  page = await fresh(ctx);                                          // a roomy board: measure the picture before and after
  await dropMade(page, SMALL, 100, 100);
  const O = (await pictureAt(page, 0)).len;
  await selectBoardPicture(page, await pictureAt(page, 0));
  await page.click("#rmBg");
  await page.waitForFunction(() => /^data:image\/png/.test(window.__bzSketch.board().images[0].url), null, { timeout: 30000 });
  const N = (await pictureAt(page, 0)).len;
  check("E39 control: on a roomy board the same compact JPEG IS cleared, into a PNG many times its size", N > O * 4, { jpeg: O, png: N });
  await page.close();

  page = await fresh(ctx);                                          // a board with room for the JPEG, but not for the PNG
  await dropMade(page, SMALL, 100, 100);
  const filler = LIMIT - Math.round((O + N) / 2) - 700;             // as a data URL: halfway between the two sizes
  await dropMade(page, { kind: "bytes", n: Math.floor((filler - 22) / 4) * 3 }, 700, 100);
  const before = await pictureAt(page, 0);
  // It must really be saved, not just be small enough in memory: a save of this board, with
  // both pictures, that the stub (which refuses what the route refuses) accepted...
  await page.waitForFunction(() => !!window.__bzSketch.state().jobId);
  const job = (await state(page)).jobId;
  const lens = await page.evaluate(() => window.__bzSketch.board().images.map((i) => i.url.length).sort((a, b) => a - b).join(","));
  const accepted = await cameTrue(() => saves.some((s) => s.jobId === job && s.status === 200 && s.board &&
    s.board.images.map((i) => i.url.length).sort((a, b) => a - b).join(",") === lens), 20000);
  const sizeNow = await page.evaluate(() => JSON.stringify(window.__bzSketch.board()).length);
  check("E40 setup: a board just under the 8 MB limit is saved: the server accepted a save of it with both pictures",
    accepted && sizeNow < LIMIT && sizeNow > LIMIT - 2 * 1024 * 1024, { accepted, sizeNow, saves: saves.filter((s) => s.jobId === job).map((s) => s.status + ":" + (s.board ? s.board.images.length : "-")) });
  // ...and a reload of it brings both pictures back, byte for byte
  const again = await fresh(ctx, origin + "/buzzy/sketch?job=" + encodeURIComponent(job));
  const both = await cameTrue(() => again.evaluate(() => window.__bzSketch.state().images === 2), 20000);
  const lensAgain = await again.evaluate(() => window.__bzSketch.board().images.map((i) => i.url.length).sort((a, b) => a - b).join(","));
  check("E40b ...and a reload of it brings both pictures back, byte for byte", both && lensAgain === lens, { both, lens, lensAgain });
  await again.close();
  await selectBoardPicture(page, before);
  await page.click("#rmBg");
  await sleep(1500);
  const refused = await pictureAt(page, 0);
  msg = await status(page);
  check("E41 clearing the background there is refused, with a clear message", /Not done/.test(msg) && /8 MB save limit/.test(msg) && /Nothing was changed/.test(msg), msg);
  check("E42 ...and the picture is exactly as it was (still the compact JPEG)", refused.len === before.len && refused.head === before.head, { before: before.len, now: refused.len });
  await selectBoardPicture(page, await pictureAt(page, 1));         // make room: delete the filler
  await page.keyboard.press("Delete");
  await selectBoardPicture(page, before);
  await page.click("#rmBg");
  await page.waitForFunction(() => /^data:image\/png/.test(window.__bzSketch.board().images[0].url), null, { timeout: 30000 });
  check("E43 once there is room, the same click works", /Background removed/.test(await status(page)), await status(page));
  await page.close();

  // 4. (second review) a board that is over the limit already: a clear that makes it smaller is
  //    allowed (it is progress), but it must not then say the board is small enough to save
  page = await fresh(ctx);
  // a big picture with see-through pixels (so the importer keeps it a PNG): its cleared PNG is
  // made smaller to fit the 2 MB a picture is allowed, so the board shrinks...
  await dropMade(page, { kind: "noise", w: 1600, h: 1200, block: [100, 100, 1000, 700], bg: [40, 120, 220], clear: [0, 0, 24, 24], type: "image/png" }, 100, 50);
  const big = await pictureAt(page, 0);
  // ...and a filler that keeps the board over 8 MB even with the picture at 2 MB
  const FILL = Math.round(7.6 * 1024 * 1024);
  await dropMade(page, { kind: "bytes", n: Math.floor((FILL - 22) / 4) * 3 }, 700, 100);
  const sizeBefore = await page.evaluate(() => JSON.stringify(window.__bzSketch.board()).length);
  await selectBoardPicture(page, big);
  await page.click("#rmBg");
  const done50 = await cameTrue(() => page.evaluate(() => /Background removed/.test(document.getElementById("status").textContent)), 60000);
  const said50 = await status(page);
  const after = await page.evaluate(() => { const b = window.__bzSketch.board(); return { size: JSON.stringify(b).length, head: b.images[0].url.slice(0, 22), len: b.images[0].url.length }; });
  check("E50 a board over the limit that is still over it after a clear says so, and does not claim it is small enough to save",
    done50 && /still/.test(said50) && /over the 8 MB save limit/.test(said50) && !/small enough to save/.test(said50), { sizeBefore, after: after.size, said50 });
  check("E51 ...the clear itself is kept (it made the board smaller): the picture is the cleared, smaller PNG",
    big.len > after.len && /image\/png/.test(after.head) && sizeBefore > LIMIT && after.size > LIMIT && after.size < sizeBefore, { big: big.len, now: after.len, sizeBefore, sizeAfter: after.size });
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════════
// (second review) Remove background: which colour is the background, and where the flood stops.
// A 200x100 test picture, made in the page:
//   "alphaSplit"  a red subject on the left that touches three edges (232 of the 596 edge
//                 pixels, 39%), and a blue background over the rest (61%) whose alpha is 191
//                 and 192 in turn: two coarse buckets, each fuller than none of them alone
//   "greySplit"   the same, with a grey background of 127 and 128 in turn (a colour bucket edge)
//   "gap"         a black band at alpha 128 along every edge, a see-through gap inside it, and a
//                 blob of the same black in the middle that touches no edge
const makeEdgeCase = (page, kind) => page.evaluate((kind) => {
  const w = 200, h = 100, c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), im = g.createImageData(w, h), d = im.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let p;
    if (kind === "gap") {
      const band = x < 10 || y < 10 || x >= w - 10 || y >= h - 10, blob = x >= 80 && x < 120 && y >= 35 && y < 65;
      p = band || blob ? [0, 0, 0, 128] : [0, 0, 0, 0];
    } else if (x < 67) p = [220, 30, 30, 255];
    else if (kind === "alphaSplit") p = [40, 120, 220, (x + y) % 2 ? 191 : 192];
    else p = (x + y) % 2 ? [127, 127, 127, 255] : [128, 128, 128, 255];
    d.set(p, (y * w + x) * 4);
  }
  g.putImageData(im, 0, 0);
  return c.toDataURL("image/png");
}, kind);
async function checksEdgeKey(ctx) {
  const opaqueRed = (p) => p[3] === 255 && p[0] > 200 && p[1] < 60 && p[2] < 60;
  // the edge pixels of the 200x100 picture that are not the red subject's
  const BG_EDGE = (() => { const a = []; for (let x = 67; x < 200; x += 3) a.push([x, 0], [x, 99]); for (let y = 1; y < 99; y += 3) a.push([199, y]); return a; })();
  for (const [kind, label, tol, n] of [["alphaSplit", "split between alpha 191 and 192", 34, 44], ["greySplit", "a grey split between 127 and 128", 24, 46]]) {
    const page = await fresh(ctx);
    await openPic(page, await makeEdgeCase(page, kind), 200);
    await setTol(page, tol);
    await page.click("#rmBg");
    await sleep(200);
    const px = await rasterPx(page, [[30, 50], [0, 0], [66, 99], [0, 50], ...BG_EDGE]);
    const left = px.slice(4).filter((p) => p[3] !== 0).length;
    check("E" + n + " a background " + label + " still wins over a subject that touches more edge than either half: the red subject stays (Fill tol. " + tol + ")",
      px.slice(0, 4).every(opaqueRed), px.slice(0, 4));
    check("E" + (n + 1) + " ...and the background is what is cleared, both halves of it, all along the edge", left === 0, { left, of: BG_EDGE.length, status: await status(page) });
    await page.close();
  }
  // a see-through gap stops the flood: the blob beyond it never touched an edge
  const page = await fresh(ctx);
  await openPic(page, await makeEdgeCase(page, "gap"), 200);
  await setTol(page, 64);
  await page.click("#rmBg");
  await sleep(200);
  const px = await rasterPx(page, [[0, 0], [5, 50], [195, 95], [100, 5], [100, 50], [85, 40], [115, 60]]);
  check("E48 a translucent black band along the edges is cleared (Fill tol. 64)", px.slice(0, 4).every((p) => p[3] === 0), px.slice(0, 4));
  check("E49 ...but the blob of the same black inside, beyond a see-through gap, stays: an empty pixel does not carry the flood",
    px.slice(4).every((p) => p[3] > 100 && p[3] < 160), px.slice(4));
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════════
// The new controls at phone width (the page itself is too tall for a phone held upright: that
// is as it was before; what is checked here is that nothing new spills out sideways).
async function checksPhone(ctx) {
  const page = await fresh(ctx);
  await page.setViewportSize({ width: 375, height: 812 });
  await sleep(300);
  await page.click('[data-tool="fill"]');
  const m = await page.evaluate(() => {
    const bar = document.getElementById("fillbar"), btn = document.getElementById("fillClear");
    if (!bar || !btn) return { vis: "missing", left: -1, right: 9999, vw: window.innerWidth, spill: 9999 };
    const r = btn.getBoundingClientRect();
    return { vis: getComputedStyle(bar).visibility, left: r.left, right: r.right, vw: window.innerWidth, spill: bar.scrollWidth - bar.clientWidth, label: btn.textContent.trim() };
  });
  check("G1 at 375 px wide the Fill switch is on screen in full and the bar does not spill sideways", m.vis === "visible" && m.left >= 0 && m.right <= m.vw && m.spill <= 1, m);
  await page.click('[data-tool="polygon"]');
  const q = await page.evaluate(() => { const bar = document.getElementById("polybar"), r = document.getElementById("polyFinish").getBoundingClientRect(); return { right: r.right, vw: window.innerWidth, spill: bar.scrollWidth - bar.clientWidth }; });
  check("G2 ...and the polygon bar's Finish shape button is still fully on screen too", q.right <= q.vw && q.spill <= 1, q);
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
      await scenario("A polygon (review fixes)", () => checksPolygonMore(ctx));
      await scenario("B delete", () => checksDelete(ctx, first));
      await scenario("B delete (review fixes)", () => checksDeleteMore(ctx));
      await scenario("C move", () => checksMove(ctx));
      await scenario("D see-through", () => checksSeeThrough(ctx, first));
      await scenario("D canvas panel (review fixes)", () => checksCanvasPanel(ctx, first));
      await scenario("E remove background", () => checksRemoveBackground(ctx, first));
      await scenario("E fill (review fixes)", () => checksFill(ctx, first));
      await scenario("E remove background budgets (review fixes)", () => checksRemoveBudgets(ctx));
      await scenario("E remove background key and flood (second review)", () => checksEdgeKey(ctx));
      await scenario("G phone width", () => checksPhone(ctx));
    } finally {
      await ctx.close();
    }
    first = false;
  }
  tag = "";
  check("F1 no page errors or console errors during the whole run", errors.length === 0, errors.slice(0, 5));
  // The guard at the top, guarded: an empty DPRS must make the probe exit non-zero. It used to run
  // nothing and report a pass. (The child stops at that guard, before it starts anything; the marker
  // keeps a child that did NOT stop there from testing itself again.)
  if (!process.env.SKETCH_PROBE_SELFTEST) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, DPRS: ",", SKETCH_PROBE_SELFTEST: "1" }, stdio: "ignore", timeout: 30000 });
    check("F2 a DPRS with no device pixel ratio in it makes the probe exit non-zero (it used to pass having run nothing)", child.status !== null && child.status !== 0, { status: child.status, signal: child.signal });
  }
} catch (e) {
  crashed = true;
  console.error("probe-sketch-tools: the probe itself failed: " + (e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : e));
}
try { await browser.close(); } catch { /* a connected browser is left running */ }
server.close();
if (!crashed) console.log("screenshots: " + SHOTS);
console.log(crashed ? "RESULT: probe crashed" : "RESULT: " + passed + " passed, " + failed + " failed");
process.exit(crashed ? 2 : failed ? 1 : 0);
