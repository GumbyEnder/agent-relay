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
//   5. A board with no room says so before anything is made; Lockdown refuses the picture maker
//      (on the page and on the server's own route) and a colour still works.
// usage: node scripts/probe-paint-on-board.mjs <origin>  (BZ_PROBE_CDP, BZ_MAIL_LOG as the other probes)
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";

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
  const cards = await page.$$eval(".wb-card.wb-k-model", (ns) => ns.map((n) => ({ name: n.querySelector(".wb-name").textContent, paint: !!n.querySelector(".wb-paint3d") })));
  check("0. a .glb model card has Paint changes, an .obj model card does not", cards.length === 2 && cards.find((c) => c.name === "Tank panel").paint && !cards.find((c) => c.name === "Turret").paint, J(cards));
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
await page.keyboard.press("Delete");
await page.waitForTimeout(300);
check("1. the window has the keyboard: Delete does not take the selected card off the board behind it", (await page.locator(".wb-card.wb-k-model").count()) === 2 && (await page.evaluate(() => !!document.activeElement.closest(".mp-box"))));

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

// 5. No room: said before anything is made. Lockdown: the picture maker refused, a colour not.
{
  const before = await page.evaluate(() => window.BeeZillaWhiteboard.current().count());
  await page.evaluate((n) => { const b = window.BeeZillaWhiteboard.current(); for (let i = 0; i < n; i++) b.addCard({ kind: "note", title: "filler " + i, body: "", user: true }); }, 160 - before - 1);
  check("5. (the board is nearly full)", (await page.evaluate(() => window.BeeZillaWhiteboard.current().count())) === 159);
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
  check("5. a board with no room says so before anything is made, and adds nothing", (await page.evaluate(() => window.BeeZillaWhiteboard.current().count())) === 159 && !(await page.$eval(".mp-apply", (b) => b.disabled)));
  // Lockdown: on the account.
  await page.evaluate(() => fetch("/api/buzzy/privacy", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "lockdown" }) }));
  await page.fill(".mp-area textarea", "add rust stains");
  await page.click(".mp-apply");
  await page.waitForFunction(() => /Lockdown/.test(document.querySelector(".mp-status")?.textContent || ""), null, { timeout: 15000 });
  check("5. in Lockdown the picture maker is refused in plain words (the window says so)", true);
  const direct = await page.evaluate(async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const r = await fetch("/api/buzzy/art", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "repaint3d", crop: png, mask: png, instruction: "add rust" }) });
    return { status: r.status, body: await r.json() };
  });
  check("5. …and the server's own route refuses it too (403, code lockdown), whatever the page says", direct.status === 403 && direct.body.code === "lockdown" && /Lockdown/.test(direct.body.error), J(direct));
  await page.evaluate(() => fetch("/api/buzzy/privacy", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "open" }) }));
  const open = await page.evaluate(async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const r = await fetch("/api/buzzy/art", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "repaint3d", crop: png, mask: png, instruction: "add rust" }) });
    return { status: r.status, body: await r.json() };
  });
  check("5. …and with Lockdown off the same request is not refused for that reason", open.body.code !== "lockdown", J(open));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}
check("no page errors", errors.length === 0, errors.join(" | "));

await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
