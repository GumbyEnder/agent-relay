// Sharing a page only after the person says yes (owner, 2026-11-21), in a real browser, signed in,
// against a built server.
//   1. Copy page link opens a window; nothing is made. It says anyone with the link, or who finds
//      it by searching the internet; it lists what a link shows; "Block searches" is ticked.
//   2. Esc and the X close it; a click outside does not. Still nothing is made.
//   3. QR code → Yes: the window shows the link and its QR code. A visitor with NO cookie reads the
//      page, and it tells search engines to keep out (header AND meta tag).
//   4. Untick Block searches → Update: index, follow. Tick it again → noindex again.
//   5. Stop sharing: the address answers 410 (noindex) and the copy is gone.
//   6. Advocate refuses and says how to switch; nothing is made.
//   7. It opens, styled, from another page (Library); a corner drags to resize.
// usage: node scripts/probe-page-share.mjs [origin]   (BZ_PROBE_CDP=<DevTools URL> to reuse a browser;
//        BZ_SHOT=<folder> writes a picture of each state; sign-in as in probe-bee-home.mjs)
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOT = process.env.BZ_SHOT || "";
if (SHOT) mkdirSync(SHOT, { recursive: true });

async function devSignIn() {
  const email = `probe-share-${Date.now().toString(36)}@test.local`;
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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN }).catch(() => {});
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

const api = async (method, p, data) => {
  const res = await context.request.fetch(ORIGIN + p, { method, data, headers: data ? { "content-type": "application/json" } : {} });
  return { status: res.status(), json: await res.json().catch(() => null) };
};
// A stranger: no cookie at all.
const stranger = async (p) => {
  const res = await fetch(ORIGIN + p, { redirect: "manual" });
  return { status: res.status, robots: res.headers.get("x-robots-tag"), cookie: res.headers.get("set-cookie"), text: await res.text() };
};
const shot = (name) => (SHOT ? page.screenshot({ path: path.join(SHOT, name + ".png") }) : Promise.resolve());
const settle = (ms = 500) => page.waitForTimeout(ms);
const box = () => page.locator(".pshare-box");
const textOf = async (sel) => (await page.locator(sel).first().innerText().catch(() => "")) || "";
const checks = {};
const note = (name, ok, detail) => { checks[name] = { ok: !!ok, detail }; };

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
await page.waitForFunction(() => window.BeeZillaShell && window.bzAddToBoard && window.BeeZillaPageShare && document.getElementById("bzChrome"), null, { timeout: 25000 });
await settle(800);
// Something on the board, saved to the account (a copy is built from the account's rows).
await page.evaluate(() => window.bzAddToBoard({ kind: "note", title: "Probe note", body: "hello <b>world</b> from the probe" }));
await page.waitForFunction(() => document.documentElement.classList.contains("ob-open"), null, { timeout: 8000 });
for (let i = 0; i < 40; i++) {
  const pre = await api("GET", "/api/buzzy/page-shares/preview?board=talk");
  if (pre.json && pre.json.canShare) break;
  await settle(300);
}
await page.evaluate(() => window.scrollTo(0, 0));

// 1. Copy page link: a window, and nothing made
await page.locator("#bzCopy").click();
await box().waitFor({ state: "visible", timeout: 8000 });
await page.locator(".pshare-list").waitFor({ timeout: 8000 });
const askText = await textOf(".pshare-box");
note("1: the window opens as a dialog", await page.evaluate(() => { const b = document.querySelector(".pshare-box"); return b && b.getAttribute("role") === "dialog" && b.getAttribute("aria-modal") === "true"; }));
note("1: it says anyone with the link, and by searching the internet", /anyone who has the link/i.test(askText) && /searching the internet/i.test(askText), askText.slice(0, 200));
note("1: it says everything on this page becomes readable, no sign-in", /everything on this page/i.test(askText) && /no sign-in/i.test(askText));
note("1: it lists what a link shows, with numbers", /Your Idea Board/.test(askText) && /\b1 card\b/.test(askText), askText);
note("1: it says what is left out", /Left out:.*Memory.*Library.*account details/i.test(askText), askText);
note("1: Block searches is ticked by default", await page.locator(".pshare-tick").isChecked());
note("1: the safe button has focus", await page.evaluate(() => document.activeElement && document.activeElement.textContent === "Cancel"));
const before = await api("GET", "/api/buzzy/page-shares/preview?board=talk");
note("1: nothing has been shared yet", before.json && before.json.active === null);
await shot("1-ask");

// 2. Esc closes; a click outside does not; the X closes
await page.keyboard.press("Escape");
await settle(300);
note("2: Esc closes it", (await box().count()) === 0);
await page.locator("#bzCopy").click();
await box().waitFor({ state: "visible" });
await page.mouse.click(8, 8); // on the dimmed page, outside the box
await settle(300);
note("2: a click outside does not close it", (await box().count()) === 1);
await page.locator(".pshare-x").click();
await settle(300);
note("2: the X closes it", (await box().count()) === 0);
const afterClose = await api("GET", "/api/buzzy/page-shares/preview?board=talk");
note("2: still nothing shared", afterClose.json && afterClose.json.active === null);

// A request that skips the question makes nothing
const skipped = await api("POST", "/api/buzzy/page-shares", { board: "talk" });
note("2: a request without the confirmation is refused", skipped.status === 400 && skipped.json.code === "confirm_needed");

// 3. QR code, Yes
await page.locator("#bzQr").click();
await box().waitFor({ state: "visible" });
await page.locator(".pshare-list").waitFor();
await page.getByRole("button", { name: "Yes, share this page" }).click();
await page.locator(".pshare-link").waitFor({ timeout: 10000 });
const link = await page.locator(".pshare-link").inputValue();
note("3: the link is an address on this site", new RegExp("^" + ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/buzzy/p/ps_[A-Za-z0-9_-]{43}$").test(link), link);
note("3: the QR code is drawn", (await page.locator(".pshare-qr svg").count()) === 1 && (await page.locator(".pshare-qr").isVisible()));
note("3: the window says it is shared and what went in", /This page is shared/.test(await textOf(".pshare-box")) && /In the copy: your idea board \(1 card\)/i.test(await textOf(".pshare-box")), await textOf(".pshare-box"));
note("3: it says searches are blocked", /Searches are blocked/.test(await textOf(".pshare-box")));
await shot("3-shared-qr");
const seen = await stranger(new URL(link).pathname);
note("3: a visitor with no cookie reads the page", seen.status === 200 && seen.text.includes("Probe note"), String(seen.status));
note("3: its markup was not run", seen.text.includes("hello &lt;b&gt;world&lt;/b&gt; from the probe") && !seen.text.includes("<b>world"));
note("3: the header tells search engines to keep out", /noindex/.test(seen.robots || "") && /nofollow/.test(seen.robots || ""), seen.robots);
note("3: so does the page itself", /<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">/.test(seen.text));
note("3: a visitor is given no cookie", !seen.cookie);

// 4. Untick → Update: index, follow; tick again → noindex
await page.locator(".pshare-tick").uncheck();
await page.getByRole("button", { name: "Update the copy" }).click();
await page.waitForFunction(() => /Search engines may list this page/.test(document.querySelector(".pshare-box")?.innerText || ""), null, { timeout: 8000 });
let again = await stranger(new URL(link).pathname);
note("4: unticked, the page says index, follow", again.robots === "index, follow" && /content="index, follow"/.test(again.text), again.robots);
await shot("4-unticked");
await page.locator(".pshare-tick").check();
await page.getByRole("button", { name: "Update the copy" }).click();
await page.waitForFunction(() => /Searches are blocked/.test(document.querySelector(".pshare-box")?.innerText || ""), null, { timeout: 8000 });
again = await stranger(new URL(link).pathname);
note("4: ticked again, noindex is back", /noindex/.test(again.robots || "") && /noindex/.test(again.text), again.robots);
note("4: the address did not change", (await page.locator(".pshare-link").inputValue()) === link);

// 5. Stop sharing
await page.getByRole("button", { name: "Stop sharing" }).click();
await page.waitForFunction(() => /No longer shared/.test(document.querySelector(".pshare-box")?.innerText || ""), null, { timeout: 8000 });
const gone = await stranger(new URL(link).pathname);
note("5: the address is turned off (410) and still keeps search engines out", gone.status === 410 && /noindex/.test(gone.robots || ""), String(gone.status));
note("5: the copy is gone from it", !gone.text.includes("Probe note"));
await shot("5-stopped");
await page.locator(".pshare-btn", { hasText: "Close" }).click();
await settle(300);

// 6. Advocate refuses
await api("PUT", "/api/buzzy/privacy", { mode: "advocate" });
await page.evaluate(() => { try { localStorage.setItem("bz.privacy", "advocate"); } catch (_) {} });
await page.locator("#bzCopy").click();
await box().waitFor({ state: "visible" });
await page.waitForFunction(() => /can't be shared right now/.test(document.querySelector(".pshare-box")?.innerText || ""), null, { timeout: 8000 });
const adv = await textOf(".pshare-box");
note("6: Advocate says why, and how to switch", /nothing is published/.test(adv) && /Switch to Open/.test(adv), adv);
note("6: no Yes button is offered", (await page.getByRole("button", { name: "Yes, share this page" }).count()) === 0);
await shot("6-advocate");
await page.keyboard.press("Escape");
const advPost = await api("POST", "/api/buzzy/page-shares", { board: "talk", confirm: true });
note("6: the server refuses too", advPost.status === 409 && advPost.json.code === "privacy_advocate");
await api("PUT", "/api/buzzy/privacy", { mode: "open" });
await page.evaluate(() => { try { localStorage.setItem("bz.privacy", "open"); } catch (_) {} });

// 7. From another page, styled; a corner resizes
await page.evaluate(() => window.BeeZillaShell.go("/buzzy/library"));
await page.waitForFunction(() => window.BeeZillaShell.currentKey === "/buzzy/library" && !window.BeeZillaShell.busy);
await settle(800);
await page.locator("#bzQr").click();
await box().waitFor({ state: "visible", timeout: 8000 });
await page.locator(".pshare-list, .pshare-lead").first().waitFor();
await page.waitForFunction(() => document.querySelector(".pshare-actions"), null, { timeout: 8000 });
const style = await page.evaluate(() => {
  const b = document.querySelector(".pshare-box");
  const cs = getComputedStyle(b);
  return { bg: cs.backgroundColor, position: cs.position, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) };
});
note("7: on Library it is styled (dark card, fixed)", style.bg === "rgb(21, 21, 21)" && style.position === "fixed", JSON.stringify(style));
await shot("7-on-library");
const grip = await page.locator(".pshare-grip-se").boundingBox();
if (grip) {
  await page.mouse.move(grip.x + 8, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(grip.x + 148, grip.y + 108, { steps: 6 });
  await page.mouse.up();
}
const grown = await page.evaluate(() => { const r = document.querySelector(".pshare-box").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
note("7: dragging a corner resizes it", grown.w >= style.w + 100 && grown.h >= style.h + 60, JSON.stringify({ style, grown }));
const left = await page.locator(".pshare-grip-w").boundingBox();
if (left) {
  const w1 = grown.w;
  await page.mouse.move(left.x + 3, left.y + left.height / 2);
  await page.mouse.down();
  await page.mouse.move(left.x - 77, left.y + left.height / 2, { steps: 5 });
  await page.mouse.up();
  const w2 = await page.evaluate(() => Math.round(document.querySelector(".pshare-box").getBoundingClientRect().width));
  note("7: dragging a side resizes it", w2 >= w1 + 60, `${w1} → ${w2}`);
}
await page.keyboard.press("Escape");
await settle(300);
note("7: Esc closes it here too", (await box().count()) === 0);

await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
note("no page errors", errors.length === 0, errors.join(" | "));

let pass = true;
for (const [name, r] of Object.entries(checks)) {
  console.log(r.ok ? "PASS" : "FAIL", name, r.ok ? "" : "— " + (r.detail ?? ""));
  if (!r.ok) pass = false;
}
console.log("VERDICT:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
