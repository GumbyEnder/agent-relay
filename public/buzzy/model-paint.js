/*
 * Paint on a 3D model what you want changed — and only that changes.
 *
 * Testers, 2026-11-24 (the call the owner pasted): "I would tell it to like fix a
 * windshield, like the alpha on a windshield … and then it completely messed up all the
 * treads on the tires." Owner: "Let's imagine an interface where you have the three D
 * model and you're able to paint on that three D model what you would like changed …
 * red paint … and then we'll have like a blue brush and do a different area and like ask
 * a specific change … link out a card that's blue or red … in the whiteboard we have this
 * three D thing where you can spin the model around … and then when you're done painting
 * it creates a note … and we really gotta constrain it."
 *
 * What this does (an ES module, loaded the first time "Paint changes" is pressed on a 3D
 * model card of the Idea Board):
 *   - Opens the model (.glb) in a window you can turn, zoom and move (three.js r170,
 *     vendored in /buzzy/vendor/three). Closes only with Esc or ✕ (BeeZilla's rule), and
 *     can be resized by any side or corner (resize.js reads data-bz-resize).
 *   - A red brush and a blue brush paint the model's surface: each painted triangle
 *     belongs to that colour's area. An eraser takes paint off. The paint is drawn over
 *     the model so you can see exactly what you marked, from every side.
 *   - Each colour gets "How should the red area change?", with quick picks.
 *   - "Make the changes" changes ONLY the painted triangles and their part of the
 *     texture; every other triangle, pixel and material in the file stays as it was:
 *       see-through / glass   → the painted faces become their own glass part
 *       a colour ("black")    → the painted part of the texture is recoloured, shading kept
 *       shiny / metal / matte → the painted faces get their own material
 *       remove                → the painted faces are taken out
 *       anything else         → BeeZilla's picture maker repaints the painted part of the
 *                               texture, and only the painted pixels are put back
 *   - The result is saved as a new .glb in the Library and put on the board next to the
 *     original (which is kept), joined by a line, with a note for each colour saying what
 *     was asked, and a picture of the areas you painted (so a colour is never asked about
 *     without showing it).
 */
import * as THREE from "./vendor/three/three.module.min.js";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "./vendor/three/addons/controls/OrbitControls.js";
import { GLTFExporter } from "./vendor/three/addons/exporters/GLTFExporter.js";

export const REGIONS = [
  { id: 1, key: "red", name: "Red", css: "#ff4d4d", rgb: [255, 60, 60] },
  { id: 2, key: "blue", name: "Blue", css: "#4d8dff", rgb: [60, 140, 255] },
];

// ── What an instruction asks for (pure, tested in scripts/test-model-paint.mjs) ──
const COLOURS = {
  black: "#111111", white: "#f4f4f4", grey: "#808080", gray: "#808080", silver: "#c0c4c8", gold: "#d4a017",
  red: "#c62828", orange: "#ef6c00", yellow: "#f9d71c", green: "#2e7d32", olive: "#6b6b2a", blue: "#1e5bd8",
  navy: "#1a2a5a", purple: "#6a1b9a", pink: "#e86fa0", brown: "#6d4c2f", tan: "#c8a878", beige: "#d9c8a0",
  bronze: "#8c6a3a", copper: "#b87333", teal: "#00897b", cyan: "#00bcd4", maroon: "#6d1b1b", khaki: "#b5a76a",
};
const SHADE = { dark: 0.55, darker: 0.55, deep: 0.6, light: 1.35, lighter: 1.35, pale: 1.5, bright: 1.25 };

/** One instruction, read into the change it asks for. Never guesses beyond the words. */
export function readInstruction(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return { kind: "none" };
  if (/\b(?:remove|delete|get rid of|take (?:it |them )?(?:off|away|out)|cut (?:it |them )?off|hide)\b/.test(t)) return { kind: "remove" };
  const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/.exec(t);
  let colour = null;
  if (hex) colour = "#" + (hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1]);
  else {
    for (const name of Object.keys(COLOURS)) {
      if (new RegExp("\\b" + name + "\\b").test(t)) { colour = COLOURS[name]; break; }
    }
    if (colour) {
      for (const [w, f] of Object.entries(SHADE)) if (new RegExp("\\b" + w + "\\b").test(t)) { colour = scaleHex(colour, f); break; }
    }
  }
  if (/\b(?:see[\s-]?through|transparent|translucent|glass|clear|tinted|window|windshield|windscreen|visor|lens)\b/.test(t)) {
    return { kind: "glass", colour: colour || "#203040", opacity: /\b(?:clear|transparent|see[\s-]?through)\b/.test(t) && !/\btint/.test(t) ? 0.25 : 0.45 };
  }
  const shiny = /\b(?:shiny|glossy|polished|chrome|mirror|metal(?:lic)?|steel)\b/.test(t);
  const matte = /\b(?:matte|matt|dull|rough|flat)\b/.test(t);
  // A colour and nothing else that needs a painter: recolour the painted part.
  const extra = t.replace(/#[0-9a-f]{3,6}\b/g, " ")
    .replace(new RegExp("\\b(?:" + Object.keys(COLOURS).concat(Object.keys(SHADE)).join("|") + "|make|it|them|this|that|the|a|an|area|part|bit|colou?r(?:ed)?|paint(?:ed)?|turn|change|to|into|should|be|please|and|in|all|shiny|glossy|polished|chrome|mirror|metal(?:lic)?|steel|matte|matt|dull|rough|flat)\\b", "g"), " ")
    .replace(/[^a-z]+/g, " ").trim();
  if (!extra && (colour || shiny || matte)) {
    return { kind: "look", colour, metalness: shiny && /\b(?:chrome|mirror|metal(?:lic)?|steel)\b/.test(t) ? 0.9 : null, roughness: shiny ? 0.15 : matte ? 0.95 : null };
  }
  return { kind: "repaint", words: String(text).trim().slice(0, 600) };
}
function scaleHex(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return "#" + [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Recolour pixels in place where the mask is set, keeping their light and shade. */
export function recolourPixels(data, mask, hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const tr = (n >> 16) & 255, tg = (n >> 8) & 255, tb = n & 255;
  // The area's own average brightness, so the result has the target colour on average
  // and keeps every scratch, seam and shadow of the original.
  let sum = 0, count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { const p = i * 4; sum += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]; count++; }
  if (!count) return 0;
  const avg = Math.max(8, sum / count);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    const l = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / avg;
    const a = mask[i] / 255;
    data[p] = Math.round(data[p] * (1 - a) + Math.min(255, tr * l) * a);
    data[p + 1] = Math.round(data[p + 1] * (1 - a) + Math.min(255, tg * l) * a);
    data[p + 2] = Math.round(data[p + 2] * (1 - a) + Math.min(255, tb * l) * a);
  }
  return count;
}

// ── The window ────────────────────────────────────────────────────────────
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = `
.mp-dialog{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6)}
.mp-box{position:relative;display:flex;flex-direction:column;width:min(1100px,100%);height:min(780px,100%);background:#141414;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden}
.mp-head{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem;border-bottom:1px solid #2a2a2a}
.mp-head h2{flex:1;margin:0;font-size:1rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-x{background:none;border:1px solid #444;color:#ddd;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:15px}
.mp-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;padding:.5rem .9rem;border-bottom:1px solid #2a2a2a}
.mp-tools button{background:#1e1e1e;color:#eee;border:1px solid #3a3a3a;border-radius:9px;padding:.35rem .7rem;cursor:pointer;font-size:.86rem}
.mp-tools button.on{border-color:#ffd40d;background:#2a2610}
.mp-tools .dot{display:inline-block;width:.8em;height:.8em;border-radius:50%;margin-right:.35em;vertical-align:-1px}
.mp-tools label{font-size:.8rem;color:#aaa;display:inline-flex;align-items:center;gap:.35rem}
.mp-main{flex:1;min-height:0;display:flex}
.mp-stage{position:relative;flex:1;min-width:0;background:#1b1b1b}
.mp-stage canvas{display:block;width:100%;height:100%;touch-action:none}
.mp-hint{position:absolute;left:10px;bottom:10px;right:10px;font-size:.8rem;color:#bbb;pointer-events:none;text-shadow:0 1px 2px #000}
.mp-side{width:300px;max-width:42%;overflow:auto;border-left:1px solid #2a2a2a;padding:.7rem .8rem;display:flex;flex-direction:column;gap:.8rem}
.mp-area{border:1px solid #333;border-radius:10px;padding:.6rem}
.mp-area h3{margin:0 0 .4rem;font-size:.9rem;display:flex;align-items:center;gap:.4rem}
.mp-area .count{color:#999;font-weight:400;font-size:.78rem}
.mp-area textarea{width:100%;box-sizing:border-box;min-height:64px;background:#101010;color:#eee;border:1px solid #3a3a3a;border-radius:8px;padding:.4rem;font:inherit;font-size:.85rem;resize:vertical}
.mp-picks{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.35rem}
.mp-picks button{background:#1e1e1e;color:#ccc;border:1px solid #3a3a3a;border-radius:999px;padding:.15rem .55rem;font-size:.75rem;cursor:pointer}
.mp-empty{color:#999;font-size:.84rem}
.mp-foot{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem;border-top:1px solid #2a2a2a}
.mp-status{flex:1;font-size:.84rem;color:#bbb}
.mp-apply{background:#ffd40d;color:#111;border:1px solid #ffd40d;border-radius:9px;padding:.45rem .9rem;font-weight:650;cursor:pointer}
.mp-apply[disabled]{opacity:.5;cursor:default}
@media (max-width:760px){.mp-main{flex-direction:column}.mp-side{width:auto;max-width:none;border-left:none;border-top:1px solid #2a2a2a;max-height:40%}}`;
  document.head.appendChild(s);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * Open the painter for one model card.
 *   opts.url      the .glb (/api/buzzy/assets/<id>)
 *   opts.title    the card's title
 *   opts.save     async (bytes, name) → { url, id }        (defaults to POST /api/buzzy/assets)
 *   opts.place    (result) → void: put the new model, notes and picture on the board
 *   opts.repaint  async ({crop, mask, instruction}) → dataUrl   (defaults to /api/buzzy/art repaint3d)
 * Resolves with the painter's handle (for tests): { close, paintAt, apply, state }.
 */
export async function open(opts) {
  style();
  const dlg = el("div", "mp-dialog");
  dlg.setAttribute("role", "dialog");
  dlg.setAttribute("aria-modal", "true");
  dlg.setAttribute("aria-labelledby", "mpTitle");
  const box = el("div", "mp-box");
  box.setAttribute("data-bz-resize", "all");
  box.setAttribute("data-bz-resize-anchor", "center");
  box.setAttribute("data-bz-resize-key", "model-paint");
  const head = el("div", "mp-head");
  const h = el("h2", "", "Paint what to change — " + String(opts.title || "3D model").slice(0, 80));
  h.id = "mpTitle";
  const x = el("button", "mp-x", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  head.append(h, x);
  const tools = el("div", "mp-tools");
  const btnTurn = el("button", "on", "Turn");
  btnTurn.title = "Drag to turn the model, scroll to zoom, right-drag to move (T)";
  const brushBtns = REGIONS.map((r) => {
    const b = el("button");
    const dot = el("span", "dot");
    dot.style.background = r.css;
    b.append(dot, document.createTextNode(r.name + " brush"));
    b.title = `Paint the ${r.name.toLowerCase()} area (${r.key[0].toUpperCase()}). Right-drag turns the model while painting.`;
    return b;
  });
  const btnErase = el("button", "", "Eraser");
  btnErase.title = "Take paint off (E)";
  const sizeLab = el("label", "", "Brush");
  const size = el("input");
  size.type = "range"; size.min = "4"; size.max = "120"; size.value = "28";
  size.setAttribute("aria-label", "Brush size");
  sizeLab.appendChild(size);
  const btnClear = el("button", "", "Clear paint");
  tools.append(btnTurn, ...brushBtns, btnErase, sizeLab, btnClear);
  const main = el("div", "mp-main");
  const stage = el("div", "mp-stage");
  const canvas = el("canvas");
  const hint = el("div", "mp-hint", "Loading the model…");
  stage.append(canvas, hint);
  const side = el("div", "mp-side");
  main.append(stage, side);
  const foot = el("div", "mp-foot");
  const status = el("span", "mp-status", "");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const apply = el("button", "mp-apply", "Make the changes");
  apply.disabled = true;
  foot.append(status, apply);
  box.append(head, tools, main, foot);
  dlg.appendChild(box);
  document.body.appendChild(dlg);
  if (window.BeeZillaResize && window.BeeZillaResize.attach) { try { window.BeeZillaResize.attach(box); } catch (_) { /* optional */ } }

  // ── three.js ──
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1b1b);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-4, 2, -3);
  scene.add(fill);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  const overlays = new THREE.Group();
  scene.add(overlays);

  let model = null;           // gltf.scene
  const parts = [];           // { mesh, tris, centroids, region (Uint8Array), overlay, colors }
  let tool = "turn";
  let dirty = false;
  let closed = false;

  function resize() {
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, r.width), hh = Math.max(1, r.height);
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  let raf = 0;
  function loop() {
    if (closed) return;
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  const gltf = await new Promise((resolve, reject) => new GLTFLoader().load(opts.url, resolve, undefined, reject)).catch((e) => {
    hint.textContent = "That model could not be opened: " + (e && e.message ? e.message : "unknown error");
    return null;
  });
  if (gltf) {
    model = gltf.scene;
    scene.add(model);
    model.updateMatrixWorld(true);
    model.traverse((o) => { if (o.isMesh) prepare(o); });
    frame();
    hint.textContent = "Drag to turn the model. Pick the red or blue brush and paint the area you want changed.";
  }
  resize();
  loop();

  function prepare(mesh) {
    const part = analyse(mesh);
    if (part) parts.push(part);
  }
  // A mesh's faces, their centres (for the brush) and the paint layer drawn over them.
  function analyse(mesh) {
    const g = mesh.geometry;
    const pos = g.getAttribute("position");
    if (!pos) return null;
    const idx = g.getIndex();
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const v = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    const centroids = new Float32Array(triCount * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      a.fromBufferAttribute(pos, v(t, 0)).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, v(t, 1)).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, v(t, 2)).applyMatrix4(mesh.matrixWorld);
      centroids[t * 3] = (a.x + b.x + c.x) / 3;
      centroids[t * 3 + 1] = (a.y + b.y + c.y) / 3;
      centroids[t * 3 + 2] = (a.z + b.z + c.z) / 3;
    }
    // The paint, drawn over the model: the same triangles, coloured per area.
    const og = new THREE.BufferGeometry();
    const op = new Float32Array(triCount * 9);
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        a.fromBufferAttribute(pos, v(t, k)).applyMatrix4(mesh.matrixWorld);
        op.set([a.x, a.y, a.z], t * 9 + k * 3);
      }
    }
    og.setAttribute("position", new THREE.BufferAttribute(op, 3));
    const colors = new Float32Array(triCount * 12);
    og.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    const om = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
    const overlay = new THREE.Mesh(og, om);
    overlay.renderOrder = 10;
    overlays.add(overlay);
    return { mesh, triCount, v, centroids, region: new Uint8Array(triCount), overlay, colors };
  }

  function frame() {
    const bb = new THREE.Box3().setFromObject(model);
    const size3 = bb.getSize(new THREE.Vector3());
    const centre = bb.getCenter(new THREE.Vector3());
    const radius = Math.max(size3.x, size3.y, size3.z) || 1;
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.position.copy(centre).add(new THREE.Vector3(radius * 0.9, radius * 0.6, radius * 1.3));
    camera.updateProjectionMatrix();
    controls.target.copy(centre);
    controls.update();
  }

  function setTool(t) {
    tool = t;
    btnTurn.classList.toggle("on", t === "turn");
    brushBtns.forEach((b, i) => b.classList.toggle("on", t === REGIONS[i].key));
    btnErase.classList.toggle("on", t === "erase");
    const painting = t !== "turn";
    controls.mouseButtons = { LEFT: painting ? null : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: painting ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN };
    controls.touches = { ONE: painting ? null : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
    canvas.style.cursor = painting ? "crosshair" : "grab";
    hint.textContent = painting
      ? (t === "erase" ? "Paint over an area to take its paint off. Right-drag turns the model." : `Paint the ${t} area. Right-drag turns the model; scroll zooms.`)
      : "Drag to turn the model. Pick the red or blue brush and paint the area you want changed.";
  }
  btnTurn.onclick = () => setTool("turn");
  brushBtns.forEach((b, i) => (b.onclick = () => setTool(REGIONS[i].key)));
  btnErase.onclick = () => setTool("erase");
  btnClear.onclick = () => {
    parts.forEach((p) => { p.region.fill(0); recolour(p); });
    dirty = false;
    sync();
  };

  // ── Painting ──
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function hitAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(parts.map((p) => p.mesh), false);
    return hits[0] || null;
  }
  /** Paint (or erase) every triangle within the brush of a world point. */
  function paintPoint(point, which, worldRadius) {
    const rr = worldRadius * worldRadius;
    let changed = 0;
    for (const p of parts) {
      const cs = p.centroids;
      for (let t = 0; t < p.triCount; t++) {
        const dx = cs[t * 3] - point.x, dy = cs[t * 3 + 1] - point.y, dz = cs[t * 3 + 2] - point.z;
        if (dx * dx + dy * dy + dz * dz > rr) continue;
        if (p.region[t] !== which) { p.region[t] = which; changed++; }
      }
      if (changed) recolour(p);
    }
    return changed;
  }
  function brushWorldRadius(point) {
    const r = canvas.getBoundingClientRect();
    const dist = camera.position.distanceTo(point);
    const worldH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return (Number(size.value) / Math.max(1, r.height)) * worldH * 0.5;
  }
  function recolour(p) {
    const col = p.colors;
    for (let t = 0; t < p.triCount; t++) {
      const reg = REGIONS.find((r) => r.id === p.region[t]);
      for (let k = 0; k < 3; k++) {
        const o = t * 12 + k * 4;
        if (reg) { col[o] = reg.rgb[0] / 255; col[o + 1] = reg.rgb[1] / 255; col[o + 2] = reg.rgb[2] / 255; col[o + 3] = 0.78; }
        else col[o + 3] = 0;
      }
    }
    p.overlay.geometry.getAttribute("color").needsUpdate = true;
  }
  let painting = false;
  function stroke(e) {
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) return;
    const which = tool === "erase" ? 0 : REGIONS.find((r) => r.key === tool).id;
    if (paintPoint(hit.point, which, brushWorldRadius(hit.point))) { dirty = true; sync(); }
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (tool === "turn" || e.button !== 0) return;
    painting = true;
    canvas.setPointerCapture(e.pointerId);
    stroke(e);
  });
  canvas.addEventListener("pointermove", (e) => { if (painting) stroke(e); });
  const endStroke = () => { painting = false; };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  // ── The areas and what to do with them ──
  const asks = {};
  const PICKS = ["Make it see-through glass", "Make it black", "Make it shiny metal", "Remove it"];
  function counts() {
    const n = {};
    REGIONS.forEach((r) => (n[r.id] = 0));
    parts.forEach((p) => { for (let t = 0; t < p.triCount; t++) if (p.region[t]) n[p.region[t]]++; });
    return n;
  }
  function sync() {
    const n = counts();
    side.innerHTML = "";
    const any = REGIONS.some((r) => n[r.id]);
    if (!any) side.appendChild(el("p", "mp-empty", "Paint an area with the red brush (and another with the blue one, if you like). Then say here how each should change — only the painted parts will."));
    REGIONS.forEach((r) => {
      if (!n[r.id]) return;
      const area = el("div", "mp-area");
      const t = el("h3");
      const dot = el("span", "dot");
      dot.style.cssText = `display:inline-block;width:.8em;height:.8em;border-radius:50%;background:${r.css}`;
      t.append(dot, document.createTextNode(`How should the ${r.name.toLowerCase()} area change?`));
      t.appendChild(el("span", "count", ` ${n[r.id]} faces`));
      const ta = el("textarea");
      ta.placeholder = r.id === 1 ? "e.g. make it see-through dark glass" : "e.g. make it black, shiny metal";
      ta.value = asks[r.id] || "";
      ta.setAttribute("aria-label", `How should the ${r.name.toLowerCase()} area change?`);
      ta.dataset.region = r.key;
      ta.addEventListener("input", () => { asks[r.id] = ta.value; syncApply(); });
      const picks = el("div", "mp-picks");
      PICKS.forEach((p) => {
        const b = el("button", "", p);
        b.type = "button";
        b.onclick = () => { ta.value = p; asks[r.id] = p; syncApply(); };
        picks.appendChild(b);
      });
      area.append(t, ta, picks);
      side.appendChild(area);
    });
    syncApply();
  }
  function syncApply() {
    const n = counts();
    const ready = REGIONS.some((r) => n[r.id] && String(asks[r.id] || "").trim());
    apply.disabled = !ready;
    status.textContent = ready ? "Only the painted parts will change. The original stays on your board." : REGIONS.some((r) => n[r.id]) ? "Say how each painted area should change." : "";
  }
  sync();

  // ── Making the changes ──
  async function doApply() {
    if (!model) return null;
    apply.disabled = true;
    const n = counts();
    const done = [];
    const picture = canvas.toDataURL("image/png");   // the painted areas, as seen
    for (const r of REGIONS) {
      const words = String(asks[r.id] || "").trim();
      if (!n[r.id] || !words) continue;
      const want = readInstruction(words);
      status.textContent = `Changing the ${r.name.toLowerCase()} area…`;
      try {
        if (want.kind === "remove") removeFaces(r.id);
        else if (want.kind === "glass") splitFaces(r.id, glassMaterial(want), r.key + "-glass");
        else if (want.kind === "look") {
          if (want.colour) recolourTexture(r.id, want.colour);
          if (want.metalness !== null || want.roughness !== null) splitFaces(r.id, null, r.key + "-finish", (m) => {
            if (want.metalness !== null) m.metalness = want.metalness;
            if (want.roughness !== null) m.roughness = want.roughness;
          });
        } else await repaintTexture(r.id, want.words);
        done.push({ region: r, words, kind: want.kind });
      } catch (e) {
        status.textContent = `The ${r.name.toLowerCase()} area could not be changed: ${e && e.message ? e.message : e}`;
        apply.disabled = false;
        return null;
      }
    }
    status.textContent = "Saving the changed model…";
    const bytes = await new Promise((resolve, reject) => new GLTFExporter().parse(model, resolve, reject, { binary: true }));
    const save = opts.save || defaultSave;
    const saved = await save(new Uint8Array(bytes), "model-changed-" + Date.now() + ".glb");
    // The picture of the painted areas goes to the Library too, so the board can show it.
    let pictureUrl = null;
    try {
      const blob = await (await fetch(picture)).blob();
      const pic = await save(new Uint8Array(await blob.arrayBuffer()), "painted-areas-" + Date.now() + ".png", "image/png");
      pictureUrl = pic && pic.url ? pic.url : null;
    } catch (_) { /* the model is what matters; the picture is a help */ }
    const result = { saved, done, picture, pictureUrl };
    if (opts.place) opts.place(result);
    dirty = false;
    done.forEach((d) => { delete asks[d.region.id]; });
    sync();
    status.textContent = "Done — the changed model is on your board, next to the original. You can paint more, or close this.";
    return result;
  }
  apply.onclick = () => { doApply(); };

  // Faces of one area, per part.
  function facesOf(p, id) {
    const out = [];
    for (let t = 0; t < p.triCount; t++) if (p.region[t] === id) out.push(t);
    return out;
  }
  // Take faces out of a mesh. The faces that stay keep their order, so the paint of the
  // other area (painted but not changed yet) follows them.
  function keepIndex(p, drop) {
    const g = p.mesh.geometry;
    const idx = g.getIndex();
    const keep = [];
    const kept = [];
    for (let t = 0; t < p.triCount; t++) {
      if (drop[t]) continue;
      kept.push(t);
      for (let k = 0; k < 3; k++) keep.push(idx ? idx.getX(t * 3 + k) : t * 3 + k);
    }
    g.setIndex(keep);
    return kept;
  }
  function removeFaces(id) {
    for (const p of parts) {
      const faces = facesOf(p, id);
      if (!faces.length) continue;
      const drop = new Uint8Array(p.triCount);
      faces.forEach((t) => (drop[t] = 1));
      rebuild(p, keepIndex(p, drop));
    }
  }
  /** The painted faces become a part of their own, with their own material. */
  function splitFaces(id, material, name, tweak) {
    for (const p of parts) {
      const faces = facesOf(p, id);
      if (!faces.length) continue;
      const g = p.mesh.geometry;
      const idx = g.getIndex();
      const piece = g.clone();
      const ix = [];
      faces.forEach((t) => { for (let k = 0; k < 3; k++) ix.push(idx ? idx.getX(t * 3 + k) : t * 3 + k); });
      piece.setIndex(ix);
      const mat = material || (Array.isArray(p.mesh.material) ? p.mesh.material[0] : p.mesh.material).clone();
      if (tweak) tweak(mat);
      const part = new THREE.Mesh(piece, mat);
      part.name = (p.mesh.name || "part") + "-" + name;
      p.mesh.parent.add(part);
      part.position.copy(p.mesh.position);
      part.quaternion.copy(p.mesh.quaternion);
      part.scale.copy(p.mesh.scale);
      const drop = new Uint8Array(p.triCount);
      faces.forEach((t) => (drop[t] = 1));
      rebuild(p, keepIndex(p, drop));
    }
  }
  function glassMaterial(want) {
    // glTF keeps this as alphaMode BLEND with the colour's alpha: see-through in every viewer.
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(want.colour), transparent: true, opacity: want.opacity, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide });
  }
  // After faces moved or went: the brush centres and the paint layer are made again for
  // the faces that stay, and their paint goes with them (the area just changed has none).
  function rebuild(p, kept) {
    const old = p.region;
    overlays.remove(p.overlay);
    p.overlay.geometry.dispose();
    p.overlay.material.dispose();
    const fresh = analyse(p.mesh);
    if (!fresh) return;
    kept.forEach((t, i) => { if (i < fresh.triCount) fresh.region[i] = old[t]; });
    Object.assign(p, fresh);
    recolour(p);
  }

  /** The texture pixels the area covers, as a mask the size of the texture. */
  function textureMask(p, id, w, hgt) {
    const g = p.mesh.geometry;
    const uv = g.getAttribute("uv");
    if (!uv) return null;
    const c = document.createElement("canvas");
    c.width = w; c.height = hgt;
    const k = c.getContext("2d");
    k.fillStyle = "#fff";
    k.strokeStyle = "#fff";
    k.lineWidth = 2;    // a little over the edge, so no seam of old colour is left
    let any = false;
    for (let t = 0; t < p.triCount; t++) {
      if (p.region[t] !== id) continue;
      k.beginPath();
      for (let j = 0; j < 3; j++) {
        const vi = p.v(t, j);
        const px = uv.getX(vi) * w, py = uv.getY(vi) * hgt;   // glTF: (0,0) is the image's top-left
        if (j === 0) k.moveTo(px, py); else k.lineTo(px, py);
      }
      k.closePath();
      k.fill();
      k.stroke();
      any = true;
    }
    if (!any) return null;
    const d = k.getImageData(0, 0, w, hgt).data;
    const m = new Uint8ClampedArray(w * hgt);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4];
    return m;
  }
  function textureCanvas(map) {
    const img = map.image;
    const w = img.width, hgt = img.height;
    const c = document.createElement("canvas");
    c.width = w; c.height = hgt;
    c.getContext("2d").drawImage(img, 0, 0);
    return c;
  }
  function putTexture(p, map, c) {
    const t = new THREE.CanvasTexture(c);
    t.flipY = map.flipY;
    t.colorSpace = map.colorSpace;
    t.wrapS = map.wrapS; t.wrapT = map.wrapT;
    t.channel = map.channel;
    const mats = Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material];
    mats.forEach((m) => { if (m.map === map) { m.map = t; m.needsUpdate = true; } });
    return t;
  }
  function recolourTexture(id, hex) {
    for (const p of parts) {
      if (!facesOf(p, id).length) continue;
      const mat = Array.isArray(p.mesh.material) ? p.mesh.material[0] : p.mesh.material;
      if (!mat.map || !mat.map.image) {
        // No texture: the painted faces get their own coloured material instead.
        splitFaces(id, null, "colour", (m) => { m.color = new THREE.Color(hex); });
        continue;
      }
      const c = textureCanvas(mat.map);
      const mask = textureMask(p, id, c.width, c.height);
      if (!mask) continue;
      const k = c.getContext("2d");
      const img = k.getImageData(0, 0, c.width, c.height);
      recolourPixels(img.data, mask, hex);
      k.putImageData(img, 0, 0);
      putTexture(p, mat.map, c);
    }
  }
  /** Only the painted pixels of the picture maker's repaint go back into the texture. */
  async function repaintTexture(id, words) {
    for (const p of parts) {
      if (!facesOf(p, id).length) continue;
      const mat = Array.isArray(p.mesh.material) ? p.mesh.material[0] : p.mesh.material;
      if (!mat.map || !mat.map.image) throw new Error("this model has no texture to repaint");
      const c = textureCanvas(mat.map);
      const mask = textureMask(p, id, c.width, c.height);
      if (!mask) continue;
      let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) { const xx = i % c.width, yy = (i - xx) / c.width; if (xx < x0) x0 = xx; if (yy < y0) y0 = yy; if (xx > x1) x1 = xx; if (yy > y1) y1 = yy; }
      const pad = 24;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      const crop = document.createElement("canvas"); crop.width = cw; crop.height = ch;
      crop.getContext("2d").drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
      const mk = document.createElement("canvas"); mk.width = cw; mk.height = ch;
      const mctx = mk.getContext("2d");
      const mimg = mctx.createImageData(cw, ch);
      for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
        const v = mask[(y0 + yy) * c.width + (x0 + xx)] ? 255 : 0;
        const o = (yy * cw + xx) * 4;
        mimg.data[o] = mimg.data[o + 1] = mimg.data[o + 2] = v; mimg.data[o + 3] = 255;
      }
      mctx.putImageData(mimg, 0, 0);
      const repaint = opts.repaint || defaultRepaint;
      const url = await repaint({ crop: crop.toDataURL("image/png"), mask: mk.toDataURL("image/png"), instruction: words });
      const back = await loadImage(url);
      const tmp = document.createElement("canvas"); tmp.width = cw; tmp.height = ch;
      tmp.getContext("2d").drawImage(back, 0, 0, cw, ch);
      const fresh = tmp.getContext("2d").getImageData(0, 0, cw, ch).data;
      const k = c.getContext("2d");
      const img = k.getImageData(x0, y0, cw, ch);
      for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
        if (!mask[(y0 + yy) * c.width + (x0 + xx)]) continue;    // outside the paint: untouched
        const o = (yy * cw + xx) * 4;
        img.data[o] = fresh[o]; img.data[o + 1] = fresh[o + 1]; img.data[o + 2] = fresh[o + 2];
      }
      k.putImageData(img, x0, y0);
      putTexture(p, mat.map, c);
    }
  }
  function loadImage(url) {
    return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("the repainted picture could not be read")); i.src = url; });
  }
  async function defaultSave(bytes, name, type) {
    const r = await fetch("/api/buzzy/assets", { method: "POST", credentials: "same-origin", headers: { "content-type": type || "model/gltf-binary", "x-bz-path": name }, body: bytes });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "the changed model could not be saved");
    return { id: j.id, url: "/api/buzzy/assets/" + j.id, name };
  }
  async function defaultRepaint(req) {
    const r = await fetch("/api/buzzy/art", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "repaint3d", crop: req.crop, mask: req.mask, instruction: req.instruction }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.image) throw new Error(j.error || "the picture maker did not repaint it");
    return j.image;
  }

  // ── Closing: Esc or ✕ only ──
  function close(force) {
    if (closed) return;
    if (dirty && !force && !window.confirm("Close without making the changes? Your paint will be lost.")) return;
    closed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener("keydown", onKey, true);
    controls.dispose();
    renderer.dispose();
    dlg.remove();
    if (opts.onClose) opts.onClose();
  }
  function onKey(e) {
    const typing = e.target && /^(?:TEXTAREA|INPUT)$/.test(e.target.tagName);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); return; }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (k === "t") setTool("turn");
    else if (k === "r") setTool("red");
    else if (k === "b") setTool("blue");
    else if (k === "e") setTool("erase");
  }
  document.addEventListener("keydown", onKey, true);
  x.onclick = () => close(false);

  setTool("turn");
  return {
    close,
    apply: doApply,
    state: () => ({ loaded: !!model, parts: parts.length, faces: parts.reduce((s, p) => s + p.triCount, 0), counts: counts(), dirty, tool }),
    /** For tests: paint at a point on the screen with a colour ("red", "blue", "erase"). */
    paintAt(clientX, clientY, which) { setTool(which); const hit = hitAt(clientX, clientY); if (!hit) return 0; const id = which === "erase" ? 0 : REGIONS.find((r) => r.key === which).id; const nn = paintPoint(hit.point, id, brushWorldRadius(hit.point)); if (nn) { dirty = true; sync(); } return nn; },
    ask(which, words) { const r = REGIONS.find((q) => q.key === which); asks[r.id] = words; sync(); },
    /** For tests: paint every face within `radius` of a point on the model (world units). */
    paintWorld(px, py, pz, which, radius) { const id = which === "erase" ? 0 : REGIONS.find((r) => r.key === which).id; const nn = paintPoint(new THREE.Vector3(px, py, pz), id, radius); if (nn) { dirty = true; sync(); } return nn; },
  };
}
