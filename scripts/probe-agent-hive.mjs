// The Hive, in a real browser, signed in, against a production build and a stand-in model.
//
//   - the Hive is the first row of the strip, scrolled out of sight above BeeZilla; a small
//     "Hive" label at the top says so, and pressing it scrolls up to it
//   - an agent that asks BeeZilla for something (the stand-in model calls ask_bzilla when told
//     "ask BeeZilla …") leaves the question and the answer in the Hive window; BeeZilla asking
//     an agent by name (ask_agent) does too
//   - the window is not a modal: the page behind it stays usable; it updates while open; only
//     Esc or its X closes it, never a press outside it
//
// usage: BZ_FAKE_LLM=<stand-in model's address> node scripts/probe-agent-hive.mjs [origin]
//   (the server must have been started with BZ_CHAT_BASE_URL pointing at that stand-in model,
//   which answers tool requests: scratchpad fake-llm.mjs is the one used for this change;
//   BZ_PROBE_CDP, BZ_MAIL_LOG, BZ_PROBE_SHOTS as probe-agents.mjs)
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function devSignIn() {
  const email = `probe-hive-${Date.now().toString(36)}@test.local`;
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
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail).slice(0, 240)}`);
};
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, credentials: "same-origin", headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  return r.json();
}, [method, path, body]);
const hiveText = () => page.evaluate(() => (document.getElementById("bzHive")?.innerText || "").replace(/\s+/g, " "));
const send = async (text) => {
  await page.fill("#chatInput", text);
  await page.click("#chatSend");
};

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
await page.evaluate(() => { localStorage.removeItem("bz.agents.open"); });
await page.reload({ waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-item");
await page.waitForTimeout(500);

// The Hive: above BeeZilla, out of sight.
const hidden = await page.evaluate(() => {
  const sc = document.getElementById("bzagScroll");
  const hive = document.querySelector(".bzag-hive").getBoundingClientRect();
  const bz = document.querySelector('[data-agent="bzilla"]').getBoundingClientRect();
  return { scrollTop: sc.scrollTop, hiveBottom: Math.round(hive.bottom), bzTop: Math.round(bz.top), label: !document.querySelector(".bzag-peek").hidden };
});
check("the Hive is above BeeZilla, scrolled out of sight, with a label to say so", hidden.scrollTop > 0 && hidden.hiveBottom <= 20 && hidden.bzTop < 40 && hidden.label, hidden);
await shot("hive-1-hidden");
await page.click(".bzag-peek");
await page.waitForTimeout(700);
check("pressing the label scrolls up to the Hive", await page.evaluate(() => document.getElementById("bzagScroll").scrollTop === 0 && document.querySelector(".bzag-peek").hidden));

// An agent with a job, and a conversation with it that asks BeeZilla.
const first = (await api("GET", "/api/buzzy/agents")).agents[0];
await api("POST", `/api/buzzy/agents/${first.id}/identity`, { text: "You're in charge of my calendars" });
await page.evaluate(() => window.BeeZillaAgents.refresh());
await page.waitForTimeout(500);
await page.click(`#bzAgents .bzag-item[data-agent="${first.id}"]`);
await page.waitForFunction(() => document.documentElement.getAttribute("data-bz-agent"), null, { timeout: 8000 });
await page.waitForTimeout(800);
await send("Please ask BeeZilla which day this week is free");
await page.waitForFunction(() => /Fake model reply/.test(document.getElementById("chatMessages")?.innerText || ""), null, { timeout: 25000 });
await page.waitForTimeout(500);

// Open the Hive and read it.
await page.click(".bzag-hive");
await page.waitForSelector("#bzHive");
await page.waitForFunction(() => document.querySelectorAll("#bzHive .bzh-msg").length >= 2, null, { timeout: 8000 }).catch(() => {});
let h = await hiveText();
check("the Hive shows 'asked BeeZilla' and the answer", /asked BeeZilla/.test(h) && /BeeZilla answered/.test(h), h.slice(0, 300));
check("the Hive remembers when the agent was given its job", /took on a job|calendars/.test(h), h.slice(0, 300));
await shot("hive-2-window");
// not a modal: the page behind still works while it is open
await page.mouse.click(1000, 700);
await page.waitForTimeout(250);
check("a press on the page leaves the Hive open", !!(await page.$("#bzHive")));
check("the page behind the Hive is still usable while it is open", await page.evaluate(() => !document.getElementById("chatInput").disabled));

// BeeZilla asks an agent by name; the open window picks it up without a reload.
await page.locator('#bzAgents .bzag-item[data-agent="bzilla"]').click();
await page.waitForFunction(() => !document.documentElement.getAttribute("data-bz-agent"), null, { timeout: 8000 });
await page.waitForTimeout(600);
const before = await page.evaluate(() => document.querySelectorAll("#bzHive .bzh-msg").length);
await send(`Please ask ${first.name} what is on its list today`);
await page.waitForFunction(() => /Fake model reply/.test(document.getElementById("chatMessages")?.innerText || ""), null, { timeout: 25000 });
await page.waitForFunction((n) => document.querySelectorAll("#bzHive .bzh-msg").length >= n + 2, before, { timeout: 12000 }).catch(() => {});
h = await hiveText();
check("BeeZilla asking an agent by name shows in the open window, with its answer", new RegExp("BeeZilla asked " + first.name).test(h) && new RegExp(first.name + " answered BeeZilla").test(h), h.slice(-300));
await shot("hive-3-both");

// Esc and X, never an outside press.
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Esc closes the Hive", !(await page.$("#bzHive")));
await page.click(".bzag-hive");
await page.waitForSelector("#bzHive");
await page.click("#bzHive .bzh-x");
await page.waitForTimeout(300);
check("its X closes it", !(await page.$("#bzHive")));
check("no page errors", problems.length === 0, problems.slice(0, 3));
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
await context.close();
process.exit(fails ? 1 : 0);
