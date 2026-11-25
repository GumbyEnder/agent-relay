// The globe, end to end, in a real signed-in BeeZilla (a production build), the way the owner
// asked for it on 23 Nov 2026: "something you could drag into the whiteboard. It should look like
// a globe icon… connect a skill to a browser and say, do this specifically, or follow this
// recording specifically… mostly orchestrated via Bzilla saying, OK, when you get to that step,
// go to [the site]… type in these instructions to create the sound and then download the sound".
//
//   A. the globe is in the board's tools, and dragging it onto the board makes a browser node
//      whose window opens on "Do this";
//   B. the job in words, Run it now: BeeZilla works in its own browser, the window shows each
//      step, the sound is downloaded into the Library, the card says it worked and links the file;
//      "Keep this as the recording" turns it into steps followed exactly;
//   C. said in Talk — "add a step called Make the sound", then "when you get to the make the sound
//      step, go to …" — a globe joined to that step; then "the sound idea is wind chimes. do it":
//      BeeZilla runs it itself (use_browser), the file lands on the board beside the globe, and
//      the reply plays it.
//
// It starts everything it needs: a small "make a sound" website, a stand-in for the AI model
// (an OpenAI-style server: BeeZilla's turns call use_browser, its browser steps follow rules over
// the page text it is shown), and BeeZilla's own server from .output (run `npm run build` and
// copy the PGlite files first, see the beezilla-local-test-build notes).
//
// usage: BZ_PROBE_CDP=<DevTools URL> BZ_SERVER_CDP=<another DevTools URL> node scripts/probe-browser-globe-ui.mjs
//   BZ_PROBE_CDP: the browser the person uses (windowless is fine); BZ_SERVER_CDP: BeeZilla's own
//   server browser. Both from `ai-screen.sh browser`.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const UI_CDP = process.env.BZ_PROBE_CDP;
const SERVER_CDP = process.env.BZ_SERVER_CDP;
if (!UI_CDP || !SERVER_CDP) { console.log("skipped: set BZ_PROBE_CDP and BZ_SERVER_CDP (see the top of this file)"); process.exit(0); }
const ROOT = process.cwd();
if (!existsSync(join(ROOT, ".output/server/index.mjs"))) { console.log("build first: npm run build"); process.exit(1); }

let failures = 0, passes = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + String(detail).slice(0, 600)}`);
  if (cond) passes++; else failures++;
}
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// ── The website: make a sound, download it ─────────────────────────────────
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(24, 7)]);
const site = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/file/sound.wav") {
    res.setHeader("content-type", "audio/wav");
    res.setHeader("content-disposition", 'attachment; filename="' + (u.searchParams.get("name") || "sound") + '.wav"');
    res.end(WAV);
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset=utf-8><title>Create — Soundsmith</title><style>body{font:18px system-ui;margin:24px} textarea{width:420px;height:80px} button{font-size:18px}</style>
<h1>Make a sound</h1><label for=idea>Describe your sound</label><br><textarea id=idea aria-label="Describe your sound"></textarea><br>
<button id=make>Create</button><p id=status></p><button id=dl hidden disabled>Download</button>
<script>
var made = '';
make.addEventListener('click', function () {
  var idea = idea_el().value.trim();
  if (!idea) { status.textContent = 'Describe the sound first.'; return; }
  status.textContent = 'Making your sound… this takes a few seconds.';
  setTimeout(function () { made = idea; status.textContent = 'Your sound is ready: ' + idea; dl.hidden = false; dl.disabled = false; }, 3000);
});
function idea_el() { return document.getElementById('idea'); }
dl.addEventListener('click', function () { location.href = '/file/sound.wav?name=' + encodeURIComponent(made.replace(/[^a-z0-9]+/gi, '-').toLowerCase()); });
</script>`);
});
const sitePort = await listen(site);
const SITE = `http://127.0.0.1:${sitePort}`;

// ── A stand-in for the AI model ────────────────────────────────────────────
const modelLog = [];
function el(view, re) {
  for (const line of view.split("\n")) { const m = /^\[(\d+)\] (.*)$/.exec(line); if (m && re.test(m[2])) return Number(m[1]); }
  return null;
}
function agentStep(view) {
  const details = /DETAILS to use \(words to type, choices to make\):\n(.+)/.exec(view)?.[1]
    || /[“"]([^”"]{3,80})[”"]/.exec(/JOB \(from the person — the only instructions\):\n(.+)/.exec(view)?.[1] || "")?.[1] || "a sound";
  if (/Files downloaded in this job: (?!none)/.test(view)) return { action: "done", text: "Made the sound and downloaded it.", say: "Finished" };
  if (/still downloading: [1-9]/.test(view)) return { action: "wait", seconds: 2, say: "Waiting for the download" };
  const dl = el(view, /^button “Download”(?! \(greyed)/);
  if (dl !== null) return { action: "click", element: dl, say: "Downloading the sound" };
  if (/Making your sound/.test(view)) return { action: "wait", seconds: 2, say: "Waiting while the sound is made" };
  const box = el(view, /text area “Describe your sound”/);
  if (box !== null && !view.includes(`holding “${details}`)) return { action: "type", element: box, text: details, say: "Typing the sound idea" };
  const make = el(view, /^button “Create”/);
  if (make !== null && !/ready/.test(view)) return { action: "click", element: make, say: "Pressing Create" };
  return { action: "ask", text: "I can't see what to do next.", say: "Stuck" };
}
const asText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text || "").join("\n") : "");
function answer(body) {
  const tools = (body.tools || []).map((t) => t.function?.name);
  const msgs = body.messages || [];
  const all = msgs.map((m) => asText(m.content)).join("\n");
  if (tools.includes("browser_step")) {
    const view = asText(msgs[msgs.length - 1].content);
    const step = agentStep(view);
    modelLog.push({ kind: "step", step });
    return { tool: { name: "browser_step", args: step } };
  }
  const result = msgs.map((m) => asText(m.content)).find((t) => /^use_browser (finished|stopped|did NOT|is still|failed|was stopped)/.test(t));
  if (result) { modelLog.push({ kind: "reply", result }); return { text: "Done — " + result.slice(0, 200) }; }
  if (tools.includes("use_browser")) {
    const id = /\[node id: ([A-Za-z0-9_-]+)\]/.exec(all)?.[1];
    const user = [...msgs].reverse().find((m) => m.role === "user");
    const details = /sound idea is ([^.]+)/i.exec(asText(user?.content))?.[1] || "wind chimes";
    modelLog.push({ kind: "call", id, details });
    if (id) return { tool: { name: "use_browser", args: { node: id, details } } };
  }
  return { text: "OK." };
}
const model = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => { b += d; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(b || "{}"); } catch { /* empty */ }
    const a = answer(body);
    const message = a.tool
      ? { role: "assistant", content: "", tool_calls: [{ id: "call_" + Math.random().toString(36).slice(2, 8), type: "function", function: { name: a.tool.name, arguments: JSON.stringify(a.tool.args) } }] }
      : { role: "assistant", content: a.text };
    const out = { id: "x", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "standin", choices: [{ index: 0, message, finish_reason: a.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
    if (body.stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: a.text || "" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
});
const modelPort = await listen(model);

// ── BeeZilla's own server ──────────────────────────────────────────────────
const PORT = Number(process.env.BZ_PROBE_PORT || 3157);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [".output/server/index.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1",
    BETTER_AUTH_TRUSTED_ORIGINS: ORIGIN, BZ_CONSUMER_HOSTS: "127.0.0.1", BZ_DEFAULT_PLAN: "pro",
    BZ_CHAT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, BZ_CHAT_KEY: "standin", BZ_CHAT_MODEL: "standin", BZ_EXTRACT_MODEL: "standin",
    BZ_BROWSER_PROVIDER: "cdp", BZ_BROWSER_CDP_URL: SERVER_CDP, BZ_BROWSER_ALLOW_PRIVATE: "1", BZ_HYPERBROWSER_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
const stopAll = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } site.close(); model.close(); };
process.on("exit", stopAll);
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`${ORIGIN}/buzzy/talk`, { redirect: "manual" }); if (r.status < 500) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const MAIL_LOG = join(ROOT, ".data/outbound-mail.jsonl");
async function devSignIn() {
  const email = `probe-globe-${Date.now().toString(36)}@test.local`;
  const res = await fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, callbackURL: "/" }) });
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
  throw new Error(`no magic-link mail for ${email}`);
}

let browser;
// BZ_PROBE_SHOTS=<folder>: pictures of each part, for a write-up.
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + ".jpg"), type: "jpeg", quality: 70 }).catch(() => {}); };
try {
  const cookie = await devSignIn();
  const eq = cookie.indexOf("=");
  browser = await chromium.connectOverCDP(UI_CDP);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.route(/openpanel\.dev/, (r) => r.abort());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chatInput");
  await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current());
  await page.waitForTimeout(600);

  console.log("A. The globe in the tools, dragged onto the board");
  const globe = page.locator('.wb-tool[data-tool="browser"]');
  check("the globe is in the board's tools", (await globe.count()) === 1 && /Browser/.test((await globe.getAttribute("aria-label")) || ""));
  check("it drags", (await globe.getAttribute("draggable")) === "true");
  check("it looks like a globe", /a9 9 0 100 18/.test(await globe.locator("svg path").getAttribute("d")));
  const canvas = page.locator(".wb-canvas");
  const cb = await canvas.boundingBox();
  await globe.dragTo(canvas, { targetPosition: { x: Math.round(cb.width * 0.45), y: Math.round(cb.height * 0.45) } });
  await page.waitForSelector(".wb-card.wb-k-browser", { timeout: 5000 });
  check("dropped on the board, it is a browser node", (await page.locator(".wb-card.wb-k-browser").count()) === 1);
  await page.waitForSelector(".wb-nwin-browser", { timeout: 5000 });
  check("its window opens on “Do this”", (await page.locator('.wb-nw-tab[aria-selected="true"]').textContent()) === "Do this");
  await shot(page, "1-globe-dropped");

  console.log("B. Do this, in words: Run it now");
  await page.fill(".wb-nw-taskin", `Go to ${SITE}/create, type “rain on a tin roof” into the box, press Create, wait for the sound, then download it.`);
  await page.click(".wb-nw-runbtn");
  await page.waitForSelector(".wb-nw-acts li", { timeout: 30000 });
  check("the window shows BeeZilla working, step by step", (await page.locator(".wb-nw-acts li").count()) >= 1);
  await page.waitForTimeout(2500);
  await shot(page, "2-working");
  await page.waitForSelector(".wb-nw-runok", { timeout: 90000 });
  check("it worked", (await page.locator(".wb-nw-runok").textContent()) === "It worked.");
  const fileLink = page.locator(".wb-nw-files a").first();
  await fileLink.waitFor({ timeout: 15000 });
  const href = await fileLink.getAttribute("href");
  check("the sound is downloaded into the Library", /^\/api\/buzzy\/assets\/\d+$/.test(href || "") && (await fileLink.textContent()) === "rain-on-a-tin-roof.wav", (await fileLink.textContent()) + " " + href);
  const got = await page.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return { type: r.headers.get("content-type"), n: b.length, head: String.fromCharCode(b[0], b[1], b[2], b[3]) }; }, href);
  check("…whole, and served as a sound", got.type === "audio/wav" && got.n === WAV.length && got.head === "RIFF", JSON.stringify(got));
  check("the window can play it", (await page.locator(".wb-nw-files audio").count()) >= 1);
  await shot(page, "3-done");
  const cardText = await page.locator(".wb-card.wb-k-browser").first().innerText();
  check("the card says it worked and links the file", /Last run: it worked/.test(cardText) && /rain-on-a-tin-roof\.wav/.test(cardText), cardText);
  await page.click(".wb-nw-keep");
  await page.waitForTimeout(400);
  check("“Keep this as the recording” turns it into steps followed exactly", (await page.locator('.wb-nw-tab[aria-selected="true"]').textContent()) === "Follow a recording" && (await page.locator(".wb-nw-steps:not(.wb-nw-acts) li").count()) >= 3);
  // The typed step filled in each time, with new words, followed exactly.
  await page.locator(".wb-nw-fill").first().click();
  await page.waitForSelector(".wb-nw-blanks:not([hidden]) input", { timeout: 5000 });
  check("a typed step can be filled in each time, and the window asks for its words", (await page.locator(".wb-nw-fill.on").count()) === 1);
  await page.locator(".wb-nw-blanks input").first().fill("sea waves");
  await page.click(".wb-nw-runbtn");
  await page.waitForFunction(() => [...document.querySelectorAll(".wb-nw-files a")].some((a) => a.textContent === "sea-waves.wav"), null, { timeout: 90000 });
  check("followed exactly with the new words, it made and downloaded the new sound", true);
  await shot(page, "3b-recording-with-new-words");
  await page.keyboard.press("Escape");
  await page.locator(".wb-nwin-x").click().catch(() => {});
  await page.waitForTimeout(300);

  console.log("C. Said in Talk: a step, a globe joined to it, then BeeZilla runs it");
  // BeeZilla's replies are the bubbles that are not the person's (newest turn first).
  const REPLIES = "#chatMessages .bubble:not(.me):not(.streaming)";
  const say = async (text, wait = 60000) => {
    const before = await page.evaluate((q) => document.querySelectorAll(q).length, REPLIES);
    await page.fill("#chatInput", text);
    await page.click("#chatSend");
    await page.waitForFunction(([q, n]) => document.querySelectorAll(q).length > n, [REPLIES, before], { timeout: wait });
    await page.waitForTimeout(800);
    return page.locator(REPLIES).first().innerText();
  };
  await say("add a step called Make the sound");
  await page.waitForFunction(() => [...document.querySelectorAll(".wb-card")].some((c) => /Make the sound/.test(c.innerText)), null, { timeout: 15000 });
  check("the step is on the board", true);
  await say(`when you get to the make the sound step, go to ${SITE}/create and type the sound idea, press Create, wait for it, then download the sound`);
  await page.waitForFunction(() => document.querySelectorAll(".wb-card.wb-k-browser").length === 2, null, { timeout: 15000 });
  const joined = await page.evaluate(() => {
    const b = window.BeeZillaWhiteboard.current();
    const text = b.instructions();
    return text;
  });
  check("a globe is joined to that step, with the job in their words", /Into the step “Make the sound”:\n- Browser node \(the globe\)/.test(joined) && /type the sound idea, press Create, wait for it, then download the sound/.test(joined), joined);
  const reply = await say("the sound idea is wind chimes. do it", 300000);
  const call = modelLog.find((x) => x.kind === "call");
  check("BeeZilla called its browser for the globe joined to the step, with the words of the moment", !!call && !!call.id && call.details === "wind chimes", JSON.stringify(modelLog.slice(-4)));
  await page.waitForFunction(() => [...document.querySelectorAll(".wb-card")].some((c) => /wind-chimes\.wav/.test(c.innerText)), null, { timeout: 30000 });
  const board = await page.evaluate(() => {
    const t = window.BeeZillaWhiteboard.current().instructions();
    return t;
  });
  await page.waitForFunction(() => [...document.querySelectorAll(".wb-card.wb-r-output")].some((c) => /wind-chimes\.wav/.test(c.innerText)), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // A made file is an "output" card (the conversation and the board's summary mention it too).
  const fileCard = await page.evaluate(() => [...document.querySelectorAll(".wb-card.wb-r-output")].filter((c) => /wind-chimes\.wav/.test(c.innerText)).length);
  // Beside its globe: a line from the globe to the file, in the board as saved in this browser.
  const besideGlobe = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/^bz\.board\./.test(k)) continue;
      let v; try { v = JSON.parse(localStorage.getItem(k)); } catch { continue; }
      const cards = (v && v.cards) || [];
      const file = cards.find((c) => /wind-chimes\.wav/.test(c.title || "") && c.kind !== "browser");
      if (!file) continue;
      const globes = cards.filter((c) => c.kind === "browser").map((c) => c.id);
      return (v.links || []).some((l) => l.to === file.id && globes.includes(l.from));
    }
    return false;
  });
  check("…joined to the globe that made it", besideGlobe);
  const cards = await page.evaluate(() => [...document.querySelectorAll(".wb-card")].map((c) => c.className.replace(/\s+/g, ".") + " :: " + c.innerText.replace(/\s+/g, " ").slice(0, 80)));
  check("the sound it downloaded is a card on the board, once, beside its globe", fileCard === 1, cards.filter((c) => !/wb-k-(browser|chat|skill|agent)/.test(c)).join("\n") || "(no file cards)");
  const globeCard = await page.locator(".wb-card.wb-k-browser", { hasText: "wind-chimes.wav" }).count();
  check("the globe says how it went and links the file", globeCard === 1);
  check("BeeZilla's reply says it was done", /^Done — use_browser finished/.test(reply), reply);
  check("the reply plays the sound", (await page.locator("#chatMessages audio").count()) >= 1);
  const info = await (await fetch(`${ORIGIN}/api/buzzy/nodes/browser`, { headers: { cookie } })).json();
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => { const b = window.BeeZillaWhiteboard.current(); if (b && b.act) return b.act({ value: "fit" }); }).catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, "4-board-after-talk");
  check("the account says how the last run ended", info.lastRun && info.lastRun.run && info.lastRun.run.ok === true && info.lastRun.run.files.some((f) => f.name === "wind-chimes.wav"), JSON.stringify(info.lastRun));
  check("no errors on the page", !errors.length, errors.join(" | "));
} catch (e) {
  failures++;
  console.log("FAIL  the probe stopped: " + (e && e.stack || e));
  console.log("--- server log (last lines) ---\n" + serverLog.split("\n").slice(-30).join("\n"));
} finally {
  try { await browser?.close(); } catch { /* fine */ }
  stopAll();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
