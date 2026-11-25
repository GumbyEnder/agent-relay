// BeeZilla sees what the owner sees on the Idea Board (owner, 21 Nov 2026: "it could
// hover over something or grab something and say, what do I do with this?… And it
// knows what this or that is"). On the real Talk page:
//   1. Hover a card and type "what is this?": the turn carries the board as seen, with
//      that card under the pointer as "this", and BeeZilla's reply names it.
//   2. Hold a card mid-drag while speaking starts (the hooks the microphone calls, see
//      talk.html bzSpeechHeard / bzFreezeView), then ask "what do I do with this?": the
//      view frozen as speech started carries the held card, and the reply names it.
//   3. Rest on a card, cross another on the way to the Send button and click it: "this"
//      is the card rested on, not the one crossed.
//   4. Drag a card in from elsewhere on the page over the board: it is what "this" means.
//   5. "make this bigger" over a card: BeeZilla's board step zooms to that card.
// usage: node scripts/probe-board-view.mjs [origin]      (BZ_PROBE_CDP=<DevTools URL> to reuse a browser)
//   Steps 1–2 and 5 need a working chat model on the server; BZ_PROBE_NO_MODEL=1 checks
//   only what the turn carries. BZ_PROBE_DUMP=<file> appends each turn's message, view,
//   reply and board steps to that file (JSON lines), to read what BeeZilla was given. Sign-in as in probe-soft-nav.mjs (BZ_PROBE_COOKIE, or the dev
//   magic-link inbox at BZ_MAIL_LOG).
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const MODEL = !process.env.BZ_PROBE_NO_MODEL;

async function devSignIn() {
  const email = `probe-view-${Date.now().toString(36)}@test.local`;
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{
  name: cookie.slice(0, eqAt), value: cookie.slice(eqAt + 1),
  domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
}]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit

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
await page.evaluate(() => window.BeeZillaWhiteboard.current().addGraph({ nodes: [
  { id: "cake", kind: "note", title: "Grandma's lemon drizzle cake", body: "200 g butter, 200 g sugar, 4 eggs, 2 lemons. Bake 45 minutes at 180 °C.", x: 0, y: 0 },
  { id: "bake", kind: "skill", title: "Bake the sponge", body: "Mix, pour into a lined tin, bake.", x: 340, y: 0 },
  { id: "shop", kind: "note", title: "Shopping list", body: "lemons, caster sugar, icing sugar", x: 0, y: 260 },
  { id: "post", kind: "output", title: "Bake sale poster", body: "An A4 poster for Saturday's bake sale.", x: 680, y: 0 },
], links: [{ from: "cake", to: "bake" }] }));
await page.waitForTimeout(700);
await page.evaluate(() => { window.BeeZillaWhiteboard.current().fit(); });
await page.waitForTimeout(500);

const centre = (title) => page.evaluate((t) => {
  const n = [...document.querySelectorAll(".wb-world > .wb-card")].find((c) => (c.getAttribute("aria-label") || "").endsWith(": " + t));
  if (!n) return { missing: [...document.querySelectorAll(".wb-world > .wb-card")].map((c) => c.getAttribute("aria-label")) };
  const r = n.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40), id: n.getAttribute("data-id") };
}, title);

// One turn: what it carried to the server, and BeeZilla's answer.
async function turn(send) {
  const req = page.waitForRequest((r) => r.url().endsWith("/api/buzzy/chat") && r.method() === "POST", { timeout: 20000 });
  await send();
  const request = await req;
  const body = JSON.parse(request.postData() || "{}");
  let reply = "", actions = [];
  if (MODEL) {
    const res = await request.response();
    const text = res ? await res.text().catch(() => "") : "";
    // Server-sent events; the last "done" carries the whole answer.
    for (const block of text.split("\n\n")) {
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev === "done" && data) { try { const d = JSON.parse(data); reply = d.reply || ""; actions = d.actions || []; } catch { /* not JSON */ } }
    }
    if (!reply && text.trim().startsWith("{")) { try { const d = JSON.parse(text); reply = d.reply || ""; actions = d.actions || []; } catch { /* not JSON */ } }
    await page.waitForFunction(() => !document.getElementById("thinkingIndicator"), null, { timeout: 180000 }).catch(() => {});
  }
  if (process.env.BZ_PROBE_DUMP) { const fs = await import("node:fs"); fs.appendFileSync(process.env.BZ_PROBE_DUMP, JSON.stringify({ message: body.message, view: body.boardView, reply, actions }) + "\n"); }
  return { view: body.boardView, reply, actions };
}
async function typeAndEnter(words) {
  await page.focus("#chatInput");
  await page.keyboard.type(words, { delay: 15 });
  await page.keyboard.press("Enter");
}
const said = (reply, re) => re.test(String(reply || "").replace(/[’‘]/g, "'"));

// 1. Hover a card, ask "what is this?".
{
  const c = await centre("Grandma's lemon drizzle cake");
  if (c.missing) console.log("cards on the board:", JSON.stringify(c.missing));
  await page.mouse.move(c.x - 40, c.y + 40);
  await page.mouse.move(c.x, c.y, { steps: 6 });
  await page.waitForTimeout(600);
  const { view, reply } = await turn(() => typeAndEnter("what is this?"));
  check("hover + \"what is this?\": the turn carries the board as seen", !!view && view.v === 1 && view.open === true && view.items.length >= 4, JSON.stringify(view)?.slice(0, 300));
  check("…with the hovered card under the pointer as \"this\"", view?.focus?.id === c.id && view.focus.why === "under the pointer", JSON.stringify(view?.focus));
  if (MODEL) check("BeeZilla's reply names it (the lemon drizzle cake)", said(reply, /lemon drizzle|lemon cake|grandma/i), reply.slice(0, 400));
  console.log("      reply:", JSON.stringify(reply.slice(0, 300)));
}

// 2. Hold a card mid-drag while speaking starts, then ask "what do I do with this?".
{
  const c = await centre("Shopping list");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 30, { steps: 5 });
  // What the microphone does as the person starts talking (talk.html: the first loud
  // frame calls markSpeech, the first words in the box call freezeView).
  await page.evaluate(() => { window.BeeZillaWhiteboard.markSpeech(); window.BeeZillaWhiteboard.freezeView("speaking"); });
  await page.mouse.move(c.x + 120, c.y + 60, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(20, 20);          // the pointer leaves: what counts is the moment they spoke
  const { view, reply } = await turn(() => typeAndEnter("what do I do with this?"));
  check("held while speaking: the view frozen as speech started goes with the turn", view?.why === "speaking", JSON.stringify(view && { why: view.why, ageMs: view.ageMs }));
  check("…and \"this\" is the card being held", view?.focus?.id === c.id && view.focus.why === "holding" && view.held?.how === "moving it", JSON.stringify({ focus: view?.focus, held: view?.held }));
  if (MODEL) check("BeeZilla's reply is about the shopping list", said(reply, /shopping list|lemons|icing sugar|caster sugar/i), reply.slice(0, 400));
  console.log("      reply:", JSON.stringify(reply.slice(0, 300)));
}

// 3. Rest on a card, cross another on the way to the Send button, click Send.
{
  const rest = await centre("Bake the sponge");
  const cross = await centre("Bake sale poster");
  await page.mouse.move(rest.x, rest.y, { steps: 4 });
  await page.waitForTimeout(700);
  await page.focus("#chatInput");
  await page.keyboard.type("how do I do that?", { delay: 10 });
  const send = await page.evaluate(() => { const r = document.getElementById("chatSend").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(cross.x, cross.y, { steps: 3 });
  const { view } = await turn(async () => { await page.mouse.move(send.x, send.y, { steps: 3 }); await page.mouse.down(); await page.mouse.up(); });
  check("clicked Send after resting on a card: \"this\" is the card rested on, not the one crossed", view?.focus?.id === rest.id && view.focus.why === "last pointed at", JSON.stringify(view?.focus));
}

// 4. Something dragged in from elsewhere on the page, over the board.
{
  const r = await page.evaluate(() => {
    const src = document.createElement("img");
    src.alt = "Sunset over Lisbon";
    src.src = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    src.draggable = true;
    document.body.appendChild(src);
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const canvas = document.querySelector(".wb-canvas");
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 200, clientY: box.top + 200 }));
    const v = window.BeeZillaWhiteboard.seeing();
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    src.remove();
    return { focus: v.focus, incoming: v.incoming, after: window.BeeZillaWhiteboard.seeing().incoming || null };
  });
  check("a picture dragged in from the page: it is what \"this\" means while it is over the board", r.focus?.id === "incoming" && r.incoming?.title === "Sunset over Lisbon" && r.incoming.over === true && r.incoming.kind === "Picture", JSON.stringify(r));
  check("…and it is gone once the drag ends", r.after === null, JSON.stringify(r.after));
}

// 5. "make this bigger" over a card: the board zooms to it.
if (MODEL) {
  await page.evaluate(() => window.BeeZillaWhiteboard.current().fit());   // BeeZilla's own cards may have pushed it out of view
  await page.waitForTimeout(700);
  const c = await centre("Bake sale poster");
  await page.mouse.move(c.x, c.y, { steps: 4 });
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => Number((/scale\(([\d.]+)\)/.exec(document.querySelector(".wb-world").style.transform) || [0, 1])[1]));
  const { actions } = await turn(() => typeAndEnter("make this bigger"));
  check("\"make this bigger\" is a board step about \"this\"", actions.some((a) => a.do === "board" && a.value === "enlarge" && a.target === "this"), JSON.stringify(actions));
  await page.waitForTimeout(2500);
  const after = await page.evaluate((id) => {
    const n = document.querySelector('.wb-card[data-id="' + id + '"]');
    const c = document.querySelector(".wb-canvas").getBoundingClientRect();
    const r = n.getBoundingClientRect();
    return { z: Number((/scale\(([\d.]+)\)/.exec(document.querySelector(".wb-world").style.transform) || [0, 1])[1]), centred: Math.abs(r.left + r.width / 2 - (c.left + c.width / 2)) < c.width / 4, selected: n.classList.contains("wb-on") };
  }, c.id);
  check("…and the board zooms in on that card", after.z > before * 1.3 && after.centred && after.selected, JSON.stringify({ before, after }));
}

await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall board-view checks passed");
process.exit(failures ? 1 : 0);
