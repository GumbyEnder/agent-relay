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
 *   - A red brush and a blue brush paint what you SEE: each painted triangle belongs to that
 *     colour's area. The brush reads a picture of which triangle shows at each pixel, so a
 *     part behind another part is never painted through it. An eraser takes paint off.
 *   - Each colour gets "How should the red area change?", with quick picks. What an
 *     instruction means is decided from its words (readInstruction), and only when the words
 *     say so: "remove it" takes the part off, "remove the scratches" is a repaint.
 *   - "Make the changes" changes ONLY the painted triangles and their part of the texture;
 *     every other triangle, pixel and material in the file stays as it was:
 *       see-through / glass   → the painted faces become their own glass primitive
 *       a colour ("black")    → the painted faces get their own copy of the texture, recoloured
 *       shiny / metal / matte → the painted faces get their own material
 *       remove                → the painted faces are taken out
 *       anything else         → BeeZilla's picture maker repaints the painted part of the
 *                               texture (this uses picture generations, said before you press),
 *                               and only the painted pixels are put back
 *   - The file is patched, not exported again (glb-patch.js): textures, animations and
 *     everything not painted are carried over byte for byte. The work is staged: nothing in
 *     the open model or your paint changes until the new file has been built, checked, saved
 *     and put on the board; a failure at any step leaves it all as it was.
 *   - The result is saved as a new .glb in the Library and put on the board next to the
 *     original (which is kept), joined by lines, with a note for each colour saying what
 *     was asked and a picture of each painted area (so a colour is never asked about
 *     without showing it). The painter then shows the new model, so you can paint more.
 */
import * as THREE from "./vendor/three/three.module.min.js";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "./vendor/three/addons/controls/OrbitControls.js";
import { GlbPatch, copyOf, readGlb, readModel as readModelFile } from "./glb-patch.js";

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
const SHINY = new Set(["shiny", "glossy", "gloss", "polished", "chrome", "mirror", "metal", "metallic", "steel"]);
const METAL = new Set(["chrome", "mirror", "metal", "metallic", "steel"]);
const MATTE = new Set(["matte", "matt", "dull", "rough", "flat"]);
const SEE = new Set(["seethrough", "transparent", "translucent", "glass", "glassy", "tinted", "tint", "clearglass"]);
const SOLID = new Set(["opaque", "solid"]);
// Words that only frame a request ("please make it …", "the part should be …").
const FRAME = new Set(("make makes turn turns change changes set have give paint painted colour color coloured colored should must need needs " +
  "to into be become as it its this that them these those the a an of in so all whole entire area areas part parts bit bits region regions " +
  "piece pieces selection selected marked thing patch surface look looks like more less very really quite slightly fully completely totally " +
  "is are was will would can could id ill lets let us we you i me my your our want wish please just now then and also with kindly").split(" "));
// Names of parts, harmless in "make the windshield black": they say WHICH part, not what to do.
const PARTS = new Set(("windshield windscreen window windows visor lens canopy door doors hood bonnet roof wheel wheels tire tires tyre tyres rim rims " +
  "body bumper bumpers panel panels light lights headlight headlights taillight taillights trim handle handles seat seats wing wings fender fenders " +
  "hull cabin cockpit lid cover grille grill barrel turret armor armour plate plates frame shell cap case track tracks gun engine hatch trunk boot " +
  "tailgate fin").split(" "));
// "remove it", "delete this part", "get rid of the painted area": the part ITSELF is to go.
const WHAT = "(?:it|this|that|them|these|those|everything|all of it|(?:the |this |that |these |those )?(?:(?:whole|entire|painted|selected|marked|red|blue) )*(?:part|parts|area|areas|region|regions|bit|bits|piece|pieces|selection|patch|thing|faces)(?: (?:i|you|we) (?:painted|marked|selected))?)";
const OFF = "(?: (?:off|out|away|completely|entirely|altogether|totally|fully))*";
const REMOVE = new RegExp("^(?:(?:remove|delete|erase|discard|hide|scrap|drop)(?: " + WHAT + ")?|(?:take|cut)(?: " + WHAT + ")? (?:off|out|away)|get rid of(?: " + WHAT + ")?)" + OFF + "$");
const LEAD = /^(?:please|just|now|then|ok|okay|so|and|also|kindly|go ahead and|can you|could you|would you|will you|you can|you could|you should|i want you to|i want to|i want|i would like you to|i would like to|i would like|id like you to|id like to|id like|i need you to|i need to|i need|lets|let us|we should|we can|we could|we need to|we want to|we want)\s+/;
const TRAIL = /\s+(?:please|thanks|thank you|thx|for me|now)$/;

function plainWords(text) {
  let t = String(text || "").toLowerCase().replace(/['’]/g, "");
  t = t.replace(/#([0-9a-f]{6}|[0-9a-f]{3})\b/g, " hex$1 ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(LEAD, "").replace(TRAIL, "").trim();
    if (t === before) break;
  }
  return t;
}
/**
 * One instruction, read into the change it asks for. Never guesses beyond the words: a change
 * that cannot be undone (taking faces away) or that changes what a surface IS (see-through) is
 * only read from words that ask for it about the painted part itself; anything the words do not
 * settle goes to the picture maker, which only repaints the painted pixels.
 */
export function readInstruction(text) {
  const raw = String(text || "").trim();
  let t = plainWords(raw);
  if (!t) return { kind: "none" };
  if (REMOVE.test(t)) return { kind: "remove" };
  // "the red area" names the area, it is not the colour red.
  t = t.replace(/\b(?:red|blue) (?=(?:area|areas|part|parts|bit|bits|region|regions|selection|patch|piece|pieces)\b)/g, "");
  // Transparency words, in the forms that really ask for it (a bare "clear" is not one).
  t = t.replace(/\b(?:non|not|isnt|arent|never|no longer|stop being|without)\s+(?:be\s+|being\s+)?(?:see through|seen through|transparent|translucent|clear glass|glass|glassy)\b/g, " opaque ")
    .replace(/\bsee through\b|\bcrystal clear\b/g, "seethrough")
    .replace(/\bclear (?=glass|plastic|acrylic|perspex)/g, "clearglass ")
    .replace(/\b(?:make|turn|have|set|be|become|is|are)\s+(?:(?:it|this|that|them|the area|the part|the painted area|the painted part)\s+)?(?:(?:completely|fully|totally|more|very|really)\s+)?clear\b/g, (m) => m.replace(/clear$/, "seethrough"));
  if (t === "clear") t = "seethrough";
  const toks = t.split(" ").filter(Boolean);
  const colours = [];
  let shade = null, hex = null, shiny = false, metal = false, matte = false, see = false, tint = false, solid = false, clearish = false, content = false;
  const left = [];
  for (const w of toks) {
    const h = /^hex([0-9a-f]{3}|[0-9a-f]{6})$/.exec(w);
    if (h) { hex = "#" + (h[1].length === 3 ? h[1].split("").map((c) => c + c).join("") : h[1]); colours.push(hex); content = true; }
    else if (COLOURS[w]) { colours.push(COLOURS[w]); content = true; }
    else if (SHADE[w]) { shade = SHADE[w]; content = true; }
    else if (SHINY.has(w)) { shiny = true; if (METAL.has(w)) metal = true; content = true; }
    else if (MATTE.has(w)) { matte = true; content = true; }
    else if (SEE.has(w)) { see = true; content = true; if (w === "tinted" || w === "tint") tint = true; if (w === "seethrough" || w === "transparent" || w === "clearglass") clearish = true; }
    else if (SOLID.has(w)) { solid = true; content = true; }
    else if (!FRAME.has(w) && !PARTS.has(w)) left.push(w);
  }
  // Anything the words do not settle, or two things at once: the picture maker, painted pixels only.
  if (left.length || new Set(colours).size > 1 || (see && solid)) return { kind: "repaint", words: raw.slice(0, 600) };
  let colour = colours[0] || null;
  if (colour && shade && !hex) colour = scaleHex(colour, shade);
  if (see) return { kind: "glass", colour: colour || "#203040", opacity: clearish && !tint ? 0.25 : 0.45 };
  if (solid || colour || shiny || matte) {
    return { kind: "look", opaque: solid, colour, metalness: shiny && metal ? 0.9 : null, roughness: shiny ? 0.15 : matte ? 0.95 : null };
  }
  return content ? { kind: "repaint", words: raw.slice(0, 600) } : { kind: "none" };
}
function scaleHex(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return "#" + [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
/** What an instruction will do, in a sentence (shown under the box before anything is done). */
export function describeInstruction(want) {
  if (!want || want.kind === "none") return "";
  if (want.kind === "remove") return "Takes the painted part off the model.";
  if (want.kind === "glass") return want.opacity < 0.3 ? "Turns it into clear, see-through glass." : "Turns it into tinted, see-through glass.";
  if (want.kind === "repaint") return "The picture maker repaints the painted part of the texture.";
  const bits = [];
  if (want.opaque) bits.push("makes it solid (not see-through)");
  if (want.colour) {
    const name = Object.keys(COLOURS).find((k) => COLOURS[k] === want.colour);
    bits.push("recolours it " + (name || want.colour));
  }
  if (want.metalness !== null && want.metalness !== undefined) bits.push("makes it shiny metal");
  else if (want.roughness !== null && want.roughness !== undefined) bits.push(want.roughness < 0.5 ? "makes it shiny" : "makes it matte");
  return bits.length ? bits[0].charAt(0).toUpperCase() + bits.join(", ").slice(1) + "." : "";
}

/**
 * Recolour pixels in place where the mask is set, keeping their light and shade. A flat dark
 * area (all black, say) has no shade to keep, so it simply takes the colour.
 */
export function recolourPixels(data, mask, hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const tr = (n >> 16) & 255, tg = (n >> 8) & 255, tb = n & 255;
  // The area's own average brightness, so the result has the target colour on average
  // and keeps every scratch, seam and shadow of the original.
  let sum = 0, count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { const p = i * 4; sum += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]; count++; }
  if (!count) return 0;
  const avg = sum / count;
  const flat = avg < 8;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    const l = flat ? 1 : (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / avg;
    const a = mask[i] / 255;
    data[p] = Math.round(data[p] * (1 - a) + Math.min(255, tr * l) * a);
    data[p + 1] = Math.round(data[p + 1] * (1 - a) + Math.min(255, tg * l) * a);
    data[p + 2] = Math.round(data[p + 2] * (1 - a) + Math.min(255, tb * l) * a);
  }
  return count;
}
/** One channel (0 R, 1 G, 2 B) set to a value where the mask is set. */
export function fillChannel(data, mask, channel, value) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4 + channel, a = mask[i] / 255;
    data[p] = Math.round(data[p] * (1 - a) + value * a);
    count++;
  }
  return count;
}

const LOCKDOWN_SAYS = "Lockdown is on, and nothing leaves BeeZilla in that mode, so the picture maker cannot repaint this. " +
  "Colours, glass, shiny or matte finishes and “remove it” still work. The privacy control on the Talk bar switches Lockdown off.";
const FINISH_NOT = "this part's material is flat-shaded or uses an older material type, so shininess has no effect on it";
const MAX_TEXELS = 8192 * 8192;
/** A picture's own size (an image element reports its drawn size, a bitmap its real one). */
const sizeOf = (img) => ({ w: img.naturalWidth || img.width || 0, h: img.naturalHeight || img.height || 0 });

// ── The window ────────────────────────────────────────────────────────────
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = `
.mp-dialog{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6)}
.mp-box{position:relative;display:flex;flex-direction:column;width:min(1100px,100%);height:min(780px,100%);background:#141414;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden;container:mp/inline-size;outline:none}
.mp-head{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem;border-bottom:1px solid #2a2a2a}
.mp-head h2{flex:1;margin:0;font-size:1rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-x{background:none;border:1px solid #444;color:#ddd;border-radius:8px;width:36px;height:36px;cursor:pointer;font-size:15px}
.mp-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;padding:.5rem .9rem;border-bottom:1px solid #2a2a2a}
.mp-tools button{background:#1e1e1e;color:#eee;border:1px solid #3a3a3a;border-radius:9px;padding:.35rem .7rem;cursor:pointer;font-size:.86rem}
.mp-tools button.on{border-color:#ffd40d;background:#2a2610}
.mp-tools button[disabled],.mp-tools input[disabled]{opacity:.45;cursor:default}
.mp-tools .dot{display:inline-block;width:.8em;height:.8em;border-radius:50%;margin-right:.35em;vertical-align:-1px}
.mp-tools label{font-size:.8rem;color:#aaa;display:inline-flex;align-items:center;gap:.35rem}
.mp-main{flex:1;min-height:0;display:flex}
.mp-stage{position:relative;flex:1 1 0;min-width:0;min-height:0;background:#1b1b1b}
.mp-stage canvas{position:absolute;inset:0;display:block;width:100%;height:100%;touch-action:none}
.mp-hint{position:absolute;left:10px;bottom:10px;right:10px;font-size:.8rem;color:#bbb;pointer-events:none;text-shadow:0 1px 2px #000}
.mp-hint.err{color:#ff9a9a;font-size:.9rem}
.mp-side{width:300px;max-width:42%;overflow:auto;border-left:1px solid #2a2a2a;padding:.7rem .8rem;display:flex;flex-direction:column;gap:.8rem}
.mp-area{border:1px solid #333;border-radius:10px;padding:.6rem}
.mp-area h3{margin:0 0 .4rem;font-size:.9rem;display:flex;align-items:center;gap:.4rem}
.mp-area .count{color:#999;font-weight:400;font-size:.78rem}
.mp-area textarea{width:100%;box-sizing:border-box;min-height:64px;background:#101010;color:#eee;border:1px solid #3a3a3a;border-radius:8px;padding:.4rem;font:inherit;font-size:.85rem;resize:vertical}
.mp-note{margin:.35rem 0 0;font-size:.78rem;color:#b9b9b9}
.mp-note b{color:#ffd40d;font-weight:600}
.mp-picks{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.35rem}
.mp-picks button{background:#1e1e1e;color:#ccc;border:1px solid #3a3a3a;border-radius:999px;padding:.15rem .55rem;font-size:.75rem;cursor:pointer}
.mp-picks button[disabled],.mp-area textarea[disabled]{opacity:.5;cursor:default}
.mp-empty{color:#999;font-size:.84rem}
.mp-foot{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem;border-top:1px solid #2a2a2a}
.mp-status{flex:1;font-size:.84rem;color:#bbb}
.mp-apply{background:#ffd40d;color:#111;border:1px solid #ffd40d;border-radius:9px;padding:.45rem .9rem;font-weight:650;cursor:pointer}
.mp-apply[disabled]{opacity:.5;cursor:default}
@container mp (max-width:640px){.mp-main{flex-direction:column}.mp-side{width:auto;max-width:none;border-left:none;border-top:1px solid #2a2a2a;max-height:40%}}
@media (max-width:760px){.mp-main{flex-direction:column}.mp-side{width:auto;max-width:none;border-left:none;border-top:1px solid #2a2a2a;max-height:40%}}`;
  document.head.appendChild(s);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const linear = (hex) => new THREE.Color(hex).toArray();
function dataUrlBytes(url) {
  const bin = atob(String(url).split(",")[1] || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function loadImage(url) {
  return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("the repainted picture could not be read")); i.src = url; });
}
/** Plain words for a failure; the page's own errors already are. */
const whyOf = (e) => (e && e.message ? String(e.message) : String(e || "something went wrong"));
/** A reason to stop that is not a fault (said as it is, nothing "went wrong"). */
class Refusal extends Error {}
class Stopped extends Error {}

/**
 * Open the painter for one model card.
 *   opts.url       the .glb (/api/buzzy/assets/<id>)
 *   opts.title     the card's title
 *   opts.save      async (bytes, name, type, { signal }) → { url, id }     (defaults to POST /api/buzzy/assets)
 *   opts.repaint   async ({crop, mask, instruction}, { signal }) → dataUrl (defaults to /api/buzzy/art repaint3d)
 *   opts.canPlace  (cards) → "" when the board has room for that many cards, else the words to say
 *   opts.place     (result) → true once the changed model, notes and pictures are on the board
 *   opts.privacy   async () → "open" | "advocate" | "lockdown"      (defaults to the page's and the account's)
 *   opts.onClose   called once, after the painter has closed
 * Resolves, once the model has loaded or failed to, with the painter's handle (for tests):
 * { close, paintAt, paintWorld, apply, ask, state, screenOf, setView }.
 */
export async function open(opts) {
  opts = opts || {};
  style();
  const opener = document.activeElement;
  const ctl = new AbortController();
  let closed = false, busy = false, cancelled = false, dirty = false;
  let failed = "";                 // why the 3D view cannot be used; kept on screen, never replaced
  let renderer = null, controls = null, pickTarget = null, ro = null, raf = 0;
  let model = null, gltf = null, source = null;
  const parts = [];                // { mesh, assoc, triCount, v, region (Uint8Array), overlay, pick, colors, idBase }
  let nextId = 0, pickFresh = false;
  let tool = "turn";
  const asks = {};
  const areaEls = {};
  let usedRepaints = 0;

  // ── The dialog: its exits are in place before anything slow starts ──
  const dlg = el("div", "mp-dialog");
  const box = el("div", "mp-box");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "mpTitle");
  box.tabIndex = -1;
  box.setAttribute("data-bz-resize", "all");
  box.setAttribute("data-bz-resize-anchor", "center");
  // Never smaller than the canvas, the tools and the button need, nor wider than a small screen has.
  const minW = Math.min(480, Math.max(300, window.innerWidth - 32)), minH = Math.min(480, Math.max(320, window.innerHeight - 32));
  box.setAttribute("data-bz-resize-min", minW + " " + minH);
  box.setAttribute("data-bz-resize-key", "model-paint");
  box.setAttribute("data-bz-resize-name", "the painter");
  const head = el("div", "mp-head");
  const h = el("h2", "", "Paint what to change — " + String(opts.title || "3D model").slice(0, 80));
  h.id = "mpTitle";
  const x = el("button", "mp-x", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  head.append(h, x);
  const tools = el("div", "mp-tools");
  const btnTurn = el("button", "on", "Turn");
  btnTurn.type = "button";
  btnTurn.title = "Drag to turn the model, scroll to zoom, right-drag to move (T)";
  const brushBtns = REGIONS.map((r) => {
    const b = el("button");
    b.type = "button";
    const dot = el("span", "dot");
    dot.style.background = r.css;
    b.append(dot, document.createTextNode(r.name + " brush"));
    b.title = `Paint the ${r.name.toLowerCase()} area (${r.key[0].toUpperCase()}). Right-drag turns the model while painting.`;
    return b;
  });
  const btnErase = el("button", "", "Eraser");
  btnErase.type = "button";
  btnErase.title = "Take paint off (E)";
  const sizeLab = el("label", "", "Brush");
  const size = el("input");
  size.type = "range"; size.min = "4"; size.max = "120"; size.value = "28";
  size.setAttribute("aria-label", "Brush size");
  sizeLab.appendChild(size);
  const btnClear = el("button", "", "Clear paint");
  btnClear.type = "button";
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
  apply.type = "button";
  apply.disabled = true;
  foot.append(status, apply);
  box.append(head, tools, main, foot);
  dlg.appendChild(box);
  document.body.appendChild(dlg);
  // Nothing behind the window can be reached by key or by screen reader while it is open.
  const inerted = [];
  Array.prototype.forEach.call(document.body.children, (n) => {
    if (n === dlg || /^(?:SCRIPT|STYLE|LINK)$/.test(n.tagName) || n.inert) return;
    n.inert = true;
    inerted.push(n);
  });
  try { box.focus({ preventScroll: true }); } catch { /* focus is a convenience */ }
  if (window.BeeZillaResize && window.BeeZillaResize.attach) {
    try { window.BeeZillaResize.attach(box, { edges: "all", ax: "center", ay: "center", min: [minW, minH], bound: "window", key: "model-paint", name: "the painter" }); } catch { /* the attributes find it too */ }
  }

  const say = (text) => { if (!closed) status.textContent = text; };
  function setHint(text, isError) {
    hint.textContent = text;
    hint.classList.toggle("err", !!isError);
  }
  function fail(why) {
    failed = why;
    setHint(why, true);
    syncTools();
    sync();
  }

  // ── Closing: Esc or ✕ only ──
  function close(force) {
    if (closed) return;
    if (!force) {
      if (busy && !window.confirm("Stop making the changes? Nothing will be put on your board.")) return;
      if (!busy && dirty && !window.confirm("Close without making the changes? Your paint will be lost.")) return;
    }
    if (busy) { cancelled = true; }
    closed = true;
    ctl.abort();
    document.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    if (renderer) {
      clearModel();
      if (pickTarget) pickTarget.dispose();
      if (controls) controls.dispose();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* already gone */ }
    }
    if (window.BeeZillaResize && window.BeeZillaResize.detach) { try { window.BeeZillaResize.detach(box); } catch { /* optional */ } }
    inerted.forEach((n) => { n.inert = false; });
    dlg.remove();
    box.textContent = "";
    parts.length = 0;
    source = null; gltf = null; model = null;
    try { if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true }); } catch { /* focus is a convenience */ }
    if (opts.onClose) { try { opts.onClose(); } catch { /* the page's own */ } }
  }
  const resizing = () => document.documentElement.hasAttribute("data-bz-rs");
  function onKey(e) {
    if (e.key === "Escape") {
      // A drag of the window's edge is taken back by Esc, and that Esc is the drag's: it closes nothing.
      if (resizing()) return;
      e.preventDefault(); e.stopPropagation();
      close(false);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (e.target && /^(?:TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (!model || failed || busy) return;
    if (k === "t") setTool("turn");
    else if (k === "r") setTool("red");
    else if (k === "b") setTool("blue");
    else if (k === "e") setTool("erase");
  }
  document.addEventListener("keydown", onKey, true);
  x.onclick = () => close(false);

  // ── three.js ──
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
  const overlays = new THREE.Group();
  scene.add(overlays);
  const pickScene = new THREE.Scene();      // the same triangles, each drawn in its own number
  function startRenderer() {
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.addEventListener("change", () => { pickFresh = false; });
      canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (!failed) fail("The 3D view stopped (the graphics card was reset). Close this and open the painter again."); });
    } catch (e) {
      if (renderer) { try { renderer.dispose(); } catch { /* never started */ } }
      renderer = null; controls = null;
      fail("The 3D view could not start in this browser: " + whyOf(e) + ". You can still close this.");
    }
  }

  function resize() {
    if (!renderer || closed) return;
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, r.width), hh = Math.max(1, r.height);
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
    pickFresh = false;
  }
  function startLoop() {
    ro = new ResizeObserver(resize);
    ro.observe(stage);
    const loop = () => {
      if (closed) return;
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    resize();
    loop();
  }

  // ── Loading ──
  const parseGltf = (bytes) => new Promise((resolve, reject) => {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    new GLTFLoader().parse(copy, "", resolve, reject);
  });
  async function readModel() {
    const res = await fetch(opts.url, { credentials: "same-origin", signal: ctl.signal });
    if (!res.ok) throw new Error("the file could not be read (" + res.status + ")");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const glb = readModelFile(bytes);   // a .glb, or a .gltf with its data inside it (the result is saved as a .glb either way)
    new GlbPatch(glb);                  // says now if the file keeps its data outside itself
    const g = await parseGltf(bytes);
    if (!g || !g.scene) throw new Error("that file has no model in it");
    return { bytes, glb, gltf: g };
  }
  function unsupported(g) {
    let bad = "";
    g.scene.traverse((o) => { if (o.isInstancedMesh && !bad) bad = "This model repeats parts with GPU instancing, which the painter cannot change yet."; });
    return bad;
  }
  function clearModel() {
    parts.forEach((p) => {
      overlays.remove(p.overlay);
      pickScene.remove(p.pick);
      p.overlay.geometry.dispose();
      p.overlay.material.dispose();
      p.pick.material.dispose();
    });
    parts.length = 0;
    nextId = 0;
    if (model) { scene.remove(model); disposeTree(model); }
    model = null; gltf = null;
  }
  /** Free what a loaded model holds on the graphics card and in memory. */
  function disposeTree(root) {
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => {
        Object.keys(m).forEach((k) => {
          const t = m[k];
          if (t && t.isTexture) {
            if (t.image && typeof t.image.close === "function") { try { t.image.close(); } catch { /* closed already */ } }
            t.dispose();
          }
        });
        m.dispose();
      });
    });
  }
  async function install(g, glb, bytes, first) {
    // Which node of the file each object of the loaded scene is. The loader's own notes cannot say: a
    // mesh used by two nodes is one set of notes for both, and the later node's number wins.
    nodeOf = new Map();
    const objects = await Promise.all((glb.json.nodes || []).map((_n, i) => g.parser.getDependency("node", i).catch(() => null)));
    objects.forEach((o, i) => { if (o) nodeOf.set(o, i); });
    if (closed) { disposeTree(g.scene); return; }
    clearModel();
    gltf = g;
    model = g.scene;
    source = { json: glb.json, bin: glb.bin, bytes };
    scene.add(model);
    model.updateMatrixWorld(true);
    const bad = unsupported(g);
    if (bad) { fail(bad); return; }
    model.traverseVisible((o) => { if (o.isMesh) { const p = analyse(o); if (p) parts.push(p); } });
    if (first) frame();
    pickFresh = false;
    setHint(parts.length ? hintFor("turn") : "There is nothing left to paint: every part of this model was taken off.", !parts.length);
  }
  // Everything above is only declared; this runs once all of it is in place (Esc and ✕ already work).
  async function init() {
    startRenderer();
    if (renderer) {
      startLoop();
      try {
        const r = await readModel();
        if (!closed) await install(r.gltf, r.glb, r.bytes, true);
        else disposeTree(r.gltf.scene);
      } catch (e) {
        if (!closed) fail("That model could not be opened: " + whyOf(e));
      }
    }
    if (closed) return;
    syncTools();
    setTool("turn");
    sync();
  }

  // ── The model's triangles: their centres, the paint over them, and their numbers ──
  let nodeOf = new Map();           // object of the loaded scene → its node's number in the file
  function nodeIndexOf(mesh) {
    for (let o = mesh; o; o = o.parent) if (nodeOf.has(o)) return nodeOf.get(o);
    return undefined;
  }
  function analyse(mesh) {
    const g = mesh.geometry;
    const pos = g.getAttribute("position");
    if (!pos) return null;
    const idx = g.getIndex();
    const ia = idx ? idx.array : null;
    const triCount = ia ? Math.floor(ia.length / 3) : Math.floor(pos.count / 3);
    if (!triCount) return null;
    const v = (t, k) => (ia ? ia[t * 3 + k] : t * 3 + k);
    const a = new THREE.Vector3();
    const op = new Float32Array(triCount * 9);
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        a.fromBufferAttribute(pos, v(t, k)).applyMatrix4(mesh.matrixWorld);
        op[t * 9 + k * 3] = a.x; op[t * 9 + k * 3 + 1] = a.y; op[t * 9 + k * 3 + 2] = a.z;
      }
    }
    const idBase = nextId;
    nextId += triCount;
    const ids = new Uint8Array(triCount * 12);
    for (let t = 0; t < triCount; t++) {
      const n = idBase + t + 1;
      for (let k = 0; k < 3; k++) { const o = t * 12 + k * 4; ids[o] = n & 255; ids[o + 1] = (n >> 8) & 255; ids[o + 2] = (n >> 16) & 255; ids[o + 3] = 255; }
    }
    // The paint, drawn over the model: the same triangles, coloured per area.
    const og = new THREE.BufferGeometry();
    og.setAttribute("position", new THREE.BufferAttribute(op, 3));
    const colors = new Float32Array(triCount * 12);
    og.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    og.setAttribute("pickId", new THREE.BufferAttribute(ids, 4, true));
    const om = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
    const overlay = new THREE.Mesh(og, om);
    overlay.renderOrder = 10;
    overlay.frustumCulled = false;
    overlays.add(overlay);
    // The same triangles in their own numbers (as colours), seen the way the model is seen: a face the
    // model hides (its back, when it is drawn one-sided) is hidden here too.
    const mirrored = mesh.matrixWorld.determinant() < 0;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const side = !mat || mat.side === THREE.DoubleSide ? THREE.DoubleSide : (mat.side === THREE.BackSide) !== mirrored ? THREE.BackSide : THREE.FrontSide;
    const pm = new THREE.ShaderMaterial({
      vertexShader: "attribute vec4 pickId; varying vec4 vPick; void main(){ vPick = pickId; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "varying vec4 vPick; void main(){ gl_FragColor = vPick; }",
      side,
    });
    const pick = new THREE.Mesh(og, pm);
    pick.frustumCulled = false;
    pickScene.add(pick);
    const assoc = gltf.parser.associations.get(mesh) || {};
    return { mesh, assoc: { mesh: assoc.meshes, prim: assoc.primitives, node: nodeIndexOf(mesh) }, triCount, v, region: new Uint8Array(triCount), overlay, pick, colors, idBase, world: op };
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

  // ── The tools ──
  const hintFor = (t) => (t === "turn"
    ? "Drag to turn the model. Pick the red or blue brush and paint the area you want changed."
    : t === "erase" ? "Paint over an area to take its paint off. Right-drag turns the model."
      : `Paint the ${t} area. Right-drag turns the model; scroll zooms. Only what you can see is painted.`);
  function syncTools() {
    const can = !!model && !failed && !busy && parts.length > 0;
    brushBtns.forEach((b) => { b.disabled = !can; });
    btnErase.disabled = !can;
    btnClear.disabled = !can;
    size.disabled = !can;
    btnTurn.disabled = !model || !!failed;
  }
  function setTool(t) {
    tool = t;
    btnTurn.classList.toggle("on", t === "turn");
    brushBtns.forEach((b, i) => b.classList.toggle("on", t === REGIONS[i].key));
    btnErase.classList.toggle("on", t === "erase");
    const painting = t !== "turn";
    if (controls) {
      controls.mouseButtons = { LEFT: painting ? null : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: painting ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN };
      controls.touches = { ONE: painting ? null : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
    }
    canvas.style.cursor = painting ? "crosshair" : "grab";
    if (!failed && model && parts.length) setHint(hintFor(t), false);
  }
  btnTurn.onclick = () => setTool("turn");
  brushBtns.forEach((b, i) => (b.onclick = () => setTool(REGIONS[i].key)));
  btnErase.onclick = () => setTool("erase");
  btnClear.onclick = () => {
    if (busy) return;
    parts.forEach((p) => { p.region.fill(0); for (let i = 3; i < p.colors.length; i += 4) p.colors[i] = 0; p.overlay.geometry.getAttribute("color").needsUpdate = true; });
    dirty = false;
    sync();
  };

  // ── Painting: what you see under the brush ──
  function renderPick() {
    const dim = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!pickTarget || pickTarget.width !== dim.x || pickTarget.height !== dim.y) {
      if (pickTarget) pickTarget.dispose();
      pickTarget = new THREE.WebGLRenderTarget(dim.x, dim.y, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    }
    const was = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(pickTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.render(pickScene, camera);
    renderer.setRenderTarget(was);
    renderer.setClearColor(clear, clearAlpha);
    pickFresh = true;
  }
  const partOfId = (n) => { for (const p of parts) if (n > p.idBase && n <= p.idBase + p.triCount) return p; return null; };
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tri = new THREE.Triangle(), hitAt = new THREE.Vector3(), near = new THREE.Vector3();
  const triOf = (p, t) => { tri.a.fromArray(p.world, t * 9); tri.b.fromArray(p.world, t * 9 + 3); tri.c.fromArray(p.world, t * 9 + 6); return tri; };
  /**
   * The triangles visible inside a disc of the screen, per part; null when its centre is not on the model.
   * Only what the brush can SEE is painted (the picture of triangle numbers hides what is behind), and of
   * that only what is near the face under its centre: a part that shows past the edge of the one being
   * painted, far behind it, is another part and is left alone (three brush radii, in the model's own units).
   */
  function seenUnder(clientX, clientY, radiusCss) {
    if (!renderer || !parts.length) return null;
    if (!pickFresh) renderPick();
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const W = pickTarget.width, H = pickTarget.height;
    const sx = W / rect.width, sy = H / rect.height;
    const cx = Math.floor((clientX - rect.left) * sx), cy = H - 1 - Math.floor((clientY - rect.top) * sy);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;
    const r = Math.max(0, Math.round(radiusCss * Math.max(sx, sy)));
    const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r), x1 = Math.min(W - 1, cx + r), y1 = Math.min(H - 1, cy + r);
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    const buf = new Uint8Array(w * hh * 4);
    renderer.readRenderTargetPixels(pickTarget, x0, y0, w, hh, buf);
    const at = (px, py) => { const o = ((py - y0) * w + (px - x0)) * 4; return buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16); };
    const centreId = at(cx, cy);
    if (!centreId) return null;
    const seen = new Map();
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx, dy = py - cy;
        if (dx * dx + dy * dy > r * r) continue;
        const n = at(px, py);
        if (!n) continue;
        const p = partOfId(n);
        if (!p) continue;
        let set = seen.get(p);
        if (!set) seen.set(p, (set = new Set()));
        set.add(n - p.idBase - 1);
      }
    }
    // Near the face under the centre of the brush, and that face itself always.
    const cp = partOfId(centreId), ct = centreId - cp.idBase - 1;
    triOf(cp, ct);
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectTriangle(tri.a, tri.b, tri.c, false, hitAt)) tri.getMidpoint(hitAt);
    const reach = 3 * radiusCss * ((2 * camera.position.distanceTo(hitAt) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / rect.height);
    seen.forEach((set, p) => {
      set.forEach((t) => {
        if (p === cp && t === ct) return;
        triOf(p, t).closestPointToPoint(hitAt, near);
        if (near.distanceTo(hitAt) > reach) set.delete(t);
      });
    });
    return seen;
  }
  function paintTris(p, tris, which) {
    const reg = which ? REGIONS.find((q) => q.id === which) : null;
    let changed = 0;
    tris.forEach((t) => {
      if (p.region[t] === which) return;
      p.region[t] = which;
      changed++;
      for (let k = 0; k < 3; k++) {
        const o = t * 12 + k * 4;
        if (reg) { p.colors[o] = reg.rgb[0] / 255; p.colors[o + 1] = reg.rgb[1] / 255; p.colors[o + 2] = reg.rgb[2] / 255; p.colors[o + 3] = 0.78; }
        else p.colors[o + 3] = 0;
      }
    });
    if (changed) p.overlay.geometry.getAttribute("color").needsUpdate = true;
    return changed;
  }
  const whichOf = (name) => (name === "erase" ? 0 : REGIONS.find((r) => r.key === name).id);
  function brushAt(clientX, clientY, name) {
    const seen = seenUnder(clientX, clientY, Number(size.value) / 2);
    if (!seen) return 0;
    let changed = 0;
    seen.forEach((set, p) => { changed += paintTris(p, set, whichOf(name)); });
    if (changed) { dirty = true; syncSoon(); }
    return changed;
  }
  let syncQueued = false;
  function syncSoon() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; sync(); });
  }
  let strokeId = null, lastX = 0, lastY = 0, pending = null;
  const touches = new Set();
  function strokeTo(px, py) {
    const gap = Math.max(3, Number(size.value) * 0.25);
    const steps = Math.min(12, Math.max(1, Math.ceil(Math.hypot(px - lastX, py - lastY) / gap)));
    for (let i = 1; i <= steps; i++) brushAt(lastX + ((px - lastX) * i) / steps, lastY + ((py - lastY) * i) / steps, tool);
    lastX = px; lastY = py;
  }
  function beginStroke(id, px, py) {
    strokeId = id; lastX = px; lastY = py;
    try { canvas.setPointerCapture(id); } catch { /* the moves still arrive */ }
    brushAt(px, py, tool);
  }
  function endStroke(e) {
    if (e && e.pointerType === "touch") touches.delete(e.pointerId);
    if (pending && (!e || pending.id === e.pointerId)) {
      // A quick tap with one finger is a dot of paint.
      clearTimeout(pending.timer);
      const tap = pending; pending = null;
      if (e && e.type === "pointerup" && touches.size === 0) brushAt(tap.x, tap.y, tool);
    }
    if (!e || e.pointerId === strokeId) strokeId = null;
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") {
      touches.add(e.pointerId);
      // A second finger is a pinch or a turn, never paint: whatever was waiting to paint is dropped.
      if (touches.size > 1) { if (pending) { clearTimeout(pending.timer); pending = null; } strokeId = null; return; }
    }
    if (tool === "turn" || e.button !== 0 || busy || !model || failed) return;
    if (e.pointerType === "touch") {
      const id = e.pointerId;
      pending = { id, x: e.clientX, y: e.clientY, timer: setTimeout(() => { const p = pending; pending = null; if (p && touches.size === 1) beginStroke(id, p.x, p.y); }, 110) };
      return;
    }
    beginStroke(e.pointerId, e.clientX, e.clientY);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pending && pending.id === e.pointerId) { pending.x = e.clientX; pending.y = e.clientY; return; }
    if (strokeId === e.pointerId && touches.size <= 1 && !busy) strokeTo(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  // ── The areas and what to do with them ──
  const PICKS = ["Make it see-through glass", "Make it black", "Make it shiny metal", "Remove it"];
  function counts() {
    const n = {};
    REGIONS.forEach((r) => (n[r.id] = 0));
    parts.forEach((p) => { for (let t = 0; t < p.triCount; t++) if (p.region[t]) n[p.region[t]]++; });
    return n;
  }
  function sync() {
    if (closed) return;
    const n = counts();
    side.innerHTML = "";
    Object.keys(areaEls).forEach((k) => delete areaEls[k]);
    const any = REGIONS.some((r) => n[r.id]);
    if (!any) side.appendChild(el("p", "mp-empty", failed ? "" : "Paint an area with the red brush (and another with the blue one, if you like). Then say here how each should change — only the painted parts will."));
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
      ta.disabled = busy;
      ta.setAttribute("aria-label", `How should the ${r.name.toLowerCase()} area change?`);
      ta.dataset.region = r.key;
      ta.addEventListener("input", () => { asks[r.id] = ta.value; syncApply(); });
      const note = el("p", "mp-note");
      note.setAttribute("aria-live", "polite");
      const picks = el("div", "mp-picks");
      PICKS.forEach((p) => {
        const b = el("button", "", p);
        b.type = "button";
        b.disabled = busy;
        b.onclick = () => { ta.value = p; asks[r.id] = p; syncApply(); };
        picks.appendChild(b);
      });
      area.append(t, ta, note, picks);
      side.appendChild(area);
      areaEls[r.id] = { ta, note };
    });
    syncApply();
  }
  function syncApply() {
    if (closed) return;
    const n = counts();
    const painted = REGIONS.filter((r) => n[r.id]);
    const missing = painted.filter((r) => !String(asks[r.id] || "").trim());
    const planned = planEdits(false);
    painted.forEach((r) => {
      const a = areaEls[r.id];
      if (!a) return;
      const want = readInstruction(asks[r.id] || "");
      const doing = describeInstruction(want);
      const calls = want.kind === "repaint" ? planned.groups.filter((g) => g.region === r && g.op === "repaint").length : 0;
      const stamp = want.kind + "|" + doing + "|" + calls;
      if (a.note.dataset.said === stamp) return;
      a.note.dataset.said = stamp;
      a.note.textContent = "";
      if (want.kind === "repaint") {
        a.note.append(document.createTextNode(doing + " "), el("b", "", calls ? `Uses ${calls} picture generation${calls === 1 ? "" : "s"}.` : "Uses picture generations."), document.createTextNode(" To take the part off instead, say “remove it”."));
      } else a.note.textContent = doing;
    });
    const repaints = planned.groups.filter((g) => g.op === "repaint").length;
    apply.textContent = repaints ? `Make the changes (uses ${repaints} picture generation${repaints === 1 ? "" : "s"})` : "Make the changes";
    apply.disabled = busy || !!failed || !painted.length || !!missing.length;
    if (busy) return;
    status.textContent = !painted.length ? "" : missing.length ? `Say how the ${missing.map((r) => r.name.toLowerCase()).join(" and ")} area should change (or erase its paint).`
      : repaints ? `The picture maker repaints, so this uses ${repaints} picture generation${repaints === 1 ? "" : "s"} from your plan. Only the painted parts will change.`
        : "Only the painted parts will change. The original stays on your board.";
  }

  // ── What the instructions mean for the file: one edit per (part, colour) ──
  const J = () => source.json;
  const primOf = (p) => { const m = J().meshes && J().meshes[p.assoc.mesh]; return m && m.primitives && m.primitives[p.assoc.prim]; };
  const matOf = (prim) => (prim && prim.material !== undefined && J().materials ? J().materials[prim.material] : null);
  const imageOf = (texIndex) => {
    const t = J().textures && J().textures[texIndex];
    if (!t) return undefined;
    if (t.source !== undefined) return t.source;
    for (const k of Object.keys(t.extensions || {})) if (t.extensions[k] && t.extensions[k].source !== undefined) return t.extensions[k].source;
    return undefined;
  };
  const facesOf = (p, id) => { const out = []; for (let t = 0; t < p.triCount; t++) if (p.region[t] === id) out.push(t); return out; };
  const uvName = (map) => (map.channel ? "uv" + map.channel : "uv");
  /**
   * What each painted colour will do to each part it touches. errors: reasons it cannot be done (said
   * before anything is spent or changed); groups: the texture copies to make (one picture-maker call
   * each, for a repaint).
   */
  function planEdits(strict) {
    const edits = [], errors = [], groups = [];
    if (!source) return { edits, errors, groups };
    const groupFor = (key, make) => { let g = groups.find((q) => q.key === key); if (!g) { g = make(); g.key = key; g.edits = []; groups.push(g); } return g; };
    for (const r of REGIONS) {
      const words = String(asks[r.id] || "").trim();
      if (!words) continue;
      const want = readInstruction(words);
      const nm = r.name.toLowerCase();
      if (want.kind === "none") { if (parts.some((q) => facesOf(q, r.id).length)) errors.push(`Say how the ${nm} area should change.`); continue; }
      for (const p of parts) {
        const faces = facesOf(p, r.id);
        if (!faces.length) continue;
        const prim = p.assoc.mesh !== undefined ? primOf(p) : null;
        if (!prim) { errors.push(`The ${nm} area touches a part that could not be matched to the file, so it cannot be changed.`); continue; }
        const matDef = matOf(prim);
        const pbr = (matDef && matDef.pbrMetallicRoughness) || {};
        const e = { part: p, region: r, want, words, faces, prim, matDef, base: null, mr: null, mrMode: "" };
        const m3 = Array.isArray(p.mesh.material) ? p.mesh.material[0] : p.mesh.material;
        const tex = (info, map, what) => {
          if (!info) return null;
          const image = imageOf(info.index);
          if (image === undefined || !map || !map.image || map.isCompressedTexture || !sizeOf(map.image).w) { errors.push(`The ${nm} area's ${what} could not be read, so it cannot be changed.`); return false; }
          if (sizeOf(map.image).w * sizeOf(map.image).h > MAX_TEXELS) { errors.push(`The ${nm} area's ${what} is too large to edit here.`); return false; }
          if (!p.mesh.geometry.getAttribute(uvName(map))) { errors.push(`The ${nm} area's ${what} has no texture coordinates on this part, so it cannot be changed.`); return false; }
          return { texIndex: info.index, image, map };
        };
        if (want.kind === "repaint") {
          if (!pbr.baseColorTexture) { errors.push(`The ${nm} area has no texture to repaint (this model is coloured with plain materials). Say a colour, “glass”, “shiny”, “matte” or “remove it” instead.`); continue; }
          e.base = tex(pbr.baseColorTexture, m3 && m3.map, "texture");
          if (e.base === false) continue;
          groupFor(`${r.id}|repaint|base|${e.base.image}`, () => ({ region: r, op: "repaint", role: "base", image: e.base.image, words, map: e.base.map })).edits.push(e);
        } else if (want.kind === "look") {
          if (want.colour && pbr.baseColorTexture) {
            e.base = tex(pbr.baseColorTexture, m3 && m3.map, "texture");
            if (e.base === false) continue;
            groupFor(`${r.id}|recolour|base|${e.base.image}`, () => ({ region: r, op: "recolour", role: "base", image: e.base.image, hex: want.colour, map: e.base.map })).edits.push(e);
          }
          const finish = want.metalness !== null || want.roughness !== null;
          if (finish) {
            const ext = (matDef && matDef.extensions) || {};
            if (ext.KHR_materials_unlit || ext.KHR_materials_pbrSpecularGlossiness) { errors.push(`The ${nm} area cannot be made shiny or matte: ${FINISH_NOT}.`); continue; }
            if (pbr.metallicRoughnessTexture) {
              if (want.metalness !== null && want.roughness !== null) e.mrMode = "drop";
              else {
                e.mr = tex(pbr.metallicRoughnessTexture, m3 && m3.roughnessMap, "finish map");
                if (e.mr === false) continue;
                e.mrMode = want.roughness !== null ? "rough" : "metal";
                groupFor(`${r.id}|${e.mrMode}|mr|${e.mr.image}`, () => ({ region: r, op: e.mrMode, role: "mr", image: e.mr.image, channel: e.mrMode === "rough" ? 1 : 2, map: e.mr.map })).edits.push(e);
              }
            }
          }
        }
        edits.push(e);
      }
    }
    if (strict && !edits.length && !errors.length) errors.push("Paint an area first.");
    return { edits, errors: Array.from(new Set(errors)), groups };
  }

  // ── Making the changes ──
  const guard = () => { if (cancelled || closed) throw new Stopped(); };
  async function lockdownOn() {
    if (opts.privacy) { try { return (await opts.privacy()) === "lockdown"; } catch { return false; } }
    try { if (window.bzPrivacy && window.bzPrivacy() === "lockdown") return true; } catch { /* not on a page with the control */ }
    try {
      const r = await fetch("/api/buzzy/privacy", { credentials: "same-origin", signal: ctl.signal });
      const j = await r.json();
      return j && j.mode === "lockdown";
    } catch { return false; }     // the server enforces it too: this is only the early, friendly no
  }
  async function doApply() {
    if (busy || closed || !model || failed) return null;
    const planned = planEdits(true);
    if (planned.errors.length) { say(planned.errors[0]); return null; }
    const painted = REGIONS.filter((r) => counts()[r.id]);
    const unsaid = painted.filter((r) => !String(asks[r.id] || "").trim());
    if (unsaid.length) { say(`Say how the ${unsaid[0].name.toLowerCase()} area should change (or erase its paint).`); return null; }
    busy = true; cancelled = false;
    syncTools(); sync();
    const repaints = planned.groups.filter((g) => g.op === "repaint").length;
    try {
      guard();
      if (repaints && (await lockdownOn())) throw new Refusal(LOCKDOWN_SAYS);
      guard();
      const regionsDone = painted.map((r) => ({ region: r, words: String(asks[r.id]).trim(), kind: readInstruction(asks[r.id]).kind }));
      if (opts.canPlace) { const why = opts.canPlace(1 + regionsDone.length * 2); if (why) throw new Refusal(why); }
      const views = snapshots(regionsDone.map((d) => d.region));      // the painted areas as they are now
      const bytes = await build(planned);
      guard();
      say("Checking the changed model…");
      const parsed = await parseGltf(bytes);
      const glb = readGlb(bytes);
      guard();
      say("Saving the changed model…");
      const save = opts.save || defaultSave;
      const stamp = Date.now();
      const saved = await save(bytes, "model-changed-" + stamp + ".glb", "model/gltf-binary", { signal: ctl.signal });
      guard();
      // The pictures of the painted areas go to the Library too, so the board can show each. The model is
      // what matters: a picture that cannot be saved is left out, not a reason to lose the model.
      const pictures = [];
      for (const v of views) {
        guard();
        try {
          const pic = await save(dataUrlBytes(v.dataUrl), `painted-${v.region.key}-${stamp}.png`, "image/png", { signal: ctl.signal });
          if (pic && pic.url) pictures.push({ region: v.region, url: pic.url });
        } catch { /* the picture is a help */ }
      }
      guard();
      const result = {
        saved, bytes,
        done: regionsDone.map((d) => Object.assign(d, { pictureUrl: (pictures.find((q) => q.region === d.region) || {}).url || null })),
        pictures,
        pictureUrl: pictures.length ? pictures[0].url : null,
      };
      const placed = opts.place ? await opts.place(result) : true;
      if (placed === false) throw new Refusal("The changed model was saved to your Library, but it could not be put on the board. Make room on the board and press the button again; your paint is still here.");
      // Done: the painter now shows what was saved, so what you see is what is in the file.
      dirty = false;
      Object.keys(asks).forEach((k) => delete asks[k]);
      repaintCache.clear();
      if (!closed) {
        await install(parsed, glb, bytes, false);
        setTool("turn");
      } else disposeTree(parsed.scene);
      busy = false;
      syncTools(); sync();
      say("Done — the changed model is on your board, next to the original. You can paint more on it, or close this.");
      return result;
    } catch (e) {
      busy = false;
      const why = e instanceof Stopped ? "" : e instanceof Refusal ? e.message
        : `The changes could not be made: ${whyOf(e)}. Nothing was changed; your paint is still here, so you can try again.`;
      if (!closed) { syncTools(); sync(); if (why) say(why); }
      return null;
    }
  }
  apply.onclick = () => { doApply(); };

  /** The painted areas as a picture each, seen from outside, so a note never speaks about an area nobody can see. */
  function snapshots(list) {
    const out = [];
    const bb = new THREE.Box3().setFromObject(model);
    const centre = bb.getCenter(new THREE.Vector3());
    const radius = Math.max(bb.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (const r of list) {
      const sum = new THREE.Vector3(), facing = new THREE.Vector3();
      let count = 0;
      for (const p of parts) {
        for (let t = 0; t < p.triCount; t++) {
          if (p.region[t] !== r.id) continue;
          a.fromArray(p.world, t * 9); b.fromArray(p.world, t * 9 + 3); c.fromArray(p.world, t * 9 + 6);
          sum.add(a).add(b).add(c);
          facing.add(b.clone().sub(a).cross(c.clone().sub(a)));
          count += 3;
        }
      }
      if (!count) continue;
      const at = sum.divideScalar(count);
      let dir = at.clone().sub(centre);
      if (dir.length() < radius * 0.2) dir = facing.lengthSq() > 1e-12 ? facing : new THREE.Vector3(0, 0, 1);
      dir.normalize();
      const cam = camera.clone();
      cam.position.copy(at).addScaledVector(dir, radius * 1.8);
      cam.up.set(0, Math.abs(dir.y) > 0.95 ? 0 : 1, Math.abs(dir.y) > 0.95 ? 1 : 0);
      cam.lookAt(at);
      cam.near = radius / 100; cam.far = radius * 100;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      renderer.render(scene, cam);
      const small = document.createElement("canvas");
      const k = Math.min(1, 900 / canvas.width);
      small.width = Math.max(1, Math.round(canvas.width * k)); small.height = Math.max(1, Math.round(canvas.height * k));
      small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
      out.push({ region: r, dataUrl: small.toDataURL("image/png") });
    }
    renderer.render(scene, camera);
    return out;
  }

  /** The pixels of the texture the painted faces cover, as a mask the size of the texture. */
  function textureMask(p, faces, map, w, hgt) {
    const uv = p.mesh.geometry.getAttribute(uvName(map));
    if (!uv) return null;
    map.updateMatrix();
    const c = document.createElement("canvas");
    c.width = w; c.height = hgt;
    const k = c.getContext("2d");
    k.fillStyle = "#fff"; k.strokeStyle = "#fff";
    k.lineWidth = 2;        // a little over the edge, so no seam of old colour is left
    k.lineJoin = "round";
    const uvp = new THREE.Vector2();
    const corner = [[0, 0], [0, 0], [0, 0]];
    const repeat = (wrap) => wrap === THREE.RepeatWrapping || wrap === THREE.MirroredRepeatWrapping;
    let any = false;
    for (const t of faces) {
      for (let j = 0; j < 3; j++) {
        const vi = p.v(t, j);
        uvp.set(uv.getX(vi), uv.getY(vi)).applyMatrix3(map.matrix);
        corner[j][0] = uvp.x * w; corner[j][1] = (map.flipY ? 1 - uvp.y : uvp.y) * hgt;     // glTF: (0,0) is the image's top-left
      }
      const minX = Math.min(corner[0][0], corner[1][0], corner[2][0]), maxX = Math.max(corner[0][0], corner[1][0], corner[2][0]);
      const minY = Math.min(corner[0][1], corner[1][1], corner[2][1]), maxY = Math.max(corner[0][1], corner[1][1], corner[2][1]);
      const i0 = repeat(map.wrapS) ? Math.floor(minX / w) : 0, i1 = repeat(map.wrapS) ? Math.floor(maxX / w) : 0;
      const j0 = repeat(map.wrapT) ? Math.floor(minY / hgt) : 0, j1 = repeat(map.wrapT) ? Math.floor(maxY / hgt) : 0;
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 16) { k.fillRect(0, 0, w, hgt); any = true; continue; }     // covers the picture over and over
      for (let jj = j0; jj <= j1; jj++) {
        for (let ii = i0; ii <= i1; ii++) {
          k.beginPath();
          for (let q = 0; q < 3; q++) {
            let px = corner[q][0], py = corner[q][1];
            if (repeat(map.wrapS)) px = map.wrapS === THREE.MirroredRepeatWrapping && (ii & 1) ? (ii + 1) * w - px : px - ii * w;
            if (repeat(map.wrapT)) py = map.wrapT === THREE.MirroredRepeatWrapping && (jj & 1) ? (jj + 1) * hgt - py : py - jj * hgt;
            if (q === 0) k.moveTo(px, py); else k.lineTo(px, py);
          }
          k.closePath();
          k.fill();
          k.stroke();
          any = true;
        }
      }
    }
    if (!any) return null;
    const d = k.getImageData(0, 0, w, hgt).data;
    const m = new Uint8ClampedArray(w * hgt);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] ? 255 : 0;
    return m;
  }
  const repaintCache = new Map();
  /** One group's copy of its texture, with the change made in the painted pixels only; as encoded bytes. */
  async function editTexture(g) {
    const img = g.map.image;
    const { w, h: hgt } = sizeOf(img);
    const c = document.createElement("canvas");
    c.width = w; c.height = hgt;
    const k = c.getContext("2d");
    k.drawImage(img, 0, 0);
    const mask = new Uint8ClampedArray(w * hgt);
    for (const e of g.edits) {
      const m = textureMask(e.part, e.faces, g.role === "mr" ? e.mr.map : e.base.map, w, hgt);
      if (m) for (let i = 0; i < m.length; i++) if (m[i] > mask[i]) mask[i] = m[i];
    }
    if (!mask.some((v) => v)) throw new Error("the painted faces do not cover any of the texture");
    if (g.op === "recolour" || g.op === "rough" || g.op === "metal") {
      const px = k.getImageData(0, 0, w, hgt);
      if (g.op === "recolour") recolourPixels(px.data, mask, g.hex); else fillChannel(px.data, mask, g.channel, 255);
      k.putImageData(px, 0, 0);
    } else await repaintInto(g, c, mask);
    const mime = g.map.userData && g.map.userData.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise((resolve) => c.toBlob(resolve, mime, 0.92));
    if (!blob) throw new Error("the changed texture could not be saved");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
  }
  /** Only the painted pixels of the picture maker's repaint go back into the texture. */
  async function repaintInto(g, c, mask) {
    const w = c.width;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const xx = i % w, yy = (i - xx) / w; if (xx < x0) x0 = xx; if (yy < y0) y0 = yy; if (xx > x1) x1 = xx; if (yy > y1) y1 = yy; }
    const pad = 24;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const crop = document.createElement("canvas"); crop.width = cw; crop.height = ch;
    crop.getContext("2d").drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
    const mk = document.createElement("canvas"); mk.width = cw; mk.height = ch;
    const mctx = mk.getContext("2d");
    const mimg = mctx.createImageData(cw, ch);
    for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
      const v = mask[(y0 + yy) * w + (x0 + xx)] ? 255 : 0;
      const o = (yy * cw + xx) * 4;
      mimg.data[o] = mimg.data[o + 1] = mimg.data[o + 2] = v; mimg.data[o + 3] = 255;
    }
    mctx.putImageData(mimg, 0, 0);
    const cropUrl = crop.toDataURL("image/png"), maskUrl = mk.toDataURL("image/png");
    // Asked once per distinct piece: a retry after a failure later on does not buy it again.
    const key = [g.words, g.image, x0, y0, cw, ch, cropUrl.length, maskUrl.length, cropUrl.slice(-64), maskUrl.slice(-64)].join("|");
    let url = repaintCache.get(key);
    if (!url) {
      const repaint = opts.repaint || defaultRepaint;
      say(`Asking the picture maker to repaint the ${g.region.name.toLowerCase()} area…`);
      url = await repaint({ crop: cropUrl, mask: maskUrl, instruction: g.words }, { signal: ctl.signal });
      usedRepaints++;
      repaintCache.set(key, url);
    }
    guard();
    const back = await loadImage(url);
    const tmp = document.createElement("canvas"); tmp.width = cw; tmp.height = ch;
    tmp.getContext("2d").drawImage(back, 0, 0, cw, ch);
    const fresh = tmp.getContext("2d").getImageData(0, 0, cw, ch).data;
    const k = c.getContext("2d");
    const img = k.getImageData(x0, y0, cw, ch);
    for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
      if (!mask[(y0 + yy) * w + (x0 + xx)]) continue;    // outside the paint: untouched
      const o = (yy * cw + xx) * 4;
      img.data[o] = fresh[o]; img.data[o + 1] = fresh[o + 1]; img.data[o + 2] = fresh[o + 2];
    }
    k.putImageData(img, x0, y0);
  }

  /** The patched file for the planned edits. Pure of the open model: nothing here changes what is on screen. */
  async function build(planned) {
    const patch = new GlbPatch(source);
    const json = patch.json;
    // The texture copies first (the only part that can take time): one image per group, with a
    // texture of its own for each texture it replaces, sampled the way that texture was.
    for (const g of planned.groups) {
      guard();
      say(g.op === "repaint" ? `Repainting the ${g.region.name.toLowerCase()} area…` : `Changing the ${g.region.name.toLowerCase()} area's texture…`);
      const made = await editTexture(g);
      guard();
      g.imageIndex = patch.addImage(made.bytes, made.mime, `${g.role === "mr" ? "finish" : "texture"} (${g.region.key} area)`);
      g.textures = new Map();
    }
    const retex = (g, info) => {
      const out = copyOf(info);
      if (!g.textures.has(info.index)) g.textures.set(info.index, patch.addTexture(g.imageIndex, json.textures[info.index].sampler, `${g.role} (${g.region.key} area)`));
      out.index = g.textures.get(info.index);
      return out;
    };
    const groupOf = (e, role, op) => planned.groups.find((g) => g.role === role && g.edits.includes(e) && (!op || g.op === op));
    const matCache = new Map();
    const materialFor = (e) => {
      const key = `${e.region.id}|${e.prim.material}|${e.want.kind}`;
      if (matCache.has(key)) return matCache.get(key);
      const want = e.want;
      let def;
      if (want.kind === "glass") {
        def = { name: `Glass (${e.region.key} area)`, pbrMetallicRoughness: { baseColorFactor: [...linear(want.colour), want.opacity], metallicFactor: 0.1, roughnessFactor: 0.05 }, alphaMode: "BLEND", doubleSided: true };
      } else {
        def = copyOf(e.matDef || {});
        def.name = `${def.name || "Material"} (${e.region.key} area)`;
        const pbr = def.pbrMetallicRoughness = def.pbrMetallicRoughness || {};
        const alpha = want.opaque ? 1 : pbr.baseColorFactor && pbr.baseColorFactor[3] !== undefined ? pbr.baseColorFactor[3] : 1;
        if (want.kind === "repaint") {
          pbr.baseColorTexture = retex(groupOf(e, "base", "repaint"), pbr.baseColorTexture);
        } else {
          if (want.opaque) { delete def.alphaMode; delete def.alphaCutoff; if (pbr.baseColorFactor) pbr.baseColorFactor[3] = 1; }
          if (want.colour) {
            if (pbr.baseColorTexture) { pbr.baseColorTexture = retex(groupOf(e, "base", "recolour"), pbr.baseColorTexture); pbr.baseColorFactor = [1, 1, 1, alpha]; }
            else pbr.baseColorFactor = [...linear(want.colour), alpha];
          }
          if (want.metalness !== null) pbr.metallicFactor = want.metalness;
          if (want.roughness !== null) pbr.roughnessFactor = want.roughness;
          if (e.mrMode === "drop") delete pbr.metallicRoughnessTexture;
          else if (e.mrMode) pbr.metallicRoughnessTexture = retex(groupOf(e, "mr"), pbr.metallicRoughnessTexture);
        }
      }
      const index = patch.addMaterial(def);
      matCache.set(key, index);
      return index;
    };
    // Per node: its primitives, with the painted faces moved to primitives of their own.
    const byNode = new Map();
    parts.forEach((p) => { if (p.assoc.node !== undefined) { if (!byNode.has(p.assoc.node)) byNode.set(p.assoc.node, []); byNode.get(p.assoc.node).push(p); } });
    for (const [node, nodeParts] of byNode) {
      guard();
      if (!nodeParts.some((p) => planned.edits.some((e) => e.part === p))) continue;
      // Every part must sit where the file says it does, or nothing is written (never a change to the wrong node).
      if (json.nodes[node].mesh === undefined || nodeParts.some((p) => p.assoc.mesh !== json.nodes[node].mesh)) throw new Error("a part of the model did not match its place in the file");
      const meshDef = json.meshes[json.nodes[node].mesh];
      const out = [];
      meshDef.primitives.forEach((prim, j) => {
        const p = nodeParts.find((q) => q.assoc.prim === j);
        const mine = p ? planned.edits.filter((e) => e.part === p) : [];
        if (!mine.length) { out.push(prim); return; }
        const owner = new Int16Array(p.triCount).fill(-1);
        mine.forEach((e, i) => e.faces.forEach((t) => { owner[t] = i; }));
        const kept = [], per = mine.map(() => []);
        for (let t = 0; t < p.triCount; t++) {
          const into = owner[t] < 0 ? kept : per[owner[t]];
          into.push(p.v(t, 0), p.v(t, 1), p.v(t, 2));
        }
        if ((kept.length + per.reduce((s, l) => s + l.length, 0)) / 3 !== p.triCount) throw new Error("the faces did not add up");
        const baseOf = () => { const q = copyOf(prim); if (q.mode !== undefined && q.mode !== 4) q.mode = 4; return q; };
        if (kept.length) { const q = baseOf(); q.indices = patch.addIndices(kept); out.push(q); }
        mine.forEach((e, i) => {
          if (e.want.kind === "remove" || !per[i].length) return;
          const q = baseOf();
          q.indices = patch.addIndices(per[i]);
          q.material = materialFor(e);
          // A colour that is asked for is the colour, not the colour times what the vertices carried.
          if (e.want.kind === "glass" || (e.want.kind === "look" && e.want.colour)) Object.keys(q.attributes).forEach((a) => { if (/^COLOR_\d+$/.test(a)) delete q.attributes[a]; });
          out.push(q);
        });
      });
      patch.setNodePrimitives(node, out);
    }
    return patch.bytes();
  }

  async function defaultSave(bytes, name, type, o) {
    const r = await fetch("/api/buzzy/assets", { method: "POST", credentials: "same-origin", headers: { "content-type": type || "model/gltf-binary", "x-bz-path": name }, body: bytes, signal: o && o.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "the changed model could not be saved");
    return { id: j.id, url: "/api/buzzy/assets/" + j.id, name };
  }
  async function defaultRepaint(req, o) {
    const r = await fetch("/api/buzzy/art", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "repaint3d", crop: req.crop, mask: req.mask, instruction: req.instruction }), signal: o && o.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.image) throw new Error(j.error || "the picture maker did not repaint it");
    return j.image;
  }

  // ── For tests and the page ──
  function makeHandle() {
    return {
      close,
      apply: doApply,
      state: () => ({ loaded: !!model, failed, busy, closed, parts: parts.length, faces: parts.reduce((s, p) => s + p.triCount, 0), counts: closed ? {} : counts(), dirty, tool, repaints: usedRepaints }),
      /** Paint at a point of the screen (the brush's own path): what shows there is painted. Returns the faces changed. */
      paintAt(clientX, clientY, which) { if (closed || !model) return 0; setTool(which); return brushAt(clientX, clientY, which); },
      /** Paint every face within `radius` of a point on the model (world units), seen or not. */
      paintWorld(px, py, pz, which, radius) {
        if (closed || !model) return 0;
        const id = whichOf(which), rr = radius * radius;
        let nn = 0;
        for (const p of parts) {
          const tris = [];
          for (let t = 0; t < p.triCount; t++) {
            const o = t * 9;
            const cx = (p.world[o] + p.world[o + 3] + p.world[o + 6]) / 3 - px, cy = (p.world[o + 1] + p.world[o + 4] + p.world[o + 7]) / 3 - py, cz = (p.world[o + 2] + p.world[o + 5] + p.world[o + 8]) / 3 - pz;
            if (cx * cx + cy * cy + cz * cz <= rr) tris.push(t);
          }
          nn += paintTris(p, tris, id);
        }
        if (nn) { dirty = true; sync(); }
        return nn;
      },
      ask(which, words) { const r = REGIONS.find((q) => q.key === which); asks[r.id] = words; sync(); },
      /** The parts of the model and how many of each one's faces are painted. */
      parts: () => parts.map((p) => ({ name: p.mesh.name, faces: p.triCount, painted: p.region.reduce((n, r) => n + (r ? 1 : 0), 0) })),
      /** Where a point of the model is on the screen (client pixels). */
      screenOf(px, py, pz) {
        camera.updateMatrixWorld();
        const v = new THREE.Vector3(px, py, pz).project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
      },
      setView(cx, cy, cz, tx, ty, tz) {
        if (!controls) return;
        camera.position.set(cx, cy, cz);
        controls.target.set(tx, ty, tz);
        controls.update();
        camera.updateMatrixWorld();
        pickFresh = false;
      },
    };
  }
  await init();
  return makeHandle();
}
