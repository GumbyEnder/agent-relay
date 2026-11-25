#!/usr/bin/env node
/**
 * probe-model-paint.mjs — paint on a 3D model what you want changed, and only that changes.
 *
 * Testers, 2026-11-24: fixing the windshield "completely messed up all the treads on the
 * tires". This checks, in a real browser, that public/buzzy/model-paint.js changes ONLY the
 * painted faces and their pixels, and that the file it saves is the original with a patch on it:
 *   A. A model opens in a dialog that takes the keyboard, and turns.
 *   B. "make it black" on the red area: the painted faces get their own primitive with their own
 *      copy of the texture; the original picture is byte for byte the same.
 *   C. "make it see-through glass": the painted faces become their own BLEND primitive.
 *   D. "remove it": exactly the painted faces go.
 *   E. Anything else goes to the picture maker (stubbed): only painted pixels take its result;
 *      "remove the scratches" is a repaint, never a deletion; the picture-generation use is said first.
 *   F. Two colours, two changes, one go.
 *   G. Esc or ✕ close it, also before the model has loaded, and after a load or WebGL failure.
 *   H. The brush paints what you see: a panel behind another is never painted through.
 *   I. Two nodes that share one mesh: only the painted node changes.
 *   J. A mesh with no faces left leaves the file (no empty index).
 *   K. Faces that share texels with painted ones (mirrored UVs) keep the original texture.
 *   L. Animations and untouched textures come through; a texture on UV set 1 with a transform is
 *      recoloured where the paint is.
 *   M. A finish on a part with a metallic-roughness map is done right; on a flat-shaded one, refused.
 *   N. A failure (save, placing, quota) leaves the model and the paint as they were, and a retry
 *      does not buy the picture maker's work twice. One Apply at a time; discard really discards.
 *   O. Lockdown refuses the picture maker (and says so) but a colour still works.
 *   P. A second finger never paints. Esc while dragging an edge cancels the drag, not the painter;
 *      the window has a usable minimum; closing frees what it held and gives the keyboard back.
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
const root = process.env.PAINT_PUBLIC ? path.resolve(process.env.PAINT_PUBLIC) : path.resolve(here, "..", "public");     // (PAINT_PUBLIC: a copy of public/, for mutation runs)
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.resolve(here, ".."), "package.json"));
const { chromium } = require("playwright");
const SHOTS = process.env.SHOTS_DIR || "";

const TYPES = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml" };
const held = new Map();     // models the page posts, to be served back (slowly, for the load tests)
let privacy = "open";       // the account's saved privacy mode, as /api/buzzy/privacy tells it
let spied = 0;              // requests made of /spy/…: what the painter must never ask
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname === "/api/buzzy/privacy") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, mode: privacy })); return; }
  if (url.pathname.startsWith("/set-privacy/")) { privacy = url.pathname.slice(13); res.writeHead(204); res.end(); return; }
  // An address "outside": anything asked of it is counted (the painter must never ask).
  if (url.pathname.startsWith("/spy/")) { spied++; res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")); return; }
  if (url.pathname === "/spyhits") { res.writeHead(200, { "content-type": "text/plain" }); res.end(String(spied)); return; }
  if (url.pathname === "/spyreset") { spied = 0; res.writeHead(204); res.end(); return; }
  if (url.pathname === "/test.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><meta charset=utf-8><title>paint test</title></head><body style='margin:0;background:#000'>" +
      "<div id='board'><button id='opener'>Paint changes</button></div><script src='/buzzy/resize.js'></script></body></html>");
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/put/")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { held.set(url.pathname.slice(5), Buffer.concat(chunks)); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname.startsWith("/glb/")) {
    const body = held.get(url.pathname.slice(5));
    const delay = Number(url.searchParams.get("delay") || 0);
    setTimeout(() => {
      if (!body) { res.writeHead(404); res.end("no such model"); return; }
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      res.end(body);
    }, delay);
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
const dialogs = [];
page.on("pageerror", (e) => errors.push(e.message));
// Two errors are the point of a test (WebGL refused, a model that is not there): not faults.
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const where = (m.location() || {}).url || "";
  if (/Error creating WebGL context/.test(m.text()) || /\/glb\/nothing-here$/.test(where)) return;
  errors.push(m.text() + (where ? " @ " + where : ""));
});
page.on("dialog", async (d) => { dialogs.push(d.message()); try { await d.accept(); } catch { /* it closed itself */ } });
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failures++;
}
const J = (v) => JSON.stringify(v);
/** Run one block of checks; if it throws (a saved file that is not there, say) that is itself a failed check, and the rest still run. */
async function section(name, fn) {
  try { await fn(); } catch (e) { check(`${name} (the checks stopped: ${String(e && e.message).split("\n")[0].slice(0, 160)})`, false); }
  try { await page.evaluate(() => { if (window.__h) { try { window.__h.close(true); } catch { /* closed */ } } localStorage.removeItem("bz.size.model-paint"); }); } catch { /* the page is gone */ }
  try { await page.setViewportSize({ width: 1280, height: 860 }); } catch { /* the page is gone */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The window is gone (given a moment: closing may wait for an answer to a question, and a busy machine is slow). */
const gone = async () => { for (let i = 0; i < 40; i++) { if (!(await page.$(".mp-dialog"))) return true; await sleep(100); } return false; };

await page.goto(`${ORIGIN}/test.html`);

// ── The test models, made in the page with the same three.js, and what is read back from a saved file ──
await page.evaluate(async () => {
  const THREE = await import("/buzzy/vendor/three/three.module.min.js");
  const { GLTFExporter } = await import("/buzzy/vendor/three/addons/exporters/GLTFExporter.js");
  const { GLTFLoader } = await import("/buzzy/vendor/three/addons/loaders/GLTFLoader.js");
  const { readGlb } = await import("/buzzy/glb-patch.js");
  window.__bytes = {}; window.__glbs = {}; window.__GLTFLoader = GLTFLoader; window.__THREE = THREE;
  const { writeGlb } = await import("/buzzy/glb-patch.js");
  const b64 = (u8) => { let t = ""; for (let i = 0; i < u8.length; i += 8192) t += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(t); };

  // A 256² texture, left half one colour, right half another (glTF: (0,0) is the picture's top-left).
  const tex = (left, right) => {
    const c = document.createElement("canvas"); c.width = 256; c.height = 256;
    const k = c.getContext("2d");
    k.fillStyle = left; k.fillRect(0, 0, 128, 256);
    k.fillStyle = right; k.fillRect(128, 0, 128, 256);
    const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const plane = (w, h, sx, sy) => {
    const g = new THREE.PlaneGeometry(w, h, sx, sy);
    const uv = g.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));    // v runs top→bottom
    return g;
  };
  const mesh = (g, m, name, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(g, m); o.name = name; o.position.set(x, y, z); return o; };
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const keep = async (key, scene, opts) => {
    const bytes = new Uint8Array(await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true, ...(opts || {}) })));
    window.__bytes[key] = bytes;
    window.__glbs[key] = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
    await fetch("/put/" + key, { method: "POST", body: bytes });
  };
  const scene = (...objs) => { const s = new THREE.Scene(); objs.forEach((o) => s.add(o)); return s; };

  await keep("panel", scene(mesh(plane(2, 2, 32, 32), std({ map: tex("#c00000", "#00a000"), roughness: 0.8 }), "panel")));
  // Two panels, one behind the other, nothing in common but where they stand.
  await keep("twoPanels", scene(mesh(plane(2, 2, 8, 8), std({ color: 0x8899aa }), "front"), mesh(plane(2, 2, 8, 8), std({ color: 0xaa9988 }), "back", 0, 0, -0.05)));
  // A panel whose picture is solid black (it used to stay black whatever colour it was asked for).
  await keep("black", scene(mesh(plane(2, 2, 16, 16), std({ map: tex("#000000", "#000000") }), "black")));
  // A small panel in front of a big one, far behind: the big one shows all round the small one.
  await keep("stepped", scene(mesh(plane(1, 1, 4, 4), std({ color: 0x8899aa }), "near"), mesh(plane(3, 3, 8, 8), std({ color: 0xaa9988 }), "far", 0, 0, -1.5)));
  // Two wheels: two nodes, one mesh (the exporter shares a mesh that has one geometry and one material).
  const wg = plane(1, 1, 4, 4), wm = std({ map: tex("#c00000", "#00a000") });
  await keep("shared", scene(mesh(wg, wm, "left wheel", -1, 0, 0), mesh(wg, wm, "right wheel", 1, 0, 0)));
  // A tiny part (two faces) beside a bigger one.
  await keep("empty", scene(mesh(plane(1, 1, 1, 1), std({ color: 0xcc4444 }), "tiny", -1.5), mesh(plane(1, 1, 2, 2), std({ color: 0x44cc44 }), "other", 1.5)));
  // Mirrored: the left quad and the right quad both use the left half of the picture (red).
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 0, -1, 0, 0, 1, 0, -1, 1, 0, 0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(8).fill([0, 0, 1]).flat(), 3));
    const q = [0, 1, 0.5, 1, 0.5, 0, 0, 0];
    g.setAttribute("uv", new THREE.Float32BufferAttribute([...q, ...q], 2));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    await keep("mirror", scene(mesh(g, std({ map: tex("#c00000", "#00a000") }), "mirror")));
  }
  // With an animation.
  {
    const m = mesh(plane(2, 2, 8, 8), std({ map: tex("#c00000", "#00a000") }), "slider");
    const clip = new THREE.AnimationClip("slide", 1, [new THREE.VectorKeyframeTrack("slider.position", [0, 1], [0, 0, 0, 0, 1, 0])]);
    await keep("animated", scene(m), { animations: [clip] });
  }
  // The picture is on UV set 1, with a transform: the plane uses the RIGHT half of it (green).
  {
    const g = plane(2, 2, 16, 16);
    g.setAttribute("uv1", g.getAttribute("uv").clone());
    const uv = g.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0, 0);     // set 0 says nothing useful
    const t = tex("#c00000", "#00a000");
    t.channel = 1; t.repeat.set(0.5, 1); t.offset.set(0.5, 0);
    await keep("uv1", scene(mesh(g, std({ map: t }), "uv1")));
  }
  // A finish map: roughness in green (200 → 0.78), metalness in blue (0), over a plain base colour picture.
  {
    const mr = document.createElement("canvas"); mr.width = 256; mr.height = 256;
    const k = mr.getContext("2d"); k.fillStyle = "rgb(0,200,0)"; k.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(mr); t.flipY = false;
    await keep("mr", scene(mesh(plane(2, 2, 16, 16), std({ map: tex("#c00000", "#00a000"), roughnessMap: t, metalnessMap: t, roughness: 1, metalness: 1 }), "mr")));
  }
  // The same panel as a .gltf, with its data inside it (data: addresses); and one that points at another file.
  {
    const m = mesh(plane(2, 2, 8, 8), std({ map: tex("#c00000", "#00a000") }), "text");
    const out = await new Promise((res, rej) => new GLTFExporter().parse(scene(m), res, rej, { binary: false }));
    const text = new TextEncoder().encode(JSON.stringify(out));
    window.__bytes.gltf = text;
    window.__glbs.gltf = URL.createObjectURL(new Blob([text], { type: "model/gltf+json" }));
    await fetch("/put/external", { method: "POST", body: new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "model.bin", byteLength: 8 }] })) });
  }
  await keep("unlit", scene(mesh(plane(2, 2, 8, 8), new THREE.MeshBasicMaterial({ color: 0x336699 }), "unlit")));
  {
    const g = plane(2, 2, 8, 8);
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(g.getAttribute("position").count).fill([0, 1, 0]).flat(), 3));
    await keep("vcolor", scene(mesh(g, std({ vertexColors: true }), "vcolor")));
  }

  // ── Models for the second review ──
  // A model that asks outside for its picture (and one for a second buffer): the loader would go and fetch them.
  {
    const g = readGlb(window.__bytes.panel);
    const img = JSON.parse(JSON.stringify(g.json));
    img.images[0] = { uri: location.origin + "/spy/pic.png", mimeType: "image/png" };
    window.__bytes.spyimage = writeGlb(img, g.bin);
    const buf = JSON.parse(JSON.stringify(g.json));
    buf.buffers.push({ uri: location.origin + "/spy/data.bin", byteLength: 8 });
    window.__bytes.spybuffer = writeGlb(buf, g.bin);
    // …and one that has its picture inside as a data: address (the file's own, so allowed).
    const emb = JSON.parse(JSON.stringify(g.json));
    const v = emb.bufferViews[emb.images[0].bufferView];
    emb.images[0] = { uri: "data:image/png;base64," + b64(g.bin.slice(v.byteOffset, v.byteOffset + v.byteLength)), mimeType: "image/png" };
    window.__bytes.datauri = writeGlb(emb, g.bin);
    for (const k of ["spyimage", "spybuffer", "datauri"]) window.__glbs[k] = URL.createObjectURL(new Blob([window.__bytes[k]], { type: "model/gltf-binary" }));
  }
  // A grille with holes (alphaMode MASK: left half solid red, right half cut away) in front of a wall.
  {
    const c = document.createElement("canvas"); c.width = 256; c.height = 256;
    const k = c.getContext("2d"); k.fillStyle = "rgba(200,0,0,1)"; k.fillRect(0, 0, 128, 256);       // the right half stays transparent
    const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
    await keep("cutout", scene(mesh(plane(2, 2, 8, 8), std({ map: t, alphaTest: 0.5 }), "grille"), mesh(plane(4, 4, 8, 8), std({ color: 0x889988 }), "wall", 0, 0, -0.5)));
  }
  // A plane with a morph weight: drawn half a unit higher than its position attribute says.
  {
    const g = plane(2, 2, 8, 8);
    const n = g.getAttribute("position").count;
    const up = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) up[i * 3 + 1] = 1;
    g.morphAttributes.position = [new THREE.Float32BufferAttribute(up, 3)];
    g.morphTargetsRelative = true;
    const m = mesh(g, std({ color: 0x8899aa }), "morph");
    m.morphTargetInfluences = [0.5];
    await keep("morph", scene(m));
  }
  // Two scenes, the default holding one wheel and the other scene the other (the loader prunes its notes per scene).
  {
    const g = readGlb(window.__bytes.shared);
    const j = JSON.parse(JSON.stringify(g.json));
    j.scenes = [{ nodes: [0] }, { nodes: [1] }]; j.scene = 0;
    window.__bytes.twoScenes = writeGlb(j, g.bin);
    window.__glbs.twoScenes = URL.createObjectURL(new Blob([window.__bytes.twoScenes], { type: "model/gltf-binary" }));
  }
  // A windshield that lets light through by transmission (alphaMode OPAQUE, yet see-through).
  {
    const m = new THREE.MeshPhysicalMaterial({ color: 0x99ccff, transmission: 1, roughness: 0.1 });
    await keep("transmission", scene(mesh(plane(2, 2, 8, 8), m, "windshield")));
  }
  // Vertex colours that carry opacity (RGBA) on a blended surface.
  {
    const g = plane(2, 2, 8, 8);
    const n = g.getAttribute("position").count;
    const rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { rgba[i * 4] = 0; rgba[i * 4 + 1] = 1; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = i % 4 === 0 ? 0.25 : 0.75; }
    g.setAttribute("color", new THREE.Float32BufferAttribute(rgba, 4));
    await keep("valpha", scene(mesh(g, std({ vertexColors: true, transparent: true }), "valpha")));
  }
  // A picture drawn clamped, and the face lies wholly past its right edge (u 1.2 … 1.4).
  {
    const g = plane(2, 2, 8, 8);
    const uv = g.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1.2 + uv.getX(i) * 0.2);
    await keep("clamp", scene(mesh(g, std({ map: tex("#c00000", "#00a000") }), "clamp")));
  }
  // A finish map that is a JPEG: roughness (green) 200, metalness (blue) a gradient the compressor would move.
  {
    const mr = document.createElement("canvas"); mr.width = 256; mr.height = 256;
    const k = mr.getContext("2d");
    for (let x = 0; x < 256; x++) { k.fillStyle = `rgb(0,200,${(x * 7) % 256})`; k.fillRect(x, 0, 1, 256); }
    const t = new THREE.CanvasTexture(mr); t.flipY = false; t.userData.mimeType = "image/jpeg";
    await keep("mrjpeg", scene(mesh(plane(2, 2, 16, 16), std({ map: tex("#c00000", "#00a000"), roughnessMap: t, metalnessMap: t, roughness: 1, metalness: 1 }), "mrjpeg")));
  }
  // Near the Library's limit (and over it): a binary part padded out.
  {
    const g = readGlb(window.__bytes.panel);
    const pad = (size) => { const j = JSON.parse(JSON.stringify(g.json)); const bin = new Uint8Array(size); bin.set(g.bin); j.buffers[0].byteLength = size; return writeGlb(j, bin); };
    const limit = 25 * 1024 * 1024;
    window.__bytes.bigbin = pad(limit - 10000);
    window.__bytes.toobig = pad(limit + 4000);
    for (const k of ["bigbin", "toobig"]) window.__glbs[k] = URL.createObjectURL(new Blob([window.__bytes[k]], { type: "model/gltf-binary" }));
  }
  // A small panel that faces +z at x = 1, and a big cover at x = -4: seen from the side (the way the model is "seen from
  // outside" from its middle) the small one is edge-on and shows nothing; from the front, where it was painted, it shows.
  await keep("hidden", scene(mesh(plane(1, 1, 4, 4), std({ color: 0x8899aa }), "target", 1, 0, 0), mesh(plane(2, 2, 4, 4), std({ color: 0xaa9988 }), "cover", -4, 0, 0)));

  // The numbers a vertex-colour accessor holds, per primitive of a node's mesh.
  window.__colours = (u8, nodeName) => {
    const { json, bin } = readGlb(u8);
    const node = json.nodes.find((n) => n.name === nodeName);
    return json.meshes[node.mesh].primitives.map((p) => {
      if (p.attributes.COLOR_0 === undefined) return null;
      const a = json.accessors[p.attributes.COLOR_0], v = json.bufferViews[a.bufferView];
      const items = a.type === "VEC4" ? 4 : 3;
      const f = new Float32Array(bin.slice(v.byteOffset + (a.byteOffset || 0), v.byteOffset + (a.byteOffset || 0) + a.count * items * 4).buffer);
      return { type: a.type, count: a.count, rgbMin: Math.min(...Array.from(f).filter((_x, i) => i % items < 3)), rgbMax: Math.max(...Array.from(f).filter((_x, i) => i % items < 3)), alpha: items === 4 ? Array.from(f).filter((_x, i) => i % 4 === 3) : null, rgb0: [f[0], f[1], f[2]] };
    });
  };

  // What a saved file holds: per node its mesh; per mesh its primitives (faces, material, picture…).
  window.__desc = (u8) => {
    const { json } = readGlb(u8);
    const faces = (p) => (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3;
    const tex = (info) => (info && json.textures[info.index] ? json.textures[info.index].source : null);
    return {
      nodes: (json.nodes || []).map((n) => ({ name: n.name || "", mesh: n.mesh })),
      meshes: (json.meshes || []).map((m) => m.primitives.map((p) => {
        const mat = p.material !== undefined ? (json.materials || [])[p.material] : null;
        const pbr = (mat && mat.pbrMetallicRoughness) || {};
        return { faces: faces(p), alpha: (mat && mat.alphaMode) || "OPAQUE", image: tex(pbr.baseColorTexture), mrImage: tex(pbr.metallicRoughnessTexture), color: !!p.attributes.COLOR_0,
          rough: pbr.roughnessFactor, metal: pbr.metallicFactor, base: pbr.baseColorFactor || null, matName: mat && mat.name,
          transmission: !!(mat && mat.extensions && mat.extensions.KHR_materials_transmission), mrMime: pbr.metallicRoughnessTexture ? (json.images[tex(pbr.metallicRoughnessTexture)] || {}).mimeType : null };
      })),
      images: (json.images || []).length,
      uris: (json.images || []).filter((i) => i.uri !== undefined).length + (json.buffers || []).filter((b) => b.uri !== undefined).length,
      animations: json.animations || [],
      emptyAccessors: json.accessors.filter((a) => a.count === 0).length,
    };
  };
  // The colours at (u, v) points of one picture inside a file (u, v from the picture's top-left).
  window.__sample = async (u8, image, uvs) => {
    const { json, bin } = readGlb(u8);
    const v = json.bufferViews[json.images[image].bufferView];
    const bmp = await createImageBitmap(new Blob([bin.slice(v.byteOffset, v.byteOffset + v.byteLength)], { type: json.images[image].mimeType }));
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    const k = c.getContext("2d"); k.drawImage(bmp, 0, 0);
    return uvs.map(([u, w]) => Array.from(k.getImageData(Math.min(bmp.width - 1, Math.floor(u * bmp.width)), Math.min(bmp.height - 1, Math.floor(w * bmp.height)), 1, 1).data.slice(0, 3)));
  };
  window.__imageBytes = (u8, image) => { const { json, bin } = readGlb(u8); const v = json.bufferViews[json.images[image].bufferView]; return Array.from(bin.slice(v.byteOffset, v.byteOffset + v.byteLength)); };
  window.__loads = async (u8) => {     // does three.js read it, and what does it see?
    const url = URL.createObjectURL(new Blob([u8], { type: "model/gltf-binary" }));
    const g = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
    const meshes = [];
    g.scene.traverse((o) => { if (o.isMesh) meshes.push(o.name); });
    return { meshes, animations: g.animations.length };
  };

  // Open the painter on one of the models, with stand-ins for the account (save, board, picture maker).
  window.__open = async (key, o = {}) => {
    const mod = await import("/buzzy/model-paint.js");
    window.__saved = []; window.__placed = null; window.__repaints = []; window.__placeCalls = 0; window.__saveCalls = 0; window.__closed = 0;
    let failSave = o.failSave || 0, failPlace = o.failPlace || 0;
    if (o.focusOpener !== false) document.getElementById("opener").focus();
    const opts = {
      url: o.url || window.__glbs[key],
      title: key,
      save: async (bytes, name, type) => {
        window.__saveCalls++;
        if (o.saveDelay) await new Promise((r) => setTimeout(r, o.saveDelay));
        if (failSave > 0 && /\.glb$/.test(name)) { failSave--; throw new Error("the Library said no"); }
        window.__saved.push({ bytes: new Uint8Array(bytes), name, type });
        return { id: window.__saved.length, url: "/fake/" + window.__saved.length, name };
      },
      place: (res) => {
        window.__placeCalls++;
        if (failPlace > 0) { failPlace--; return false; }
        window.__placed = { done: res.done.map((d) => ({ region: d.region.key, words: d.words, kind: d.kind, picture: d.pictureUrl })), pictures: res.pictures.length };
        return true;
      },
      repaint: async ({ crop, instruction }) => {
        window.__repaints.push(instruction);
        const i = new Image(); i.src = crop; await i.decode();
        const c = document.createElement("canvas"); c.width = i.width; c.height = i.height;
        const k = c.getContext("2d"); k.fillStyle = o.repaintColour || "#ff00ff"; k.fillRect(0, 0, c.width, c.height);
        return c.toDataURL("image/png");
      },
      onClose: () => { window.__closed++; },
    };
    // The picture maker's allowance, as the server would say it: o.allowanceLeft generations are left today.
    window.__allowanceAsked = [];
    opts.allowance = async (units) => {
      window.__allowanceAsked.push(units);
      return o.allowanceLeft !== undefined && units > o.allowanceLeft ? `This change needs the picture maker ${units} times, and image quota for the starter plan is 60 per day — ${o.allowanceLeft} left. Nothing has been spent.` : "";
    };
    if (o.canPlace) opts.canPlace = () => o.canPlace;
    if (o.privacy) opts.privacy = async () => o.privacy;
    window.__h = await mod.open(opts);
    return window.__h.state();
  };
  window.__model = () => window.__saved.filter((s) => /\.glb$/.test(s.name))[0] && window.__saved.filter((s) => /\.glb$/.test(s.name))[0].bytes;
});

const open = (key, o) => page.evaluate(([k, x]) => window.__open(k, x), [key, o || {}]);
const state = () => page.evaluate(() => window.__h.state());
const desc = () => page.evaluate(() => { const m = window.__model(); if (!m) throw new Error("nothing was saved: " + (document.querySelector(".mp-status") || {}).textContent); return window.__desc(m); });
const sample = (image, uvs) => page.evaluate(([i, p]) => window.__sample(window.__model(), i, p), [image, uvs]);
const close = () => page.evaluate(() => window.__h.close(true));
const apply = () => page.evaluate(async () => { await window.__h.apply(); return window.__placed; });
const statusText = () => page.evaluate(() => (document.querySelector(".mp-status") || {}).textContent || "");
const sum = (l) => l.reduce((a, b) => a + b, 0);
const dark = (c) => c[0] < 60 && c[1] < 60 && c[2] < 60;
const red = (c) => c[0] > 160 && c[1] < 40 && c[2] < 40;
const green = (c) => c[1] > 130 && c[0] < 40 && c[2] < 40;

// A. Opens, and takes the keyboard.
const s0 = await open("panel");
check("A. the model opens in the painter", s0.loaded && s0.parts === 1 && s0.faces === 2048 && !s0.failed, J(s0));
check("A. it can be turned (the painter starts in Turn)", s0.tool === "turn", s0.tool);
check("A. the keyboard is in the window, and the page behind it can't be reached", await page.evaluate(() => !!document.activeElement.closest(".mp-box") && !!document.getElementById("opener").closest("[inert]") && document.querySelector(".mp-box").getAttribute("aria-modal") === "true"));
{
  await page.evaluate(() => { window.__deleted = 0; document.addEventListener("keydown", (e) => { if (e.key === "Delete" && document.getElementById("board").contains(document.activeElement)) window.__deleted++; }); });
  await page.keyboard.press("Delete");
  check("A. the board's own keys do nothing behind it (Delete)", (await page.evaluate(() => window.__deleted)) === 0);
}
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "a-opened.png") });
await close();
check("A. closing gives the keyboard back to the button that opened it, and the page is live again", await page.evaluate(() => document.activeElement === document.getElementById("opener") && !document.getElementById("opener").closest("[inert]")) && (await page.evaluate(() => window.__closed)) === 1);

// B. A colour: only the painted faces, on a primitive and a texture copy of their own.
await open("panel");
const painted = await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
check("B. the red brush paints the faces under it", painted > 20 && painted < 400, String(painted));
await page.evaluate(() => window.__h.ask("red", "make it black"));
check("B. the words are read back before anything is done", /Recolours it black/.test(await page.textContent(".mp-note")), await page.textContent(".mp-note"));
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "b-painted-red.png") });
const resB = await apply();
check("B. the change is made and placed, with a picture of the painted area", resB && resB.done.length === 1 && resB.done[0].kind === "look" && resB.pictures === 1 && !!resB.done[0].picture, J(resB));
const dB = await desc();
check("B. the painted faces are a primitive of their own; no face was added or lost", dB.meshes[0].length === 2 && dB.meshes[0][0].faces === 2048 - painted && dB.meshes[0][1].faces === painted && sum(dB.meshes[0].map((p) => p.faces)) === 2048, J(dB.meshes));
check("B. the unpainted faces keep the original material and picture; the painted ones have a copy", dB.meshes[0][0].image === 0 && dB.meshes[0][1].image !== 0 && dB.images === 2, J(dB.meshes) + " images " + dB.images);
check("B. the original picture is byte for byte the same", J(await page.evaluate(() => window.__imageBytes(window.__model(), 0))) === J(await page.evaluate((k) => window.__imageBytes(window.__bytes[k], 0), "panel")));
const cB = await sample(dB.meshes[0][1].image, [[0.25, 0.5], [0.02, 0.05], [0.8, 0.5], [0.52, 0.5]]);
check("B. in the copy, the painted pixels went dark", dark(cB[0]), J(cB[0]));
check("B. …and the pixels around them are as they were (red far from the paint, the green half, beside the seam)", red(cB[1]) && green(cB[2]) && green(cB[3]), J(cB));
check("B. the saved file is the original with a patch: its nodes and meshes are the same", (await page.evaluate((k) => { const a = window.__desc(window.__bytes[k]), b = window.__desc(window.__model()); return JSON.stringify(a.nodes) === JSON.stringify(b.nodes) && a.animations.length === b.animations.length; }, "panel")));
{
  const st = await state();
  check("B. the painter then shows what was saved (the new primitive is a part, paint cleared), so it can be painted again", st.parts === 2 && st.faces === 2048 && !st.dirty && !st.busy && st.counts[1] === 0, J(st));
  check("B. it says it is done, once", /^Done — the changed model is on your board/.test(await statusText()), await statusText());
}
await close();

// C. Glass: a part of its own, see-through.
await open("panel");
const nGlass = await page.evaluate(() => window.__h.paintWorld(0.5, 0.4, 0, "blue", 0.25));
await page.evaluate(() => window.__h.ask("blue", "Make it see-through glass"));
await apply();
const dC = await desc();
check("C. the painted faces became a primitive of their own", dC.meshes[0].length === 2 && dC.meshes[0].some((p) => p.faces === nGlass) && sum(dC.meshes[0].map((p) => p.faces)) === 2048, J(dC.meshes) + " painted " + nGlass);
check("C. that part is see-through (alphaMode BLEND), the rest is not", dC.meshes[0].filter((p) => p.alpha === "BLEND").length === 1 && dC.meshes[0].filter((p) => p.alpha === "OPAQUE").length === 1, J(dC.meshes));
await close();

// D. Remove: exactly the painted faces go.
await open("panel");
const nRemove = await page.evaluate(() => window.__h.paintWorld(0, -0.6, 0, "red", 0.2));
await page.evaluate(() => window.__h.ask("red", "remove it"));
await apply();
const dD = await desc();
check("D. exactly the painted faces were removed", dD.meshes[0].length === 1 && dD.meshes[0][0].faces === 2048 - nRemove, J(dD.meshes) + " removed " + nRemove);
await close();

// E. Anything else: the picture maker repaints; only painted pixels take its result. Say first what it costs.
await open("panel", { repaintColour: "#ff00ff" });
await page.evaluate(() => window.__h.paintWorld(0.5, -0.4, 0, "red", 0.3));
await page.evaluate(() => window.__h.ask("red", "remove the scratches"));
check("E. “remove the scratches” is read as a repaint, and what it costs is said before Apply", /picture generation/.test(await page.textContent(".mp-apply")) && /uses 1 picture generation/i.test(await page.textContent(".mp-note")) && /uses 1 picture generation/i.test(await statusText()), (await page.textContent(".mp-apply")) + " | " + (await page.textContent(".mp-note")));
await apply();
const eS = await page.evaluate(async () => {
  const d = window.__desc(window.__model());
  const u8 = window.__model();
  return { d, painted: (await window.__sample(u8, d.meshes[0][1].image, [[0.75, 0.7], [0.75, 0.2], [0.1, 0.5]])), repaints: window.__repaints.length };
});
check("E. the picture maker was asked once; no face was taken off", eS.repaints === 1 && sum(eS.d.meshes[0].map((p) => p.faces)) === 2048 && eS.d.meshes[0].length === 2, J(eS.d.meshes));
check("E. painted pixels took the repaint; pixels outside the paint kept their colour", eS.painted[0][0] > 200 && eS.painted[0][1] < 60 && eS.painted[0][2] > 200 && green(eS.painted[1]) && red(eS.painted[2]), J(eS.painted));
await close();

// F. Two colours, two changes, one go. Every painted area needs its words first.
await open("panel");
const nr = await page.evaluate(() => window.__h.paintWorld(-0.5, 0.5, 0, "red", 0.25));
const nb = await page.evaluate(() => window.__h.paintWorld(0.5, 0.5, 0, "blue", 0.25));
await page.evaluate(() => window.__h.ask("red", "make it see-through glass"));
check("F. Apply waits until every painted area has been told how to change", (await page.$eval(".mp-apply", (b) => b.disabled)) && /blue area/.test(await statusText()), await statusText());
await page.evaluate(() => window.__h.ask("blue", "remove it"));
const resF = await apply();
const dF = await desc();
check("F. both areas were changed, each its own way", resF.done.length === 2 && resF.done.map((d) => d.kind).join() === "glass,remove", J(resF));
check("F. each painted area has its own picture saved, so each note can show what it is about", resF.pictures === 2 && resF.done.every((d) => !!d.picture) && resF.done[0].picture !== resF.done[1].picture, J(resF));
check("F. the faces add up: the glass faces became their own primitive and the blue ones went", sum(dF.meshes[0].map((p) => p.faces)) === 2048 - nb && dF.meshes[0].some((p) => p.faces === nr && p.alpha === "BLEND"), J(dF.meshes) + ` red ${nr} blue ${nb}`);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "f-two-areas.png") });
await close();

// G. Esc or ✕ only, and they work before the model has loaded and after a failure.
await open("panel");
await page.mouse.click(5, 5);
check("G. a click outside does not close it", await page.$(".mp-dialog") !== null);
await page.evaluate(() => window.__h.paintWorld(0, 0, 0, "red", 0.2));
dialogs.length = 0;
await page.keyboard.press("Escape");
await sleep(200);
check("G. Esc asks before throwing paint away, then closes", dialogs.length === 1 && /paint will be lost/.test(dialogs[0]) && (await gone()), J(dialogs));
await open("panel");
dialogs.length = 0;
await page.click(".mp-x");
await sleep(100);
check("G. ✕ closes it (no paint, no question)", (await gone()) && dialogs.length === 0);
{
  // A slow load: Esc and ✕ work at once, and the late arrival does nothing.
  await page.evaluate((u) => { window.__late = import("/buzzy/model-paint.js").then((m) => m.open({ url: u, title: "slow" })); }, `${ORIGIN}/glb/panel?delay=1200`);
  await page.waitForSelector(".mp-dialog");
  check("G. while the model is still loading the window is there and says so", /Loading/.test(await page.textContent(".mp-hint")));
  await page.keyboard.press("Escape");
  await sleep(100);
  check("G. Esc closes it before the model has loaded", (await gone()));
  await sleep(1500);
  check("G. …and the model that arrives afterwards changes nothing (no window, no error)", (await gone()) && errors.length === 0, errors.join(" | "));
}
{
  const bad = await open("panel", { url: `${ORIGIN}/glb/nothing-here` });
  check("G. a model that cannot be opened says why and stays on screen", !!bad.failed && /could not be opened/.test(await page.textContent(".mp-hint")) && /err/.test(await page.getAttribute(".mp-hint", "class")), J(bad));
  await page.keyboard.press("Tab");
  await page.keyboard.press("r");
  check("G. …its message is not replaced by the tool hint", /could not be opened/.test(await page.textContent(".mp-hint")));
  await page.keyboard.press("Escape");
  await sleep(100);
  check("G. …and Esc closes it", (await gone()));
  await page.evaluate(() => fetch("/put/notglb", { method: "POST", body: new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n") }));
  const txt = await open("panel", { url: `${ORIGIN}/glb/notglb` });
  check("G. a file that is not a .glb or .gltf (an .obj, say) says so", !!txt.failed && /not a \.glb or \.gltf/.test(await page.textContent(".mp-hint")), await page.textContent(".mp-hint"));
  await page.click(".mp-x");
  await sleep(100);
  check("G. …and ✕ closes it", (await gone()));
}
{
  // WebGL cannot start: the message stays, the window can still be closed.
  await page.evaluate(() => { window.__getContext = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...r) { return /webgl/.test(t) ? null : window.__getContext.call(this, t, ...r); }; });
  const noGl = await open("panel");
  await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = window.__getContext; });
  check("G. when WebGL cannot start the window says so and stays", !!noGl.failed && /could not start/.test(await page.textContent(".mp-hint")) && (await page.$(".mp-dialog")) !== null, J(noGl));
  check("G. …with nothing to paint with", await page.$eval(".mp-tools button:nth-of-type(2)", (b) => b.disabled));
  await page.keyboard.press("Escape");
  await sleep(100);
  check("G. …and Esc closes it", (await gone()));
}

// H. The brush paints what you see, not what is behind it.
await open("twoPanels");
{
  // (The case is a real hazard: a brush that only measured distance in the model would paint both panels.)
  await page.evaluate(() => window.__h.paintWorld(0, 0, 0, "red", 0.2));
  const per = await page.evaluate(() => window.__h.parts());
  check("H. (a brush that measured distance, not sight, would paint both panels)", per.every((p) => p.painted > 0), J(per));
  await close();
}
await open("twoPanels");
await page.evaluate(() => window.__h.setView(0, 0, 4, 0, 0, 0));
{
  await page.evaluate(() => { document.querySelector(".mp-tools input[type=range]").value = "70"; });
  const at = await page.evaluate(() => window.__h.screenOf(0, 0, 0));
  const n = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [at.x, at.y]);
  const per = await page.evaluate(() => window.__h.parts());
  check("H. the brush paints the panel it is on", n > 0 && per.find((p) => p.name === "front").painted > 0, J(per));
  check("H. a panel behind it stays unpainted", per.find((p) => p.name === "back").painted === 0, J(per));
  await page.evaluate(() => window.__h.ask("red", "remove it"));
  await apply();
  const d = await desc();
  const faces = (name) => { const n2 = d.nodes.find((q) => q.name === name); return n2 && n2.mesh !== undefined ? sum(d.meshes[n2.mesh].map((p) => p.faces)) : 0; };
  check("H. removing what was painted takes nothing off the panel behind", faces("back") === 128 && faces("front") < 128 && faces("front") > 0, `front ${faces("front")} back ${faces("back")}`);
  await close();
}
await open("stepped");
{
  // The brush's disc, at the small panel's edge, also covers the big panel that shows past it, far behind.
  await page.evaluate(() => window.__h.setView(0, 0, 4, 0, 0, 0));
  const at = await page.evaluate(() => window.__h.screenOf(0.45, 0, 0));
  await page.evaluate(() => { document.querySelector(".mp-tools input[type=range]").value = "90"; });
  const n = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [at.x, at.y]);
  const per = await page.evaluate(() => window.__h.parts());
  check("H. a part that shows past the edge of the one being painted, far behind it, is left alone", n > 0 && per.find((p) => p.name === "near").painted > 0 && per.find((p) => p.name === "far").painted === 0, J(per));
  await close();
}
await open("panel");
{
  // A one-sided face the model hides (its back) is hidden to the brush too.
  await page.evaluate(() => window.__h.setView(0, 0, -4, 0, 0, 0));
  const at = await page.evaluate(() => window.__h.screenOf(0, 0, 0));
  const n = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [at.x, at.y]);
  check("H. the back of a one-sided panel, which the model does not show, is not painted", n === 0, String(n));
  await page.evaluate(() => window.__h.setView(0, 0, 4, 0, 0, 0));
  const front = await page.evaluate(() => window.__h.screenOf(0, 0, 0));
  const m = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [front.x, front.y]);
  check("H. …and the front of it is", m > 0, String(m));
  const e = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "erase"), [front.x, front.y]);
  check("H. the eraser takes the paint off what is seen", e === m && (await state()).counts[1] === 0, `${e} vs ${m}`);
  await close();
}

// I. Two nodes that share one mesh: only the painted one changes.
await open("shared");
{
  const before = await page.evaluate(() => window.__desc(window.__bytes.shared));
  check("I. (the model: two nodes, one mesh)", before.nodes.length === 2 && before.nodes[0].mesh === before.nodes[1].mesh && before.meshes.length === 1, J(before.nodes));
  const nn = await page.evaluate(() => window.__h.paintWorld(-1, 0, 0, "red", 0.45));
  await page.evaluate(() => window.__h.ask("red", "remove it"));
  await apply();
  const d = await desc();
  const left = d.nodes.find((q) => q.name === "left wheel"), right = d.nodes.find((q) => q.name === "right wheel");
  check("I. the painted wheel has a mesh of its own, with fewer faces", left.mesh !== right.mesh && sum(d.meshes[left.mesh].map((p) => p.faces)) === 32 - nn, J(d.nodes) + " painted " + nn);
  check("I. the other wheel is untouched: every face", sum(d.meshes[right.mesh].map((p) => p.faces)) === 32, J(d.meshes));
  await close();
}

// J. A mesh with no faces left leaves the file.
await open("empty");
{
  const nn = await page.evaluate(() => window.__h.paintWorld(-1.5, 0, 0, "red", 1));
  await page.evaluate(() => window.__h.ask("red", "remove it"));
  await apply();
  const d = await desc();
  const tiny = d.nodes.find((q) => q.name === "tiny"), other = d.nodes.find((q) => q.name === "other");
  check("J. painting every face of a part and removing it leaves the part out of the file", nn === 2 && tiny.mesh === undefined && d.emptyAccessors === 0, J(d.nodes) + " painted " + nn + " empty " + d.emptyAccessors);
  check("J. the other part is as it was, and the file loads without the removed one", sum(d.meshes[other.mesh].map((p) => p.faces)) === 8 && J((await page.evaluate(() => window.__loads(window.__model()))).meshes) === J(["other"]), J(d.meshes));
  check("J. the painter then shows what is left", (await state()).faces === 8, J(await state()));
  await close();
}

// K. Faces that share texels with the painted ones keep the original texture.
await open("mirror");
{
  const nn = await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.75));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  check("K. (the left quad's two faces are painted, the right quad's are not)", nn === 2, String(nn));
  await apply();
  const d = await desc();
  const prims = d.meshes[0];
  const orig = prims.find((p) => p.image === 0), copy = prims.find((p) => p.image !== 0 && p.image !== null);
  check("K. the unpainted quad still uses the original picture; the painted one has its own", !!orig && !!copy && orig.faces === 2 && copy.faces === 2, J(prims));
  const o = (await sample(orig.image, [[0.25, 0.5]]))[0], c = (await sample(copy.image, [[0.25, 0.5]]))[0];
  check("K. the shared texel is still red for the quad that was not painted", red(o), J(o));
  check("K. …and dark for the one that was", dark(c), J(c));
  check("K. the original picture is byte for byte the same", J(await page.evaluate(() => window.__imageBytes(window.__model(), 0))) === J(await page.evaluate(() => window.__imageBytes(window.__bytes.mirror, 0))));
  await close();
}

// K2. A .gltf with its data inside is opened, and the change is saved as a .glb; one with outside files says so.
await open("gltf");
{
  const st = await state();
  const n = await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  const bytes = await page.evaluate(() => String.fromCharCode(...window.__model().slice(0, 4)));
  const d = await desc();
  check("K. a .gltf with its data inside opens, and the change is saved as a .glb with the painted faces apart", st.loaded && st.faces === 128 && bytes === "glTF" && d.meshes[0].length === 2 && d.meshes[0].some((p) => p.faces === n) && sum(d.meshes[0].map((p) => p.faces)) === 128, J(st) + bytes + J(d.meshes));
  await close();
}
{
  const ext = await open("panel", { url: `${ORIGIN}/glb/external` });
  check("K. a .gltf that keeps its data in other files says so, and can be closed", !!ext.failed && /another address or in another file/.test(await page.textContent(".mp-hint")), await page.textContent(".mp-hint"));
  await page.keyboard.press("Escape");
  await sleep(100);
}

// K3. A solid black picture takes the colour it is asked for.
await open("black");
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it red"));
  await apply();
  const d = await desc();
  const copy = d.meshes[0].find((p) => p.image !== 0);
  const c = copy ? (await sample(copy.image, [[0.25, 0.5], [0.8, 0.5]])) : [];
  check("K. a solid black picture takes a new colour in the painted part, and stays black elsewhere", !!copy && c[0][0] > 180 && c[0][1] < 60 && c[0][2] < 60 && dark(c[1]), J(c));
  await close();
}

// L. Animations and a picture on UV set 1 with a transform.
await open("animated");
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  const a = await page.evaluate(() => ({ was: window.__desc(window.__bytes.animated).animations, now: window.__desc(window.__model()).animations }));
  check("L. an animation comes through, as it was", a.was.length === 1 && J(a.was) === J(a.now), J(a));
  check("L. …and the saved model still loads with it", (await page.evaluate(() => window.__loads(window.__model()))).animations === 1);
  await close();
}
await open("uv1");
{
  // The plane's left half (u 0…0.5) shows picture columns 0.5…0.75 (green): that is where the copy must be dark.
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  const d = await desc();
  const copy = d.meshes[0].find((p) => p.image !== 0);
  const c = await sample(copy.image, [[0.6, 0.5], [0.7, 0.5], [0.3, 0.5], [0.9, 0.5]]);
  check("L. a picture on UV set 1, with a transform, is changed where the paint is on it", dark(c[0]) && dark(c[1]), J(c));
  check("L. …and nowhere else (the other half of the picture, the part the plane does not use)", red(c[2]) && green(c[3]), J(c));
  await close();
}

// M. A finish: with a map, and on a flat-shaded part.
await open("mr");
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it shiny"));
  await apply();
  const d = await desc();
  const copy = d.meshes[0].find((p) => p.mrImage !== 0 && p.mrImage !== null), keep = d.meshes[0].find((p) => p.mrImage === 0);
  const g = copy ? (await sample(copy.mrImage, [[0.25, 0.5]]))[0][1] : -1;
  const gKeep = keep ? (await sample(keep.mrImage, [[0.25, 0.5]]))[0][1] : -1;
  check("M. a finish with a metallic-roughness map: the painted faces end up as shiny as asked (factor × map)", !!copy && Math.abs(copy.rough * (g / 255) - 0.15) < 0.02, J(copy) + " green " + g);
  check("M. …and the faces that were not painted keep their own finish map", !!keep && Math.abs(gKeep - 200) <= 3 && keep.rough === 1, J(keep) + " green " + gKeep);
  await close();
  await open("mr");
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it shiny metal"));
  await apply();
  const e = await desc();
  const own = e.meshes[0].find((p) => p.rough !== 1 || p.metal !== 1);
  check("M. shiny metal sets both finishes outright and leaves the map out of it", !!own && Math.abs(own.rough - 0.15) < 1e-6 && Math.abs(own.metal - 0.9) < 1e-6 && own.mrImage === null, J(e.meshes));
  await close();
}
await open("mr");
{
  // Colour and finish together, on a part with a picture and a finish map: one new material that has all of it.
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it black, shiny metal"));
  await apply();
  const d = await desc();
  const own = d.meshes[0].find((p) => p.metal === 0.9);
  const c = own ? (await sample(own.image, [[0.25, 0.5]]))[0] : null;
  check("M. black shiny metal on a textured part with a finish map: the picture goes dark, the finish is set outright, in one material", !!own && own.image !== 0 && own.mrImage === null && Math.abs(own.rough - 0.15) < 1e-6 && !!c && dark(c), J(d.meshes) + J(c));
  await close();
}
await open("unlit");
{
  await page.evaluate(() => window.__h.paintWorld(0, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it shiny"));
  await apply();
  check("M. a flat-shaded part cannot be made shiny: it says so and saves nothing", /flat-shaded/.test(await statusText()) && (await page.evaluate(() => window.__saveCalls)) === 0, await statusText());
  await page.evaluate(() => window.__h.ask("red", "make it red"));
  await apply();
  check("M. …but a colour still works on it", (await page.evaluate(() => window.__saveCalls)) > 0 && sum((await desc()).meshes[0].map((p) => p.faces)) === 128);
  await close();
}
await open("twoPanels");
{
  // A colour and a finish, said together, are one change on one part: black AND shiny metal.
  await page.evaluate(() => window.__h.setView(0, 0, 4, 0, 0, 0));
  const at = await page.evaluate(() => window.__h.screenOf(0, 0, 0));
  await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [at.x, at.y]);
  await page.evaluate(() => window.__h.ask("red", "make it black, shiny metal"));
  await apply();
  const d = await desc();
  const prims = d.meshes[d.nodes.find((n) => n.name === "front").mesh];
  const changed = prims.find((p) => p.metal === 0.9), kept = prims.find((p) => p.metal !== 0.9);
  check("M. a colour and a finish together are one change: the painted faces are black AND shiny metal", !!changed && Math.abs(changed.rough - 0.15) < 1e-6 && changed.base && changed.base[0] < 0.02 && changed.base[1] < 0.02 && changed.base[2] < 0.02, J(prims));
  check("M. …and the faces that were not painted keep their own colour and finish", !!kept && kept.base[0] > 0.1 && kept.metal === 0, J(prims));
  await close();
}
await open("vcolor");
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it red"));
  await apply();
  const d = await desc();
  const painted = d.meshes[0].find((p) => p.base && p.base[0] > 0.3);
  check("M. a colour on faces that carry vertex colours is the colour asked for (the vertex colours stay on the other faces)", !!painted && !painted.color && d.meshes[0].some((p) => p.color), J(d.meshes));
  await close();
}

// N. A failure leaves everything as it was; nothing is bought twice; one Apply at a time; discard discards.
await open("panel", { failSave: 1 });
{
  const n = await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  const st = await state();
  check("N. a save that fails says so, and leaves the model and the paint as they were", /could not be made/.test(await statusText()) && /still here/.test(await statusText()) && st.counts[1] === n && st.parts === 1 && st.faces === 2048 && st.dirty && !st.busy, (await statusText()) + J(st));
  check("N. …the button is ready again, and nothing was put on the board", !(await page.$eval(".mp-apply", (b) => b.disabled)) && (await page.evaluate(() => window.__placeCalls)) === 0);
  await apply();
  check("N. pressing it again works, once", (await page.evaluate(() => window.__placeCalls)) === 1 && (await page.evaluate(() => window.__saved.filter((s) => /\.glb$/.test(s.name)).length)) === 1);
  await close();
}
await open("panel", { failSave: 1, repaintColour: "#00ffff" });
{
  await page.evaluate(() => window.__h.paintWorld(0.5, -0.4, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "add rust stains"));
  await apply();
  const first = await page.evaluate(() => window.__repaints.length);
  await apply();
  check("N. the picture maker's work is not bought twice when a save has to be tried again", first === 1 && (await page.evaluate(() => window.__repaints.length)) === 1 && (await page.evaluate(() => window.__placeCalls)) === 1, `first ${first}`);
  await close();
}
await open("panel", { failPlace: 1 });
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  const st = await state();
  check("N. a board that cannot take the result is said, and the paint stays", /could not be put on the board/.test(await statusText()) && st.dirty && st.faces === 2048 && st.parts === 1, (await statusText()) + J(st));
  await apply();
  check("N. …then it is placed on the next try", (await page.evaluate(() => window.__placeCalls)) === 2 && !!(await page.evaluate(() => window.__placed)));
  await close();
}
await open("panel", { canPlace: "The board needs room for 3 more cards." });
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "add rust"));
  await apply();
  check("N. no room on the board is said before any work is done (nothing is asked of the picture maker, nothing saved)", /room for 3 more cards/.test(await statusText()) && (await page.evaluate(() => window.__repaints.length)) === 0 && (await page.evaluate(() => window.__saveCalls)) === 0, await statusText());
  await close();
}
await open("panel", { saveDelay: 700 });
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await page.evaluate(() => { window.__first = window.__h.apply(); });
  await sleep(150);
  const second = await page.evaluate(async () => (await window.__h.apply()) === null);
  check("N. one Apply at a time: a second press while the first is working does nothing", second && (await page.$eval(".mp-apply", (b) => b.disabled)) && await page.$eval(".mp-area textarea", (t) => t.disabled));
  await page.evaluate(async () => { await window.__first; });
  check("N. …the first one finishes, once", (await page.evaluate(() => window.__placeCalls)) === 1 && (await page.evaluate(() => window.__saved.filter((s) => /\.glb$/.test(s.name)).length)) === 1);
  await close();
}
await open("panel", { saveDelay: 900 });
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await page.evaluate(() => { window.__first = window.__h.apply(); });
  await sleep(200);
  dialogs.length = 0;
  await page.keyboard.press("Escape");
  await sleep(150);
  check("N. closing while it works asks, and a yes really stops it", dialogs.length === 1 && /Stop making the changes/.test(dialogs[0]) && (await gone()), J(dialogs));
  await sleep(2500);
  check("N. …nothing is put on the board, and no picture is saved, after it was dismissed", (await page.evaluate(() => window.__placeCalls)) === 0 && (await page.evaluate(() => window.__saveCalls)) === 1, `place ${await page.evaluate(() => window.__placeCalls)} saves ${await page.evaluate(() => window.__saveCalls)}`);
}

// O. Lockdown: the picture maker is refused, local changes are not.
await open("panel", { privacy: "lockdown" });
{
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "add rust and scratches"));
  await apply();
  check("O. in Lockdown a repaint is refused in plain words, before anything is sent or saved", /Lockdown/.test(await statusText()) && (await page.evaluate(() => window.__repaints.length)) === 0 && (await page.evaluate(() => window.__saveCalls)) === 0, await statusText());
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  check("O. …and a colour still works in Lockdown", !!(await page.evaluate(() => window.__placed)) && (await page.evaluate(() => window.__repaints.length)) === 0);
  await close();
}
{
  // The account's saved mode, as the page asks the server for it (no override): the same answer.
  await page.evaluate(() => fetch("/set-privacy/lockdown"));
  await open("panel");
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "add rust"));
  await apply();
  check("O. …also when the account's saved mode is what says it", /Lockdown/.test(await statusText()) && (await page.evaluate(() => window.__repaints.length)) === 0 && (await page.evaluate(() => window.__saveCalls)) === 0, await statusText());
  await close();
  await page.evaluate(() => fetch("/set-privacy/open"));
}

// P. A second finger never paints; Esc while dragging an edge; the minimum size; what closing frees.
{
  const touch = await browser.newContext({ viewport: { width: 1280, height: 860 }, hasTouch: true });
  const tp = await touch.newPage();
  await tp.goto(`${ORIGIN}/test.html`);
  await tp.evaluate(async () => {
    const THREE = await import("/buzzy/vendor/three/three.module.min.js");
    const { GLTFExporter } = await import("/buzzy/vendor/three/addons/exporters/GLTFExporter.js");
    const s = new THREE.Scene();
    s.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 16, 16), new THREE.MeshStandardMaterial({ color: 0x8899aa })));
    const bytes = await new Promise((res, rej) => new GLTFExporter().parse(s, res, rej, { binary: true }));
    window.__glb = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
    const mod = await import("/buzzy/model-paint.js");
    window.__h = await mod.open({ url: window.__glb, title: "touch" });
    window.__h.setView(0, 0, 4, 0, 0, 0);
    window.__h.paintAt(-9999, -9999, "red");       // chooses the red brush; nothing is under it
  });
  const cdp = await touch.newCDPSession(tp);
  const at = await tp.evaluate(() => window.__h.screenOf(0, 0, 0));
  const t = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  await t("touchStart", [{ x: at.x - 40, y: at.y, id: 1 }, { x: at.x + 40, y: at.y, id: 2 }]);
  await t("touchMove", [{ x: at.x - 60, y: at.y + 10, id: 1 }, { x: at.x + 60, y: at.y - 10, id: 2 }]);
  await sleep(250);
  await t("touchMove", [{ x: at.x - 70, y: at.y + 20, id: 1 }, { x: at.x + 70, y: at.y - 20, id: 2 }]);
  await t("touchEnd", []);
  await sleep(100);
  check("P. two fingers (a pinch or a turn) paint nothing", (await tp.evaluate(() => window.__h.state())).counts[1] === 0, J(await tp.evaluate(() => window.__h.state())));
  await t("touchStart", [{ x: at.x, y: at.y, id: 5 }]);
  await sleep(250);
  await t("touchMove", [{ x: at.x + 20, y: at.y + 6, id: 5 }]);
  await t("touchMove", [{ x: at.x + 40, y: at.y + 12, id: 5 }]);
  await t("touchEnd", []);
  await sleep(100);
  check("P. one finger paints", (await tp.evaluate(() => window.__h.state())).counts[1] > 0, J(await tp.evaluate(() => window.__h.state())));
  // A second finger that lands after the first has already left paint takes that paint back: it was a pinch, not a stroke.
  await tp.click(".mp-tools button:nth-of-type(5)");          // Clear paint
  await t("touchStart", [{ x: at.x, y: at.y, id: 7 }]);
  await sleep(300);
  const dot = (await tp.evaluate(() => window.__h.state())).counts[1];
  await t("touchStart", [{ x: at.x, y: at.y, id: 7 }, { x: at.x + 90, y: at.y, id: 8 }]);
  await sleep(150);
  const after = await tp.evaluate(() => window.__h.state());
  await t("touchEnd", []);
  check("P. a second finger that lands late takes back what the first had painted (a pinch is not a stroke)", dot > 0 && after.counts[1] === 0 && !after.dirty, J({ dot, after }));
  await tp.evaluate(() => window.__h.close(true));
  await touch.close();
}
await open("panel");
{
  const box0 = await page.$eval(".mp-box", (b) => ({ w: b.offsetWidth, h: b.offsetHeight }));
  const corner = await page.$(".mp-box .bz-rs-se");
  check("P. the window can be made bigger or smaller by its corner", !!corner);
  const r = await corner.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 - 120, r.y + r.height / 2 - 90, { steps: 4 });
  const mid = await page.$eval(".mp-box", (b) => ({ w: b.offsetWidth, h: b.offsetHeight }));
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await sleep(100);
  const after = await page.$eval(".mp-box", (b) => ({ w: b.offsetWidth, h: b.offsetHeight }));
  check("P. Esc while dragging an edge takes the drag back and closes nothing", mid.w < box0.w && after.w === box0.w && after.h === box0.h && (await page.$(".mp-dialog")) !== null, J({ box0, mid, after }));
  const r2 = await (await page.$(".mp-box .bz-rs-se")).boundingBox();
  await page.mouse.move(r2.x + r2.width / 2, r2.y + r2.height / 2);
  await page.mouse.down();
  await page.mouse.move(40, 40, { steps: 6 });
  await page.mouse.up();
  const small = await page.$eval(".mp-box", (b) => ({ w: b.offsetWidth, h: b.offsetHeight }));
  check("P. it never gets so small that the canvas, the tools and the button cannot be used", small.w >= 480 && small.h >= 480, J(small));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "p-min-size.png") });
  const parts = await page.evaluate(() => { const c = document.querySelector(".mp-stage canvas").getBoundingClientRect(); const a = document.querySelector(".mp-apply").getBoundingClientRect(); const bx = document.querySelector(".mp-box").getBoundingClientRect(); return { canvas: [c.width, c.height], applyInside: a.bottom <= bx.bottom + 1 && a.right <= bx.right + 1 }; });
  check("P. …at that size the canvas still has room and the button is whole", parts.canvas[1] >= 100 && parts.canvas[0] >= 150 && parts.applyInside, J(parts));
  await page.keyboard.press("Escape");
  await sleep(100);
  check("P. Esc, with no drag, closes it", (await gone()));
}
{
  await open("panel");
  await page.evaluate(() => { window.__boxRef = document.querySelector(".mp-box"); window.__cvRef = document.querySelector(".mp-stage canvas"); });
  const had = await page.evaluate(() => !!window.__boxRef._bzrs);
  await close();
  const gone = await page.evaluate(() => ({ untracked: !window.__boxRef._bzrs, lost: window.__cvRef.getContext("webgl2") ? window.__cvRef.getContext("webgl2").isContextLost() : true, empty: window.__boxRef.childNodes.length === 0 }));
  check("P. closing lets go of what the window held: the resizer forgets it, the graphics context is released, the page is cleared", had && gone.untracked && gone.lost && gone.empty, J({ had, gone }));
}

// ── The second review ──────────────────────────────────────────────────────────────────────
const asked = () => page.evaluate(() => window.__allowanceAsked.slice());
// Q1. Nothing is fetched from outside the file.
await section("Q1.", async () => {
  const hits = async () => Number(await page.evaluate(async () => (await (await fetch("/spyhits")).text())));
  await page.evaluate(() => fetch("/spyreset", { method: "POST" }));
  // The control: a loader handed these very bytes does go and ask the address for the picture.
  await page.evaluate(async () => { try { await new Promise((res, rej) => new window.__GLTFLoader().parse(window.__bytes.spyimage.slice().buffer, "", res, rej)); } catch { /* it asked; that is all this wants */ } });
  await sleep(500);
  const control = await hits();
  check("Q. (control: a loader given a file that points a picture outside does go and ask for it)", control >= 1, String(control));
  await page.evaluate(() => fetch("/spyreset", { method: "POST" }));
  for (const [key, what] of [["spyimage", "a picture"], ["spybuffer", "a second buffer"]]) {
    const st = await open(key);
    await sleep(600);
    const n = await hits();
    check(`Q. a model that keeps ${what} at another address is refused before anything opens it: it says why, and the address is never asked`, !!st.failed && /another address or in another file/.test(await page.textContent(".mp-hint")) && n === 0, `${J(st)} hits ${n} ${await page.textContent(".mp-hint")}`);
    check(`Q. …(and it is closable)`, await (async () => { await page.keyboard.press("Escape"); await sleep(100); return (await gone()); })());
  }
  await open("datauri");
  const st = await state();
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  const d = await desc();
  check("Q. a picture inside the file as a data: address is the file's own: it opens, paints, and comes out inside the binary part with no address left", st.loaded && !st.failed && d.meshes[0].length === 2 && d.uris === 0 && (await hits()) === 0, J(st) + J(d.meshes));
  await close();
});
// Q2. Alpha cutouts: the brush sees what the drawing shows.
await section("Q2.", async () => {
  const d0 = await page.evaluate(() => window.__desc(window.__bytes.cutout));
  check("Q. (the grille is a cut-out: alphaMode MASK)", d0.meshes.flat().some((p) => p.alpha === "MASK"));
  await open("cutout");
  await page.evaluate(() => window.__h.setView(0, 0, 4, 0, 0, 0));
  const hole = await page.evaluate(() => window.__h.screenOf(0.5, 0, 0));
  const n = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [hole.x, hole.y]);
  const per = await page.evaluate(() => window.__h.parts());
  check("Q. brushing where the grille is cut away paints the wall that shows through, not the grille in front", n > 0 && per.find((p) => p.name === "wall").painted > 0 && per.find((p) => p.name === "grille").painted === 0, J(per));
  await page.evaluate(() => window.__h.ask("red", "remove it"));
  await apply();
  const d = await desc();
  const faces = (name) => { const n2 = d.nodes.find((q) => q.name === name); return n2 && n2.mesh !== undefined ? sum(d.meshes[n2.mesh].map((p) => p.faces)) : 0; };
  check("Q. “remove it” there takes faces off the wall and none off the grille", faces("grille") === 128 && faces("wall") > 0 && faces("wall") < 128, `grille ${faces("grille")} wall ${faces("wall")}`);
  await close();
  await open("cutout");
  await page.evaluate(() => window.__h.setView(0, 0, 4, 0, 0, 0));
  const solid = await page.evaluate(() => window.__h.screenOf(-0.5, 0, 0));
  await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [solid.x, solid.y]);
  const per2 = await page.evaluate(() => window.__h.parts());
  check("Q. …and brushing the solid half paints the grille", per2.find((p) => p.name === "grille").painted > 0 && per2.find((p) => p.name === "wall").painted === 0, J(per2));
  await close();
});
// Q3. Faces as they are drawn: a morph weight moves the vertices.
await section("Q3.", async () => {
  await open("morph");
  await page.evaluate(() => window.__h.setView(0, 0.25, 4, 0, 0.25, 0));
  const top = await page.evaluate(() => window.__h.screenOf(0, 1.3, 0));
  const low = await page.evaluate(() => window.__h.screenOf(0, -0.8, 0));
  const nLow = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [low.x, low.y]);
  const nTop = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [top.x, top.y]);
  check("Q. a mesh with a morph weight is picked where it is DRAWN: the top, half a unit above its raw positions, paints; the bottom, which it no longer covers, does not", nTop > 0 && nLow === 0, `top ${nTop} low ${nLow}`);
  const w = await page.evaluate(() => window.__h.paintWorld(0, 1.4, 0, "blue", 0.2));
  check("Q. …and the faces the world test finds are the drawn ones too", w > 0);
  await close();
});
// Q4. Two scenes: the default scene's parts are still matched to the file.
await section("Q4.", async () => {
  await open("twoScenes");
  const st = await state();
  const n = await page.evaluate(() => window.__h.paintWorld(-1, 0, 0, "red", 0.45));
  await page.evaluate(() => window.__h.ask("red", "remove it"));
  const res = await apply();
  const d = await desc();
  check("Q. a file with two scenes: the default scene's wheel is matched to the file, and the change is made (the other scene's wheel, one mesh, is untouched)", st.parts === 1 && n > 0 && !!res && d.nodes[0].mesh !== d.nodes[1].mesh && sum(d.meshes[d.nodes[0].mesh].map((p) => p.faces)) === 32 - n && sum(d.meshes[d.nodes[1].mesh].map((p) => p.faces)) === 32, `${J(st)} ${J(d.nodes)} ${J(d.meshes)} ${await statusText()}`);
  await close();
});
// Q5. Solid means solid: light is not let through either. Vertex opacity is kept when a colour is asked for.
await section("Q5.", async () => {
  await open("transmission");
  const d0 = await page.evaluate(() => window.__desc(window.__bytes.transmission));
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it opaque"));
  await apply();
  const d = await desc();
  check("Q. (the windshield transmits light and is alphaMode OPAQUE)", d0.meshes[0][0].transmission === true && d0.meshes[0][0].alpha === "OPAQUE");
  check("Q. “make it opaque” turns the painted part's transmission off, and the part that was not painted keeps its own", d.meshes[0].length === 2 && d.meshes[0][0].transmission === true && d.meshes[0][1].transmission === false && d.meshes[0][1].alpha === "OPAQUE", J(d.meshes));
  await close();
  await open("valpha");
  const before = await page.evaluate(() => window.__colours(window.__bytes.valpha, "valpha")[0]);
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it red"));
  await apply();
  const cols = await page.evaluate(() => window.__colours(window.__model(), "valpha"));
  check("Q. a colour on faces whose vertices carry opacity: the colour is what was asked (vertex RGB neutral) and each vertex keeps its opacity", cols.length === 2 && !!cols[1] && cols[1].type === "VEC4" && cols[1].rgbMin === 1 && cols[1].rgbMax === 1 && J(cols[1].alpha) === J(before.alpha), J(cols[1] && { t: cols[1].type, min: cols[1].rgbMin, max: cols[1].rgbMax }));
  check("Q. …and the faces that were not painted keep their vertex colours as they were", !!cols[0] && cols[0].rgb0[1] === 1 && cols[0].rgb0[0] === 0 && J(cols[0].alpha) === J(before.alpha));
  await close();
});
// Q6. Clamped pictures, and a finish map that is a JPEG.
await section("Q6.", async () => {
  await open("clamp");
  const n = await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  const res = await apply();
  const d = await desc();
  const copy = d.meshes[0].find((p) => p.image !== 0);
  const c = copy ? await sample(copy.image, [[0.999, 0.5], [0.2, 0.5]]) : [];
  check("Q. a face past the edge of a clamped picture shows its edge texels, and those are what is changed (it used to fail: “do not cover any of the texture”)", n > 0 && !!res && !!copy && dark(c[0]) && red(c[1]), `${n} ${J(c)} ${await statusText()}`);
  await close();
  await open("mrjpeg");
  const o = await page.evaluate(() => window.__desc(window.__bytes.mrjpeg));
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.4));
  await page.evaluate(() => window.__h.ask("red", "make it shiny"));
  await apply();
  const e = await desc();
  const made = e.meshes[0].find((p) => p.mrImage !== null && p.mrImage !== o.meshes[0][0].mrImage);
  const uvs = [0.1, 0.2, 0.3, 0.4, 0.45].map((u) => [u, 0.5]);
  const [blueOrig, blueCopy] = made ? await page.evaluate(async ([ia, ib, pts]) => [(await window.__sample(window.__bytes.mrjpeg, ia, pts)).map((c) => c[2]), (await window.__sample(window.__model(), ib, pts)).map((c) => c[2])], [o.meshes[0][0].mrImage, made.mrImage, uvs]) : [[], []];
  check("Q. (the finish map is a JPEG)", o.meshes[0][0].mrMime === "image/jpeg");
  check("Q. a finish map edited for roughness is saved lossless (PNG), and the channel nobody asked about (metalness, blue) is exactly what it was", !!made && made.mrMime === "image/png" && J(blueOrig) === J(blueCopy), `${made && made.mrMime} ${J(blueOrig)} ${J(blueCopy)}`);
  await close();
});
// Q7. Words: which way, and how much.
await section("Q7.", async () => {
  await open("panel");
  await page.evaluate(() => window.__h.paintWorld(-0.5, 0, 0, "red", 0.3));
  await page.evaluate(() => window.__h.ask("red", "make it less shiny"));
  const off = await page.$eval(".mp-apply", (b) => b.disabled);
  check("Q. “make it less shiny” is not read as “shiny”: Apply is off, and the box says what to say instead", off && /matte/.test(await page.textContent(".mp-note")) && /less shiny/.test(await statusText()), (await page.textContent(".mp-note")) + " | " + (await statusText()));
  check("Q. …nothing was asked of the picture maker, and nothing saved", (await page.evaluate(() => window.__repaints.length)) === 0 && (await asked()).length === 0 && (await page.evaluate(() => window.__saveCalls)) === 0);
  await page.evaluate(() => window.__h.ask("red", "make it half transparent"));
  check("Q. “make it half transparent” is said to be a change to the part itself, not a paid repaint", /50% see-through/.test(await page.textContent(".mp-note")) && !/picture generation/.test(await page.textContent(".mp-apply")), (await page.textContent(".mp-note")) + " | " + (await page.textContent(".mp-apply")));
  await apply();
  const d = await desc();
  const made = d.meshes[0].find((p) => p.alpha === "BLEND");
  check("Q. …it keeps the part's own look (the same picture) at half opacity, and the picture maker is never asked", !!made && made.image === 0 && made.base && made.base[3] === 0.5 && d.images === 1 && (await page.evaluate(() => window.__repaints.length)) === 0 && (await asked()).length === 0, J(d.meshes));
  await close();
});
// Q8. The picture maker's allowance is checked for ALL its calls before the first is paid for; and the Library's limit too.
await section("Q8.", async () => {
  await open("panel", { allowanceLeft: 1 });
  await page.evaluate(() => { window.__h.paintWorld(-0.5, 0.5, 0, "red", 0.25); window.__h.paintWorld(0.5, 0.5, 0, "blue", 0.25); window.__h.ask("red", "add rust stains"); window.__h.ask("blue", "add scratches"); });
  const st0 = await state();
  await apply();
  const st1 = await state();
  check("Q. a change that needs the picture maker twice, with one generation left, is refused before the first is paid for (and says so)", J(await asked()) === "[2]" && (await page.evaluate(() => window.__repaints.length)) === 0 && /needs the picture maker 2 times/.test(await statusText()) && (await page.evaluate(() => window.__saveCalls)) === 0 && st1.counts[1] === st0.counts[1] && st1.counts[2] === st0.counts[2] && !st1.busy, `${J(await asked())} ${await statusText()}`);
  await close();
  await open("panel", { allowanceLeft: 2 });
  await page.evaluate(() => { window.__h.paintWorld(-0.5, 0.5, 0, "red", 0.25); window.__h.paintWorld(0.5, 0.5, 0, "blue", 0.25); window.__h.ask("red", "add rust stains"); window.__h.ask("blue", "add scratches"); });
  await apply();
  check("Q. …with two left both are made", J(await asked()) === "[2]" && (await page.evaluate(() => window.__repaints.length)) === 2 && !!(await page.evaluate(() => window.__placed)));
  await close();
  await open("panel", { allowanceLeft: 5, failSave: 1 });
  await page.evaluate(() => { window.__h.paintWorld(0.5, -0.4, 0, "red", 0.3); window.__h.ask("red", "add rust stains"); });
  await apply();
  await apply();
  check("Q. a repaint already bought (a save had to be tried again) is not counted against the allowance again", J(await asked()) === "[1]" && (await page.evaluate(() => window.__repaints.length)) === 1 && !!(await page.evaluate(() => window.__placed)), J(await asked()));
  await close();
  // The Library keeps files up to 25 MB; a changed copy is the original plus a patch.
  await open("bigbin");
  await page.evaluate(() => { window.__h.paintWorld(-0.5, 0, 0, "red", 0.3); window.__h.ask("red", "add rust stains"); });
  await apply();
  check("Q. a repaint whose result could never be saved is refused before the picture maker is asked (or the allowance)", (await page.evaluate(() => window.__repaints.length)) === 0 && (await asked()).length === 0 && /could not be saved/.test(await statusText()) && /25 MB/.test(await statusText()), await statusText());
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  check("Q. …and a local change that comes out too big is refused before it is uploaded", (await page.evaluate(() => window.__saveCalls)) === 0 && /could not be saved/.test(await statusText()), await statusText());
  await close();
  const big = await open("toobig");
  check("Q. a model over the Library's limit says so when it opens, can be looked at, and can be closed", !!big.failed && big.loaded && /Library keeps files up to 25 MB/.test(await page.textContent(".mp-hint")), `${J(big)} ${await page.textContent(".mp-hint")}`);
  await page.keyboard.press("Escape");
  await sleep(100);
  check("Q. …(Esc closes it)", (await gone()));
});
// Q9. A size remembered from a taller window opens inside this one, and follows the window.
await section("Q9.", async () => {
  await page.evaluate(() => localStorage.setItem("bz.size.model-paint", JSON.stringify({ w: 1200, h: 1000 })));
  await page.setViewportSize({ width: 1280, height: 600 });
  await open("panel");
  const fit = () => page.evaluate(() => { const b = document.querySelector(".mp-box").getBoundingClientRect(); const a = document.querySelector(".mp-apply").getBoundingClientRect(); const x = document.querySelector(".mp-x").getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), applyBottom: Math.round(a.bottom), closeTop: Math.round(x.top), min: document.querySelector(".mp-box").getAttribute("data-bz-resize-min"), w: innerWidth, h: innerHeight }; });
  const f1 = await fit();
  check("Q. a size remembered from a taller window opens inside this one: the window, its Close and its Apply are all on the screen", f1.top >= 0 && f1.bottom <= f1.h && f1.applyBottom <= f1.h && f1.closeTop >= 0, J(f1));
  await page.setViewportSize({ width: 700, height: 500 });
  await sleep(500);
  const f2 = await fit();
  check("Q. …and when the window gets smaller while it is open it comes in again, and its smallest size follows", f2.bottom <= f2.h && f2.right <= f2.w && f2.top >= 0 && f2.left >= 0 && f2.min === "480 468", J(f2));
  await close();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(() => localStorage.removeItem("bz.size.model-paint"));
});
// Q10. Each painted area's picture shows the paint, from the view it was painted from.
await section("Q10.", async () => {
  await open("hidden");
  await page.evaluate(() => window.__h.setView(0, 0, 5, 0, 0, 0));
  const at = await page.evaluate(() => window.__h.screenOf(1, 0, 0));
  const n = await page.evaluate(([x, y]) => window.__h.paintAt(x, y, "red"), [at.x, at.y]);
  await page.evaluate(() => window.__h.ask("red", "make it black"));
  await apply();
  const pic = await page.evaluate(async () => {
    const f = window.__saved.find((x) => /painted-red.*\.png$/.test(x.name));
    const bmp = await createImageBitmap(new Blob([f.bytes], { type: "image/png" }));
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    const k = c.getContext("2d"); k.drawImage(bmp, 0, 0);
    const d = k.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140) red++;
    return { red, w: c.width, h: c.height };
  });
  check("Q. the picture saved for a painted area shows its paint, even where the view from outside the model would not (it is the view it was painted from)", n > 0 && pic.red > 40, J(pic));
  await close();
});

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await context.close();
if (!process.env.CDP_URL) await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
