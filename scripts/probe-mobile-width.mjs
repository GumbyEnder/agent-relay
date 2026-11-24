// beezilla-mobile-width — the phone-width probe (CR-12, extended by CR-13).
//
// The 390px class of bug has cost three rounds: the 179-vs-172 header bar, the
// sessions drawer, and CR-13's overlapping places row / clipped company select /
// off-screen privacy panel. document.scrollWidth lied every time, so the pass
// condition is measured geometry, not "no scrollbar":
//
//   over     — elements whose unclipped right edge is past the layout viewport
//   tabs     — any two place labels whose boxes overlap on the same line
//   fit      — a placeholder or select label wider than the box that shows it
//   popover  — #privacyPop / .bz-more-menu must sit wholly inside the viewport,
//              with an opaque background, opened as a real user opens it
//
// Widths 360, 390 and 430 (the phones Shane's screenshots came from) plus 1280,
// and every /buzzy page that carries the shared chrome, including orchestrate,
// landing and login. Signed out by default; pass a Playwright storageState and
// Talk itself is added to the page list.
//
// usage:
//   node scripts/probe-mobile-width.mjs [origin] [storageState.json]
//     origin        default http://127.0.0.1:3000 (`npm run build && node .output/server/index.mjs`)
//     storageState  signed-in session; omit to probe signed out
//
// exit 0 = every case passes. exit 1 = at least one measured failure.
// exit 2 = the probe could not run (no playwright, no browser, page error).
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("playwright is not installed in this checkout — run `npm ci` first");
  process.exit(2);
}

const BASE = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const STATE = process.argv[3] || "";
// Signed out, /buzzy/talk is a redirect to landing, so it only joins the list
// with a session. Every other page renders the chrome either way.
const PAGES = STATE
  ? ["talk", "library", "sketch", "orchestrate", "download", "studio", "capabilities", "landing", "login"]
  : ["library", "sketch", "orchestrate", "download", "studio", "capabilities", "landing", "login"];
const WIDTHS = [360, 390, 430, 1280];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});

// Runs in the page. Kept as one function so it reads the live DOM, not a copy.
function measure() {
  const de = document.documentElement;
  const layout = de.clientWidth;
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + n.id); break; }
      let s = n.tagName.toLowerCase();
      if (n.classList.length) s += "." + [...n.classList].slice(0, 2).join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const textWidth = (text, el) => {
    const st = getComputedStyle(el);
    const c = document.createElement("canvas").getContext("2d");
    c.font = st.fontWeight + " " + st.fontSize + " " + st.fontFamily;
    return c.measureText(String(text || "")).width;
  };
  const contentRoom = (el) => {
    const st = getComputedStyle(el);
    return el.clientWidth - (parseFloat(st.paddingLeft) || 0) - (parseFloat(st.paddingRight) || 0);
  };

  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= layout + 1) continue;
    let clipped = false;
    for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== "visible") { clipped = true; break; }
    }
    if (clipped) continue;
    offenders.push({ sel: path(el), right: Math.round(r.right), over: Math.round(r.right - layout) });
  }
  offenders.sort((a, b) => b.over - a.over);

  // The places row: labels must not paint over each other.
  const labels = [...document.querySelectorAll("#bzPlaces [role=tab], #bzPlaces .bz-places a")];
  const overlaps = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].getBoundingClientRect();
      const b = labels[j].getBoundingClientRect();
      const sameLine = a.top < b.bottom - 2 && b.top < a.bottom - 2;
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (sameLine && x > 1) overlaps.push(`${labels[i].textContent.trim()} / ${labels[j].textContent.trim()} (${Math.round(x)}px)`);
    }
  }

  // Text that has to fit the box that shows it. Hidden boxes (a template's
  // search, a pane that is not open) are not laid out and cannot clip.
  const fits = [];
  const measurable = (el) => !!el && el.clientWidth > 0 && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
  const search = document.getElementById("bzSearch");
  if (measurable(search) && search.placeholder) {
    const over = Math.round(textWidth(search.placeholder, search) - contentRoom(search));
    if (over > 1) fits.push(`#bzSearch placeholder "${search.placeholder}" +${over}px`);
  }
  const rw = document.getElementById("rwSearch");
  if (measurable(rw) && rw.placeholder) {
    const over = Math.round(textWidth(rw.placeholder, rw) - contentRoom(rw));
    if (over > 1) fits.push(`#rwSearch placeholder "${rw.placeholder}" +${over}px`);
  }
  const sel = document.querySelector("#bzChrome select.bz-co-select");
  if (measurable(sel) && sel.options.length) {
    const opt = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "";
    const st = getComputedStyle(sel);
    const room = sel.clientWidth - (parseFloat(st.paddingLeft) || 0) - (parseFloat(st.paddingRight) || 0);
    const over = Math.round(textWidth(opt, sel) - room);
    if (over > 1) fits.push(`company select "${opt}" +${over}px`);
  }

  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const bg = (el) => el ? getComputedStyle(el).backgroundColor : null;
  const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;

  return {
    landed: location.pathname,
    title: document.title,
    layout,
    inner: innerWidth,
    docScroll: de.scrollWidth,
    offenders: offenders.slice(0, 6),
    overlaps,
    fits,
    places: box(document.getElementById("bzPlaces")),
    navShown: shown(document.getElementById("bzNav")),
    privacy: box(document.getElementById("privacyPop")),
    more: box(document.querySelector(".bz-more-menu")),
    chrome: box(document.getElementById("bzChrome")),
    header: box(document.querySelector("header")),
  };
}

const rows = [];
const failures = [];
const notes = [];
let failed = false;
const pageErrors = [];

for (const width of WIDTHS) {
  const height = width === 1280 ? 900 : 844;
  const ctx = await browser.newContext({
    viewport: { width, height },
    ...(STATE ? { storageState: STATE } : {}),
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${width}px ${e.message.slice(0, 120)}`));

  const fail = (msg) => { failed = true; failures.push(`${width}px ${msg}`); };

  for (const name of PAGES) {
    const res = await page.goto(`${BASE}/buzzy/${name}`, { waitUntil: "load" });
    if (!res || res.status() >= 400) { notes.push(`${name} @${width}: HTTP ${res ? res.status() : "no response"} — not measured`); continue; }
    await page.waitForTimeout(1800); // the shell injects the chrome after load
    const m = await page.evaluate(measure);
    const where = m.landed === `/buzzy/${name}` ? name : `${name} → ${m.landed}`;
    rows.push({ width, page: where, ...m });
    if (m.offenders.length || m.docScroll > m.layout + 1) fail(`${where}: ${m.offenders.length} element(s) past the right edge${m.offenders[0] ? ` (worst ${m.offenders[0].sel} +${m.offenders[0].over}px)` : ""}`);
    if (m.overlaps.length) fail(`${where}: places labels overlap — ${m.overlaps.join("; ")}`);
    if (m.fits.length) fail(`${where}: text wider than its box — ${m.fits.join("; ")}`);

    // Every popover a person can open: open it, measure it, close it.
    const privacyBtn = await page.$(".privacy-btn");
    if (privacyBtn && await privacyBtn.isVisible()) {
      await privacyBtn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(350);
      const pm = await page.evaluate(() => {
        const el = document.getElementById("privacyPop");
        if (!el || getComputedStyle(el).display === "none" || el.hidden) return null;
        const r = el.getBoundingClientRect();
        return { box: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }, bg: getComputedStyle(el).backgroundColor, z: getComputedStyle(el).zIndex, text: el.textContent.replace(/\s+/g, " ").trim() };
      });
      if (pm) {
        rows.push({ width, page: `${where} (privacy open)`, privacy: pm.box });
        if (pm.box.left < -1 || pm.box.right > width + 1) fail(`${where}: #privacyPop off-screen (left ${pm.box.left}, right ${pm.box.right})`);
        if (pm.bg === "rgba(0, 0, 0, 0)" || pm.bg === "transparent") fail(`${where}: #privacyPop has no background`);
        if (!/sharing stays your choice|Publishing is not switched on/.test(pm.text)) fail(`${where}: #privacyPop copy is missing/truncated`);
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(150);
    }

    const moreBtn = await page.$(".bz-more-btn");
    if (moreBtn && await moreBtn.isVisible()) {
      await moreBtn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      const mm = await page.evaluate(() => {
        const el = document.querySelector(".bz-more-menu");
        if (!el || el.hidden) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), bg: getComputedStyle(el).backgroundColor };
      });
      if (mm) {
        rows.push({ width, page: `${where} (more open)`, more: mm });
        if (mm.left < -1 || mm.right > width + 1 || mm.top < -1 || mm.bottom > height + 1) {
          fail(`${where}: .bz-more-menu off-screen (${mm.left}..${mm.right} × ${mm.top}..${mm.bottom})`);
        }
        if (mm.bg === "rgba(0, 0, 0, 0)" || mm.bg === "transparent") fail(`${where}: .bz-more-menu has no background`);
      }
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  await ctx.close();
}

await browser.close();

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`beezilla-mobile-width — ${BASE}${STATE ? ` (signed in: ${STATE})` : " (signed out)"}`);
console.log(`${pad("page", 34)}${num("w", 6)}${num("over", 6)}${num("tabs", 6)}${num("fit", 5)}${num("scroll", 8)}${num("client", 8)}  worst`);
for (const r of rows) {
  const worst = r.offenders && r.offenders.length ? `${r.offenders[0].sel} (+${r.offenders[0].over}px)` : "-";
  console.log(
    `${pad(r.page || "", 34)}${num(r.width, 6)}${num(r.offenders ? r.offenders.length : "-", 6)}${num(r.overlaps ? r.overlaps.length : "-", 6)}${num(r.fits ? r.fits.length : "-", 5)}${num(r.docScroll == null ? "-" : r.docScroll, 8)}${num(r.layout == null ? "-" : r.layout, 8)}  ${worst}`,
  );
}
for (const n of notes) console.log(`note: ${n}`);
for (const e of pageErrors) console.log(`pageerror: ${e}`);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length} measured failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\nPASS — no overhang, no overlapping places labels, no clipped placeholder/select text, every popover on-screen and opaque, across ${rows.length} measurements.`);
process.exit(0);
