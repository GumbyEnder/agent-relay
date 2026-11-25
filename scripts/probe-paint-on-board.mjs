// Paint changes on a 3D model card, on the real Talk page (testers, 2026-11-24: "paint on
// that three D model what you would like changed … link out a card that's blue or red").
//   0. Only a .glb model card offers Paint changes (an .obj card does not).
//   1. It opens the model and takes the keyboard: the board's Delete key does nothing behind it.
//   2. Paint with the red brush (real mouse drags on the model), say "make it black"; Esc while
//      dragging the window's edge takes the drag back and closes nothing; press "Make the changes".
//   3. The board gets the changed model beside the original (kept), a note "Red area" with what was
//      asked that wears the red brush's colour, a picture of the painted area, and — read from the
//      board's own saved state, not from words — the lines original → note → changed model and
//      picture → note. The saved file is the original with a patch on it (its picture byte for byte).
//   4. Painting again in the same window starts from the model just made: the next change is
//      linked from it.
//   5. The picture maker, through the REAL route with a stand-in for the provider (never a real key):
//      a repaint is made; a change that needs it twice with one generation left is refused before the
//      first is spent; Lockdown sends no file name to a model (the stand-in counts what reaches it).
//      A board put away while the picture maker works takes nothing: what was made stays in the Library
//      and the painter says so, keeping the paint.
//   6. A board with no room says so before anything is made; Lockdown refuses the picture maker
//      (on the page and on the server's own route) and a colour still works.
//   7. A board put away under the painter BEFORE Apply is said so before anything is made or saved.
// The stand-in provider is started by this script on BZ_PROBE_STANDIN_PORT; the server under test must
// have been started pointing at it (BZ_CHAT_BASE_URL=http://127.0.0.1:<port>/v1, BZ_CHAT_KEY=<anything
// that is not a real key>, BZ_DEFAULT_PLAN=starter). Without it sections 5 and 7 are skipped.
// usage: node scripts/probe-paint-on-board.mjs <origin>  (BZ_PROBE_CDP, BZ_MAIL_LOG as the other probes)
import http from "node:http";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";

// ── A stand-in for the model provider: counts what reaches it, answers an image request with a magenta picture ──
const STANDIN = Number(process.env.BZ_PROBE_STANDIN_PORT || 0);
const standin = { images: 0, chats: 0, delay: 0 };
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function pngOf(r, g, b) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, r, g, b]))), chunk("IEND", Buffer.alloc(0))]);
}
let standinServer = null;
if (STANDIN) {
  standinServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
      if (req.method === "POST" && /\/chat\/completions$/.test(req.url || "")) {
        res.writeHead(200, { "content-type": "application/json" });
        if (Array.isArray(body.modalities) && body.modalities.includes("image")) {
          standin.images++;
          setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done", images: [{ type: "image_url", image_url: { url: "data:image/png;base64," + pngOf(255, 0, 255).toString("base64") } }] } }] })), standin.delay || 0);
        } else {
          standin.chats++;
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ description: "a stand-in answer", tags: ["stand in"] }) } }] }));
        }
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => standinServer.listen(STANDIN, "127.0.0.1", r));
}

async function devSignIn() {
  const email = `probe-paint-${Date.now().toString(36)}@test.local`;
  const res = await fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, callbackURL: "/" }) });
  if (!res.ok) throw new Error(`magic-link request failed ${res.status}`);
  for (let i = 0; i < 30; i++) {
    if (existsSync(MAIL_LOG)) {
      for (const line of readFileSync(MAIL_LOG, "utf8").trim().split("\n").reverse()) {
        let mail; try { mail = JSON.parse(line); } catch { continue; }
        if (mail.to !== email) continue;
        const link = mail.actionUrl || (mail.text || "").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0];
        if (!link) continue;
        const v = await fetch(link.replace(/&amp;/g, "&").replace(/^https?:\/\/[^/]+/, ORIGIN), { redirect: "manual" });
        const cookie = (v.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.includes("session_token"));
        if (cookie) return cookie;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic-link mail for ${email}`);
}

const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
const eqAt = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP) : await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: cookie.slice(0, eqAt), value: cookie.slice(eqAt + 1), domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort());
let failures = 0;
const errors = [];
const dialogs = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failures++;
}
const J = (v) => JSON.stringify(v);

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#chatInput");
await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current());

// A model of theirs: a panel, left half olive, right half grey, made and saved here; and an .obj file.
const asset = await page.evaluate(async () => {
  const THREE = await import("/buzzy/vendor/three/three.module.min.js");
  const { GLTFExporter } = await import("/buzzy/vendor/three/addons/exporters/GLTFExporter.js");
  const c = document.createElement("canvas"); c.width = 256; c.height = 256;
  const k = c.getContext("2d");
  k.fillStyle = "#6b7a3a"; k.fillRect(0, 0, 128, 256);
  k.fillStyle = "#8a8a8a"; k.fillRect(128, 0, 128, 256);
  const tex = new THREE.CanvasTexture(c); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.PlaneGeometry(2, 2, 24, 24);
  const uv = geo.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex })));
  const bytes = new Uint8Array(await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true })));
  const up = async (body, name, type) => (await (await fetch("/api/buzzy/assets", { method: "POST", credentials: "same-origin", headers: { "content-type": type, "x-bz-path": name }, body })).json()).id;
  const id = await up(bytes, "tank-panel.glb", "model/gltf-binary");
  const objId = await up(new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), "turret.obj", "model/obj");
  const b = window.BeeZillaWhiteboard.current();
  b.addCard({ kind: "model", title: "Tank panel", url: "/api/buzzy/assets/" + id, contentType: "model/gltf-binary", user: true });
  b.addCard({ kind: "model", title: "Turret", url: "/api/buzzy/assets/" + objId, contentType: "model/obj", user: true });
  window.__original = Array.from(bytes);
  return id;
});
check("0. a 3D model card is on the board", Number(asset) > 0, String(asset));
const inertBefore = await page.evaluate(() => [...document.body.children].filter((n) => n.inert).length);
await page.waitForTimeout(800);

// 0. Only what the painter can open and save gets the button.
{
  // A 3D job's FBX copy lands on the board as a model card too (the quad mesh, for Blender): the painter reads only glTF.
  // Several shapes of such a card, and look-alikes that must still be offered. (Adding a card moves the view to it, so the
  // view is brought back to the Tank panel afterwards.)
  await page.evaluate(async (id) => {
    const fbx = await (await fetch("/api/buzzy/assets", { method: "POST", credentials: "same-origin", headers: { "content-type": "model/fbx", "x-bz-path": "model-1234abcd.fbx" }, body: new TextEncoder().encode("Kaydara FBX Binary  \0") })).json();
    const b = window.BeeZillaWhiteboard.current();
    [
      { title: "model-1234abcd.fbx", url: "/api/buzzy/assets/" + fbx.id, contentType: "model/fbx" },
      { title: "Robot FBX", url: "https://files.example/robot.fbx?token=1" },                                  // only its address says
      { title: "Quad robot", url: "/api/buzzy/assets/" + fbx.id, contentType: "application/x-fbx" },           // a type that is not glTF
      { title: "robot.glb", url: "/api/buzzy/assets/" + fbx.id, contentType: "model/fbx" },                    // the details contradict each other
      { title: "Gltf model", url: "/api/buzzy/assets/" + id, contentType: "model/gltf+json" },
      { title: "Plain type.glb", url: "/api/buzzy/assets/" + id, contentType: "application/octet-stream" },
    ].forEach((spec) => b.addCard({ kind: "model", user: true, ...spec }));
  }, asset);
  const cards = await page.$$eval(".wb-card.wb-k-model", (ns) => ns.map((n) => ({ name: n.querySelector(".wb-name").textContent, paint: !!n.querySelector(".wb-paint3d"), download: !!n.querySelector("a.wb-open") })));
  const has = (name) => (cards.find((c) => c.name === name) || {}).paint;
  check("0. a .glb model card has Paint changes, an .obj model card does not", cards.length === 8 && has("Tank panel") === true && has("Turret") === false, J(cards));
  check("0. an FBX model card (the 3D job's quad-mesh copy) is not offered Paint changes, whichever way it says so: its type, its name, its address, a type that is not glTF, or a name that says .glb against a type that says fbx", has("model-1234abcd.fbx") === false && has("Robot FBX") === false && has("Quad robot") === false && has("robot.glb") === false, J(cards));
  check("0. …it keeps its download, and a glTF type or a plain .glb name with a generic type is still offered", cards.filter((c) => /fbx|Quad|robot/i.test(c.name)).every((c) => c.download) && has("Gltf model") === true && has("Plain type.glb") === true, J(cards));
  await page.evaluate(() => window.BeeZillaWhiteboard.current().act({ value: "focus", target: "Tank panel" }));
  await page.waitForTimeout(900);
}

// 1. Paint changes.
const card = page.locator(".wb-card.wb-k-model", { hasText: "Tank panel" });
const btn = await card.locator(".wb-paint3d").elementHandle();
check("1. the model card has Paint changes", !!btn);
const label = btn ? await btn.evaluate((b) => ({ text: b.textContent, color: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor })) : null;
check("1. its label can be read (not yellow on yellow)", !!label && label.text === "Paint changes" && label.color !== label.bg, J(label));
await card.locator(".wb-name").click();                  // the card is selected: Delete would take it off the board
await btn.click();
await page.waitForSelector(".mp-dialog canvas", { timeout: 20000 });
await page.waitForFunction(() => /Pick the red or blue brush/.test(document.querySelector(".mp-hint")?.textContent || ""), null, { timeout: 20000 });
check("1. the model opens in the painter", true);
const modelCards = await page.locator(".wb-card.wb-k-model").count();
await page.keyboard.press("Delete");
await page.waitForTimeout(300);
check("1. the window has the keyboard: Delete does not take the selected card off the board behind it", (await page.locator(".wb-card.wb-k-model").count()) === modelCards && modelCards === 8 && (await page.evaluate(() => !!document.activeElement.closest(".mp-box"))));

// 2. Paint with the red brush: real drags over the middle-left of the model.
await page.click(".mp-tools button:nth-of-type(2)");
const box = await page.$eval(".mp-stage canvas", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const cx = box.x + box.w * 0.43, cy = box.y + box.h * 0.5;
await page.mouse.move(cx - 30, cy - 20);
await page.mouse.down();
for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 30 + i * 5, cy - 20 + i * 3);
await page.mouse.up();
await page.waitForSelector(".mp-area textarea");
const faces = await page.$eval(".mp-area .count", (n) => n.textContent);
check("2. the brush painted faces, and the red area asks how it should change", /\d+ faces/.test(faces), faces);
await page.fill(".mp-area textarea", "make it black");
check("2. what it will do is said under the words", /Recolours it black/.test(await page.textContent(".mp-note")), await page.textContent(".mp-note"));
// Esc while dragging the window's corner takes the drag back, and the painter (with its paint) is still there.
{
  const corner = await (await page.$(".mp-box .bz-rs-se")).boundingBox();
  const before = await page.$eval(".mp-box", (b) => b.offsetWidth);
  dialogs.length = 0;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 - 140, corner.y + corner.height / 2 - 100, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(150);
  check("2. Esc while dragging the window's edge takes the drag back and closes nothing (no question, paint kept)", (await page.$eval(".mp-box", (b) => b.offsetWidth)) === before && !!(await page.$(".mp-area textarea")) && dialogs.length === 0, J({ before, dialogs }));
}
if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-painted.png` });
await page.click(".mp-apply");
await page.waitForFunction(() => /Done — the changed model is on your board/.test(document.querySelector(".mp-status")?.textContent || ""), null, { timeout: 30000 });
check("2. the change is made", true);

// 3. On the board: read from the board's own saved state.
const boardState = () => page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("bz.board.")) continue;
    const v = JSON.parse(localStorage.getItem(k) || "null");
    if (v && Array.isArray(v.cards) && v.cards.some((c) => /\(changed\)/.test(c.title || ""))) return { cards: v.cards, links: v.links || [] };
  }
  return null;
});
await page.waitForFunction(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("bz.board.") && /\(changed\)/.test(localStorage.getItem(k) || "")) return true; } return false; }, null, { timeout: 10000 });
const b1 = await boardState();
const src = b1.cards.find((c) => c.title === "Tank panel"), made = b1.cards.find((c) => c.title === "Tank panel (changed)");
const note = b1.cards.find((c) => c.kind === "note" && c.title === "Red area"), pic = b1.cards.find((c) => c.kind === "image" && c.title === "The red area");
const has = (a, b) => !!(a && b && b1.links.some((l) => l.from === a.id && l.to === b.id));
check("3. the changed model is on the board, and the original is kept", !!src && !!made && src.id !== made.id && made.kind === "model" && src.url !== made.url, J(b1.cards.map((c) => c.title)));
check("3. a note for the red area says what was asked, and remembers its brush", !!note && note.body === "make it black" && note.region === "red", J(note));
check("3. a picture of the painted area is on the board", !!pic && /^\/api\/buzzy\/assets\/\d+/.test(pic.url), J(pic));
check("3. the saved lines run original → note → changed model", has(src, note) && has(note, made), J(b1.links.map((l) => [(b1.cards.find((c) => c.id === l.from) || {}).title, (b1.cards.find((c) => c.id === l.to) || {}).title])));
check("3. …and the picture feeds the note it explains", has(pic, note));
{
  const said = await page.evaluate(() => window.BeeZillaWhiteboard.current().instructions());
  check("3. the note's words are a record, not an instruction for the turns that follow: BeeZilla is told of them as “also on the board”, never as the person's own “Note —” line", /Also on the board:[\s\S]*- Note — Red area: make it black/.test(said) && !/^Note — make it black/m.test(said), said.slice(0, 500));
}
check("3. the note wears the red brush's colour on the board", await page.evaluate(() => { const n = document.querySelector(".wb-card.wb-k-note.wb-reg-red"); return !!n && !!n.querySelector(".wb-regdot") && /Red area/.test(n.textContent) && getComputedStyle(n).borderLeftColor !== getComputedStyle(n).borderTopColor; }));
{
  const got = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url, { credentials: "same-origin" })).arrayBuffer());
    const { readGlb } = await import("/buzzy/glb-patch.js");
    const { json, bin } = readGlb(bytes);
    const was = readGlb(new Uint8Array(window.__original));
    const img = (g, i) => { const v = g.json.bufferViews[g.json.images[i].bufferView]; return Array.from(g.bin.slice(v.byteOffset, v.byteOffset + v.byteLength)).join(); };
    const faces = (p) => (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3;
    return { prims: json.meshes[0].primitives.map(faces), images: json.images.length, same: img(was, 0) === img({ json, bin }, 0), glb: String.fromCharCode(...bytes.slice(0, 4)) };
  }, made.url);
  check("3. the saved model is a real .glb that comes back from the Library: the painted faces in a primitive of their own, the original picture byte for byte", got.glb === "glTF" && got.prims.length === 2 && got.prims[0] + got.prims[1] === 1152 && got.images === 2 && got.same, J(got));
}
if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-board-after.png` });

// 4. Painting again, in the same window: it shows the new model, and the next change starts from it.
check("4. the window now shows the changed model (two parts), ready to be painted again", await page.evaluate(() => /Drag to turn/.test(document.querySelector(".mp-hint")?.textContent || "")));
await page.click(".mp-tools button:nth-of-type(3)");
await page.mouse.move(cx + 120, cy);
await page.mouse.down();
for (let i = 0; i <= 10; i++) await page.mouse.move(cx + 120 + i * 5, cy + i * 3);
await page.mouse.up();
await page.waitForSelector(".mp-area textarea");
await page.fill(".mp-area textarea", "remove it");
await page.click(".mp-apply");
await page.waitForFunction(() => /Done — the changed model is on your board/.test(document.querySelector(".mp-status")?.textContent || ""), null, { timeout: 30000 });
await page.waitForFunction(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("bz.board.") && /Blue area/.test(localStorage.getItem(k) || "")) return true; } return false; }, null, { timeout: 10000 });
{
  const b2 = await page.evaluate(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("bz.board.") && /Blue area/.test(localStorage.getItem(k) || "")) { const v = JSON.parse(localStorage.getItem(k)); return { cards: v.cards, links: v.links }; } } return null; });
  const note2 = b2.cards.find((c) => c.title === "Blue area");
  const second = b2.cards.filter((c) => c.title === "Tank panel (changed)");
  const first = second.find((c) => c.id === made.id);
  const next = second.find((c) => c.id !== made.id);
  const linked = (a, b) => b2.links.some((l) => l.from === a.id && l.to === b.id);
  check("4. the second change is a new model card linked from the first changed model, through its blue note", second.length === 2 && !!note2 && note2.region === "blue" && linked(first, note2) && linked(note2, next), J(b2.cards.map((c) => c.title)));
}
await page.click(".mp-x");
await page.waitForTimeout(600);
check("4. ✕ closes the painter once the changes are made (nothing to lose), and the keyboard is back on the board", (await page.$(".mp-dialog")) === null && (await page.evaluate((n) => [...document.body.children].filter((x) => x.inert).length === n, inertBefore)) && dialogs.length === 0, J(dialogs));

// 5. The picture maker through the real route (a stand-in for the provider), the allowance, a board put away while it
//    works, and Lockdown's tagging.
const mountBoard = async () => {
  await page.waitForSelector("#chatInput");
  await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current());
};
const storedCards = () => page.evaluate(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("bz.board.")) { const v = JSON.parse(localStorage.getItem(k) || "null"); if (v && Array.isArray(v.cards) && v.cards.some((c) => /Tank panel/.test(c.title || ""))) return v.cards; } } return []; });
const changedModels = async () => (await storedCards()).filter((c) => /\(changed\)/.test(c.title || "")).map((c) => c.url);
const uploads = (list) => { const on = async (r) => { if (r.request().method() === "POST" && /\/api\/buzzy\/assets(\?|$)/.test(r.url())) list.push(await r.json().catch(() => ({}))); }; page.on("response", on); return () => page.off("response", on); };
if (!STANDIN) console.log("SKIP  5. (no stand-in provider: BZ_PROBE_STANDIN_PORT is not set)");
if (STANDIN) {
  const ready = () => page.waitForFunction(() => /Pick the red or blue brush|Drag to turn/.test(document.querySelector(".mp-hint")?.textContent || ""), null, { timeout: 20000 });
  const openOn = async (label) => { await page.locator(".wb-card.wb-k-model", { hasText: label }).first().locator(".wb-paint3d").evaluate((b) => b.click()); await ready(); };
  const stroke = async (nth, dx = 0, dy = 0) => {
    await page.click(`.mp-tools button:nth-of-type(${nth})`);
    const g = await page.$eval(".mp-stage canvas", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const x = g.x + g.w * 0.43 + dx, y = g.y + g.h * 0.5 + dy;
    await page.mouse.move(x - 30, y - 20);
    await page.mouse.down();
    for (let i = 0; i <= 8; i++) await page.mouse.move(x - 30 + i * 5, y - 20 + i * 3);
    await page.mouse.up();
  };
  const say = (region, words) => page.fill(`.mp-area textarea[data-region="${region}"]`, words);
  const waitStatus = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".mp-status")?.textContent || ""), re.source, { timeout: 40000 });
  const doneStatus = /Done — the changed model is on your board/;
  const closePainter = async () => { await page.click(".mp-x"); await page.waitForSelector(".mp-dialog", { state: "detached", timeout: 15000 }); };
  const settle = async () => { let last = -1; for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 1500)); if (standin.chats === last) return standin.chats; last = standin.chats; } return standin.chats; };
  const setPrivacy = (mode) => page.evaluate((m) => fetch("/api/buzzy/privacy", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: m }) }).then((r) => r.ok), mode);

  // 5a. A repaint, the real way: the stand-in is asked once, and its picture goes into the painted pixels.
  const g0 = standin.images;
  const had = (await changedModels()).length;
  await openOn("Tank panel");
  await stroke(2);
  await page.waitForSelector(".mp-area textarea");
  await say("red", "add rust stains");
  const label = await page.textContent(".mp-apply");
  check("5. what a repaint costs is on the button before it is pressed", /uses 1 picture generation/.test(label), label);
  await page.click(".mp-apply");
  await waitStatus(doneStatus);
  check("5. the picture maker (the stand-in) was asked once through the real route, and the changed model is on the board", standin.images === g0 + 1, `${standin.images - g0} asked; ${await page.textContent(".mp-status")}`);
  {
    let urls = [];
    for (let i = 0; i < 40; i++) { urls = await changedModels(); if (urls.length > had) break; await page.waitForTimeout(250); }
    const found = await page.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url, { credentials: "same-origin" })).arrayBuffer());
      const { readGlb } = await import("/buzzy/glb-patch.js");
      const { json, bin } = readGlb(bytes);
      const out = [];
      for (const im of json.images || []) {
        const v = json.bufferViews[im.bufferView];
        const bmp = await createImageBitmap(new Blob([bin.slice(v.byteOffset, v.byteOffset + v.byteLength)], { type: im.mimeType }));
        const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
        const k = c.getContext("2d"); k.drawImage(bmp, 0, 0);
        const d = k.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200) n++;
        out.push({ name: im.name, mime: im.mimeType, w: c.width, h: c.height, magenta: n });
      }
      return out;
    }, urls[urls.length - 1]);
    check("5. …the painted pixels of the saved model took the picture maker's result (a texture of its own, magenta where painted; the original's picture has none)", urls.length === had + 1 && found.some((f) => /red area/.test(f.name || "") && f.magenta > 50) && found.some((f) => !/area/.test(f.name || "") && f.magenta === 0), JSON.stringify(found) + " " + urls.length + " vs " + had);
  }
  await closePainter();

  // 5b. A board put away (the page moved to another conversation) WHILE the picture maker works: what was made is kept in the
  //     Library, the board takes nothing, and the painter says why in words and keeps the paint.
  standin.delay = 1500;
  const up = [];
  const stopWatching = uploads(up);
  await openOn("Tank panel");
  await stroke(2, 25, 12);                      // not the stroke of 5a: the result must be a file the account has not got yet
  await say("red", "add rust stains");
  await page.click(".mp-apply");
  await waitStatus(/Asking the picture maker/);
  const cards0 = await page.evaluate(() => { window.__putAway = window.BeeZillaWhiteboard.current(); return window.__putAway.count(); });
  await page.evaluate(() => window.__putAway.destroy());
  await waitStatus(/not open any more/);
  stopWatching();
  standin.delay = 0;
  {
    const st = await page.textContent(".mp-status");
    const cards1 = await page.evaluate(() => window.__putAway.count());
    check("5. a board put away while the picture maker works takes nothing: the window says so in words (the model is in the Library), never says it is done, and keeps the paint", /Library/.test(st) && /Open that conversation again/.test(st) && !/Done —/.test(st) && cards1 === cards0 && (await page.$$(".mp-area")).length === 1 && up.some((u) => u.ok === true && u.duplicate === false), `${st} / ${cards0} → ${cards1} / uploads ${J(up)}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForSelector(".mp-dialog", { state: "detached", timeout: 15000 });
  // The page comes back with a board again (a fresh visit starts with an empty one): the model goes back on it.
  await page.reload({ waitUntil: "domcontentloaded" });
  await mountBoard();
  await page.evaluate((id) => window.BeeZillaWhiteboard.current().addCard({ kind: "model", title: "Tank panel", url: "/api/buzzy/assets/" + id, contentType: "model/gltf-binary", user: true }), asset);

  // 5c. The allowance for ALL of a change's calls, before the first is spent (the starter plan: 60 a day).
  const need = 59 - standin.images;
  const spent = await page.evaluate(async (n) => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    let ok = 0;
    for (let i = 0; i < n; i++) { const r = await fetch("/api/buzzy/art", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "repaint3d", crop: png, mask: png, instruction: "add rust" }) }); if (r.ok) ok++; }
    return ok;
  }, need);
  check("5. (59 of the day's 60 picture generations are used up)", spent === need && standin.images === 59, `${spent}/${need}, stand-in ${standin.images}`);
  await openOn("Tank panel");
  await stroke(2, -40, -60);
  await stroke(3, 120, 20);
  await page.waitForSelector('.mp-area textarea[data-region="blue"]');
  await say("red", "add rust stains");
  await say("blue", "add scratches");
  await page.click(".mp-apply");
  await waitStatus(/needs the picture maker 2 times/);
  const refusal = await page.textContent(".mp-status");
  check("5. a change that needs the picture maker twice, with one generation left, is refused before the first is spent, in the plan's own words", /image quota for the starter plan is 60 per day — 1 left/.test(refusal) && /Nothing has been spent/.test(refusal) && standin.images === 59, `${refusal} / asked ${standin.images}`);
  check("5. …and the paint is still there to try again with fewer areas", (await page.$$(".mp-area")).length === 2 && !(await page.$eval(".mp-apply", (b) => b.disabled)));
  await page.click(".mp-tools button:nth-of-type(5)");          // Clear paint
  await stroke(2, -40, -60);
  await page.waitForSelector('.mp-area textarea[data-region="red"]');
  await say("red", "add rust stains");
  await page.click(".mp-apply");
  await waitStatus(doneStatus);
  check("5. …with one area, the one generation left is spent and the change is made", standin.images === 60, String(standin.images));
  await stroke(2, 60, 30);
  await say("red", "add moss");
  await page.click(".mp-apply");
  await waitStatus(/left/);
  check("5. with none left, the next repaint is refused up front, and says how many are left (0)", /needs the picture maker 1 time/.test(await page.textContent(".mp-status")) && /0 left/.test(await page.textContent(".mp-status")) && standin.images === 60, `${await page.textContent(".mp-status")} / ${standin.images}`);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".mp-dialog", { state: "detached", timeout: 15000 });

  // 5d. Lockdown: nothing leaves BeeZilla, so a saved file's name is not sent to a model for search words.
  //     Each save below is a file the account has not stored before: the server answers "duplicate" for bytes it already has
  //     and tags nothing then, which would make a "nothing was sent" answer true for the wrong reason.
  const saveNew = async (words) => {
    const sent = [];
    const stop = uploads(sent);
    await openOn("Tank panel");
    await stroke(2);
    await say("red", words);
    await page.click(".mp-apply");
    await waitStatus(doneStatus);
    await closePainter();
    stop();
    return sent.filter((u) => u && u.duplicate === false).length;
  };
  const c0 = await settle();
  const fresh1 = await saveNew("make it grey");
  const c1 = await settle();
  check("5. (control: a new file saved in the open mode makes the server ask its model for search words)", fresh1 >= 1 && c1 > c0, `${fresh1} new file(s); ${c0} → ${c1}`);
  check("5. (Lockdown is on)", await setPrivacy("lockdown"));
  const fresh2 = await saveNew("make it white");
  const c2 = await settle();
  check("5. in Lockdown saving a new file sends nothing to a model: its name and note never leave BeeZilla (the search words are written here)", fresh2 >= 1 && c2 === c1, `${fresh2} new file(s); ${c1} → ${c2}`);
  await page.evaluate(() => fetch("/api/buzzy/search?q=changed", { credentials: "same-origin" }).then((r) => r.status));
  const c3 = await settle();
  check("5. …and a search in Lockdown does not fill in missing search words by asking a model either", c3 === c2, `${c2} → ${c3}`);
  check("5. (Lockdown is off again)", await setPrivacy("open"));
  await page.evaluate(() => fetch("/api/buzzy/search?q=changed", { credentials: "same-origin" }).then((r) => r.status));
  const c4 = await settle();
  check("5. (control: with Lockdown off the search does fill them in, asking the model for the files saved in Lockdown)", c4 > c3, `${c3} → ${c4}`);
}

// 6. No room: said before anything is made. Lockdown: the picture maker refused, a colour not.
{
  const before = await page.evaluate(() => window.BeeZillaWhiteboard.current().count());
  await page.evaluate((n) => { const b = window.BeeZillaWhiteboard.current(); for (let i = 0; i < n; i++) b.addCard({ kind: "note", title: "filler " + i, body: "", user: true }); }, 160 - before - 1);
  check("6. (the board is nearly full)", (await page.evaluate(() => window.BeeZillaWhiteboard.current().count())) === 159);
  // (The filler cards moved the board; press the button where it is, on or off the screen.)
  await page.locator(".wb-card.wb-k-model", { hasText: "Tank panel" }).first().locator(".wb-paint3d").evaluate((b) => b.click());
  await page.waitForFunction(() => /Pick the red or blue brush/.test(document.querySelector(".mp-hint")?.textContent || ""), null, { timeout: 20000 });
  await page.click(".mp-tools button:nth-of-type(2)");
  await page.mouse.move(cx - 30, cy - 20);
  await page.mouse.down();
  for (let i = 0; i <= 8; i++) await page.mouse.move(cx - 30 + i * 5, cy - 20 + i * 3);
  await page.mouse.up();
  await page.waitForSelector(".mp-area textarea");
  await page.fill(".mp-area textarea", "make it black");
  await page.click(".mp-apply");
  await page.waitForFunction(() => /room for 3 more cards/.test(document.querySelector(".mp-status")?.textContent || ""), null, { timeout: 15000 });
  check("6. a board with no room says so before anything is made, and adds nothing", (await page.evaluate(() => window.BeeZillaWhiteboard.current().count())) === 159 && !(await page.$eval(".mp-apply", (b) => b.disabled)));
  // Lockdown: on the account.
  await page.evaluate(() => fetch("/api/buzzy/privacy", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "lockdown" }) }));
  await page.fill(".mp-area textarea", "add rust stains");
  await page.click(".mp-apply");
  await page.waitForFunction(() => /Lockdown/.test(document.querySelector(".mp-status")?.textContent || ""), null, { timeout: 15000 });
  check("6. in Lockdown the picture maker is refused in plain words (the window says so)", true);
  const direct = await page.evaluate(async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const r = await fetch("/api/buzzy/art", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "repaint3d", crop: png, mask: png, instruction: "add rust" }) });
    return { status: r.status, body: await r.json() };
  });
  check("6. …and the server's own route refuses it too (403, code lockdown), whatever the page says", direct.status === 403 && direct.body.code === "lockdown" && /Lockdown/.test(direct.body.error), J(direct));
  await page.evaluate(() => fetch("/api/buzzy/privacy", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "open" }) }));
  const open = await page.evaluate(async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const r = await fetch("/api/buzzy/art", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "repaint3d", crop: png, mask: png, instruction: "add rust" }) });
    return { status: r.status, body: await r.json() };
  });
  check("6. …and with Lockdown off the same request is not refused for that reason", open.body.code !== "lockdown", J(open));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}
// 7. A board that was put away under the open painter, BEFORE Apply: said before anything is made, nothing is saved or spent.
if (STANDIN) {
  // Section 6 filled the board: start over with the model alone, so that room is not what refuses this.
  await page.evaluate((id) => { const b = window.BeeZillaWhiteboard.current(); b.clear(); b.addCard({ kind: "model", title: "Tank panel", url: "/api/buzzy/assets/" + id, contentType: "model/gltf-binary", user: true }); }, asset);
  await page.locator(".wb-card.wb-k-model", { hasText: "Tank panel" }).first().locator(".wb-paint3d").evaluate((b) => b.click());
  await page.waitForFunction(() => /Pick the red or blue brush/.test(document.querySelector(".mp-hint")?.textContent || ""), null, { timeout: 20000 });
  await page.click(".mp-tools button:nth-of-type(2)");
  const g = await page.$eval(".mp-stage canvas", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.move(g.x + g.w * 0.43 - 30, g.y + g.h * 0.5 - 20);
  await page.mouse.down();
  for (let i = 0; i <= 8; i++) await page.mouse.move(g.x + g.w * 0.43 - 30 + i * 5, g.y + g.h * 0.5 - 20 + i * 3);
  await page.mouse.up();
  await page.waitForSelector(".mp-area textarea");
  await page.fill(".mp-area textarea", "make it black");
  const sent = [];
  const stop = uploads(sent);
  const before = await page.evaluate(() => { window.__putAway = window.BeeZillaWhiteboard.current(); return window.__putAway.count(); });
  await page.evaluate(() => window.__putAway.destroy());
  await page.click(".mp-apply");
  await page.waitForFunction(() => /not open any more/.test(document.querySelector(".mp-status")?.textContent || ""), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  stop();
  const after = await page.evaluate(() => window.__putAway.count());
  check("7. a board put away under the painter is said so BEFORE anything is made: nothing is saved to the Library, the board is not written to, and the paint is kept", sent.length === 0 && !/Done —/.test(await page.textContent(".mp-status")) && after === before && (await page.$$(".mp-area")).length === 1 && /Open that conversation again/.test(await page.textContent(".mp-status")), `${await page.textContent(".mp-status")} / ${before} → ${after} / uploads ${J(sent)}`);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".mp-dialog", { state: "detached", timeout: 15000 });
}
check("no page errors", errors.length === 0, errors.join(" | "));

if (standinServer) standinServer.close();
await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
