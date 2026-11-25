// The bee is home (owner, 2026-11-21): "when you click the bee itself, like the Beezilla
// logo, it should bring you back to the top page with the thing folded away."
// What this checks, signed in, in a real browser against a built server:
//   A. Talk, Idea Board open        -> click the bee -> board folded, Inspiration under the row.
//   B. Talk, a search left open     -> click the bee -> search put away, the row of places back.
//   C. Talk, the Library place open -> click the bee -> Inspiration again.
//   D. Library (page hop, board opened above it) -> click the bee -> Talk, board folded.
//   E. Library opened on its own (a link, a reload) -> click the bee -> Talk, board folded.
//   F. Voice still running (simulated) -> click the bee -> the board STAYS folded.
//   G. Nothing reloaded: a marker on `window` survives A to D (it is a soft move, not a page load).
// usage: node scripts/probe-bee-home.mjs [origin]      (BZ_PROBE_CDP=<DevTools URL> to reuse a browser)
//   Sign-in works as in probe-soft-nav.mjs: BZ_PROBE_COOKIE="name=value", or leave it unset
//   against a local server and the probe signs a throwaway account in through the dev
//   magic-link inbox (BZ_MAIL_LOG, default .data/outbound-mail.jsonl in the server's folder).
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";

async function devSignIn() {
  const email = `probe-beehome-${Date.now().toString(36)}@test.local`;
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
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await context.addCookies([{
  name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
  domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
}]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

const ready = () => page.waitForFunction(() => window.BeeZillaShell && window.bzAddToBoard && window.bzBrowseSelect && document.getElementById("bzChrome") && !window.BeeZillaShell.busy, null, { timeout: 20000 });
const settle = (ms = 700) => page.waitForTimeout(ms);
const hop = async (path) => {
  await page.evaluate((p) => window.BeeZillaShell.go(p), path);
  await page.waitForFunction((p) => window.BeeZillaShell.currentKey === p && !window.BeeZillaShell.busy, path);
  await settle(800);
};
const bee = () => page.locator(".bz-brandrow a.bz-brand").first();
const look = () => page.evaluate(() => {
  const vis = (el) => !!el && !el.closest(".hidden") && !!(el.offsetWidth || el.offsetHeight);
  const on = document.querySelector("#bzTabs [data-tab].on");
  return {
    path: location.pathname,
    key: window.BeeZillaShell.currentKey,
    boardOpen: document.documentElement.classList.contains("ob-open"),
    boardShown: vis(document.getElementById("obBoard")),
    tab: on ? on.getAttribute("data-tab") : null,
    searchShown: vis(document.getElementById("bzResults")),
    readerShown: vis(document.getElementById("bzReader")),
    placesShown: vis(document.getElementById("bzTabs")),
    qrOpen: !!document.querySelector(".bz-qr-pop"),
    scrollY: Math.round(window.scrollY),
    marker: window.__beeProbe === "kept",
  };
});
const openBoard = async () => {
  await page.evaluate(() => window.bzAddToBoard({ kind: "note", title: "Probe note", body: "hello" }));
  await page.waitForFunction(() => document.documentElement.classList.contains("ob-open"), null, { timeout: 8000 });
  await settle(500);
};
const clickBee = async () => { await bee().click(); await settle(900); };

const out = {};

// A. Talk, board open
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
await ready();
await page.evaluate(() => { window.__beeProbe = "kept"; });
await settle(800);
out.startA = await look();
await openBoard();
await page.evaluate(() => window.scrollTo(0, 400));
out.beforeA = await look();
await clickBee();
out.A = await look();

// B. a search left open
await page.fill("#bzSearch", "probe");
await settle(1200);
out.beforeB = await look();
await clickBee();
out.B = await look();

// C. the Library place open
await page.evaluate(() => window.bzBrowseSelect("library"));
await settle(500);
out.beforeC = await look();
await clickBee();
out.C = await look();

// D. from Library by a page hop, with the board opened above it
await hop("/buzzy/library");
await openBoard();
out.beforeD = await look();
await clickBee();
out.D = await look();

// F. a voice session that is still running must not throw the board straight back open.
// The mic button's own handler is held back (no real microphone here); the board's "asked"
// flag is set by its capture listener, which runs first, and the voice state is faked on.
await page.evaluate(() => {
  const v = window.bzVoice;
  if (v) { v.mic = true; v.armed = false; }
  const mic = document.getElementById("micBtn");
  mic.addEventListener("click", (e) => e.stopImmediatePropagation(), true);
  mic.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  mic.setAttribute("aria-pressed", "true"); // the board watches this button
});
await settle(1200);
out.beforeF = await look();
await clickBee();
await settle(2500); // the board's own watchers get a few turns to reopen it
out.F = await look();
await page.evaluate(() => { const v = window.bzVoice; if (v) { v.mic = false; v.armed = false; } document.getElementById("micBtn").setAttribute("aria-pressed", "false"); });

// E. Library opened on its own
await page.goto(`${ORIGIN}/buzzy/library`, { waitUntil: "load" });
await page.waitForFunction(() => window.BeeZillaShell && document.getElementById("bzHead") && window.bzAddToBoard && !window.BeeZillaShell.busy, null, { timeout: 25000 });
await settle(1000);
await openBoard();
out.beforeE = await look();
await clickBee();
out.E = await look();

await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();

const folded = (s) => s.path === "/buzzy/talk" && s.key === "/buzzy/talk" && !s.boardOpen && !s.boardShown && s.tab === "inspiration" && s.placesShown && !s.searchShown && !s.readerShown && s.scrollY === 0;
const checks = {
  "A: board was open before": out.beforeA.boardOpen && out.beforeA.scrollY > 0,
  "A: bee folds the board, Inspiration, top": folded(out.A),
  "B: a search was open before": out.beforeB.searchShown,
  "B: bee puts the search away": folded(out.B),
  "C: the Library place was open before": out.beforeC.tab === "library",
  "C: bee goes back to Inspiration": folded(out.C),
  "D: Library with the board open above it": out.beforeD.key === "/buzzy/library" && out.beforeD.boardOpen,
  "D: bee lands on Talk, folded": folded(out.D),
  "F: voice on opened the board before the bee": out.beforeF.path === "/buzzy/talk" && out.beforeF.boardOpen,
  "F: the board stays folded after the bee, voice on": folded(out.F),
  "E: Library on its own, board open": out.beforeE.path === "/buzzy/library" && out.beforeE.boardOpen,
  "E: bee lands on Talk, folded": folded(out.E),
  "G: no page reload through A to D": out.A.marker && out.B.marker && out.C.marker && out.D.marker,
  "no page errors": errors.length === 0,
};
console.log(JSON.stringify({ origin: ORIGIN, ...out, pageErrors: errors }, null, 2));
let pass = true;
for (const [name, ok] of Object.entries(checks)) { console.log(ok ? "PASS" : "FAIL", name); if (!ok) pass = false; }
console.log("VERDICT:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
