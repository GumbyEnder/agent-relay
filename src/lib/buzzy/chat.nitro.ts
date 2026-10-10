/**
 * Nitro handlers for /api/buzzy/**
 *
 * Session-gated via Better Auth (same pattern as /api/agent/*).
 * Thin h3 wrapper delegates to chatLoop() in server.ts.
 *
 * Routes:
 *   POST /api/buzzy/chat            — send a message, get a reply
 *   GET  /api/buzzy/models          — list available models (labels + ids)
 *   GET  /api/buzzy/memory          — aggregate memory for the Memory page
 *   GET  /api/buzzy/transcript      — restore chat (jobId or sessionId)
 *   GET  /api/buzzy/sessions        — list user's sessions
 *   POST /api/buzzy/sessions        — create a session
 *   PATCH /api/buzzy/sessions/:id   — rename session title
 *   POST /api/buzzy/sessions/:id/summary — generate AI summary
 */

import { defineEventHandler, getMethod, setResponseStatus } from "h3";
import { chatLoop } from "./server";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getModels, chatCompletion } from "./llm";
import { getSql } from "@/lib/db";
import { honchoAvailable } from "./honcho";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function headersFromEvent(event: any): Headers {
  const rawHeaders = event.node?.req?.headers ?? event.req?.headers;
  if (rawHeaders instanceof Headers) return rawHeaders;
  const init: [string, string][] = Object.entries(
    (rawHeaders ?? {}) as Record<string, string | string[] | undefined>,
  ).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]);
  return new Headers(init);
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  const path = event.path ?? "";

  // ── GET /api/buzzy/models — open catalog ─────────────────────────────
  if (method === "GET" && path === "/api/buzzy/models") {
    const models = getModels();
    return { models };
  }

  // ── GET /api/buzzy/transcript — restore chat on reload (dogfood 10007) ──
  // Accepts jobId (legacy) or sessionId (new) as an alternative.
  if (method === "GET" && path === "/api/buzzy/transcript") {
    const url = new URL(event.path ?? "/api/buzzy/transcript", "http://x");
    const jobIdParam = url.searchParams.get("jobId");
    const jobId = jobIdParam && jobIdParam !== "null" ? jobIdParam : null;
    const sessionIdParam = url.searchParams.get("sessionId");
    const sessionId = sessionIdParam && sessionIdParam !== "null" ? sessionIdParam : null;
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }

    const sql = await getSql();
    const rows = sessionId
      ? await sql`
          SELECT role, content, created_at FROM buzzy_chat_messages
          WHERE user_id = ${user.id} AND session_id = ${sessionId}
          ORDER BY created_at ASC LIMIT 50
        `
      : await sql`
          SELECT job_id, role, content, created_at FROM buzzy_chat_messages
          WHERE user_id = ${user.id} AND job_id IS NOT DISTINCT FROM ${jobId}
          ORDER BY created_at ASC LIMIT 50
        `;
    return {
      messages: rows.map((r) => ({
        jobId: ("job_id" in r && r.job_id) ?? null,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      })),
    };
  }

  // ── POST /api/buzzy/chat — session-gated ─────────────────────────────
  if (method === "POST" && path === "/api/buzzy/chat") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const userId = user.id;

    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      /* empty body → bad_request from chatLoop */
    }

    const jobId: string | null = typeof body.jobId === "string" ? body.jobId : null;
    const sessionId: string | null = typeof body.sessionId === "string" ? body.sessionId : null;
    const message: string = typeof body.message === "string" ? body.message : "";
    const model: string | undefined = typeof body.model === "string" ? body.model : undefined;
    const jobContext = typeof body.jobContext === "object" && body.jobContext !== null ? body.jobContext as Record<string, unknown> : undefined;

    const result = await chatLoop({ userId, jobId, sessionId, message, model, jobContext });
    return result;
  }

  // ── GET /api/buzzy/memory — aggregate memory for the Memory page ─────
  if (method === "GET" && path === "/api/buzzy/memory") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }

    const sql = await getSql();
    const facts = await sql`
      SELECT job_id, key, value, updated_at FROM buzzy_user_memory
      WHERE user_id = ${user.id}
      ORDER BY updated_at DESC
      LIMIT 200
    `;
    const messages = await sql`
      SELECT job_id, role, content, created_at FROM buzzy_chat_messages
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return {
      honchoAvailable: honchoAvailable(),
      facts: facts.map((r) => ({
        jobId: r.job_id,
        key: r.key,
        value: r.value,
        updatedAt: r.updated_at,
      })),
      messages: messages.map((r) => ({
        jobId: r.job_id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      })),
    };
  }


  // ── GET /api/buzzy/sessions — list the user's Talk sessions ──────────
  if (method === "GET" && path === "/api/buzzy/sessions") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT s.id, s.job_id, s.title, s.summary, s.created_at, s.updated_at,
        (SELECT count(*) FROM buzzy_chat_messages m WHERE m.session_id = s.id) AS message_count
      FROM buzzy_sessions s
      WHERE s.user_id = ${user.id}
      ORDER BY s.updated_at DESC
      LIMIT 100
    `;
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        jobId: r.job_id,
        title: r.title,
        summary: r.summary,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: Number(r.message_count),
      })),
    };
  }

  // ── POST /api/buzzy/sessions — create a session ──────────────────────
  if (method === "POST" && path === "/api/buzzy/sessions") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch { /* empty body ok */ }
    const jobId = typeof body.jobId === "string" && body.jobId ? body.jobId : null;
    const id = `sess_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const sql = await getSql();
    const rows = await sql`
      INSERT INTO buzzy_sessions (id, user_id, job_id)
      VALUES (${id}, ${user.id}, ${jobId})
      RETURNING id, job_id, title, summary, created_at, updated_at
    `;
    const s = rows[0];
    setResponseStatus(event, 201);
    return {
      session: {
        id: s.id, jobId: s.job_id, title: s.title, summary: s.summary,
        createdAt: s.created_at, updatedAt: s.updated_at, messageCount: 0,
      },
    };
  }

  // ── PATCH /api/buzzy/sessions/:id — rename (ownership enforced) ──────
  const renameMatch = path.match(/^\/api\/buzzy\/sessions\/([A-Za-z0-9_-]+)$/);
  if (method === "PATCH" && renameMatch) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch { /* handled below */ }
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!title) {
      setResponseStatus(event, 400);
      return { error: "title is required", code: "bad_request" };
    }
    const sql = await getSql();
    const rows = await sql`
      UPDATE buzzy_sessions SET title = ${title}, updated_at = now()
      WHERE id = ${renameMatch[1]} AND user_id = ${user.id}
      RETURNING id, job_id, title, summary, created_at, updated_at
    `;
    if (!rows.length) {
      setResponseStatus(event, 404);
      return { error: "session not found", code: "not_found" };
    }
    const s = rows[0];
    return {
      session: {
        id: s.id, jobId: s.job_id, title: s.title, summary: s.summary,
        createdAt: s.created_at, updatedAt: s.updated_at,
      },
    };
  }

  // ── POST /api/buzzy/sessions/:id/summary — AI summary (<=200 words) ──
  const summaryMatch = path.match(/^\/api\/buzzy\/sessions\/([A-Za-z0-9_-]+)\/summary$/);
  if (method === "POST" && summaryMatch) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const owned = await sql`
      SELECT id FROM buzzy_sessions WHERE id = ${summaryMatch[1]} AND user_id = ${user.id}
    `;
    if (!owned.length) {
      setResponseStatus(event, 404);
      return { error: "session not found", code: "not_found" };
    }
    const msgs = await sql`
      SELECT role, content FROM buzzy_chat_messages
      WHERE session_id = ${summaryMatch[1]}
      ORDER BY created_at ASC LIMIT 50
    `;
    if (!msgs.length) {
      return { summary: null, note: "No messages to summarize yet." };
    }
    const transcript = msgs
      .map((m) => `${m.role === "user" ? "Client" : "BeeZilla"}: ${m.content}`)
      .join("\n")
      .slice(0, 12000);
    const raw = await chatCompletion(
      [
        {
          role: "system",
          content:
            "Summarize this conversation in 200 words or less, plain language, for the person who had it. What was discussed and what was decided. No jargon.",
        },
        { role: "user", content: transcript },
      ],
      { temperature: 0.3, maxTokens: 400 },
    );
    // Hard cap at 200 words regardless of LLM output.
    const words = raw.trim().split(/\s+/).slice(0, 200).join(" ");
    const updated = await sql`
      UPDATE buzzy_sessions SET summary = ${words}, updated_at = now()
      WHERE id = ${summaryMatch[1]} AND user_id = ${user.id}
      RETURNING summary
    `;
    return { summary: updated[0]?.summary ?? words };
  }

  throw new Error("Not found");
});
