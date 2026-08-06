/**
 * HTTP surface for the five agent verbs (+ operator helpers).
 *
 * Routes (all under /api/agent):
 *   GET  /health
 *   GET  /missions?column=ready&limit=5&agent=forge&tags=docs,ops
 *   GET  /missions/:id
 *   POST /missions/:id/claim      { agent }
 *   POST /missions/:id/heartbeat  { agent, note? }
 *   POST /missions/:id/escalate   { agent, question }
 *   POST /missions/:id/deliver    { agent, summary, artifacts? }
 *   POST /missions                { title, objective, project?, column? } — operator or agent key
 *   POST /v1                      { action: poll|claim|…|create|file, ... }
 *   GET  /agents
 *   POST /agents                  { name, harness, role?, skills? }
 *   GET  /calls
 *   POST /calls/:id/reply         { reply }   — operator
 *   GET  /export
 *   POST /reset                   — demo only
 *
 * Auth: if AGENT_RELAY_API_KEY is set, require
 *   Authorization: Bearer <key>  OR  X-Agent-Key: <key>
 * If unset, open access (local demo).
 */
import type { HarnessKind, MissionColumn, Priority } from "./types";
import { HARNESS_IDS } from "./types";
import { boardOps, ensureBoardReady } from "./board-server";
import type { EngineResult } from "./board-engine";
import { verifyGitHubSignature } from "./github-webhook";
import {
  extractArtifactFromGitHubPayload,
  githubExternalId,
  parseRelayReplyComment,
} from "./github-ingest";
import {
  checkOperatorCapability,
  resolveOperatorContext,
  type OperatorContext,
} from "./auth/verify.server";
import type { OperatorCapability } from "./auth/roles";
import { policyFromEnv, staleSummary } from "./stale-heartbeat";
import { isDevMailInboxEnabled, latestDevMailFor, listDevMail } from "./mailer";
import { clientAgentGuideMarkdown, DEFAULT_PUBLIC_BASE } from "./agent-client-guide";
import { clientAgentSkillMarkdown } from "./agent-skill";
import { canAccessBoardByOwner } from "./board-tenancy";
import { summarizeTickets } from "./ticket-summary";
import { renderDocsHtmlPage, wantsHtmlDocs } from "./docs-html";

const HARNESSES = new Set<HarnessKind>(HARNESS_IDS);
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, x-agent-key",
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    },
  });
}

function err(status: number, error: string, code?: string): Response {
  return json({ ok: false, error, code }, status);
}

function fromEngine<T>(result: EngineResult<T>): Response {
  if (!result.ok) return err(result.status, result.error, result.code);
  return json({ ok: true, ...result.data });
}

function isSameOriginBrowser(req: Request): boolean {
  const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  if (site === "same-origin") return true;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  if (origin && host) {
    try {
      if (new URL(origin).host === host.split(",")[0]!.trim()) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function presentedKey(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-agent-key")?.trim() ?? "";
}

/** Result of machine auth (Bearer). Browser UI uses type "browser". */
type MachineAuth =
  | { type: "browser" }
  | { type: "global" }
  | { type: "open" }
  | {
      type: "ark";
      keyId: string;
      projectId: string;
      /** Roster agent id when key is bound to one agent (practical flow). */
      agentId: string | null;
    };

/**
 * Authenticate machine callers. Returns auth context or an error Response.
 * Browser same-origin is never required to present an agent key.
 */
async function authenticateMachine(req: Request): Promise<MachineAuth | Response> {
  if (isSameOriginBrowser(req)) return { type: "browser" };

  const key = presentedKey(req);
  const globalKey = process.env.AGENT_RELAY_API_KEY?.trim();

  if (key) {
    if (globalKey && key === globalKey) return { type: "global" };
    if (key.startsWith("ark_")) {
      const hit = await boardOps.verifyPresentedApiKey(key);
      if (hit) {
        return {
          type: "ark",
          keyId: hit.id,
          projectId: hit.projectId,
          agentId: hit.agentId,
        };
      }
      return err(401, "Invalid or revoked API key", "unauthorized");
    }
    if (globalKey) return err(401, "Invalid or missing API key", "unauthorized");
  }

  if (globalKey) return err(401, "Invalid or missing API key", "unauthorized");
  return { type: "open" };
}

/** @deprecated use authenticateMachine — kept name for call sites during edit */
async function requireApiKey(req: Request): Promise<Response | null> {
  const auth = await authenticateMachine(req);
  if (auth instanceof Response) return auth;
  return null;
}

/**
 * Resolve which agent name/id may run a verb.
 * Agent-scoped keys may only act as that agent (practical human-issues-key flow).
 */
async function resolveVerbAgent(
  body: Record<string, unknown>,
  machine: MachineAuth,
): Promise<string | Response> {
  const requested = str(body.agent) ?? str(body.agent_id);

  if (machine.type === "ark" && machine.agentId) {
    const snap = await boardOps.snapshot();
    const bound = snap.agents.find(
      (a) =>
        a.id === machine.agentId ||
        a.name.toLowerCase() === String(machine.agentId).toLowerCase(),
    );
    if (!bound) {
      return err(
        403,
        "This API key is bound to an agent that is no longer on the roster. Register the agent again and issue a new key.",
        "agent_key_orphan",
      );
    }
    if (
      requested &&
      requested !== bound.id &&
      requested.toLowerCase() !== bound.name.toLowerCase()
    ) {
      return err(
        403,
        `This API key may only act as agent "${bound.name}"`,
        "agent_key_mismatch",
      );
    }
    return bound.name;
  }

  if (!requested) return err(400, "agent is required", "bad_request");
  return requested;
}

async function loadOperatorContext(req: Request): Promise<OperatorContext> {
  return resolveOperatorContext(req.headers, {
    lookupDbRole: (userId, email) => boardOps.getOperatorRole(userId, email),
  });
}

/**
 * Gate human operator capabilities (board writes, keys, settings).
 * Agent Bearer keys never grant these — only human session roles do
 * (or open local mode when human auth is not required).
 */
async function requireOperatorCap(
  req: Request,
  cap: OperatorCapability,
): Promise<Response | null> {
  const ctx = await loadOperatorContext(req);
  const check = checkOperatorCapability(ctx, cap);
  if (check.ok) return null;
  return err(check.status, check.error, check.code);
}

/**
 * Private boards (owner_user_id set) → owner or admin only.
 * Shared/demo boards (owner null) → any signed-in operator (intentional product policy).
 * Open/local mode (auth not required) → allow.
 */
async function operatorCanAccessProject(
  ctx: OperatorContext,
  projectId: string,
): Promise<boolean> {
  const project = await boardOps.getProject(projectId);
  if (!project) return false;
  return canAccessBoardByOwner(
    {
      authRequired: ctx.authRequired,
      userId: ctx.user?.id,
      role: ctx.role,
    },
    project.ownerUserId,
  );
}

/** Readable project ids for the operator, or null when unrestricted (open mode / admin all). */
async function resolveReadableProjectIds(
  ctx: OperatorContext,
  opts?: { adminAll?: boolean },
): Promise<string[] | null> {
  if (!ctx.authRequired) return null;
  if (!ctx.user) return [];
  if (ctx.role === "admin" && opts?.adminAll) return null;
  const boards = await boardOps.listProjects({
    ownerUserId: ctx.user.id,
    includeShared: true,
    admin: false,
  });
  return boards.map((b) => b.id);
}

/**
 * Resolve board ref and ensure the operator may access it.
 * Returns project id or an error Response. Uses 404 (not 403) to avoid leaking private board existence.
 */
async function requireOperatorProjectAccess(
  req: Request,
  projectRefRaw: string,
  opts?: { adminAll?: boolean },
): Promise<string | Response> {
  const resolved = await boardOps.resolveProjectId(projectRefRaw);
  if (!resolved) return err(404, "board not found", "not_found");
  const ctx = await loadOperatorContext(req);
  if (!ctx.authRequired) return resolved;
  if (!ctx.user) return err(401, "Sign in required", "signed_out");
  if (ctx.role === "admin" && opts?.adminAll) return resolved;
  if (!(await operatorCanAccessProject(ctx, resolved))) {
    return err(404, "board not found", "not_found");
  }
  return resolved;
}

/**
 * Gate mission reads for operators (session) and agent keys.
 * Prefer 404 mission_not_found when the caller cannot see the board.
 */
async function assertCanReadMission(
  req: Request,
  machineAuth: MachineAuth,
  mission: { id: string; projectId: string },
): Promise<Response | null> {
  if (machineAuth.type === "global") return null;

  if (machineAuth.type === "ark") {
    if (machineAuth.projectId === mission.projectId) return null;
    if (machineAuth.agentId) {
      const ok = await boardOps.agentCanAccessBoard(
        machineAuth.agentId,
        mission.projectId,
      );
      if (ok) return null;
    }
    return err(404, `Unknown mission: ${mission.id}`, "mission_not_found");
  }

  // browser / open — operator session tenancy
  const ctx = await loadOperatorContext(req);
  if (!ctx.authRequired) return null;
  if (!ctx.user) return err(401, "Sign in required", "signed_out");
  if (!(await operatorCanAccessProject(ctx, mission.projectId))) {
    return err(404, `Unknown mission: ${mission.id}`, "mission_not_found");
  }
  return null;
}

/**
 * After requireOperatorCap(write_*), ensure the mission's board is writable by this operator.
 */
async function assertOperatorCanWriteMission(
  req: Request,
  missionId: string,
): Promise<{ mission: NonNullable<Awaited<ReturnType<typeof boardOps.getMission>>> } | Response> {
  const mission = await boardOps.getMission(missionId);
  if (!mission) return err(404, "mission not found", "mission_not_found");
  const ctx = await loadOperatorContext(req);
  if (!(await operatorCanAccessProject(ctx, mission.projectId))) {
    return err(404, "mission not found", "mission_not_found");
  }
  return { mission };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    throw new Error("invalid_json");
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function projectRef(
  url: URL,
  body?: Record<string, unknown>,
): string | undefined {
  const q = url.searchParams.get("project") ?? url.searchParams.get("project_id");
  const normalize = (raw: string | undefined) => {
    if (!raw?.trim()) return undefined;
    const t = raw.trim();
    // "all" / "*" = unscoped snapshot across boards the caller can access
    if (t === "all" || t === "*" || t === "__all__") return undefined;
    return t;
  };
  const fromQ = normalize(q ?? undefined);
  if (fromQ) return fromQ;
  if (q?.trim() && normalize(q) === undefined) return undefined;
  if (body) {
    const b = str(body.project) ?? str(body.project_id);
    return normalize(b);
  }
  return undefined;
}

function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function parseUsage(raw: unknown): import("./types").MissionUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v)
      ? v
      : typeof v === "string" && v.trim() && Number.isFinite(Number(v))
        ? Number(v)
        : undefined;
  const toolRaw = u.toolCalls ?? u.tool_calls;
  let toolCalls: number | Record<string, number> | undefined;
  if (typeof toolRaw === "number") toolCalls = toolRaw;
  else if (toolRaw && typeof toolRaw === "object" && !Array.isArray(toolRaw)) {
    toolCalls = Object.fromEntries(
      Object.entries(toolRaw as Record<string, unknown>)
        .map(([k, v]) => [k, num(v)] as const)
        .filter((x): x is [string, number] => x[1] !== undefined),
    );
  }
  return {
    tokensIn: num(u.tokensIn ?? u.tokens_in),
    tokensOut: num(u.tokensOut ?? u.tokens_out),
    model: u.model != null ? String(u.model) : undefined,
    toolCalls,
    estimatedUsd: num(u.estimatedUsd ?? u.estimated_usd),
    pricingSource:
      u.pricingSource != null
        ? String(u.pricingSource)
        : u.pricing_source != null
          ? String(u.pricing_source)
          : undefined,
    raw: u as Record<string, unknown>,
  };
}

/**
 * Handle a full Request whose pathname starts with /api/agent.
 */
export async function handleAgentApiRequest(req: Request): Promise<Response> {
  await ensureBoardReady();
  const url = new URL(req.url);
  let path = url.pathname;
  // Normalize trailing slash
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, authorization, x-agent-key",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      },
    });
  }

  const prefix = "/api/agent";
  if (!path.startsWith(prefix)) {
    return err(404, "Not found");
  }
  const rest = path.slice(prefix.length) || "/";
  const parts = rest.split("/").filter(Boolean);
  // parts e.g. ["missions", "msn_x", "claim"]

  // Public docs surfaces (no agent key) — client agents can fetch the guide/skill cold.
  const publicDoc =
    (parts[0] === "health" && parts.length === 1) ||
    (parts[0] === "client-guide" && (parts.length === 1 || parts[1] === "README.md")) ||
    (parts[0] === "skill.md" && parts.length === 1) ||
    (parts[0] === "skill" && parts.length === 1) ||
    (parts[0] === "skills" && parts[1] === "devboards" && parts.length <= 3) ||
    (parts[0] === "docs" && parts.length >= 1 && parts.length <= 2);
  let machineAuth: MachineAuth = { type: "open" };
  if (!publicDoc) {
    const auth = await authenticateMachine(req);
    if (auth instanceof Response) return auth;
    machineAuth = auth;
  }

  try {
    let body: Record<string, unknown> = {};
    let rawBody = "";
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        rawBody = await req.text();
        if (rawBody.trim()) {
          const parsed = JSON.parse(rawBody) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          }
        }
      }
    } catch {
      return err(400, "Invalid JSON body", "invalid_json");
    }

    // GET /health
    if (parts.length === 1 && parts[0] === "health" && req.method === "GET") {
      const snap = await boardOps.snapshot();
      const stale = staleSummary(snap.missions, Date.now(), policyFromEnv());
      return json({
        ok: true,
        service: "agent-relay",
        version: "0.3.0",
        verbs: ["poll", "claim", "heartbeat", "escalate", "deliver"],
        missions: snap.missions.length,
        agents: snap.agents.length,
        open_calls: snap.calls.filter((c) => !c.resolvedAt).length,
        api_key_required: Boolean(process.env.AGENT_RELAY_API_KEY?.trim()),
        store: "durable",
        stale,
      });
    }

    // GET /client-guide | /docs | /docs/guide — humans get HTML; agents get markdown
    if (
      req.method === "GET" &&
      ((parts.length === 1 && parts[0] === "client-guide") ||
        (parts.length === 2 && parts[0] === "client-guide" && parts[1] === "README.md") ||
        (parts.length === 1 && parts[0] === "docs") ||
        (parts.length === 2 && parts[0] === "docs" && (parts[1] === "guide" || parts[1] === "client-guide")))
    ) {
      const base =
        url.searchParams.get("base")?.trim() ||
        process.env.BETTER_AUTH_URL?.trim() ||
        process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ||
        DEFAULT_PUBLIC_BASE;
      const normalized = base.startsWith("http") ? base : `https://${base}`;
      const md = clientAgentGuideMarkdown(normalized);
      const asJson = url.searchParams.get("format") === "json";
      if (asJson) return json({ ok: true, markdown: md, base: normalized.replace(/\/$/, "") });
      if (wantsHtmlDocs(req, url)) {
        const html = renderDocsHtmlPage({
          title: "Client agent guide",
          subtitle:
            "How remote agents connect to Dev Boards — written for operators and harness authors.",
          markdown: md,
          rawPath: "/api/agent/client-guide",
          baseUrl: normalized,
        });
        return new Response(html, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=60",
            "access-control-allow-origin": "*",
          },
        });
      }
      return new Response(md, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=60",
          "access-control-allow-origin": "*",
        },
      });
    }

    // GET /skill.md | /skill | /skills/devboards | /docs/skill — skill for agents + HTML for people
    if (
      req.method === "GET" &&
      ((parts.length === 1 && (parts[0] === "skill.md" || parts[0] === "skill")) ||
        (parts.length === 2 && parts[0] === "skills" && parts[1] === "devboards") ||
        (parts.length === 3 &&
          parts[0] === "skills" &&
          parts[1] === "devboards" &&
          parts[2] === "SKILL.md") ||
        (parts.length === 2 && parts[0] === "docs" && (parts[1] === "skill" || parts[1] === "skill.md")))
    ) {
      const base =
        url.searchParams.get("base")?.trim() ||
        process.env.BETTER_AUTH_URL?.trim() ||
        process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ||
        DEFAULT_PUBLIC_BASE;
      const normalized = base.startsWith("http") ? base : `https://${base}`;
      const md = clientAgentSkillMarkdown(normalized);
      const asJson = url.searchParams.get("format") === "json";
      if (asJson) {
        return json({
          ok: true,
          name: "devboards",
          markdown: md,
          base: normalized.replace(/\/$/, ""),
        });
      }
      if (wantsHtmlDocs(req, url)) {
        const html = renderDocsHtmlPage({
          title: "Agent skill",
          subtitle:
            "Installable client skill for Hermes and other harnesses — readable here, copyable as markdown for agents.",
          markdown: md,
          rawPath: "/api/agent/skill.md",
          baseUrl: normalized,
        });
        return new Response(html, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=60",
            "access-control-allow-origin": "*",
          },
        });
      }
      return new Response(md, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=60",
          "access-control-allow-origin": "*",
          "content-disposition": 'inline; filename="SKILL.md"',
        },
      });
    }

    // GET /me — human session + role (agents ignore; no agent key required for same-origin)
    if (parts.length === 1 && parts[0] === "me" && req.method === "GET") {
      const ctx = await loadOperatorContext(req);
      return json({
        ok: true,
        authRequired: ctx.authRequired,
        user: ctx.user,
        role: ctx.role,
        capabilities: {
          read: checkOperatorCapability(ctx, "read").ok,
          write_board: checkOperatorCapability(ctx, "write_board").ok,
          reply_call: checkOperatorCapability(ctx, "reply_call").ok,
          manage_keys: checkOperatorCapability(ctx, "manage_keys").ok,
          manage_settings: checkOperatorCapability(ctx, "manage_settings").ok,
          manage_roles: checkOperatorCapability(ctx, "manage_roles").ok,
        },
      });
    }

    // GET /dev/mail — local verification links when SMTP is not configured
    if (parts.length === 2 && parts[0] === "dev" && parts[1] === "mail" && req.method === "GET") {
      if (!isDevMailInboxEnabled()) {
        return err(404, "Dev mail inbox disabled", "not_found");
      }
      const email = url.searchParams.get("email") ?? undefined;
      const latest = email ? latestDevMailFor(email) : listDevMail({ limit: 1 })[0] ?? null;
      return json({
        ok: true,
        enabled: true,
        latest: latest
          ? {
              id: latest.id,
              to: latest.to,
              subject: latest.subject,
              actionUrl: latest.actionUrl ?? null,
              at: latest.at,
              transport: latest.transport,
            }
          : null,
        recent: listDevMail({ email, limit: 5 }).map((m) => ({
          id: m.id,
          to: m.to,
          subject: m.subject,
          actionUrl: m.actionUrl ?? null,
          at: m.at,
        })),
      });
    }

    // POST /v1  — action dispatcher matching PROTOCOL.md
    if (parts.length === 1 && parts[0] === "v1" && req.method === "POST") {
      return handleAction(body, machineAuth);
    }

    // GET /missions
    if (parts.length === 1 && parts[0] === "missions" && req.method === "GET") {
      const column = (url.searchParams.get("column") ?? "ready") as MissionColumn;
      const limit = Number(url.searchParams.get("limit") ?? "5");
      let agent = url.searchParams.get("agent") ?? undefined;
      if (machineAuth.type === "ark" && machineAuth.agentId) {
        const agentOrErr = await resolveVerbAgent(
          { agent: agent ?? undefined },
          machineAuth,
        );
        if (agentOrErr instanceof Response) return agentOrErr;
        agent = agentOrErr;
      }
      const tags = url.searchParams.get("tags")?.split(",").filter(Boolean);
      const skills = url.searchParams.get("skills")?.split(",").filter(Boolean);
      const matchAgentSkillsRaw = url.searchParams.get("match_agent_skills");
      const matchAgentSkills =
        matchAgentSkillsRaw == null
          ? undefined
          : matchAgentSkillsRaw === "1" || matchAgentSkillsRaw === "true";
      const result = await boardOps.poll({
        column,
        limit: Number.isFinite(limit) ? limit : 5,
        agent,
        tags,
        skills,
        matchAgentSkills,
        projectId: projectRef(url),
      });
      return fromEngine(result);
    }

    // GET /missions/:id
    if (parts.length === 2 && parts[0] === "missions" && req.method === "GET") {
      const id = parts[1]!;
      const m = await boardOps.getMission(id);
      if (!m) return err(404, `Unknown mission: ${id}`, "mission_not_found");
      const denied = await assertCanReadMission(req, machineAuth, m);
      if (denied) return denied;
      return json({ ok: true, mission: m });
    }

    // POST /missions/:id/claim|heartbeat|escalate|deliver|move|artifacts
    if (parts.length === 3 && parts[0] === "missions" && req.method === "POST") {
      const id = parts[1]!;
      const verb = parts[2]!;

      if (verb === "artifacts") {
        const urlA = str(body.url) ?? str(body.html_url);
        if (!urlA) return err(400, "url required", "bad_request");
        // Operator session: board ownership. Agent key: same board access as claim.
        if (machineAuth.type === "browser" || machineAuth.type === "open") {
          const gate = await requireOperatorCap(req, "write_board");
          if (gate) return gate;
          const access = await assertOperatorCanWriteMission(req, id);
          if (access instanceof Response) return access;
        } else if (machineAuth.type === "ark") {
          const existing = await boardOps.getMission(id);
          if (!existing) return err(404, "mission not found", "mission_not_found");
          const denied = await assertCanReadMission(req, machineAuth, existing);
          if (denied) return denied;
        }
        const m = await boardOps.attachMissionArtifact(id, urlA, str(body.note));
        if (!m) return err(404, "mission not found", "mission_not_found");
        return json({ ok: true, mission: m });
      }

      if (verb === "move") {
        const gate = await requireOperatorCap(req, "write_board");
        if (gate) return gate;
        const access = await assertOperatorCanWriteMission(req, id);
        if (access instanceof Response) return access;
        const column = str(body.column) as import("./types").MissionColumn | undefined;
        if (!column) return err(400, "column is required", "bad_request");
        const actor = str(body.actor) ?? "operator";
        return fromEngine(await boardOps.moveMission(id, column, actor));
      }

      const agentOrErr = await resolveVerbAgent(body, machineAuth);
      if (agentOrErr instanceof Response) return agentOrErr;
      const agent = agentOrErr;

      if (verb === "claim") {
        return fromEngine(await boardOps.claim(id, agent));
      }
      if (verb === "heartbeat") {
        return fromEngine(await boardOps.heartbeat(id, agent, str(body.note)));
      }
      if (verb === "escalate") {
        const question = str(body.question);
        if (!question) return err(400, "question is required", "bad_request");
        return fromEngine(await boardOps.escalate(id, agent, question));
      }
      if (verb === "deliver") {
        const summary = str(body.summary) ?? str(body.delivery) ?? "";
        const usage = parseUsage(body.usage ?? body.usage_report);
        return fromEngine(
          await boardOps.deliver(
            id,
            agent,
            summary,
            strArr(body.artifacts) ?? [],
            usage,
          ),
        );
      }
      return err(404, `Unknown verb: ${verb}`);
    }

    // GET /agents — fleet scoped to boards the operator can see (boardIds filtered)
    if (parts.length === 1 && parts[0] === "agents" && req.method === "GET") {
      const ctx = await loadOperatorContext(req);
      let allowedProjectIds: string[] | null = null;
      if (ctx.authRequired && ctx.user) {
        allowedProjectIds = await resolveReadableProjectIds(ctx, {
          adminAll: ctx.role === "admin" && url.searchParams.get("all") === "1",
        });
      }
      const agents = await boardOps.listFleetAgents(allowedProjectIds);
      return json({ ok: true, agents });
    }

    // GET /agents/:id|/agents/:id/profile — operator agent dossier + stats
    if (
      parts[0] === "agents" &&
      parts.length >= 2 &&
      req.method === "GET" &&
      (parts.length === 2 || parts[2] === "profile")
    ) {
      const gate = await requireOperatorCap(req, "read");
      if (gate) return gate;
      const ctx = await loadOperatorContext(req);
      let allowedProjectIds: string[] | null = null;
      if (ctx.authRequired && ctx.user) {
        const boards = await boardOps.listProjects({
          ownerUserId: ctx.user.id,
          includeShared: true,
          admin: ctx.role === "admin",
        });
        allowedProjectIds = boards.map((b) => b.id);
      }
      const profile = await boardOps.getAgentProfile(parts[1]!, {
        allowedProjectIds,
      });
      if (!profile) return err(404, "agent not found", "agent_not_found");
      return json({ ok: true, ...profile });
    }

    // POST /agents  { name, harness, role?, skills?, project?, issueKey? }
    // When project is set, issueKey defaults true — register + board-bound ark_ in one step.
    if (parts.length === 1 && parts[0] === "agents" && req.method === "POST") {
      const name = str(body.name);
      const harness = str(body.harness) as HarnessKind | undefined;
      if (!name || !harness) return err(400, "name and harness are required", "bad_request");
      if (!HARNESSES.has(harness)) {
        return err(400, `Invalid harness. One of: ${[...HARNESSES].join(", ")}`, "bad_request");
      }
      const rawProject =
        str(body.projectId) ?? str(body.project) ?? projectRef(url, body) ?? null;
      const issueKeyRaw = body.issueKey ?? body.issue_key;
      const issueKey =
        issueKeyRaw === undefined || issueKeyRaw === null
          ? Boolean(rawProject?.trim())
          : issueKeyRaw === true ||
            issueKeyRaw === 1 ||
            issueKeyRaw === "1" ||
            issueKeyRaw === "true";

      const result = await boardOps.registerAgent({
        name,
        harness,
        role: str(body.role),
        skills: strArr(body.skills),
        projectId: rawProject,
      });
      if (!result.ok) return fromEngine(result);

      let key: Awaited<ReturnType<typeof boardOps.createApiKey>> | null = null;
      let keyError: string | null = null;
      if (issueKey) {
        if (!rawProject?.trim()) {
          keyError = "project required to issue key";
        } else {
          // Keys are operator-only (manage_keys). Agent ark_ callers still get the agent.
          const gate = await requireOperatorCap(req, "manage_keys");
          if (gate) {
            try {
              const bodyJson = (await gate.clone().json()) as { error?: string };
              keyError = bodyJson.error ?? "manage_keys required to issue key";
            } catch {
              keyError = "manage_keys required to issue key";
            }
          } else {
            const projectAccess = await requireOperatorProjectAccess(req, rawProject.trim());
            if (projectAccess instanceof Response) {
              try {
                const bodyJson = (await projectAccess.clone().json()) as { error?: string };
                keyError = bodyJson.error ?? "board not accessible for key";
              } catch {
                keyError = "board not accessible for key";
              }
            } else {
              key = await boardOps.createApiKey({
                projectId: projectAccess,
                agentId: result.data.agent.id,
                name: str(body.keyName) ?? str(body.key_name) ?? `${result.data.agent.name}-key`,
              });
            }
          }
        }
      }

      return json({
        ok: true,
        agent: result.data.agent,
        ...(key
          ? {
              key: {
                id: key.id,
                projectId: key.projectId,
                agentId: key.agentId,
                name: key.name,
                keyPrefix: key.keyPrefix,
                keySuffix: key.keySuffix,
                secret: key.secret,
                createdAt: key.createdAt,
              },
            }
          : {}),
        ...(keyError ? { keyError } : {}),
        issuedKey: Boolean(key),
      });
    }

    // PATCH /agents/:id — edit role, skills, status, harness (operator)
    if (parts.length === 2 && parts[0] === "agents" && req.method === "PATCH") {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const harness = str(body.harness) as HarnessKind | undefined;
      if (harness && !HARNESSES.has(harness)) {
        return err(400, `Invalid harness. One of: ${[...HARNESSES].join(", ")}`, "bad_request");
      }
      const status = str(body.status) as import("./types").AgentStatus | undefined;
      const result = await boardOps.updateAgent(parts[1]!, {
        role: str(body.role),
        skills: strArr(body.skills),
        status,
        harness,
        notes: str(body.notes),
      });
      return fromEngine(result);
    }

    // GET /calls
    if (parts.length === 1 && parts[0] === "calls" && req.method === "GET") {
      const snap = await boardOps.snapshot();
      const openOnly = url.searchParams.get("open") !== "0";
      const calls = openOnly ? snap.calls.filter((c) => !c.resolvedAt) : snap.calls;
      return json({ ok: true, calls });
    }

    // POST /calls/:id/reply
    if (parts.length === 3 && parts[0] === "calls" && parts[2] === "reply" && req.method === "POST") {
      const gate = await requireOperatorCap(req, "reply_call");
      if (gate) return gate;
      const reply = str(body.reply);
      if (!reply) return err(400, "reply is required", "bad_request");
      const { result, webhook } = await boardOps.replyToCallWithWebhook(parts[1]!, reply);
      if (!result.ok) return fromEngine(result);
      return json({ ok: true, ...result.data, webhook });
    }

    // GET /export?history=1 — audit history (must win over plain export)
    if (
      parts.length === 1 &&
      parts[0] === "export" &&
      url.searchParams.get("history") === "1" &&
      req.method === "GET"
    ) {
      const format = (url.searchParams.get("format") ?? "json") === "csv" ? "csv" : "json";
      const exp = await boardOps.exportHistory({
        projectId: projectRef(url),
        missionId: url.searchParams.get("mission") ?? url.searchParams.get("mission_id"),
        format,
      });
      if (format === "csv") {
        return new Response(exp.body, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="mission-history.csv"',
            "cache-control": "no-store",
          },
        });
      }
      return json({ ok: true, count: exp.count, history: JSON.parse(exp.body) });
    }

    // GET /export — active board snapshot
    if (parts.length === 1 && parts[0] === "export" && req.method === "GET") {
      return json({ ok: true, ...(await boardOps.exportActive()) });
    }

    // POST /reset
    if (parts.length === 1 && parts[0] === "reset" && req.method === "POST") {
      const gate = await requireOperatorCap(req, "reset_demo");
      if (gate) return gate;
      const board = await boardOps.reset();
      return json({
        ok: true,
        message: "Demo board reset",
        missions: board.missions.length,
        agents: board.agents.length,
      });
    }

    // GET /summary — deterministic ticket/sprint rollup (AI-style, no external LLM)
    if (parts.length === 1 && parts[0] === "summary" && req.method === "GET") {
      const gate = await requireOperatorCap(req, "read");
      if (gate) return gate;
      const pref = projectRef(url);
      const ctx = await loadOperatorContext(req);
      let missions;
      if (pref) {
        const access = await requireOperatorProjectAccess(req, pref);
        if (access instanceof Response) return access;
        const snap = await boardOps.snapshot(access);
        missions = snap.missions;
      } else {
        let allowed: string[] | null = null;
        if (ctx.authRequired && ctx.user) {
          allowed = await resolveReadableProjectIds(ctx, {
            adminAll: ctx.role === "admin" && url.searchParams.get("all") === "1",
          });
        }
        const snap = await boardOps.adminSnapshot("all", { allowedProjectIds: allowed });
        missions = snap.missions;
      }
      const columnFilter = url.searchParams.get("columns")?.split(",").filter(Boolean);
      if (columnFilter?.length) {
        const set = new Set(columnFilter);
        missions = missions.filter((m) => set.has(m.column));
      }
      const summary = summarizeTickets({
        missions,
        scopeLabel: pref ?? "All boards",
      });
      return json({ ok: true, ...summary });
    }

    // GET /stale — list stale running missions (ops reliability)
    if (parts.length === 1 && parts[0] === "stale" && req.method === "GET") {
      const snap = await boardOps.snapshot(projectRef(url));
      const policy = policyFromEnv();
      const now = Date.now();
      const summary = staleSummary(snap.missions, now, policy);
      return json({
        ok: true,
        ...summary,
        policy,
        missions: snap.missions.filter((m) => summary.staleIds.includes(m.id)),
      });
    }

    // GET /events/stream — SSE for Live (server-side delta; client reconnects)
    if (parts.length === 2 && parts[0] === "events" && parts[1] === "stream" && req.method === "GET") {
      const pref = url.searchParams.get("project") ?? url.searchParams.get("board");
      const wantAll = !pref || pref === "all" || pref === "*" || pref === "__all__";
      const ctx = await loadOperatorContext(req);
      const adminAll =
        ctx.role === "admin" && url.searchParams.get("all") === "1";
      let allowedProjectIds: string[] | null = null;
      if (ctx.authRequired && ctx.user) {
        allowedProjectIds = await resolveReadableProjectIds(ctx, { adminAll });
      }
      let scopedProject: string | null = null;
      if (!wantAll && pref) {
        const access = await requireOperatorProjectAccess(req, pref, { adminAll });
        if (access instanceof Response) return access;
        scopedProject = access;
      }
      const encoder = new TextEncoder();
      let closed = false;
      let lastSig = "";
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, data: unknown) => {
            if (closed) return;
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };
          send("hello", {
            ok: true,
            projectId: scopedProject,
            scope: wantAll ? "all" : "board",
            tickMs: 1200,
          });
          const tick = async () => {
            if (closed) return;
            try {
              const snap = await boardOps.adminSnapshot(wantAll ? "all" : scopedProject, {
                allowedProjectIds,
              });
              const latestEv = snap.events[0];
              const latestHist = snap.history[0];
              const sig = [
                latestEv?.id ?? "",
                latestHist?.id ?? "",
                snap.missions.length,
                snap.calls.filter((c) => !c.resolvedAt).length,
                snap.stats.byColumn?.running ?? 0,
              ].join(":");
              if (sig !== lastSig) {
                lastSig = sig;
                send("board", {
                  at: Date.now(),
                  projectId: scopedProject,
                  scope: wantAll ? "all" : "board",
                  eventCount: snap.events.length,
                  historyCount: snap.history.length,
                  missionCount: snap.missions.length,
                  openCalls: snap.calls.filter((c) => !c.resolvedAt).length,
                  latestEvent: latestEv ?? null,
                  latestHistory: latestHist
                    ? {
                        id: latestHist.id,
                        missionId: latestHist.missionId,
                        toColumn: latestHist.toColumn,
                        at: latestHist.at,
                      }
                    : null,
                  stale: staleSummary(snap.missions, Date.now(), policyFromEnv()),
                  // Hint client to full-refresh payload (events/history bodies)
                  refresh: true,
                });
              } else {
                send("ping", { at: Date.now() });
              }
            } catch (e) {
              send("error", { message: e instanceof Error ? e.message : "tick failed" });
            }
          };
          void tick();
          const iv = setInterval(() => void tick(), 1200);
          // Long-lived stream; client EventSource reconnects on close
          const t = setTimeout(() => {
            clearInterval(iv);
            if (!closed) {
              closed = true;
              try {
                send("bye", { at: Date.now(), reason: "rotate" });
                controller.close();
              } catch {
                /* ignore */
              }
            }
          }, 5 * 60_000);
          // @ts-expect-error attach for cancel
          controller._iv = iv;
          // @ts-expect-error attach for cancel
          controller._t = t;
        },
        cancel() {
          closed = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        },
      });
    }


    // GET /admin — operator live dashboard payload (events + history + board)
    // ?project=<id> one board · ?project=all (or omit) all boards the user can see
    if (parts.length === 1 && parts[0] === "admin" && req.method === "GET") {
      const pref = url.searchParams.get("project") ?? url.searchParams.get("board");
      const wantAll =
        !pref || pref === "all" || pref === "*" || pref === "__all__";
      const ctx = await loadOperatorContext(req);
      const adminAll =
        ctx.role === "admin" && url.searchParams.get("all") === "1";
      let allowedProjectIds: string[] | null = null;
      if (ctx.authRequired && ctx.user) {
        allowedProjectIds = await resolveReadableProjectIds(ctx, { adminAll });
      }
      if (!wantAll && pref) {
        const access = await requireOperatorProjectAccess(req, pref, { adminAll });
        if (access instanceof Response) return access;
        const snap = await boardOps.adminSnapshot(access, { allowedProjectIds });
        return json({
          ok: true,
          projectId: access,
          scope: "board" as const,
          ...snap,
        });
      }
      const snap = await boardOps.adminSnapshot("all", { allowedProjectIds });
      return json({
        ok: true,
        projectId: null,
        scope: "all" as const,
        ...snap,
      });
    }

    // GET|POST /projects  (product language: boards — /boards is an alias)
    if (
      parts.length === 1 &&
      (parts[0] === "projects" || parts[0] === "boards") &&
      req.method === "GET"
    ) {
      const ctx = await loadOperatorContext(req);
      const adminAll =
        ctx.role === "admin" && url.searchParams.get("all") === "1";
      const includeArchived =
        url.searchParams.get("archived") === "1" ||
        url.searchParams.get("include_archived") === "1";
      const boards =
        ctx.authRequired && ctx.user
          ? await boardOps.listProjects({
              ownerUserId: ctx.user.id,
              includeShared: true,
              admin: adminAll,
              includeArchived,
            })
          : await boardOps.listProjects({ admin: true, includeArchived });
      return json({ ok: true, boards, projects: boards });
    }
    if (
      parts.length === 1 &&
      (parts[0] === "projects" || parts[0] === "boards") &&
      req.method === "POST"
    ) {
      // Any signed-in operator+ can create their own board (not admin-only).
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const ctx = await loadOperatorContext(req);
      const name = str(body.name);
      if (!name) return err(400, "name is required", "bad_request");
      const board = await boardOps.createProject({
        name,
        slug: str(body.slug),
        description: str(body.description),
        ownerUserId: ctx.user?.id ?? null,
      });
      return json({ ok: true, board, project: board });
    }

    // POST /boards/:id/archive | unarchive
    if (
      parts.length === 3 &&
      (parts[0] === "projects" || parts[0] === "boards") &&
      (parts[2] === "archive" || parts[2] === "unarchive") &&
      req.method === "POST"
    ) {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const ctx = await loadOperatorContext(req);
      const boardId = parts[1]!;
      const existing = await boardOps.getProject(boardId);
      if (!existing) return err(404, "board not found", "not_found");
      if (
        ctx.authRequired &&
        ctx.user &&
        existing.ownerUserId &&
        existing.ownerUserId !== ctx.user.id &&
        ctx.role !== "admin"
      ) {
        return err(403, "Not your board", "forbidden");
      }
      const board =
        parts[2] === "archive"
          ? await boardOps.archiveProject(boardId)
          : await boardOps.unarchiveProject(boardId);
      return json({ ok: true, board, project: board });
    }

    // DELETE /boards/:id — hard delete (owner or admin)
    if (
      parts.length === 2 &&
      (parts[0] === "projects" || parts[0] === "boards") &&
      req.method === "DELETE"
    ) {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const ctx = await loadOperatorContext(req);
      const boardId = parts[1]!;
      const existing = await boardOps.getProject(boardId);
      if (!existing) return err(404, "board not found", "not_found");
      if (
        ctx.authRequired &&
        ctx.user &&
        existing.ownerUserId &&
        existing.ownerUserId !== ctx.user.id &&
        ctx.role !== "admin"
      ) {
        return err(403, "Not your board", "forbidden");
      }
      try {
        const deleted = await boardOps.deleteProject(boardId, {
          force: ctx.role === "admin" && body.force === true,
        });
        return json({ ok: true, deleted });
      } catch (e) {
        return err(
          400,
          e instanceof Error ? e.message : String(e),
          "bad_request",
        );
      }
    }

    // POST /webhooks/github — signed issue/PR ingest
    if (
      parts.length === 2 &&
      parts[0] === "webhooks" &&
      parts[1] === "github" &&
      req.method === "POST"
    ) {
      const projectId = projectRef(url, body) ?? str(body.projectId) ?? "proj_default";
      const settings = await boardOps.getProjectSettings(projectId);
      const envSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
      const secret = settings.githubWebhookSecret?.trim() || envSecret || "";
      if (secret) {
        const sig = req.headers.get("x-hub-signature-256");
        if (!verifyGitHubSignature(rawBody, sig, secret)) {
          return err(401, "Invalid GitHub webhook signature", "unauthorized");
        }
      }
      try {
        const eventName = (
          req.headers.get("x-github-event") ??
          str(body.action) ??
          ""
        ).toLowerCase();

        // Issue comment: `/relay reply …` resolves open Call on linked mission
        if (
          eventName === "issue_comment" ||
          (body.comment && body.issue && !body.pull_request)
        ) {
          const comment = body.comment as { body?: string } | undefined;
          const issue = body.issue as { number?: number; pull_request?: unknown } | undefined;
          const reply = parseRelayReplyComment(comment?.body);
          if (reply && issue?.number != null && !issue.pull_request) {
            const repo =
              (body.repository as { full_name?: string } | undefined)?.full_name ?? "";
            const externalId = githubExternalId(repo, issue.number);
            const mission = await boardOps.findMissionByExternalId(externalId, projectId);
            if (!mission) {
              return json({
                ok: true,
                relay_reply: false,
                reason: "no_linked_mission",
                externalId,
              });
            }
            const openCall = (await boardOps.snapshot(projectId)).calls.find(
              (c) => c.missionId === mission.id && !c.resolvedAt,
            );
            if (!openCall) {
              return json({
                ok: true,
                relay_reply: false,
                reason: "no_open_call",
                missionId: mission.id,
              });
            }
            const { result, webhook } = await boardOps.replyToCallWithWebhook(
              openCall.id,
              reply,
              "github",
            );
            if (!result.ok) return fromEngine(result);
            return json({
              ok: true,
              relay_reply: true,
              missionId: mission.id,
              callId: openCall.id,
              webhook,
              ...result.data,
            });
          }
        }

        // PR / check / workflow artifact attach
        if (
          eventName.includes("pull_request") ||
          eventName.includes("check_run") ||
          eventName.includes("workflow_run") ||
          body.pull_request ||
          body.check_run ||
          body.workflow_run
        ) {
          const art = extractArtifactFromGitHubPayload(body);
          if (art) {
            const ids = art.externalIds?.length
              ? art.externalIds
              : art.externalId
                ? [art.externalId]
                : [];
            const attached: string[] = [];
            for (const ext of ids) {
              const mission = await boardOps.findMissionByExternalId(ext, projectId);
              if (mission) {
                await boardOps.attachMissionArtifact(mission.id, art.url, art.note);
                attached.push(mission.id);
              }
            }
            if (!attached.length && str(body.mission_id)) {
              const m = await boardOps.attachMissionArtifact(
                str(body.mission_id)!,
                art.url,
                art.note,
              );
              if (m) attached.push(m.id);
            }
            return json({
              ok: true,
              attached: attached.length > 0,
              missionIds: attached,
              artifact: art,
              reason: attached.length ? undefined : "no_linked_mission",
            });
          }
        }
        if (body.issue) {
          const result = await boardOps.ingestGitHubIssue({
            action: str(body.action),
            issue: body.issue as any,
            repository: body.repository as any,
            projectId,
          });
          return json({ ok: true, ...result });
        }
        return json({ ok: true, ignored: true, event: eventName });
      } catch (e) {
        return err(400, e instanceof Error ? e.message : "ingest failed", "bad_request");
      }
    }

    // POST /ingest/github/artifact — attach PR/check URL to mission
    if (parts.length === 3 && parts[0] === "ingest" && parts[1] === "github" && parts[2] === "artifact" && req.method === "POST") {
      const art = extractArtifactFromGitHubPayload(body);
      const missionId = str(body.mission_id) ?? str(body.missionId);
      const urlA = str(body.url) ?? art?.url;
      if (!missionId || !urlA) return err(400, "mission_id and url required", "bad_request");
      const m = await boardOps.attachMissionArtifact(missionId, urlA, str(body.note) ?? art?.note);
      if (!m) return err(404, "mission not found", "mission_not_found");
      return json({ ok: true, mission: m });
    }

    // POST /ingest/github — same as webhook (testable without GH)
    if (parts.length === 2 && parts[0] === "ingest" && parts[1] === "github" && req.method === "POST") {
      try {
        const result = await boardOps.ingestGitHubIssue({
          action: str(body.action),
          issue: (body.issue ?? body) as any,
          repository: body.repository as any,
          projectId: str(body.projectId) ?? str(body.project) ?? projectRef(url, body),
        });
        return json({ ok: true, ...result });
      } catch (e) {
        return err(400, e instanceof Error ? e.message : "ingest failed", "bad_request");
      }
    }

    // GET /missions/:id/journal.md
    if (
      parts.length === 3 &&
      parts[0] === "missions" &&
      parts[2] === "journal.md" &&
      req.method === "GET"
    ) {
      const m = await boardOps.getMission(parts[1]!);
      if (!m) return err(404, "mission not found", "mission_not_found");
      const denied = await assertCanReadMission(req, machineAuth, m);
      if (denied) return denied;
      const md = await boardOps.journalMarkdown(parts[1]!);
      if (!md) return err(404, "mission not found", "mission_not_found");
      return new Response(md, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // GET /missions/:id/journal (json wrapper)
    if (
      parts.length === 3 &&
      parts[0] === "missions" &&
      parts[2] === "journal" &&
      req.method === "GET"
    ) {
      const m = await boardOps.getMission(parts[1]!);
      if (!m) return err(404, "mission not found", "mission_not_found");
      const denied = await assertCanReadMission(req, machineAuth, m);
      if (denied) return denied;
      const md = await boardOps.journalMarkdown(parts[1]!);
      if (!md) return err(404, "mission not found", "mission_not_found");
      return json({ ok: true, mission_id: parts[1], markdown: md });
    }

    // GET /board — full snapshot for UI
    // ?project=<id> one board · ?project=all (or omit) all boards the user can see
    // Agents are always the operator's full fleet (not board-filtered) so the
    // Agents tab can list every real client (e.g. frodo) regardless of rail.
    if (parts.length === 1 && parts[0] === "board" && req.method === "GET") {
      const pref = url.searchParams.get("project") ?? url.searchParams.get("board");
      const wantAll = !pref || pref === "all" || pref === "*" || pref === "__all__";
      const ctx = await loadOperatorContext(req);
      const adminAll =
        ctx.role === "admin" && url.searchParams.get("all") === "1";
      let allowedProjectIds: string[] | null = null;
      if (ctx.authRequired && ctx.user) {
        allowedProjectIds = await resolveReadableProjectIds(ctx, { adminAll });
      }
      const fleet = await boardOps.listFleetAgents(allowedProjectIds);
      if (wantAll) {
        const snap = await boardOps.adminSnapshot("all", { allowedProjectIds });
        return json({
          ok: true,
          projectId: null,
          scope: "all" as const,
          agents: fleet,
          missions: snap.missions,
          events: snap.events,
          calls: snap.calls,
        });
      }
      const access = await requireOperatorProjectAccess(req, pref!, { adminAll });
      if (access instanceof Response) return access;
      const snap = await boardOps.snapshot(access);
      return json({
        ok: true,
        projectId: access,
        scope: "board" as const,
        agents: fleet,
        missions: snap.missions,
        events: snap.events,
        calls: snap.calls,
      });
    }

    // GET /missions/:id/history
    if (parts.length === 3 && parts[0] === "missions" && parts[2] === "history" && req.method === "GET") {
      const m = await boardOps.getMission(parts[1]!);
      if (!m) return err(404, `Unknown mission: ${parts[1]}`, "mission_not_found");
      const denied = await assertCanReadMission(req, machineAuth, m);
      if (denied) return denied;
      const hist = await boardOps.history(parts[1]!);
      return json({ ok: true, mission_id: parts[1], history: hist });
    }

    // POST /missions/:id/move  { column, actor? }
    if (parts.length === 3 && parts[0] === "missions" && parts[2] === "move" && req.method === "POST") {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const access = await assertOperatorCanWriteMission(req, parts[1]!);
      if (access instanceof Response) return access;
      const column = str(body.column) as MissionColumn | undefined;
      if (!column) return err(400, "column is required", "bad_request");
      const actor = str(body.actor) ?? "operator";
      return fromEngine(await boardOps.moveMission(parts[1]!, column, actor));
    }

    // POST /missions/:id/transfer  { project | projectId } — move to another board
    if (
      parts.length === 3 &&
      parts[0] === "missions" &&
      (parts[2] === "transfer" || parts[2] === "reboard") &&
      req.method === "POST"
    ) {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const access = await assertOperatorCanWriteMission(req, parts[1]!);
      if (access instanceof Response) return access;
      const raw =
        str(body.projectId) ?? str(body.project) ?? str(body.board) ?? str(body.boardId);
      if (!raw) return err(400, "project (board id or slug) required", "bad_request");
      const targetAccess = await requireOperatorProjectAccess(req, raw);
      if (targetAccess instanceof Response) return targetAccess;
      const result = await boardOps.moveMissionToProject(
        parts[1]!,
        targetAccess,
        str(body.actor) ?? "operator",
      );
      if (!result.ok) return err(result.status, result.error, result.code);
      return json({ ok: true, mission: result.mission });
    }

    // PATCH /missions/:id — operator edit title/body fields
    if (parts.length === 2 && parts[0] === "missions" && req.method === "PATCH") {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const access = await assertOperatorCanWriteMission(req, parts[1]!);
      if (access instanceof Response) return access;
      const result = await boardOps.updateMissionFields(parts[1]!, {
        title: str(body.title),
        objective: str(body.objective),
        context: str(body.context),
        constraints: str(body.constraints),
        acceptance: str(body.acceptance),
        priority: str(body.priority) as Priority | undefined,
        tags: strArr(body.tags),
      });
      if (!result.ok) return err(result.status, result.error, result.code);
      return json({ ok: true, mission: result.mission });
    }

    // POST /missions  create
    // Operators (session) or client agents (ark_ key on an allowed board).
    if (parts.length === 1 && parts[0] === "missions" && req.method === "POST") {
      const title = str(body.title);
      const objective = str(body.objective);
      if (!title || !objective) return err(400, "title and objective required", "bad_request");

      const created = await createMissionForCaller({
        req,
        body,
        url,
        machineAuth,
        title,
        objective,
      });
      return created;
    }


    // --- API keys ---
    if (parts.length === 1 && parts[0] === "keys" && req.method === "GET") {
      const gate = await requireOperatorCap(req, "manage_keys");
      if (gate) return gate;
      const ctx = await loadOperatorContext(req);
      const agentId = url.searchParams.get("agent") ?? url.searchParams.get("agent_id");
      if (agentId?.trim()) {
        const keys = await boardOps.listAgentApiKeys(agentId.trim());
        const filtered = [];
        for (const k of keys) {
          if (await operatorCanAccessProject(ctx, k.projectId)) filtered.push(k);
        }
        return json({ ok: true, keys: filtered });
      }
      const rawProject = projectRef(url, body) ?? "proj_default";
      const projectAccess = await requireOperatorProjectAccess(req, rawProject);
      if (projectAccess instanceof Response) return projectAccess;
      const keys = await boardOps.listApiKeys(projectAccess);
      return json({ ok: true, keys });
    }
    // GET|POST /keys/:id/reveal — operator unseals full secret (when stored)
    if (
      parts.length === 3 &&
      parts[0] === "keys" &&
      parts[2] === "reveal" &&
      (req.method === "GET" || req.method === "POST")
    ) {
      const gate = await requireOperatorCap(req, "manage_keys");
      if (gate) return gate;
      const meta = await boardOps.getApiKeyMeta(parts[1]!);
      if (!meta) return err(404, "key not found", "not_found");
      const ctx = await loadOperatorContext(req);
      if (!(await operatorCanAccessProject(ctx, meta.projectId))) {
        return err(404, "key not found", "not_found");
      }
      const revealed = await boardOps.revealApiKey(parts[1]!);
      if (!revealed) return err(404, "key not found", "not_found");
      if (!revealed.ok) {
        if (revealed.error === "key_revoked") {
          return err(410, "Key is revoked", "key_revoked");
        }
        return json(
          {
            ok: false,
            error:
              "This key was issued before reveal storage. Issue a new key to enable reveal.",
            code: "not_revealable",
            keyPrefix: revealed.keyPrefix,
            keySuffix: revealed.keySuffix,
          },
          409,
        );
      }
      return json({
        ok: true,
        key: {
          id: revealed.id,
          projectId: revealed.projectId,
          agentId: revealed.agentId,
          name: revealed.name,
          keyPrefix: revealed.keyPrefix,
          keySuffix: revealed.keySuffix,
          secret: revealed.secret,
        },
      });
    }
    if (parts.length === 1 && parts[0] === "keys" && req.method === "POST") {
      const gate = await requireOperatorCap(req, "manage_keys");
      if (gate) return gate;
      const rawProject =
        str(body.projectId) ?? str(body.project) ?? projectRef(url, body) ?? "proj_default";
      const projectAccess = await requireOperatorProjectAccess(req, rawProject);
      if (projectAccess instanceof Response) return projectAccess;
      const agentId = str(body.agentId) ?? str(body.agent) ?? null;
      const allowShared = body.allowShared === true || body.shared === true;
      // Practical flow: keys bind to a registered agent (unless explicit shared).
      if (!agentId && !allowShared) {
        return err(
          400,
          "Select a registered agent for this key (or pass allowShared:true for a board-wide key).",
          "agent_required",
        );
      }
      let boundAgentId: string | null = null;
      if (agentId) {
        const snap = await boardOps.snapshot();
        const ag = snap.agents.find(
          (a) => a.id === agentId || a.name.toLowerCase() === agentId.toLowerCase(),
        );
        if (!ag) {
          return err(
            400,
            "Unknown agent — register the agent on the roster first, then create a key for them.",
            "agent_not_found",
          );
        }
        if (ag.isDemo) {
          return err(400, "Cannot issue keys for demo agents. Register a real agent first.", "demo_agent");
        }
        boundAgentId = ag.id;
      }
      const created = await boardOps.createApiKey({
        projectId: projectAccess,
        agentId: boundAgentId,
        name: str(body.name),
      });
      return json({ ok: true, key: created });
    }
    if (parts.length === 2 && parts[0] === "keys" && req.method === "DELETE") {
      const gate = await requireOperatorCap(req, "manage_keys");
      if (gate) return gate;
      const meta = await boardOps.getApiKeyMeta(parts[1]!);
      if (!meta) return err(404, "key not found", "not_found");
      const ctx = await loadOperatorContext(req);
      if (!(await operatorCanAccessProject(ctx, meta.projectId))) {
        return err(404, "key not found", "not_found");
      }
      await boardOps.revokeApiKey(parts[1]!);
      return json({ ok: true, revoked: parts[1] });
    }
    if (parts.length === 3 && parts[0] === "keys" && parts[2] === "revoke" && req.method === "POST") {
      const gate = await requireOperatorCap(req, "manage_keys");
      if (gate) return gate;
      const meta = await boardOps.getApiKeyMeta(parts[1]!);
      if (!meta) return err(404, "key not found", "not_found");
      const ctx = await loadOperatorContext(req);
      if (!(await operatorCanAccessProject(ctx, meta.projectId))) {
        return err(404, "key not found", "not_found");
      }
      await boardOps.revokeApiKey(parts[1]!);
      return json({ ok: true, revoked: parts[1] });
    }

    // POST /roles — admin assigns operator role
    if (parts.length === 1 && parts[0] === "roles" && req.method === "POST") {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const userId = str(body.userId) ?? str(body.user_id);
      const role = str(body.role);
      if (!userId || (role !== "viewer" && role !== "operator" && role !== "admin")) {
        return err(400, "userId and role (viewer|operator|admin) required", "bad_request");
      }
      const saved = await boardOps.setOperatorRole({
        userId,
        email: str(body.email) ?? null,
        role,
      });
      return json({ ok: true, role: saved });
    }

    // ── Platform admin (separate admin.* host / manage_roles) ──────────
    // GET /admin/users
    if (
      parts.length === 2 &&
      parts[0] === "admin" &&
      parts[1] === "users" &&
      req.method === "GET"
    ) {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const users = await boardOps.listPlatformUsers();
      return json({ ok: true, users });
    }
    // POST /admin/users  { email, password, name?, role? } — invite/create
    if (
      parts.length === 2 &&
      parts[0] === "admin" &&
      parts[1] === "users" &&
      req.method === "POST"
    ) {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const email = str(body.email);
      const password = str(body.password);
      if (!email || !password) {
        return err(400, "email and password required", "bad_request");
      }
      try {
        const user = await boardOps.adminCreateUser({
          email,
          password,
          name: str(body.name) ?? undefined,
          role: str(body.role) ?? "operator",
          emailVerified: body.emailVerified !== false && body.email_verified !== false,
        });
        return json({ ok: true, user }, 201);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "create failed";
        const status = /already exists/i.test(msg) ? 409 : 400;
        return err(status, msg, status === 409 ? "conflict" : "bad_request");
      }
    }
    // POST /admin/users/:id/disable | /enable
    if (
      parts.length === 4 &&
      parts[0] === "admin" &&
      parts[1] === "users" &&
      (parts[3] === "disable" || parts[3] === "enable") &&
      req.method === "POST"
    ) {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const userId = parts[2]!;
      const ctx = await loadOperatorContext(req);
      if (ctx.user?.id === userId && parts[3] === "disable") {
        return err(400, "cannot disable your own account", "bad_request");
      }
      const result = await boardOps.setUserDisabled({
        userId,
        disabled: parts[3] === "disable",
        reason: str(body.reason) ?? str(body.disabled_reason),
      });
      return json({ ok: true, ...result });
    }
    // POST /admin/users/:id/reset-password { password }
    if (
      parts.length === 4 &&
      parts[0] === "admin" &&
      parts[1] === "users" &&
      (parts[3] === "reset-password" || parts[3] === "reset_password") &&
      req.method === "POST"
    ) {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const password = str(body.password) ?? str(body.newPassword);
      if (!password) return err(400, "password required", "bad_request");
      try {
        const result = await boardOps.adminResetUserPassword({
          userId: parts[2]!,
          password,
        });
        return json({ ok: true, ...result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "reset failed";
        return err(/not found/i.test(msg) ? 404 : 400, msg, "bad_request");
      }
    }
    // GET /admin/usage?range=7d|30d
    if (
      parts.length === 2 &&
      parts[0] === "admin" &&
      parts[1] === "usage" &&
      req.method === "GET"
    ) {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const rangeRaw = (url.searchParams.get("range") ?? "7d").toLowerCase();
      const days = rangeRaw.endsWith("d")
        ? Number(rangeRaw.slice(0, -1))
        : Number(rangeRaw);
      const usage = await boardOps.platformUsage(Number.isFinite(days) ? days : 7);
      return json({ ok: true, ...usage });
    }
    // GET /admin/boards
    if (
      parts.length === 2 &&
      parts[0] === "admin" &&
      parts[1] === "boards" &&
      req.method === "GET"
    ) {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const includeArchived =
        url.searchParams.get("archived") === "1" ||
        url.searchParams.get("include_archived") === "1";
      const boards = await boardOps.listPlatformBoards({ includeArchived });
      return json({ ok: true, boards });
    }
    // POST /admin/boards/:id/transfer { userId | email | ownerUserId | null for shared }
    if (
      parts.length === 4 &&
      parts[0] === "admin" &&
      parts[1] === "boards" &&
      parts[3] === "transfer" &&
      req.method === "POST"
    ) {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const boardId = parts[2]!;
      const existing = await boardOps.getProject(boardId);
      if (!existing) return err(404, "board not found", "not_found");
      let owner: string | null =
        str(body.userId) ?? str(body.ownerUserId) ?? str(body.owner_user_id) ?? null;
      if (body.shared === true || body.clearOwner === true) owner = null;
      const email = str(body.email);
      if (!owner && email) {
        const users = await boardOps.listPlatformUsers();
        const hit = users.find(
          (u) => u.email && u.email.toLowerCase() === email.toLowerCase(),
        );
        if (!hit) return err(404, "user not found for email", "user_not_found");
        owner = hit.id;
      }
      const board = await boardOps.transferBoardOwnership(boardId, owner);
      return json({ ok: true, board });
    }
    // GET /admin/agents — fleet oversight
    if (
      parts.length === 2 &&
      parts[0] === "admin" &&
      parts[1] === "agents" &&
      req.method === "GET"
    ) {
      const gate = await requireOperatorCap(req, "manage_roles");
      if (gate) return gate;
      const agents = await boardOps.listPlatformAgents();
      return json({ ok: true, agents });
    }

    // POST /missions/bulk-move { ids, column } — operator Accept All etc.
    if (
      parts.length === 2 &&
      parts[0] === "missions" &&
      parts[1] === "bulk-move" &&
      req.method === "POST"
    ) {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const ids = strArr(body.ids) ?? strArr(body.missionIds) ?? [];
      const column = str(body.column) as MissionColumn | undefined;
      if (!ids.length || !column) {
        return err(400, "ids[] and column required", "bad_request");
      }
      const ctx = await loadOperatorContext(req);
      const allowed: string[] = [];
      for (const id of ids) {
        const m = await boardOps.getMission(id);
        if (!m) continue;
        if (await operatorCanAccessProject(ctx, m.projectId)) allowed.push(id);
      }
      const result = await boardOps.bulkMoveMissions(
        allowed,
        column,
        str(body.actor) ?? "operator",
      );
      return json({ ok: true, ...result, requested: ids.length, allowed: allowed.length });
    }

    // POST /agents/:id/boards  { project | projectId } — grant membership
    if (
      parts.length === 3 &&
      parts[0] === "agents" &&
      parts[2] === "boards" &&
      req.method === "POST"
    ) {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const raw =
        str(body.projectId) ?? str(body.project) ?? str(body.board) ?? str(body.boardId);
      if (!raw) return err(400, "project (board id or slug) required", "bad_request");
      const projectAccess = await requireOperatorProjectAccess(req, raw);
      if (projectAccess instanceof Response) return projectAccess;
      const agentRef = parts[1]!;
      const profile = await boardOps.getAgentProfile(agentRef);
      if (!profile?.agent) return err(404, "agent not found", "agent_not_found");
      await boardOps.grantBoardAccess(profile.agent.id, projectAccess);
      const next = await boardOps.getAgentProfile(profile.agent.id);
      return json({ ok: true, agent: next?.agent ?? profile.agent, boardIds: next?.agent.boardIds ?? [] });
    }
    // DELETE /agents/:id/boards/:projectId — revoke membership
    if (
      parts.length === 4 &&
      parts[0] === "agents" &&
      parts[2] === "boards" &&
      req.method === "DELETE"
    ) {
      const gate = await requireOperatorCap(req, "write_board");
      if (gate) return gate;
      const projectAccess = await requireOperatorProjectAccess(req, parts[3]!);
      if (projectAccess instanceof Response) return projectAccess;
      const agentRef = parts[1]!;
      const profile = await boardOps.getAgentProfile(agentRef);
      if (!profile?.agent) return err(404, "agent not found", "agent_not_found");
      await boardOps.revokeBoardAccess(profile.agent.id, projectAccess);
      const next = await boardOps.getAgentProfile(profile.agent.id);
      return json({ ok: true, agent: next?.agent ?? profile.agent, boardIds: next?.agent.boardIds ?? [] });
    }

    // --- project settings ---
    if (parts.length === 2 && parts[0] === "projects" && parts[1] && req.method === "GET") {
      // fallthrough if not settings
    }
    if (parts.length === 3 && parts[0] === "projects" && parts[2] === "settings" && req.method === "GET") {
      const gate = await requireOperatorCap(req, "read");
      if (gate) return gate;
      const projectAccess = await requireOperatorProjectAccess(req, parts[1]!);
      if (projectAccess instanceof Response) return projectAccess;
      const s = await boardOps.getProjectSettings(projectAccess);
      return json({
        ok: true,
        settings: {
          projectId: s.projectId,
          githubRepo: s.githubRepo,
          replyWebhookUrl: s.replyWebhookUrl,
          hasGithubSecret: s.hasGithubSecret,
          githubConnect: {
            webhookPath: `/api/agent/webhooks/github?project=${encodeURIComponent(s.projectId)}`,
            ingestPath: "/api/agent/ingest/github",
            guidance:
              "1) Create a GitHub webhook (or App) on the mapped repo. 2) Set content-type application/json. 3) Paste the webhook secret here. 4) Point the payload URL at webhookPath on this host. 5) Issue events create missions with stable external_id github:owner/repo#n.",
          },
        },
      });
    }
    if (parts.length === 3 && parts[0] === "projects" && parts[2] === "settings" && req.method === "POST") {
      const gate = await requireOperatorCap(req, "manage_settings");
      if (gate) return gate;
      const projectAccess = await requireOperatorProjectAccess(req, parts[1]!);
      if (projectAccess instanceof Response) return projectAccess;
      const s = await boardOps.updateProjectSettings(projectAccess, {
        githubWebhookSecret: body.githubWebhookSecret === undefined ? undefined : (str(body.githubWebhookSecret) ?? null),
        githubRepo: body.githubRepo === undefined ? undefined : (str(body.githubRepo) ?? null),
        replyWebhookUrl: body.replyWebhookUrl === undefined ? undefined : (str(body.replyWebhookUrl) ?? null),
      });
      return json({
        ok: true,
        settings: {
          projectId: s.projectId,
          githubRepo: s.githubRepo,
          replyWebhookUrl: s.replyWebhookUrl,
          hasGithubSecret: s.hasGithubSecret,
        },
      });
    }

    // attach artifact
    if (parts.length === 3 && parts[0] === "missions" && parts[2] === "artifacts" && req.method === "POST") {
      const urlA = str(body.url) ?? str(body.html_url);
      if (!urlA) return err(400, "url required", "bad_request");
      if (machineAuth.type === "browser" || machineAuth.type === "open") {
        const gate = await requireOperatorCap(req, "write_board");
        if (gate) return gate;
        const access = await assertOperatorCanWriteMission(req, parts[1]!);
        if (access instanceof Response) return access;
      } else if (machineAuth.type === "ark") {
        const existing = await boardOps.getMission(parts[1]!);
        if (!existing) return err(404, "mission not found", "mission_not_found");
        const denied = await assertCanReadMission(req, machineAuth, existing);
        if (denied) return denied;
      }
      const m = await boardOps.attachMissionArtifact(parts[1]!, urlA, str(body.note));
      if (!m) return err(404, "mission not found", "mission_not_found");
      return json({ ok: true, mission: m });
    }

    // GET|POST /me/prefs — operator UI preferences (theme, …)
    if (
      parts.length === 2 &&
      parts[0] === "me" &&
      parts[1] === "prefs" &&
      (req.method === "GET" || req.method === "POST")
    ) {
      const gate = await requireOperatorCap(req, "read");
      if (gate) return gate;
      const ctx = await loadOperatorContext(req);
      if (!ctx.user?.id) {
        return err(401, "Sign in required", "signed_out");
      }
      if (req.method === "GET") {
        const prefs = await boardOps.getOperatorPrefs(ctx.user.id);
        return json({ ok: true, ...prefs });
      }
      const theme = str(body.theme) ?? null;
      const prefsPatch =
        body.prefs && typeof body.prefs === "object" && !Array.isArray(body.prefs)
          ? (body.prefs as Record<string, unknown>)
          : undefined;
      const saved = await boardOps.setOperatorPrefs(ctx.user.id, {
        theme: theme === null || theme === "" ? null : theme,
        prefs: prefsPatch,
      });
      return json({ ok: true, ...saved });
    }

    // GET /  — catalog
    if (parts.length === 0 && req.method === "GET") {
      return json({
        ok: true,
        service: "agent-relay",
        protocol: "v0.2",
        endpoints: {
          health: "GET /api/agent/health",
          poll: "GET /api/agent/missions?column=ready&limit=5&agent=forge",
          claim: "POST /api/agent/missions/:id/claim",
          heartbeat: "POST /api/agent/missions/:id/heartbeat",
          escalate: "POST /api/agent/missions/:id/escalate",
          deliver: "POST /api/agent/missions/:id/deliver",
          create: "POST /api/agent/missions  { title, objective, project, column? }",
          action: "POST /api/agent/v1  { action: poll|claim|…|create|file, ... }",
          agents: "GET|POST /api/agent/agents",
          calls: "GET /api/agent/calls",
          reply: "POST /api/agent/calls/:id/reply",
          export: "GET /api/agent/export",
          admin: "GET /api/agent/admin?project=",
          boards: "GET /api/agent/boards",
          projects: "GET|POST /api/agent/projects",
          github_ingest: "POST /api/agent/ingest/github",
          journal: "GET /api/agent/missions/:id/journal",
        },
      });
    }

    return err(404, `No route for ${req.method} ${path}`);
  } catch (e) {
    console.error("[agent-api]", e);
    return err(500, e instanceof Error ? e.message : "Internal error", "internal");
  }
}

async function handleAction(
  body: Record<string, unknown>,
  machine: MachineAuth = { type: "open" },
): Promise<Response> {
  const action = str(body.action)?.toLowerCase();
  if (!action) return err(400, "action is required", "bad_request");

  if (action === "poll") {
    const column = (str(body.column) ?? "ready") as MissionColumn;
    const limit = typeof body.limit === "number" ? body.limit : Number(body.limit ?? 5);
    const tags = strArr(body.tags);
    const skills = strArr(body.skills);
    const matchRaw = body.match_agent_skills ?? body.matchAgentSkills;
    const matchAgentSkills =
      matchRaw === undefined
        ? undefined
        : matchRaw === true || matchRaw === 1 || matchRaw === "1" || matchRaw === "true";
    let agentName: string | undefined = str(body.agent) ?? str(body.agent_id);
    if (machine.type === "ark" && machine.agentId) {
      const agentOrErr = await resolveVerbAgent(body, machine);
      if (agentOrErr instanceof Response) return agentOrErr;
      agentName = agentOrErr;
    }
    return fromEngine(
      await boardOps.poll({
        column,
        limit: Number.isFinite(limit) ? limit : 5,
        agent: agentName,
        tags,
        skills,
        matchAgentSkills,
        projectId: str(body.project) ?? str(body.project_id),
      }),
    );
  }

  const agentOrErr = await resolveVerbAgent(body, machine);
  if (agentOrErr instanceof Response) return agentOrErr;
  const agent = agentOrErr;
  const missionId = str(body.mission_id) ?? str(body.missionId);
  if (["claim", "heartbeat", "escalate", "deliver"].includes(action) && !missionId) {
    return err(400, "mission_id is required", "bad_request");
  }

  if (action === "claim") return fromEngine(await boardOps.claim(missionId!, agent));
  if (action === "heartbeat") {
    return fromEngine(await boardOps.heartbeat(missionId!, agent, str(body.note)));
  }
  if (action === "escalate") {
    const question = str(body.question);
    if (!question) return err(400, "question is required", "bad_request");
    return fromEngine(await boardOps.escalate(missionId!, agent, question));
  }
  if (action === "deliver") {
    const summary = str(body.summary) ?? str(body.delivery) ?? "";
    const usage = parseUsage(body.usage ?? body.usage_report);
    return fromEngine(
      await boardOps.deliver(
        missionId!,
        agent!,
        summary,
        strArr(body.artifacts) ?? [],
        usage,
      ),
    );
  }

  // Client agents may file missions (Inbox/Ready) on boards they can access.
  if (action === "create" || action === "file" || action === "create_mission") {
    const title = str(body.title);
    const objective = str(body.objective);
    if (!title || !objective) {
      return err(400, "title and objective required", "bad_request");
    }
    // Synthetic request bits for shared helper — path create only needs body + machine.
    return createMissionForCaller({
      req: new Request("http://local/api/agent/missions", { method: "POST" }),
      body,
      url: new URL("http://local/api/agent/missions"),
      machineAuth: machine,
      title,
      objective,
    });
  }

  return err(400, `Unknown action: ${action}`, "bad_request");
}

const AGENT_CREATE_COLUMNS = new Set<string>(["inbox", "ready"]);

/**
 * Create a mission as operator (session) or client agent (ark_ key).
 * Agents default to Inbox and may only target boards they can access.
 */
async function createMissionForCaller(opts: {
  req: Request;
  body: Record<string, unknown>;
  url: URL;
  machineAuth: MachineAuth;
  title: string;
  objective: string;
}): Promise<Response> {
  const { req, body, url, machineAuth, title, objective } = opts;
  const rawProject =
    str(body.projectId) ?? str(body.project) ?? projectRef(url, body);
  const rawColumn = (str(body.column) ?? "inbox").toLowerCase();

  // ── Operator path ────────────────────────────────────────────
  const opCtx = await loadOperatorContext(req);
  const opCheck = checkOperatorCapability(opCtx, "write_board");
  if (opCheck.ok) {
    let projectId = rawProject?.trim() || undefined;
    if (projectId) {
      const access = await requireOperatorProjectAccess(req, projectId);
      if (access instanceof Response) return access;
      projectId = access;
    }
    return fromEngine(
      await boardOps.createMission({
        title,
        objective,
        context: str(body.context),
        constraints: str(body.constraints),
        acceptance: str(body.acceptance),
        priority: str(body.priority) as Priority | undefined,
        tags: strArr(body.tags),
        column: rawColumn as MissionColumn,
        projectId,
      }),
    );
  }

  // ── Client agent path (ark_ / global key) ────────────────────
  if (machineAuth.type !== "ark" && machineAuth.type !== "global") {
    return err(
      opCheck.status ?? 401,
      opCheck.error ??
        "Sign in as an operator, or use an agent API key bound to a board.",
      opCheck.code ?? "signed_out",
    );
  }

  let agentId: string | null =
    machineAuth.type === "ark" ? machineAuth.agentId : null;
  let agentName: string | null = null;

  if (machineAuth.type === "ark") {
    if (!machineAuth.agentId) {
      return err(
        403,
        "This API key is not bound to an agent. Issue an agent-bound key to create missions.",
        "agent_required",
      );
    }
    const agentOrErr = await resolveVerbAgent(body, machineAuth);
    if (agentOrErr instanceof Response) return agentOrErr;
    agentName = agentOrErr;
    const snap = await boardOps.snapshot();
    const bound = snap.agents.find(
      (a) =>
        a.id === machineAuth.agentId ||
        a.name.toLowerCase() === agentName!.toLowerCase(),
    );
    agentId = bound?.id ?? machineAuth.agentId;
  } else {
    // global key: require explicit agent
    const agentOrErr = await resolveVerbAgent(body, machineAuth);
    if (agentOrErr instanceof Response) return agentOrErr;
    agentName = agentOrErr;
    const snap = await boardOps.snapshot();
    const bound = snap.agents.find(
      (a) =>
        a.name.toLowerCase() === agentName!.toLowerCase() ||
        a.id === agentName,
    );
    if (!bound || bound.isDemo) {
      return err(400, "Unknown agent — register a real agent first", "agent_not_found");
    }
    agentId = bound.id;
    agentName = bound.name;
  }

  if (!AGENT_CREATE_COLUMNS.has(rawColumn)) {
    return err(
      400,
      "Agents may only create missions in inbox or ready (default: inbox).",
      "bad_column",
    );
  }

  const projectId =
    (rawProject?.trim()
      ? await boardOps.resolveProjectId(rawProject.trim())
      : null) ??
    (machineAuth.type === "ark" ? machineAuth.projectId : null);

  if (!projectId) {
    return err(
      400,
      "project (board id or slug) is required when creating as an agent.",
      "project_required",
    );
  }

  const allowed = await boardOps.agentCanAccessBoard(agentId!, projectId);
  // Also allow the board the key was issued on (even if membership row missing)
  const keyBoardOk =
    machineAuth.type === "ark" && machineAuth.projectId === projectId;
  if (!allowed && !keyBoardOk) {
    return err(
      403,
      "This agent has no access to that board. Ask an operator to grant board access or issue a key on that board.",
      "board_forbidden",
    );
  }

  // Keep roster membership in sync when agent files work via key board access
  await boardOps.grantBoardAccess(agentId!, projectId);

  return fromEngine(
    await boardOps.createMission({
      title,
      objective,
      context: str(body.context),
      constraints: str(body.constraints),
      acceptance: str(body.acceptance),
      priority: str(body.priority) as Priority | undefined,
      tags: strArr(body.tags),
      column: rawColumn as MissionColumn,
      projectId,
      createdByAgentId: agentId,
      createdByAgentName: agentName,
    }),
  );
}

/** True when the URL path is owned by this handler. */
export function isAgentApiPath(pathname: string): boolean {
  const p = pathname.split("?", 1)[0] ?? "";
  return p === "/api/agent" || p.startsWith("/api/agent/");
}
