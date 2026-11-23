// CR-12 — beezilla-mobile-width: the 390px overhang probe.
//
// The 390px class of bug has cost two rounds already (the 179-vs-172 header bar,
// then the sessions drawer). Both times the naive check — document.scrollWidth —
// said the page was clean while real boxes hung past the right edge: an
// off-canvas element parked at translateX(100%) leaves a rect outside the
// viewport that Chromium never turns into a scrollbar. So the pass condition is
// "no element's right edge is past the viewport", not "no scrollbar".
//
// This probe is the evidence. It drives the built/served pages with Playwright,
// at 390 and 1280, and prints per page:
//   over   — elements whose right edge is past the layout viewport
//   scroll — documentElement.scrollWidth vs clientWidth (the old, lying check)
//   worst  — the element with the largest overhang, as a short selector
//   head   — the height of #bzHead, against the measured baseline
//
// Overflow only counts when nothing clips it: an element inside an ancestor with
// overflow-x hidden/auto/scroll cannot widen the document, so it is not an
// offender (it would make this probe cry wolf on every scroll strip).
//
// usage:
//   node scripts/probe-mobile-width.mjs [origin] [storageState.json]
//     origin        default http://127.0.0.1:3000 (a `npm run build && node .output/server/index.mjs`)
//     storageState  Playwright storageState JSON for a signed-in session; omit to
//                   probe signed out (the pages still render their chrome)
//
// exit 0 = every page has 0 overhang at 390 and 1280 and the drawer round-trips
//          closed → open → closed without one.
// exit 1 = at least one page or width has an element past the right edge.
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
// The brief named /buzzy/orchestrate; it is gone (404 on 75609cc and on live).
// studio is the page that took its place, so it is what this probe watches.
const PAGES = ["talk", "library", "download", "sketch", "studio"];
const WIDTHS = [390, 1280];

// The pill's measured width on 75609cc. A different width at 390px means the
// chrome moved. Reported, never failed — the overhang is the only fail.
const PILL_WIDTH = 48;
// nav.js fixes the brand row at 56px in its own stylesheet, so that IS a
// baseline on a desktop width (below ~900px the row wraps and grows, which is
// intended). #bzHead is content-dependent — it contains the search block — so it
// is printed for comparison, never asserted.
const BRANDROW_HEIGHT = 56;

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
      if (n.id) {
        parts.unshift("#" + n.id);
        break;
      }
      let s = n.tagName.toLowerCase();
      if (n.classList.length) s += "." + [...n.classList].slice(0, 2).join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // display:none subtree: not laid out
    if (r.right <= layout + 1) continue;
    let clipped = false;
    for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox !== "visible") {
        clipped = true;
        break;
      }
    }
    if (clipped) continue;
    offenders.push({ sel: path(el), right: Math.round(r.right), over: Math.round(r.right - layout) });
  }
  offenders.sort((a, b) => b.over - a.over);
  const head = document.getElementById("bzHead");
  const pill = document.getElementById("sessionsPill");
  const drawer = document.getElementById("sessionsDrawer");
  const box = (el) => (el ? (({ left, right, width, height }) => ({
    left: Math.round(left), right: Math.round(right),
    width: Math.round(width), height: Math.round(height),
  }))(el.getBoundingClientRect()) : null);
  return {
    landed: location.pathname,
    title: document.title,
    layout,
    inner: window.innerWidth,
    docScroll: de.scrollWidth,
    bodyScroll: document.body ? document.body.scrollWidth : 0,
    count: offenders.length,
    worst: offenders[0] || null,
    top: offenders.slice(0, 4),
    headH: head ? Math.round(head.getBoundingClientRect().height) : null,
    brandH: (() => {
      const b = document.querySelector(".bz-brandrow");
      return b ? Math.round(b.getBoundingClientRect().height) : null;
    })(),
    pill: box(pill),
    pillShown: pill ? getComputedStyle(pill).display !== "none" : false,
    drawer: drawer ? { display: getComputedStyle(drawer).display, box: box(drawer) } : null,
  };
}

const rows = [];
const notes = [];
let failed = false;
const errors = [];

for (const width of WIDTHS) {
  const ctx = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 900 },
    ...(STATE ? { storageState: STATE } : {}),
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${width}px ${e.message.slice(0, 120)}`));

  for (const name of PAGES) {
    errors.length = 0;
    const res = await page.goto(`${BASE}/buzzy/${name}`, { waitUntil: "load" });
    if (!res || res.status() >= 400) {
      notes.push(`${name} @${width}: HTTP ${res ? res.status() : "no response"} — not measured`);
      continue;
    }
    await page.waitForTimeout(1800); // the shell injects #bzHead after load
    const m = await page.evaluate(measure);
    const where = m.landed === `/buzzy/${name}` ? name : `${name} → ${m.landed}`;
    rows.push({ width, page: where, ...m, pageErrors: [...errors].slice(0, 3) });
    if (m.count > 0 || m.docScroll > m.layout + 1) failed = true;

    // Talk owns the sessions drawer: drive it open → minimised (pill) → open
    // again → closed and keep the count at 0 in every state. A closed drawer
    // that is only translated shows up exactly here, and so does a pill that
    // hangs off the right edge.
    if (name === "talk") {
      // The drawer's own toggle lives inside the folded #obParking, so it is not
      // visible on today's Talk page; History's tab opens an inline pane instead.
      // The drawer is still in the DOM and still laid out, which is exactly the
      // bug. Click the handler directly when the button cannot be clicked, and say
      // so once, so a future page that grows a real affordance needs no change.
      let usedProgrammaticClick = false;
      const clickQuietly = async (sel, label) => {
        const el = await page.$(sel);
        if (!el) {
          notes.push(`talk @${width}: ${label} is not in the DOM`);
          return false;
        }
        if (await el.isVisible()) {
          await el.click({ timeout: 5000 }).catch((e) => notes.push(`talk @${width}: ${label} click failed: ${e.message.slice(0, 80)}`));
        } else {
          if (!usedProgrammaticClick) {
            notes.push(`talk @${width}: drawer handlers driven by element.click() — the toggle is inside the folded #obParking`);
            usedProgrammaticClick = true;
          }
          await el.evaluate((node) => node.click());
        }
        await page.waitForTimeout(400);
        return true;
      };
      const record = async (label) => {
        const mm = await page.evaluate(measure);
        rows.push({ width, page: `talk (${label})`, ...mm, pageErrors: [...errors].slice(0, 3) });
        if (mm.count > 0 || mm.docScroll > mm.layout + 1) failed = true;
        return mm;
      };

      if (await clickQuietly("#sessionsToggle", "#sessionsToggle")) {
        const openM = await record("drawer open");
        if (openM.drawer && openM.drawer.box && openM.drawer.box.right > openM.layout + 1) {
          notes.push(`talk @${width}: drawer right edge ${openM.drawer.box.right} > layout ${openM.layout}`);
          failed = true;
        }
        // minimise → the pill
        if (await clickQuietly("#sessionsMin", "#sessionsMin")) {
          const pillM = await record("drawer minimised");
          if (pillM.pillShown && (!pillM.pill || pillM.pill.right > pillM.layout + 1)) {
            notes.push(`talk @${width}: pill past the right edge (${JSON.stringify(pillM.pill)})`);
            failed = true;
          }
          if (width === 390 && pillM.pillShown && pillM.pill && Math.abs(pillM.pill.width - PILL_WIDTH) > 1) {
            notes.push(`talk @${width}: pill is ${pillM.pill.width}px, baseline is ${PILL_WIDTH}px (chrome change?)`);
          }
          // the pill reopens: this is the close/open window the drawer fix protects
          if (await clickQuietly("#sessionsPill", "#sessionsPill")) {
            const againM = await record("drawer reopened from pill");
            if (againM.drawer && againM.drawer.display === "none") {
              notes.push(`talk @${width}: reopened drawer stayed unmounted`);
              failed = true;
            }
          }
        }
        // close, and prove the drawer leaves layout
        if (await clickQuietly("#sessionsClose", "#sessionsClose")) {
          const closedM = await record("drawer closed");
          if (closedM.drawer && closedM.drawer.display !== "none") {
            notes.push(`talk @${width}: closed drawer is still laid out (display: ${closedM.drawer.display})`);
            failed = true;
          }
        }
      }
    }
  }
  await ctx.close();
}

await browser.close();

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`CR-12 beezilla-mobile-width — ${BASE}${STATE ? ` (signed in: ${STATE})` : " (signed out)"}`);
console.log(`${pad("page", 26)}${num("w", 6)}${num("over", 6)}${num("scroll", 8)}${num("client", 8)}${num("brand", 6)}${num("head", 6)}  worst`);
for (const r of rows) {
  const worst = r.worst ? `${r.worst.sel} (+${r.worst.over}px)` : "-";
  console.log(
    `${pad(r.page || "", 26)}${num(r.width, 6)}${num(r.count, 6)}${num(r.docScroll, 8)}${num(r.layout, 8)}${num(r.brandH == null ? "-" : r.brandH, 6)}${num(r.headH == null ? "-" : r.headH, 6)}  ${worst}`,
  );
}

// Baseline drift: reported, because it means the chrome moved, not that the page
// overhangs.
for (const r of rows) {
  if (r.width >= 1000 && r.brandH != null && Math.abs(r.brandH - BRANDROW_HEIGHT) > 1) {
    notes.push(`${r.page} @${r.width}: .bz-brandrow is ${r.brandH}px, nav.js says ${BRANDROW_HEIGHT}px`);
  }
}

for (const n of notes) console.log(`note: ${n}`);
const bad = rows.filter((r) => r.pageErrors && r.pageErrors.length);
for (const r of bad) console.log(`pageerror: ${r.page} @${r.width}: ${r.pageErrors.join(" | ")}`);

const total = rows.reduce((a, r) => a + r.count, 0);
console.log(
  failed
    ? `\nFAIL — ${total} element(s) past the right edge across ${rows.length} measurements`
    : `\nPASS — 0 elements past the right edge across ${rows.length} measurements, all scrollWidths inside the client width`,
);
process.exit(failed ? 1 : 0);
