// "New conversation" gives a new conversation (testers, 2026-11-24: "When I click new
// conversation it's not actually giving me a new conversation … I still have all these
// nodes here"). On the real Talk page, signed in, with a chat model answering:
//   1. Talk once: the conversation, its board and its cards are there.
//   2. Press New conversation on the board: the conversation empties, the board in front
//      of it has none of the old conversation's cards, and the old one is in History.
//   3. Talk again: it is a NEW conversation (a different id), on a clean board.
//   4. Reload on that conversation, press New conversation again: still clean (the board
//      in front of a new conversation is only emptied at load when the visit starts there).
//   5. New conversation pressed while BeeZilla is still answering: the late answer stays
//      with the conversation it was asked in, and nothing of it reaches the new board.
//   6. Steps still running at the press (played by the probe: known steps at known
//      moments) finish on the board they were drawn on — only once their end is known —
//      a 3D model and a video followed out of sight to their end (the video through a
//      "try again" answer, never two checks at once), and the reopened board's undo kept.
//   7. Talk open in two tabs: the second tab's visit never hides the first tab's reply,
//      and the first tab's board stays its own conversation's.
//   8. Offline: a saved drawing, then six New conversations on notes that never reached
//      the account: each press gives a blank board, and back online every one of them is
//      in the board's History, the saved drawing's own entry included.
//   9. A slow account: a card put on the board right after the press stays.
//  10. A conversation left mid-answer and opened again from History shows its reply.
// usage: node scripts/probe-new-conversation.mjs <origin>   (BZ_PROBE_CDP=<DevTools URL>, BZ_MAIL_LOG=<server>/.data/outbound-mail.jsonl)
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";

async function devSignIn() {
  const email = `probe-newconv-${Date.now().toString(36)}@test.local`;
  const res = await fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
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
  throw new Error(`no magic-link mail for ${email} in ${MAIL_LOG}`);
}

const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
const eqAt = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP) : await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: cookie.slice(0, eqAt), value: cookie.slice(eqAt + 1), domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax" }]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort());

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failures++;
}
page.on("pageerror", (e) => { console.log("page error:", e.message); failures++; });

const state = () => page.evaluate(() => ({
  session: localStorage.getItem("bz_session_id"),
  mine: document.querySelectorAll("#chatThread .bubble.me, .bubble.me").length,
  bubbles: [...document.querySelectorAll(".bubble")].map((b) => b.textContent.trim().slice(0, 60)),
  boardOpen: !!(window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current()),
  cards: [...document.querySelectorAll(".wb-world > .wb-card")].map((c) => c.getAttribute("aria-label") || c.className),
}));

async function send(text) {
  await page.fill("#chatInput", text);
  const before = await page.evaluate(() => document.querySelectorAll(".bubble.bot, .bubble.assistant, .bubble:not(.me)").length);
  await page.click("#chatSend");
  await page.waitForFunction((n) => {
    const bots = document.querySelectorAll(".bubble.bot, .bubble.assistant, .bubble:not(.me)");
    return bots.length > n && /Stand-in reply|\w{3}/.test(bots[bots.length - 1].textContent || "");
  }, before, { timeout: 90000 });
  await page.waitForTimeout(2500); // the board catches up (cards, the conversation card)
}

async function pressBoardNew() {
  const has = await page.$(".wb-new");
  if (!has) {
    await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await page.waitForSelector(".wb-new", { timeout: 10000 });
  }
  await page.click(".wb-new");
  await page.waitForTimeout(2500);
}

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#chatInput");

// 1. Talk once.
await send("Plan a poster for Saturday's bake sale");
// A card of the person's own on this conversation's board, so "the old cards are gone"
// tests a real card and not only the conversation card.
await page.evaluate(() => window.BeeZillaWhiteboard.current().addCard({ kind: "note", title: "Seed note for the old conversation", body: "only on the first board", user: true }));
await page.waitForTimeout(1500);
const s1 = await state();
check("1. a conversation exists after the first message", !!s1.session && s1.mine >= 1, JSON.stringify(s1));
check("1. the seed card is on its board", s1.cards.some((c) => /Seed note for the old conversation/.test(c)), JSON.stringify(s1.cards));
check("1. its board shows its cards", s1.boardOpen && s1.cards.length >= 1, JSON.stringify(s1.cards));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-first-conversation.png` });

// 2. New conversation on the board.
await pressBoardNew();
const s2 = await state();
check("2. the conversation is empty", s2.mine === 0, JSON.stringify(s2.bubbles));
check("2. no conversation id is held", !s2.session || s2.session !== s1.session, `${s1.session} → ${s2.session}`);
const oldCards = s1.cards.filter((c) => !/Conversation/.test(c));
const leftOver = s2.cards.filter((c) => oldCards.includes(c));
check("2. none of the old conversation's cards are on the board in front of the new one", leftOver.length === 0, JSON.stringify(leftOver));
check("2. …the seed card included", !s2.cards.some((c) => /Seed note for the old conversation/.test(c)), JSON.stringify(s2.cards));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-after-new-conversation.png` });

// 3. Talk again: a new conversation.
await send("Now a birthday card for my aunt");
const s3 = await state();
check("3. the next message starts a NEW conversation", !!s3.session && s3.session !== s1.session, `${s1.session} vs ${s3.session}`);
check("3. only the new message is in it", s3.mine === 1, JSON.stringify(s3.bubbles));
const old3 = s3.cards.filter((c) => oldCards.includes(c));
check("3. the new conversation's board has none of the first one's cards", old3.length === 0, JSON.stringify(old3));
const list = await page.evaluate(async () => {
  const r = await fetch("/api/buzzy/sessions", { credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  return (j.sessions || []).map((s) => s.id);
});
check("3. both conversations are in History", list.includes(s1.session) && list.includes(s3.session), JSON.stringify(list));

// 4. Reload on that conversation, then New conversation again.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#chatInput");
await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current());
await page.evaluate(() => window.BeeZillaWhiteboard.current().addCard({ kind: "note", title: "Seed note after reload", body: "only on this board", user: true }));
await page.waitForTimeout(2000);
const s4a = await state();
check("4. after a reload the conversation's board is there, with its seed card", s4a.cards.some((c) => /Seed note after reload/.test(c)), JSON.stringify(s4a.cards));
await pressBoardNew();
const s4 = await state();
check("4. after a reload, New conversation still empties the conversation", s4.mine === 0, JSON.stringify(s4.bubbles));
const old4 = s4.cards.filter((c) => s4a.cards.includes(c) && !/Conversation/.test(c));
check("4. …and the board in front of it is clean", old4.length === 0, JSON.stringify(old4));
await send("A shopping list for the party");
const s5 = await state();
check("4. …and the next message is a new conversation", s5.session && s5.session !== s3.session && s5.mine === 1, `${s3.session} vs ${s5.session}`);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-after-reload-new.png` });

// 5. New conversation while BeeZilla is still answering (the model takes its time): the
//    late answer stays with the conversation it was asked in — not in the new one, and
//    nothing of it is drawn on the new board.
const lateAsk = "Plan a garden party, take your time";
await page.fill("#chatInput", lateAsk);
await page.click("#chatSend");
await page.waitForFunction(() => !!localStorage.getItem("bz_session_id"), null, { timeout: 15000 });
const askedIn = await page.evaluate(() => localStorage.getItem("bz_session_id"));
await page.waitForTimeout(1500);              // the turn has started drawing its steps
const stillWaiting = await page.evaluate(() => ![...document.querySelectorAll(".bubble:not(.me)")].some((b) => /garden party/i.test(b.textContent || "")));
check("5. (the answer is still on its way when New conversation is pressed)", stillWaiting, "the stand-in answered too early: this run proves nothing");
await pressBoardNew();
const cardsAtNew = (await state()).cards;
await page.waitForTimeout(11000);             // the late answer arrives meanwhile
const s6 = await state();
check("5. the late answer does not join the new conversation", !s6.bubbles.some((b) => /garden party/i.test(b)) && s6.mine === 0, JSON.stringify(s6.bubbles));
const drawnLate = s6.cards.filter((c) => !cardsAtNew.includes(c));
check("5. nothing of the late turn is drawn on the new board", drawnLate.length === 0, JSON.stringify(drawnLate));
const kept = await page.evaluate(async (id) => {
  const r = await fetch("/api/buzzy/transcript?sessionId=" + encodeURIComponent(id), { credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  return (j.messages || []).map((m) => m.role + ": " + String(m.content).slice(0, 60));
}, askedIn);
check("5. the late answer is kept with the conversation it was asked in", kept.some((m) => /^assistant: /.test(m)) && kept.some((m) => /garden party/i.test(m)), JSON.stringify(kept));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/5-late-answer-stays-away.png` });

// 6. Known steps, running when New conversation is pressed. The chat stream of this turn
//    is played by the probe; so are the 3D maker's answers (done on the second check)
//    and the video maker's ("try again" first, then working, then done — slowly).
const boardOf = (id) => page.evaluate((id) => {
  try { return JSON.parse(localStorage.getItem("bz.board." + id) || "null"); } catch (_) { return null; }
}, id);
const flowCard = (doc, flow) => ((doc && doc.cards) || []).find((c) => c.flow === flow) || null;
const ASSET_3D = "/api/buzzy/assets/990001", ASSET_VIDEO = "/api/buzzy/assets/990002";
let modelAsks = 0, videoAsks = 0, videoBusy = 0, videoMostAtOnce = 0, videoTryAgain = 0;
await page.route(/\/api\/buzzy\/model3d\/probe-task-1$/, async (route) => {
  modelAsks++;
  const body = modelAsks < 2
    ? { ok: true, taskId: "probe-task-1", status: "IN_PROGRESS", progress: 40 }
    : { ok: true, taskId: "probe-task-1", status: "SUCCEEDED", progress: 100, asset: { id: 990001, url: ASSET_3D, name: "probe-model.glb", type: "model/gltf-binary" } };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await page.route(/\/api\/buzzy\/video\/probe-job-1$/, async (route) => {
  videoAsks++;
  videoBusy++;
  videoMostAtOnce = Math.max(videoMostAtOnce, videoBusy);
  try {
    if (videoAsks === 1) {
      videoTryAgain++;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "The video queue is full.", code: "busy", retryable: true }) });
    } else if (videoAsks === 2) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, jobId: "probe-job-1", state: "rendering", etaMinutes: 1 }) });
    } else {
      await new Promise((r) => setTimeout(r, 9000));     // a slow download: longer than the wait between checks
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, jobId: "probe-job-1", state: "done", video: { url: ASSET_VIDEO, name: "probe-video.mp4", type: "video/mp4", bytes: 1000 } }) });
    }
  } finally { videoBusy--; }
});
await page.evaluate(() => {
  const real = window.fetch;
  window.fetch = function (url, init) {
    const u = String(url);
    if (window.__probeArm && (u === "/api/buzzy/chat" || u.indexOf("/api/buzzy/chat?") === 0) && init && String(init.method || "").toUpperCase() === "POST") {
      window.__probeArm = false;
      let ctrl;
      const body = new ReadableStream({ start(c) { ctrl = c; } });
      const enc = new TextEncoder();
      window.__probeStream = {
        push(ev, data) { ctrl.enqueue(enc.encode("event: " + ev + "\ndata: " + JSON.stringify(data) + "\n\n")); },
        close() { ctrl.close(); },
      };
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }
    return real.apply(this, arguments);
  };
  window.__probeArm = true;
});
await page.fill("#chatInput", "Probe: steps still working");
await page.click("#chatSend");
await page.waitForFunction(() => !!window.__probeStream, null, { timeout: 15000 });
const probeSession = await page.evaluate(() => localStorage.getItem("bz_session_id"));
await page.evaluate(() => {
  const s = window.__probeStream;
  s.push("flow", { kind: "skill", id: "skill:probe", title: "Probe step", parent: "agent", state: "running", detail: "working on it" });
  s.push("flow", { kind: "output", id: "out:3d:probe-task-1", title: "3D model", parent: "skill:probe", state: "running", contentType: "model/gltf-binary", taskId: "probe-task-1" });
  s.push("flow", { kind: "output", id: "out:video:probe-job-1", title: "Probe video", parent: "skill:probe", state: "running", contentType: "video/mp4" });
  s.push("flow", { kind: "skill", id: "skill:probe-open", title: "A step with no end yet", parent: "agent", state: "running" });
});
await page.waitForFunction((id) => {
  try {
    const d = JSON.parse(localStorage.getItem("bz.board." + id) || "null");
    const flows = ["skill:probe", "out:3d:probe-task-1", "out:video:probe-job-1", "skill:probe-open"];
    return flows.every((f) => d.cards.some((c) => c.flow === f && c.state === "running"));
  } catch (_) { return false; }
}, probeSession, { timeout: 15000 }).catch(() => {});
const before6 = await boardOf(probeSession);
check("6. (four known steps are drawn and running before New conversation is pressed)",
  ["skill:probe", "out:3d:probe-task-1", "out:video:probe-job-1", "skill:probe-open"].every((f) => (flowCard(before6, f) || {}).state === "running"),
  JSON.stringify(((before6 && before6.cards) || []).map((c) => [c.flow, c.state])));
await pressBoardNew();
await page.evaluate(() => {
  const s = window.__probeStream;
  s.push("flow", { kind: "skill", id: "skill:probe", title: "Probe step", parent: "agent", state: "done" });
  s.push("done", { ok: true, reply: "Probe reply for the conversation that was left", model3d: { taskId: "probe-task-1" }, video: { jobId: "probe-job-1", etaMinutes: 1 } });
  s.close();
});
await page.waitForTimeout(800);
// Back to that conversation from History, and something of the person's own on its board.
await page.evaluate((id) => window.bzOpenSession({ id: id, companyId: null }), probeSession);
await page.waitForFunction((id) => localStorage.getItem("bz_session_id") === id, probeSession, { timeout: 10000 });
await page.waitForFunction(() => [...document.querySelectorAll(".wb-world > .wb-card")].some((c) => /Probe step/.test(c.getAttribute("aria-label") || "")), null, { timeout: 10000 });
await page.evaluate(() => window.BeeZillaWhiteboard.current().addCard({ kind: "note", title: "Undo me later", body: "put on the reopened board", user: true }));
await page.waitForFunction((id) => {
  try {
    const d = JSON.parse(localStorage.getItem("bz.board." + id) || "null");
    return d.cards.some((c) => c.flow === "out:video:probe-job-1" && c.state !== "running");
  } catch (_) { return false; }
}, probeSession, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);                 // the account gets it
const after6 = await boardOf(probeSession);
const c3d = flowCard(after6, "out:3d:probe-task-1") || {}, cvid = flowCard(after6, "out:video:probe-job-1") || {};
check("6. the step whose end came after the press is finished on its own board", (flowCard(after6, "skill:probe") || {}).state === "", JSON.stringify(flowCard(after6, "skill:probe")));
check("6. the 3D model, followed out of sight, is done on that board with its file", c3d.state === "" && c3d.url === ASSET_3D, JSON.stringify(c3d));
check("6. the video is done there too, after a \"try again\" answer", cvid.state === "" && cvid.url === ASSET_VIDEO && videoTryAgain === 1, JSON.stringify(cvid) + ` asks=${videoAsks}`);
check("6. …and its checks never overlapped (one at a time, even a slow one)", videoMostAtOnce === 1 && videoAsks === 3, `at once=${videoMostAtOnce} asks=${videoAsks}`);
check("6. a step with no known end is left as it was", (flowCard(after6, "skill:probe-open") || {}).state === "running", JSON.stringify(flowCard(after6, "skill:probe-open")));
const account6 = await page.evaluate(async (id) => {
  const r = await fetch("/api/buzzy/whiteboards/" + encodeURIComponent(id), { credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  return ((j.board && j.board.state && j.board.state.cards) || []).filter((c) => c.flow).map((c) => ({ flow: c.flow, state: c.state || "", url: c.url || "" }));
}, probeSession);
const acc = (f) => account6.find((c) => c.flow === f) || {};
check("6. the account has the same", acc("out:3d:probe-task-1").url === ASSET_3D && acc("out:video:probe-job-1").url === ASSET_VIDEO && acc("skill:probe").state === "", JSON.stringify(account6));
await page.focus(".wb-canvas");
await page.keyboard.press("Control+z");
await page.waitForTimeout(600);
const undone = await page.evaluate(() => ![...document.querySelectorAll(".wb-world > .wb-card")].some((c) => /Undo me later/.test(c.getAttribute("aria-label") || "")));
check("6. undo still works on that board after the background change", undone);
await page.waitForTimeout(800);
const afterUndo = await boardOf(probeSession);
check("6. …and undoing it leaves the finished 3D model and video finished, with their files",
  (flowCard(afterUndo, "out:video:probe-job-1") || {}).url === ASSET_VIDEO && (flowCard(afterUndo, "out:video:probe-job-1") || {}).state === "" &&
  (flowCard(afterUndo, "out:3d:probe-task-1") || {}).url === ASSET_3D,
  JSON.stringify([flowCard(afterUndo, "out:video:probe-job-1"), flowCard(afterUndo, "out:3d:probe-task-1")]));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/6-steps-finished-on-their-board.png` });

// 7. Talk in two tabs: the second tab's visit clears the shared conversation id; the
//    first tab's reply still shows.
await pressBoardNew();
await page.fill("#chatInput", "Two tabs open, take your time");
await page.click("#chatSend");
await page.waitForFunction(() => !!localStorage.getItem("bz_session_id"), null, { timeout: 15000 });
const tabOneSession = await page.evaluate(() => localStorage.getItem("bz_session_id"));
const tab2 = await context.newPage();
await tab2.route(/openpanel\.dev/, (r) => r.abort());
await tab2.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await tab2.waitForSelector("#chatInput");
check("7. (the second tab's visit cleared the shared conversation id)", !(await tab2.evaluate(() => localStorage.getItem("bz_session_id"))));
await page.waitForFunction(() => [...document.querySelectorAll(".bubble:not(.me)")].some((b) => /Two tabs open, take your time/.test(b.textContent || "")), null, { timeout: 40000 }).catch(() => {});
check("7. the first tab still shows its reply", await page.evaluate(() => [...document.querySelectorAll(".bubble:not(.me)")].some((b) => /Two tabs open, take your time/.test(b.textContent || ""))),
  JSON.stringify((await state()).bubbles));
await page.waitForTimeout(2500);               // the board checks for a new conversation every 1.5 s
await page.evaluate(() => window.BeeZillaWhiteboard.current().addCard({ kind: "note", title: "Tab one's own card", body: "", user: true }));
await page.waitForTimeout(1200);
const whereSaved = await page.evaluate((id) => {
  const has = (key) => { try { return (JSON.parse(localStorage.getItem(key) || "null") || { cards: [] }).cards.some((c) => c.title === "Tab one's own card"); } catch (_) { return false; } };
  return { own: has("bz.board." + id), talk: has("bz.board.talk") };
}, tabOneSession);
check("7. the first tab's board is still its own conversation's (a card put on it is saved there)", whereSaved.own && !whereSaved.talk, JSON.stringify(whereSaved));
await tab2.close();

// 8. A drawing saved to the account; then offline, six New conversations, each on notes
//    that never reached it. Each press gives a blank board; back online, every one of
//    them is in the board's History as an entry of its own, the saved drawing's included.
await pressBoardNew();
await page.evaluate(() => window.BeeZillaWhiteboard.current().addCard({ kind: "note", title: "Saved drawing", body: "reached the account", user: true }));
let savedFirst = false;
for (let i = 0; i < 20 && !savedFirst; i++) {
  await page.waitForTimeout(700);
  savedFirst = await page.evaluate(async () => {
    const r = await fetch("/api/buzzy/whiteboards/talk", { credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    return ((j.board && j.board.state && j.board.state.cards) || []).some((c) => c.title === "Saved drawing");
  });
}
check("8. (the first drawing reached the account)", savedFirst);
await context.setOffline(true);
await pressBoardNew();
const offlineNotes = [1, 2, 3, 4, 5, 6].map((n) => `Offline note ${n}`);
let blankEachTime = true;
for (const t of offlineNotes) {
  await page.evaluate((t) => window.BeeZillaWhiteboard.current().addCard({ kind: "note", title: t, body: "never sent", user: true }), t);
  await page.waitForTimeout(600);
  await pressBoardNew();
  const cards = (await state()).cards;
  if (cards.some((c) => /Saved drawing|Offline note/.test(c))) blankEachTime = false;
}
const kept8 = await page.evaluate(() => localStorage.getItem("bz.board.talk~left") || "");
check("8. offline, every New conversation still gives a blank board", blankEachTime);
check("8. …and all six sets of notes are kept on this computer meanwhile", offlineNotes.every((t) => kept8.includes(t)), kept8.slice(0, 200));
await context.setOffline(false);
let history8 = [];
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  history8 = await page.evaluate(async () => {
    const r = await fetch("/api/buzzy/whiteboards/talk/versions", { credentials: "same-origin" }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    return (j.versions || []).map((v) => v.titles || []);
  });
  if (["Saved drawing", ...offlineNotes].every((t) => history8.some((titles) => titles.includes(t)))) break;
}
// An entry of its own: that drawing, and none of the others.
const ownEntry = (t) => history8.some((titles) => titles.includes(t) && !titles.some((x) => x !== t && /^(Saved drawing|Offline note \d)$/.test(x)));
check("8. back online, the saved drawing still has its own History entry", ownEntry("Saved drawing"), JSON.stringify(history8));
check("8. …and each of the six offline notes has one too", offlineNotes.every(ownEntry), JSON.stringify(history8));
await page.waitForTimeout(1500);
const after8 = await page.evaluate(async () => {
  const r = await fetch("/api/buzzy/whiteboards/talk", { credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  return { kept: localStorage.getItem("bz.board.talk~left"), titles: ((j.board && j.board.state && j.board.state.cards) || []).map((c) => c.title) };
});
check("8. …nothing is left only on this computer, and the board itself stays blank", !after8.kept && after8.titles.length === 0, JSON.stringify(after8));

// 9. A slow account: what is put on the board right after the press is the new
//    conversation's, and stays.
await page.evaluate(() => window.BeeZillaWhiteboard.current().addCard({ kind: "note", title: "Before the press", body: "", user: true }));
await page.waitForTimeout(2500);
const slow = /\/api\/buzzy\/whiteboards\/talk$/;
await page.route(slow, async (route) => {
  if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 3000));
  await route.continue();
});
await page.click(".wb-new");
await page.evaluate(() => window.BeeZillaWhiteboard.current().addCard({ kind: "note", title: "Right after the press", body: "", user: true }));
await page.waitForTimeout(7000);
const s9 = await state();
check("9. a card put on the board right after the press stays", s9.cards.some((c) => /Right after the press/.test(c)), JSON.stringify(s9.cards));
check("9. …and the one from before the press is gone", !s9.cards.some((c) => /Before the press/.test(c)), JSON.stringify(s9.cards));
await page.unroute(slow);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/9-slow-account.png` });

// 10. Left mid-answer, then opened again from History before the answer came: once it
//     comes, it shows (the conversation is on screen again).
await page.fill("#chatInput", "Back again soon, take your time");
await page.click("#chatSend");
await page.waitForFunction(() => !!localStorage.getItem("bz_session_id"), null, { timeout: 15000 });
const leftSession = await page.evaluate(() => localStorage.getItem("bz_session_id"));
await page.waitForTimeout(1200);
await pressBoardNew();
await page.evaluate((id) => window.bzOpenSession({ id: id, companyId: null }), leftSession);
await page.waitForFunction((id) => localStorage.getItem("bz_session_id") === id && [...document.querySelectorAll(".bubble.me")].some((b) => /Back again soon/.test(b.textContent || "")), leftSession, { timeout: 10000 }).catch(() => {});
check("10. (it was open again before its reply came)", await page.evaluate((id) => localStorage.getItem("bz_session_id") === id &&
  ![...document.querySelectorAll(".bubble:not(.me)")].some((b) => /Back again soon, take your time/.test(b.textContent || "")), leftSession),
  "the reply was already there: this run proves nothing");
await page.waitForFunction(() => [...document.querySelectorAll(".bubble:not(.me)")].some((b) => /Back again soon, take your time/.test(b.textContent || "")), null, { timeout: 30000 }).catch(() => {});
check("10. its reply shows once it comes", await page.evaluate(() => [...document.querySelectorAll(".bubble:not(.me)")].some((b) => /Back again soon, take your time/.test(b.textContent || ""))),
  JSON.stringify((await state()).bubbles));

await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
