/**
 * Conversation recency + one-line summaries.
 *
 * The Recent work list was showing conversations in insertion order, not by
 * when they last moved, and every row said "Pick up this conversation" because
 * the `summary` column was never filled automatically (the POST endpoint
 * existed, nothing called it).
 *
 * Two jobs here:
 *   touchSession()            — stamp updated_at on every turn, so "most recent
 *                               conversation" is a fact and not a guess.
 *   maybeSummarizeSession()   — keep a one-line summary fresh. Cheap model, run
 *                               off the critical path, refresh every N messages,
 *                               and fall back to the owner's own opening line so
 *                               a row is never blank.
 */

import { chatCompletion } from "./llm";

const SUMMARY_MODEL = process.env.BZ_SUMMARY_MODEL?.trim() || "google/gemini-3.1-flash-lite";
const MAX_WORDS = 30;
/** Regenerate only after this many new messages — summaries are a list label,
 *  not a per-turn artifact, and each refresh is a model call. */
const REFRESH_EVERY = 6;
/** How much transcript the summariser sees (tail-weighted). */
const TRANSCRIPT_CHARS = 8000;

/** Mark the conversation as active. Cheap single-row write. */
export async function touchSession(sql: any, sessionId: string, userId: string): Promise<void> {
  try {
    await sql`
      UPDATE buzzy_sessions SET updated_at = now()
      WHERE id = ${sessionId} AND user_id = ${userId}
    `;
  } catch (err) {
    console.warn("[buzzy/sessions] touch failed:", err instanceof Error ? err.message : err);
  }
}

function clipWords(text: string, words = MAX_WORDS): string {
  const parts = String(text || "").replace(/\s+/g, " ").trim().split(" ");
  return parts.slice(0, words).join(" ").trim();
}

/**
 * Generate and store a fresh one-line summary. Returns the stored text, or null
 * when the session has nothing to summarise.
 */
export async function summarizeSessionNow(
  sql: any,
  sessionId: string,
  userId: string,
): Promise<string | null> {
  const msgs = (await sql`
    SELECT role, content FROM buzzy_chat_messages
    WHERE session_id = ${sessionId} AND user_id = ${userId}
    ORDER BY created_at DESC LIMIT 40
  `) as Array<{ role: string; content: string }>;
  if (!msgs.length) return null;
  const chronological = [...msgs].reverse();

  // The owner's own opening line is the honest fallback if the model fails.
  const firstUser = chronological.find((m) => m.role === "user")?.content ?? "";
  const fallback = clipWords(firstUser, MAX_WORDS);

  const transcript = chronological
    .map((m) => `${m.role === "user" ? "Person" : "BeeZilla"}: ${String(m.content).slice(0, 900)}`)
    .join("\n")
    .slice(-TRANSCRIPT_CHARS);

  let summary = "";
  try {
    const raw = await chatCompletion(
      [
        {
          role: "system",
          content:
            `Write ONE line describing this conversation: what it is about and what was decided or produced. ` +
            `${MAX_WORDS} words maximum, plain language, no preamble ("The conversation is about…" is banned), ` +
            `no quotes, no exclamation marks. Write it as a label a person would scan in a list.`,
        },
        { role: "user", content: transcript },
      ],
      { model: SUMMARY_MODEL, temperature: 0.2, maxTokens: 160 },
    );
    summary = clipWords(raw);
  } catch {
    summary = "";
  }

  const value = summary || fallback;
  if (!value) return null;

  try {
    const count = (await sql`
      SELECT count(*)::int AS n FROM buzzy_chat_messages
      WHERE session_id = ${sessionId} AND user_id = ${userId}
    `) as Array<{ n: number }>;
    await sql`
      UPDATE buzzy_sessions
      SET summary = ${value}, summary_at = now(), summary_messages = ${Number(count[0]?.n ?? 0)}, updated_at = now()
      WHERE id = ${sessionId} AND user_id = ${userId}
    `;
  } catch (err) {
    console.warn("[buzzy/sessions] summary write failed:", err instanceof Error ? err.message : err);
  }
  return value;
}

/**
 * Refresh the summary only when it is missing or stale. Never throws: a summary
 * is a label, and a failed label must not break the turn that produced it.
 */
export async function maybeSummarizeSession(
  sql: any,
  sessionId: string,
  userId: string,
): Promise<void> {
  try {
    const rows = (await sql`
      SELECT s.summary, s.summary_messages,
             (SELECT count(*)::int FROM buzzy_chat_messages m
              WHERE m.session_id = s.id AND m.user_id = s.user_id) AS msg_count
      FROM buzzy_sessions s
      WHERE s.id = ${sessionId} AND s.user_id = ${userId}
      LIMIT 1
    `) as Array<{ summary: string | null; summary_messages: number | null; msg_count: number }>;
    const row = rows[0];
    if (!row) return;
    const count = Number(row.msg_count ?? 0);
    if (count < 2) return;
    const haveSummary = typeof row.summary === "string" && row.summary.trim().length > 0;
    const since = count - Number(row.summary_messages ?? 0);
    if (haveSummary && since < REFRESH_EVERY) return;
    await summarizeSessionNow(sql, sessionId, userId);
  } catch (err) {
    console.warn("[buzzy/sessions] summarize skipped:", err instanceof Error ? err.message : err);
  }
}
