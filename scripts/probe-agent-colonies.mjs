// Colonies in the Zilla agents sidebar, in a real browser, signed in, against a production build.
//
//   - one agent dragged onto another asks "Name your new colony", with grey examples chosen
//     from what the agents inside help with; a press outside it does nothing, Esc cancels
//   - Create makes the colony (a folder with its agents under it); it survives a reload
//   - an agent dropped on a colony joins it; dragged out to a gap it leaves; at a row's top
//     edge it goes before that row
//   - a colony opens and closes, can be renamed, and Ungroup keeps every agent
//   - every move also has a button: the agent's Edit window has a Colony choice
//   - BeeZilla's own prompt knows the colony's name and purpose (when BZ_FAKE_LLM is set)
//
// usage: node scripts/probe-agent-colonies.mjs [origin]    (BZ_PROBE_CDP, BZ_MAIL_LOG as probe-agents.mjs;
//   BZ_FAKE_LLM=<stand-in model's address> to also read the prompt BeeZilla was sent)
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function devSignIn() {
  const email = `probe-colonies-${Date.now().toString(36)}@test.local`;
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
  const r = await fetch("/api/buzzy/agents" + p, { method: m, credentials: "same-origin", headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  return r.json();
}, [method, path, body]);
const names = () => page.evaluate(() => [...document.querySelectorAll("#bzAgents .bzag-item:not(.bzag-hive)")].map((n) => (n.getAttribute("data-colony") ? "[colony] " : "") + (n.querySelector(".bzag-name")?.textContent || "")));
const item = (id) => `#bzAgents .bzag-item[data-agent="${id}"]`;
const modalOpen = () => page.evaluate(() => document.getElementById("bzAgentsModal")?.classList.contains("open"));

// Four agents with jobs, and the strip opened so the names show.
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
await page.evaluate(() => { localStorage.setItem("bz.agents.open", "1"); localStorage.removeItem("bz.agents.w"); });
await page.reload({ waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-item");
const first = (await api("GET", "")).agents[0];
const ids = [first.id];
for (let i = 0; i < 3; i++) ids.push((await api("POST", "", {})).agent.id);
const jobs = ["my to-do list", "calendars", "real estate listings", "music and movies"];
for (let i = 0; i < ids.length; i++) await api("POST", `/${ids[i]}/identity`, { text: jobs[i] });
await page.evaluate(() => window.BeeZillaAgents.refresh());
await page.waitForTimeout(600);
check("four agents, each with a job", (await names()).length === 5, await names());

// Drop one on another: the naming window.
await page.dragAndDrop(item(ids[1]), item(ids[0]));
await page.waitForSelector("#bzAgentsModal.open", { timeout: 5000 }).catch(() => {});
const dlg = await page.evaluate(() => ({
  title: document.querySelector("#bzAgentsModal h2")?.textContent,
  ph: [...document.querySelectorAll("#bzAgentsModal input[type=text]")].map((i) => i.placeholder),
  chips: [...document.querySelectorAll("#bzAgentsModal .bzag-chip")].map((c) => c.textContent),
}));
check("dropping one agent on another asks to name the new colony", await modalOpen() && /Name your new colony/.test(dlg.title || "") && dlg.chips.length === 2, dlg);
check("the grey examples fit the agents inside (to-do list + calendars: personal productivity)", /personal productivity/.test(dlg.ph[1] || ""), dlg.ph);
await shot("colonies-1-name-it");
await page.mouse.click(6, 6);
await page.waitForTimeout(250);
check("a press outside the naming window leaves it open", await modalOpen());
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Esc cancels, and no colony is made", !(await modalOpen()) && (await api("GET", "")).colonies.length === 0);

// Make it for real.
await page.dragAndDrop(item(ids[1]), item(ids[0]));
await page.waitForSelector("#bzAgentsModal.open");
await page.fill("#bzAgentsModal input[type=text] >> nth=0", "Daily life");
await page.fill("#bzAgentsModal input[type=text] >> nth=1", "These agents keep my days in order");
await page.click("#bzAgentsModal .bzag-btn.primary");
await page.waitForFunction(() => document.querySelector("#bzAgents .bzag-colony"));
await page.waitForTimeout(400);
let n = await names();
check("a colony 'Daily life' with its two agents under it", n.includes("[colony] Daily life") && n.length === 6, n);
await shot("colonies-2-made");
await page.reload({ waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-colony");
check("the colony is there after a reload, in the same place", (await names()).slice(0, 3).join("|") === "BeeZilla|[colony] Daily life|Bunnyzilla", await names());
const col = (await api("GET", "")).colonies[0];

// Join, leave, order.
await page.dragAndDrop(item(ids[2]), `#bzAgents .bzag-colony[data-colony="${col.id}"]`);
await page.waitForTimeout(600);
check("dropping an agent on a colony adds it", (await api("GET", "")).colonies[0].agentIds.length === 3 && !(await modalOpen()));
await page.dragAndDrop(item(ids[1]), "#bzagScroll", { targetPosition: { x: 60, y: 600 } });
await page.waitForTimeout(600);
const left = await api("GET", "");
check("dragged out to the gap, it leaves the colony and goes last", left.colonies[0].agentIds.length === 2 && left.layout[left.layout.length - 1].id === ids[1], left.layout);
await page.dragAndDrop(item(ids[3]), item(ids[1]), { targetPosition: { x: 40, y: 6 } });
await page.waitForTimeout(600);
const lay = (await api("GET", "")).layout.map((l) => l.id);
check("dropped on a row's top edge, it goes before that row", lay.indexOf(ids[3]) === lay.indexOf(ids[1]) - 1, lay);

// Open and close, rename.
await page.click(`#bzAgents .bzag-colony[data-colony="${col.id}"]`);
await page.waitForTimeout(400);
const closedNames = await names();
check("pressing a colony closes it", closedNames.length === 4 && !closedNames.includes("Bunnyzilla"), closedNames);
await page.reload({ waitUntil: "load" });
await page.waitForSelector("#bzAgents .bzag-colony");
check("a closed colony stays closed after a reload", (await names()).length === 4);
await page.click(`#bzAgents .bzag-colony[data-colony="${col.id}"]`);
await page.waitForTimeout(400);
await page.click(`#bzAgents .bzag-more[data-more-colony="${col.id}"]`);
await page.waitForSelector("#bzAgentsModal.open");
await page.fill("#bzAgentsModal input[type=text] >> nth=0", "Everyday");
await page.click("#bzAgentsModal .bzag-btn.primary");
await page.waitForFunction(() => !document.getElementById("bzAgentsModal").classList.contains("open"));
check("renaming a colony shows at once", (await names()).includes("[colony] Everyday"), await names());
await shot("colonies-3-renamed");

// The button route: the agent's Edit window.
await page.click(`#bzAgents .bzag-more[data-more="${ids[3]}"]`);
await page.waitForSelector("#bzAgentsModal.open");
const opts = await page.evaluate(() => [...document.querySelectorAll("#bzAgentsModal select option")].map((o) => o.textContent));
check("an agent's Edit window offers its colonies", opts.includes("Everyday") && opts.includes("On its own") && opts.includes("A new colony…"), opts);
await page.selectOption("#bzAgentsModal select", col.id);
await page.click("#bzAgentsModal .bzag-btn.primary");
await page.waitForFunction(() => !document.getElementById("bzAgentsModal").classList.contains("open"));
await page.waitForTimeout(600);
check("choosing the colony there moves the agent in", (await api("GET", "")).colonies[0].agentIds.includes(ids[3]));

// BeeZilla knows the colony (needs the stand-in model: BZ_FAKE_LLM).
if (process.env.BZ_FAKE_LLM) {
  await page.locator('#bzAgents .bzag-item[data-agent="bzilla"]').click();
  await page.waitForTimeout(500);
  await page.fill("#chatInput", "Who looks after my things?");
  await page.click("#chatSend");
  await page.waitForTimeout(2500);
  const seen = await (await fetch(process.env.BZ_FAKE_LLM + "/last")).json();
  const sys = seen.map((s) => s.system).join("\n");
  check("BeeZilla's own prompt names the colony and its purpose", /Everyday/.test(sys), sys.length);
}

// Ungroup keeps every agent.
await page.click(`#bzAgents .bzag-more[data-more-colony="${col.id}"]`);
await page.waitForSelector("#bzAgentsModal.open");
await page.click("#bzAgentsModal .bzag-btn.danger");
await page.click("#bzAgentsModal .bzag-btn.danger");
await page.waitForFunction(() => !document.querySelector("#bzAgents .bzag-colony"), null, { timeout: 6000 });
check("Ungroup removes the colony and keeps every agent", (await names()).length === 5 && (await api("GET", "")).colonies.length === 0, await names());

check("no page errors", problems.length === 0, problems.slice(0, 3));
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
await context.close();
process.exit(fails ? 1 : 0);
