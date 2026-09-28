/**
 * Nitro handlers for /api/buzzy/**
 *
 * Session-gated via Better Auth (same pattern as /api/agent/*).
 * Thin h3 wrapper delegates to chatLoop() in server.ts.
 *
 * Routes:
 *   POST /api/buzzy/chat   — send a message, get a reply
 *   GET  /api/buzzy/models — list available models (labels + ids)
 */

import { defineEventHandler, getMethod, setResponseStatus } from "h3";
import { chatLoop } from "./server";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getModels } from "./llm";

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  const path = event.path ?? "";

  // ── GET /api/buzzy/models — open catalog ─────────────────────────────
  if (method === "GET" && path === "/api/buzzy/models") {
    const models = getModels();
    return { models };
  }

  // ── POST /api/buzzy/chat — session-gated ─────────────────────────────
  if (method === "POST" && path === "/api/buzzy/chat") {
    const rawHeaders = event.node?.req?.headers ?? event.req?.headers;
    const headersInit = rawHeaders instanceof Headers
      ? rawHeaders
      : Object.entries(rawHeaders as Record<string, string>).reduce<Record<string, string>>((h, [k, v]) => {
          if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : v;
          return h;
        }, {});
    const user = await getSessionUserFromHeaders(new Headers(headersInit));
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

  throw new Error("Not found");
});
