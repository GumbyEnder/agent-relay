// Nothing closes on a click outside it: only Esc or an X (owner, 2026-11-21), pressed
// against the real pop-ups in a real browser, signed in, on a production build — and at
// the widths a phone actually has, because a control that is off-screen or under an
// overlay is not an exit.
//
//   talk     the settings panel behind the gear (#bzSettings, .bzs-close; X, Esc)
//   talk     the privacy pop-up (#privacyPop, #privacyClose; X, Esc)
//   talk     the AI key dialog (.ob-dialog, .ob-x; X, Esc), typed key survives a press away
//   recipes  the purchase dialog (.bz-modal, .cancel named "Cancel")
//   recipes  "Use this recipe" dialog (.bz-modal, .cancel named "Close"), typed brief survives
//
// Per panel, three measurements plus the negative:
//   inside   — the exit control's box is wholly inside the layout viewport
//   hittable — document.elementFromPoint(centre) is the control (or inside it); an
//              element under an overlay screenshots fine and eats the tap
//   closes   — a real click on it takes the panel out of view
//   negative — a press outside leaves the panel open, with what was typed still there
//
// PRESENCE IS NOT OPEN/CLOSED — three mechanisms, so no single test covers all five:
//   #bzSettings  built once, toggled with [hidden]  → never removed; ask "visible"
//   #privacyPop  built once, toggled with .hidden   → never removed; ask visible
//   .ob-dialog   removed from the DOM               → ask "present"
//   .bz-modal    the two recipe dialogs, removed    → ask "present"
// Asking presence for the first two reports a false failure against code that closes
// correctly; that misread has already been filed as a bug once (#361).
//
// A recipe dialog has no X and that is correct: docs/BEEZILLA-SCREEN-RULES.md §Critical
// asks for "its own X (or a button that says Close or Cancel)". `.ob-x` lives only in
// voice-stage.js. Do not "fix" working code by counting controls instead of reading the rule.
//
// usage: node scripts/probe-no-outside-close.mjs [origin] [session] [widths]
//   origin   default http://127.0.0.1:8080
//   session  Playwright storageState .json, or a one-line `session_token=...` file.
//            Omitted, it signs a throwaway account in through the dev magic-link inbox
//            (BZ_MAIL_LOG, default .data/outbound-mail.jsonl) — the server must be booted
//            with AGENT_RELAY_DEV_MAIL=1 and AGENT_RELAY_MAIL_LOG_DIR pointing there.
//   widths   csv, default 360,390,430,1366
//   BZ_PROBE_CDP=<DevTools URL> reuses a running browser instead of launching one.
//
// The recipes half needs seeded demo data (SEAL_SEED_BASE + SEAL_SEED_COOKIE →
// scripts/seed-demo-recipes.ts) and a build carrying the private marketplace modules; an
// open build answers `marketplace_disabled`, and those two cases report FAIL rather than
// silently skipping. The browser's cookie jar is its own: a curl sign-in does not log the
// page in.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("playwright is not installed in this checkout — run `npm ci` first");
  process.exit(2);
}

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const SESSION = process.argv[3] || process.env.BZ_PROBE_SESSION || "";
const WIDTHS = (process.argv[4] || "360,390,430,1366").split(",").map(Number).filter(Boolean);
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

// Two session shapes, because two tools produce them: a Playwright storageState JSON from
// a signed-in browser, or the single `session_token=...` line the sign-in helpers write.
const cookieFile = (raw) => {
  if (raw.startsWith("{")) {
    const state = JSON.parse(raw);
    return (state.cookies || []).map((c) => ({ ...c, domain: c.domain || new URL(ORIGIN).hostname }));
  }
  const eq = raw.indexOf("=");
  return [{
    name: raw.slice(0, eq), value: raw.slice(eq + 1), domain: new URL(ORIGIN).hostname,
    path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
  }];
};
const sessionCookies = process.env.BZ_PROBE_COOKIE
  ? cookieFile(process.env.BZ_PROBE_COOKIE)
  : SESSION && existsSync(SESSION)
    ? cookieFile(readFileSync(SESSION, "utf8").trim())
    : cookieFile(await devSignIn());

const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });

let fails = 0;
const check = (w, name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} @${w} ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

const rect = (page, sel) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      sel: s,
      text: (n.textContent || "").trim().slice(0, 24),
      visible: r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden",
      left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom),
      w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight,
      inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
      hitIsSelf: !!(hit && (hit === n || n.contains(hit))),
      hitTag: hit ? hit.tagName + "." + (hit.className || "").toString().split(" ")[0] : null,
    };
  }, sel);
const present = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
// #bzSettings stays in the DOM toggled with [hidden] and #privacyPop with a .hidden class,
// so for those two "closed" means "not on screen", not "not in the document".
const shown = async (page, sel) => { const r = await rect(page, sel); return !!(r && r.visible); };
const vp = (page) => page.evaluate(() => [window.innerWidth, document.documentElement.clientWidth, document.documentElement.scrollWidth]);
const signedIn = (page) =>
  page.evaluate(async () => {
    const r = await fetch("/api/buzzy/graphs", { credentials: "same-origin" });
    return { path: location.pathname, status: r.status };
  });

for (const width of WIDTHS) {
  console.log(`\n=== ${width}px ===`);
  const context = await browser.newContext({
    viewport: { width, height: width >= 768 ? 800 : 780 },
    deviceScaleFactor: 1,
    hasTouch: width < 500,
    isMobile: width < 500,
  });
  await context.addCookies(sessionCookies);
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 160)));
  await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit
  const pressElsewhere = async () => {
    await page.mouse.click(Math.max(2, Math.round(width / 12)), 6);
    await page.waitForTimeout(250);
  };

  // ---- Talk: settings panel, privacy pop-up, AI key dialog ----
  await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#bzGear", { timeout: 20000 });
  await page.waitForSelector("#privacyBtn");
  await page.waitForTimeout(1200);
  const who = await signedIn(page);
  const [vw, cw, sw] = await vp(page);
  check(width, "signed in on /buzzy/talk", who.path === "/buzzy/talk" && who.status === 200, who);
  check(width, "viewport really applied", vw === width && cw === width, { innerWidth: vw, clientWidth: cw, scrollWidth: sw });

  // The settings panel behind the gear.
  await page.click("#bzGear");
  await page.waitForSelector("#bzSettings", { state: "visible" });
  await pressElsewhere();
  check(width, "outside press leaves the settings panel open", await shown(page, "#bzSettings"));
  const gearX = await rect(page, "#bzSettings .bzs-close");
  check(width, "settings X is on screen and hittable", !!gearX && gearX.inside && gearX.hitIsSelf, gearX);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(width, "Esc closes the settings panel", !(await shown(page, "#bzSettings")));
  await page.click("#bzGear");
  await page.waitForSelector("#bzSettings", { state: "visible" });
  await page.click("#bzSettings .bzs-close");
  await page.waitForTimeout(250);
  check(width, "the settings panel's X closes it", !(await shown(page, "#bzSettings")));

  // The privacy pop-up.
  await page.click("#privacyBtn");
  await page.waitForSelector("#privacyPop:not(.hidden)");
  await pressElsewhere();
  check(width, "outside press leaves the privacy pop-up open", await present(page, "#privacyPop:not(.hidden)"));
  const privX = await rect(page, "#privacyClose");
  check(width, "privacy X is on screen and hittable", !!privX && privX.inside && privX.hitIsSelf, privX);
  await page.click("#privacyClose");
  await page.waitForTimeout(250);
  check(width, "the privacy pop-up's X closes it", !(await present(page, "#privacyPop:not(.hidden)")));
  await page.click("#privacyBtn");
  await page.waitForSelector("#privacyPop:not(.hidden)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(width, "Esc closes the privacy pop-up (after focus moved)", !(await present(page, "#privacyPop:not(.hidden)")));

  // The AI key dialog, with something typed in it. The value is deliberately not
  // key-shaped: the question is whether a stray press loses typed text, not whether a
  // key validates.
  await page.evaluate(() => window.bzOpenKeyDialog());
  await page.waitForSelector(".ob-dialog", { state: "visible" });
  await page.fill('.ob-dialog [name="apiKey"]', "probe-not-a-real-key");
  await pressElsewhere();
  const keySurvives = await page.evaluate(() => {
    const d = document.querySelector(".ob-dialog");
    return !!d && d.querySelector('[name="apiKey"]').value;
  });
  check(width, "outside press leaves the key dialog open with the typed key", keySurvives);
  const keyX = await rect(page, ".ob-dialog .ob-x");
  check(width, "key dialog X is on screen and hittable", !!keyX && keyX.inside && keyX.hitIsSelf, keyX);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(width, "Esc closes the key dialog", !(await present(page, ".ob-dialog")));
  await page.evaluate(() => window.bzOpenKeyDialog());
  await page.waitForSelector(".ob-dialog", { state: "visible" });
  await page.click(".ob-dialog .ob-x");
  await page.waitForTimeout(250);
  check(width, "the key dialog's X closes it", !(await present(page, ".ob-dialog")));

  // ---- Recipes: the purchase dialog and "Use this recipe" ----
  await page.goto(`${ORIGIN}/buzzy/recipes`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#shelf button.buy", { timeout: 20000 });
  await page.waitForTimeout(800);
  const who2 = await signedIn(page);
  check(width, "signed in on /buzzy/recipes", who2.path === "/buzzy/recipes" && who2.status === 200, who2);

  const buy = page.locator("#shelf button.buy", { hasText: "Buy →" }).first();
  if (await buy.count()) {
    await buy.click();
    await page.waitForSelector(".bz-modal", { state: "visible" });
    const heads = await page.evaluate(() =>
      [...document.querySelectorAll(".bz-modal h2, .bz-modal button")].map((n) => (n.textContent || "").trim()));
    await pressElsewhere();
    check(width, "outside press leaves the purchase dialog open", await present(page, ".bz-modal"));
    const cancel = await rect(page, ".bz-modal .cancel");
    check(width, "purchase dialog's Cancel is on screen and hittable", !!cancel && cancel.inside && cancel.hitIsSelf, cancel);
    check(width, "purchase dialog has NO X (Cancel is its pointer exit)", !heads.includes("✕") && !heads.includes("×"), heads);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check(width, "Esc closes the purchase dialog", !(await present(page, ".bz-modal")));
    await page.locator("#shelf button.buy", { hasText: "Buy →" }).first().click();
    await page.waitForSelector(".bz-modal", { state: "visible" });
    await page.click(".bz-modal .cancel");
    await page.waitForTimeout(250);
    check(width, "Cancel closes the purchase dialog", !(await present(page, ".bz-modal")));
  } else {
    check(width, "a priced recipe is on the shelf", false);
  }

  // The owned recipe: claim the free one first.
  const claim = page.locator("#shelf button.buy", { hasText: "Claim it →" }).first();
  if (await claim.count()) {
    await claim.click();
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#shelf button.buy", { timeout: 20000 });
    await page.waitForTimeout(600);
  }
  const use = page.locator("#shelf button.buy", { hasText: "Use this recipe →" }).first();
  if (await use.count()) {
    await use.click();
    await page.waitForSelector(".bz-modal", { state: "visible" });
    await page.fill(".bz-modal textarea", "a brief that must survive a stray press");
    await pressElsewhere();
    const briefSurvives = await page.evaluate(() => {
      const t = document.querySelector(".bz-modal textarea");
      return !!t && t.value;
    });
    check(width, "outside press leaves the recipe dialog open with the brief", briefSurvives);
    const closeB = await rect(page, ".bz-modal .cancel");
    check(width, "recipe dialog's Close is on screen and hittable", !!closeB && closeB.inside && closeB.hitIsSelf, closeB);
    await page.click(".bz-modal .cancel");
    await page.waitForTimeout(250);
    check(width, "Close closes the recipe dialog", !(await present(page, ".bz-modal")));
  } else {
    check(width, "an owned recipe is on the shelf (Use this recipe)", false);
  }

  const after = await vp(page);
  check(width, "no sideways scroll", after[2] <= after[0] + 1, { innerWidth: after[0], scrollWidth: after[2] });
  check(width, "no page errors", problems.length === 0, problems.slice(0, 3));
  await context.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
await browser.close();
process.exit(fails ? 1 : 0);
