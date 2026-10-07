/**
 * Nitro handlers for /api/buzzy/**
 *
 * Session-gated via Better Auth (same pattern as /api/agent/*).
 * Thin h3 wrapper delegates to chatLoop() in server.ts.
 *
 * Routes:
 *   POST /api/buzzy/chat   — send a message, get a reply
 *   GET  /api/buzzy/models — list available models (labels + ids)
 *   GET  /api/buzzy/memory — aggregate memory for the Memory page
 */

import { defineEventHandler, getMethod, setResponseStatus } from "h3";
import { chatLoop } from "./server";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getModels } from "./llm";
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
  if (method === "GET" && path === "/api/buzzy/transcript") {
    const url = new URL(event.path ?? "/api/buzzy/transcript", "http://x");
    const jobIdParam = url.searchParams.get("jobId");
    const jobId = jobIdParam && jobIdParam !== "null" ? jobIdParam : null;
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }

    const sql = await getSql();
    const rows = await sql`
      SELECT job_id, role, content, created_at FROM buzzy_chat_messages
      WHERE user_id = ${user.id} AND job_id IS NOT DISTINCT FROM ${jobId}
      ORDER BY created_at ASC LIMIT 50
    `;
    return {
      messages: rows.map((r) => ({
        jobId: r.job_id,
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
    const message: string = typeof body.message === "string" ? body.message : "";
    const model: string | undefined = typeof body.model === "string" ? body.model : undefined;

    const result = await chatLoop({ userId, jobId, message, model });
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

  throw new Error("Not found");
});
