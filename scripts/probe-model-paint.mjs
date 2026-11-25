#!/usr/bin/env node
/**
 * probe-model-paint.mjs — paint on a 3D model what you want changed, and only that changes.
 *
 * Testers, 2026-11-24: fixing the windshield "completely messed up all the treads on the
 * tires". This checks, in a real browser, that public/buzzy/model-paint.js changes ONLY the
 * painted faces and their pixels:
 *   A. A test model (a plane, left half red, right half green, 1,024 faces) opens and turns.
 *   B. "make it black" on the red area: painted pixels go dark, unpainted pixels are
 *      byte-for-byte the same, the face count is unchanged.
 *   C. "make it see-through glass": the painted faces become their own part with a
 *      see-through (alphaMode BLEND) material; nothing else changes.
 *   D. "remove it": exactly the painted faces go.
 *   E. Anything else goes to the picture maker (stubbed here): only painted pixels take
 *      its result.
 *   F. Two colours, two different changes, in one go; the other colour's paint survives
 *      the first change.
 *   G. Esc closes (after asking when there is paint); a click outside does not.
 *
 * No server or account: public/ is served from this checkout on a free port. Browser:
 * CDP_URL=<DevTools address> (e.g. from `ai-screen.sh browser`), else Playwright's own.
 *   node scripts/probe-model-paint.mjs        (SHOTS_DIR=<folder> for screenshots)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "public");
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.resolve(here, ".."), "package.json"));
const { chromium } = require("playwright");
const SHOTS = process.env.SHOTS_DIR || "";

const TYPES = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/test.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><meta charset=utf-8><title>paint test</title></head><body style='margin:0;background:#000'></body></html>");
    return;
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
let failures = 0;
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failures++;
}

await page.goto(`${ORIGIN}/test.html`);
// The test model, made in the page with the same three.js: a plane facing the camera,
// 32×32 squares (2,048 faces), texture left half red (#c00000), right half green (#00a000).
await page.evaluate(async () => {
  const THREE = await import("/buzzy/vendor/three/three.module.min.js");
  const { GLTFExporter } = await import("/buzzy/vendor/three/addons/exporters/GLTFExporter.js");
  const { GLTFLoader } = await import("/buzzy/vendor/three/addons/loaders/GLTFLoader.js");
  window.__THREE = THREE; window.__GLTFLoader = GLTFLoader;
  const c = document.createElement("canvas"); c.width = 256; c.height = 256;
  const k = c.getContext("2d");
  k.fillStyle = "#c00000"; k.fillRect(0, 0, 128, 256);
  k.fillStyle = "#00a000"; k.fillRect(128, 0, 128, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  const geo = new THREE.PlaneGeometry(2, 2, 32, 32);
  // glTF: uv (0,0) is the image's top-left; PlaneGeometry's v runs bottom→top, so flip it.
  const uv = geo.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
  mesh.name = "panel";
  const sceneIn = new THREE.Scene();
  sceneIn.add(mesh);
  const bytes = await new Promise((res, rej) => new GLTFExporter().parse(sceneIn, res, rej, { binary: true }));
  window.__glb = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
  // Reads a saved .glb: faces per mesh, materials, and the colour at (u, v) of the first texture.
  window.__read = async (u8) => {
    const url = URL.createObjectURL(new Blob([u8], { type: "model/gltf-binary" }));
    const g = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
    const meshes = [];
    g.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const faces = meshes.map((m) => (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count) / 3);
    const mats = meshes.map((m) => ({ transparent: !!m.material.transparent, opacity: m.material.opacity, hasMap: !!m.material.map }));
    const withMap = meshes.find((m) => m.material.map);
    let px = null;
    if (withMap) {
      const img = withMap.material.map.image;
      const cc = document.createElement("canvas"); cc.width = img.width; cc.height = img.height;
      const kk = cc.getContext("2d"); kk.drawImage(img, 0, 0);
      const d = kk.getImageData(0, 0, img.width, img.height).data;
      px = (u, v) => { const x = Math.min(img.width - 1, Math.floor(u * img.width)), y = Math.min(img.height - 1, Math.floor(v * img.height)); const o = (y * img.width + x) * 4; return [d[o], d[o + 1], d[o + 2]]; };
    }
    // glTF JSON, for alphaMode.
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jsonLen)));
    return { faces, mats, alpha: (json.materials || []).map((m) => m.alphaMode || "OPAQUE"), sample: px };
  };
});

async function openPainter(repaintColour) {
  return page.evaluate(async (rc) => {
    const mod = await import("/buzzy/model-paint.js");
    window.__saved = []; window.__placed = null; window.__repaints = 0;
    window.__h = await mod.open({
      url: window.__glb, title: "Test panel",
      save: async (bytes, name, type) => { window.__saved.push({ bytes, name, type }); return { id: window.__saved.length, url: "/fake/" + window.__saved.length, name }; },
      place: (res) => { window.__placed = { done: res.done.map((d) => ({ region: d.region.key, words: d.words, kind: d.kind })), pictureUrl: res.pictureUrl }; },
      repaint: async ({ crop }) => {
        window.__repaints++;
        const i = new Image(); i.src = crop; await i.decode();
        const c = document.createElement("canvas"); c.width = i.width; c.height = i.height;
        const k = c.getContext("2d"); k.fillStyle = rc; k.fillRect(0, 0, c.width, c.height);
        return c.toDataURL("image/png");
      },
    });
    for (let i = 0; i < 50 && !window.__h.state().loaded; i++) await new Promise((r) => setTimeout(r, 100));
    return window.__h.state();
  }, repaintColour || "#ff00ff");
}
const glbOf = (i = 0) => page.evaluate(async (n) => window.__read(window.__saved.filter((s) => /\.glb$/.test(s.name))[n].bytes), i);

// A. Opens.
const s0 = await openPainter();
check("A. the model opens in the painter", s0.loaded && s0.parts === 1 && s0.faces === 2048, JSON.stringify(s0));
check("A. it can be turned (the painter starts in Turn)", s0.tool === "turn", s0.tool);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "a-opened.png") });

// B. Recolour only the painted pixels. Paint around (-0.5, 0): inside the red half.
const painted = await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
check("B. the red brush paints the faces under it", painted > 20 && painted < 400, String(painted));
await page.evaluate(() => window.__h.ask("red", "make it black"));
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "b-painted-red.png") });
const resB = await page.evaluate(async () => { await window.__h.apply(); return window.__placed; });
check("B. the change is made and placed", resB && resB.done.length === 1 && resB.done[0].kind === "look", JSON.stringify(resB));
const gB = await glbOf(0);
const centre = await page.evaluate(async () => { const r = await window.__read(window.__saved.filter((s) => /\.glb$/.test(s.name))[0].bytes); return { painted: r.sample(0.25, 0.5), redFar: r.sample(0.02, 0.05), green: r.sample(0.8, 0.5), greenEdge: r.sample(0.52, 0.5) }; });
check("B. painted pixels went dark", centre.painted[0] < 60 && centre.painted[1] < 60 && centre.painted[2] < 60, JSON.stringify(centre.painted));
check("B. unpainted red pixels are untouched", centre.redFar[0] > 180 && centre.redFar[1] < 30, JSON.stringify(centre.redFar));
check("B. the green half is untouched", centre.green[1] > 140 && centre.green[0] < 30 && centre.greenEdge[1] > 140, JSON.stringify(centre));
check("B. no face was added or lost", gB.faces.join() === "2048", JSON.stringify(gB.faces));
check("B. the painted-areas picture is saved too", !!resB.pictureUrl, String(resB && resB.pictureUrl));
await page.evaluate(() => window.__h.close(true));

// C. Glass: a part of its own, see-through.
await openPainter();
const nGlass = await page.evaluate(() => window.__h.paintWorld(0.5, 0.4, 0, "blue", 0.25));
await page.evaluate(() => window.__h.ask("blue", "Make it see-through glass"));
await page.evaluate(async () => { await window.__h.apply(); });
const gC = await glbOf(0);
check("C. the painted faces became a part of their own", gC.faces.length === 2 && gC.faces.includes(nGlass) && gC.faces.reduce((a, b) => a + b, 0) === 2048, JSON.stringify(gC.faces) + " painted " + nGlass);
check("C. that part is see-through (alphaMode BLEND), the rest is not", gC.alpha.includes("BLEND") && gC.alpha.includes("OPAQUE"), JSON.stringify(gC.alpha));
await page.evaluate(() => window.__h.close(true));

// D. Remove: exactly the painted faces go.
await openPainter();
const nRemove = await page.evaluate(() => window.__h.paintWorld(0, -0.6, 0, "red", 0.2));
await page.evaluate(() => window.__h.ask("red", "remove it"));
await page.evaluate(async () => { await window.__h.apply(); });
const gD = await glbOf(0);
check("D. exactly the painted faces were removed", gD.faces.length === 1 && gD.faces[0] === 2048 - nRemove, JSON.stringify(gD.faces) + " removed " + nRemove);
await page.evaluate(() => window.__h.close(true));

// E. Anything else: the picture maker repaints; only painted pixels take its result.
await openPainter("#ff00ff");
await page.evaluate(() => window.__h.paintWorld(0.5, -0.4, 0, "red", 0.3));
await page.evaluate(() => window.__h.ask("red", "add rust stains and scratches"));
await page.evaluate(async () => { await window.__h.apply(); });
const eS = await page.evaluate(async () => { const r = await window.__read(window.__saved.filter((s) => /\.glb$/.test(s.name))[0].bytes); return { painted: r.sample(0.75, 0.7), outside: r.sample(0.75, 0.2), red: r.sample(0.1, 0.5), repaints: window.__repaints }; });
check("E. the picture maker was asked once", eS.repaints === 1, String(eS.repaints));
check("E. painted pixels took the repaint", eS.painted[0] > 200 && eS.painted[1] < 60 && eS.painted[2] > 200, JSON.stringify(eS.painted));
check("E. pixels outside the paint kept their colour", eS.outside[1] > 140 && eS.outside[0] < 30 && eS.red[0] > 180 && eS.red[1] < 30, JSON.stringify(eS));
await page.evaluate(() => window.__h.close(true));

// F. Two colours, two changes, one go.
await openPainter();
const nr = await page.evaluate(() => window.__h.paintWorld(-0.5, 0.5, 0, "red", 0.25));
const nb = await page.evaluate(() => window.__h.paintWorld(0.5, 0.5, 0, "blue", 0.25));
await page.evaluate(() => { window.__h.ask("red", "make it see-through glass"); window.__h.ask("blue", "remove it"); });
const resF = await page.evaluate(async () => { await window.__h.apply(); return window.__placed; });
const gF = await glbOf(0);
check("F. both areas were changed, each its own way", resF.done.length === 2 && resF.done.map((d) => d.kind).join() === "glass,remove", JSON.stringify(resF.done));
check("F. the blue paint survived the red change: its faces were removed after the glass split", gF.faces.reduce((a, b) => a + b, 0) === 2048 - nb && gF.faces.includes(nr), JSON.stringify(gF.faces) + ` red ${nr} blue ${nb}`);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "f-two-areas.png") });
await page.evaluate(() => window.__h.close(true));

// G. Esc or ✕ only.
await openPainter();
await page.mouse.click(5, 5);
check("G. a click outside does not close it", await page.$(".mp-dialog") !== null);
await page.evaluate(() => window.__h.paintWorld(0, 0, 0, "red", 0.2));
let asked = false;
page.once("dialog", (d) => { asked = true; d.accept(); });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("G. Esc asks before throwing paint away, then closes", asked && (await page.$(".mp-dialog")) === null);
await openPainter();
await page.click(".mp-x");
await page.waitForTimeout(100);
check("G. ✕ closes it (no paint, no question)", (await page.$(".mp-dialog")) === null);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await context.close();
if (!process.env.CDP_URL) await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
