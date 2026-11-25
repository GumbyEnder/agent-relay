// Nothing closes on a click outside it: only Esc or an X (owner, 2026-11-21), pressed
// outside the real pop-ups in a real browser, signed in, against a production build.
//
//   - the settings panel behind the gear (X, Esc; a press on the page does nothing)
//   - the privacy pop-up on the Talk bar (X, Esc)
//   - the AI key dialog (X, Esc), and what was typed in it survives the outside press
//
// usage: node scripts/probe-no-outside-close.mjs [origin]
//   (BZ_PROBE_CDP=<DevTools URL> to reuse a browser; BZ_MAIL_LOG=<server folder>/.data/outbound-mail.jsonl)
// Signs a throwaway account in through the dev magic-link inbox, like probe-soft-nav.mjs.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";

async function devSignIn() {
  const email = `probe-outside-${Date.now().toString(36)}@test.local`;
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

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};
const visible = (sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n || n.hidden || n.classList.contains("hidden")) return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden" && getComputedStyle(n).display !== "none";
}, sel);
// A press on the page, in an empty spot well away from every pop-up: the heading area.
const pressElsewhere = async () => { await page.mouse.click(420, 38); await page.waitForTimeout(250); };

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
await page.waitForSelector("#bzGear", { timeout: 15000 });
await page.waitForSelector("#privacyBtn");

// The settings panel behind the gear.
await page.click("#bzGear");
await page.waitForSelector("#bzSettings", { state: "visible" });
check("the gear opens the settings panel", await visible("#bzSettings"));
await pressElsewhere();
check("a press on the page leaves the settings panel open", await visible("#bzSettings"));
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Esc closes the settings panel", !(await visible("#bzSettings")));
await page.click("#bzGear");
await page.waitForSelector("#bzSettings", { state: "visible" });
await page.click("#bzSettings .bzs-close");
await page.waitForTimeout(250);
check("the settings panel's X closes it", !(await visible("#bzSettings")));

// The privacy pop-up.
await page.click("#privacyBtn");
await page.waitForSelector("#privacyPop:not(.hidden)");
check("the privacy button opens its pop-up", await visible("#privacyPop"));
await pressElsewhere();
check("a press on the page leaves the privacy pop-up open", await visible("#privacyPop"));
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Esc closes the privacy pop-up", !(await visible("#privacyPop")));
await page.click("#privacyBtn");
await page.waitForSelector("#privacyPop:not(.hidden)");
await page.click("#privacyClose");
await page.waitForTimeout(250);
check("the privacy pop-up's X closes it", !(await visible("#privacyPop")));

// The AI key dialog, with something typed in it.
await page.evaluate(() => window.bzOpenKeyDialog());
await page.waitForSelector(".ob-dialog", { state: "visible" });
await page.fill('.ob-dialog [name="apiKey"]', "sk-half-pasted-key");
await page.mouse.click(8, 8); // the dark backdrop around the box
await page.waitForTimeout(250);
check("a press on the dark around the key dialog leaves it open, with what was typed",
  await page.evaluate(() => !!document.querySelector(".ob-dialog") && document.querySelector('.ob-dialog [name="apiKey"]').value === "sk-half-pasted-key"));
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Esc closes the key dialog", !(await page.evaluate(() => !!document.querySelector(".ob-dialog"))));
await page.evaluate(() => window.bzOpenKeyDialog());
await page.waitForSelector(".ob-dialog", { state: "visible" });
await page.click(".ob-dialog .ob-x");
await page.waitForTimeout(250);
check("the key dialog's X closes it", !(await page.evaluate(() => !!document.querySelector(".ob-dialog"))));

check("no page errors", problems.length === 0, problems.slice(0, 3));
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
await context.close();
process.exit(fails ? 1 : 0);
