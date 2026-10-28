/**
 * The chat turn — BeeZilla's orchestrator, free of HTTP.
 *
 * Lifted verbatim out of the Nitro handler (`chat.nitro.ts`). The handler now
 * does exactly two things: authenticate, and hand a parsed body to this
 * function. Nothing here knows about `H3Event`, cookies, or transports, which is
 * what lets the SAME logic run three ways:
 *
 *   - the hosted product, over HTTP
 *   - the desktop window, over loopback
 *   - the CLI, headless (`beezilla run …`)
 *
 * Three response kinds exist because the route has three: a JSON body with a
 * status, and a Server-Sent-Events stream for the voice lane. The caller maps
 * them onto its own transport; this module never sets a status code itself.
 */
import { getSql } from "../db";
import type { Sql } from "../db";
import { chatLoop } from "./server";
import { recordTelemetry } from "./telemetry";
import { recordVoiceMetrics } from "./voiceMetrics";
import { memoryContextBlock, type CustomerMemoryEntry } from "./customer";
import { STATEMENT_IDS, DEEPENING_IDS } from "./questions";
import { isCompanyId, confirmedCompanyContext } from "./companyContext";
import type { VoiceHandlers } from "./voice";

export type ChatTurnInput = {
  userId: string;
  body: Record<string, unknown>;
};

export type ChatTurnOutcome =
  | { kind: "json"; status: number; payload: unknown }
  | { kind: "stream"; response: Response };

const json = (payload: unknown, status = 200): ChatTurnOutcome => ({
  kind: "json",
  status,
  payload,
});

export async function runChatTurn({ userId, body }: ChatTurnInput): Promise<ChatTurnOutcome> {
  const jobId: string | null = typeof body.jobId === "string" ? body.jobId : null;
  const sessionId: string | null = typeof body.sessionId === "string" ? body.sessionId : null;
  const message: string = typeof body.message === "string" ? body.message : "";
  const model: string | undefined = typeof body.model === "string" ? body.model : undefined;
  const attemptId: string | null = typeof body.attemptId === "string" && body.attemptId.trim()
    ? body.attemptId.trim().slice(0, 80)
    : null;
  const jobContext = typeof body.jobContext === "object" && body.jobContext !== null
    ? (body.jobContext as Record<string, unknown>)
    : undefined;
  // UI mode: "work" steers toward a work effort, "chat" is ordinary
  // conversation. Unknown values fall back to chat inside chatLoop.
  const mode: "chat" | "work" = body.mode === "work" ? "work" : "chat";
  // Voice lane: stream text + audio back over SSE so speech starts on the
  // first audio chunk instead of after the whole buffered reply.
  const voice = body.voice === true;
  const voiceName = typeof body.voiceName === "string" ? body.voiceName.trim().slice(0, 24) : undefined;
  const surface: "text" | "voice" = voice ? "voice" : "text";

  const sql = await getSql();

  // ── BZ-F024: pause/cancel stops future work (QA-15) ───────────────
  // A cancelled or paused job takes no new turns — no further model calls
  // happen against it until the owner deliberately resumes. Plain-language
  // consequences, never a silent no-op.
  if (jobId) {
    const st = await sql<{ status: string | null }>`
      SELECT status FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${userId} LIMIT 1
    `;
    const status = st[0]?.status ?? null;
    if (status === "Cancelled") {
      return json(
        {
          ok: false,
          error: "This job is cancelled — nothing more will run on it. Start a new job if you want to pick the idea up again.",
          code: "job_cancelled",
        },
        409,
      );
    }
    if (status === "Paused") {
      return json(
        {
          ok: false,
          error: "This job is paused — no work (and no spend) is happening. Resume it when you're ready and we'll pick up where we stopped.",
          code: "job_paused",
        },
        409,
      );
    }
  }

  // ── BZ-F024: attempt reconciliation (QA-09/10) ─────────────────────
  // A retried send with the same attemptId returns the STORED reply —
  // the model is not called twice, so no duplicate charge or artifact.
  if (attemptId) {
    const prior = await sql<{ content: string }>`
      SELECT content FROM buzzy_chat_messages
      WHERE user_id = ${userId}
        AND COALESCE(job_id, '') = COALESCE(${jobId}, '')
        AND COALESCE(session_id, '') = COALESCE(${sessionId}, '')
        AND attempt_id = ${attemptId}
        AND role = 'assistant'
      ORDER BY created_at ASC LIMIT 1
    `;
    if (prior.length) {
      // Return the current brief so a retry after a reload still fills the box.
      const slotRows = await sql<{ key: string; value: string }>`
        SELECT key, value FROM buzzy_user_memory
        WHERE user_id = ${userId} AND job_id IS NOT DISTINCT FROM ${jobId || sessionId}
      `;
      const known = new Set([...STATEMENT_IDS, ...DEEPENING_IDS]);
      const slots: Record<string, string> = {};
      for (const r of slotRows) {
        if (known.has(r.key) && r.value?.trim()) slots[r.key] = r.value;
      }
      return json({ ok: true, reply: prior[0].content, reconciled: true, slots });
    }
  }

  let companyId: string | null = null;
  if (typeof body.companyId === "string" && isCompanyId(body.companyId)) {
    companyId = body.companyId;
  } else if (sessionId) {
    const sess = await sql<{ company_id: string | null }>`
      SELECT company_id FROM buzzy_sessions
      WHERE id = ${sessionId} AND user_id = ${userId}
      LIMIT 1
    `;
    const fromSession = sess[0]?.company_id;
    if (typeof fromSession === "string" && isCompanyId(fromSession)) companyId = fromSession;
  }
  const company = companyId ? await confirmedCompanyContext(sql, userId, companyId) : null;
  // Customer memory (component #2): inject approved-work history so later
  // jobs don't re-ask what earlier approvals already established.
  let customerMemoryBlock = "";
  if (companyId) {
    try {
      const memRows = await sql`
        SELECT customer_memory FROM buzzy_companies
        WHERE id = ${companyId} AND user_id = ${userId} AND customer_memory != '[]'::jsonb
        LIMIT 1
      `;
      const mem = memRows[0]?.customer_memory as CustomerMemoryEntry[] | undefined;
      if (Array.isArray(mem) && mem.length > 0) customerMemoryBlock = memoryContextBlock(mem);
    } catch { /* memory is additive — never block the chat */ }
  }

  const turnStarted = Date.now();
  await recordTelemetry(sql, { userId, jobId, event: "run_started", props: { surface } });

  const runTurn = (speech?: VoiceHandlers) =>
    chatLoop({
      userId,
      jobId,
      sessionId,
      message,
      model,
      attemptId,
      jobContext,
      mode,
      companyName: company?.name ?? null,
      companyFacts: company?.facts ?? [],
      customerMemoryBlock,
      surface,
      speech,
      voiceName,
    });

  // ── Voice lane: text + audio streamed as Server-Sent Events ────────
  // Events: text {t} · audio {b64,format} · done {ChatResponse} · error {error}
  // The final `done` payload is the SAME ChatResponse the text lane returns,
  // so the client runs one post-processing path for both.
  if (voice) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        try {
          const result = await runTurn({
            onText: (t) => send("text", { t }),
            onAudio: (b64, format) => send("audio", { b64, format }),
          });
          send("done", result);
          if (result.timings) {
            await recordVoiceMetrics(sql as Sql, {
              userId,
              jobId,
              sessionId,
              source: "server",
              mode,
              model: result.timings.model,
              ttftMs: result.timings.ttftMs,
              ttfaMs: result.timings.ttfaMs,
              turnMs: result.timings.totalMs,
              extractMs: result.timings.extractMs,
              llmMs: result.timings.llmMs,
              honchoMs: result.timings.honchoMs,
              replyChars: result.reply?.length ?? 0,
              spoken: true,
            });
          }
        } catch (err) {
          console.error("[buzzy/voice] turn failed:", err instanceof Error ? err.message : err);
          send("error", { error: "The voice turn failed. Try again — the text chat still works." });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      },
    });
    return {
      kind: "stream",
      response: new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      }),
    };
  }

  const result = await runTurn();
  // BZ-F039: a draft was shown to the human (no content recorded — ids and
  // timing only). Check verdicts travel as their own events.
  const replyText = typeof (result as { reply?: unknown }).reply === "string"
    ? String((result as { reply: string }).reply)
    : "";
  await recordTelemetry(sql, {
    userId,
    jobId,
    event: "draft_shown",
    props: { surface: "chat", ms: Date.now() - turnStarted, count: replyText.length > 0 ? 1 : 0 },
  });
  return json(result);
}
