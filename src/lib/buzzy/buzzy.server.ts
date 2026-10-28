/**
 * Buzzy chat API — dev-compatible handler.
 *
 * Takes a plain Node `Request` object (like `agent-api.server.ts`) and
 * delegates to `chatLoop()` in server.ts.
 *
 * Used by the Vite dev middleware. Production uses the Nitro route handler.
 *
 * Routes:
 *   POST /api/buzzy/chat   — send a message, get a reply
 *   GET  /api/buzzy/models — list available models
 */

import { chatLoop } from "./server";
import { getModels } from "./llm";

export async function handleBuzzyRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ── GET /api/buzzy/models — open catalog ─────────────────────────────
  if (method === "GET" && path === "/api/buzzy/models") {
    const models = getModels();
    return new Response(JSON.stringify({ models }), {
      headers: { "content-type": "application/json" },
    });
  }

  // ── POST /api/buzzy/chat — session-gated ─────────────────────────────
  if (method === "POST" && path === "/api/buzzy/chat") {
    // In dev, skip auth gate (session info not available in middleware context).
    // Production Nitro route handles auth via requireUserId().
    const userId = "dev-user";

    let body: Record<string, unknown> = {};
    try {
      const parsed = await request.json();
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

    const result = await chatLoop({ userId, jobId, sessionId, message, model });
    const status = result.ok ? 200 : 400;
    return new Response(JSON.stringify(result), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Not found", { status: 404 });
}
