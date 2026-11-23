// Code Monkey, the agent panel and the brain, in a real browser, signed in, against a production build.
//
//   1. A new account's strip: BeeZilla, Code Monkey (its own picture, ready: "helps with coding"),
//      the grey bunny.
//   2. Pressing Code Monkey: the Talk button says "Talk to Code Monkey" and is #B8591F; the
//      interface takes its colour (the header's accent, the open place in the row); its panel opens
//      beside the strip with its folders lit on top (Programming, Web design…) and the rest grey,
//      and the page moves over for it.
//   3. Talking to it about code lists the conversation under its History.
//   4. Pressing the Programming folder: the panel shows the folder (who works there, the recent
//      conversations), Code Monkey lights up in the strip and the bunny steps back, and the Memory
//      tab opens at brain/knowledge/programming with the breadcrumb back to brain.
//   5. The breadcrumb's "brain" shows the memories and the three branches; the tree goes to
//      systems/bots/Code Monkey and shows its agent.md and picture.
//   6. Esc steps back from the folder to the agent, then closes the panel; the X closes it too.
//   7. Pressing BeeZilla brings back "Talk to BeeZilla" and the yellow.
//   8. Asking BeeZilla for a new agent (the stand-in model calls make_agent) puts it in the strip.
//   9. A phone: the panel covers the page until closed, and nothing is wider than the screen.
//
// usage: node scripts/probe-brain.mjs [origin]   (BZ_PROBE_CDP=<DevTools URL>; BZ_MAIL_LOG=<server
//   folder>/.data/outbound-mail.jsonl; BZ_PROBE_SHOTS=<folder> to keep pictures). Needs a chat model
//   that answers (a stand-in is fine) and that calls make_agent when it is offered.
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function devSignIn() {
  const email = `probe-brain-${Date.now().toString(36)}@test.local`;
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
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push("console: " + m.text().slice(0, 200)); });

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const names = () => page.evaluate(() => [...document.querySelectorAll("#bzAgents .bzag-item[data-agent]")].map((n) => n.getAttribute("aria-label")));
const press = async (agentName) => {
  await page.locator(`#bzAgents .bzag-item[data-agent]`).filter({ has: page.locator(".bzag-name", { hasText: new RegExp(`^${agentName}$`) }) }).first().click();
};
const look = () => page.evaluate(() => {
  const mic = document.querySelector("#micBtn");
  const head = document.querySelector("#bzHead");
  const panel = document.querySelector("#bzAgentPanel");
  const tab = document.querySelector('#bzTabs [data-tab].on');
  return {
    label: (mic && (mic.querySelector(".tb-label") || mic).textContent || "").trim(),
    micBg: mic ? getComputedStyle(mic).backgroundImage : "",
    agentAttr: document.documentElement.getAttribute("data-bz-agent"),
    headAccent: head ? getComputedStyle(head).getPropertyValue("--bz-yellow").trim() : "",
    tabColor: tab ? getComputedStyle(tab).color : "",
    pad: getComputedStyle(document.documentElement).paddingLeft,
    panelOpen: !!panel && !panel.hidden,
    panelLeft: panel && !panel.hidden ? Math.round(panel.getBoundingClientRect().left) : null,
    panelName: panel ? (panel.querySelector(".bzap-name") || {}).textContent : null,
    panelJob: panel ? (panel.querySelector(".bzap-job") || {}).textContent : null,
    hot: panel ? [...panel.querySelectorAll(".bzap-folder.is-hot .bzap-fname")].map((n) => n.textContent) : [],
    grey: panel ? [...panel.querySelectorAll(".bzap-folder.is-grey .bzap-fname")].map((n) => n.textContent) : [],
    history: panel ? [...panel.querySelectorAll(".bzap-chat .bzap-chat-title")].map((n) => n.textContent) : [],
  };
});

// 1. The strip for a new account.
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-item[data-agent]", { timeout: 20000 });
await page.waitForTimeout(800);
const list = await names();
check("a new account: BeeZilla, then Code Monkey (ready, helps with coding), then the grey bunny",
  list.length === 3 && /^BeeZilla/.test(list[0]) && list[1] === "Code Monkey, helps with coding" && /^Bunnyzilla, waiting for a job/.test(list[2]), list);
const monkeyPic = await page.evaluate(() => {
  const it = [...document.querySelectorAll("#bzAgents .bzag-item[data-agent]")][1];
  const img = it && it.querySelector("img");
  return img ? img.getAttribute("src") : null;
});
check("Code Monkey wears its own picture", monkeyPic === "/buzzy/zillas/monkey.webp", monkeyPic);
await shot("1-strip");

// 2. Code Monkey: the button, the colour, the panel.
await press("Code Monkey");
await page.waitForFunction(() => /Talk to Code Monkey/.test(document.querySelector("#micBtn")?.textContent || ""), null, { timeout: 15000 });
await page.waitForSelector("#bzAgentPanel .bzap-folder", { timeout: 15000 });
await page.waitForTimeout(400); // the page slides over (0.16s)
let L = await look();
check("the Talk button says Talk to Code Monkey", L.label === "Talk to Code Monkey", L.label);
check("the Talk button is #B8591F", /rgb\(184, 89, 31\)/.test(L.micBg), L.micBg.slice(0, 160));
check("the header's accent is Code Monkey's colour (readable on the dark page), not the yellow", !!L.headAccent && !/#ffc107/i.test(L.headAccent) && !/255, 193, 7/.test(L.headAccent), L.headAccent);
check("the open place in the row wears it too", !!L.tabColor && !/rgb\(255, 193, 7\)/.test(L.tabColor), L.tabColor);
check("its panel opens beside the strip and the page moves over", L.panelOpen && L.panelLeft === 72 && L.pad === "372px", { left: L.panelLeft, pad: L.pad });
check("the panel names it and its job", L.panelName === "Code Monkey" && L.panelJob === "helps with coding", [L.panelName, L.panelJob]);
check("its folders are lit on top: Programming and Web design among them", L.hot.includes("Programming") && L.hot.includes("Web design") && L.hot.includes("Code Monkey"), L.hot);
check("the rest of the brain is grey below", L.grey.includes("Pictures") && L.grey.includes("Videos") && !L.grey.includes("Programming"), L.grey.slice(0, 12));
await shot("2-code-monkey");

// 3. Talk to it about code; its History lists the conversation.
await page.fill("#chatInput", "Why does my TypeScript build fail on the API server?");
await page.keyboard.press("Enter");
await page.waitForFunction(() => /Happy to help/.test(document.getElementById("chatMessages")?.innerText || ""), null, { timeout: 60000 });
await page.waitForTimeout(800);
await press("Code Monkey");
await page.waitForFunction(() => document.querySelectorAll("#bzAgentPanel .bzap-chat").length > 0, null, { timeout: 15000 }).catch(() => {});
L = await look();
check("talking to it lists the conversation under its History", L.history.length === 1, L.history);

// 4. A folder: who works there, its conversations, the strip lit, the Memory tab at it.
await page.locator("#bzAgentPanel .bzap-folder.is-hot", { has: page.locator(".bzap-fname", { hasText: /^Programming$/ }) }).first().click();
await page.waitForSelector("#bzAgentPanel .bzap-worker", { timeout: 15000 });
await page.waitForSelector(".bzb .bzb-crumbs .bzb-crumb.is-here", { timeout: 20000 });
await page.waitForTimeout(900);
const F = await page.evaluate(() => {
  const panel = document.querySelector("#bzAgentPanel");
  return {
    title: panel.querySelector(".bzap-name")?.textContent,
    path: panel.querySelector(".bzap-job")?.textContent,
    workers: [...panel.querySelectorAll(".bzap-worker .bzap-fname")].map((n) => n.textContent),
    sessions: panel.querySelectorAll(".bzap-chat").length,
    focus: document.documentElement.classList.contains("bzag-folder-focus"),
    lit: [...document.querySelectorAll("#bzAgents .bzag-item.bzag-works")].map((n) => n.getAttribute("aria-label")),
    memoryTab: !!document.querySelector('#bzTabs [data-tab="memory"].on'),
    crumbs: [...document.querySelectorAll(".bzb .bzb-crumbs .bzb-crumb")].map((n) => n.textContent),
    addr: document.querySelector(".bzb .bzb-addr code")?.textContent,
    explorerWorkers: [...document.querySelectorAll(".bzb .bzb-worker span")].map((n) => n.textContent),
    explorerChats: document.querySelectorAll(".bzb .bzb-items .bzb-k-conversation").length,
  };
});
check("the panel shows the folder: Programming, brain/knowledge/programming", F.title === "Programming" && F.path === "brain/knowledge/programming", [F.title, F.path]);
check("who works there: Code Monkey first", F.workers[0] === "Code Monkey", F.workers);
check("and the recent conversation about it", F.sessions >= 1, F.sessions);
check("Code Monkey lights up in the strip, and only the ones that work there", F.focus && F.lit.length >= 1 && F.lit.every((n) => !/Bunnyzilla/.test(n)) && F.lit.some((n) => /^Code Monkey/.test(n)), F.lit);
check("the Memory tab opened at the folder, with the breadcrumb back to brain", F.memoryTab && F.crumbs.join(" › ") === "brain › knowledge › Programming" && F.addr === "brain/knowledge/programming", { tab: F.memoryTab, crumbs: F.crumbs, addr: F.addr });
check("the Memory tab shows who works there and the conversation too", F.explorerWorkers.includes("Code Monkey") && F.explorerChats >= 1, { w: F.explorerWorkers, c: F.explorerChats });
await page.locator(".bzb").scrollIntoViewIfNeeded();
await shot("3-folder-in-memory");

// 5. Back to brain: the memories and the three branches; then down to Code Monkey's bot folder.
await page.locator(".bzb .bzb-crumbs .bzb-crumb").first().click();
await page.waitForFunction(() => document.querySelector(".bzb .bzb-h2")?.textContent === "brain", null, { timeout: 10000 });
const R = await page.evaluate(() => ({
  branches: [...document.querySelectorAll(".bzb .bzb-branch-name")].map((n) => n.textContent),
  memories: !!([...document.querySelectorAll(".bzb .bzb-h3")].find((h) => /Your memories/.test(h.textContent))),
  addr: document.querySelector(".bzb .bzb-addr code")?.textContent,
  panelView: document.querySelector("#bzAgentPanel .bzap-name")?.textContent,
  focus: document.documentElement.classList.contains("bzag-folder-focus"),
}));
check("brain shows the three branches and the memories", R.branches.join() === "knowledge,systems,assets" && R.memories && R.addr === "brain", R);
check("and the panel goes back to the agent, the strip back to normal", R.panelView === "Code Monkey" && !R.focus, R);
await shot("4-brain");
await page.locator('.bzb .bzb-branch[data-path="systems"]').click();
await page.locator('.bzb .bzb-sub-folder[data-path="systems/bots"]').click();
await page.locator('.bzb .bzb-sub-folder[data-path="systems/bots/code-monkey"]').click();
await page.waitForFunction(() => document.querySelector(".bzb .bzb-addr code")?.textContent === "brain/systems/bots/code-monkey", null, { timeout: 10000 });
const B = await page.evaluate(() => ({
  items: [...document.querySelectorAll(".bzb .bzb-items .bzb-title")].map((n) => n.textContent),
  md: document.querySelector(".bzb .bzb-md")?.textContent || "",
  draggable: [...document.querySelectorAll(".bzb .bzb-items .bzb-item")].every((n) => n.getAttribute("draggable") === "true" && n.hasAttribute("data-bz-card")),
}));
check("step by step to systems › Bots › Code Monkey: its agent.md and its picture", B.items.join() === "agent.md,avatar" && /^# Code Monkey/.test(B.md) && /Helps with: coding/.test(B.md), B);
check("everything there can go on the Idea Board", B.draggable);
await shot("5-bot-folder");

// 6. Esc: from a folder back to the agent, then shut. The X shuts it too. (The panel followed the
// Memory tab into Code Monkey's bot folder, so it is on a folder now: its back button returns.)
check("the panel follows a folder chosen in the Memory tab", (await page.locator("#bzAgentPanel .bzap-back").count()) === 1);
await page.locator("#bzAgentPanel .bzap-back").click();
await page.locator("#bzAgentPanel .bzap-folder.is-hot").first().click();
await page.waitForSelector("#bzAgentPanel .bzap-back", { timeout: 10000 });
await page.locator("body").click({ position: { x: 900, y: 860 } }).catch(() => {});
await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
let E = await look();
check("Esc on a folder steps back to the agent", E.panelOpen && E.panelName === "Code Monkey" && E.hot.length > 0, E.panelName);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
E = await look();
check("a second Esc closes the panel and the page moves back", !E.panelOpen && E.pad === "72px", { open: E.panelOpen, pad: E.pad });
await press("Code Monkey");
await page.waitForSelector("#bzAgentPanel:not([hidden]) .bzap-x", { timeout: 10000 });
await page.locator("#bzAgentPanel .bzap-x").click();
check("its X closes it", !(await look()).panelOpen);

// 7. BeeZilla: her button and her yellow come back.
await press("BeeZilla");
await page.waitForFunction(() => /Talk to BeeZilla/.test(document.querySelector("#micBtn")?.textContent || ""), null, { timeout: 15000 });
L = await look();
check("pressing BeeZilla brings back Talk to BeeZilla and the yellow", L.label === "Talk to BeeZilla" && !L.agentAttr && !/184, 89, 31/.test(L.micBg), { label: L.label, attr: L.agentAttr });
check("and opens her panel", L.panelOpen && L.panelName === "BeeZilla", L.panelName);

// 8. BeeZilla makes an agent.
await page.fill("#chatInput", "Can you make me an agent for my taxes?");
await page.keyboard.press("Enter");
await page.waitForFunction(() => [...document.querySelectorAll("#bzAgents .bzag-item[data-agent]")].some((n) => /^Tax Owl/.test(n.getAttribute("aria-label") || "")), null, { timeout: 60000 }).catch(() => {});
const after = await names();
check("asking BeeZilla for an agent puts it in the strip", after.some((n) => /^Tax Owl, helps with my taxes/.test(n)), after);
await shot("6-made-agent");

// 9. A phone.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.evaluate(() => window.BeeZillaAgents.panel("bzilla"));
await page.waitForTimeout(500);
const P = await page.evaluate(() => {
  const r = document.querySelector("#bzAgentPanel").getBoundingClientRect();
  return { left: Math.round(r.left), width: Math.round(r.width), over: document.documentElement.scrollWidth - window.innerWidth };
});
check("on a phone the panel covers the page, and nothing is wider than the screen", P.left === 0 && P.width === 390 && P.over <= 0, P);
await shot("7-phone");
await page.locator("#bzAgentPanel .bzap-x").click();

check("no page errors", problems.length === 0, problems.slice(0, 5));
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
await context.close();
process.exit(fails ? 1 : 0);
