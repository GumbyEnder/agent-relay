// The Talk button keeps its size however much is typed or pasted (owner, 2026-11-22):
//   "the talk to it button gets larger the more text I put in the text field, especially
//    when I copy and paste a large amount. It really goes out of proportion. Massive
//    button, little text. Maybe we just pin the button to the top of it and allow the
//    text box to grow without growing the button."
// Before: the bar stretched every part to the box's height, so pasting a long email made
// the hexagon button 3 times as tall (57px → 176px) while the box showed 6 lines.
//
// This drives a real browser against a running build and holds the page to:
//   1. The Talk button, the paper clip and privacy keep the height of ONE line of the box
//      for every length of text (typed line by line, pasted whole, pasted huge), and sit
//      level with the box's top.
//   2. The box grows by itself, never past its limit (38% of the window, 30% on the board's
//      top edge), then scrolls; the whole bar stays inside the window.
//   3. Clearing the box puts every size back exactly where it started.
//   4. The limit follows the window's height.
//   5. A long text typed on the page and carried onto the board (See board) is fitted again
//      in the board's narrower top edge, and the title and buttons beside it stay level
//      with the first line.
//   6. A phone: the same, with the button an icon.
//
// usage: node scripts/probe-talk-box.mjs [origin]      (BZ_PROBE_CDP=<DevTools URL> to reuse a browser)
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
  const email = `probe-talkbox-${Date.now().toString(36)}@test.local`;
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

const results = [];
let failed = 0;
const check = (name, ok, detail) => {
  results.push({ name, ok });
  if (ok) console.log("ok   ", name);
  else { failed++; console.log("FAIL ", name, detail ? "— " + detail : ""); }
};
const near = (a, b, tol = 0.75) => Math.abs(a - b) <= tol;

const PARA = "Here is a paragraph that I copied from an email thread and pasted in whole, because I want BeeZilla to read all of it before answering me. ";
const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: ` + PARA).join("\n");
const HUGE = Array.from({ length: 400 }, (_, i) => `Row ${i + 1}: ` + PARA).join("\n");

async function open(viewport) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{
    name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
    domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
  }]);
  const page = await context.newPage();
  await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
  await page.waitForSelector("#chatInput:not([disabled])", { timeout: 30000 });
  await page.waitForTimeout(1200);
  return { context, page, errors };
}

// Where each part of the bar is, in pixels.
const geometry = (page) => page.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom };
  };
  const input = document.getElementById("chatInput");
  const bar = document.getElementById("talkBar");
  return {
    bar: box(bar),
    btn: box(document.getElementById("micBtn")),
    field: box(document.querySelector(".talk-field")),
    input: box(input),
    extras: box(document.querySelector(".talk-extras")),
    send: bar.classList.contains("has-text") ? box(document.getElementById("chatSend")) : null,
    title: box(document.querySelector(".wb-title")),
    tools: box(document.querySelector(".wb-tools")),
    maxPx: parseFloat(getComputedStyle(input).maxHeight),
    scrolls: input.scrollHeight > input.clientHeight + 1,
    grown: bar.classList.contains("is-grown"),
    innerHeight: window.innerHeight,
  };
});
const paste = async (page, text) => {
  await page.fill("#chatInput", "");
  await page.focus("#chatInput");
  await page.keyboard.insertText(text);   // what a paste does: one input event with all the text
  await page.waitForTimeout(250);
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

// ── 1–4: the page's Talk bar, desktop ───────────────────────────────────────────────────
{
  const { context, page, errors } = await open({ width: 1366, height: 800 });
  const empty = await geometry(page);
  check("the bar starts as one line", empty.field.h < 70 && !empty.grown, JSON.stringify(empty.field));

  // typed line by line: the button never changes, the box grows a line at a time
  let btnMoved = "", prev = empty.field.h, monotone = true, topLevel = true;
  await page.focus("#chatInput");
  for (let i = 1; i <= 14; i++) {
    await page.keyboard.insertText("A line of words " + i);
    await page.keyboard.press("Shift+Enter");
    const g = await geometry(page);
    if (!near(g.btn.h, empty.btn.h) || !near(g.btn.w, empty.btn.w) || !near(g.btn.y, empty.btn.y)) btnMoved += ` line ${i}: ${g.btn.w}x${g.btn.h}@${g.btn.y}`;
    if (g.field.h + 0.75 < prev) monotone = false;
    prev = g.field.h;
    if (!near(g.btn.y, g.field.y) || !near(g.extras.y, g.field.y)) topLevel = false;
  }
  check("typing line by line never changes the Talk button's size or place" + (btnMoved ? " (" + btnMoved + ")" : ""), btnMoved === "");
  check("the box only gets taller while lines are added", monotone);
  check("the button and the paper clip stay level with the top of the box", topLevel);

  // a long paste
  await paste(page, LONG);
  const long = await geometry(page);
  await shot(page, "talk-box-long");
  check("a 40-line paste leaves the button exactly as tall as one line", near(long.btn.h, empty.btn.h) && near(long.btn.w, empty.btn.w), `${long.btn.w}x${long.btn.h} vs ${empty.btn.w}x${empty.btn.h}`);
  check("…and the paper clip row too", near(long.extras.h, empty.extras.h) && near(long.extras.y, empty.btn.y));
  check("…the Send arrow stays on the first line", long.send && long.send.y + long.send.h <= long.btn.b + 1, JSON.stringify(long.send));
  check("the box grew well past one line", long.field.h > empty.field.h * 4, `${long.field.h} vs ${empty.field.h}`);
  check("the box stops at its limit (38% of the window) and scrolls", long.input.h <= long.maxPx + 32 && long.scrolls, `${long.input.h} vs max ${long.maxPx}`);
  check("the limit is about 38% of the window", near(long.maxPx, Math.min(Math.max(long.innerHeight * 0.38, 144), 320), 1.5), `${long.maxPx} for a ${long.innerHeight}px window`);
  check("the whole bar fits in the window", long.bar.b < long.innerHeight, `bar bottom ${long.bar.b}`);
  check("the bar becomes a rounded box, not a pill that cuts into the words", await page.evaluate(() => {
    const r = parseFloat(getComputedStyle(document.getElementById("talkBar")).borderTopLeftRadius);
    return r > 0 && r < 60;
  }));

  // a huge paste: the same
  await paste(page, HUGE);
  const huge = await geometry(page);
  check("a 400-line paste is no different (same limit, same button)", near(huge.btn.h, empty.btn.h) && near(huge.field.h, long.field.h, 1.5), `${huge.field.h} vs ${long.field.h}`);
  await shot(page, "talk-box-huge");

  // 4. the limit follows the window's height
  await page.setViewportSize({ width: 1366, height: 520 });
  await page.waitForTimeout(250);
  const short = await geometry(page);
  check("a shorter window lowers the limit and the box follows", short.input.h < huge.input.h - 40 && near(short.maxPx, Math.max(520 * 0.38, 144), 1.5), `${short.input.h} vs ${huge.input.h}`);
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.waitForTimeout(250);

  // 3. clear: everything back where it started
  await paste(page, "");
  const cleared = await geometry(page);
  check("clearing the box puts the bar back exactly as it was", near(cleared.bar.h, empty.bar.h) && near(cleared.field.h, empty.field.h) && near(cleared.btn.h, empty.btn.h) && !cleared.grown, `${cleared.bar.h} vs ${empty.bar.h}`);

  // 5. carried onto the board: typed on the page, then See board
  await paste(page, LONG);
  await page.locator(".ob-see-board").click();
  await page.waitForSelector(".wb-dock #chatInput", { timeout: 15000 });
  await page.waitForTimeout(600);
  const dock = await geometry(page);
  await shot(page, "talk-box-on-board");
  check("on the board the box was fitted again for its narrower place and stops at its limit", dock.grown && dock.scrolls && dock.input.h <= dock.maxPx + 24, JSON.stringify([dock.input.h, dock.maxPx]));
  check("on the board the limit is 30% of the window", near(dock.maxPx, Math.min(Math.max(dock.innerHeight * 0.3, 112), 224), 1.5), `${dock.maxPx}`);
  check("on the board the Talk button is one line tall (not the box's height)", dock.btn.h < 52 && near(dock.btn.y, dock.field.y), `${dock.btn.h}`);
  check("on the board the title and the buttons stay level with the first line", dock.title && dock.tools && dock.title.y < dock.btn.y + 24 && dock.tools.y < dock.btn.y + 24, JSON.stringify([dock.title, dock.tools]));
  check("on the board the bar is a rounded box too", await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("talkBar")).borderTopLeftRadius) < 60));
  await paste(page, "");
  const dockClear = await geometry(page);
  check("on the board, clearing it puts the one-line bar back", !dockClear.grown && near(dockClear.btn.h, dock.btn.h) && dockClear.field.h < 60, `${dockClear.field.h}`);
  check("no script errors", errors.length === 0, errors.join(" | "));
  await context.close();
}

// ── 6: a phone ──────────────────────────────────────────────────────────────────────────
{
  const { context, page, errors } = await open({ width: 390, height: 844 });
  const empty = await geometry(page);
  await paste(page, LONG);
  const long = await geometry(page);
  await shot(page, "talk-box-phone");
  check("phone: the button keeps its size for a 40-line paste", near(long.btn.h, empty.btn.h) && near(long.btn.w, empty.btn.w), `${long.btn.w}x${long.btn.h} vs ${empty.btn.w}x${empty.btn.h}`);
  check("phone: the button stays level with the box's top", near(long.btn.y, long.field.y));
  check("phone: the box grows and stops at its limit", long.field.h > empty.field.h * 3 && long.input.h <= long.maxPx + 28 && long.scrolls, `${long.input.h} vs ${long.maxPx}`);
  check("phone: the paper clip row sits under the box, whole", long.extras.y >= long.field.b - 1 && long.extras.h > 20);
  await paste(page, "");
  const cleared = await geometry(page);
  check("phone: clearing puts the bar back", near(cleared.bar.h, empty.bar.h) && !cleared.grown, `${cleared.bar.h} vs ${empty.bar.h}`);
  check("phone: no script errors", errors.length === 0, errors.join(" | "));
  await context.close();
}

if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nVERDICT: PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
