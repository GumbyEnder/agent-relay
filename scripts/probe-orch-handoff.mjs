// Orchestrate -> Talk handoff probe.
//
// The bug it guards: orchestrate.html saved the canonical spec under
// `bz_orch_handoff` and hopped to /buzzy/talk?fromOrchestration=1, and nothing
// in Talk read either one — the plan vanished and the query hint meant nothing.
//
// usage: node scripts/probe-orch-handoff.mjs [origin]
//   Signed-in pages need a session: the probe signs a throwaway account in
//   through the dev magic-link inbox (BZ_MAIL_LOG, default
//   .data/outbound-mail.jsonl in the server's cwd), or set BZ_PROBE_COOKIE.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
// The rendered route (/buzzy/talk) is what ships; the raw file is accepted so the
// probe can run against a dev server, which serves public/ directly.
const TALK_PATH = process.argv[3] || "/buzzy/talk";
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";

async function devSignIn() {
  const email = `probe-orch-${Date.now().toString(36)}@test.local`;
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

const SPEC = {
  schema: "beezilla/orchestration", schemaVersion: 1,
  name: "Quote follow-up",
  description: "Chase every open quote twice, then hand the warm ones to a human.",
  direction: "TD", grid: 16, entry: "n_start",
  params: [], policy: { maxConcurrency: 2, budgetSec: 300, onError: "stop" },
  nodes: [
    { id: "n_start", type: "start", name: "Start", x: 96, y: 64, notes: "", config: {} },
    { id: "n_agent", type: "agent", name: "Find open quotes", x: 320, y: 64, notes: "", config: { prompt: "List every quote sent in the last 30 days with no reply." } },
    { id: "n_tool", type: "tool", name: "Send reminder", x: 544, y: 64, notes: "", config: { tool: "email.send" } },
    { id: "n_note", type: "note", name: "Internal", x: 96, y: 240, notes: "not a step", config: { text: "scratch" } },
    { id: "n_end", type: "end", name: "End", x: 96, y: 320, notes: "", config: { outputs: {} } },
  ],
  edges: [{ id: "e_1", from: { node: "n_start", port: "out" }, to: { node: "n_agent", port: "in" }, label: "", condition: null }],
  meta: { generator: "human" },
};

async function waitConsumed(page, ms = 4000) {
  // The door drops the key only after the document has stayed put for a beat, so
  // the checks below wait for the drop instead of racing it.
  await page.waitForFunction(() => window.localStorage.getItem("bz_orch_handoff") === null, null, { timeout: ms }).catch(() => {});
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}

const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
const eq = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{
  name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
  domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
}]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// Establish the origin first, then plant the key exactly as orchestrate.html
// leaves it (one write, no init script, so the second load really starts clean).
await page.goto(`${ORIGIN}${TALK_PATH}`, { waitUntil: "domcontentloaded" });
await page.evaluate((spec) => {
  window.localStorage.setItem("bz_orch_handoff", JSON.stringify(spec));
}, SPEC);

await page.goto(`${ORIGIN}${TALK_PATH}?fromOrchestration=1`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const el = document.getElementById("chatInput");
  return el && !el.disabled;
}, null, { timeout: 25000 }).catch(() => {});

const value = await page.$eval("#chatInput", (el) => el.value);
check("composer is filled", value.trim().length > 0, value.slice(0, 120));
check("names the plan", value.includes("Quote follow-up"));
check("says where it came from", /Orchestrate/.test(value));
check("lists the agent step with its prompt", value.includes("Find open quotes") && value.includes("last 30 days"));
check("lists the tool step", value.includes("Send reminder") && value.includes("email.send"));
check("skips the note node", !value.includes("scratch"));
check("does not send it", (await page.$$eval(".msg, .message, [data-role='user']", (n) => n.length)) === 0);
check("ends with the ask", /turn it into a draft/.test(value));

await waitConsumed(page);
const handoffLeft = await page.evaluate(() => window.localStorage.getItem("bz_orch_handoff"));
check("one-shot: key consumed", handoffLeft === null, String(handoffLeft).slice(0, 40));
const href = page.url();
check("query hint dropped", !/fromOrchestration/.test(href), href);

// A reload must not re-plant a stale plan.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const el = document.getElementById("chatInput");
  return el && !el.disabled;
}, null, { timeout: 25000 }).catch(() => {});
const afterReload = await page.$eval("#chatInput", (el) => el.value);
check("reload leaves the box empty", afterReload.trim() === "", afterReload.slice(0, 80));

// The first-run flake, modelled: a late get-session callback from an earlier Talk
// document fires the door in a document that has no composer. Before the fix the
// door consumed the key anyway, so the plan was gone and neither bz:page nor the
// auth callback could retry. No composer must mean "not yet", never "delivered".
await page.goto(`${ORIGIN}${TALK_PATH}`, { waitUntil: "domcontentloaded" });
const survived = await page.evaluate((spec) => {
  window.localStorage.setItem("bz_orch_handoff", JSON.stringify(spec));
  const real = document.getElementById.bind(document);
  document.getElementById = (id) => (id === "chatInput" ? null : real(id));
  try {
    window.dispatchEvent(new CustomEvent("bz:page", { detail: { key: "/buzzy/talk" } }));
  } finally {
    document.getElementById = real;
  }
  return window.localStorage.getItem("bz_orch_handoff");
}, SPEC);
check("no composer: the handoff is not consumed", survived !== null, String(survived).slice(0, 40));

// ...and the next load still delivers it, which is the whole point of not eating it.
await page.goto(`${ORIGIN}${TALK_PATH}?fromOrchestration=1`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const el = document.getElementById("chatInput");
  return el && !el.disabled;
}, null, { timeout: 25000 }).catch(() => {});
const retried = await page.$eval("#chatInput", (el) => el.value);
check("next load still delivers the plan", /Quote follow-up/.test(retried) && /Orchestrate/.test(retried), retried.slice(0, 90));
await waitConsumed(page);
check("retry consumed it", (await page.evaluate(() => window.localStorage.getItem("bz_orch_handoff"))) === null);

// The route a person actually takes: on the canvas, press Send, land on Talk.
// Two orders, because they exercise different doors:
//   A. Orchestrate loaded first -> Talk is fetched and its scripts run.
//   B. Talk kept alive, soft-hop to Orchestrate, Send -> Talk is only RESTORED,
//      no script of ours runs again, so only the bz:page door can catch it.
async function seedPlan() {
  await page.evaluate((spec) => { window.localStorage.setItem("bz_orch_spec", JSON.stringify(spec)); }, SPEC);
}
async function sendFromCanvas() {
  await page.waitForFunction(() => document.getElementById("btnSend"), null, { timeout: 20000 });
  await page.click("#btnSend");
  await page.waitForFunction(() => {
    const el = document.getElementById("chatInput");
    return el && el.value && el.value.includes("Orchestrate");
  }, null, { timeout: 20000 }).catch(() => {});
}
function composerValue() {
  return page.$eval("#chatInput", (el) => el.value).catch(() => "");
}

// A — fresh Orchestrate load, Talk not in the shell's cache.
await seedPlan();
await page.goto(`${ORIGIN}/buzzy/orchestrate`, { waitUntil: "domcontentloaded" });
await sendFromCanvas();
const freshValue = await composerValue();
check("Send from a fresh Orchestrate fills Talk", /Orchestrate/.test(freshValue) && /Quote follow-up/.test(freshValue), freshValue.slice(0, 90));
check("landed on Talk", /\/buzzy\/talk/.test(page.url()), page.url());
await waitConsumed(page);
check("handoff consumed (fresh load)", (await page.evaluate(() => window.localStorage.getItem("bz_orch_handoff"))) === null);

// B — Talk kept alive, orchestrate visited through the shell, Send comes back.
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const el = document.getElementById("chatInput");
  return el && !el.disabled;
}, null, { timeout: 25000 }).catch(() => {});
await seedPlan();
const softHop = await page.evaluate(async () => {
  if (!window.BeeZillaShell || !window.BeeZillaShell.go) return "no-shell";
  await window.BeeZillaShell.go("/buzzy/orchestrate");
  return "hopped";
});
check("shell hop to Orchestrate", softHop === "hopped", softHop);
await sendFromCanvas();
const keptValue = await composerValue();
check("Send to a kept-alive Talk still fills it", /Orchestrate/.test(keptValue) && /Quote follow-up/.test(keptValue), keptValue.slice(0, 90));
await waitConsumed(page);
check("handoff consumed (kept-alive Talk)", (await page.evaluate(() => window.localStorage.getItem("bz_orch_handoff"))) === null);

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
