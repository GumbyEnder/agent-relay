// Zooming the Idea Board on the real Talk page (owner, 21 Nov 2026: "when zooming in
// and out of the board, things throw themselves around and you lose your bits").
//   1. A trackpad pinch over each part of the board — its top bar with the Talk box, the
//      tools, the zoom buttons, the board itself — zooms the board with the fingers and
//      never the page; no card moves. (Before: over the bars the whole page zoomed and
//      jumped toward the fingers, and pinching back on the board left the page big.)
//   2. Ctrl/⌘ + = and − zoom the board.
//   3. Two fingers on a touch screen, the first on a card: the board zooms, no card moves.
//      (Before: the board never zoomed and the cards followed the first finger.)
//   4. A board saved zoomed off into nothing, with a card flung 90,000 px away: it opens
//      with every card in sight, the far one back beside the others.
// usage: node scripts/probe-board-zoom.mjs [origin]      (BZ_PROBE_CDP=<DevTools URL> to reuse a browser)
//   Signed-in pages need a session: set BZ_PROBE_COOKIE to a "name=value" session
//   cookie, or leave it unset against a local server and the probe signs a throwaway
//   account in through the dev magic-link inbox (BZ_MAIL_LOG, default
//   .data/outbound-mail.jsonl in the server's folder).
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";

async function devSignIn() {
  const email = `probe-zoom-${Date.now().toString(36)}@test.local`;
  const res = await fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`magic-link request failed ${res.status}`);
  for (let i = 0; i < 30; i++) {
    if (existsSync(MAIL_LOG)) {
      for (const line of readFileSync(MAIL_LOG, "utf8").trim().split("\n").reverse()) {
        let mail;
        try { mail = JSON.parse(line); } catch { continue; }
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
  throw new Error(`no magic-link mail for ${email} in ${MAIL_LOG}`);
}

const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
const eqAt = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failures++;
}
const scaleOf = (t) => Number((/scale\(([\d.]+)\)/.exec(t || "") || [0, 0])[1]);

async function talk(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  await context.addCookies([{
    name: cookie.slice(0, eqAt), value: cookie.slice(eqAt + 1),
    domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
  }]);
  const page = await context.newPage();
  await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit
  page.on("pageerror", (e) => { console.log("page error:", e.message); failures++; });
  await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
  // Open the board the way a person does: press into the Talk box.
  await page.waitForSelector("#chatInput");
  await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current());
  await page.evaluate(() => window.BeeZillaWhiteboard.current().addGraph({ nodes: [
    { id: "a", kind: "note", title: "Note A", body: "first idea", x: 0, y: 0 },
    { id: "b", kind: "skill", title: "Step B", body: "do the thing", x: 320, y: 0 },
    { id: "c", kind: "output", title: "End C", body: "the result", x: 640, y: 40 },
  ], links: [{ from: "a", to: "b" }, { from: "b", to: "c" }] }));
  await page.waitForTimeout(600);
  return { context, page, cdp: await context.newCDPSession(page) };
}
const look = (page) => page.evaluate(() => ({
  t: document.querySelector(".wb-world").style.transform,
  page: visualViewport.scale,
  cards: Object.fromEntries([...document.querySelectorAll(".wb-world > .wb-card")].map((n) => [n.getAttribute("aria-label"), n.style.left + "," + n.style.top])),
}));

// 1 + 2. A trackpad pinch over every part of the board; Ctrl/⌘ + = and −.
{
  const { context, page, cdp } = await talk();
  const spots = await page.evaluate(() => {
    const mid = (sel, dy = 0) => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 60), r.top + r.height / 2 + dy]; };
    return { "the top bar with the Talk box": mid(".wb-head .wb-dock"), "the tools": mid(".wb-toolbar", -40), "the zoom buttons": mid(".wb-zoom"), "the board itself": mid(".wb-canvas") };
  });
  for (const [name, [x, y]] of Object.entries(spots)) {
    const before = await look(page);
    await cdp.send("Input.synthesizePinchGesture", { x, y, scaleFactor: 1.8, relativeSpeed: 800, gestureSourceType: "mouse" });
    await page.waitForTimeout(250);
    const after = await look(page);
    check(`pinch over ${name}: the page stays as it was`, after.page === 1, `page zoom ${after.page}`);
    check(`pinch over ${name}: the board zooms with the fingers (×1.8)`, Math.abs(scaleOf(after.t) / scaleOf(before.t) - 1.8) < 0.05, `${scaleOf(before.t)} → ${scaleOf(after.t)}`);
    check(`pinch over ${name}: no card moves`, JSON.stringify(after.cards) === JSON.stringify(before.cards));
    await cdp.send("Input.synthesizePinchGesture", { x, y, scaleFactor: 1 / 1.8, relativeSpeed: 800, gestureSourceType: "mouse" });
    await page.waitForTimeout(250);
  }
  await page.mouse.click(...(await page.evaluate(() => { const r = document.querySelector(".wb-canvas").getBoundingClientRect(); return [r.right - 200, r.bottom - 120]; })));
  const k0 = scaleOf((await look(page)).t);
  await page.keyboard.press("Control+Equal");
  const k1 = scaleOf((await look(page)).t);
  await page.keyboard.press("Control+Minus");
  const k2 = scaleOf((await look(page)).t);
  check("Ctrl + = zooms the board in and Ctrl + − back out", Math.abs(k1 / k0 - 1.25) < 0.01 && Math.abs(k2 - k0) < 0.001, `${k0} → ${k1} → ${k2}`);
  await context.close();
}

// 3. Two fingers on a touch screen, the first one on a card.
{
  const { context, page, cdp } = await talk({ hasTouch: true });
  const before = await look(page);
  const [x, y] = await page.evaluate(() => { const r = document.querySelector('.wb-world > .wb-card[aria-label="Note: Note A"] .wb-name').getBoundingClientRect(); return [r.left + 10, r.top + 5]; });
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([px, py], i) => ({ x: px, y: py, id: i + 1 })) });
  await touch("touchStart", [[x, y]]);
  await touch("touchMove", [[x + 6, y + 4]]);
  await touch("touchStart", [[x + 6, y + 4], [x + 250, y + 200]]);
  for (let i = 1; i <= 8; i++) { await touch("touchMove", [[x - i * 15, y - i * 10], [x + 250 + i * 15, y + 200 + i * 10]]); await page.waitForTimeout(16); }
  await touch("touchEnd", []);
  await page.waitForTimeout(400);
  const after = await look(page);
  check("two fingers on a touch screen: no card moves", JSON.stringify(after.cards) === JSON.stringify(before.cards), JSON.stringify(after.cards));
  check("two fingers on a touch screen: the board zooms", scaleOf(after.t) > scaleOf(before.t) * 1.3, `${scaleOf(before.t)} → ${scaleOf(after.t)}`);
  await context.close();
}

// 4. A board saved zoomed off into nothing, with one card flung far away.
{
  const { context, page } = await talk();
  const id = "probe-zoom-" + Date.now().toString(36);
  const r = await page.evaluate(async (boardId) => {
    localStorage.setItem("bz.board." + boardId, JSON.stringify({ v: 2, cards: [
      { id: "n1", kind: "note", title: "Near one", body: "", url: "", contentType: "", x: 0, y: 0 },
      { id: "n2", kind: "note", title: "Near two", body: "", url: "", contentType: "", x: 300, y: 0 },
      { id: "f1", kind: "note", title: "Far one", body: "", url: "", contentType: "", x: 90000, y: -40000 },
    ], links: [], view: { x: -50000, y: 30000, z: 0.4 }, viewSet: true, sync: { rev: null, dirty: false, base: null } }));
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:20px;top:20px;width:1000px;height:640px;display:flex;z-index:99";
    host.className = "ob-board";
    document.body.appendChild(host);
    const b = window.BeeZillaWhiteboard.mount(host, { boardId });
    await new Promise((res) => setTimeout(res, 600));
    const c = host.querySelector(".wb-canvas").getBoundingClientRect();
    const cards = [...host.querySelectorAll(".wb-world > .wb-card")].map((n) => { const q = n.getBoundingClientRect(); return { name: n.getAttribute("aria-label"), seen: q.right > c.left && q.left < c.right && q.bottom > c.top && q.top < c.bottom, at: n.style.left + "," + n.style.top }; });
    const said = host.querySelector(".wb-toast").textContent;
    b.destroy();
    host.remove();
    return { cards, said };
  }, id);
  check("a board saved far off opens with every card in sight", r.cards.length === 3 && r.cards.every((c) => c.seen), JSON.stringify(r.cards));
  const far = ((r.cards.find((c) => c.name === "Note: Far one") || {}).at || "").split(",").map(parseFloat);
  check("the card flung 90,000 px away is back beside the others (just below them)", far[0] === 0 && far[1] > 0 && far[1] < 600, JSON.stringify(r.cards));
  check("and the board says so", /back beside the others/.test(r.said), r.said);
  await context.close();
}

if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall zoom checks passed");
process.exit(failures ? 1 : 0);
