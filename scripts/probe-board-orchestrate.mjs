// Orchestrate on the Idea Board, by talking — a real-browser probe.
//
// What it does, signed in as a throwaway account: opens Talk and the Idea Board,
// asks BeeZilla in the Talk box to orchestrate a newsletter, watches the cards arrive
// (screenshots while it builds), checks the flow reads left to right with nothing on
// top of anything, asks for a change ("add a spelling check before my approval"),
// opens the flow in Orchestrate ("open it in orchestrate") and puts it back on the
// board from there. Needs a server with a chat model (any OpenAI-style one; see
// docs/beezilla/ORCHESTRATE-ON-THE-BOARD.md for a local one).
//
// usage: BZ_PROBE_CDP=<cdp address> BZ_MAIL_LOG=<server dir>/.data/outbound-mail.jsonl \
//        BZ_PROBE_SHOTS=<folder> node scripts/probe-board-orchestrate.mjs <origin>
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
const BUILD_MS = Number(process.env.BZ_PROBE_BUILD_MS || 360000);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function devSignIn() {
  const email = `probe-orch-board-${Date.now().toString(36)}@test.local`;
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail !== undefined && !ok ? " — " + JSON.stringify(detail).slice(0, 300) : ""}`);
}
let shotN = 0;
async function shot(page, label) {
  if (!SHOTS) return;
  const name = `${SHOTS}/${String(++shotN).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: name });
  console.log("  shot", name);
}

const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
const eq = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP) : await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax" }]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// The board's flow, read from the page: cards with their boxes and the lines between them.
async function flowOnBoard() {
  return page.evaluate(() => {
    const out = { cards: [], lines: [], labels: [] };
    document.querySelectorAll(".wb-panel .wb-card").forEach((n) => {
      const kind = (Array.from(n.classList).find((c) => c.startsWith("wb-k-")) || "").slice(5);
      if (kind === "chat" || kind === "area") return;
      const r = n.getBoundingClientRect();
      out.cards.push({ kind, title: (n.querySelector(".wb-name") || {}).textContent || "", x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight, sx: r.left, sy: r.top });
    });
    document.querySelectorAll(".wb-panel .wb-llabel text").forEach((t) => out.labels.push(t.textContent));
    const b = window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current();
    out.instructions = b ? b.instructions() : "";
    return out;
  });
}
function overlapping(cards) {
  const bad = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) bad.push([a.title, b.title]);
  }
  return bad;
}
async function say(words) {
  await page.waitForFunction(() => { const el = document.getElementById("chatInput"); return el && !el.disabled; }, null, { timeout: 30000 });
  await page.fill("#chatInput", words);
  await page.keyboard.press("Enter");
}
// A build is over when the board's build bar has come and gone (or never came, for errors).
async function waitForBuild(label) {
  const t0 = Date.now();
  let seen = false, live = 0, cards = -1, said = "";
  while (Date.now() - t0 < BUILD_MS) {
    const now = await page.evaluate(() => {
      const b = document.querySelector(".wb-buildbar");
      return { on: !!b && !b.hidden, text: b ? b.textContent : "", n: document.querySelectorAll(".wb-panel .wb-card").length };
    });
    if (now.on) {
      // A picture as BeeZilla says what it sees, and as the cards arrive.
      if (!seen || (now.text !== said && /^(?!BeeZilla is looking)/.test(now.text)) || (cards >= 0 && now.n >= cards + 2 && live < 5)) {
        await shot(page, `${label}-live-${live}`);
        live++;
        if (now.text !== said) console.log("  BeeZilla says:", now.text.replace(/Stop$/, "").trim());
        said = now.text;
        cards = now.n;
      }
      seen = true;
    } else if (seen) break;
    // Nothing started in four minutes: the turn failed (its reply says why), stop waiting.
    else if (Date.now() - t0 > 240000) break;
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(900);
  return { seen, ms: Date.now() - t0 };
}

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BZOrchestration, null, { timeout: 30000 });
check("the board and the orchestration module are on Talk", true);
// The Idea Board button lives behind the Talk bar's More on a wide screen: press it the
// way the page's own "See board" does.
await page.evaluate(() => document.getElementById("boardToggle").click());
await page.waitForFunction(() => window.BeeZillaWhiteboard.current(), null, { timeout: 15000 });
await page.waitForTimeout(1200);
await shot(page, "board-open");

// 1. A new orchestration, by talking.
await say("Orchestrate a weekly newsletter: find this week's news, write it, I approve it, then email it to the list every Monday.");
const first = await waitForBuild("build");
check("BeeZilla built on the board (the build bar showed)", first.seen, first);
let flow = await flowOnBoard();
await shot(page, "built");
const FLOWISH = /^(?:start|tool|decision|parallel|loop|approval|trigger|subflow|skill|memory|document|note)$/;
const kinds = flow.cards.map((c) => c.kind);
console.log("  board after the build:", JSON.stringify(flow.cards.map((c) => `${c.kind}:${c.title}@${c.x},${c.y}`)));
check("cards arrived", flow.cards.length >= 4, kinds);
check("it has flow cards (a trigger or start, an approval…)", kinds.some((k) => k === "trigger" || k === "start") && kinds.some((k) => k === "approval"), kinds);
check("nothing sits on top of anything", overlapping(flow.cards).length === 0, overlapping(flow.cards));
const firstCount = flow.cards.length;
const firstFlow = flow.cards.filter((c) => FLOWISH.test(c.kind)).length;

// 2. A change to it.
await say("add a spelling check before my approval");
const second = await waitForBuild("change");
check("the change was built live too", second.seen, second);
flow = await flowOnBoard();
await shot(page, "changed");
console.log("  board after the change:", JSON.stringify(flow.cards.map((c) => `${c.kind}:${c.title}@${c.x},${c.y}`)));
check("one more card", flow.cards.length === firstCount + 1, { before: firstCount, after: flow.cards.length });
const approval = flow.cards.find((c) => c.kind === "approval");
const check2 = flow.cards.find((c) => /spell/i.test(c.title));
check("the check sits before the approval, in the row", !!(approval && check2 && check2.x < approval.x), { approval, check2 });
check("still nothing on top of anything", overlapping(flow.cards).length === 0, overlapping(flow.cards));

// 3. Into the Orchestrate editor.
await say("open it in orchestrate");
await page.waitForFunction(() => {
  const wrap = document.getElementById("canvasWrap");
  return location.pathname === "/buzzy/orchestrate" && window.BZ_ORCH_DEBUG && wrap && wrap.getBoundingClientRect().height > 100;
}, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(2000);
const spec = await page.evaluate(() => window.BZ_ORCH_DEBUG ? { n: window.BZ_ORCH_DEBUG.spec.nodes.length, types: window.BZ_ORCH_DEBUG.spec.nodes.map((x) => x.type), status: document.getElementById("status").textContent } : null);
await shot(page, "orchestrate-from-board");
check("the flow opened in Orchestrate", spec && spec.n >= firstFlow, { spec, firstFlow });
const editorTop = await page.evaluate(() => { const w = document.getElementById("canvasWrap"); return w ? Math.round(w.getBoundingClientRect().top) : null; });
check("…with the editor in view (the board folded away)", editorTop !== null && editorTop < 760, editorTop);
check("…and it is valid there", spec && /valid/.test(spec.status), spec);
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check("Orchestrate is dark", /rgb\(10, 10, 10\)/.test(bg), bg);

// 4. And back onto the board.
await page.click("#btnBoard");
await page.waitForFunction(() => location.pathname === "/buzzy/talk", null, { timeout: 30000 }).catch(() => {});
const third = await waitForBuild("back");
flow = await flowOnBoard();
await shot(page, "back-on-board");
check("put back on the board card by card", third.seen && flow.cards.length >= firstCount, { third, n: flow.cards.length });
check("no page errors", errors.length === 0, errors.slice(0, 5));

const failed = results.filter((r) => !r.ok);
console.log(`\nprobe board orchestrate: ${results.length - failed.length} passed, ${failed.length} failed`);
await context.close();
process.exit(failed.length ? 1 : 0);
