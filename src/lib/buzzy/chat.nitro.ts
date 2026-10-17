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
    return {
      messages: rows.map((r) => ({
        jobId: ("job_id" in r && typeof r.job_id === "string") ? r.job_id : null,
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

    const sql = await getSql();
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
    const rows = companyFilter
      ? await sql`
          SELECT id, template, title, status, company_id, data, created_at, updated_at
          FROM buzzy_jobs
          WHERE user_id = ${user.id} AND company_id = ${companyFilter}
          ORDER BY updated_at DESC
          LIMIT 500
        `
      : await sql`
          SELECT id, template, title, status, company_id, data, created_at, updated_at
          FROM buzzy_jobs
          WHERE user_id = ${user.id}
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
    await sql`DELETE FROM buzzy_jobs WHERE id = ${id} AND user_id = ${user.id}`;
    return { ok: true };
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
    if (!hasTitle && !hasStatus && !hasApproved && !hasDraft) {
      setResponseStatus(event, 400);
      return { error: "Nothing to update.", code: "bad_request" };
    }
    const dataPatch: Record<string, unknown> = {};
    if (hasApproved) dataPatch.approved = body.approved;
    if (hasDraft) dataPatch.draft = body.draft;
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
    return { job: { id: rows[0].id, title: rows[0].title, status: rows[0].status } };
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
