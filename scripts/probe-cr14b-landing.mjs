/**
 * CR-14b proof: a paper belongs to a job.
 *
 * On the BUILT server (real Nitro output, real Postgres), signed in as a real
 * account this script creates a session for via the app's own sign-in route:
 *
 *   1. blank /buzzy/talk          → no paper panel (the reported bug: it showed one)
 *   2. /buzzy/talk?job=<stale>    → the job's paper, and no "On <other job>" label
 *   3. paste a letter on a blank  → panel appears AND the address carries ?job=
 *   4. reload that address        → the panel is still there (reload-resume survives)
 *   5. New conversation           → panel gone, address clean
 *
 * Prints one line per check + a JSON blob. Exit 1 on any failure.
 */
import { chromium } from "playwright";

const ORIGIN = process.env.ORIGIN || "http://127.0.0.1:8217";
const EMAIL = "cr14b@example.test";
const PASSWORD = "prooflocal-123456";
const JOB = "job_proof14b0001";
const CO = "co_proof14b0001";

let failures = 0;
const report = {};
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route("**/*", (r) => {
  const u = r.request().url();
  if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return r.abort();
  return r.continue();
});

// A real session, issued by the app's own sign-in route; context.request shares the
// browser's cookie jar.
const signIn = await context.request.post(`${ORIGIN}/api/auth/sign-in/email`, {
  data: { email: EMAIL, password: PASSWORD },
  headers: { Origin: ORIGIN, "Content-Type": "application/json" },
});
check("signed in via /api/auth/sign-in/email", signIn.status() === 200, `status ${signIn.status()}`);

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e && e.message)));

const state = async () => page.evaluate(() => {
  const panel = document.getElementById("paperPanel");
  return {
    path: location.pathname + location.search,
    panelHidden: !panel || panel.classList.contains("hidden"),
    panelText: panel ? panel.innerText.slice(0, 200) : "",
  };
});

// ── 1. blank landing ────────────────────────────────────────────────────
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const signedIn = await page.evaluate(async () => (await fetch("/api/buzzy/jobs", { credentials: "same-origin" })).status);
check("the browser is really signed in (/api/buzzy/jobs 200)", signedIn === 200, `status ${signedIn}`);
let s = await state();
report.blank = s;
check("blank landing stays on /buzzy/talk", s.path === "/buzzy/talk", s.path);
check("blank landing shows NO paper (the reported bug)", s.panelHidden === true, JSON.stringify(s.panelText));

// ── 2. the job's own paper ──────────────────────────────────────────────
await page.goto(`${ORIGIN}/buzzy/talk?job=${JOB}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
s = await state();
report.job = s;
check("opening the job shows its paper", s.panelHidden === false, JSON.stringify(s));
check("the paper is the seeded one (need to do my taxes)", /need to do my taxes|IRS/i.test(s.panelText), s.panelText);
check("no 'On <other job>' label on the job's own sheet", !/On "/.test(s.panelText), s.panelText);

// ── 3. paste a letter on a blank conversation → job in the address ──────
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await page.evaluate(() => { document.getElementById("paperDrop").classList.remove("hidden"); });
await page.fill("#paperPaste", "Dear Landlord, the rent receipt for March is attached. Amount due $900 by the 5th.");
await page.click("#paperRead");
await page.waitForTimeout(9000);
s = await state();
report.pasted = s;
check("pasting a letter puts its sheet on the page", s.panelHidden === false, JSON.stringify(s));
check("...and the address now names the job (?job=)", /\?job=job_/.test(s.path), s.path);

// ── 4. reload → still the same job and the same sheet ───────────────────
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);
s = await state();
report.reloaded = s;
check("a reload keeps the job's paper on screen", s.panelHidden === false, JSON.stringify(s));

// ── 5. New conversation → no job, no sheet, clean address ───────────────
await page.evaluate(() => document.getElementById("newChatBtn").click());
await page.waitForTimeout(2500);
s = await state();
report.newChat = s;
check("New conversation drops the paper", s.panelHidden === true, JSON.stringify(s.panelText));
check("New conversation clears ?job= from the address", !/job=/.test(s.path), s.path);

check("no page errors", errors.length === 0, errors.join(" | "));

report.failures = failures;
console.log("\nREPORT=" + JSON.stringify(report, null, 1));
await browser.close();
process.exit(failures ? 1 : 0);
