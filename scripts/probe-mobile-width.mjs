// CR-12/CR-13 — beezilla-mobile-width: the phone-width layout probe.
//
// The 390px class of bug has cost several rounds: the 179-vs-172 header bar, the
// sessions drawer, then the CR-13 tab row that painted labels over each other and
// a privacy popover that opened past the LEFT edge of the screen. The naive checks
// were blind to all of it:
//   * document.scrollWidth misses an off-canvas box and a clipped-left popover;
//   * an element whose right edge is inside the viewport can still overlap its
//     neighbour, or clip its own placeholder text;
//   * a closed popover cannot be measured at all.
// So this probe drives the real states (tabs, More menu, account menu, Feedback,
// QR, privacy) at 360/390/430/1280, signed out AND signed in, and fails on: an
// element past the right edge where nothing clips it; two labels in a page's
// tab/link row overlapping; an input placeholder or a select value that does not
// fit its field; a popover/menu outside the viewport or see-through.
//
// Overflow counts only when nothing clips it: an element inside an ancestor with
// overflow-x hidden/auto/scroll cannot widen the document, so it is not an
// offender there.
//
// usage:
//   node scripts/probe-mobile-width.mjs [origin] [storageState.json]
//     origin        default http://127.0.0.1:3000 (built server)
//     storageState  Playwright storageState JSON for a signed-in session. When
//                   given, the probe runs BOTH passes (signed in, then signed
//                   out); without it, only the signed-out pass runs and says so.
//
// exit 0 = every check passed at every width in both passes that ran.
// exit 1 = at least one layout violation.
// exit 2 = the probe could not run (no playwright, no browser).
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
// /buzzy/orchestrate is live — the old comment claiming it 404s was stale — and it
// is one of the worst pages, so it is watched. The sign-in pages have no #bzHead
// and only render signed out, so they run in that pass.
const PAGES = [
  "talk", "library", "memory", "experts", "recipes", "sketch", "orchestrate",
  "studio", "capabilities", "download", "wallet", "upload",
];
const SIGNOUT_ONLY = ["landing", "login"];
const WIDTHS = [360, 390, 430, 1280];

// The pill's measured width. A different width at 390px means the chrome moved.
// Reported, never failed.
const PILL_WIDTH = 48;
// nav.js fixes the brand row at 56px in its own stylesheet, so that IS a
// baseline on a desktop width (below ~900px the row wraps and grows, which is
// intended). #bzHead is content-dependent, so it is printed, never asserted.
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
  const vh = window.innerHeight;
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
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left), right: Math.round(r.right),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      width: Math.round(r.width), height: Math.round(r.height),
    };
  };
  const shown = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const alpha = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const bits = m[1].split(",").map((s) => parseFloat(s));
    return bits.length > 3 ? bits[3] : 1;
  };

  // 1) Anything past the right edge that nothing clips.
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

  // 2) Labels in a row must not overlap. A wrapped row has several lines, so only
  // pairs on the same line (intersecting in both axes) count. One element can
  // match two of the selectors below, so dedupe the elements first.
  const overlaps = [];
  const labels = [];
  const seen = new Set();
  for (const sel of ["#bzTabs > button", ".bz-places > a", "#bzNav a", "#bzPlaces a"]) {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!shown(el)) continue;
      labels.push({ text: el.textContent.trim().slice(0, 24), sel, ...box(el) });
    }
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 1 && y > 1) overlaps.push(`${a.text} / ${b.text}`);
    }
  }

  // 3) Input placeholders and select values must fit their field. A <textarea>
  // placeholder may wrap across lines, so only <input> is measured for fit.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const clippedFields = [];
  for (const el of document.querySelectorAll("input[placeholder]")) {
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);
    const text = el.getAttribute("placeholder");
    if (!text) continue;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const need = ctx.measureText(text).width;
    const room = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (need > room + 1) clippedFields.push({ sel: path(el), kind: "placeholder", text, need: Math.round(need), room: Math.round(room) });
  }
  for (const el of document.querySelectorAll("select")) {
    if (!shown(el)) continue;
    const opt = el.options && el.options[el.selectedIndex];
    if (!opt) continue;
    // A select reserves room for its arrow (the chrome's own rule is 1.5rem of padding).
    const cs = getComputedStyle(el);
    const room = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - 24;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const need = ctx.measureText(opt.text).width;
    if (need > room + 1) clippedFields.push({ sel: path(el), kind: "select", text: opt.text, need: Math.round(need), room: Math.round(room) });
  }

  // 4) Open popovers: fully on screen, opaque.
  const popSel = ["#privacyPop", ".bz-more-menu", "#bzChrome .account-menu", "#bzFeedback", ".bz-qr-pop", "#bzSettings"];
  const popovers = [];
  for (const sel of popSel) {
    for (const el of document.querySelectorAll(sel)) {
      if (!shown(el)) continue;
      const b = box(el);
      const cs = getComputedStyle(el);
      popovers.push({
        sel,
        box: b,
        inside: b.left >= -1 && b.right <= layout + 1 && b.top >= -1 && b.bottom <= vh + 1,
        opaque: alpha(cs.backgroundColor) >= 1,
        bg: cs.backgroundColor,
      });
    }
  }

  const head = document.getElementById("bzHead");
  const pill = document.getElementById("sessionsPill");
  const drawer = document.getElementById("sessionsDrawer");
  return {
    landed: location.pathname,
    layout,
    inner: window.innerWidth,
    vh,
    docScroll: de.scrollWidth,
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
    overlaps,
    clippedFields,
    popovers,
  };
}

const rows = [];
const notes = [];
const violations = [];
const errors = [];

function record(row) {
  rows.push(row);
  const where = `${row.page} @${row.width}${row.pass === "signed-out" ? " (out)" : ""}`;
  if (row.count > 0 || row.docScroll > row.layout + 1) {
    violations.push(
      `${where}: ${row.count} element(s) past the right edge${row.worst ? ` — ${row.worst.sel} (+${row.worst.over}px)` : ""}` +
        `${row.docScroll > row.layout + 1 ? `, scrollWidth ${row.docScroll} > ${row.layout}` : ""}`,
    );
  }
  for (const o of row.overlaps) violations.push(`${where}: overlapping labels — ${o}`);
  for (const f of row.clippedFields) violations.push(`${where}: ${f.kind} "${f.text}" needs ${f.need}px in ${f.room}px — ${f.sel}`);
  for (const p of row.popovers) {
    if (!p.inside) violations.push(`${where}: ${p.sel} outside the viewport (${JSON.stringify(p.box)}, viewport ${row.layout}×${row.vh})`);
    if (!p.opaque) violations.push(`${where}: ${p.sel} is see-through (${p.bg})`);
  }
}

async function run(pass, width, statePath) {
  const ctx = await browser.newContext({
    viewport: { width, height: width >= 1000 ? 900 : 844 },
    ...(statePath ? { storageState: statePath } : {}),
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${pass} ${width}px ${e.message.slice(0, 140)}`));

  const pages = pass === "signed-out" ? PAGES.concat(SIGNOUT_ONLY) : PAGES;

  for (const name of pages) {
    errors.length = 0;
    const res = await page.goto(`${BASE}/buzzy/${name}`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) {
      notes.push(`${name} @${width} ${pass}: HTTP ${res ? res.status() : "no response"} — not measured`);
      continue;
    }
    await page.waitForTimeout(2200); // the shell injects #bzHead after load
    const m = await page.evaluate(measure);
    const where = m.landed === `/buzzy/${name}` ? name : `${name} → ${m.landed}`;
    record({ width, page: where, pass, ...m, pageErrors: [...errors].slice(0, 3) });

    // Open every menu/popover the page offers and measure it too.
    const openAndMeasure = async (clickSel, label) => {
      const btn = await page.$(clickSel);
      if (!btn || !(await btn.isVisible())) return;
      await btn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(350);
      const mm = await page.evaluate(measure);
      record({ width, page: `${name} (${label})`, pass, ...mm, pageErrors: [...errors].slice(0, 3) });
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(150);
    };
    await openAndMeasure("#privacyBtn", "privacy open");
    await openAndMeasure(".bz-more-btn", "more open");
    await openAndMeasure("#accountLink", "account open");
    await openAndMeasure("#bzChrome .bz-ask", "feedback open");
    await openAndMeasure("#bzQr", "qr open");

    // Talk owns the sessions drawer: drive it open → minimised (pill) → open
    // again → closed and keep the checks at 0 in every state. A closed drawer
    // that is only translated shows up exactly here, and so does a pill past the
    // right edge. The drawer's toggle lives inside the folded #obParking, so it is
    // not visible on today's Talk page; click the handler directly when needed.
    if (name === "talk") {
      let usedProgrammaticClick = false;
      const clickQuietly = async (sel, label) => {
        const el = await page.$(sel);
        if (!el) {
          notes.push(`talk @${width} ${pass}: ${label} is not in the DOM`);
          return false;
        }
        if (await el.isVisible()) {
          await el.click({ timeout: 5000 }).catch((e) => notes.push(`talk @${width} ${pass}: ${label} click failed: ${e.message.slice(0, 80)}`));
        } else {
          if (!usedProgrammaticClick) {
            notes.push(`talk @${width} ${pass}: drawer handlers driven by element.click() — the toggle is inside the folded #obParking`);
            usedProgrammaticClick = true;
          }
          await el.evaluate((node) => node.click());
        }
        await page.waitForTimeout(400);
        return true;
      };
      const again = async (label) => {
        const mm = await page.evaluate(measure);
        record({ width, page: `talk (${label})`, pass, ...mm, pageErrors: [...errors].slice(0, 3) });
        if (mm.drawer && mm.drawer.box && mm.drawer.box.right > mm.layout + 1) {
          violations.push(`talk @${width} ${pass}: drawer right edge ${mm.drawer.box.right} > layout ${mm.layout}`);
        }
        if (mm.pillShown && (!mm.pill || mm.pill.right > mm.layout + 1)) {
          violations.push(`talk @${width} ${pass}: pill past the right edge (${JSON.stringify(mm.pill)})`);
        }
        if (width === 390 && mm.pillShown && mm.pill && Math.abs(mm.pill.width - PILL_WIDTH) > 1) {
          notes.push(`talk @${width}: pill is ${mm.pill.width}px, baseline is ${PILL_WIDTH}px (chrome change?)`);
        }
        return mm;
      };
      if (await clickQuietly("#sessionsToggle", "#sessionsToggle")) {
        await again("drawer open");
        if (await clickQuietly("#sessionsMin", "#sessionsMin")) {
          await again("drawer minimised");
          if (await clickQuietly("#sessionsPill", "#sessionsPill")) {
            const reopened = await again("drawer reopened from pill");
            if (reopened.drawer && reopened.drawer.display === "none") {
              violations.push(`talk @${width} ${pass}: reopened drawer stayed unmounted`);
            }
          }
        }
        if (await clickQuietly("#sessionsClose", "#sessionsClose")) {
          const closed = await again("drawer closed");
          if (closed.drawer && closed.drawer.display !== "none") {
            violations.push(`talk @${width} ${pass}: closed drawer is still laid out (display: ${closed.drawer.display})`);
          }
        }
      }
    }
  }
  await ctx.close();
}

if (STATE) {
  for (const width of WIDTHS) await run("signed-in", width, STATE);
}
for (const width of WIDTHS) await run("signed-out", width, "");

await browser.close();

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`CR-13 beezilla-mobile-width — ${BASE}${STATE ? " (signed in + signed out)" : " (signed out only — pass a storageState for the signed-in pass)"}`);
console.log(`${pad("page", 30)}${pad("pass", 12)}${num("w", 6)}${num("over", 6)}${num("scroll", 8)}${num("client", 8)}${num("brand", 6)}${num("head", 6)}${num("ovl", 5)}${num("fit", 5)}${num("pop", 5)}  worst`);
for (const r of rows) {
  const worst = r.worst ? `${r.worst.sel} (+${r.worst.over}px)` : "-";
  console.log(
    `${pad(r.page || "", 30)}${pad(r.pass, 12)}${num(r.width, 6)}${num(r.count, 6)}${num(r.docScroll, 8)}${num(r.layout, 8)}${num(r.brandH == null ? "-" : r.brandH, 6)}${num(r.headH == null ? "-" : r.headH, 6)}${num(r.overlaps.length, 5)}${num(r.clippedFields.length, 5)}${num(r.popovers.length, 5)}  ${worst}`,
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
for (const r of rows.filter((x) => x.pageErrors && x.pageErrors.length)) {
  console.log(`pageerror: ${r.page} @${r.width} ${r.pass}: ${r.pageErrors.join(" | ")}`);
}

if (violations.length) {
  console.log(`\n${violations.length} violation(s):`);
  for (const v of violations.slice(0, 80)) console.log(`  FAIL ${v}`);
  if (violations.length > 80) console.log(`  … ${violations.length - 80} more`);
  console.log(`\nFAIL — ${violations.length} layout violation(s) across ${rows.length} measurements`);
  process.exit(1);
}
console.log(`\nPASS — ${rows.length} measurements; no overhang, no overlapping labels, every placeholder and select fits, every open popover on-screen and opaque`);
process.exit(0);
