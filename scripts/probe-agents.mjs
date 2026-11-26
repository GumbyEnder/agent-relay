// The Zilla agents sidebar, in a real browser, signed in, against a production build.
//
//   1. The strip is on every page that has the website's header, the page has moved
//      over to make room, and it is the SAME strip after moving between pages.
//   2. A new account has BeeZilla, one grey bunny and a plus.
//   3. Pressing the bunny opens Talk as it: the board is open, the Talk button is pink,
//      the header says Bunnyzilla and the box asks what job it should take on.
//   4. Saying the job ("You're in charge of my to-do list") gives it a job and a face: the
//      strip shows the emoji, the header too, and the exchange is kept in History.
//   5. After a reload the agent is still there, and pressing it picks the conversation up.
//   6. The plus brings in the next one, and does not pile up grey ones.
//   7. The strip opens (names and jobs), scrolls with many agents, and its edge resizes it.
//   8. Nothing closes on a click outside it: the edit dialog stays open when the page
//      around it is pressed, and closes only with Esc or its X.
//   9. A phone gets a drawer, with the same rule.
//
// usage: node scripts/probe-agents.mjs [origin]    (BZ_PROBE_CDP=<DevTools URL> to reuse a browser;
//   BZ_MAIL_LOG=<server folder>/.data/outbound-mail.jsonl; BZ_PROBE_SHOTS=<folder> to keep pictures)
// Signs a throwaway account in through the dev magic-link inbox, like probe-soft-nav.mjs.
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function devSignIn() {
  const email = `probe-agents-${Date.now().toString(36)}@test.local`;
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
const eq = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
await context.addCookies([{
  name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
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
const strip = () => page.evaluate(() => {
  const r = document.querySelector("#bzAgents")?.getBoundingClientRect();
  return {
    strips: document.querySelectorAll("#bzAgents").length,
    left: r ? Math.round(r.left) : null, width: r ? Math.round(r.width) : null,
    pad: getComputedStyle(document.documentElement).paddingLeft,
    head: document.querySelector("#bzHead")?.getBoundingClientRect().left ?? null,
    names: [...document.querySelectorAll("#bzAgents .bzag-item:not(.bzag-hive)")].map((n) => n.getAttribute("aria-label")),
  };
});
const hop = async (path) => {
  await page.evaluate((p) => window.BeeZillaShell.go(p), path);
  // A cold server answers its first request for a page slowly, so this waits a good while.
  // (Music studio gives itself a ?job= address as it opens, so only the path is compared.)
  await page.waitForFunction((p) => window.BeeZillaShell.currentKey.split("?")[0] === p && !window.BeeZillaShell.busy, path, { timeout: 90000 });
  await page.waitForTimeout(500);
};
const thread = () => page.evaluate(() => (document.getElementById("chatMessages")?.innerText || "").replace(/\s+/g, " "));

// 1 + 2. The strip, on Talk, for a new account.
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-item", { timeout: 15000 });
let s = await strip();
check("the strip is on Talk, 72px wide, and the page has moved over", s.strips === 1 && s.left === 0 && s.width === 72 && s.pad === "72px" && s.head >= 72, s);
check("a new account has BeeZilla and one grey bunny", s.names.length === 2 && /^BeeZilla/.test(s.names[0]) && /^Bunnyzilla, waiting for a job/.test(s.names[1]), s.names);
check("there is a plus", (await page.locator("#bzAgents .bzag-add").count()) === 1);
await shot("1-talk-strip");

// The strip on the other pages, and the same strip after moving between them.
for (const path of ["/buzzy/library", "/buzzy/sketch", "/buzzy/studio", "/buzzy/capabilities", "/buzzy/experts", "/buzzy/memory", "/buzzy/recipes", "/buzzy/wallet", "/buzzy/talk"]) {
  await hop(path);
  const t = await strip();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`one strip on ${path}, page moved over, nothing wider than the window`, t.strips === 1 && t.left === 0 && t.width === 72 && t.pad === "72px" && t.head >= 72 && over <= 1, { ...t, over });
  if (path === "/buzzy/sketch" || path === "/buzzy/library") await shot("2-" + path.split("/").pop());
}

// 3. Press the grey bunny: Talk as Bunnyzilla.
await page.locator("#bzAgents .bzag-item.is-unset").click();
await page.waitForFunction(() => document.documentElement.getAttribute("data-bz-agent"), null, { timeout: 8000 });
await page.waitForTimeout(900);
const talk1 = await page.evaluate(() => ({
  attr: document.documentElement.getAttribute("data-bz-agent"),
  bg: getComputedStyle(document.querySelector("#micBtn")).backgroundImage,
  label: document.querySelector("#micBtn .tb-label")?.textContent,
  name: document.querySelector(".bz-brand strong")?.textContent,
  ph: document.getElementById("chatInput")?.getAttribute("placeholder"),
  boardOpen: document.documentElement.classList.contains("ob-open"),
  current: document.querySelector("#bzAgents [aria-current=true]")?.getAttribute("aria-label"),
}));
check("Bunnyzilla's Talk: pink button, its name, board open", /rgb\(24\d, 1[4-7]\d, 1[5-9]\d\)/.test(talk1.bg) && talk1.name === "Bunnyzilla" && talk1.label === "Talk to Bunnyzilla" && talk1.boardOpen, talk1);
check("the box asks what job to take on", /job/i.test(talk1.ph || ""), talk1.ph);
check("it asks 'What role do you want me to play?'", /What role do you want me to play\?/.test(await thread()), (await thread()).slice(0, 200));
await shot("3-bunny-asks");

// 4. Say the job.
await page.fill("#chatInput", "You're in charge of my to-do list");
await page.click("#chatSend");
await page.waitForFunction(() => /Got it/.test(document.getElementById("chatMessages")?.innerText || ""), null, { timeout: 15000 });
await page.waitForTimeout(600);
const talk2 = await page.evaluate(() => ({
  face: document.querySelector("#bzAgents .bzag-face")?.textContent,
  hdr: document.querySelector(".bz-brand .bz-agent-face")?.textContent,
  unset: document.querySelectorAll("#bzAgents .is-unset").length,
  ph: document.getElementById("chatInput")?.getAttribute("placeholder"),
  label: document.getElementById("chatInput")?.getAttribute("aria-label"),
}));
check("a job gives it a to-do face, in the strip and the header", talk2.face === "✅" && talk2.hdr === "✅" && talk2.unset === 0 && /What do you need from Bunnyzilla/.test(talk2.label || "") && talk2.ph === "What do you need?", talk2);
await shot("4-bunny-has-a-job");

// 5. A reload keeps it; pressing it picks the conversation up.
await page.reload({ waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-item");
const names = (await strip()).names;
check("after a reload Bunnyzilla still helps with the to-do list", /^Bunnyzilla, helps with to-do list/.test(names[1] || ""), names);
await page.locator('#bzAgents .bzag-item[data-agent]:not([data-agent="bzilla"])').first().click();
await page.waitForFunction(() => /Got it/.test(document.getElementById("chatMessages")?.innerText || ""), null, { timeout: 10000 }).catch(() => {});
check("pressing it picks its conversation back up", /Got it/.test(await thread()), (await thread()).slice(0, 160));

// A new conversation with an agent greets in the agent's words, and a conversation opened
// from History brings its agent back.
await page.evaluate(() => document.querySelector(".wb-new") && document.querySelector(".wb-new").click());
await page.waitForTimeout(700);
const fresh = await page.evaluate(() => ({ name: document.querySelector(".bz-brand strong")?.textContent, text: (document.getElementById("chatMessages")?.innerText || "").replace(/\s+/g, " ") }));
check("New conversation stays with the agent and it greets in its own words", fresh.name === "Bunnyzilla" && /Hi, I'm Bunnyzilla\. I help with to-do list/.test(fresh.text), fresh);
const sid = (await page.evaluate(async () => (await (await fetch("/api/buzzy/agents", { credentials: "same-origin" })).json()).agents[0].lastSessionId));
await page.locator('#bzAgents .bzag-item[data-agent="bzilla"]').click();
await page.waitForFunction(() => !document.documentElement.getAttribute("data-bz-agent"), null, { timeout: 8000 });
await page.evaluate((id) => window.bzOpenSession({ id }), sid);
await page.waitForFunction(() => document.documentElement.getAttribute("data-bz-agent"), null, { timeout: 8000 }).catch(() => {});
check("opening an agent's conversation from History brings the agent back", await page.evaluate(() => document.querySelector(".bz-brand strong")?.textContent === "Bunnyzilla" && !!document.documentElement.getAttribute("data-bz-agent")));

// 6. The plus: the next one, once.
await page.locator("#bzAgents .bzag-add").click();
await page.waitForFunction(() => document.querySelectorAll("#bzAgents .bzag-item:not(.bzag-hive)").length === 3, null, { timeout: 8000 });
await page.waitForTimeout(700);
const added = (await strip()).names;
check("the plus brings in Bullzilla, waiting for a job", /^Bullzilla, waiting for a job/.test(added[2] || ""), added);
await page.locator("#bzAgents .bzag-add").click();
await page.waitForTimeout(500);
check("pressing the plus again does not pile up grey agents", (await strip()).names.length === 3);
check("Bullzilla's Talk button is orange-ish and says its name", await page.evaluate(() => document.querySelector("#micBtn .tb-label")?.textContent === "Talk to Bullzilla"));

// 7. Open it, size it.
await page.locator("#bzAgents .bzag-toggle").click();
await page.waitForTimeout(400);
const open = await page.evaluate(() => ({
  w: Math.round(document.querySelector("#bzAgents").getBoundingClientRect().width),
  pad: getComputedStyle(document.documentElement).paddingLeft,
  roles: [...document.querySelectorAll("#bzAgents .bzag-role")].map((n) => n.textContent),
}));
check("opened: names and jobs show, the page moved further", open.w > 200 && open.pad === open.w + "px" && open.roles.includes("helps with to-do list"), open);
check("with the strip open the box you type in is still wide enough", await page.evaluate(() => Math.round(document.getElementById("chatInput").getBoundingClientRect().width)) >= 140, await page.evaluate(() => Math.round(document.getElementById("chatInput").getBoundingClientRect().width)));
await shot("5-strip-open");
const edge = await page.evaluate(() => { const r = document.querySelector("#bzAgents .bzag-edge").getBoundingClientRect(); return { x: r.x + r.width / 2, y: 400 }; });
await page.mouse.move(edge.x, edge.y); await page.mouse.down(); await page.mouse.move(340, edge.y, { steps: 6 }); await page.mouse.up();
check("its edge pulls it wider", Math.abs((await page.evaluate(() => document.querySelector("#bzAgents").getBoundingClientRect().width)) - 340) <= 2);
await page.reload({ waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-item");
check("opened and its width are remembered", await page.evaluate(() => Math.round(document.querySelector("#bzAgents").getBoundingClientRect().width) === 340));

// Many agents: it scrolls and the plus stays reachable.
for (let i = 0; i < 24; i++) {
  await page.evaluate(async () => {
    const r = await fetch("/api/buzzy/agents", { method: "GET", credentials: "same-origin" });
    const j = await r.json();
    const waiting = (j.agents || []).filter((a) => !a.ready);
    // make each new one ready, so the next plus really adds another
    for (const a of waiting) await fetch("/api/buzzy/agents/" + a.id, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "something" + a.id.slice(-3) }) });
    await fetch("/api/buzzy/agents", { method: "POST", credentials: "same-origin" });
  });
}
await page.reload({ waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-item");
await page.waitForTimeout(500);
const many = await page.evaluate(() => {
  const sc = document.getElementById("bzagScroll");
  return { n: document.querySelectorAll("#bzAgents .bzag-item:not(.bzag-hive)").length, scrolls: sc.scrollHeight > sc.clientHeight, plusBottom: Math.round(document.querySelector("#bzAgents .bzag-add").getBoundingClientRect().bottom), vh: innerHeight };
});
check("many agents: the strip scrolls and the plus stays on screen", many.n > 20 && many.scrolls && many.plusBottom <= many.vh, many);
await shot("6-many");

// 8. Nothing closes on a click outside it.
await page.locator("#bzAgents .bzag-more").first().click();
await page.waitForSelector("#bzAgentsModal.open");
await page.fill('#bzAgentsModal input[type="text"] >> nth=0', "Dolly");
await page.mouse.click(700, 60);
await page.waitForTimeout(250);
check("a click outside the edit dialog leaves it open, with what was typed", await page.evaluate(() => document.getElementById("bzAgentsModal").classList.contains("open") && document.querySelector('#bzAgentsModal input[type="text"]').value === "Dolly"));
await shot("7-edit-dialog");
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Esc closes it, and nothing was saved", await page.evaluate(() => !document.getElementById("bzAgentsModal").classList.contains("open") && !/Dolly/.test(document.getElementById("bzAgents").innerText)));
await page.locator("#bzAgents .bzag-more").first().click();
await page.waitForSelector("#bzAgentsModal.open");
await page.click("#bzAgentsModal .bzag-x");
await page.waitForTimeout(200);
check("its X closes it", await page.evaluate(() => !document.getElementById("bzAgentsModal").classList.contains("open")));
// rename for real
await page.locator("#bzAgents .bzag-more").first().click();
await page.waitForSelector("#bzAgentsModal.open");
await page.fill('#bzAgentsModal input[type="text"] >> nth=0', "Dolly");
await page.click("#bzAgentsModal .bzag-btn.primary");
await page.waitForFunction(() => !document.getElementById("bzAgentsModal").classList.contains("open"));
check("Save renames the agent", /Dolly/.test(await page.evaluate(() => document.getElementById("bzAgents").innerText)));

// Dragging to the Idea Board: a face carries a picture card.
const card = await page.evaluate(() => {
  const dt = new DataTransfer();
  document.querySelector('#bzAgents .bzag-item[data-agent]:not([data-agent="bzilla"])').dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
  return dt.getData("application/x-beezilla-card");
});
check("an agent can be dragged to the Idea Board as a picture card", /"kind":"image"/.test(card) && /\/buzzy\/zillas\//.test(card), card.slice(0, 120));

// Back to BeeZilla: everything undone.
await page.locator('#bzAgents .bzag-item[data-agent="bzilla"]').click();
await page.waitForFunction(() => !document.documentElement.getAttribute("data-bz-agent"), null, { timeout: 8000 });
const bee = await page.evaluate(() => ({ name: document.querySelector(".bz-brand strong")?.textContent, label: document.querySelector("#micBtn .tb-label")?.textContent, bg: getComputedStyle(document.querySelector("#micBtn")).backgroundImage }));
check("pressing BeeZilla puts the yellow button and the bee back", bee.name === "BeeZilla" && bee.label === "Talk to BeeZilla" && /255, 193, 7|255, 179, 0|255, 213, 79/.test(bee.bg), bee);

// 9. A phone: a drawer, closed only by its X or Esc.
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(400);
const ph = await page.evaluate(() => ({
  pad: getComputedStyle(document.documentElement).paddingLeft,
  tab: !!document.querySelector("#bzAgentsTab") && getComputedStyle(document.querySelector("#bzAgentsTab")).display !== "none",
  stripX: Math.round(document.querySelector("#bzAgents").getBoundingClientRect().right),
  over: document.documentElement.scrollWidth - innerWidth,
}));
check("on a phone the page keeps its width and a small tab opens the drawer", ph.pad === "0px" && ph.tab && ph.stripX <= 0 && ph.over <= 1, ph);
await page.click("#bzAgentsTab");
await page.waitForTimeout(400);
await shot("8-phone-drawer");
check("the drawer shows names", await page.evaluate(() => document.querySelector("#bzAgents .bzag-name")?.offsetParent !== null && document.querySelector("#bzAgents").getBoundingClientRect().left >= 0));
await page.mouse.click(370, 600);
await page.waitForTimeout(250);
check("a click on the page does not close the drawer", await page.evaluate(() => document.documentElement.classList.contains("bz-agents-drawer")));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Esc closes the drawer", await page.evaluate(() => !document.documentElement.classList.contains("bz-agents-drawer")));

if (problems.length) console.log("page problems:\n  " + problems.join("\n  "));
check("no page errors", problems.length === 0, problems.slice(0, 3));
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
await context.close();
process.exit(fails ? 1 : 0);
