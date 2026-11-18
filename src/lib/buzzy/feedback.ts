/**
 * Tester feedback and the admin side of user testing (owner, 2026-11-17):
 * "Collect confusion points, bug reports, screenshots, and real task results",
 * "Provide appropriate upgraded access for 3D and audio capabilities", "Finish the
 * administrative upgrade system".
 *
 * - Anyone signed in can send a report from "Send feedback" in the menu under their
 *   name: what they tried and what happened, plus an optional screenshot.
 * - Admins read the reports, and put a tester on a plan by email, on /buzzy/testers.
 *   An admin is an account whose email is listed in BZ_ADMIN_EMAILS (comma
 *   separated), or a caller holding the ops key, as before.
 */
import type { Sql } from "@/lib/db";

export const FEEDBACK_TEXT_MAX = 4000;
/** Length of the screenshot's data URL; about 1.1 MB of picture. */
export const SCREENSHOT_MAX = 1_500_000;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export interface FeedbackInput {
  text?: unknown;
  page?: unknown;
  screenshot?: unknown;
}
export interface FeedbackReport {
  text: string;
  page: string;
  screenshot: string | null;
}

export function checkFeedback(body: FeedbackInput): { ok: true; report: FeedbackReport } | { ok: false; error: string; code: string } {
  const text = String(body?.text ?? "").trim();
  if (!text) return { ok: false, error: "Say what you tried and what happened.", code: "empty" };
  if (text.length > FEEDBACK_TEXT_MAX) {
    return { ok: false, error: `Keep it under ${FEEDBACK_TEXT_MAX.toLocaleString("en")} characters.`, code: "too_long" };
  }
  const page = String(body?.page ?? "").slice(0, 300);
  let screenshot: string | null = null;
  if (body?.screenshot != null && body.screenshot !== "") {
    const s = String(body.screenshot);
    if (s.length > SCREENSHOT_MAX) return { ok: false, error: "That picture is too big. Pick one under 1 MB.", code: "too_big" };
    if (!DATA_URL.test(s)) return { ok: false, error: "A screenshot must be a PNG, JPEG or WebP picture.", code: "bad_picture" };
    screenshot = s;
  }
  return { ok: true, report: { text, page, screenshot } };
}

export async function saveFeedback(sql: Sql, userId: string, r: FeedbackReport, userAgent: string): Promise<number> {
  const rows = await sql<{ id: number | string }>`
    INSERT INTO buzzy_feedback (user_id, text, page, screenshot, user_agent)
    VALUES (${userId}, ${r.text}, ${r.page}, ${r.screenshot}, ${String(userAgent || "").slice(0, 300)})
    RETURNING id
  `;
  return Number(rows[0]!.id);
}

export async function listFeedback(sql: Sql, limit = 200) {
  return sql<{ id: number | string; created_at: string; page: string; text: string; has_screenshot: boolean; email: string | null; name: string | null }>`
    SELECT f.id, f.created_at, f.page, f.text, (f.screenshot IS NOT NULL) AS has_screenshot, u.email, u.name
    FROM buzzy_feedback f
    LEFT JOIN "user" u ON u.id = f.user_id
    ORDER BY f.created_at DESC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
}

export async function feedbackScreenshot(sql: Sql, id: number): Promise<string | null> {
  const rows = await sql<{ screenshot: string | null }>`SELECT screenshot FROM buzzy_feedback WHERE id = ${id} LIMIT 1`;
  return rows[0]?.screenshot ?? null;
}

/** The account a tester signed up with, by email. */
export async function userIdForEmail(sql: Sql, email: string): Promise<string | null> {
  const rows = await sql<{ id: string }>`SELECT id FROM "user" WHERE lower(email) = lower(${email.trim()}) LIMIT 1`;
  return rows[0]?.id ?? null;
}

export function adminEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    String(env.BZ_ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return !!email && adminEmails(env).has(String(email).trim().toLowerCase());
}
