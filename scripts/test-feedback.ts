/**
 * Tester feedback and admin access (src/lib/buzzy/feedback.ts).
 * Run: npx tsx scripts/test-feedback.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkFeedback, isAdminEmail, adminEmails, FEEDBACK_TEXT_MAX, SCREENSHOT_MAX } from "../src/lib/buzzy/feedback";

let failures = 0;
function check(ok: unknown, label: string): void {
  if (ok) return;
  failures++;
  console.error("FAIL", label);
}

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const good = checkFeedback({ text: "  The Talk button did nothing on my phone  ", page: "/buzzy/talk", screenshot: png });
check(good.ok && good.report.text === "The Talk button did nothing on my phone" && good.report.screenshot === png, "a report with a screenshot is kept, trimmed");
check(checkFeedback({ text: "no picture" }).ok, "a screenshot is optional");
check(!checkFeedback({ text: "   " }).ok, "an empty report is refused");
check(!checkFeedback({ text: "x".repeat(FEEDBACK_TEXT_MAX + 1) }).ok, "an over-long report is refused");
check(!checkFeedback({ text: "hi", screenshot: "data:text/html;base64,PGgxPmhpPC9oMT4=" }).ok, "only pictures count as screenshots");
check(!checkFeedback({ text: "hi", screenshot: "javascript:alert(1)" }).ok, "a script is not a screenshot");
check(!checkFeedback({ text: "hi", screenshot: "data:image/png;base64," + "A".repeat(SCREENSHOT_MAX) }).ok, "a huge picture is refused");
check(checkFeedback({ text: "hi", page: "/x".repeat(400) }).ok && (checkFeedback({ text: "hi", page: "/x".repeat(400) }) as { ok: true; report: { page: string } }).report.page.length === 300, "the page is cut to 300 characters");

const env = { BZ_ADMIN_EMAILS: " Owner@Example.test , ops@example.test,," };
check(adminEmails(env).size === 2, "admin emails are a trimmed, comma-separated list");
check(isAdminEmail("owner@example.test", env) && isAdminEmail("OPS@EXAMPLE.TEST", env), "admin emails match without case");
check(!isAdminEmail("someone@example.test", env) && !isAdminEmail(null, env) && !isAdminEmail("", env), "anyone else is not an admin");
check(!isAdminEmail("owner@example.test", {}), "with no BZ_ADMIN_EMAILS nobody is an admin");

// The pieces the page needs are still wired.
const root = resolve(import.meta.dirname, "..");
const nav = readFileSync(resolve(root, "public/buzzy/nav.js"), "utf8");
const server = readFileSync(resolve(root, "src/lib/buzzy/chat.nitro.ts"), "utf8");
const pages = readFileSync(resolve(root, "src/lib/buzzy/pages.nitro.ts"), "utf8");
check(nav.includes('"Send feedback"') && nav.includes('"/buzzy/feedback.js"'), "the menu under your name offers Send feedback");
check(server.includes('path === "/api/buzzy/feedback"') && server.includes('path === "/api/buzzy/admin/feedback"'), "the feedback routes exist");
check(/"testers"/.test(pages), "/buzzy/testers is a page");
check(readFileSync(resolve(root, "migrations/0058_buzzy_feedback.sql"), "utf8").includes("CREATE TABLE IF NOT EXISTS buzzy_feedback"), "the feedback table has a migration");

if (failures) {
  console.error(`feedback: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("feedback: all checks passed");
