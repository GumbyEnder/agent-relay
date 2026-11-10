// BZ-11 gate, signed in: the chrome must land in the SAME box on every /buzzy
// page, whatever each page's own stylesheet does to body font/line-height. The
// chrome names its own metrics in nav.js; this probe proves it on the served bytes.
// usage: node probe-chrome-geom.mjs [origin] [storageState.json]
import { createRequire } from "node:module";
const require = createRequire("/home/gumbyender/agents/agent-relay/node_modules/");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "https://beezilla.net";
const STATE = process.argv[3] || "";
const PAGES = [
  "talk", "sketch", "studio", "library", "capabilities", "memory",
  "experts", "recipes", "wallet", "upload", "profile",
];

const browser = await chromium.launch({
  headless: true, executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(STATE ? { storageState: STATE } : {}) });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 140)));

const rows = [];
for (const p of PAGES) {
  errors.length = 0;
  await page.goto(`${BASE}/buzzy/${p}`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  rows.push({
    page: p,
    ...(await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      };
      const nav = document.getElementById("bzNav");
      const brand = document.querySelector(".bz-brandrow .bz-brand");
      return {
        title: document.title,
        brandText: brand ? brand.innerText.trim().replace(/\s+/g, " ") : null,
        markBox: box(document.querySelector(".bz-brandrow .bz-brand img")),
        clusterBox: box(document.querySelector(".bz-brandrow .bz-cluster")),
        acctBox: box(document.getElementById("accountLink")),
        planBox: box(document.querySelector(".bz-plan")),
        navBars: document.querySelectorAll(".bz-navbar").length,
        tabsVisible: !!(() => { const t = document.getElementById("companyTabs"); return t && getComputedStyle(t).display !== "none"; })(),
        // nav anchors only: document/asset links legitimately open a new tab
        navBlanks: nav ? nav.querySelectorAll('a[target="_blank"]').length : 0,
        skeleton: /\bSign in\b/.test((document.getElementById("accountLink") || {}).innerText || ""),
      };
    })),
    errors: errors.splice(0),
  });
}

const pick = (k) => rows.map((r) => r[k]);
const same = (k) => new Set(pick(k).map((v) => JSON.stringify(v))).size === 1;
const bits = {
  oneBrandText: [...new Set(pick("brandText"))],
  markSame: same("markBox"), clusterSame: same("clusterBox"),
  acctSame: same("acctBox"), planSame: same("planBox"),
  oneNavBar: pick("navBars").every((n) => n === 1),
  noCompanyTabs: pick("tabsVisible").every((v) => v === false),
  noNavBlankTarget: pick("navBlanks").every((n) => n === 0),
  skeletons: rows.filter((r) => r.skeleton).map((r) => r.page),
  pageErrors: rows.filter((r) => r.errors.length).map((r) => [r.page, r.errors]),
};
for (const r of rows) console.log(r.page.padEnd(13), JSON.stringify({ mark: r.markBox, cluster: r.clusterBox, acct: r.acctBox, plan: r.planBox }));
console.log(JSON.stringify(bits, null, 1));
const pass = bits.oneBrandText.length === 1 && bits.markSame && bits.clusterSame &&
  bits.acctSame && bits.planSame && bits.oneNavBar && bits.noCompanyTabs &&
  bits.noNavBlankTarget && bits.skeletons.length === 0 && bits.pageErrors.length === 0;
console.log("VERDICT:", pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
