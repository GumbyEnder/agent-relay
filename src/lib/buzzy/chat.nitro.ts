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
 *   GET  /api/buzzy/profile         — account-scoped business profile + defaults
 *   PUT  /api/buzzy/profile         — save profile fields (closed key set)
 *   POST /api/buzzy/profile/reuse   — copy chosen defaults into a job
 *   GET  /api/buzzy/companies       — companies on this account
 *   POST /api/buzzy/companies       — add a company (name only)
 *   POST /api/buzzy/companies/from-website — read a public site into a proposed card
 *   POST /api/buzzy/companies/:id/lines — confirm, edit, or drop one card line
 *   GET  /api/buzzy/sessions        — list user's sessions (?companyId= scopes)
 *   POST /api/buzzy/sessions        — create a session
 *   PATCH /api/buzzy/sessions/:id   — rename session title
 *   POST /api/buzzy/sessions/:id/summary — generate AI summary
 *   POST /api/buzzy/papers          — read a dropped or pasted paper into proposed lines
 *   GET  /api/buzzy/papers          — latest paper on the active company (?companyId, ?jobId)
 *   POST /api/buzzy/papers/:id/lines — confirm, correct, or drop one line
 *   POST /api/buzzy/money-check — compare a draft to the paper and the brief
 *   POST /api/buzzy/promise-check — mark a committing sentence; do not approve or send
 */

import { defineEventHandler, getMethod, setResponseStatus } from "h3";
import { chatLoop } from "./server";
import type { VoiceHandlers } from "./voice";
import { summarizeSessionNow } from "./sessions";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getModels, chatCompletion } from "./llm";
import { getSql, type Sql } from "@/lib/db";
import { honchoAvailable } from "./honcho";
import { getProfile, saveProfile, reuseDefaults, PROFILE_FIELDS } from "./profile";
import { contextWindowFor, contextState } from "./context";
import { fallbackCompanyName, readPublicWebsite, WEBSITE_SOURCE } from "./website";
import { checkMoney, type MoneyBriefLine, type MoneyFact } from "./money";
import { checkPromise } from "./promise";
import { cleanFilename, latestPaper, savePaper, updatePaperLine } from "./paper";
import { buildWeeklyDigest } from "./digest";
import { rebuildCustomerMemory, memoryContextBlock, extractTemplateStructure, type CustomerMemoryEntry } from "./customer";
import { buildExportBundle, deleteAccountData } from "./portability";
import { recordJobEvent } from "./jobEvents";
import { dueScheduledJobs, markScheduledRun, saveScheduledDraft } from "./scheduled";
import { setDocumentAcceptance, materializeDraft, summarizeChanges } from "./documents";
import { ensureExecutionBoard } from "./execution";
import { renderTextPdf } from "./pdf";
import { renderDocument } from "./artifact";
import { TOOL_REGISTRY } from "./tools";
import { reviewSeparately, type ReviewCheck } from "./review";
import { STARTERS, getStarter } from "./starters";
import { recordTelemetry, successSummary, TELEMETRY_DISCLOSURE } from "./telemetry";
import { RECIPES, UNIVERSAL_STATEMENTS, getRecipe, validateRecipe, boundaryViolations } from "./recipes";
import { resolveActingAccount, guard, canPerform, denialReason, TEAM_ACTIONS, DELEGATABLE, authorize, type MemberRole } from "./team";
import { STATEMENT_IDS, DEEPENING_IDS } from "./questions";

/**
 * One latency sample. Two sources: `server` (our own stage timings) and
 * `client` (what the owner actually experienced — mic stop → first sound →
 * turn end). Kept apart on purpose: a slow model and a slow client are
 * different bugs. Identity and timings only, never text or audio.
 */
async function recordVoiceMetrics(
  sql: Sql,
  row: {
    userId: string;
    jobId?: string | null;
    sessionId?: string | null;
    source: "client" | "server";
    mode?: string | null;
    model?: string | null;
    asrMs?: number | null;
    ttftMs?: number | null;
    ttfaMs?: number | null;
    turnMs?: number | null;
    extractMs?: number | null;
    llmMs?: number | null;
    honchoMs?: number | null;
    replyChars?: number | null;
    audioBytes?: number | null;
    spoken?: boolean;
    lane?: string | null;
    speechMs?: number | null;
  },
): Promise<void> {
  try {
    await sql`
      INSERT INTO buzzy_voice_metrics
        (user_id, job_id, session_id, source, mode, model, asr_ms, ttft_ms, ttfa_ms,
         turn_ms, extract_ms, llm_ms, honcho_ms, reply_chars, audio_bytes, spoken, lane, speech_ms)
      VALUES
        (${row.userId}, ${row.jobId ?? null}, ${row.sessionId ?? null}, ${row.source},
         ${row.mode ?? null}, ${row.model ?? null}, ${row.asrMs ?? null}, ${row.ttftMs ?? null},
         ${row.ttfaMs ?? null}, ${row.turnMs ?? null}, ${row.extractMs ?? null},
         ${row.llmMs ?? null}, ${row.honchoMs ?? null}, ${row.replyChars ?? null},
         ${row.audioBytes ?? null}, ${row.spoken ?? false}, ${row.lane ?? null}, ${row.speechMs ?? null})
    `;
  } catch (err) {
    // A lost metric must never break a turn.
    console.warn("[buzzy/voice-metrics] insert failed:", err instanceof Error ? err.message : err);
  }
}

/** Parse JSON safely; return a fallback object on malformed input. */
function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function queryValue(fullPath: string, key: string): string | null {
  const qs = fullPath.includes("?") ? fullPath.slice(fullPath.indexOf("?") + 1) : "";
  if (!qs) return null;
  const v = new URLSearchParams(qs).get(key);
  if (!v || v === "null") return null;
  return v;
}

function isCompanyId(id: string): boolean {
  return /^co_[a-z0-9]{8,32}$/.test(id);
}

function asMoneyBrief(raw: unknown): MoneyBriefLine[] {
  if (!Array.isArray(raw)) return [];
  const out: MoneyBriefLine[] = [];
  for (const row of raw.slice(0, 12)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const status = rec.status === "confirmed" || rec.status === "skipped" || rec.status === "open" || rec.status === "proposed"
      ? rec.status
      : "open";
    out.push({
      label: typeof rec.label === "string" ? rec.label.slice(0, 80) : "",
      value: typeof rec.value === "string" ? rec.value.slice(0, 500) : "",
      status,
    });
  }
  return out;
}

function companyName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ").slice(0, 80);
  return name || null;
}

type CompanyRow = {
  id: string;
  name: string;
  one_liner: string;
  website: string;
  created_at: string;
  updated_at: string;
};

type FactRow = {
  id: string;
  company_id: string;
  fact_key: string;
  label: string;
  value: string;
  status: string;
  source_label: string;
  source_page: string;
  original_value: string;
};

const FACT_ORDER = ["name", "does", "serves", "locations", "voice"];

function linePayload(row: FactRow) {
  return {
    id: row.id,
    key: row.fact_key,
    label: row.label,
    value: row.value,
    status: row.status,
    source: row.source_label,
    page: row.source_page,
    edited: row.original_value !== "" && row.value !== row.original_value,
  };
}

function companyPayload(row: CompanyRow, facts: FactRow[] = []) {
  const lines = facts
    .filter((f) => f.company_id === row.id && f.status !== "dropped")
    .sort((a, b) => FACT_ORDER.indexOf(a.fact_key) - FACT_ORDER.indexOf(b.fact_key))
    .map(linePayload);
  return {
    id: row.id,
    name: row.name,
    oneLiner: row.one_liner || "",
    website: row.website || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
    facts: lines.filter((l) => l.status === "confirmed"),
  };
}

function factValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
  return v || null;
}

async function confirmedCompanyContext(
  sql: Sql,
  userId: string,
  companyId: string,
): Promise<{ name: string; facts: Array<{ label: string; value: string }> } | null> {
  if (!isCompanyId(companyId)) return null;
  const rows = await sql<CompanyRow>`
    SELECT id, name, one_liner, website, created_at, updated_at
    FROM buzzy_companies
    WHERE id = ${companyId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const facts = await sql<FactRow>`
    SELECT id, company_id, fact_key, label, value, status, source_label, source_page, original_value
    FROM buzzy_company_facts
    WHERE user_id = ${userId} AND company_id = ${companyId} AND status = 'confirmed'
    ORDER BY created_at ASC
    LIMIT 20
  `;
  return {
    name: rows[0].name,
    facts: facts
      .filter((f) => typeof f.value === "string" && f.value.trim())
      .map((f) => ({ label: f.label || f.fact_key, value: f.value })),
  };
}

async function companyFacts(sql: Sql, userId: string, companyId?: string): Promise<FactRow[]> {
  return companyId
    ? await sql<FactRow>`
        SELECT id, company_id, fact_key, label, value, status, source_label, source_page, original_value
        FROM buzzy_company_facts
        WHERE user_id = ${userId} AND company_id = ${companyId} AND status <> 'dropped'
        ORDER BY created_at ASC
        LIMIT 20
      `
    : await sql<FactRow>`
        SELECT id, company_id, fact_key, label, value, status, source_label, source_page, original_value
        FROM buzzy_company_facts
        WHERE user_id = ${userId} AND status <> 'dropped'
        ORDER BY created_at ASC
        LIMIT 250
      `;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function headersFromEvent(event: any): Headers {
  const rawHeaders = event.node?.req?.headers ?? event.req?.headers;
  if (rawHeaders instanceof Headers) return rawHeaders;
  const init: [string, string][] = Object.entries(
    (rawHeaders ?? {}) as Record<string, string | string[] | undefined>,
  ).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]);
  return new Headers(init);
}

/**
 * Operator read-back. The owner asking "review my last turn" cannot be answered
 * from a signed-in endpoint, and timing rows carry no message text — so a
 * timing-only read is allowed with the ops key. Never widen this to content.
 */
function opsAuthorized(event: any): boolean {
  const want = (process.env.BZ_OPS_KEY || "").trim();
  if (!want) return false;
  const got = (headersFromEvent(event).get("x-bz-ops-key") || "").trim();
  return got.length > 0 && got === want;
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  // In this (tanstack/nitro) runtime `event.path` carries the query string, so
  // route matching silently failed for any `/api/buzzy/…?x=y` URL ("Not found").
  // Split it: `path` is the pathname, the query is parsed where needed.
  const fullPath = event.path ?? "";
  const path = fullPath.split("?")[0];

  // ── GET /api/buzzy/shared/:token — PUBLIC controlled-share read (BZ-F021) ─
  // The ONLY unauthenticated buzzy route. Serves exactly one pinned version
  // of one document while the link is unexpired and unrevoked. Completion
  // never makes anything public — a human created this link explicitly.
  const sharedMatch = path.match(/^\/api\/buzzy\/shared\/(sh_[A-Za-z0-9]{20,40})$/);
  if (method === "GET" && sharedMatch) {
    const sql = await getSql();
    const rows = await sql`
      SELECT s.id, s.doc_id, s.version, s.expires_at, s.revoked_at,
             d.title, (SELECT content FROM buzzy_document_versions v
                        WHERE v.doc_id = s.doc_id AND v.version = s.version) AS content
      FROM buzzy_share_links s
      JOIN buzzy_documents d ON d.id = s.doc_id
      WHERE s.token = ${sharedMatch[1]}
      LIMIT 1
    `;
    const link = rows[0];
    if (!link || link.revoked_at || new Date(String(link.expires_at)).getTime() < Date.now()) {
      setResponseStatus(event, 410);
      return { error: "That link has expired or been turned off. Ask the owner for a fresh one.", code: "link_gone" };
    }
    if (link.content == null) {
      setResponseStatus(event, 410);
      return { error: "That document version is no longer available.", code: "link_gone" };
    }
    return {
      title: link.title,
      version: link.version,
      content: link.content,
      note: "Shared by the owner as a read-only link. It expires and can be turned off at any time.",
    };
  }

  // ── GET /api/buzzy/tools — the declared capability surface (BZ-F013) ────
  // Every tool the chat loop can execute, with its input/output contract,
  // sensitivity, cost class, side effects, permission need, verification and
  // failure behavior. The loop's allowlist IS this registry — a model
  // instruction alone mints nothing beyond it.
  if (method === "GET" && path === "/api/buzzy/tools") {
    return { tools: TOOL_REGISTRY };
  }

  // ── GET /api/buzzy/models — open catalog (labels only; raw ids stay server-side) ──
  if (method === "GET" && path === "/api/buzzy/models") {
    const models = getModels().map((m) => ({ label: m.label, key: m.label }));
    return { models };
  }

  // ── GET /api/buzzy/context — how full is the window right now ──────
  // Cheap estimate from the stored turns + a fixed prompt/tool allowance.
  // The authoritative number comes back on every chat turn (response.context).
  if (method === "GET" && path === "/api/buzzy/context") {
    const qs = fullPath.includes("?") ? fullPath.slice(fullPath.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const sessionId = params.get("sessionId");
    const jobId = params.get("jobId");
    const modelParam = params.get("model");
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    let rows: Array<{ content: string }> = [];
    try {
      rows = sessionId
        ? await sql`SELECT content FROM buzzy_chat_messages
            WHERE user_id = ${user.id} AND session_id = ${sessionId}
            ORDER BY created_at DESC LIMIT 60` as Array<{ content: string }>
        : jobId
          ? await sql`SELECT content FROM buzzy_chat_messages
              WHERE user_id = ${user.id} AND job_id = ${jobId}
              ORDER BY created_at DESC LIMIT 60` as Array<{ content: string }>
          : [];
    } catch { rows = []; }
    const label = modelParam || getModels()[0]?.label || "";
    const modelId = getModels().find((m) => m.label === label)?.model || label;
    const limit = contextWindowFor(modelId);
    const chars = rows.reduce((acc, r) => acc + String(r.content || "").length, 0);
    const used = Math.ceil(chars / 4) + 1500 + 2200; // turns + tool schemas + persona
    return { ok: true, model: label, messages: rows.length, context: contextState(used, limit) };
  }

  // ── GET /api/buzzy/transcript — restore chat on reload (dogfood 10007) ──
  // Accepts jobId (legacy) or sessionId (new) as an alternative.
  if (method === "GET" && path === "/api/buzzy/transcript") {
    const qs = fullPath.includes("?") ? fullPath.slice(fullPath.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const jobIdParam = params.get("jobId");
    const jobId = jobIdParam && jobIdParam !== "null" ? jobIdParam : null;
    const sessionIdParam = params.get("sessionId");
    const sessionId = sessionIdParam && sessionIdParam !== "null" ? sessionIdParam : null;
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    if (!sessionId && !jobId) {
      return { messages: [] };
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
          WHERE user_id = ${user.id} AND job_id = ${jobId}
          ORDER BY created_at ASC LIMIT 50
        `;
    // BZ-F004: resume at the server-confirmed state — restore the structured
    // Decisions (buzzy_user_memory) alongside the messages, so reopening a
    // job/session re-fills the Decisions box instead of showing it empty
    // until the next chat turn.
    let resolvedJobId = jobId;
    if (!resolvedJobId && sessionId) {
      const sj = await sql<{ job_id: string | null }>`
        SELECT job_id FROM buzzy_sessions
        WHERE id = ${sessionId} AND user_id = ${user.id} LIMIT 1
      `;
      resolvedJobId = sj[0]?.job_id ?? null;
    }
    const slots: Record<string, string> = {};
    if (resolvedJobId) {
      const slotRows = await sql<{ key: string; value: string }>`
        SELECT key, value FROM buzzy_user_memory
        WHERE user_id = ${user.id} AND job_id = ${resolvedJobId}
      `;
      const known = new Set([...STATEMENT_IDS, ...DEEPENING_IDS]);
      for (const r of slotRows) {
        if (known.has(r.key) && typeof r.value === "string" && r.value.trim()) {
          slots[r.key] = r.value;
        }
      }
    }
    return {
      messages: rows.map((r) => ({
        jobId: ("job_id" in r && typeof r.job_id === "string") ? r.job_id : null,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      })),
      slots,
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
    const attemptId: string | null = typeof body.attemptId === "string" && body.attemptId.trim()
      ? body.attemptId.trim().slice(0, 80)
      : null;
    const jobContext = typeof body.jobContext === "object" && body.jobContext !== null ? body.jobContext as Record<string, unknown> : undefined;
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
        setResponseStatus(event, 409);
        return {
          ok: false,
          error: "This job is cancelled — nothing more will run on it. Start a new job if you want to pick the idea up again.",
          code: "job_cancelled",
        };
      }
      if (status === "Paused") {
        setResponseStatus(event, 409);
        return {
          ok: false,
          error: "This job is paused — no work (and no spend) is happening. Resume it when you're ready and we'll pick up where we stopped.",
          code: "job_paused",
        };
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
        return { ok: true, reply: prior[0].content, reconciled: true, slots };
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

    const runTurn = (opts?: { speech?: VoiceHandlers; onText?: (t: string) => void }) =>
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
        speech: opts?.speech,
        voiceName,
        onText: opts?.onText,
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
              speech: {
                onText: (t) => send("text", { t }),
                onAudio: (b64, format) => send("audio", { b64, format }),
              },
            });
            send("done", result);
            if (result.timings) {
              await recordVoiceMetrics(sql, {
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
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // ── Typed lane, streamed ───────────────────────────────────────────
    // Same SSE contract as the voice lane minus audio: `text` deltas then
    // `done`. The page paints words as they arrive instead of after the whole
    // reply is buffered.
    if (body.stream === true) {
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
            const result = await runTurn({ onText: (t) => send("text", { t }) });
            send("done", result);
          } catch (err) {
            console.error("[buzzy/text] turn failed:", err instanceof Error ? err.message : err);
            send("error", { error: "The turn failed. Try again." });
          } finally {
            closed = true;
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const result = await runTurn();
    // Typed turns belong in the same log. Until now only the voice lane wrote a
    // server sample, so a slow typed turn left no trace at all — which is
    // exactly the turn the owner asked to have reviewed.
    if (result.timings) {
      try {
        await recordVoiceMetrics(sql, {
          userId,
          jobId,
          sessionId,
          source: "server",
          mode,
          lane: "text",
          model: result.timings.model,
          ttftMs: result.timings.ttftMs,
          ttfaMs: result.timings.ttfaMs,
          turnMs: result.timings.totalMs,
          extractMs: result.timings.extractMs,
          llmMs: result.timings.llmMs,
          honchoMs: result.timings.honchoMs,
          replyChars: result.reply?.length ?? 0,
          spoken: false,
        });
      } catch { /* metrics never break a turn */ }
    }
    // BZ-F039: a draft was shown to the human (no content recorded — ids and
    // timing only). Check verdicts travel as their own events.
    const replyText = typeof (result as { reply?: unknown }).reply === "string" ? String((result as { reply: string }).reply) : "";
    await recordTelemetry(sql, { userId, jobId, event: "draft_shown",
      props: { surface: "chat", ms: Date.now() - turnStarted, count: replyText.length > 0 ? 1 : 0 } });
    return result;
  }

  // ── Voice + turn latency metrics ───────────────────────────────────
  // POST: client beacon (what the owner experienced). GET: the readout —
  // p50/p95 time-to-talk and turn time, per day, for the signed-in account.
  if (method === "POST" && path === "/api/buzzy/voice-metrics") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      /* empty body — record what we have */
    }
    const num = (key: string): number | null => {
      const v = body[key];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      return Math.max(0, Math.min(600000, Math.round(v)));
    };
    const sql = await getSql();
    await recordVoiceMetrics(sql, {
      userId: user.id,
      jobId: typeof body.jobId === "string" ? body.jobId : null,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
      source: "client",
      mode: typeof body.mode === "string" ? body.mode.slice(0, 16) : null,
      model: typeof body.model === "string" ? body.model.slice(0, 64) : null,
      asrMs: num("asrMs"),
      ttftMs: num("ttftMs"),
      ttfaMs: num("ttfaMs"),
      turnMs: num("turnMs"),
      replyChars: num("replyChars"),
      audioBytes: num("audioBytes"),
      spoken: body.spoken === true,
      lane: typeof body.lane === "string" ? body.lane.slice(0, 8) : null,
      speechMs: num("speechMs"),
    });
    return { ok: true };
  }
  if (method === "GET" && path === "/api/buzzy/voice-metrics") {
    const ops = opsAuthorized(event);
    const user = ops ? null : await getSessionUserFromHeaders(headersFromEvent(event));
    if (!ops && !user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const opsUser = ops ? queryValue(fullPath, "user") : null;
    const sql = await getSql();
    // Never a nested query fragment (postgres.js would execute it). Two plain
    // parameters instead: "everything" for the operator, "one owner" otherwise.
    const scopeAll = ops && !opsUser;
    // `user` is null on the ops path, so it must be optional here.
    const scopeUid = opsUser ?? user?.id ?? "";
    const daysRaw = Number(queryValue(fullPath, "days"));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(90, Math.round(daysRaw)) : 7;
    try {
    const summary = (await sql`
      SELECT
        count(*)::int                                              AS turns,
        count(*) FILTER (WHERE spoken)::int                        AS spoken_turns,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfa_ms)       AS ttfa_p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfa_ms)      AS ttfa_p95,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms)       AS ttft_p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms)      AS ttft_p95,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY turn_ms)       AS turn_p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY turn_ms)      AS turn_p95,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY llm_ms)        AS llm_p50,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract_ms)    AS extract_p50,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY asr_ms)        AS asr_p50
      FROM buzzy_voice_metrics
      WHERE (${scopeAll} OR user_id = ${scopeUid})
        AND created_at > now() - (${days} * interval '1 day')
    `) as Array<Record<string, number | null>>;
    const byDay = (await sql`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             count(*)::int                                        AS turns,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfa_ms) AS ttfa_p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfa_ms) AS ttfa_p95,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY turn_ms) AS turn_p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY turn_ms) AS turn_p95
      FROM buzzy_voice_metrics
      WHERE (${scopeAll} OR user_id = ${scopeUid})
        AND created_at > now() - (${days} * interval '1 day')
      GROUP BY 1 ORDER BY 1 DESC
    `) as Array<Record<string, unknown>>;
    const recent = (await sql`
      SELECT created_at, source, mode, model, lane, asr_ms, ttft_ms, ttfa_ms, turn_ms,
             extract_ms, llm_ms, reply_chars, spoken, session_id, user_id, speech_ms
      FROM buzzy_voice_metrics
      WHERE (${scopeAll} OR user_id = ${scopeUid})
      ORDER BY created_at DESC LIMIT 25
    `) as Array<Record<string, unknown>>;
    // One row per TURN, not per sample: the server row and the client row are
    // written ~1ms apart for the same turn, and only together do they answer
    // "how long did the owner talk, and how long did we take to answer".
    // One entry per TURN. The server row and the client row for the same turn
    // are written ~1ms apart, so pair by session id and proximity — bucketing by
    // clock time splits them at bucket edges.
    const rowsSorted = (recent as Array<Record<string, any>>)
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const used = new Set<number>();
    const shaped: Array<Record<string, unknown>> = [];
    for (let i = 0; i < rowsSorted.length; i++) {
      if (used.has(i)) continue;
      const r = rowsSorted[i];
      used.add(i);
      let partner: Record<string, any> | null = null;
      for (let j = i + 1; j < rowsSorted.length; j++) {
        if (used.has(j)) continue;
        const q = rowsSorted[j];
        if (q.session_id !== r.session_id || q.source === r.source) continue;
        if (Math.abs(new Date(r.created_at).getTime() - new Date(q.created_at).getTime()) > 3000) break;
        partner = q;
        used.add(j);
        break;
      }
      const c = (r.source === "client" ? r : partner) ?? {};
      const v = (r.source === "server" ? r : partner) ?? {};
      shaped.push({
        at: r.created_at,
        session_id: r.session_id,
        user_id: r.user_id,
        model: c.model ?? v.model ?? null,
        lane: c.lane ?? v.lane ?? null,
        speech_ms: c.speech_ms ?? v.speech_ms ?? null,
        asr_ms: c.asr_ms ?? null,
        ttft_ms: c.ttft_ms ?? v.ttft_ms ?? null,
        ttfa_ms: c.ttfa_ms ?? v.ttfa_ms ?? null,
        turn_ms: c.turn_ms ?? v.turn_ms ?? null,
        reply_chars: c.reply_chars ?? v.reply_chars ?? null,
        spoken: c.spoken ?? v.spoken ?? null,
        overhead_ms:
          c.turn_ms != null && v.turn_ms != null ? Math.round(c.turn_ms - v.turn_ms) : null,
      });
    }
    return { ok: true, days, summary: summary[0] ?? null, byDay, turns: shaped, recent };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[buzzy/ops] voice-metrics read failed:", msg);
      if (ops) { setResponseStatus(event, 500); return { ok: false, error: msg }; }
      throw err;
    }
  }

  // ── GET /api/buzzy/tool-calls — what the harness actually ran ───────
  // Read-back for the tool telemetry. Identity + timing only; no arguments or
  // result text, so this is safe to expose to the signed-in owner.
  if (method === "GET" && path === "/api/buzzy/tool-calls") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const daysRaw = Number(queryValue(fullPath, "days"));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(90, Math.round(daysRaw)) : 1;
    const calls = (await sql`
      SELECT created_at, tool, gate, ms, ok, error_code, result_bytes, path, job_id
      FROM buzzy_tool_calls
      WHERE user_id = ${user.id}
        AND created_at > now() - (${days} * interval '1 day')
      ORDER BY created_at DESC
      LIMIT 50
    `) as Array<Record<string, unknown>>;
    const summary = (await sql`
      SELECT tool,
             count(*)::int                                        AS calls,
             count(*) FILTER (WHERE ok)::int                      AS ok_calls,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)      AS ms_p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)     AS ms_p95
      FROM buzzy_tool_calls
      WHERE user_id = ${user.id}
        AND created_at > now() - (${days} * interval '1 day')
      GROUP BY tool ORDER BY calls DESC
    `) as Array<Record<string, unknown>>;
    return { ok: true, days, summary, calls };
  }

  // ── GET /api/buzzy/jobs/:id/document — approval-gated artifact download ─
  // The .docx produced by render_document is downloadable ONLY after the
  // owner has approved the job (plan doc 23 Phase 1 acceptance).
  const pathParts = path.split("/"); // ["", "api", "buzzy", "jobs", ":id", "document"]
  if (method === "GET" && pathParts[2] === "buzzy" && pathParts[3] === "jobs" && pathParts[5] === "document") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const jobId = pathParts[4];
    const sql = await getSql();
    const rows = await sql`
      SELECT data->>'approved' AS approved, data->'artifact' AS artifact
      FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${user.id}
    `;
    const row = rows[0];
    if (!row || !row.artifact) {
      setResponseStatus(event, 404);
      return { error: "No document on this job", code: "not_found" };
    }
    if (row.approved !== "true") {
      setResponseStatus(event, 403);
      return { error: "Approve the document first, then download it.", code: "approval_required" };
    }
    const artifact = row.artifact as { filename?: string; bytesB64?: string; contentType?: string };
    if (!artifact.bytesB64) {
      setResponseStatus(event, 404);
      return { error: "No document on this job", code: "not_found" };
    }
    const bytes = Buffer.from(artifact.bytesB64, "base64");
    await recordTelemetry(sql, { userId: user.id, jobId, event: "exported",
      props: { format: artifact.contentType ?? "docx" } });
    setResponseStatus(event, 200);
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": artifact.contentType ?? "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${artifact.filename ?? "document.docx"}"`,
      },
    });
  }

  // ── Scheduled jobs (plan doc 23, component #5) ──────────────────────
  // Create/list/delete: owner-facing. Run: cron-friendly, secret-gated.
  if (method === "POST" && path === "/api/buzzy/scheduled") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const body = await event.req.json().then((b: any) => (b && typeof b === "object" ? b : {})).catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "";
    const cadence = ["daily", "weekly", "monthly"].includes(body.cadence) ? body.cadence : "weekly";
    const companyId = typeof body.companyId === "string" && isCompanyId(body.companyId) ? body.companyId : null;
    if (!name || !prompt) {
      setResponseStatus(event, 400);
      return { error: "name and prompt are required", code: "bad_request" };
    }
    const sql = await getSql();
    const id = "sch_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    await sql`
      INSERT INTO buzzy_scheduled_jobs (id, user_id, company_id, name, prompt, cadence)
      VALUES (${id}, ${user.id}, ${companyId}, ${name}, ${prompt}, ${cadence})
    `;
    return { ok: true, scheduled: { id, name, cadence } };
  }
  if (method === "GET" && path === "/api/buzzy/scheduled") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT id, name, prompt, cadence, next_run_at, last_result, enabled
      FROM buzzy_scheduled_jobs WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 50
    `;
    return { ok: true, scheduled: rows };
  }
  if (method === "DELETE" && path.startsWith("/api/buzzy/scheduled/")) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    await sql`DELETE FROM buzzy_scheduled_jobs WHERE id = ${path.slice("/api/buzzy/scheduled/".length)} AND user_id = ${user.id}`;
    return { ok: true };
  }
  // Cron runner: each due run lands a DRAFT in the approve queue. Never sends.
  if (method === "GET" && path === "/api/buzzy/scheduled/run") {
    const runnerSecret = process.env.BZ_SCHEDULER_SECRET ?? "";
    const provided = queryValue(fullPath, "secret") ?? "";
    if (!runnerSecret || provided !== runnerSecret) {
      setResponseStatus(event, 403);
      return { error: "Runner secret required", code: "forbidden" };
    }
    const sql = await getSql();
    const due = await dueScheduledJobs(sql, 3);
    const results: Array<{ id: string; draftId?: string; error?: string }> = [];
    for (const job of due) {
      try {
        const userId = job.user_id;
        const result = await chatLoop({
          userId,
          jobId: null,
          sessionId: null,
          message: job.prompt + "\n\n(This is a scheduled run — produce the draft; it will wait for approval.)",
          jobContext: undefined,
          companyName: null,
          companyFacts: [],
        });
        if (result.ok && result.reply) {
          const draftId = await saveScheduledDraft(sql, job, result.reply);
          await markScheduledRun(sql, job.id, "draft created: " + draftId, "weekly");
          results.push({ id: job.id, draftId });
        } else {
          await markScheduledRun(sql, job.id, "run failed: " + (result.error ?? "unknown"), "weekly");
          results.push({ id: job.id, error: result.error ?? "unknown" });
        }
      } catch (err) {
        await markScheduledRun(sql, job.id, "run threw: " + String(err), "weekly");
        results.push({ id: job.id, error: String(err) });
      }
    }
    return { ok: true, ran: results.length, results };
  }

  // ── Inbox actions (component #4): READ-ONLY digest; sending never exists
  // as an autonomous path. Without a connection: clean not-connected state —
  // the zero-config harness stays fully useful.
  if (method === "GET" && path === "/api/buzzy/inbox/digest") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const conn = await sql`
      SELECT status, last_error FROM buzzy_connections
      WHERE user_id = ${user.id} AND kind = 'email' AND scope = 'read' LIMIT 1
    `;
    if (!conn.length || conn[0].status !== "connected") {
      return { ok: true, connected: false, message: "No mailbox connected yet. Connect one any time — until then, everything else works as usual." };
    }
    if (conn[0].last_error) {
      return { ok: true, connected: true, degraded: true, message: `I can't reach your mailbox right now (${conn[0].last_error}). Reconnect from settings when you can.` };
    }
    return { ok: true, connected: true, items: [], message: "Mailbox connected. Digest items appear here as drafted replies waiting on your approval." };
  }

  // ── GET /api/buzzy/jobs/:id/events — attribution audit trail ─────────
  if (method === "GET" && pathParts?.[2] === "buzzy" && pathParts?.[3] === "jobs" && pathParts?.[5] === "events") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT actor, action, detail, created_at FROM buzzy_job_events
      WHERE job_id = ${pathParts[4]} AND user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 100
    `;
    return { ok: true, events: rows };
  }

  // ── GET /api/buzzy/export — one-click data export (plan doc 23) ──────
  if (method === "GET" && path === "/api/buzzy/export") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const bundle = await buildExportBundle(sql, user.id);
    return new Response(bundle.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${bundle.filename}"`,
      },
    });
  }

  // ── DELETE /api/buzzy/account — one-action, plain-confirmation deletion ─
  if (method === "DELETE" && path === "/api/buzzy/account") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    if (body.confirm !== "delete my business") {
      setResponseStatus(event, 400);
      return { error: 'This removes everything. Send {"confirm":"delete my business"} to proceed.', code: "confirmation_required" };
    }
    const sql = await getSql();
    const receipt = await deleteAccountData(sql, user.id);
    return { ok: true, deleted: receipt };
  }

  // ── Integrations: connection framework (plan doc 23, read-only first) ─
  // One consent moment per connection, plain language, scope as buckets.
  const CONNECTION_CONSENT: Record<string, string> = {
    email: "May I read your email to learn about your customers? You'll see everything I learn, and I'll never send anything without asking.",
    calendar: "May I read your calendar to keep scheduling language realistic? I'll only propose events as drafts, never create them myself.",
    documents: "May I read documents you choose, to learn your templates? New files land in your folder only after you approve them.",
    invoicing: "May I read paid/unpaid status to ground what I know about your customers? I will never write to your invoicing system.",
  };

  if (method === "GET" && path === "/api/buzzy/connections") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT kind, scope, status, last_error, connected_at, scope_detail
      FROM buzzy_connections WHERE user_id = ${user.id} ORDER BY connected_at DESC
    `;
    const known = Object.keys(CONNECTION_CONSENT);
    return {
      ok: true,
      connections: rows,
      available: known.map((kind) => ({ kind, consent: CONNECTION_CONSENT[kind] })),
    };
  }

  if (method === "POST" && path === "/api/buzzy/connections") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const body = await event.req.json().then((b: any) => (b && typeof b === "object" ? b : {})).catch(() => ({}));
    const kind = typeof body.kind === "string" && CONNECTION_CONSENT[body.kind] ? body.kind : null;
    // Write scope exists ONLY as draft-creation; outward writes do not exist.
    const scope = body.scope === "write" ? "write" : "read";
    if (!kind) {
      setResponseStatus(event, 400);
      return { error: "Unknown integration kind", code: "bad_request" };
    }
    // BZ-F032: the owner selects exactly what is shared (labels/folders/
    // messages) — never a silent full-mailbox grant. Read-only first is the
    // default; the selection is stored so the UI can explain and revoke it.
    const selected = Array.isArray(body.selected)
      ? (body.selected as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s: string) => s.trim().slice(0, 120)).slice(0, 20)
      : [];
    const scopeDetail = { selected, readOnly: scope === "read" };
    const sql = await getSql();
    await sql`
      INSERT INTO buzzy_connections (id, user_id, kind, scope, status, scope_detail)
      VALUES (${"conn_" + Math.random().toString(36).slice(2, 10)}, ${user.id}, ${kind}, ${scope}, 'connected',
              ${JSON.stringify(scopeDetail)}::jsonb)
      ON CONFLICT (user_id, kind) DO UPDATE SET
        scope = EXCLUDED.scope, status = 'connected', last_error = '', updated_at = now(),
        scope_detail = EXCLUDED.scope_detail
    `;
    return {
      ok: true,
      kind,
      scope,
      selected,
      consent: CONNECTION_CONSENT[kind],
      note: selected.length
        ? `Connected to ${selected.length} selected item${selected.length === 1 ? "" : "s"} — nothing outside that selection is read.`
        : "Connected read-only, but nothing is selected yet — pick the folders or messages you want shared.",
    };
  }

  if (method === "DELETE" && path.startsWith("/api/buzzy/connections/")) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    await sql`DELETE FROM buzzy_connections WHERE user_id = ${user.id} AND kind = ${path.slice("/api/buzzy/connections/".length)}`;
    return { ok: true };
  }

  // ── GET /api/buzzy/notifications — draft-bearing notification payload ─
  if (method === "GET" && path === "/api/buzzy/notifications") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT id, title, updated_at FROM buzzy_jobs
      WHERE user_id = ${user.id} AND data->>'draft' IS NOT NULL
        AND data->>'approved' IS DISTINCT FROM 'true'
      ORDER BY updated_at DESC LIMIT 5
    `;
    return {
      ok: true,
      pendingDrafts: rows.length,
      newest: rows[0] ? { title: rows[0].title, jobId: rows[0].id } : null,
    };
  }

  // ── GET /api/buzzy/templates — the owner's template library ─────────
  if (method === "GET" && path === "/api/buzzy/templates") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT id, company_id, name, kind, structure, created_at
      FROM buzzy_templates WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 50
    `;
    return { ok: true, templates: rows };
  }

  // ── POST /api/buzzy/templates — upload a .docx, extract its structure ─
  if (method === "POST" && path === "/api/buzzy/templates") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const b64 = typeof body.docxB64 === "string" ? body.docxB64 : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "Uploaded template";
    const companyId = typeof body.companyId === "string" && isCompanyId(body.companyId) ? body.companyId : null;
    if (!b64) {
      setResponseStatus(event, 400);
      return { error: "docxB64 is required", code: "bad_request" };
    }
    let structure;
    try {
      structure = await extractTemplateStructure(new Uint8Array(Buffer.from(b64, "base64")));
    } catch (terr) {
      setResponseStatus(event, 400);
      return { error: terr instanceof Error ? terr.message : "not a readable .docx", code: "bad_file" };
    }
    const sql = await getSql();
    const id = "tpl_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    await sql`
      INSERT INTO buzzy_templates (id, user_id, company_id, name, kind, structure)
      VALUES (${id}, ${user.id}, ${companyId}, ${name}, 'document', ${JSON.stringify(structure)}::jsonb)
    `;
    return { ok: true, template: { id, name, structure } };
  }

  // ── GET /api/buzzy/digest — weekly civilian activity log ────────────
  if (method === "GET" && path === "/api/buzzy/digest") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const weeksRaw = queryValue(fullPath, "weeks");
    const weeks = weeksRaw ? Number(weeksRaw) : 1;
    const sql = await getSql();
    const digest = await buildWeeklyDigest(sql, user.id, {
      weeks: Number.isFinite(weeks) ? weeks : 1,
    });
    return { ok: true, digest };
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

  // ── DELETE /api/buzzy/memory — forget, with propagation (BZ-F031) ─────
  // Removes remembered facts for one job (or one key). Memory is derived at
  // READ time from buzzy_user_memory, so the next chat turn provably no
  // longer applies the forgotten items. Approved documents and the Library
  // are NOT deleted — forgetting memory never implies deleting the work.
  if (method === "DELETE" && path === "/api/buzzy/memory") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const jobId = typeof body.jobId === "string" && body.jobId.trim() ? body.jobId.trim().slice(0, 120) : null;
    const key = typeof body.key === "string" && body.key.trim() ? body.key.trim().slice(0, 80) : null;
    if (!jobId) {
      setResponseStatus(event, 400);
      return { error: "Tell me which job to forget memory for.", code: "bad_request" };
    }
    const sql = await getSql();
    const rows = key
      ? await sql`
          DELETE FROM buzzy_user_memory
          WHERE user_id = ${user.id} AND job_id = ${jobId} AND key = ${key}
          RETURNING 1
        `
      : await sql`
          DELETE FROM buzzy_user_memory
          WHERE user_id = ${user.id} AND job_id = ${jobId}
          RETURNING 1
        `;
    return {
      ok: true,
      forgotten: rows.length,
      note: "Those remembered details are gone and won't be used again. Approved documents and your Library are untouched — delete a job or the account for that.",
    };
  }

  // ── GET /api/buzzy/profile — account-scoped business profile + defaults ──
  if (method === "GET" && path === "/api/buzzy/profile") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const profile = await getProfile(sql, user.id);
    return { fields: PROFILE_FIELDS, profile };
  }

  // ── PUT /api/buzzy/profile — save profile fields (closed key set) ──────
  if (method === "PUT" && path === "/api/buzzy/profile") {
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
    const values =
      body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
        ? (body.fields as Record<string, unknown>)
        : {};
    const sql = await getSql();
    const { saved, rejected } = await saveProfile(sql, user.id, values);
    const profile = await getProfile(sql, user.id);
    return { saved, rejected, profile };
  }

  // ── POST /api/buzzy/profile/reuse — copy chosen defaults into a job ─────
  if (method === "POST" && path === "/api/buzzy/profile/reuse") {
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
    const jobId = typeof body.jobId === "string" && body.jobId ? body.jobId : null;
    const keys = Array.isArray(body.keys)
      ? body.keys.filter((k): k is string => typeof k === "string")
      : [];
    if (!jobId) {
      setResponseStatus(event, 400);
      return { error: "jobId is required", code: "bad_request" };
    }
    const sql = await getSql();
    const { reused, skipped } = await reuseDefaults(sql, user.id, jobId, keys);
    return { reused, skipped };
  }

  // ── GET /api/buzzy/companies — tabs for this account ────────────────
  if (method === "GET" && path === "/api/buzzy/companies") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql<CompanyRow>`
      SELECT id, name, one_liner, website, created_at, updated_at
      FROM buzzy_companies
      WHERE user_id = ${user.id}
      ORDER BY created_at ASC
      LIMIT 50
    `;
    const facts = await companyFacts(sql, user.id);
    return { companies: rows.map((row) => companyPayload(row, facts)) };
  }

  // ── POST /api/buzzy/companies/from-website — proposed card, nothing confirmed ──
  if (method === "POST" && path === "/api/buzzy/companies/from-website") {
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
    const read = await readPublicWebsite(body.url);
    if (!read.ok) {
      setResponseStatus(event, read.code === "bad_url" || read.code === "blocked" ? 400 : 422);
      return { error: read.error, code: read.code };
    }
    const named = read.lines.find((l) => l.key === "name");
    const name = companyName(named?.value) || fallbackCompanyName(read.page);
    const id = `co_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const sql = await getSql();
    const rows = await sql<CompanyRow>`
      INSERT INTO buzzy_companies (id, user_id, name, website)
      VALUES (${id}, ${user.id}, ${name}, ${read.page})
      RETURNING id, name, one_liner, website, created_at, updated_at
    `;
    try {
      for (const line of read.lines) {
        const lineId = `ln_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        await sql`
          INSERT INTO buzzy_company_facts
            (id, company_id, user_id, fact_key, label, value, status, source_label, source_page, original_value)
          VALUES
            (${lineId}, ${id}, ${user.id}, ${line.key}, ${line.label}, ${line.value},
             'proposed', ${WEBSITE_SOURCE}, ${read.page}, ${line.value})
        `;
      }
    } catch (err) {
      await sql`DELETE FROM buzzy_company_facts WHERE company_id = ${id} AND user_id = ${user.id}`;
      await sql`DELETE FROM buzzy_companies WHERE id = ${id} AND user_id = ${user.id}`;
      throw err;
    }
    const facts = await companyFacts(sql, user.id, id);
    setResponseStatus(event, 201);
    return { company: companyPayload(rows[0], facts) };
  }

  // ── POST /api/buzzy/companies/:id/lines — confirm, edit, or drop one line ──
  const lineMatch = path.match(/^\/api\/buzzy\/companies\/(co_[a-z0-9]{8,32})\/lines$/);
  if (method === "POST" && lineMatch) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const companyId = lineMatch[1];
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch { /* handled below */ }
    const lineId = typeof body.lineId === "string" ? body.lineId : "";
    const action = body.action;
    if (!/^ln_[a-z0-9]{8,32}$/.test(lineId) || (action !== "confirm" && action !== "edit" && action !== "drop")) {
      setResponseStatus(event, 400);
      return { error: "Choose confirm, change, or drop for that line.", code: "bad_request" };
    }
    const edited = action === "edit" ? factValue(body.value) : null;
    if (action === "edit" && !edited) {
      setResponseStatus(event, 400);
      return { error: "Type what this line should say.", code: "bad_request" };
    }
    const sql = await getSql();
    const owned = await sql<CompanyRow>`
      SELECT id, name, one_liner, website, created_at, updated_at
      FROM buzzy_companies
      WHERE id = ${companyId} AND user_id = ${user.id}
    `;
    if (!owned.length) {
      setResponseStatus(event, 404);
      return { error: "Company not found", code: "not_found" };
    }
    const existing = await sql<FactRow>`
      SELECT id, company_id, fact_key, label, value, status, source_label, source_page, original_value
      FROM buzzy_company_facts
      WHERE id = ${lineId} AND company_id = ${companyId} AND user_id = ${user.id}
    `;
    if (!existing.length || existing[0].status === "dropped") {
      setResponseStatus(event, 404);
      return { error: "That line is not on the card.", code: "not_found" };
    }
    const row = existing[0];
    if (action === "drop") {
      await sql`
        UPDATE buzzy_company_facts
        SET status = 'dropped', updated_at = now()
        WHERE id = ${lineId} AND user_id = ${user.id}
      `;
      if (row.fact_key === "does") {
        await sql`
          UPDATE buzzy_companies
          SET one_liner = '', updated_at = now()
          WHERE id = ${companyId} AND user_id = ${user.id} AND one_liner = ${row.value}
        `;
      }
    } else {
      const next = action === "edit" ? (edited as string) : row.value;
      await sql`
        UPDATE buzzy_company_facts
        SET status = 'confirmed', value = ${next}, updated_at = now()
        WHERE id = ${lineId} AND user_id = ${user.id}
      `;
      if (row.fact_key === "name") {
        const renamed = companyName(next);
        if (renamed) {
          await sql`
            UPDATE buzzy_companies
            SET name = ${renamed}, updated_at = now()
            WHERE id = ${companyId} AND user_id = ${user.id}
          `;
        }
      } else if (row.fact_key === "does") {
        await sql`
          UPDATE buzzy_companies
          SET one_liner = ${next.slice(0, 280)}, updated_at = now()
          WHERE id = ${companyId} AND user_id = ${user.id}
        `;
      }
    }
    const fresh = await sql<CompanyRow>`
      SELECT id, name, one_liner, website, created_at, updated_at
      FROM buzzy_companies
      WHERE id = ${companyId} AND user_id = ${user.id}
    `;
    const facts = await companyFacts(sql, user.id, companyId);
    return { company: companyPayload(fresh[0], facts) };
  }

  // ── POST /api/buzzy/companies — add a company by the name the owner uses ──
  if (method === "POST" && path === "/api/buzzy/companies") {
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
    const name = companyName(body.name);
    if (!name) {
      setResponseStatus(event, 400);
      return { error: "Type the company name.", code: "bad_request" };
    }
    const id = `co_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const sql = await getSql();
    const rows = await sql<CompanyRow>`
      INSERT INTO buzzy_companies (id, user_id, name)
      VALUES (${id}, ${user.id}, ${name})
      RETURNING id, name, one_liner, website, created_at, updated_at
    `;
    setResponseStatus(event, 201);
    return { company: companyPayload(rows[0]) };
  }

  // ── PATCH /api/buzzy/companies/:id — rename + edit the one-liner ─────
  const patchCompany = path.match(/^\/api\/buzzy\/companies\/(co_[a-z0-9]{8,32})$/);
  if (method === "PATCH" && patchCompany) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const companyId = patchCompany[1];
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch { /* handled below */ }
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const hasOneLiner = Object.prototype.hasOwnProperty.call(body, "one_liner");
    if (!hasName && !hasOneLiner) {
      setResponseStatus(event, 400);
      return { error: "Nothing to update.", code: "bad_request" };
    }
    const name = hasName ? companyName(body.name) : null;
    if (hasName && !name) {
      setResponseStatus(event, 400);
      return { error: "Type the company name.", code: "bad_request" };
    }
    const cleanOneLiner =
      hasOneLiner && typeof body.one_liner === "string"
        ? body.one_liner.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 280)
        : null;
    const sql = await getSql();
    const owned = await sql<CompanyRow>`
      SELECT id, name, one_liner, website, created_at, updated_at
      FROM buzzy_companies
      WHERE id = ${companyId} AND user_id = ${user.id}
    `;
    if (!owned.length) {
      setResponseStatus(event, 404);
      return { error: "Company not found", code: "not_found" };
    }
    const newName = hasName && name ? name : owned[0].name;
    const newOneLiner = cleanOneLiner !== null ? cleanOneLiner : owned[0].one_liner;
    const updated = await sql<CompanyRow>`
      UPDATE buzzy_companies
      SET name = ${newName}, one_liner = ${newOneLiner}, updated_at = now()
      WHERE id = ${companyId} AND user_id = ${user.id}
      RETURNING id, name, one_liner, website, created_at, updated_at
    `;
    const facts = await companyFacts(sql, user.id, companyId);
    return { company: companyPayload(updated[0], facts) };
  }

  // ── GET /api/buzzy/jobs — list the user's durable jobs ──────────────
  if (method === "GET" && path === "/api/buzzy/jobs") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const companyFilter = queryValue(fullPath, "companyId");
    if (companyFilter) {
      if (!isCompanyId(companyFilter)) {
        setResponseStatus(event, 400);
        return { error: "Unknown company.", code: "bad_company" };
      }
      const owned = await sql`
        SELECT id FROM buzzy_companies WHERE id = ${companyFilter} AND user_id = ${user.id}
      `;
      if (!owned.length) {
        setResponseStatus(event, 404);
        return { error: "Company not found", code: "not_found" };
      }
    }
    // BZ-F037: Archived jobs leave the ACTIVE view but keep documents and
    // history — they return only with ?archived=1.
    const includeArchived = queryValue(fullPath, "archived") === "1";
    const rows = companyFilter
      ? await sql`
          SELECT id, template, title, status, company_id, data, created_at, updated_at
          FROM buzzy_jobs
          WHERE user_id = ${user.id} AND company_id = ${companyFilter}
            AND (${includeArchived}::boolean OR status IS DISTINCT FROM 'Archived')
          ORDER BY updated_at DESC
          LIMIT 500
        `
      : await sql`
          SELECT id, template, title, status, company_id, data, created_at, updated_at
          FROM buzzy_jobs
          WHERE user_id = ${user.id}
            AND (${includeArchived}::boolean OR status IS DISTINCT FROM 'Archived')
          ORDER BY updated_at DESC
          LIMIT 500
        `;
    return {
      jobs: rows.map((r) => ({
        id: r.id,
        template: r.template,
        title: r.title,
        status: r.status,
        companyId: typeof r.company_id === "string" ? r.company_id : null,
        data: typeof r.data === "string" ? safeParseJson(r.data) : r.data,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  }

  // ── GET /api/buzzy/search — work search across ALL of the user's companies
  // Matches job titles, captured problem text, and chat message content, so a
  // user can find work by what was said in it, not just its title. Archived
  // jobs stay out. Results carry the company name for the cross-company view.
  if (method === "GET" && path === "/api/buzzy/search") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const raw = (queryValue(fullPath, "q") ?? "").trim();
    // A one-character search is not a search — say so instead of returning an
    // empty 200 that looks like "no matches" (BZ-F019 contract, kept).
    if (raw.length === 1) {
      setResponseStatus(event, 400);
      return { error: "Type at least 2 characters to search.", code: "bad_query" };
    }
    if (raw.length === 0) {
      return { ok: true, query: "", jobs: [], documents: [], sessions: [], totals: { jobs: 0, documents: 0, sessions: 0 } };
    }
    const statusFilter = queryValue(fullPath, "status");
    const typeFilter = queryValue(fullPath, "type"); // "jobs" | "documents" | null
    const pattern = "%" + raw.slice(0, 120).replace(/[%_]/g, (m) => "\\" + m) + "%";
    const sql = await getSql();
    const jobRows = await sql`
      SELECT j.id, j.title, j.status, j.company_id, c.name AS company_name, j.updated_at,
        COALESCE(j.data->>'problem', j.data->'slots'->>'challenge', '') AS snippet
      FROM buzzy_jobs j
      LEFT JOIN buzzy_companies c ON c.id = j.company_id AND c.user_id = j.user_id
      WHERE j.user_id = ${user.id}
        AND j.status IS DISTINCT FROM 'Archived'
        AND (
          j.title ILIKE ${pattern}
          OR COALESCE(j.data->>'problem', '') ILIKE ${pattern}
          OR COALESCE(j.data->'slots'->>'challenge', '') ILIKE ${pattern}
          OR COALESCE(j.data->'slots'->>'end_goal', '') ILIKE ${pattern}
          OR EXISTS (
            SELECT 1 FROM buzzy_chat_messages m
            WHERE m.job_id = j.id AND m.user_id = ${user.id} AND m.content ILIKE ${pattern}
          )
        )
      ORDER BY j.updated_at DESC
      LIMIT 25
    `;
    const sessionRows = await sql`
      SELECT s.id, s.title, s.job_id, s.company_id, c.name AS company_name, s.updated_at,
        (SELECT count(*) FROM buzzy_chat_messages m WHERE m.session_id = s.id) AS message_count,
        COALESCE(s.summary, '') AS snippet
      FROM buzzy_sessions s
      LEFT JOIN buzzy_companies c ON c.id = s.company_id AND c.user_id = s.user_id
      WHERE s.user_id = ${user.id}
        AND (
          s.title ILIKE ${pattern}
          OR COALESCE(s.summary, '') ILIKE ${pattern}
          OR EXISTS (
            SELECT 1 FROM buzzy_chat_messages m
            WHERE m.session_id = s.id AND m.user_id = ${user.id} AND m.content ILIKE ${pattern}
          )
        )
      ORDER BY s.updated_at DESC
      LIMIT 25
    `;
    // Documents are part of "find my work" — title OR current-version content,
    // with a snippet so the result explains itself (BZ-F019).
    const docRows = typeFilter === "jobs" ? [] : await sql`
      SELECT d.id, d.job_id, d.title, d.status, d.current_version, d.updated_at,
             (SELECT content FROM buzzy_document_versions v
               WHERE v.doc_id = d.id AND v.version = d.current_version) AS content
      FROM buzzy_documents d
      WHERE d.user_id = ${user.id}
        AND (d.title ILIKE ${pattern}
             OR (SELECT content FROM buzzy_document_versions v
                  WHERE v.doc_id = d.id AND v.version = d.current_version) ILIKE ${pattern})
        AND (${statusFilter}::text IS NULL OR d.status = ${statusFilter})
      ORDER BY d.updated_at DESC LIMIT 25
    `;
    const ql = raw.toLowerCase();
    return {
      ok: true,
      query: raw,
      jobs: typeFilter === "documents" ? [] : jobRows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        companyId: typeof r.company_id === "string" ? r.company_id : null,
        companyName: typeof r.company_name === "string" ? r.company_name : null,
        snippet: typeof r.snippet === "string" ? r.snippet.slice(0, 180) : "",
        updatedAt: r.updated_at,
      })),
      sessions: sessionRows.map((r) => ({
        id: r.id,
        title: r.title,
        jobId: typeof r.job_id === "string" ? r.job_id : null,
        companyId: typeof r.company_id === "string" ? r.company_id : null,
        companyName: typeof r.company_name === "string" ? r.company_name : null,
        snippet: typeof r.snippet === "string" ? r.snippet.slice(0, 180) : "",
        messageCount: Number(r.message_count),
        updatedAt: r.updated_at,
      })),
      documents: docRows.map((d) => {
        const content = String(d.content ?? "");
        const at = content.toLowerCase().indexOf(ql);
        const snippet = at >= 0
          ? content.slice(Math.max(0, at - 60), at + raw.length + 60).replace(/\s+/g, " ").trim()
          : "";
        return {
          id: d.id, jobId: d.job_id, title: d.title, status: d.status,
          currentVersion: d.current_version, updatedAt: d.updated_at,
          ...(snippet ? { snippet } : {}),
        };
      }),
      totals: { jobs: typeFilter === "documents" ? 0 : jobRows.length, documents: docRows.length, sessions: sessionRows.length },
    };
  }

  // ── POST /api/buzzy/jobs — upsert a job (durable persistence) ───────
  if (method === "POST" && path === "/api/buzzy/jobs") {
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
    const id = typeof body.id === "string" && body.id ? body.id.slice(0, 120) : "";
    if (!id) {
      setResponseStatus(event, 400);
      return { error: "id is required", code: "bad_request" };
    }
    const template = typeof body.template === "string" ? body.template.slice(0, 64) : null;
    const title = typeof body.title === "string" ? body.title.slice(0, 200) : null;
    const status = typeof body.status === "string" ? body.status.slice(0, 64) : null;
    // Missing companyId leaves the column alone so an older client cannot
    // unfile a job. null files it to no company. A string must be ours.
    let companyId: string | null | undefined;
    if (Object.prototype.hasOwnProperty.call(body, "companyId")) {
      if (body.companyId === null || body.companyId === "") companyId = null;
      else if (typeof body.companyId === "string" && isCompanyId(body.companyId)) companyId = body.companyId;
      else {
        setResponseStatus(event, 400);
        return { error: "That company isn't on your account.", code: "bad_company" };
      }
    }
    const dataObj: Record<string, unknown> =
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? { ...(body.data as Record<string, unknown>) }
        : {};
    if (companyId !== undefined) dataObj.companyId = companyId;
    const dataJson = JSON.stringify(dataObj);
    const sql = await getSql();
    if (typeof companyId === "string") {
      const owned = await sql`
        SELECT id FROM buzzy_companies WHERE id = ${companyId} AND user_id = ${user.id}
      `;
      if (!owned.length) {
        setResponseStatus(event, 400);
        return { error: "That company isn't on your account.", code: "bad_company" };
      }
    }
    const rows = companyId !== undefined
      ? await sql`
          INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
          VALUES (${id}, ${user.id}, ${template}, ${title}, ${status}, ${companyId}, ${dataJson}::jsonb, now())
          ON CONFLICT (id) DO UPDATE SET
            template = EXCLUDED.template,
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            company_id = EXCLUDED.company_id,
            data = EXCLUDED.data,
            updated_at = now()
          WHERE buzzy_jobs.user_id = EXCLUDED.user_id
          RETURNING id
        `
      : await sql`
          INSERT INTO buzzy_jobs (id, user_id, template, title, status, data, updated_at)
          VALUES (${id}, ${user.id}, ${template}, ${title}, ${status}, ${dataJson}::jsonb, now())
          ON CONFLICT (id) DO UPDATE SET
            template = EXCLUDED.template,
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            data = EXCLUDED.data,
            updated_at = now()
          WHERE buzzy_jobs.user_id = EXCLUDED.user_id
          RETURNING id
        `;
    if (!rows.length) {
      setResponseStatus(event, 409);
      return { error: "That job belongs to someone else.", code: "conflict" };
    }
    return { ok: true, id, companyId: companyId === undefined ? undefined : companyId };
  }

  // ── DELETE /api/buzzy/jobs/:id — remove a job (ownership enforced) ──
  if (method === "DELETE" && path.startsWith("/api/buzzy/jobs/")) {
    const id = path.slice("/api/buzzy/jobs/".length);
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    if (!id) {
      setResponseStatus(event, 400);
      return { error: "id is required", code: "bad_request" };
    }
    const sql = await getSql();
    // Attribution event only when the caller actually owns and deletes the job —
    // otherwise a non-owner DELETE attempt would stamp their event onto someone
    // else's job (QA-05 negative, BZ-F002 / #158).
    const deleted = await sql`DELETE FROM buzzy_jobs WHERE id = ${id} AND user_id = ${user.id} RETURNING id`;
    if (deleted.length) {
      await recordJobEvent(sql, id, user.id, "delete", "job deleted by owner");
    }
    // BZ-F037: deletion PROPAGATES per policy and says so. A deleted job takes
    // its messages, remembered facts, documents (+versions) and execution
    // linkage with it; the response spells out scope, including what no
    // consumer delete can touch (backups / legally required audit).
    if (deleted.length) {
      const docId = "doc_" + id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
      const cascade: Record<string, number> = {};
      cascade.messages = (await sql`DELETE FROM buzzy_chat_messages WHERE user_id = ${user.id} AND job_id = ${id} RETURNING 1`).length;
      cascade.memory = (await sql`DELETE FROM buzzy_user_memory WHERE user_id = ${user.id} AND job_id = ${id} RETURNING 1`).length;
      cascade.document_versions = (await sql`DELETE FROM buzzy_document_versions WHERE doc_id = ${docId} RETURNING 1`).length;
      cascade.documents = (await sql`DELETE FROM buzzy_documents WHERE id = ${docId} AND user_id = ${user.id} RETURNING 1`).length;
      return {
        ok: true,
        deleted: { job: 1, ...cascade },
        note: "The job, its conversation, its remembered details and its documents are deleted. This does not reach encrypted backups or legally required audit records, which age out on their own schedule.",
      };
    }
    return { ok: true, deleted: { job: 0 }, note: "Nothing was deleted — that job isn't on your account." };
  }

  // ── PATCH /api/buzzy/jobs/:id — rename the job title ─────────────────
  if (method === "PATCH" && path.startsWith("/api/buzzy/jobs/")) {
    const id = path.slice("/api/buzzy/jobs/".length);
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    if (!id) {
      setResponseStatus(event, 400);
      return { error: "id is required", code: "bad_request" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch { /* handled below */ }
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : null;
    const hasTitle = title !== null;
    if (hasTitle && !title) {
      setResponseStatus(event, 400);
      return { error: "title is required", code: "bad_request" };
    }
    const status = typeof body.status === "string" ? body.status.slice(0, 64) : null;
    const hasStatus = status !== null;
    const hasApproved = typeof body.approved === "boolean";
    const hasDraft = typeof body.draft === "string";
    // BZ-F026: explicit due date, stored exactly as given (ISO with the
    // owner's timezone offset) — never inferred, never silently shifted.
    const hasDueDate = typeof body.dueDate === "string" && !Number.isNaN(Date.parse(body.dueDate));
    if (typeof body.dueDate === "string" && body.dueDate && !hasDueDate) {
      setResponseStatus(event, 400);
      return { error: "That due date didn't parse — use a date like 2026-11-15 or a full ISO timestamp.", code: "bad_date" };
    }
    if (!hasTitle && !hasStatus && !hasApproved && !hasDraft && !hasDueDate) {
      setResponseStatus(event, 400);
      return { error: "Nothing to update.", code: "bad_request" };
    }
    const dataPatch: Record<string, unknown> = {};
    if (hasApproved) dataPatch.approved = body.approved;
    if (hasDraft) dataPatch.draft = body.draft;
    if (hasDueDate) dataPatch.due_date = body.dueDate;
    let executionInfo: { projectId: string; created: boolean } | null = null;
    const sql = await getSql();
    const rows = await sql`
      UPDATE buzzy_jobs SET
        title = COALESCE(${title}, title),
        status = COALESCE(${status}, status),
        data = COALESCE(data, '{}'::jsonb) || ${JSON.stringify(dataPatch)}::jsonb,
        updated_at = now()
      WHERE id = ${id} AND user_id = ${user.id}
      RETURNING id, title, status, company_id
    `;
    if (!rows.length) {
      setResponseStatus(event, 404);
      return { error: "job not found", code: "not_found" };
    }
    // ── Per-human attribution (multi-owner groundwork) ─────────────────
    if (hasApproved) {
      await recordJobEvent(sql, id, user.id, "approve",
        body.approved === true ? "approved" : "approval revoked");
      await recordTelemetry(sql, { userId: user.id, jobId: id,
        event: body.approved === true ? "approval_recorded" : "reopened",
        props: { action: body.approved === true ? "approve" : "revoke" } });
      // BZ-F015/F017: approval state flows into the document lifecycle —
      // and references the EXACT version being approved (QA-08). When the
      // client supplies the text it approved, a mismatch with the document's
      // current version is a stale approval: reject it, never silently
      // apply it to newer content.
      try {
        const acc = await setDocumentAcceptance(
          sql, user.id, id, body.approved === true,
          typeof body.draft === "string" ? body.draft : null,
        );
        if (!acc.ok) {
          setResponseStatus(event, 409);
          return {
            error: "That draft changed since you opened it — review the latest version, then approve.",
            code: acc.code,
            currentVersion: acc.currentVersion,
          };
        }
      } catch (derr) {
        console.error("[buzzy/documents] acceptance sync failed:", derr instanceof Error ? derr.message : derr);
      }
      // BZ-REUSE-159: on Approve, create (idempotently) the shop-floor board
      // + agent + first ticket under the hood. The durable approval audit
      // (job approval + document accepted_version) is the first_ticket_cut
      // gate — ensureExecutionBoard refuses without it.
      if (body.approved === true) {
        try {
          const exec = await ensureExecutionBoard(sql, user.id, id);
          if (exec.ok) {
            executionInfo = { projectId: exec.execution.projectId, created: exec.created };
          }
        } catch (exerr) {
          // Execution linkage is additive — the approval itself already landed.
          console.error("[buzzy/execution] board creation failed:", exerr instanceof Error ? exerr.message : exerr);
        }
      }
    }
    if (hasStatus) {
      await recordJobEvent(sql, id, user.id, "status", String(body.status));
    }
    // ── Company KB derivation (plan doc 23, component #1) ─────────────
    // When a job with a company is approved, its confirmed paper facts
    // (approved-document facts only — never raw chats) become PROPOSED
    // company facts. They stay suggestions until the owner confirms them
    // in the company card — the approval surface stays one-click.
    if (hasApproved && body.approved === true && rows[0].company_id) {
      const cid = rows[0].company_id as string;
      // Customer memory rollup (component #2): rebuilt from approved jobs on
      // every approval — the most recent state always wins.
      try {
        await rebuildCustomerMemory(sql, user.id, cid);
      } catch (merr) {
        console.error("[buzzy] customer memory rebuild failed:", merr instanceof Error ? merr.message : merr);
      }
      const paperFacts = await sql`
        SELECT DISTINCT ON (fact_key) fact_key, label, value
        FROM buzzy_paper_facts
        WHERE user_id = ${user.id} AND company_id = ${cid}
          AND status = 'confirmed' AND value <> ''
        ORDER BY fact_key, updated_at DESC
        LIMIT 12
      `;
      for (const pf of paperFacts) {
        await sql`
          INSERT INTO buzzy_company_facts
            (id, company_id, user_id, fact_key, label, value, status,
             source_label, source_page, original_value)
          VALUES (
            ${"kb_" + pf.fact_key + "_" + id.slice(-8)}, ${cid}, ${user.id},
            ${pf.fact_key}, ${pf.label}, ${pf.value}, 'proposed',
            'from your approved documents', ${id}, ''
          )
          ON CONFLICT (id) DO UPDATE SET
            value = EXCLUDED.value, updated_at = now()
        `;
      }
    }
    return {
      job: { id: rows[0].id, title: rows[0].title, status: rows[0].status },
      ...(executionInfo ? { execution: executionInfo } : {}),
    };
  }

  // ── GET /api/buzzy/documents — durable document library (BZ-F015) ────
  // Drafts, ready-for-review and accepted versions are visibly different
  // states; every row is the materialized output, never a reconstructed echo.
  if (method === "GET" && path === "/api/buzzy/documents") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const jobFilter = queryValue(fullPath, "jobId");
    const statusFilter = queryValue(fullPath, "status");
    const rows = await sql`
      SELECT d.id, d.job_id, d.title, d.type, d.status, d.current_version,
             d.expert, d.created_at, d.updated_at,
             (SELECT content FROM buzzy_document_versions v
               WHERE v.doc_id = d.id AND v.version = d.current_version) AS content
      FROM buzzy_documents d
      WHERE d.user_id = ${user.id}
        AND (${jobFilter}::text IS NULL OR d.job_id = ${jobFilter})
        AND (${statusFilter}::text IS NULL OR d.status = ${statusFilter})
      ORDER BY d.updated_at DESC LIMIT 200
    `;
    return { documents: rows };
  }

  // ── GET /api/buzzy/documents/:id?version=N — one document, chosen version ─
  const docMatch = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)$/);
  if (method === "GET" && docMatch) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const docs = await sql`
      SELECT id, job_id, title, type, status, current_version, accepted_version, expert, created_at, updated_at
      FROM buzzy_documents WHERE id = ${docMatch[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const versionRaw = queryValue(fullPath, "version");
    const version = versionRaw ? Number(versionRaw) : docs[0].current_version;
    // QA-12: the chosen version is returned exactly as stored — exports and
    // renders always match it; unknown versions are a clean 404, never a
    // silent fall-through to the latest.
    const vrows = await sql`
      SELECT version, content, created_at FROM buzzy_document_versions
      WHERE doc_id = ${docMatch[1]} AND version = ${Number.isFinite(version) ? version : -1} LIMIT 1
    `;
    if (!vrows.length) {
      setResponseStatus(event, 404);
      return { error: "That version does not exist", code: "not_found" };
    }
    const versions = await sql`
      SELECT version, parent_version, creator, expert, brief_revision, review,
             accepted_at, accepted_by, created_at
      FROM buzzy_document_versions
      WHERE doc_id = ${docMatch[1]} ORDER BY version DESC
    `;
    await recordTelemetry(sql, { userId: user.id, jobId: String(docs[0].job_id ?? ""), docId: docMatch[1],
      event: "retrieved", props: { version: Number(vrows[0].version), status: String(docs[0].status ?? "") } });

    // ── BZ-F020: exports match the CHOSEN version (QA-12) ──────────────
    // format=pdf|docx|md|csv renders THIS version's canonical text on demand —
    // the export can never drift from the version the owner picked.
    const format = (queryValue(fullPath, "format") ?? "").toLowerCase();
    if (format) {
      await recordTelemetry(sql, { userId: user.id, jobId: String(docs[0].job_id ?? ""), docId: docMatch[1],
        event: "exported", props: { format, version: Number(vrows[0].version) } });
      const title = String(docs[0].title ?? "document");
      const text = String(vrows[0].content ?? "");
      const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";
      const versionTag = `-v${vrows[0].version}`;
      if (format === "md") {
        return new Response(text, {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${base}${versionTag}.md"` },
        });
      }
      if (format === "pdf") {
        const bytes = renderTextPdf(title, text);
        return new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${base}${versionTag}.pdf"` },
        });
      }
      if (format === "docx") {
        // Map canonical text to the typed renderer: markdown-ish headings are
        // sections, everything else is paragraphs. Unsupported shapes are a
        // useful error, never a silent empty file (QA-11).
        const sections: Array<{ heading: string; paragraphs: string[] }> = [];
        let current: { heading: string; paragraphs: string[] } = { heading: title, paragraphs: [] };
        for (const raw of text.split("\n")) {
          const h = raw.match(/^#{1,3}\s+(.*)$/);
          if (h) {
            if (current.paragraphs.length || sections.length === 0) sections.push(current);
            current = { heading: h[1].slice(0, 120), paragraphs: [] };
          } else if (raw.trim()) {
            current.paragraphs.push(raw.trim().slice(0, 2000));
          }
        }
        sections.push(current);
        const shaped = sections.filter((s) => s.paragraphs.length).slice(0, 25);
        if (!shaped.length) {
          setResponseStatus(event, 422);
          return { error: "That version has no readable text to put in a Word file — download the Markdown instead.", code: "empty_document" };
        }
        const rendered = await renderDocument({ title, sections: shaped });
        if (!rendered.ok || !rendered.bytes) {
          setResponseStatus(event, 422);
          return { error: rendered.error ?? "The Word render failed — the Markdown download still works.", code: "render_failed" };
        }
        return new Response(rendered.bytes as unknown as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": rendered.contentType ?? "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": `attachment; filename="${rendered.filename?.replace(/\.docx$/, "") ?? base}${versionTag}.docx"`,
          },
        });
      }
      if (format === "csv") {
        // Tabular text: |-delimited rows, skipping the markdown separator row.
        const lines = text.split("\n").filter((l) => l.includes("|") && /[a-z0-9]/i.test(l.replace(/[|\-\s:]/g, "")));
        if (!lines.length) {
          setResponseStatus(event, 422);
          return { error: "That version has no table to export — CSV only works for tabular content. This is a value export: formulas are evaluated to their shown values.", code: "no_table" };
        }
        const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
        const csv = lines
          .map((l) => l.split("|").slice(1, -1).map((c) => q(c.trim())).join(","))
          .join("\n") + "\n";
        return new Response(csv, {
          status: 200,
          headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${base}${versionTag}.csv"` },
        });
      }
      setResponseStatus(event, 400);
      return { error: `Unknown format "${format.slice(0, 16)}". Try pdf, docx, md, or csv.`, code: "bad_format", supported: ["pdf", "docx", "md", "csv"] };
    }

    return { document: { ...docs[0], content: vrows[0].content, version: vrows[0].version }, versions };
  }

  // ── POST /api/buzzy/documents/:id/edit — owner manual edit (BZ-F016) ──
  // A manual edit materializes a NEW immutable version with manual-edit
  // provenance; an accepted document re-opens for review (QA-20), and the
  // earlier version is kept untouched (QA-12).
  const docEdit = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)\/edit$/);
  if (method === "POST" && docEdit) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const content = typeof body.content === "string" ? body.content.slice(0, 80000) : "";
    if (!content.trim()) {
      setResponseStatus(event, 400);
      return { error: "Type the document text.", code: "bad_request" };
    }
    const sql = await getSql();
    const docs = await sql<{ job_id: string | null; title: string }>`
      SELECT job_id, title FROM buzzy_documents WHERE id = ${docEdit[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const result = await materializeDraft(sql, user.id, docs[0].job_id ?? docEdit[1], docs[0].title, content, {
      creator: user.id,
      expert: "manual edit",
    });
    return {
      ok: true,
      version: result.version,
      changed: result.changed,
      note: result.changed
        ? `Saved as version ${result.version}. The earlier version is kept, and this document is waiting for your review again.`
        : "That matches the current version exactly — nothing new to save.",
    };
  }

  // ── GET /api/buzzy/documents/:id/diff?from=N&to=M — changed-section summary ─
  const docDiff = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)\/diff$/);
  if (method === "GET" && docDiff) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const owned = await sql`SELECT id, current_version FROM buzzy_documents WHERE id = ${docDiff[1]} AND user_id = ${user.id} LIMIT 1`;
    if (!owned.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const to = Number(queryValue(fullPath, "to") ?? owned[0].current_version);
    const from = Number(queryValue(fullPath, "from") ?? (to - 1));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < 1 || from >= to) {
      setResponseStatus(event, 400);
      return { error: "Pick two versions to compare, like ?from=1&to=2.", code: "bad_request" };
    }
    const vrows = await sql`
      SELECT version, content FROM buzzy_document_versions
      WHERE doc_id = ${docDiff[1]} AND version IN (${from}, ${to})
    `;
    const va = vrows.find((v) => v.version === from);
    const vb = vrows.find((v) => v.version === to);
    if (!va || !vb) {
      setResponseStatus(event, 404);
      return { error: "One of those versions does not exist.", code: "not_found" };
    }
    return { diff: summarizeChanges(String(va.content), String(vb.content), from, to) };
  }

  // ── GET /api/buzzy/documents/:id/pack — "Take the work" bundle (BZ-F021) ─
  // The accepted document + brief/decision summary + provenance + open
  // caveats, assembled owner-side. Sending it externally is a DIFFERENT,
  // separately approved action — this route only packs, never sends.
  const docPack = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)\/pack$/);
  if (method === "GET" && docPack) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const docs = await sql`
      SELECT id, job_id, title, status, current_version, accepted_version, created_at, updated_at
      FROM buzzy_documents WHERE id = ${docPack[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const doc = docs[0];
    const version = doc.accepted_version ?? doc.current_version;
    const vrows = await sql`
      SELECT version, content, brief_revision, review, accepted_at, accepted_by
      FROM buzzy_document_versions WHERE doc_id = ${doc.id} AND version = ${version} LIMIT 1
    `;
    const v = vrows[0];
    if (!v) {
      setResponseStatus(event, 404);
      return { error: "No readable version on this document.", code: "not_found" };
    }
    const brief = typeof v.brief_revision === "string" ? safeParseJson(v.brief_revision) : (v.brief_revision ?? {});
    const review = Array.isArray(v.review) ? v.review : (typeof v.review === "string" ? (() => { try { return JSON.parse(v.review); } catch { return []; } })() : []);
    return {
      pack: {
        title: doc.title,
        status: doc.status,
        version,
        accepted: doc.status === "accepted" && doc.accepted_version === version,
        content: v.content,
        brief,
        evidence: {
          acceptedAt: v.accepted_at ?? null,
          reviewChecks: (review as Array<{ label?: string; verdict?: string }>).map((c) => ({ label: c.label ?? "", verdict: c.verdict ?? "" })),
        },
        caveats: doc.status === "accepted"
          ? []
          : ["This version is not accepted yet — it is a working draft, not a final document."],
        note: "Packed for you to take. Emailing or sending it to anyone is a separate step you'll be asked about first.",
      },
    };
  }

  // ── POST /api/buzzy/documents/:id/share — explicit, pinned, expiring ──────
  const docShare = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)\/share$/);
  if (method === "POST" && docShare) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* defaults */ }
    const ttlHours = Math.min(Math.max(Number(body.ttlHours) || 72, 1), 24 * 30);
    const sql = await getSql();
    const docs = await sql`
      SELECT id, status, current_version, accepted_version FROM buzzy_documents
      WHERE id = ${docShare[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const doc = docs[0];
    const version = typeof body.version === "number" ? body.version : (doc.accepted_version ?? doc.current_version);
    // Scoped to REVIEWED versions: you can only share the exact accepted
    // version — never a working draft (QA-16 exact approved version).
    if (doc.status !== "accepted" || version !== doc.accepted_version) {
      setResponseStatus(event, 409);
      return {
        error: "Only the accepted version can be shared. Review and accept it first — sharing a draft is exactly what this gate prevents.",
        code: "not_accepted_version",
        acceptedVersion: doc.accepted_version,
      };
    }
    // Retry idempotent (QA-16): an active link for the same doc+version is
    // returned, never duplicated.
    const active = await sql`
      SELECT id, token, expires_at FROM buzzy_share_links
      WHERE user_id = ${user.id} AND doc_id = ${doc.id} AND version = ${version}
        AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1
    `;
    if (active.length) {
      return { ok: true, created: false, share: { id: active[0].id, token: active[0].token, expiresAt: active[0].expires_at, url: `/api/buzzy/shared/${active[0].token}` } };
    }
    const token = "sh_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const id = "shl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await sql`
      INSERT INTO buzzy_share_links (id, user_id, doc_id, version, token, expires_at)
      VALUES (${id}, ${user.id}, ${doc.id}, ${version}, ${token}, now() + (${ttlHours}::text || ' hours')::interval)
    `;
    setResponseStatus(event, 201);
    return { ok: true, created: true, share: { id, token, expiresAt: null, url: `/api/buzzy/shared/${token}` } };
  }

  // ── GET /api/buzzy/shares — the recorded links on this account ──────────
  if (method === "GET" && path === "/api/buzzy/shares") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT s.id, s.doc_id, s.version, s.expires_at, s.revoked_at, s.created_at, d.title
      FROM buzzy_share_links s JOIN buzzy_documents d ON d.id = s.doc_id
      WHERE s.user_id = ${user.id}
      ORDER BY s.created_at DESC LIMIT 100
    `;
    return { shares: rows };
  }

  // ── DELETE /api/buzzy/shares/:id — revoke (turn the link off) ──────────
  if (method === "DELETE" && path.startsWith("/api/buzzy/shares/")) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      UPDATE buzzy_share_links SET revoked_at = now()
      WHERE id = ${path.slice("/api/buzzy/shares/".length)} AND user_id = ${user.id} AND revoked_at IS NULL
      RETURNING id
    `;
    return { ok: true, revoked: rows.length > 0 };
  }

  // ── POST /api/buzzy/documents/:id/save-as-template — reuse structure (BZ-F018) ─
  // From an ACCEPTED document: save its structure (headings + paragraph
  // shapes) as a reusable template with project/private values replaced by
  // clear variables (QA-14 — a template never smuggles a prior client's
  // facts into the next job). `exclude` terms the owner names are stripped
  // to variables too ("what must not be reused").
  const docTemplate = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)\/save-as-template$/);
  if (method === "POST" && docTemplate) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* defaults */ }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "Reusable structure";
    const exclude = Array.isArray(body.exclude)
      ? body.exclude.filter((x): x is string => typeof x === "string" && x.trim().length > 1).slice(0, 20)
      : [];
    const sql = await getSql();
    const docs = await sql`
      SELECT id, job_id, status, accepted_version, current_version FROM buzzy_documents
      WHERE id = ${docTemplate[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const doc = docs[0];
    // Templates come from ACCEPTED outputs only — same bar as sharing.
    if (doc.status !== "accepted" || doc.accepted_version == null) {
      setResponseStatus(event, 409);
      return { error: "Only an accepted document can become a template — accept the final version first.", code: "not_accepted" };
    }
    const vrows = await sql`
      SELECT content, brief_revision FROM buzzy_document_versions
      WHERE doc_id = ${doc.id} AND version = ${doc.accepted_version} LIMIT 1
    `;
    if (!vrows.length) {
      setResponseStatus(event, 404);
      return { error: "The accepted version is missing.", code: "not_found" };
    }
    const brief = typeof vrows[0].brief_revision === "string"
      ? safeParseJson(vrows[0].brief_revision)
      : (vrows[0].brief_revision ?? {});
    let templateBody = String(vrows[0].content ?? "");
    const variables: string[] = [];
    // Replace each brief value (project/private specifics) with a variable.
    for (const [key, value] of Object.entries(brief as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 2 && value !== "skipped") {
        const needle = value.trim();
        if (templateBody.includes(needle)) {
          templateBody = templateBody.split(needle).join(`{{${key}}}`);
          variables.push(key);
        }
      }
    }
    // Replace owner-named never-reuse terms.
    exclude.forEach((term, i) => {
      const t = term.trim();
      if (templateBody.toLowerCase().includes(t.toLowerCase())) {
        const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        templateBody = templateBody.replace(re, `{{detail_${i + 1}}}`);
        variables.push(`detail_${i + 1}`);
      }
    });
    const id = "tpl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10) + Date.now().toString(36);
    await sql`
      INSERT INTO buzzy_templates (id, user_id, company_id, name, kind, structure)
      VALUES (${id}, ${user.id}, NULL, ${name}, 'document',
              ${JSON.stringify({ sourceDocId: doc.id, sourceVersion: doc.accepted_version, body: templateBody, variables })}::jsonb)
    `;
    setResponseStatus(event, 201);
    return {
      ok: true,
      template: { id, name, variables, sourceVersion: doc.accepted_version },
      note: variables.length
        ? "Structure saved with the project-specific parts as blanks — none of this job's private details ride along."
        : "Structure saved. No project-specific values were found to blank out — check it once before reusing.",
    };
  }

  // ── GET /api/buzzy/documents/:id/check-sheet — compact acceptance sheet ──
  // What was produced · what was checked · what remains uncertain · how to use
  // the files. Deterministic; the human decides from this, not from vibes.
  const docSheet = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)\/check-sheet$/);
  if (method === "GET" && docSheet) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const docs = await sql`
      SELECT id, job_id, title, status, current_version, accepted_version, expert
      FROM buzzy_documents WHERE id = ${docSheet[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const doc = docs[0];
    const version = doc.accepted_version ?? doc.current_version;
    const vrows = await sql`
      SELECT version, content, brief_revision, review, accepted_at FROM buzzy_document_versions
      WHERE doc_id = ${doc.id} AND version = ${version} LIMIT 1
    `;
    const decisions = await sql`
      SELECT version, action, role, note, created_at FROM buzzy_document_decisions
      WHERE doc_id = ${doc.id} AND user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 10
    `;
    const review = (() => {
      const raw = vrows[0]?.review;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return []; } }
      return [];
    })() as Array<{ label?: string; verdict?: string; detail?: string }>;
    return {
      sheet: {
        produced: { title: doc.title, version, status: doc.status, expert: doc.expert ?? null },
        checked: review.map((c) => ({ label: c.label ?? "", verdict: c.verdict ?? "" })),
        uncertain: review.filter((c) => c.verdict === "warning").map((c) => ({ label: c.label ?? "", detail: c.detail ?? "" })),
        files: {
          markdown: `/api/buzzy/documents/${doc.id}?version=${version}&format=md`,
          pdf: `/api/buzzy/documents/${doc.id}?version=${version}&format=pdf`,
          docx: `/api/buzzy/documents/${doc.id}?version=${version}&format=docx`,
          csv: `/api/buzzy/documents/${doc.id}?version=${version}&format=csv`,
        },
        decisions,
      },
    };
  }

  // ── POST /api/buzzy/documents/:id/decision — Accept / Request changes / Keep draft ─
  // Internal and customer acceptance are DISTINCT records (role). Requesting
  // changes creates a BOUNDED correction note tied to this exact version —
  // one revision request, not a fresh unlimited job.
  const docDecision = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)\/decision$/);
  if (method === "POST" && docDecision) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const action = body.action;
    if (action !== "accept" && action !== "request_changes" && action !== "keep_draft") {
      setResponseStatus(event, 400);
      return { error: "Choose Accept, Request changes, or Keep as a draft.", code: "bad_action" };
    }
    const role = body.role === "customer" ? "customer" : "internal";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
    if (action === "request_changes" && !note) {
      setResponseStatus(event, 400);
      return { error: "Tell me what to change — a correction needs a specific ask.", code: "note_required" };
    }
    const sql = await getSql();
    // BZ-F034: a teammate acts on the OWNER's account through membership, and
    // the action itself is authorized by role or an explicit delegation (with
    // its cap) — scope is never granted by being signed in.
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null);
    const needAction = action === "accept" ? "accept_document" : action === "request_changes" ? "request_changes" : "read";
    const docs = await sql`
      SELECT id, job_id, title, status, current_version, accepted_version
      FROM buzzy_documents WHERE id = ${docDecision[1]} AND user_id = ${acting.accountId} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const doc = docs[0];
    if (needAction !== "read") {
      // The space comes from the owning job, not the document row.
      const spaceRows = doc.job_id
        ? await sql<{ company_id: string | null }>`
            SELECT company_id FROM buzzy_jobs WHERE id = ${String(doc.job_id)} AND user_id = ${acting.accountId} LIMIT 1
          `
        : [];
      const decision = await authorize(sql as never, acting, needAction as never,
        { companyId: spaceRows[0]?.company_id ?? null });
      if (!decision.allowed) {
        setResponseStatus(event, 403);
        return { error: decision.reason, code: "role_denied", role: acting.role, via: decision.via };
      }
    }
    const version = typeof body.version === "number" ? body.version : (doc.accepted_version ?? doc.current_version);
    // Decisions bind to a version that must exist (and, to accept, the current
    // one — a stale accept is refused, never silently applied).
    const vrows = await sql`
      SELECT content FROM buzzy_document_versions WHERE doc_id = ${doc.id} AND version = ${version} LIMIT 1
    `;
    if (!vrows.length) {
      setResponseStatus(event, 404);
      return { error: "That version does not exist.", code: "not_found" };
    }
    if (action === "accept" && version !== doc.current_version) {
      setResponseStatus(event, 409);
      return {
        error: "That version is not the latest — review the current one before accepting.",
        code: "stale_version",
        currentVersion: doc.current_version,
      };
    }
    await sql`
      INSERT INTO buzzy_document_decisions (doc_id, user_id, version, action, role, note)
      VALUES (${doc.id}, ${acting.accountId}, ${version}, ${action}, ${role}, ${note})
    `;
    await recordTelemetry(sql, { userId: user.id, jobId: String(doc.job_id ?? doc.id), docId: String(doc.id),
      event: action === "accept" ? "human_accepted" : action === "request_changes" ? "reopened" : "needs_you_answered",
      props: { action, role, version } });
    if (action === "accept" && role === "internal") {
      // Internal acceptance moves the document lifecycle (customer acceptance
      // is a distinct record and never flips the internal state by itself).
      try {
        await setDocumentAcceptance(sql, user.id, String(doc.job_id ?? doc.id), true,
          typeof body.draft === "string" ? body.draft : null);
      } catch (derr) {
        console.error("[buzzy/documents] acceptance sync failed:", derr instanceof Error ? derr.message : derr);
      }
    }
    if (action === "request_changes") {
      await recordJobEvent(sql, String(doc.job_id ?? doc.id), user.id, "correction_requested",
        JSON.stringify({ version, bound: "one revision", note: note.slice(0, 200) }));
    }
    return {
      ok: true,
      decision: { version, action, role },
      note: action === "request_changes"
        ? `Noted — one bounded correction on version ${version}: "${note.slice(0, 120)}". Revise and re-review; this stays tied to that version.`
        : action === "accept"
          ? `Accepted version ${version}${role === "customer" ? " (customer acceptance)" : ""}. Earlier versions stay intact.`
          : "Kept as a draft — nothing is treated as final.",
    };
  }

  // ── Starters (BZ-F028): three outcome-first journeys ──────────────────
  if (method === "GET" && path === "/api/buzzy/starters") {
    return { starters: STARTERS };
  }
  const starterStart = path.match(/^\/api\/buzzy\/starters\/([a-z-]{3,40})\/start$/);
  if (method === "POST" && starterStart) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const starter = getStarter(starterStart[1]);
    if (!starter) {
      setResponseStatus(event, 404);
      return { error: "That starter doesn't exist.", code: "not_found" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* defaults */ }
    const companyId = typeof body.companyId === "string" && isCompanyId(body.companyId) ? body.companyId : null;
    const sql = await getSql();
    if (companyId) {
      const owned = await sql`SELECT id FROM buzzy_companies WHERE id = ${companyId} AND user_id = ${user.id}`;
      if (!owned.length) {
        setResponseStatus(event, 400);
        return { error: "That company isn't on your account.", code: "bad_company" };
      }
    }
    const jobId = `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
    await sql`
      INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
      VALUES (${jobId}, ${user.id}, ${starter.playbook}, ${starter.name}, 'Discovering', ${companyId},
              ${JSON.stringify({ starter: starter.id, outcome: starter.outcome, boundary: starter.boundary })}::jsonb, now())
    `;
    await recordTelemetry(sql, { userId: user.id, jobId, event: "project_started",
      props: { starter: starter.id, playbook: starter.playbook } });
    setResponseStatus(event, 201);
    return {
      ok: true,
      job: { id: jobId, title: starter.name, status: "Discovering", starter: starter.id },
      firstQuestion: starter.firstQuestion,
      boundary: starter.boundary,
    };
  }

  // ── POST /api/buzzy/jobs/:id/repeat — clone structure, ask fresh inputs ──
  // BZ-F029: repeating a job copies the playbook/template and permitted
  // reusable structure — NEVER the old approval, draft or document. The new
  // job starts in Discovering and explicitly asks for a fresh time period,
  // party details and changed goals.
  const jobRepeat = path.match(/^\/api\/buzzy\/jobs\/([A-Za-z0-9_-]{3,120})\/repeat$/);
  if (method === "POST" && jobRepeat) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql<{ id: string; template: string | null; title: string | null; company_id: string | null; data: unknown }>`
      SELECT id, template, title, company_id, data FROM buzzy_jobs
      WHERE id = ${jobRepeat[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!rows.length) {
      setResponseStatus(event, 404);
      return { error: "Job not found", code: "not_found" };
    }
    const src = rows[0];
    const srcData = typeof src.data === "string" ? safeParseJson(src.data) : (src.data ?? {});
    const starterId = typeof (srcData as Record<string, unknown>).starter === "string"
      ? String((srcData as Record<string, unknown>).starter) : null;
    const starter = starterId ? getStarter(starterId) : undefined;
    const newId = `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const title = `${(src.title ?? "Job").slice(0, 60)} (repeat)`;
    await sql`
      INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
      VALUES (${newId}, ${user.id}, ${src.template}, ${title}, 'Discovering', ${src.company_id},
              ${JSON.stringify({
                repeatedFrom: src.id,
                starter: starterId,
                outcome: starter?.outcome ?? null,
                freshInputsRequired: [
                  "the new time period",
                  "party-specific details (who/what this run is for)",
                  "any changed goals or scope",
                ],
                approved: false,
              })}::jsonb, now())
    `;
    setResponseStatus(event, 201);
    return {
      ok: true,
      job: { id: newId, title, status: "Discovering", repeatedFrom: src.id },
      firstQuestion: "Same kind of job as before — what time period is this for, who is it for, and what's changed?",
      note: "The structure came across. The old approval, draft and files did not — this run needs your fresh answers and a new approval.",
    };
  }

  // ── Team (BZ-F041): invitations, membership, scoped access ────────────
  // Members are real signed-in accounts. The owner's data stays keyed by the
  // owner's id; a member request resolves to it THROUGH membership. Every
  // owner-only action is gated by canPerform(), not by prose.
  if (path === "/api/buzzy/team" && method !== "POST") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null,
      queryValue(fullPath, "owner"));
    const own = await sql`
      SELECT id, email, role, status, invited_at, accepted_at
      FROM buzzy_team_members WHERE owner_user_id = ${user.id}
      ORDER BY invited_at DESC
    `;
    const belonging = await sql`
      SELECT m.id, m.owner_user_id, m.role, m.status, m.accepted_at
      FROM buzzy_team_members m WHERE m.member_user_id = ${user.id} AND m.status = 'active'
    `;
    return {
      ok: true,
      acting: { accountId: acting.accountId, role: acting.role, isOwner: acting.role === "owner" },
      members: own,
      memberOf: belonging,
      roles: {
        owner: Array.from(new Set([...TEAM_ACTIONS])),
        admin: TEAM_ACTIONS.filter((a) => canPerform("admin", a)),
        member: TEAM_ACTIONS.filter((a) => canPerform("member", a)),
        reviewer: TEAM_ACTIONS.filter((a) => canPerform("reviewer", a)),
      },
      note: "Each teammate signs in with their own email. Nobody shares a magic link.",
    };
  }

  if (method === "POST" && path === "/api/buzzy/team/invite") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null);
    const deny = guard("manage_team", acting);
    if (deny) {
      setResponseStatus(event, 403);
      return { error: deny, code: "role_denied", role: acting.role };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setResponseStatus(event, 400);
      return { error: "Give me one email address to invite.", code: "bad_email" };
    }
    const role: MemberRole = body.role === "admin" || body.role === "reviewer" ? body.role : "member";
    if (email === (user.email ?? "").toLowerCase()) {
      setResponseStatus(event, 400);
      return { error: "That's your own address — you're already the owner.", code: "bad_email" };
    }
    const existing = await sql`
      SELECT id, status FROM buzzy_team_members
      WHERE owner_user_id = ${acting.accountId} AND email = ${email} LIMIT 1
    `;
    const memberId = existing.length ? String(existing[0].id) : `tm_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (existing.length) {
      await sql`
        UPDATE buzzy_team_members SET role = ${role}, status = 'invited',
          invited_at = now(), accepted_at = NULL, member_user_id = NULL
        WHERE id = ${memberId} AND owner_user_id = ${acting.accountId}
      `;
    } else {
      await sql`
        INSERT INTO buzzy_team_members (id, owner_user_id, email, role, status)
        VALUES (${memberId}, ${acting.accountId}, ${email}, ${role}, 'invited')
      `;
    }
    const token = crypto.randomUUID().replace(/-/g, "");
    await sql`
      INSERT INTO buzzy_team_invites (token, member_id, expires_at)
      VALUES (${token}, ${memberId}, now() + interval '7 days')
    `;
    await recordTelemetry(sql, { userId: acting.accountId, event: "project_started",
      props: { kind: "team_invite", role } });
    setResponseStatus(event, 201);
    return {
      ok: true,
      member: { id: memberId, email, role, status: "invited" },
      // No mail channel is wired on this deployment — hand back the link and
      // say so, instead of claiming an email went out.
      inviteUrl: `/buzzy/team/join?token=${token}`,
      note: "Invitation created. No email was sent (this deployment has no delivery channel) — send this link to them yourself. It expires in 7 days.",
      expiresInDays: 7,
    };
  }

  if (method === "POST" && path === "/api/buzzy/team/accept") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const token = typeof body.token === "string" ? body.token.trim().slice(0, 80) : "";
    if (!token) {
      setResponseStatus(event, 400);
      return { error: "That invitation link is missing its token.", code: "bad_token" };
    }
    const sql = await getSql();
    const invites = await sql`
      SELECT i.token, i.member_id, i.expires_at, i.used_at, m.owner_user_id, m.email, m.role, m.status
      FROM buzzy_team_invites i JOIN buzzy_team_members m ON m.id = i.member_id
      WHERE i.token = ${token} LIMIT 1
    `;
    if (!invites.length) {
      setResponseStatus(event, 404);
      return { error: "That invitation doesn't exist.", code: "not_found" };
    }
    const inv = invites[0];
    if (inv.used_at) {
      setResponseStatus(event, 409);
      return { error: "That invitation was already used.", code: "already_used" };
    }
    if (new Date(String(inv.expires_at)).getTime() < Date.now()) {
      setResponseStatus(event, 409);
      return { error: "That invitation has expired — ask for a new one.", code: "expired" };
    }
    if (String(inv.email).toLowerCase() !== (user.email ?? "").toLowerCase()) {
      setResponseStatus(event, 403);
      return {
        error: `This invitation is for ${inv.email}. Sign in with that address to accept it.`,
        code: "wrong_account",
      };
    }
    if (String(inv.owner_user_id) === user.id) {
      setResponseStatus(event, 409);
      return { error: "You already own this account.", code: "already_owner" };
    }
    await sql`
      UPDATE buzzy_team_members SET member_user_id = ${user.id}, status = 'active', accepted_at = now()
      WHERE id = ${inv.member_id}
    `;
    await sql`UPDATE buzzy_team_invites SET used_at = now() WHERE token = ${token}`;
    return {
      ok: true,
      joined: { accountId: String(inv.owner_user_id), role: String(inv.role) },
      note: `You joined as ${inv.role}. You'll work inside that account with your own sign-in.`,
    };
  }

  const teamMember = path.match(/^\/api\/buzzy\/team\/(tm_[A-Za-z0-9]{8,32})$/);
  if (method === "DELETE" && teamMember) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null);
    const deny = guard("manage_team", acting);
    if (deny) {
      setResponseStatus(event, 403);
      return { error: deny, code: "role_denied", role: acting.role };
    }
    const rows = await sql`
      UPDATE buzzy_team_members SET status = 'revoked', member_user_id = NULL
      WHERE id = ${teamMember[1]} AND owner_user_id = ${acting.accountId}
      RETURNING id, email, role
    `;
    if (!rows.length) {
      setResponseStatus(event, 404);
      return { error: "That teammate isn't on your account.", code: "not_found" };
    }
    await sql`DELETE FROM buzzy_team_invites WHERE member_id = ${teamMember[1]}`;
    return { ok: true, revoked: rows[0], note: "Access removed. Their own account and their own work are untouched." };
  }

  // Proof that scoping works: what this sign-in can see, and why.
  if (method === "GET" && path === "/api/buzzy/team/scope") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null,
      queryValue(fullPath, "owner"));
    const jobs = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM buzzy_jobs WHERE user_id = ${acting.accountId}
    `;
    const docs = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM buzzy_documents WHERE user_id = ${acting.accountId}
    `;
    return {
      ok: true,
      acting: { accountId: acting.accountId, role: acting.role, membershipId: acting.membershipId },
      visible: { jobs: Number(jobs[0]?.n ?? 0), documents: Number(docs[0]?.n ?? 0) },
      can: TEAM_ACTIONS.filter((a) => canPerform(acting.role, a)),
      cannot: TEAM_ACTIONS.filter((a) => !canPerform(acting.role, a)).map((a) => ({
        action: a, reason: denialReason(acting.role, a),
      })),
    };
  }

  // ── Delegations (BZ-F034): grant one action, in one space, under a cap ──
  const delegationCreate = path.match(/^\/api\/buzzy\/team\/(tm_[A-Za-z0-9]{8,32})\/delegations$/);
  if (method === "POST" && delegationCreate) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null);
    const deny = guard("manage_team", acting);
    if (deny) {
      setResponseStatus(event, 403);
      return { error: deny, code: "role_denied", role: acting.role };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const action = typeof body.action === "string" && (DELEGATABLE as readonly string[]).includes(body.action)
      ? body.action : "";
    if (!action) {
      setResponseStatus(event, 400);
      return { error: `Choose one of: ${DELEGATABLE.join(", ")}.`, code: "bad_action" };
    }
    const member = await sql`
      SELECT id, email, role, status FROM buzzy_team_members
      WHERE id = ${delegationCreate[1]} AND owner_user_id = ${acting.accountId} LIMIT 1
    `;
    if (!member.length) {
      setResponseStatus(event, 404);
      return { error: "That teammate isn't on your account.", code: "not_found" };
    }
    if (String(member[0].status) !== "active") {
      setResponseStatus(event, 409);
      return { error: "That teammate hasn't accepted the invitation yet.", code: "not_active" };
    }
    const scopeCompanyId = typeof body.companyId === "string" && isCompanyId(body.companyId) ? body.companyId : null;
    if (scopeCompanyId) {
      const owned = await sql`SELECT id FROM buzzy_companies WHERE id = ${scopeCompanyId} AND user_id = ${acting.accountId}`;
      if (!owned.length) {
        setResponseStatus(event, 400);
        return { error: "That business space isn't on your account.", code: "bad_company" };
      }
    }
    const maxAmount = Number.isFinite(Number(body.maxAmountCents)) ? Math.max(0, Math.floor(Number(body.maxAmountCents))) : null;
    const days = Number.isFinite(Number(body.expiresInDays)) ? Math.min(365, Math.max(1, Math.floor(Number(body.expiresInDays)))) : null;
    const id = `dl_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await sql`
      INSERT INTO buzzy_delegations (id, member_id, owner_user_id, action, scope_company_id, max_amount_cents, expires_at)
      VALUES (${id}, ${delegationCreate[1]}, ${acting.accountId}, ${action}, ${scopeCompanyId}, ${maxAmount},
              ${days ? new Date(Date.now() + days * 86400000).toISOString() : null})
    `;
    setResponseStatus(event, 201);
    return {
      ok: true,
      delegation: { id, action, scopeCompanyId, maxAmountCents: maxAmount, expiresInDays: days },
      note: `Delegated ${action.replace(/_/g, " ")}${scopeCompanyId ? " in that business space" : " across the account"}${maxAmount != null ? `, capped at ${(maxAmount / 100).toFixed(2)}` : ""}. It applies only to that action — nothing else is implied.`,
    };
  }

  const delegationList = path.match(/^\/api\/buzzy\/team\/(tm_[A-Za-z0-9]{8,32})\/delegations$/);
  if (method === "GET" && delegationList) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null);
    const member = await sql`
      SELECT id FROM buzzy_team_members WHERE id = ${delegationList[1]} AND owner_user_id = ${acting.accountId} LIMIT 1
    `;
    if (!member.length) {
      setResponseStatus(event, 404);
      return { error: "That teammate isn't on your account.", code: "not_found" };
    }
    const rows = await sql`
      SELECT id, action, scope_company_id, max_amount_cents, expires_at, revoked_at, created_at
      FROM buzzy_delegations WHERE member_id = ${delegationList[1]}
      ORDER BY created_at DESC
    `;
    return { ok: true, delegations: rows, delegatable: DELEGATABLE };
  }

  const delegationDelete = path.match(/^\/api\/buzzy\/team\/delegations\/(dl_[A-Za-z0-9]{8,32})$/);
  if (method === "DELETE" && delegationDelete) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null);
    const deny = guard("manage_team", acting);
    if (deny) {
      setResponseStatus(event, 403);
      return { error: deny, code: "role_denied", role: acting.role };
    }
    const rows = await sql`
      UPDATE buzzy_delegations SET revoked_at = now()
      WHERE id = ${delegationDelete[1]} AND owner_user_id = ${acting.accountId} AND revoked_at IS NULL
      RETURNING id, action
    `;
    if (!rows.length) {
      setResponseStatus(event, 404);
      return { error: "That delegation isn't active on your account.", code: "not_found" };
    }
    return { ok: true, revoked: rows[0], note: "Delegation revoked — that action needs the owner or an admin again." };
  }

  // ── Recipes (BZ-J04…J11): configured business playbooks ───────────────
  // A recipe is discoverable, startable, and its boundary is checkable BEFORE
  // anything is accepted or sent. Boundaries are enforced in code, not prose.
  if (method === "GET" && path === "/api/buzzy/recipes") {
    return {
      universalStatements: UNIVERSAL_STATEMENTS,
      recipes: RECIPES.map((r) => ({
        id: r.id, name: r.name, outcome: r.outcome, playbook: r.playbook,
        discovery: r.discovery, checklist: r.checklist,
        permittedSources: r.permittedSources, tools: r.tools,
        outputContract: r.outputContract, domainChecks: r.domainChecks,
        boundary: r.boundary, firstQuestion: r.firstQuestion,
        configured: validateRecipe(r).length === 0,
      })),
    };
  }

  const recipeStart = path.match(/^\/api\/buzzy\/recipes\/([a-z0-9-]{3,48})\/start$/);
  if (method === "POST" && recipeStart) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const recipe = getRecipe(recipeStart[1]);
    if (!recipe) {
      setResponseStatus(event, 404);
      return { error: "That recipe doesn't exist.", code: "not_found" };
    }
    const problems = validateRecipe(recipe);
    if (problems.length) {
      setResponseStatus(event, 400);
      return { error: "This recipe is not fully configured.", code: "recipe_incomplete", problems };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* defaults */ }
    const companyId = typeof body.companyId === "string" && isCompanyId(body.companyId) ? body.companyId : null;
    const sql = await getSql();
    if (companyId) {
      const owned = await sql`SELECT id FROM buzzy_companies WHERE id = ${companyId} AND user_id = ${user.id}`;
      if (!owned.length) {
        setResponseStatus(event, 400);
        return { error: "That company isn't on your account.", code: "bad_company" };
      }
    }
    const jobId = `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
    await sql`
      INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
      VALUES (${jobId}, ${user.id}, ${recipe.playbook}, ${recipe.name}, 'Discovering', ${companyId},
              ${JSON.stringify({
                recipe: recipe.id, outcome: recipe.outcome, boundary: recipe.boundary,
                outputContract: recipe.outputContract,
              })}::jsonb, now())
    `;
    await recordTelemetry(sql, { userId: user.id, jobId, event: "project_started",
      props: { starter: recipe.id, playbook: recipe.playbook } });
    setResponseStatus(event, 201);
    return {
      ok: true,
      job: { id: jobId, title: recipe.name, status: "Discovering", recipe: recipe.id, template: recipe.playbook },
      firstQuestion: recipe.firstQuestion,
      checklist: recipe.checklist,
      outputContract: recipe.outputContract,
      boundary: recipe.boundary,
    };
  }

  // Boundary pre-check: does a draft cross this recipe's line?
  const recipeCheck = path.match(/^\/api\/buzzy\/recipes\/([a-z0-9-]{3,48})\/boundary-check$/);
  if (method === "POST" && recipeCheck) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const recipe = getRecipe(recipeCheck[1]);
    if (!recipe) {
      setResponseStatus(event, 404);
      return { error: "That recipe doesn't exist.", code: "not_found" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const draft = typeof body.draft === "string" ? body.draft : "";
    if (!draft.trim()) {
      setResponseStatus(event, 400);
      return { error: "Give me the draft text to check.", code: "bad_request" };
    }
    const hits = boundaryViolations(recipe, draft);
    return {
      ok: true,
      recipe: recipe.id,
      blocked: hits.length > 0,
      violations: hits,
      boundary: recipe.boundary,
      note: hits.length
        ? `This crosses the recipe's line: ${recipe.boundary} Fix those before it can be accepted.`
        : `Within the recipe's boundary: ${recipe.boundary}`,
    };
  }

  // ── Telemetry (BZ-F039): success summary + plain disclosure ───────────
  // The business signal is accepted, retrievable, useful outputs — not chat
  // counts. Infrastructure uptime is deliberately absent here.
  if (method === "GET" && path === "/api/buzzy/telemetry") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const daysRaw = Number(queryValue(fullPath, "days"));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? Math.floor(daysRaw) : 30;
    return {
      ok: true,
      success: await successSummary(sql as never, user.id, days),
      disclosure: TELEMETRY_DISCLOSURE,
      note: "Success means accepted, retrievable, useful outputs — not messages or tokens.",
    };
  }

  // ── Outbound actions (BZ-F033): preview → one-shot approval → receipt ──
  // Sending/sharing is its own gate. Approval binds to the EXACT version +
  // recipient; changing either requires a new action. Delivery reports the
  // truth — with no channel configured, nothing is sent and the receipt says so.
  if (method === "POST" && path.startsWith("/api/buzzy/documents/") && path.endsWith("/outbound")) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const m = path.match(/^\/api\/buzzy\/documents\/(doc_[A-Za-z0-9_-]+)\/outbound$/);
    if (!m) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const recipient = typeof body.recipient === "string" ? body.recipient.trim().slice(0, 200) : "";
    if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
      setResponseStatus(event, 400);
      return { error: "Who is this going to? Give me one email address.", code: "bad_recipient" };
    }
    const kind = body.kind === "share_link" ? "share_link" : "email";
    const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim().slice(0, 80)
      : `out_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const sql = await getSql();
    // Retry idempotent: the same key returns the same action, never a duplicate.
    const prior = await sql`
      SELECT id, status, doc_id, version, recipient, receipt FROM buzzy_outbound_actions
      WHERE user_id = ${user.id} AND idempotency_key = ${idempotencyKey} LIMIT 1
    `;
    if (prior.length) {
      return { ok: true, created: false, action: prior[0] };
    }
    const docs = await sql`
      SELECT id, title, status, current_version, accepted_version FROM buzzy_documents
      WHERE id = ${m[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const doc = docs[0];
    if (doc.status !== "accepted" || doc.accepted_version == null) {
      setResponseStatus(event, 409);
      return { error: "Only an accepted version can be sent or shared — accept it first.", code: "not_accepted" };
    }
    const id = `out_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await sql`
      INSERT INTO buzzy_outbound_actions (id, user_id, doc_id, version, kind, recipient, status, idempotency_key)
      VALUES (${id}, ${user.id}, ${doc.id}, ${doc.accepted_version}, ${kind}, ${recipient}, 'pending', ${idempotencyKey})
    `;
    setResponseStatus(event, 201);
    return {
      ok: true,
      created: true,
      action: { id, docId: doc.id, version: doc.accepted_version, kind, recipient, status: "pending" },
      preview: {
        content: `Version ${doc.accepted_version} of "${doc.title ?? "the document"}"`,
        recipient,
        consequence: kind === "email" ? "One email leaves your account to this address." : "A read-only link to this exact version is created.",
        note: "Nothing has been sent. Approving applies to this version and this recipient only — change either and you decide again.",
      },
    };
  }

  const outboundDecide = path.match(/^\/api\/buzzy\/outbound\/(out_[A-Za-z0-9]{8,32})\/(approve|cancel)$/);
  if (method === "POST" && outboundDecide) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql<{ id: string; doc_id: string; version: number; kind: string; recipient: string; status: string }>`
      SELECT id, doc_id, version, kind, recipient, status FROM buzzy_outbound_actions
      WHERE id = ${outboundDecide[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!rows.length) {
      setResponseStatus(event, 404);
      return { error: "That action isn't on your account.", code: "not_found" };
    }
    const action = rows[0];
    if (outboundDecide[2] === "cancel") {
      await sql`UPDATE buzzy_outbound_actions SET status = 'cancelled', decided_at = now(),
                receipt = ${JSON.stringify({ result: "cancelled by owner", at: new Date().toISOString() })}::jsonb
                WHERE id = ${action.id} AND user_id = ${user.id}`;
      return { ok: true, action: { ...action, status: "cancelled" } };
    }
    // BZ-F034: sending is authorized by role or an explicit delegation, in the
    // acting account's scope — never merely because the caller is signed in.
    const acting = await resolveActingAccount(sql as never, user.id, user.email ?? null);
    const sendDecision = await authorize(sql as never, acting, "send_outbound", {});
    if (!sendDecision.allowed) {
      setResponseStatus(event, 403);
      return { error: sendDecision.reason, code: "role_denied", role: acting.role, via: sendDecision.via };
    }
    // Approve: re-verify the pinned version is still the accepted one — a
    // material change since preview invalidates this approval (QA-16/QA-20).
    const docs = await sql<{ title: string | null; status: string; accepted_version: number | null }>`
      SELECT title, status, accepted_version FROM buzzy_documents
      WHERE id = ${action.doc_id} AND user_id = ${acting.accountId} LIMIT 1
    `;
    if (!docs.length || docs[0].status !== "accepted" || docs[0].accepted_version !== action.version) {
      await sql`UPDATE buzzy_outbound_actions SET status = 'cancelled', decided_at = now(),
                receipt = ${JSON.stringify({ result: "invalidated: the accepted version changed since preview", at: new Date().toISOString() })}::jsonb
                WHERE id = ${action.id} AND user_id = ${user.id}`;
      setResponseStatus(event, 409);
      return {
        error: "What you previewed is no longer the accepted version — review the latest and approve again.",
        code: "stale_action",
      };
    }
    // Delivery: no outbound mail channel is configured for this deployment.
    // Say so explicitly — a receipt that claims sending would be a lie.
    const receipt = {
      result: "not_sent",
      reason: "no delivery channel configured for this deployment",
      target: action.recipient,
      version: action.version,
      at: new Date().toISOString(),
    };
    await sql`
      UPDATE buzzy_outbound_actions SET status = 'blocked', decided_at = now(),
        receipt = ${JSON.stringify(receipt)}::jsonb
      WHERE id = ${action.id} AND user_id = ${user.id}
    `;
    return {
      ok: true,
      action: { ...action, status: "blocked" },
      receipt,
      note: "Approved — but nothing was sent: this deployment has no mail delivery channel. Wire one before promising delivery.",
    };
  }

  if (method === "GET" && path === "/api/buzzy/outbound") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT id, doc_id, version, kind, recipient, status, receipt, created_at, decided_at
      FROM buzzy_outbound_actions WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 100
    `;
    return { actions: rows };
  }

  // ── Contacts directory (BZ-F030) — proposed until the owner accepts; ────
  // a name match NEVER merges entities — duplicates are flagged, not fused.
  if (method === "GET" && path === "/api/buzzy/contacts") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      SELECT id, company_id, kind, name, role, contact, status, source_label, created_at, updated_at
      FROM buzzy_contacts WHERE user_id = ${user.id}
      ORDER BY updated_at DESC LIMIT 200
    `;
    return { contacts: rows };
  }

  if (method === "POST" && path === "/api/buzzy/contacts") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ").slice(0, 120) : "";
    if (!name) {
      setResponseStatus(event, 400);
      return { error: "Type the person's or business's name.", code: "bad_request" };
    }
    const kind = body.kind === "customer" || body.kind === "supplier" ? body.kind : "person";
    const role = typeof body.role === "string" ? body.role.trim().slice(0, 120) : null;
    const contactIn = body.contact && typeof body.contact === "object" && !Array.isArray(body.contact)
      ? body.contact as Record<string, unknown>
      : {};
    const contact: Record<string, string> = {};
    for (const k of ["email", "phone"]) {
      if (typeof contactIn[k] === "string" && contactIn[k].trim()) contact[k] = String(contactIn[k]).trim().slice(0, 200);
    }
    const companyId = typeof body.companyId === "string" && isCompanyId(body.companyId) ? body.companyId : null;
    const sql = await getSql();
    if (companyId) {
      const owned = await sql`SELECT id FROM buzzy_companies WHERE id = ${companyId} AND user_id = ${user.id}`;
      if (!owned.length) {
        setResponseStatus(event, 400);
        return { error: "That company isn't on your account.", code: "bad_company" };
      }
    }
    // Disambiguation: same-name EXISTING contacts are surfaced so the owner
    // can tell apart "Acme (the supplier)" from "Acme (the customer)" — the
    // new record is still created as its own entity, never merged (QA-14).
    const dupes = await sql<{ id: string; kind: string; role: string | null }>`
      SELECT id, kind, role FROM buzzy_contacts
      WHERE user_id = ${user.id} AND lower(name) = lower(${name}) AND status <> 'dropped'
      LIMIT 5
    `;
    const id = `ct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await sql`
      INSERT INTO buzzy_contacts (id, user_id, company_id, kind, name, role, contact, status, source_label)
      VALUES (${id}, ${user.id}, ${companyId}, ${kind}, ${name}, ${role},
              ${JSON.stringify(contact)}::jsonb, 'proposed',
              ${typeof body.source === "string" ? body.source.slice(0, 120) : "added by you"})
    `;
    setResponseStatus(event, 201);
    return {
      ok: true,
      contact: { id, kind, name, role, contact, status: "proposed", companyId },
      ...(dupes.length ? { possibleDuplicates: dupes } : {}),
    };
  }

  const contactConfirm = path.match(/^\/api\/buzzy\/contacts\/(ct_[a-z0-9]{8,32})\/confirm$/);
  if (method === "POST" && contactConfirm) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const rows = await sql`
      UPDATE buzzy_contacts SET status = 'confirmed', updated_at = now()
      WHERE id = ${contactConfirm[1]} AND user_id = ${user.id} AND status = 'proposed'
      RETURNING id, kind, name, status
    `;
    if (!rows.length) {
      setResponseStatus(event, 404);
      return { error: "Contact not found (or already confirmed).", code: "not_found" };
    }
    return { ok: true, contact: rows[0] };
  }

  if (method === "DELETE" && path.startsWith("/api/buzzy/contacts/")) {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    await sql`DELETE FROM buzzy_contacts WHERE id = ${path.slice("/api/buzzy/contacts/".length)} AND user_id = ${user.id}`;
    return { ok: true };
  }

  // ── GET /api/buzzy/today — the truthful attention list (BZ-F026) ──────
  // Three honest buckets, assembled from real state only — never an
  // AI-generated feed, never a card moved by timer: needs your decision
  // (draft waiting on you), ready for your review (documents in 'ready'),
  // and due/overdue work (explicit due dates the owner set).
  if (method === "GET" && path === "/api/buzzy/today") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const sql = await getSql();
    const needsDecision = await sql`
      SELECT id, title, status, updated_at FROM buzzy_jobs
      WHERE user_id = ${user.id}
        AND data->>'draft' IS NOT NULL
        AND data->>'approved' IS DISTINCT FROM 'true'
        AND status IS DISTINCT FROM 'Archived'
        AND status IS DISTINCT FROM 'Cancelled'
      ORDER BY updated_at DESC LIMIT 20
    `;
    const readyDocs = await sql`
      SELECT d.id, d.title, d.current_version, d.updated_at FROM buzzy_documents d
      WHERE d.user_id = ${user.id} AND d.status = 'ready'
      ORDER BY d.updated_at DESC LIMIT 20
    `;
    const dueJobs = await sql`
      SELECT id, title, status, data->>'due_date' AS due_date, updated_at FROM buzzy_jobs
      WHERE user_id = ${user.id}
        AND data->>'due_date' IS NOT NULL
        AND status IS DISTINCT FROM 'Archived'
        AND status IS DISTINCT FROM 'Cancelled'
        AND status IS DISTINCT FROM 'Done'
      ORDER BY (data->>'due_date') ASC LIMIT 30
    `;
    const now = Date.now();
    const due = dueJobs.map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      dueDate: j.due_date,
      overdue: j.due_date ? Date.parse(String(j.due_date)) < now : false,
      updatedAt: j.updated_at,
    }));
    return {
      needsDecision: needsDecision.map((j) => ({ id: j.id, title: j.title, status: j.status, updatedAt: j.updated_at, href: `/buzzy/talk?job=${j.id}` })),
      readyForReview: readyDocs.map((d) => ({ id: d.id, title: d.title, currentVersion: d.current_version, updatedAt: d.updated_at })),
      due: due.map((j) => ({ ...j, href: `/buzzy/talk?job=${j.id}` })),
      note: "Everything here is real state — drafts waiting on you, documents ready for review, and due dates you set. Nothing is generated to fill the page.",
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
    const companyFilter = queryValue(fullPath, "companyId");
    if (companyFilter) {
      if (!isCompanyId(companyFilter)) {
        setResponseStatus(event, 400);
        return { error: "Unknown company.", code: "bad_company" };
      }
      const owned = await sql`
        SELECT id FROM buzzy_companies WHERE id = ${companyFilter} AND user_id = ${user.id}
      `;
      if (!owned.length) {
        setResponseStatus(event, 404);
        return { error: "Company not found", code: "not_found" };
      }
    }
    const rows = companyFilter
      ? await sql`
          SELECT s.id, s.job_id, s.title, s.summary, s.company_id, s.created_at, s.updated_at,
            (SELECT count(*) FROM buzzy_chat_messages m WHERE m.session_id = s.id) AS message_count,
            (SELECT left(m.content, 220) FROM buzzy_chat_messages m
              WHERE m.session_id = s.id AND m.role = 'user'
              ORDER BY m.created_at ASC LIMIT 1) AS preview
          FROM buzzy_sessions s
          WHERE s.user_id = ${user.id} AND s.company_id = ${companyFilter}
          ORDER BY s.updated_at DESC
          LIMIT 100
        `
      : await sql`
          SELECT s.id, s.job_id, s.title, s.summary, s.company_id, s.created_at, s.updated_at,
            (SELECT count(*) FROM buzzy_chat_messages m WHERE m.session_id = s.id) AS message_count,
            (SELECT left(m.content, 220) FROM buzzy_chat_messages m
              WHERE m.session_id = s.id AND m.role = 'user'
              ORDER BY m.created_at ASC LIMIT 1) AS preview
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
        companyId: typeof r.company_id === "string" ? r.company_id : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: Number(r.message_count),
        // First thing the owner said — the row always carries text even before
        // the summariser has run.
        preview: typeof r.preview === "string" ? r.preview : null,
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
    // Honor a requested title; fall back to the DB default only when none given.
    const title = typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 120)
      : "New session";
    let companyId: string | null = null;
    if (typeof body.companyId === "string" && body.companyId) {
      if (!isCompanyId(body.companyId)) {
        setResponseStatus(event, 400);
        return { error: "That company isn't on your account.", code: "bad_company" };
      }
      companyId = body.companyId;
    }
    const id = `sess_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const sql = await getSql();
    if (companyId) {
      const owned = await sql`
        SELECT id FROM buzzy_companies WHERE id = ${companyId} AND user_id = ${user.id}
      `;
      if (!owned.length) {
        setResponseStatus(event, 400);
        return { error: "That company isn't on your account.", code: "bad_company" };
      }
    }
    const rows = await sql`
      INSERT INTO buzzy_sessions (id, user_id, job_id, title, company_id)
      VALUES (${id}, ${user.id}, ${jobId}, ${title}, ${companyId})
      RETURNING id, job_id, title, summary, company_id, created_at, updated_at
    `;
    const s = rows[0];
    setResponseStatus(event, 201);
    return {
      session: {
        id: s.id, jobId: s.job_id, title: s.title, summary: s.summary,
        companyId: typeof s.company_id === "string" ? s.company_id : null,
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

  // ── POST /api/buzzy/sessions/:id/summary — one-line conversation label ──
  // Same summariser the Recent work list uses, so the row text and the stored
  // summary can never disagree. Used to backfill older conversations.
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
    const summary = await summarizeSessionNow(sql, summaryMatch[1], user.id);
    return { summary, note: summary ? undefined : "No messages to summarize yet." };
  }

  // ── GET /api/buzzy/papers — latest paper on this company, not another ──
  if (method === "GET" && path === "/api/buzzy/papers") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const companyId = queryValue(fullPath, "companyId");
    if (!companyId || !isCompanyId(companyId)) {
      setResponseStatus(event, 400);
      return { error: "Pick the company this paper belongs to first.", code: "bad_company" };
    }
    const sql = await getSql();
    const owned = await sql`
      SELECT id FROM buzzy_companies WHERE id = ${companyId} AND user_id = ${user.id}
    `;
    if (!owned.length) {
      setResponseStatus(event, 404);
      return { error: "Company not found", code: "not_found" };
    }
    const jobId = queryValue(fullPath, "jobId");
    const paper = await latestPaper(sql, user.id, companyId, jobId);
    return { paper };
  }

  // ── POST /api/buzzy/papers — read a paper; lines stay proposed ──────
  if (method === "POST" && path === "/api/buzzy/papers") {
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
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    const jobId = typeof body.jobId === "string" && body.jobId.trim() ? body.jobId.trim().slice(0, 120) : null;
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim()
      ? body.sessionId.trim().slice(0, 80)
      : null;
    const filename = cleanFilename(body.filename);
    const text = typeof body.text === "string" ? body.text.slice(0, 80000) : "";
    const requested = body.fileKind;
    // BZ-F007: supported types are restricted EXPLICITLY. An unsupported type
    // gets a useful next action, never a silent paste-fallback or an empty
    // analysis (QA-11).
    const SUPPORTED_FILE_KINDS = new Set(["text", "pdf", "photo", "paste"]);
    if (typeof requested === "string" && requested && !SUPPORTED_FILE_KINDS.has(requested)) {
      setResponseStatus(event, 400);
      return {
        error: `That file type (${requested.slice(0, 24)}) isn't supported yet. Paste the text, or drop a PDF or a photo instead.`,
        code: "unsupported_type",
        supported: [...SUPPORTED_FILE_KINDS],
      };
    }
    const fileKind = requested === "text" || requested === "pdf" || requested === "photo" || requested === "paste"
      ? requested
      : "paste";
    let pdfBytes: Uint8Array | null = null;
    if (fileKind === "pdf") {
      const raw = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
      if (!raw || raw.length > 2_100_000) {
        setResponseStatus(event, 400);
        return { error: "That PDF didn't come through. Paste the letter instead.", code: "bad_request" };
      }
      const buf = Buffer.from(raw, "base64");
      if (!buf.length || buf.length > 1_500_000) {
        setResponseStatus(event, 400);
        return { error: "That file is too large. Paste the letter instead.", code: "bad_request" };
      }
      pdfBytes = buf;
    } else if (fileKind !== "photo" && !text.trim()) {
      setResponseStatus(event, 400);
      return { error: "Paste the letter or drop the file first.", code: "bad_request" };
    }
    const sql = await getSql();
    const saved = await savePaper(sql, user.id, {
      companyId,
      jobId,
      sessionId,
      filename,
      text: fileKind === "photo" ? "" : text,
      fileKind,
      pdfBytes,
    });
    if (!saved.ok) {
      setResponseStatus(event, saved.status);
      return { error: saved.error, code: saved.code };
    }
    return { ok: true, paper: saved.paper, reply: saved.paper.reply };
  }

  // ── POST /api/buzzy/papers/:id/lines — confirm or correct one line ──
  const paperLine = path.match(/^\/api\/buzzy\/papers\/(pp_[a-z0-9]{8,32})\/lines$/);
  if (method === "POST" && paperLine) {
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
    const lineId = typeof body.lineId === "string" ? body.lineId : "";
    const action = body.action === "confirm" || body.action === "edit" || body.action === "drop"
      ? body.action
      : "";
    if (!action) {
      setResponseStatus(event, 400);
      return { error: "Choose confirm, change, or drop for that line.", code: "bad_request" };
    }
    const sql = await getSql();
    const updated = await updatePaperLine(
      sql,
      user.id,
      paperLine[1],
      lineId,
      action,
      typeof body.value === "string" ? body.value : null,
    );
    if (!updated.ok) {
      setResponseStatus(event, updated.status);
      return { error: updated.error, code: updated.code };
    }
    return { ok: true, paper: updated.paper };
  }

  // ── POST /api/buzzy/review — the SEPARATE risk-aware check (BZ-F014) ────
  // Independent of the writing turn: contract-matched checks with tool
  // evidence (the calculator recomputes stated totals). A warning is named
  // plainly — never smoothed into "looks fine" (QA-11).
  if (method === "POST" && path === "/api/buzzy/review") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await event.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    let text = typeof body.draft === "string" ? body.draft.slice(0, 40000) : "";
    // Or review a stored document version (server-fetched, ownership-scoped).
    if (!text && typeof body.documentId === "string" && body.documentId) {
      const sql = await getSql();
      const vrows = await sql<{ content: string }>`
        SELECT v.content FROM buzzy_document_versions v
        JOIN buzzy_documents d ON d.id = v.doc_id
        WHERE v.doc_id = ${body.documentId.slice(0, 120)} AND d.user_id = ${user.id}
          AND v.version = d.current_version LIMIT 1
      `;
      if (!vrows.length) {
        setResponseStatus(event, 404);
        return { error: "Document not found", code: "not_found" };
      }
      text = String(vrows[0].content ?? "");
    }
    if (!text.trim()) {
      setResponseStatus(event, 400);
      return { error: "Give me the draft (or a document) to check.", code: "bad_request" };
    }
    const checks = reviewSeparately(text);
    const warnings = checks.filter((c: ReviewCheck) => c.verdict === "warning");
    return {
      ok: true,
      independent: true,
      note: "This is a separate check — the draft did not grade itself. Arithmetic was recomputed by the calculator, not the writer.",
      checks,
      hasWarnings: warnings.length > 0,
      blocksReady: warnings.length > 0,
    };
  }

  // ── POST /api/buzzy/money-check — compare; do not approve or send ──
  if (method === "POST" && path === "/api/buzzy/money-check") {
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
    } catch { /* the check still runs on an empty draft */ }
    const draft = typeof body.draft === "string" ? body.draft.slice(0, 20000) : "";
    const brief = asMoneyBrief(body.brief);
    let facts: MoneyFact[] = [];
    let kind = "";
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    if (companyId) {
      if (!isCompanyId(companyId)) {
        setResponseStatus(event, 400);
        return { error: "Pick the company this draft belongs to first.", code: "bad_company" };
      }
      const sql = await getSql();
      const owned = await sql`
        SELECT id FROM buzzy_companies WHERE id = ${companyId} AND user_id = ${user.id}
      `;
      if (!owned.length) {
        setResponseStatus(event, 404);
        return { error: "Company not found", code: "not_found" };
      }
      const jobRaw = typeof body.jobId === "string" ? body.jobId.trim().slice(0, 120) : "";
      const paper = await latestPaper(sql, user.id, companyId, jobRaw || null);
      if (paper) {
        kind = paper.kind;
        facts = paper.facts.map((f) => ({
          key: f.key,
          label: f.label,
          value: f.value,
          status: f.status,
          place: f.place,
          source: f.source,
        }));
      }
    }
    const check = checkMoney({ draft, facts, brief, kind });
    return {
      ok: true,
      items: check.items,
      blocksApproval: check.blocksApproval,
      draft: check.draft,
    };
  }

  // BZ-P04 review finding: an unmatched /api/buzzy route is a 404, not an
  // unhandled 500. A typo must read as "wrong path", never as "server broke".
  setResponseStatus(event, 404);
  return { ok: false, error: "That API path doesn't exist.", code: "not_found", path };
});
