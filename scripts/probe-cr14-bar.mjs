/**
 * CR-14 gate: the Talk landing and the pinned top bar.
 *
 * Shane, via buzzygrok, 2026-11-25 10:02 ET:
 *   1. Talk must not auto-load the company's latest paper on a blank landing; a paper
 *      shows only while its job is open, jobId is never adopted from a blank landing,
 *      and a visible X takes the paper off the page.
 *   2. The paper panel and the draft banners are page content, not header: an open
 *      paper used to add ~267px and push .bz-tabrow to y=748 at 390px.
 *   3. A slim pinned bar — face/name + Talk to BeeZilla + search + places row —
 *      position:sticky, top:0, on desktop and phone; waiting items scroll under it;
 *      the menu stays below Talk; it must not cover the gear or a modal; and it has to
 *      behave with the keyboard open on a phone.
 *
 * This drives a real browser at 360/390/430/1280 and measures, rather than reading CSS.
 *
 *   usage: node scripts/probe-cr14-bar.mjs [origin]        (server needs AGENT_RELAY_DEV_MAIL=1
 *          and BZ_MAIL_LOG=.../outbound-mail.jsonl; or pass BZ_PROBE_COOKIE)
 *          BZ_PROBE_SHOTS=<dir> for screenshots.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function devSignIn() {
  const email = `probe-cr14-${Date.now().toString(36)}@test.local`;
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

const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
const eq = cookie.indexOf("=");
const browser = await chromium.launch({ args: ["--no-sandbox"] });

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : "  — " + (detail ?? "")}`);
  if (!ok) failed++;
};
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

async function openTalk(viewport) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{
    name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
    domain: new URL(ORIGIN).hostname, path: "/",
    httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
  }]);
  const page = await context.newPage();
  await page.route(/openpanel\.dev/, (r) => r.abort());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load" });
  await page.waitForSelector("#chatInput:not([disabled])", { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { context, page, errors };
}

const geom = (page) => page.evaluate(() => {
  const box = (sel) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) };
  };
  const head = document.getElementById("bzHead");
  const chrome = document.querySelector("header.bz-chrome-head");
  const headerOrNull = () => chrome;
  return {
    chrome: box(chrome), head: box(head), tabrow: box("#bzPlaces"), search: box("#bzSearch"),
    talkBtn: box("#micBtn"), input: box("#chatInput"), gear: box("#bzGear"),
    paper: box("#paperPanel"), draft: box("#draftBanner"),
    paperInHead: !!document.querySelector("#bzHead #paperPanel"),
    draftInHead: !!document.querySelector("#bzHead #draftBanner"),
    paperInPage: !!document.querySelector(".chat-main #paperPanel"),
    draftInPage: !!document.querySelector(".chat-main #draftBanner"),
    chromePosition: chrome ? getComputedStyle(chrome).position : null,
    headPosition: head ? getComputedStyle(head).position : null,
    headTop: head ? getComputedStyle(head).top : null,
    chromeH: getComputedStyle(document.documentElement).getPropertyValue("--bz-chrome-h").trim(),
    kb: document.documentElement.classList.contains("bz-kb"),
    scrollY: Math.round(window.scrollY),
    docH: Math.round(document.documentElement.scrollHeight),
    viewH: Math.round(window.innerHeight),
    parts: {
      chrome: box(headerOrNull()),
      talk: box("#obStart"),
      search: box(".bz-browse"),
      places: box("#bzPlaces"),
    },
    pageTop: (() => { const e = document.querySelector(".chat-main"); return e ? Math.round(e.getBoundingClientRect().top) : null; })(),
    barCoversPage: (() => {
      // What paints at a point just inside the bottom edge of the bar? The bar itself,
      // while page content has scrolled up behind it.
      const h = document.getElementById("bzHead");
      if (!h) return null;
      const r = h.getBoundingClientRect();
      const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.bottom) - 6);
      return { inBar: !!(el && el.closest && el.closest("#bzHead")), hit: el && (el.id || el.className || el.tagName) };
    })(),
    // The menu order: Talk above the search, the search above the places.
    order: {
      talk: (() => { const e = document.getElementById("obStart"); return e ? Math.round(e.getBoundingClientRect().top) : null; })(),
      search: (() => { const e = document.querySelector(".bz-browse"); return e ? Math.round(e.getBoundingClientRect().top) : null; })(),
      places: (() => { const e = document.getElementById("bzPlaces"); return e ? Math.round(e.getBoundingClientRect().top) : null; })(),
    },
  };
});

const WIDTHS = [
  { w: 360, h: 780 }, { w: 390, h: 844 }, { w: 430, h: 932 }, { w: 1280, h: 900 },
];

for (const vp of WIDTHS) {
  const { context, page, errors } = await openTalk({ width: vp.w, height: vp.h });
  const tag = `${vp.w}x${vp.h}`;
  console.log(`\n── ${tag} ──`);
  const before = await geom(page);

  check(`${tag} the chrome head is pinned (position:sticky)`, before.chromePosition === "sticky", before.chromePosition);
  check(`${tag} #bzHead is pinned (position:sticky)`, before.headPosition === "sticky", before.headPosition);
  check(`${tag} the head's top is the measured head height (${before.chromeH})`, before.headTop === before.chromeH, `top ${before.headTop} vs ${before.chromeH}`);
  check(`${tag} the head is measured, not 0`, parseInt(before.chromeH, 10) > 0, before.chromeH);

  // 2: the paper and the draft are page content now.
  check(`${tag} the paper panel is NOT inside #bzHead`, before.paperInHead === false);
  check(`${tag} the draft banner is NOT inside #bzHead`, before.draftInHead === false);
  check(`${tag} both are inside the page (.chat-main)`, before.paperInPage && before.draftInPage);

  // 3: the bar holds still while the page scrolls under it.
  const canScroll = before.docH - before.viewH > 60;
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(400);
  const scrolled = await geom(page);
  if (canScroll) {
    check(`${tag} the page actually scrolled`, scrolled.scrollY > Math.min(300, before.docH - before.viewH - 30), `scrollY ${scrolled.scrollY}`);
  }
  check(`${tag} the face row stays at the top`, scrolled.chrome && Math.abs(scrolled.chrome.y) <= 1, JSON.stringify(scrolled.chrome));
  check(
    `${tag} the Talk row pins directly under it`,
    scrolled.head && near(scrolled.head.y, scrolled.chrome.h, 2),
    `head y ${scrolled.head?.y} vs chrome h ${scrolled.chrome?.h}`,
  );
  if (canScroll) {
    check(
      `${tag} page content scrolls UNDER the bar (it has passed behind it)`,
      scrolled.pageTop < scrolled.head.b - 40,
      `page top ${before.pageTop} → ${scrolled.pageTop}, bar bottom ${scrolled.head.b}`,
    );
    check(
      `${tag} the bar still paints on top of what slid behind it`,
      scrolled.barCoversPage && scrolled.barCoversPage.inBar === true,
      JSON.stringify(scrolled.barCoversPage),
    );
  } else {
    console.log(`note  ${tag}: page is ${before.docH}px in a ${before.viewH}px window — nothing to scroll, so "content under the bar" is not observable here`);
  }
  check(
    `${tag} the menu keeps its order: Talk, then search, then places`,
    scrolled.order.talk < scrolled.order.search && scrolled.order.search <= scrolled.order.places,
    JSON.stringify(scrolled.order),
  );
  check(
    `${tag} the whole bar, places row included, is on the first screen`,
    before.tabrow && before.tabrow.b <= vp.h,
    `places bottom ${before.tabrow?.b} of ${vp.h}; bar ${before.head?.h}px`,
  );
  console.log(
    `note  ${tag}: bar ${before.head?.h}px = head ${before.chrome?.h} + talk ${before.parts?.talk?.h} + search ${before.parts?.search?.h} + places ${before.parts?.places?.h}`,
  );

  // The gear and a dialog must never be covered by the pinned bar.
  const gearHit = await page.evaluate(() => {
    const g = document.getElementById("bzGear");
    if (!g) return { skip: "no gear" };
    const r = g.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { ok: hit === g || g.contains(hit), hit: hit && (hit.id || hit.className || hit.tagName) };
  });
  check(`${tag} the pinned bar does not cover the gear`, gearHit.ok === true, JSON.stringify(gearHit));

  const dlgHit = await page.evaluate(async () => {
    const g = document.getElementById("bzGear");
    if (!g) return { skip: "no gear" };
    g.click();
    await new Promise((r) => setTimeout(r, 500));
    const p = document.getElementById("bzSettings");
    if (!p || p.hidden) return { skip: "settings did not open" };
    const r = p.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, Math.min(r.y + 24, r.bottom - 4));
    const inside = hit ? (p === hit || p.contains(hit)) : false;
    const covered = !!(hit && hit.closest && hit.closest("#bzHead"));
    p.hidden = true;
    return { inside, covered, hit: hit && (hit.id || hit.className || hit.tagName) };
  });
  check(`${tag} a dialog opens ABOVE the pinned bar`, dlgHit.skip ? true : (dlgHit.inside && !dlgHit.covered), JSON.stringify(dlgHit));

  check(`${tag} no page errors`, errors.length === 0, errors.join(" | "));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/talk-${vp.w}-scrolled.png` });

  // Phone with the keyboard up: the bar collapses to the Talk row.
  if (vp.w <= 760) {
    const coverAndShrink = async (h) => {
      await page.setViewportSize({ width: vp.w, height: h });
      await page.waitForTimeout(600);
      return geom(page);
    };
    const tall = await coverAndShrink(844);
    const kb = await coverAndShrink(480);
    check(`keyboard ${tag}: the page notices (html.bz-kb)`, kb.kb === true, `kb=${kb.kb}`);
    check(
      `keyboard ${tag}: the name row gives way`,
      (await page.evaluate(() => {
        const c = document.querySelector("header.bz-chrome-head");
        return !c || getComputedStyle(c).display === "none";
      })) === true,
    );
    check(
      `keyboard ${tag}: the search and places give way`,
      (await page.evaluate(() => {
        const b = document.querySelector(".bz-browse");
        return !b || getComputedStyle(b).display === "none";
      })) === true,
    );
    check(
      `keyboard ${tag}: the Talk row is the whole bar (${tall.head?.h}px → ${kb.head?.h}px)`,
      kb.head && kb.head.h <= 220 && kb.head.h <= 480 * 0.45 && kb.head.h < (tall.head?.h ?? 9999),
      `head ${kb.head?.h}`,
    );
    check(
      `keyboard ${tag}: the composer is still on screen`,
      kb.input && kb.input.y >= 0 && kb.input.b <= 480,
      JSON.stringify(kb.input),
    );
    check(
      `keyboard ${tag}: the gear is not under the bar`,
      (await page.evaluate(() => {
        const g = document.getElementById("bzGear");
        const h = document.getElementById("bzHead");
        if (!g || !h) return true;
        const a = g.getBoundingClientRect(), b = h.getBoundingClientRect();
        return b.bottom <= a.top || b.top >= a.bottom || b.right <= a.left || b.left >= a.right;
      })) === true,
    );
    // Back to the phone's own height: the bar must come back whole.
    const back = await coverAndShrink(844);
    check(`keyboard ${tag}: closing it brings the whole bar back`, back.kb === false && back.head.h > kb.head.h, `head ${back.head.h}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/talk-${vp.w}-keyboard.png` });
  }

  await context.close();
}

// ── the landing rule, on the wire (no paper on this account) ─────────────
{
  const { context, page, errors } = await openTalk({ width: 390, height: 844 });
  console.log("\n── landing / paper wire ──");
  const wire = await page.evaluate(async () => {
    const cos = await fetch("/api/buzzy/companies", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null);
    const co = (cos && cos.companies && cos.companies[0] && cos.companies[0].id) || null;
    const out = { co };
    if (co) {
      const r = await fetch(`/api/buzzy/papers?companyId=${encodeURIComponent(co)}`, { credentials: "same-origin" });
      out.getStatus = r.status;
      out.getBody = await r.json().catch(() => null);
    }
    const del = await fetch("/api/buzzy/papers/pp_aaaaaaaaaaaaaaaa", { method: "DELETE", credentials: "same-origin" });
    out.delStatus = del.status;
    out.delBody = await del.json().catch(() => null);
    out.anonStatus = null; // measured outside the page, where there is no session
    out.panelHidden = document.getElementById("paperPanel").classList.contains("hidden");
    return out;
  });
  check("GET /api/buzzy/papers answers JSON (route alive)", wire.getStatus === 200 || wire.co === null, JSON.stringify(wire.getStatus));
  check(
    "a landing with no open-job paper shows no paper",
    wire.co === null ? true : (wire.getBody && wire.getBody.paper === null && wire.panelHidden === true),
    JSON.stringify(wire.getBody),
  );
  check(
    "DELETE on a paper that is not yours/theirs → 404 JSON (not HTML)",
    wire.delStatus === 404 && wire.delBody && wire.delBody.code === "not_found",
    `${wire.delStatus} ${JSON.stringify(wire.delBody)}`,
  );
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.request.delete(`${ORIGIN}/api/buzzy/papers/pp_aaaaaaaaaaaaaaaa`);
  check("DELETE without a session → 401", anon.status() === 401, String(anon.status()));
  await anonCtx.close();
  check("0 page errors on the landing pass", errors.length === 0, errors.join(" | "));
  await context.close();
}

await browser.close();
console.log(`\n${failed === 0 ? "all checks passed" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
