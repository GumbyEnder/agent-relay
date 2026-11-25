// Boxes and panels you can drag bigger or smaller (owner, 2026-11-22):
//   "If I have a box like the conversation history, I could just grab the side or the
//    corner and grow the size of that so I can see it bigger if I want to. Make it so."
//
// Drives a real browser against a running build, signed in, with a real conversation on the
// Idea Board, and holds the page to:
//   1. The conversation card has a grab strip on every side and corner; the corner wears a grip.
//   2. Dragging the corner, each side, and the other corners changes the card by exactly the
//      distance the pointer moved: at 100%, and with the board zoomed out to 50% (the sums are
//      in the box's own pixels, not the screen's). A card held by its left or top edge keeps
//      its opposite edge still.
//   3. It stops at its smallest size, and never grows out of the board's own edge cases.
//   4. Esc, while dragging, puts it back, and does not close or move anything else.
//   5. The new size is saved in the card (the board's saved data, in the browser and in the
//      account), survives the board being drawn again (undo does that), and a double-click, or
//      Home on the focused corner, puts it back at 360 x 480.
//   6. Arrow keys on the corner (Tab to it) change the size, Shift by more.
//   7. A plain click on a strip changes nothing and selects nothing.
//   8. The Idea Board itself gets taller and shorter by its bottom edge, and keeps it.
//   9. History (the board's earlier versions) grows left and up from the corner it opens in.
//  10. The step editor grows right and down, gives the extra room to its words, and opens at
//      the size it was given.
//  11. Feedback grows left and down from the corner it hangs from; folded up it is the small
//      pill again, with no strips and none of the size, and unfolded it has its size back.
//  12. A phone: the Idea Board has no strip and keeps none of its height; back on a wide window
//      it has it again.
//  13. The 3D painter's window: Esc while dragging its corner takes the drag back and closes nothing;
//      it has a usable minimum size.
//
// usage: node scripts/probe-resizable-boxes.mjs [origin]      (BZ_PROBE_CDP=<DevTools URL> to reuse a browser)
//   Needs a session: BZ_PROBE_COOKIE="name=value", or leave it unset against a local server
//   and the probe signs a throwaway account in through the dev magic-link inbox (BZ_MAIL_LOG,
//   default .data/outbound-mail.jsonl in the server's folder). Screenshots go to BZ_PROBE_SHOTS.
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function devSignIn() {
  const email = `probe-resize-${Date.now().toString(36)}@test.local`;
  const res = await fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`magic-link request failed ${res.status}`);
  for (let i = 0; i < 40; i++) {
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
const eq = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });

let failed = 0, total = 0;
const check = (name, ok, detail) => {
  total++;
  if (ok) console.log("ok   ", name);
  else { failed++; console.log("FAIL ", name, detail ? "— " + detail : ""); }
};
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

const context = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
await context.addCookies([{
  name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
  domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
}]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

// ── helpers ─────────────────────────────────────────────────────────────────────────────
const card = () => page.evaluate(() => {
  const n = document.querySelector(".wb-k-chat");
  const cs = getComputedStyle(n);
  return n ? { w: n.offsetWidth, h: n.offsetHeight, x: parseFloat(cs.left), y: parseFloat(cs.top), sel: n.classList.contains("wb-on") } : null;
});
const centre = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
}, sel);
async function drag(sel, dx, dy, opts = {}) {
  const c = await centre(sel);
  if (!c) throw new Error("no handle " + sel);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 4 });
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 4 });
  if (opts.esc) { await page.keyboard.press("Escape"); await page.mouse.up(); return; }
  await page.mouse.up();
  await page.waitForTimeout(80);
}
const H = (edge) => `.wb-k-chat > .bz-rs-${edge}`;
const saved = () => page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!/^bz\.board\./.test(k)) continue;
    try {
      const b = JSON.parse(localStorage.getItem(k));
      const c = (b.cards || []).find((x) => x.id === "chat");
      if (c) return { w: c.w, h: c.h, x: c.x, y: c.y };
    } catch (_) { /* next */ }
  }
  return null;
});

// ── a real conversation on the board ────────────────────────────────────────────────────
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
await page.waitForSelector("#chatInput:not([disabled])", { timeout: 30000 });
await page.waitForTimeout(1200);
await page.focus("#chatInput");
await page.keyboard.insertText("Hello BeeZilla, can you help me plan my week?");
await page.keyboard.press("Enter");
await page.waitForSelector(".wb-k-chat", { timeout: 20000 });
await page.waitForTimeout(1000);

// 1. the strips
const strips = await page.evaluate(() => [...document.querySelectorAll(".wb-k-chat > .bz-rs")].map((h) => h.getAttribute("data-edge")).sort().join(" "));
check("the conversation has a strip on every side and corner", strips === "e n ne nw s se sw w", strips);
check("one corner is a button you can Tab to, with a name", await page.evaluate(() => {
  const m = document.querySelectorAll(".wb-k-chat > .bz-rs[tabindex='0']");
  return m.length === 1 && m[0].getAttribute("role") === "button" && /Resize the conversation/.test(m[0].getAttribute("aria-label"));
}));
check("the corner wears a grip", await page.evaluate(() => getComputedStyle(document.querySelector(".wb-k-chat > .bz-rs-se"), "::before").content !== "none"));
check("the strips show the right pointer", await page.evaluate(() => {
  const c = (e) => getComputedStyle(document.querySelector(".wb-k-chat > .bz-rs-" + e)).cursor;
  return c("e") === "ew-resize" && c("w") === "ew-resize" && c("n") === "ns-resize" && c("s") === "ns-resize" && c("se") === "nwse-resize" && c("nw") === "nwse-resize" && c("ne") === "nesw-resize" && c("sw") === "nesw-resize";
}));

let start = await card();
check("it opens at 360 x 480", near(start.w, 360) && near(start.h, 480), JSON.stringify(start));

// the card still moves by its bar (the strips did not take that over), and its room is below
await drag(".wb-k-chat .wb-chat-bar", 40, 150);
let moved = await card();
check("the card still moves by its title bar, and keeps its size", near(moved.x, start.x + 40, 2) && near(moved.y, start.y + 150, 2) && near(moved.w, 360) && near(moved.h, 480), JSON.stringify([start, moved]));
start = moved;
await page.mouse.click(1100, 700);   // empty board: nothing selected

// 2. at 100%: the corner, each side, the other corners
await drag(H("se"), 120, 60);
let c = await card();
check("dragging the corner changes the card by exactly the distance moved (+120, +60)", near(c.w, start.w + 120) && near(c.h, start.h + 60) && near(c.x, start.x) && near(c.y, start.y), JSON.stringify(c));
check("a drag does not select the card or move it", !c.sel && near(c.x, start.x) && near(c.y, start.y));
await shot("resize-card-bigger");

const a = await card();
await drag(H("e"), 80, 0);
c = await card();
check("the right side changes the width only", near(c.w, a.w + 80) && near(c.h, a.h) && near(c.x, a.x), JSON.stringify(c));
await drag(H("s"), 0, -40);
c = await card();
check("the bottom side changes the height only (and can make it smaller)", near(c.h, a.h - 40) && near(c.w, a.w + 80), JSON.stringify(c));

const b = await card();
await drag(H("w"), -70, 0);
c = await card();
check("the left side grows the card leftward and keeps the right edge where it was", near(c.w, b.w + 70) && near(c.x, b.x - 70) && near(c.x + c.w, b.x + b.w), JSON.stringify([b, c]));
const b2 = await card();
await drag(H("n"), 0, -30);
c = await card();
check("the top side grows the card upward and keeps the bottom edge where it was", near(c.h, b2.h + 30) && near(c.y, b2.y - 30) && near(c.y + c.h, b2.y + b2.h), JSON.stringify([b2, c]));
const b3 = await card();
await drag(H("nw"), -20, -20);
c = await card();
check("the top-left corner moves the corner and keeps the opposite one", near(c.x + c.w, b3.x + b3.w) && near(c.y + c.h, b3.y + b3.h) && near(c.w, b3.w + 20) && near(c.h, b3.h + 20), JSON.stringify([b3, c]));
const b4 = await card();
await drag(H("ne"), 25, -25);
c = await card();
check("the top-right corner moves the top and the right and keeps the bottom-left", near(c.x, b4.x) && near(c.y + c.h, b4.y + b4.h) && near(c.w, b4.w + 25) && near(c.h, b4.h + 25), JSON.stringify([b4, c]));
const b5 = await card();
await drag(H("sw"), -25, 25);
c = await card();
check("the bottom-left corner keeps the top-right", near(c.x + c.w, b5.x + b5.w) && near(c.y, b5.y) && near(c.w, b5.w + 25) && near(c.h, b5.h + 25), JSON.stringify([b5, c]));

// 3. the smallest size, and no drift once it is reached
const big = await card();
await drag(H("e"), -2000, 0);
c = await card();
check("it stops at its smallest width (260)", near(c.w, 260), String(c.w));
await drag(H("w"), 2000, 0);
c = await card();
check("pulling the left side all the way in stops at the smallest width and the right edge never moves", near(c.w, 260) && near(c.x + c.w, big.x + 260), JSON.stringify([big, c]));
await drag(H("s"), 0, -2000);
c = await card();
check("it stops at its smallest height (220)", near(c.h, 220), String(c.h));

// 4. Esc takes a drag back and does nothing else
const before = await card();
await drag(H("se"), 90, 90, { esc: true });
c = await card();
check("Esc, while dragging, puts the card back as it was", near(c.w, before.w) && near(c.h, before.h), JSON.stringify([before, c]));
check("…and nothing else closed or changed (the board is still open, the conversation still there)", await page.evaluate(() => !!document.querySelector(".wb-k-chat .bubble.me") && !document.getElementById("obBoard").classList.contains("hidden")));
await page.mouse.move(10, 10);

// 5. saved in the card, through undo, and back to the default
await page.waitForTimeout(500);
const inData = await saved();
check("the new size is in the card's saved data", inData && near(inData.w, before.w, 1) && near(inData.h, before.h, 1), JSON.stringify(inData));
// …and the account has it too (the board goes up a moment after a change)
await page.waitForTimeout(2800);
const account = await page.evaluate(async () => {
  const id = localStorage.getItem("bz_session_id") || "talk";
  const r = await fetch("/api/buzzy/whiteboards/" + encodeURIComponent(id), { credentials: "same-origin" });
  const j = await r.json().catch(() => null);
  const find = (o) => {
    if (!o || typeof o !== "object") return null;
    if (o.id === "chat" && o.kind === "chat") return o;
    for (const v of Object.values(o)) { const f = find(v); if (f) return f; }
    return null;
  };
  const c = find(j);
  return c ? { w: c.w, h: c.h } : { status: r.status };
});
check("the account's copy of the board has the new size too", account && near(account.w, before.w, 1) && near(account.h, before.h, 1), JSON.stringify(account));
await drag(H("se"), 50, 50);
const grown = await card();
await page.mouse.click(1000, 500);   // empty board: the board has the keyboard, nothing is selected
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
c = await card();
check("undo puts the size back (the card is drawn again from the saved data)", near(c.w, before.w) && near(c.h, before.h) && !near(c.w, grown.w), JSON.stringify({ before, grown, c }));
check("the strips are back after the card was drawn again", await page.evaluate(() => document.querySelectorAll(".wb-k-chat > .bz-rs").length === 8));
await drag(H("se"), 70, 30);
await page.dblclick(H("se"));
await page.waitForTimeout(300);
c = await card();
check("a double-click on the corner puts the card back at 360 x 480", near(c.w, 360) && near(c.h, 480), JSON.stringify(c));
await page.waitForTimeout(500);
const reset = await saved();
check("…and the saved data forgets the size", reset && reset.w === undefined && reset.h === undefined, JSON.stringify(reset));

// 6. the keyboard (with the card selected: the board's own arrow-key nudge would move it)
await page.click(".wb-k-chat .wb-chat-bar", { position: { x: 230, y: 12 } });
const kb0 = await card();
check("the card is selected", kb0.sel);
await page.focus(".wb-k-chat > .bz-rs[tabindex='0']");
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowDown");
c = await card();
check("arrow keys on the corner change the size (+16 each)", near(c.w, 376) && near(c.h, 496), JSON.stringify(c));
await page.keyboard.press("Shift+ArrowRight");
await page.keyboard.press("ArrowLeft");
c = await card();
check("Shift moves by more (+64), left makes it smaller", near(c.w, 376 + 64 - 16), String(c.w));
check("the board's own arrow-key nudge did not also move the card", near(c.x, kb0.x) && near(c.y, kb0.y), JSON.stringify([kb0, c]));
await page.keyboard.press("Home");
c = await card();
check("Home puts it back at 360 x 480", near(c.w, 360) && near(c.h, 480), JSON.stringify(c));

// 7. a plain click changes nothing and selects nothing
await page.mouse.click(1000, 500);
check("a click on empty board deselects it", !(await card()).sel);
await page.click(H("e"));
c = await card();
check("a click on a strip changes nothing and selects nothing", near(c.w, 360) && near(c.h, 480) && !c.sel, JSON.stringify(c));

// 2b. zoomed: the sums are in the card's own pixels
for (let i = 0; i < 3; i++) { await page.locator(".wb-zbtn").first().click(); await page.waitForTimeout(80); }   // zoom out
const z = await page.evaluate(() => {
  const n = document.querySelector(".wb-k-chat");
  return n.getBoundingClientRect().width / n.offsetWidth;
});
check("the board is zoomed out (the card draws smaller than it is)", z < 0.8, String(z));
const zs = await card();
await drag(H("se"), 60, 40);
c = await card();
check("zoomed to " + Math.round(z * 100) + "%, a 60 x 40 pull on the screen is " + Math.round(60 / z) + " x " + Math.round(40 / z) + " on the card", near(c.w, zs.w + 60 / z, 3) && near(c.h, zs.h + 40 / z, 3), JSON.stringify({ zs, c, z }));
await page.dblclick(H("se"));
await page.locator(".wb-zlabel").click();   // back to 100%
await page.waitForTimeout(100);

// 8. the board
const board0 = await page.evaluate(() => document.getElementById("obBoard").offsetHeight);
check("the Idea Board has a strip along its bottom edge", !!(await centre("#obBoard > .bz-rs-s")));
await drag("#obBoard > .bz-rs-s", 0, 90);
const board1 = await page.evaluate(() => document.getElementById("obBoard").offsetHeight);
check("pulling the board's bottom edge down makes it taller by exactly that", near(board1, board0 + 90), `${board0} -> ${board1}`);
await shot("resize-board-taller");
await drag("#obBoard > .bz-rs-s", 0, -2000);
const board2 = await page.evaluate(() => document.getElementById("obBoard").offsetHeight);
check("…and it stops at its smallest height (360)", near(board2, 360), String(board2));
await drag("#obBoard > .bz-rs-s", 0, 120);
const board3 = await page.evaluate(() => document.getElementById("obBoard").offsetHeight);
// The conversation card's size is part of the board's data, not this browser's, so a reload
// must draw the card at the size it was left at. Grown here, read again below.
await drag(H("se"), 80, 40);
const keptCard = await card();
await page.reload({ waitUntil: "load" });
await page.waitForSelector("#chatInput:not([disabled])", { timeout: 30000 });
await page.focus("#chatInput");
await page.keyboard.insertText("again");
await page.keyboard.press("Enter");
await page.waitForSelector("#obBoard:not(.hidden) .wb-panel", { timeout: 20000 });
await page.waitForTimeout(800);
const board4 = await page.evaluate(() => document.getElementById("obBoard").offsetHeight);
check("the board is the height you left it at, on the next visit", near(board4, board3), `${board3} vs ${board4}`);
const cardBack = await card();
check("the conversation card comes back at the size you left it, after a reload", cardBack && near(cardBack.w, keptCard.w) && near(cardBack.h, keptCard.h), `${JSON.stringify(keptCard)} -> ${JSON.stringify(cardBack)}`);
await page.dblclick(H("se"));
await page.waitForTimeout(150);
const cardReset = await card();
check("…and a double-click after the reload puts it back at 360 x 480", near(cardReset.w, 360) && near(cardReset.h, 480), JSON.stringify(cardReset));
await page.dblclick("#obBoard > .bz-rs-s");
await page.waitForTimeout(150);
check("a double-click on its bottom edge puts it back", await page.evaluate(() => !document.getElementById("obBoard").style.height));

// 9. History
await page.locator(".wb-zbtn").nth(3).click();   // the clock: earlier versions of this board
await page.waitForSelector(".wb-history:not([hidden])", { timeout: 5000 });
await page.waitForTimeout(300);
const hs = await page.evaluate(() => [...document.querySelectorAll(".wb-history > .bz-rs")].map((h) => h.getAttribute("data-edge")).sort().join(" "));
check("History grows from the corner it opens in: strips on its left, top and top-left corner", hs === "n nw w", hs);
const hg = () => page.evaluate(() => { const r = document.querySelector(".wb-history").getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
const h0 = await hg();
await drag(".wb-history > .bz-rs-nw", -90, -60);
const h1 = await hg();
check("pulling its top-left corner out makes it wider and taller, and the corner it is held by does not move", near(h1.w, h0.w + 90) && near(h1.h, h0.h + 60) && near(h1.right, h0.right) && near(h1.bottom, h0.bottom), JSON.stringify([h0, h1]));
await shot("resize-history");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 9b. the step editor: a note on the board opens it
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.locator('.wb-tool[data-tool="note"]').click();
const canvasBox = await page.evaluate(() => { const r = document.querySelector(".wb-canvas").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; });
await page.mouse.click(canvasBox.x + canvasBox.w * 0.45, canvasBox.y + 90);   // high on the board: the editor opens beside it, with room below
await page.waitForSelector(".wb-editor", { timeout: 5000 });
await page.waitForTimeout(250);
const es = await page.evaluate(() => [...document.querySelectorAll(".wb-editor > .bz-rs")].map((h) => h.getAttribute("data-edge")).sort().join(" "));
check("the step editor grows right and down: strips on its right, bottom and bottom-right corner", es === "e s se", es);
const eg = () => page.evaluate(() => { const e = document.querySelector(".wb-editor"); const r = e.getBoundingClientRect(); const t = e.querySelector(".wb-ed-body").getBoundingClientRect(); return { w: r.width, h: r.height, x: r.x, y: r.y, text: t.height }; });
const e0 = await eg();
await drag(".wb-editor > .bz-rs-se", 110, 90);
const e1 = await eg();
check("pulling its corner makes it bigger by exactly that, the corner it is held by stays, and the words get the room", near(e1.w, e0.w + 110) && near(e1.h, e0.h + 90) && near(e1.x, e0.x) && near(e1.y, e0.y) && e1.text > e0.text + 60, JSON.stringify([e0, e1]));
await shot("resize-editor");
await page.click(".wb-editor .wb-btn");   // Close
await page.waitForTimeout(150);
await page.dblclick(".wb-k-note");
await page.waitForSelector(".wb-editor", { timeout: 5000 });
await page.waitForTimeout(250);
const e2 = await eg();
check("opened again, the editor has the size it was given", near(e2.w, e1.w) && near(e2.h, e1.h), JSON.stringify([e1, e2]));
await page.click(".wb-editor .wb-btn");

// 10. Feedback
await page.locator("#bzChrome button.bz-ask").first().click();
await page.waitForSelector("#bzFeedback.open", { timeout: 5000 });
await page.waitForTimeout(300);
const fs = await page.evaluate(() => [...document.querySelectorAll("#bzFeedback > .bz-rs")].map((h) => h.getAttribute("data-edge")).sort().join(" "));
check("Feedback hangs from its top right corner: strips on its left, bottom and bottom-left corner", fs === "s sw w", fs);
const fg = () => page.evaluate(() => { const r = document.getElementById("bzFeedback").getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right, top: r.top }; });
const f0 = await fg();
await drag("#bzFeedback > .bz-rs-sw", -120, 100);
const f1 = await fg();
check("pulling its bottom-left corner out makes it wider and taller, and the corner it hangs from stays put", near(f1.w, f0.w + 120) && near(f1.h, f0.h + 100) && near(f1.right, f0.right) && near(f1.top, f0.top), JSON.stringify([f0, f1]));
await shot("resize-feedback");
await page.click("#bzFeedback .bz-panel-min");
await page.waitForTimeout(200);
const folded = await page.evaluate(() => {
  const p = document.getElementById("bzFeedback");
  return { cls: p.className, w: p.getBoundingClientRect().width, inline: p.style.width, strips: getComputedStyle(p.querySelector(".bz-rs")).display };
});
check("folded up, Feedback is the small pill again: none of the size, no strips", /\bmin\b/.test(folded.cls) && folded.w < 320 && folded.inline === "" && folded.strips === "none", JSON.stringify(folded));
await page.click("#bzFeedback .bz-panel-min");
await page.waitForTimeout(250);
const unfolded = await page.evaluate(() => {
  const p = document.getElementById("bzFeedback");
  return { cls: p.className, w: p.getBoundingClientRect().width, strips: getComputedStyle(p.querySelector(".bz-rs")).display };
});
check("unfolded, it has the size you gave it and its strips back", !/\bmin\b/.test(unfolded.cls) && near(unfolded.w, f1.w, 2) && unfolded.strips !== "none", JSON.stringify([unfolded, f1]));

// 11. a phone: the board is as tall as its page needs, so it has no strip and keeps no height
await page.evaluate(() => document.getElementById("bzFeedback").classList.remove("open"));
await drag("#obBoard > .bz-rs-s", 0, 60);
const tall = await page.evaluate(() => document.getElementById("obBoard").style.height);
check("a height was set on a wide window", /px$/.test(tall), tall);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const phone = await page.evaluate(() => ({ inline: document.getElementById("obBoard").style.height, strip: getComputedStyle(document.querySelector("#obBoard > .bz-rs-s")).display }));
check("on a phone the Idea Board has no strip and none of that height", phone.inline === "" && phone.strip === "none", JSON.stringify(phone));
await page.setViewportSize({ width: 1500, height: 1400 });
await page.waitForTimeout(400);
check("back on a wide window it has its height again", await page.evaluate((t) => document.getElementById("obBoard").style.height === t, tall));

// 12. the 3D painter's window (model-paint.js): Esc, while dragging its corner, takes the drag back and does not
// close it; it never gets smaller than the canvas, tools and button need. (A model that cannot be read still
// opens the window, with its message: that is all this needs.)
await page.evaluate(() => window.BeeZillaWhiteboard.current().addCard({ kind: "model", title: "Resize test model.glb", url: "/api/buzzy/assets/987654", contentType: "model/gltf-binary", user: true }));
await page.waitForTimeout(500);
await page.locator(".wb-card.wb-k-model .wb-paint3d").evaluate((b) => b.click());
await page.waitForSelector(".mp-box > .bz-rs-se", { timeout: 15000 });
const pw = () => page.evaluate(() => { const b = document.querySelector(".mp-box"); return { w: b.offsetWidth, h: b.offsetHeight }; });
const p0 = await pw();
await drag(".mp-box > .bz-rs-se", -160, -120, { esc: true });
await page.waitForTimeout(150);
const p1 = await pw();
check("Esc, while dragging the 3D painter's corner, takes the drag back and does not close the window", p1.w === p0.w && p1.h === p0.h && !!(await page.$(".mp-dialog")), JSON.stringify([p0, p1]));
await drag(".mp-box > .bz-rs-se", -2000, -2000);
const p2 = await pw();
check("…and pulled as small as it goes it is still big enough to use (480 × 480)", p2.w >= 480 && p2.h >= 480, JSON.stringify(p2));
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Esc, with no drag, closes it", !(await page.$(".mp-dialog")));

check("no script errors", errors.length === 0, errors.join(" | "));
await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failed ? `\n${failed} of ${total} checks failed` : `\nVERDICT: PASS (${total} checks)`);
process.exit(failed ? 1 : 0);
