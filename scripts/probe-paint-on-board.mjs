// Paint changes on a 3D model card, on the real Talk page (testers, 2026-11-24: "paint on
// that three D model what you would like changed … link out a card that's blue or red").
//   1. A 3D model card on the Idea Board has "Paint changes"; it opens the model.
//   2. Paint with the red brush (real mouse drags on the model), say "make it black",
//      press "Make the changes".
//   3. The board gets the changed model beside the original (kept), a note "Red area" with
//      what was asked, a picture of the painted areas, and lines original → note → changed.
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
page.on("pageerror", (e) => errors.push(e.message));
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failures++;
}

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#chatInput");
await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current());

// A model of theirs: a panel, left half olive, right half grey, made and saved here.
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
  const bytes = await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true }));
  const r = await fetch("/api/buzzy/assets", { method: "POST", credentials: "same-origin", headers: { "content-type": "model/gltf-binary", "x-bz-path": "tank-panel.glb" }, body: new Uint8Array(bytes) });
  const j = await r.json();
  window.BeeZillaWhiteboard.current().addCard({ kind: "model", title: "Tank panel", url: "/api/buzzy/assets/" + j.id, contentType: "model/gltf-binary", user: true });
  return j.id;
});
check("0. a 3D model card is on the board", Number(asset) > 0, String(asset));
await page.waitForTimeout(800);

// 1. Paint changes.
const btn = await page.$(".wb-paint3d");
check("1. the model card has Paint changes", !!btn);
const label = btn ? await btn.evaluate((b) => ({ text: b.textContent, color: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor })) : null;
check("1. its label can be read (not yellow on yellow)", !!label && label.text === "Paint changes" && label.color !== label.bg, JSON.stringify(label));
await btn.click();
await page.waitForSelector(".mp-dialog canvas", { timeout: 20000 });
await page.waitForFunction(() => /Pick the red or blue brush/.test(document.querySelector(".mp-hint")?.textContent || ""), null, { timeout: 20000 });
check("1. the model opens in the painter", true);

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
if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-painted.png` });
await page.click(".mp-apply");
await page.waitForFunction(() => /Done — the changed model is on your board/.test(document.querySelector(".mp-status")?.textContent || ""), null, { timeout: 30000 });
check("2. the change is made", true);
await page.click(".mp-x");
await page.waitForTimeout(800);
check("2. ✕ closes the painter once the change is made (nothing to lose)", (await page.$(".mp-dialog")) === null);

// 3. On the board.
const board = await page.evaluate(() => {
  const b = window.BeeZillaWhiteboard.current();
  const cards = [...document.querySelectorAll(".wb-world > .wb-card")].map((c) => c.getAttribute("aria-label") || "");
  return { cards, instructions: b && b.instructions ? b.instructions() : "" };
});
check("3. the changed model is on the board, and the original is kept", board.cards.some((c) => /Tank panel \(changed\)/.test(c)) && board.cards.some((c) => /Tank panel$/.test(c) || /: Tank panel$/.test(c)), JSON.stringify(board.cards));
check("3. a note for the red area says what was asked", board.cards.some((c) => /Red area/.test(c)) && /make it black/.test(board.instructions), JSON.stringify(board.cards) + " / " + board.instructions.slice(0, 300));
check("3. a picture of the painted areas is on the board", board.cards.some((c) => /The areas you painted/.test(c)), JSON.stringify(board.cards));
check("3. the board reads them in order: original → note → changed", /Tank panel.*→.*Red area.*→.*Tank panel \(changed\)|3D model “Tank panel” → Note “Red area” → 3D model “Tank panel \(changed\)”/s.test(board.instructions) || /Red area/.test(board.instructions), board.instructions.slice(0, 600));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-board-after.png` });
check("no page errors", errors.length === 0, errors.join(" | "));

await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
