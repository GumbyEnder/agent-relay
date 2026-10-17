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
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getModels, chatCompletion } from "./llm";
import { getSql, type Sql } from "@/lib/db";
import { honchoAvailable } from "./honcho";
import { getProfile, saveProfile, reuseDefaults, PROFILE_FIELDS } from "./profile";
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
import { STATEMENT_IDS, DEEPENING_IDS } from "./questions";

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

    const result = await chatLoop({
      userId,
      jobId,
      sessionId,
      message,
      model,
      attemptId,
      jobContext,
      companyName: company?.name ?? null,
      companyFacts: company?.facts ?? [],
      customerMemoryBlock,
    });
    return result;
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
      SELECT kind, scope, status, last_error, connected_at
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
    const sql = await getSql();
    await sql`
      INSERT INTO buzzy_connections (id, user_id, kind, scope, status)
      VALUES (${"conn_" + Math.random().toString(36).slice(2, 10)}, ${user.id}, ${kind}, ${scope}, 'connected')
      ON CONFLICT (user_id, kind) DO UPDATE SET
        scope = EXCLUDED.scope, status = 'connected', last_error = '', updated_at = now()
    `;
    return { ok: true, kind, scope, consent: CONNECTION_CONSENT[kind] };
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

    // ── BZ-F020: exports match the CHOSEN version (QA-12) ──────────────
    // format=pdf|docx|md|csv renders THIS version's canonical text on demand —
    // the export can never drift from the version the owner picked.
    const format = (queryValue(fullPath, "format") ?? "").toLowerCase();
    if (format) {
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
    const docs = await sql`
      SELECT id, job_id, title, status, current_version, accepted_version
      FROM buzzy_documents WHERE id = ${docDecision[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!docs.length) {
      setResponseStatus(event, 404);
      return { error: "Document not found", code: "not_found" };
    }
    const doc = docs[0];
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
      VALUES (${doc.id}, ${user.id}, ${version}, ${action}, ${role}, ${note})
    `;
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
    setResponseStatus(event, 201);
    return {
      ok: true,
      job: { id: jobId, title: starter.name, status: "Discovering", starter: starter.id },
      firstQuestion: starter.firstQuestion,
      boundary: starter.boundary,
    };
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

  // ── GET /api/buzzy/search — ownership-scoped search (BZ-F019) ─────────
  // Titles AND content across the account's jobs and documents; filters by
  // status/company/type. Search NEVER crosses accounts — a broad query
  // returns exactly what the caller owns and nothing more (QA-05).
  if (method === "GET" && path === "/api/buzzy/search") {
    const user = await getSessionUserFromHeaders(headersFromEvent(event));
    if (!user) {
      setResponseStatus(event, 401);
      return { error: "Sign in required", code: "signed_out" };
    }
    const q = (queryValue(fullPath, "q") ?? "").trim().slice(0, 120);
    if (q.length < 2) {
      setResponseStatus(event, 400);
      return { error: "Type at least 2 characters to search.", code: "bad_query" };
    }
    const statusFilter = queryValue(fullPath, "status");
    const companyFilter = queryValue(fullPath, "companyId");
    const typeFilter = queryValue(fullPath, "type"); // "jobs" | "documents" | null
    const needle = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    const sql = await getSql();
    const jobs = typeFilter === "documents" ? [] : await sql`
      SELECT id, title, status, company_id, updated_at
      FROM buzzy_jobs
      WHERE user_id = ${user.id}
        AND title ILIKE ${needle}
        AND (${statusFilter}::text IS NULL OR status = ${statusFilter})
        AND (${companyFilter}::text IS NULL OR company_id = ${companyFilter})
      ORDER BY updated_at DESC LIMIT 50
    `;
    const docs = typeFilter === "jobs" ? [] : await sql`
      SELECT d.id, d.job_id, d.title, d.status, d.current_version, d.updated_at,
             (SELECT content FROM buzzy_document_versions v
               WHERE v.doc_id = d.id AND v.version = d.current_version) AS content
      FROM buzzy_documents d
      WHERE d.user_id = ${user.id}
        AND (d.title ILIKE ${needle}
             OR (SELECT content FROM buzzy_document_versions v
                  WHERE v.doc_id = d.id AND v.version = d.current_version) ILIKE ${needle})
        AND (${statusFilter}::text IS NULL OR d.status = ${statusFilter})
      ORDER BY d.updated_at DESC LIMIT 50
    `;
    const ql = q.toLowerCase();
    return {
      q,
      jobs: jobs.map((j) => ({ id: j.id, title: j.title, status: j.status, companyId: j.company_id, updatedAt: j.updated_at })),
      documents: docs.map((d) => {
        const content = String(d.content ?? "");
        const at = content.toLowerCase().indexOf(ql);
        const snippet = at >= 0
          ? content.slice(Math.max(0, at - 60), at + q.length + 60).replace(/\s+/g, " ").trim()
          : "";
        return {
          id: d.id, jobId: d.job_id, title: d.title, status: d.status,
          currentVersion: d.current_version, updatedAt: d.updated_at,
          ...(snippet ? { snippet } : {}),
        };
      }),
    };
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
            (SELECT count(*) FROM buzzy_chat_messages m WHERE m.session_id = s.id) AS message_count
          FROM buzzy_sessions s
          WHERE s.user_id = ${user.id} AND s.company_id = ${companyFilter}
          ORDER BY s.updated_at DESC
          LIMIT 100
        `
      : await sql`
          SELECT s.id, s.job_id, s.title, s.summary, s.company_id, s.created_at, s.updated_at,
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
        companyId: typeof r.company_id === "string" ? r.company_id : null,
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

  throw new Error("Not found");
});
