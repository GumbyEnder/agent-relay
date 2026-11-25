// Soft-navigation gate (owner report, 19 Nov 2026, "a total disaster on Brave").
// Nothing here is about Brave: the same clicks broke every browser, and a reload
// hid the damage, which is why it looked like the ad blocker.
//   1. Open Sketch, go to Talk, come back to Sketch: Talk's back-to-top button stayed
//      on <body> with its stylesheet switched off, drew as a window-wide black chevron
//      ("half a diamond") and squeezed Sketch's drawing area to 0px.
//   2. Talk -> Sketch -> Talk: the chrome survived the hop but boot() deleted its
//      Feedback panel, so the yellow pill did nothing on any page until a reload.
// usage: node scripts/probe-soft-nav.mjs [origin]      (BZ_PROBE_CDP=<DevTools URL> to reuse a browser)
//   Signed-in pages need a session: set BZ_PROBE_COOKIE to a "name=value" session
//   cookie, or leave it unset against a local server and the probe signs a throwaway
//   account in through the dev magic-link inbox (BZ_MAIL_LOG, default
//   .data/outbound-mail.jsonl in the server's folder).
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";

async function devSignIn() {
  const email = `probe-softnav-${Date.now().toString(36)}@test.local`;
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
// BZ_PROBE_CDP: drive an already-running Chromium (its DevTools URL) instead of launching one.
const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
await context.addCookies([{
  name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
  domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
}]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

const hop = async (path) => {
  await page.evaluate((p) => window.BeeZillaShell.go(p), path);
  await page.waitForFunction((p) => window.BeeZillaShell.currentKey === p && !window.BeeZillaShell.busy, path);
  await page.waitForTimeout(800);
};
const feedbackOpens = async () => {
  await page.evaluate(() => document.getElementById("bzFeedback")?.classList.remove("open"));
  await page.locator("#bzChrome button.bz-ask", { hasText: "Feedback" }).click();
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const p = document.getElementById("bzFeedback");
    const r = p && p.getBoundingClientRect();
    return Boolean(p && p.classList.contains("open") && r.width > 0 && r.height > 0);
  });
};
const sketchState = () => page.evaluate(() => ({
  board: Math.round(document.querySelector("#bzPage #board")?.getBoundingClientRect().height ?? 0),
  // anything of Talk's still drawn outside a page (the stash is display:none)
  talkStrays: [...document.querySelectorAll(".bz-totop, .insp-overlay, .insp-mini, .sh-root")]
    .filter((n) => !n.closest("#bzPage, #bzPageCache")).length,
}));

await page.goto(`${ORIGIN}/buzzy/sketch`, { waitUntil: "load" });
await page.waitForFunction(() => window.BeeZillaShell && document.getElementById("bzChrome"));
await hop("/buzzy/talk");
await hop("/buzzy/sketch");
const sketch = await sketchState();
const fbOnSketch = await feedbackOpens();
await hop("/buzzy/talk");
const fbOnTalk = await feedbackOpens();
await hop("/buzzy/library");
const fbOnLibrary = await feedbackOpens();
await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();

const result = { origin: ORIGIN, sketch, feedback: { sketch: fbOnSketch, talk: fbOnTalk, library: fbOnLibrary }, pageErrors: errors };
console.log(JSON.stringify(result, null, 2));
const pass = sketch.board >= 200 && sketch.talkStrays === 0 && fbOnSketch && fbOnTalk && fbOnLibrary;
console.log("VERDICT:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
