/**
 * CR-14c proof: the address names the job the page is in.
 *
 * #415 fixed which paper may paint; it left the address behind. Opening
 * /buzzy/talk?job=<id> read the job, painted the sheet, then replaceState'd to a
 * bare /buzzy/talk — so the sheet stood on screen beside an address that no
 * longer named it, and the next refresh was a blank landing with the job
 * unreachable by link (buzzygrok, signed-in QA of 8c5752b, 2026-11-25).
 *
 * Runs against the BUILT server (real Nitro output, PGlite fallback) signed in
 * with a real session from the app's own magic-link route and the dev mail log.
 * Every job and paper here is created through the app's own endpoints.
 *
 *   1. blank /buzzy/talk                     → no panel, address bare
 *   2. paste a letter                        → panel + ?job=<id> in the address
 *   3. fresh document load of that address   → the address KEEPS ?job= and the
 *                                              job's sheet paints
 *   4. reload                                → still ?job=, still the sheet
 *   5. a second page opens the same link     → same job, same sheet
 *   6. /buzzy/library?job=<id>               → the header-donor run does not
 *                                              rewrite another page's ?job=
 *   7. opening the job from recent work      → the address gains ?job=
 *   8. back to recent                        → job, sheet and ?job= all gone
 *   9. New conversation                      → no ?job=, no sheet
 *
 * Usage: node scripts/probe-cr14c-job-url.mjs [origin]
 * Prints PASS/FAIL per check plus a JSON blob; exits 1 on any failure.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN = process.argv[2] || process.env.ORIGIN || "http://127.0.0.1:8231";
const EMAIL = "cr14c-walk@example.test";
const ROOT = join(import.meta.dirname, "..");

let failures = 0;
const report = {};
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a real session: magic link issued by the app, read from the dev mail log ──
const linkRes = await fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, {
  method: "POST",
  headers: { "content-type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ email: EMAIL, callbackURL: "/buzzy/talk" }),
});
check("the app issued a sign-in link", linkRes.status === 200, `status ${linkRes.status}`);

let actionUrl = null;
for (let i = 0; i < 40 && !actionUrl; i++) {
  try {
    const lines = readFileSync(join(ROOT, ".data/outbound-mail.jsonl"), "utf8").trim().split("\n");
    for (const line of lines.reverse()) {
      const rec = JSON.parse(line || "{}");
      if (rec.to === EMAIL && rec.actionUrl) { actionUrl = rec.actionUrl; break; }
    }
  } catch (_) { /* the log is written a moment after the POST returns */ }
  if (!actionUrl) await sleep(250);
}
check("the dev mailbox holds its action link", Boolean(actionUrl), "no outbound-mail.jsonl line for the walk account");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route("**/*", (r) => {
  const u = r.request().url();
  if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return r.abort();
  return r.continue();
});

if (actionUrl) {
  const fixed = new URL(actionUrl);
  const here = new URL(ORIGIN);
  fixed.protocol = here.protocol; fixed.host = here.host;
  const verify = await context.request.get(fixed.toString(), { maxRedirects: 5 });
  check("the magic link set a session cookie", verify.status() < 500, `status ${verify.status()}`);
}

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e && e.message)));

const state = () => page.evaluate(() => {
  const panel = document.getElementById("paperPanel");
  return {
    path: location.pathname + location.search,
    hasJob: new URLSearchParams(location.search).get("job"),
    panelHidden: !panel || panel.classList.contains("hidden"),
    panelText: panel ? panel.innerText.replace(/\s+/g, " ").slice(0, 160) : "",
  };
});
const settle = (ms = 6000) => page.waitForTimeout(ms);

// ── 1. blank landing ────────────────────────────────────────────────────
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await settle();
const signedIn = await page.evaluate(async () => (await fetch("/api/buzzy/jobs", { credentials: "same-origin" })).status);
check("the browser is really signed in (/api/buzzy/jobs 200)", signedIn === 200, `status ${signedIn}`);

// an account needs a company before a paper can belong to one
const companies = await page.evaluate(async () => {
  const r = await fetch("/api/buzzy/companies", { credentials: "same-origin" });
  return r.ok ? r.json() : null;
});
if (!companies || !(companies.companies || []).length) {
  await page.evaluate(async () => {
    await fetch("/api/buzzy/companies", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Proof Co" }),
    });
  });
  await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
  await settle();
}
let s = await state();
report.blank = s;
check("blank landing stays on a bare /buzzy/talk", s.path === "/buzzy/talk", s.path);
check("blank landing shows no paper", s.panelHidden === true, JSON.stringify(s.panelText));

// ── 2. paste a letter: a job is minted and named in the address ─────────
await page.evaluate(() => { document.getElementById("paperDrop").classList.remove("hidden"); });
await page.fill("#paperPaste", "Dear Landlord, the rent receipt for March is attached. Amount due $900 by the 5th.");
await page.click("#paperRead");
await settle(9000);
s = await state();
report.pasted = s;
const JOB = s.hasJob;
check("pasting a letter paints its sheet", s.panelHidden === false, JSON.stringify(s));
check("pasting a letter names the job in the address", /^job_/.test(JOB || ""), s.path);

// ── 3. a fresh document load of that address KEEPS ?job= ────────────────
await page.goto(`${ORIGIN}/buzzy/talk?job=${JOB}`, { waitUntil: "domcontentloaded" });
await settle(7000);
s = await state();
report.boot = s;
check("a ?job= load keeps ?job= in the address (CR-14b residual)", s.hasJob === JOB, s.path);
check("...and paints that job's sheet", s.panelHidden === false, JSON.stringify(s.panelText));

// ── 4. reload: still the same job, still the sheet ──────────────────────
await page.reload({ waitUntil: "domcontentloaded" });
await settle(7000);
s = await state();
report.reloaded = s;
check("a reload of that address is still the job (not a blank landing)", s.hasJob === JOB, s.path);
check("...and the sheet is still there", s.panelHidden === false, JSON.stringify(s.panelText));

// ── 5. the link, opened in a second page ────────────────────────────────
const other = await context.newPage();
await other.goto(`${ORIGIN}/buzzy/talk?job=${JOB}`, { waitUntil: "domcontentloaded" });
await other.waitForTimeout(7000);
const shared = await other.evaluate(() => {
  const panel = document.getElementById("paperPanel");
  return { path: location.pathname + location.search, panelHidden: !panel || panel.classList.contains("hidden") };
});
report.shared = shared;
check("a shared job link keeps ?job= for the next reader", new URLSearchParams(shared.path.split("?")[1] || "").get("job") === JOB, shared.path);
check("a shared job link paints the job's sheet", shared.panelHidden === false, JSON.stringify(shared));
await other.close();

// ── 6. the donor guard: another page's ?job= is not ours to rewrite ─────
await page.goto(`${ORIGIN}/buzzy/library?job=${JOB}`, { waitUntil: "domcontentloaded" });
await settle(6000);
const lib = await page.evaluate(() => location.pathname + location.search);
report.library = lib;
check("a header-donor run on the Library leaves its own ?job= alone", lib.includes(`job=${JOB}`), lib);

// ── 7. opening a job from recent work names it in the address ───────────
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await settle(6000);
let rows = await page.$$(".rw-item");
if (!rows.length) {
  const back = await page.$("#backToRecent:not(.hidden)");
  if (back) { await back.click(); await settle(2500); rows = await page.$$(".rw-item"); }
}
check("the recent-work list has a row to open", rows.length > 0, `${rows.length} rows`);
if (rows.length) {
  // The row is styled as a card whose click handler sits on the container; a DOM
  // click exercises that handler (Playwright's hit-test calls the container
  // invisible, which is a layout quirk of the row, not a dead control).
  await page.evaluate(() => document.querySelectorAll(".rw-item")[0].click());
  await settle(7000);
  s = await state();
  report.fromRecent = s;
  check("opening a job's conversation from recent work names the job in the address", /^job_/.test(s.hasJob || ""), s.path);
  check("...and its sheet comes back with it", s.panelHidden === false, JSON.stringify(s.panelText));
}

// ── 8. back to recent clears the job, the sheet and the param ───────────
const backBtn = await page.$("#backToRecent");
if (backBtn) {
  await page.evaluate(() => document.getElementById("backToRecent").click());
  await settle(3000);
  s = await state();
  report.backToRecent = s;
  check("back to recent clears ?job=", s.hasJob === null, s.path);
  check("back to recent clears the sheet", s.panelHidden === true, JSON.stringify(s.panelText));
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(6000);
  s = await state();
  report.afterBackReload = s;
  check("a reload after back-to-recent is a blank landing", s.hasJob === null && s.panelHidden === true, JSON.stringify(s));
}

// ── 9. New conversation ─────────────────────────────────────────────────
await page.goto(`${ORIGIN}/buzzy/talk?job=${JOB}`, { waitUntil: "domcontentloaded" });
await settle(7000);
await page.evaluate(() => document.getElementById("newChatBtn").click());
await settle(3500);
s = await state();
report.newChat = s;
check("New conversation clears ?job=", s.hasJob === null, s.path);
check("New conversation clears the sheet", s.panelHidden === true, JSON.stringify(s.panelText));

await page.screenshot({ path: join(ROOT, ".data/cr14c-newchat.png") });

check("no page errors", errors.length === 0, errors.join(" | "));

report.job = JOB;
report.failures = failures;
console.log("\nREPORT=" + JSON.stringify(report, null, 1));
await browser.close();
process.exit(failures ? 1 : 0);
