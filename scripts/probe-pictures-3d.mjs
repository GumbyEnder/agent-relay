// BeeZilla sees pictures, reads the board in line order, and makes 3D models from your
// picture (testers, 2026-11-24). On the real Talk page, signed in, with a chat model and a
// 3D maker answering (stand-ins in tests: any OpenAI-style model that can see; a Meshy
// look-alike at BZ_MESHY_BASE_URL):
//   1. A picture on the board, pointed at: "what is in this picture?" — the picture goes to
//      the model that can see, with the question, and the reply's instructions carry what
//      it shows ("PICTURES YOU CAN SEE").
//   2. Cards joined by lines (picture → "Look closely" → "Make it 3D"): the turn's
//      instructions spell the chain out in that order.
//   3. "make this a 3D model" while pointing at the picture: the 3D maker gets THE PICTURE
//      (Image to 3D), textured with PBR and a clean quad mesh, never the sentence; the
//      page follows the job and the finished model lands on the board as a 3D model card.
// usage: node scripts/probe-pictures-3d.mjs <origin>
//   BZ_PROBE_CDP=<DevTools URL>; BZ_MAIL_LOG=<server>/.data/outbound-mail.jsonl;
//   BZ_PROBE_MODEL_LOG=<jsonl the stand-in model writes>; BZ_PROBE_MESHY_LOG=<jsonl the
//   stand-in Meshy writes> (both optional: without them only the page is checked).
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const MODEL_LOG = process.env.BZ_PROBE_MODEL_LOG || "";
const MESHY_LOG = process.env.BZ_PROBE_MESHY_LOG || "";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
const lines = (f) => (f && existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function devSignIn() {
  const email = `probe-pics-${Date.now().toString(36)}@test.local`;
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
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failures++;
}
page.on("pageerror", (e) => { console.log("page error:", e.message); failures++; });

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#chatInput");
await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current());

// A picture of theirs (a little drawing made here), uploaded like a drop on the board.
const picId = await page.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 320; c.height = 200;
  const k = c.getContext("2d");
  k.fillStyle = "#fff"; k.fillRect(0, 0, 320, 200);
  k.fillStyle = "#556b2f"; k.fillRect(60, 90, 180, 50); k.fillRect(240, 105, 60, 12); k.fillRect(150, 70, 8, 22); k.fillRect(70, 66, 160, 6);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const res = await fetch("/api/buzzy/assets", { method: "POST", credentials: "same-origin", headers: { "content-type": "image/png", "x-bz-path": "helicopter-concept.png" }, body: blob });
  const j = await res.json();
  return j.id;
});
check("0. the picture is in their Library", Number(picId) > 0, String(picId));
await page.evaluate((id) => {
  const b = window.BeeZillaWhiteboard.current();
  b.addGraph({ nodes: [
    { id: "p", kind: "image", title: "Helicopter concept", x: 0, y: 0 },
  ], links: [] });
  const card = b.addCard({ kind: "image", title: "Helicopter concept", url: "/api/buzzy/assets/" + id, contentType: "image/png", user: true });
  window.__picCard = card && card.id;
}, picId);
await page.waitForTimeout(800);

async function hoverCard(title) {
  const box = await page.evaluate((t) => {
    const n = [...document.querySelectorAll(".wb-world > .wb-card")].find((c) => (c.getAttribute("aria-label") || "").includes(t) && c.querySelector("img"));
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, title);
  if (box) { await page.mouse.move(box.x, box.y); await page.waitForTimeout(600); }
  return box;
}
async function send(text, { hover } = {}) {
  if (hover) await hoverCard(hover);
  await page.fill("#chatInput", text);
  const before = await page.evaluate(() => [...document.querySelectorAll(".bubble:not(.me):not(.streaming)")].map((b) => (b.textContent || "").trim()));
  // Send from the keyboard, so the pointer stays on the card ("this").
  await page.focus("#chatInput");
  await page.keyboard.press("Enter");
  // The reply to THIS message, wherever the page puts it (Talk lists the newest first): the
  // one assistant bubble that wasn't there before the send.
  const fresh = (old) => {
    const left = old.slice();
    for (const b of document.querySelectorAll(".bubble:not(.me):not(.streaming)")) {
      const t = (b.textContent || "").trim();
      const k = left.indexOf(t);
      if (k >= 0) { left.splice(k, 1); continue; }
      if (t.length > 3 && !/^(?:Thinking|Working)/i.test(t)) return t;
    }
    return null;
  };
  await page.waitForFunction(([old, src]) => !!new Function("o", "return (" + src + ")(o)")(old), [before, fresh.toString()], { timeout: 90000 });
  await page.waitForTimeout(1200);
  return page.evaluate(([old, src]) => new Function("o", "return (" + src + ")(o)")(old), [before, fresh.toString()]);
}

// 1. "what is in this picture?" while pointing at it.
const mark1 = lines(MODEL_LOG).length;
const r1 = await send("what is in this picture?", { hover: "Helicopter concept" });
const log1 = lines(MODEL_LOG).slice(mark1);
check("1. a reply came", !!r1 && r1.length > 3, r1);
if (MODEL_LOG) {
  check("1. the picture itself went to the model that can see", log1.some((l) => l.hasImage && l.model === "standin-vision"), JSON.stringify(log1.map((l) => [l.model, l.hasImage])));
  check("1. with their question", log1.some((l) => l.hasImage && /ANSWER TO THE QUESTION:/.test(l.userTail || l.user) && /what is in this picture/i.test(l.userTail || l.user)), JSON.stringify(log1.filter((l) => l.hasImage).map((l) => (l.userTail || "").slice(-120))));
  check("1. what it shows rides with their message, as observed data", log1.some((l) => l.hasPictures && /helicopter/i.test(l.picturesBlock)), JSON.stringify(log1.map((l) => (l.picturesBlock || "").slice(0, 200))));
  check("1. …never among BeeZilla's own instructions", !log1.some((l) => l.picturesInSystem), "");
}
check("1. the reply was written knowing the picture", /\[saw-pictures\]/.test(r1) || !MODEL_LOG, r1);

// 2. A chain of cards: picture → "Look closely" → "Make it 3D".
await page.evaluate(() => {
  const b = window.BeeZillaWhiteboard.current();
  b.addGraph({ nodes: [
    { id: "s1", kind: "skill", title: "Look closely at the concept", body: "List its parts and colours", x: 0, y: 0 },
    { id: "s2", kind: "skill", title: "Make it a 3D model", body: "Keep the concept's shape", x: -400, y: 300 },
  ], links: [{ from: "s1", to: "s2" }] });
});
await page.waitForTimeout(800);
const mark2 = lines(MODEL_LOG).length;
// (BeeZilla may answer a question about its board itself, so any new reply will do here.)
const r2 = await send("what are the steps on my board?");
const log2 = lines(MODEL_LOG).slice(mark2);
if (MODEL_LOG) check("2. the turn's instructions spell out how the cards are joined", log2.some((l) => l.hasFlow), JSON.stringify(log2.map((l) => l.hasFlow)));
check("2. the reply came", !!r2 && r2.length > 3, r2);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-board-with-picture-and-steps.png` });

// 3. "make this a 3D model" while pointing at the picture. The FBX copy is made to come in
//    late (the first finished answer says it is still on its way), as a slow download would.
let lateFbx = { held: false, glb: "" };
// The page's next ask (the one that brings the FBX copy) is held until the probe has put
// another message with the same file in place.
let releaseFbx = () => {};
const fbxGate = new Promise((r) => { releaseFbx = r; });
await page.route(/\/api\/buzzy\/model3d\/[^/?]+$/, async (route) => {
  const res = await route.fetch();
  let j = null;
  try { j = await res.json(); } catch { /* not json: as it is */ }
  if (j && j.asset && !lateFbx.held) {
    lateFbx = { held: true, glb: j.asset.url };
    delete j.fbx;
    j.fbxPending = true;
    await route.fulfill({ response: res, json: j });
    return;
  }
  if (j && j.asset && lateFbx.held) await fbxGate;
  await route.fulfill({ response: res, json: j ?? undefined });
});
const meshyMark = lines(MESHY_LOG).length;
const r3 = await send("make this a 3D model", { hover: "Helicopter concept" });
if (MODEL_LOG) {
  const told = lines(MODEL_LOG).filter((l) => l.started3d).pop();
  check("3. BeeZilla is told the model is being made from their picture, by its name", !!told && /their picture “Helicopter concept”/.test(told.started3d), JSON.stringify(told && told.started3d));
} else check("3. a reply came", !!r3 && r3.length > 3, r3);
const t0 = Date.now();
await page.waitForFunction(() => [...document.querySelectorAll(".wb-world > .wb-card")].some((c) => c.querySelector(".wb-paint3d, a.wb-open[download]") && /3D/i.test(c.getAttribute("aria-label") || "")), null, { timeout: 120000 }).catch(() => {});
const modelCard = await page.evaluate(() => {
  const n = [...document.querySelectorAll(".wb-world > .wb-card")].find((c) => /3D model/i.test(c.getAttribute("aria-label") || "") && c.querySelector("a.wb-open[download]"));
  return n ? { label: n.getAttribute("aria-label"), href: n.querySelector("a.wb-open[download]").getAttribute("href") } : null;
});
check("3. the finished model is on the board, downloadable", !!modelCard && /\/api\/buzzy\/assets\/\d+/.test(modelCard.href), JSON.stringify(modelCard) + ` after ${Math.round((Date.now() - t0) / 1000)} s`);
if (MESHY_LOG) {
  const calls = lines(MESHY_LOG).slice(meshyMark);
  const start = calls.find((c) => c.method === "POST");
  check("3. the 3D maker got the picture itself (Image to 3D)", start && start.path === "/v1/image-to-3d" && /^data:image\/png;base64,/.test(String(start.body.image_url)), JSON.stringify(start));
  check("3. …painted with PBR by Meshy 7, its look kept, a clean quad mesh", start && start.body.ai_model === "meshy-7.1" && start.body.texture_model === "meshy-7" && start.body.enable_pbr === true && start.body.image_enhancement === false && start.body.topology === "quad", JSON.stringify(start && start.body));
  check("3. …never the sentence as typed", start && !("prompt" in start.body), JSON.stringify(start && start.body));
  check("3. the page followed the job to the end", calls.filter((c) => c.method === "GET" && /image-to-3d/.test(c.path)).length >= 2 && calls.some((c) => /\/files\//.test(c.path)), JSON.stringify(calls.map((c) => c.method + " " + c.path)));
}
if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-model-on-board.png` });

// 3b. The FBX copy comes in after the model: it joins its own reply's card — even when
//     another message shows the same file (put in here) — and nothing is rebuilt.
check("3b. (the first finished answer said the FBX copy was still coming)", lateFbx.held, JSON.stringify(lateFbx));
await page.evaluate((glb) => {
  const box = document.getElementById("chatMessages");
  const other = document.createElement("div");
  other.id = "probe-other-message";
  other.innerHTML = '<div class="bubble">Another message with the same file</div><div class="file-card media-card"><span class="file-meta"><span class="file-name">same.glb</span></span><a href="' + glb + '" download="same.glb">Download</a></div>';
  if (box) box.appendChild(other);
  // The reply's own card, marked: the same node must still be there after the FBX comes.
  const own = document.querySelector("[data-model3d-card]");
  if (own) own.__probeOwn = true;
}, lateFbx.glb);
releaseFbx();
await page.waitForFunction(() => /\.fbx/.test((document.querySelector("[data-model3d-card]")?.nextElementSibling?.textContent) || ""), null, { timeout: 60000 }).catch(() => {});
const fbxAt = await page.evaluate(() => {
  const own = document.querySelector("[data-model3d-card]");
  const other = document.querySelector("#probe-other-message .media-card");
  return {
    own: !!own,
    sameNode: !!own && own.__probeOwn === true,
    otherKept: !!document.getElementById("probe-other-message"),
    next: own && own.nextElementSibling ? (own.nextElementSibling.textContent || "").replace(/\s+/g, " ").slice(0, 80) : "",
    otherNext: other && other.nextElementSibling ? (other.nextElementSibling.textContent || "").slice(0, 80) : "",
    fbxCards: [...document.querySelectorAll("#chatMessages .media-card")].filter((c) => /\.fbx/.test(c.textContent || "")).length,
  };
});
check("3b. the late FBX copy is right after its own reply's model card", fbxAt.own && /\.fbx/.test(fbxAt.next), JSON.stringify(fbxAt));
check("3b. …and nowhere else (not beside another message with the same file, not twice)", fbxAt.otherKept && !/\.fbx/.test(fbxAt.otherNext) && fbxAt.fbxCards === 1, JSON.stringify(fbxAt));
check("3b. …without rebuilding the conversation (the reply's card is the same one)", fbxAt.sameNode, JSON.stringify(fbxAt));

await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
