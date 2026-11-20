/**
 * The tester surface: a report can carry a screenshot, an admin can read it, and
 * an admin can put a tester on a plan by email.
 *
 * This is a source-level test on purpose. The behaviour it guards — "the picture
 * is validated at the door AND at the column, and the admin read is gated" — is
 * one that a runtime test would only cover by sending a 1.1 MB data URL through
 * a live server. Reading the four files that must agree is cheap and fails loudly
 * when one of them drifts, which is exactly what happened between the tester kit
 * (0058, `text`/`page`/BIGSERIAL) and CR-6 (0059, `body`/`route`/TEXT id).
 */
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(ok: boolean, what: string) {
  if (ok) {
    passed += 1;
    console.log("  ok   " + what);
  } else {
    failed += 1;
    console.log("  FAIL " + what);
  }
}

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// ── the migration ────────────────────────────────────────────────────────────
const up = read("migrations/0062_buzzy_feedback_screenshot.sql");
const down = read("migrations/rollback/0062_buzzy_feedback_screenshot.down.sql");
check(/ADD COLUMN IF NOT EXISTS screenshot TEXT/.test(up), "0062 adds a nullable screenshot column");
check(/CHECK \(screenshot IS NULL OR char_length\(screenshot\) <= 1500000\)/.test(up), "0062 caps the picture in the column, not only at the door");
check(/DROP COLUMN IF EXISTS screenshot/.test(down), "the rollback drops the column");
check(!/NOT NULL/.test(up.replace(/--.*$/gm, "")), "the column stays nullable — most reports have no picture");

// ── the validator ────────────────────────────────────────────────────────────
const fb = read("src/lib/buzzy/feedback.ts");
check(/export const SCREENSHOT_MAX = 1_500_000/.test(fb), "SCREENSHOT_MAX matches the column's CHECK");
check(/const DATA_URL = \/\^data:image\\\/\(png\|jpeg\|webp\);base64/.test(fb), "only png/jpeg/webp data URLs are accepted");
check(/export function checkScreenshot/.test(fb), "checkScreenshot exists");
check(/if \(raw == null \|\| raw === ""\) return \{ ok: true, value: null \}/.test(fb), "no picture is a valid answer, not an error");
check(/export async function listFeedback/.test(fb), "listFeedback exists");
check(/SELECT f\.id, f\.ref, f\.created_at, f\.body, f\.route, f\.page_url/.test(fb), "listFeedback reads 0059's columns (body/route/page_url), not the tester kit's text/page");
check(/\(f\.screenshot IS NOT NULL\) AS has_screenshot/.test(fb), "the list says whether a picture exists without shipping the picture");
check(/ORDER BY f\.created_at DESC/.test(fb), "newest first");
check(/export async function feedbackScreenshot\(sql: Sql, id: string\)/.test(fb), "the screenshot read takes the TEXT id as a string");
check(/export async function userIdForEmail/.test(fb), "an admin can find an account by email");
check(/export function isAdminEmail/.test(fb) && /BZ_ADMIN_EMAILS/.test(fb), "admins come from BZ_ADMIN_EMAILS");

// ── the routes ───────────────────────────────────────────────────────────────
const nit = read("src/lib/buzzy/chat.nitro.ts");
check(/const shot = checkScreenshot\(raw\?\.screenshot \?\? null\)/.test(nit), "POST /api/buzzy/feedback validates the picture");
check(/screenshot\)\n          VALUES \(/.test(nit) && /\$\{shot\.value\}/.test(nit), "the picture is stored in the same row as the report");
check(/\?id=<report> returns that report's screenshot/.test(nit), "GET /api/buzzy/admin/feedback documents ?id=");
check(/if \(method === "GET" && path === "\/api\/buzzy\/admin\/feedback"\)/.test(nit), "the admin read exists");
check(/const one = queryValue\(fullPath, "id"\);\n    if \(one\) return \{ ok: true, id: one/.test(nit), "the id is passed through as a string — no Number() to turn it into NaN");
check(/async function adminAuthorized/.test(nit), "adminAuthorized exists");
check(/if \(!\(await adminAuthorized\(event\)\)\) \{\n      setResponseStatus\(event, 403\);\n      return \{ ok: false, error: "Only BeeZilla admins can read feedback/.test(nit), "reading reports is gated by admin, not by being signed in");
check(/let userId = String\(body\.user \?\? body\.userId \?\? ""\)\.trim\(\);/.test(nit), "the plan route still accepts an internal id");
check(/if \(!userId && body\.email\)/.test(nit) && /userIdForEmail\(await getSql\(\), String\(body\.email\)\)/.test(nit), "the plan route resolves a tester by email");
check(/code: "no_account"/.test(nit), "an unknown email is a 404, not a silent no-op");

// Being signed in must not be enough: the gate has to be an allowlist.
const gate = nit.slice(nit.indexOf("async function adminAuthorized"), nit.indexOf("async function adminAuthorized") + 400);
check(/opsAuthorized\(event\)/.test(gate) && /isAdminEmail/.test(gate), "admin = ops key OR an allowlisted email — nothing weaker");

// ── the page ─────────────────────────────────────────────────────────────────
const page = read("public/buzzy/testers.html");
check(/data-bz-active="testers"/.test(page), "the page marks itself active");
check(/id="bzNav"/.test(page), "it carries the one nav");
const navBlock = page.slice(page.indexOf('<nav id="bzNav">'), page.indexOf("</nav>"));
check((navBlock.match(/data-nav="/g) || []).length === 8, "exactly the eight canonical links — the page does not invent a ninth");
check(/\/api\/buzzy\/admin\/feedback/.test(page), "it reads reports from the admin route");
check(/\/api\/buzzy\/admin\/plan/.test(page), "it sets plans through the admin route");
check(/encodeURIComponent\(id\)/.test(page), "the report id is encoded, not coerced");
check(!/Number\(f\.id\)|Number\(j\.id\)/.test(page), "the page never turns a TEXT id into a number");

const pagesSrc = read("src/lib/buzzy/pages.nitro.ts");
check(/"testers"/.test(pagesSrc), "/buzzy/testers is a served page");
check(/const PAGES = new Set\(\[[\s\S]*"testers"\]/.test(pagesSrc), "and it sits in the page set");

// ── the panel ────────────────────────────────────────────────────────────────
const nav = read("public/buzzy/nav.js");
check(/id="bzFbShot"/.test(nav), "the feedback panel offers a screenshot");
check(/if \(shot\) payload\.screenshot = shot;/.test(nav), "the picture rides the same POST as the report");
check(/var SHOT_MAX = 1500000;/.test(nav), "the browser refuses an oversized picture before the round trip");
check(/if \(el\.id === "bzFbShotDrop"\)/.test(nav), "a person can remove the picture they attached");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
