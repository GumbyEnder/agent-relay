// The three privacy modes keep their own colours (owner, 2026-11-21): "open should be green,
// advocate should be yellow, lockdown should be red. But right now, the open icon is yellow,
// lockdown is red, advocate is yellow. So be careful with that."
//
// Real browser, no server: the privacy control's own markup (the Talk bar's #privacyBtn, its
// picker and the minimised pill, copied from talk.html) with the real privacy.css, in the dark
// and the light theme. For every mode and every state a person can put the button in (rest,
// pointer over it, picker open, keyboard focus) it reads what the browser actually draws and
// asks: is Open green, Advocate yellow, Lockdown red?
// usage: node scripts/probe-mode-colors.mjs            (BZ_PROBE_CDP=<DevTools URL> to reuse a browser;
//        BZ_SHOT=<folder> writes a picture of each theme)
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "public/buzzy/privacy.css"), "utf8");

// The markup is talk.html's (the button, its picker, the pill), so a rule that only matches
// the real thing is tested against the real thing.
const markup = `
<div style="display:flex;justify-content:flex-end;gap:16px;align-items:flex-start;padding:24px 24px 290px">
  <button type="button" id="privacyChip" class="privacy-chip hidden"></button>
  <div class="talk-privacy">
    <button type="button" id="privacyBtn" class="privacy-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="privacyPop" aria-label="Privacy"><span class="pv-icons"></span></button>
    <div class="privacy-pop hidden" id="privacyPop" role="dialog" aria-label="Privacy">
      <div class="pp-head"><strong>Privacy</strong></div>
      <div class="pp-slider" role="radiogroup" aria-label="Privacy mode">
        <span class="pp-thumb" aria-hidden="true"></span>
        <button type="button" role="radio" data-mode="advocate" aria-checked="false">Advocate</button>
        <button type="button" role="radio" data-mode="lockdown" aria-checked="false">Lockdown</button>
        <button type="button" role="radio" data-mode="open" aria-checked="false">Open</button>
      </div>
      <p class="pp-desc" id="privacyDesc">Your finished work can be shared with everyone.</p>
    </div>
  </div>
</div>`;

const MODES = ["open", "advocate", "lockdown"];
const WANT = { open: "green", advocate: "yellow", lockdown: "red" };

function parse(c) {
  const m = /rgba?\(([^)]+)\)/.exec(c || "");
  if (!m) return null;
  const [r, g, b, a] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return { r, g, b, a: a == null ? 1 : a };
}
// A colour's family by hue, ignoring greys (a button that is plain grey is "none").
function family(c, tint) {
  const p = parse(c);
  if (!p || p.a === 0) return "none";
  const r = p.r / 255, g = p.g / 255, b = p.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  // Dark tinted fills (a pill's #12301F) are coloured; only near-black or near-grey is "grey".
  // (`tint`: a pale wash such as the light theme's pill fill still has a hue worth reading.)
  if (tint ? d < 0.02 : max < 0.06 || d / max < 0.22) return "grey";
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h >= 85 && h <= 170) return "green";
  if (h >= 38 && h < 65) return "yellow";
  if (h >= 340 || h <= 14) return "red";
  if (h > 14 && h < 38) return "orange";
  return "other:" + Math.round(h);
}

const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 760, height: 420 } });
const results = [];
const failures = [];
const note = (theme, mode, where, got, want) => {
  const ok = got === want;
  results.push({ theme, mode, where, got, want, ok });
  if (!ok) failures.push(`${theme}/${mode}: ${where} is ${got}, should be ${want}`);
};

for (const theme of ["dark", "light"]) {
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head>` +
      `<body style="margin:0;background:${theme === "light" ? "#ffffff" : "#0E0E0E"};font-family:system-ui">${markup}</body></html>`,
  );
  const colors = (mode) => page.evaluate((m) => {
    const cs = (el, p) => getComputedStyle(el)[p];
    const btn = document.getElementById("privacyBtn");
    const chip = document.getElementById("privacyChip");
    const thumb = document.querySelector(".pp-thumb");
    const sel = document.querySelector('.pp-slider button[data-mode="' + m + '"]');
    return {
      btnColor: cs(btn, "color"), btnBorder: cs(btn, "borderTopColor"), btnIcon: cs(btn.querySelector(".pv-icons svg") || btn, "stroke"),
      btnOutline: cs(btn, "outlineColor"), btnOutlineStyle: cs(btn, "outlineStyle"),
      chipBorder: cs(chip, "borderTopColor"), chipBg: cs(chip, "backgroundColor"), chipText: cs(chip, "color"),
      thumbBg: cs(thumb, "backgroundColor"), selectedText: cs(sel, "color"),
    };
  }, mode);

  for (const mode of MODES) {
    // Paint exactly what privacy.js paints: the mode on the button, the picker and the pill.
    await page.evaluate((m) => {
      const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>';
      const btn = document.getElementById("privacyBtn");
      btn.innerHTML = '<span class="pv-icons">' + ICON + '</span><span class="pv-label">' + m + "</span>";
      btn.setAttribute("data-mode", m);
      btn.setAttribute("aria-expanded", "false");
      document.getElementById("privacyPop").classList.add("hidden");
      const chip = document.getElementById("privacyChip");
      chip.setAttribute("data-mode", m);
      chip.innerHTML = '<span class="pv-icons">' + ICON + "</span>" + m;
      chip.classList.add("hidden");
      document.querySelector(".pp-slider").setAttribute("data-mode", m);
      document.querySelectorAll(".pp-slider button").forEach((b) => b.setAttribute("aria-checked", b.getAttribute("data-mode") === m ? "true" : "false"));
    }, mode);
    await page.mouse.move(700, 400);
    const want = WANT[mode];

    // rest
    let c = await colors(mode);
    note(theme, mode, "button at rest", family(c.btnColor), want);

    // pointer over it
    await page.hover("#privacyBtn");
    c = await colors(mode);
    note(theme, mode, "button under the pointer", family(c.btnColor), want);
    await page.mouse.move(700, 400);

    // the picker open (aria-expanded) — what the owner sees right after pressing it
    await page.evaluate(() => {
      document.getElementById("privacyBtn").setAttribute("aria-expanded", "true");
      document.getElementById("privacyPop").classList.remove("hidden");
    });
    c = await colors(mode);
    note(theme, mode, "button with the picker open", family(c.btnColor), want);
    note(theme, mode, "picker's thumb", family(c.thumbBg), want);
    if (process.env.BZ_SHOT && mode === "open") {
      mkdirSync(process.env.BZ_SHOT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.BZ_SHOT, `modes-${theme}-open-picker.png`) });
    }
    await page.evaluate(() => {
      document.getElementById("privacyBtn").setAttribute("aria-expanded", "false");
      document.getElementById("privacyPop").classList.add("hidden");
    });

    // keyboard focus: the ring is the mode's colour too
    await page.focus("#privacyBtn");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    c = await colors(mode);
    note(theme, mode, "keyboard focus ring", c.btnOutlineStyle === "none" ? "none" : family(c.btnOutline), want);

    // the minimised pill
    await page.evaluate(() => document.getElementById("privacyChip").classList.remove("hidden"));
    c = await colors(mode);
    note(theme, mode, "pill's border", family(c.chipBorder), want);
    note(theme, mode, "pill's fill", family(c.chipBg, true), want);
    if (process.env.BZ_SHOT) {
      mkdirSync(process.env.BZ_SHOT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.BZ_SHOT, `modes-${theme}-${mode}.png`) });
    }
  }
  await page.close();
}
await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();

for (const r of results) if (!r.ok) console.log("FAIL", `${r.theme}/${r.mode}: ${r.where} is ${r.got}, should be ${r.want}`);
console.log(`${results.filter((r) => r.ok).length} of ${results.length} checks right`);
console.log("VERDICT:", failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
