/**
 * Durable board store (Postgres via DATABASE_URL, else PGLite).
 * All agent API + UI paths share this single source of truth.
 */
import { getSql, type Sql } from "./db";
import {
  DEFAULT_PROJECT_ID,
  SEED_AGENTS,
  SEED_CALLS,
  SEED_EVENTS,
  SEED_MISSIONS,
  SEED_PROJECTS,
} from "./seed";
import type {
  Agent,
  AgentKeyTip,
  AgentProfile,
  AgentProfileActivity,
  AgentProfileStats,
  AgentStatus,
  HarnessKind,
  HumanCall,
  Mission,
  MissionColumn,
  MissionEvent,
  MissionHistoryEntry,
  Priority,
  Project,
} from "./types";
import { uid } from "./utils";
import type { BoardData, EngineResult } from "./board-engine";
import * as engine from "./board-engine";
import {
  mapGitHubIssueToMission,
  type GitHubIngestInput,
} from "./github-ingest";
import { renderMissionJournalMarkdown } from "./journal";
import {
  createApiKeyMaterial,
  sealApiKeySecret,
  unsealApiKeySecret,
  verifyApiKeyAgainstHashes,
  type ApiKeyRecord,
} from "./api-keys";
import { historyToCsv, historyToJson } from "./audit-export";
import { buildReplyWebhookPayload, dispatchReplyWebhook } from "./reply-webhook";
import { resolveProjectRef } from "./project-ref";

const globalRef = globalThis as typeof globalThis & {
  __arBoardReady__?: Promise<void>;
  __arBoardChain__?: Promise<unknown>;
};

function ts(n: number | null | undefined): Date | null {
  if (n == null) return null;
  return new Date(n);
}

function ms(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function asJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowProject(r: Record<string, unknown>): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    description: String(r.description ?? ""),
    ownerUserId: r.owner_user_id != null ? String(r.owner_user_id) : null,
    archivedAt: ms(r.archived_at),
    createdAt: ms(r.created_at) ?? Date.now(),
    updatedAt: ms(r.updated_at) ?? Date.now(),
  };
}

function rowMissionUsage(raw: unknown): Mission["usage"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v)
      ? v
      : typeof v === "string" && v.trim() && Number.isFinite(Number(v))
        ? Number(v)
        : undefined;
  return {
    tokensIn: num(u.tokensIn ?? u.tokens_in),
    tokensOut: num(u.tokensOut ?? u.tokens_out),
    model: u.model != null ? String(u.model) : undefined,
    toolCalls:
      typeof u.toolCalls === "number" || typeof u.tool_calls === "number"
        ? num(u.toolCalls ?? u.tool_calls)
        : u.toolCalls && typeof u.toolCalls === "object"
          ? (u.toolCalls as Record<string, number>)
          : u.tool_calls && typeof u.tool_calls === "object"
            ? (u.tool_calls as Record<string, number>)
            : undefined,
    estimatedUsd: num(u.estimatedUsd ?? u.estimated_usd),
    pricingSource:
      u.pricingSource != null
        ? String(u.pricingSource)
        : u.pricing_source != null
          ? String(u.pricing_source)
          : undefined,
    raw: u,
  };
}

function rowMission(r: Record<string, unknown>): Mission {
  return {
    id: String(r.id),
    projectId: String(r.project_id ?? DEFAULT_PROJECT_ID),
    title: String(r.title),
    objective: String(r.objective ?? ""),
    context: String(r.context ?? ""),
    constraints: String(r.constraints_text ?? ""),
    acceptance: String(r.acceptance ?? ""),
    column: String(r.column_id) as MissionColumn,
    priority: String(r.priority ?? "p2") as Priority,
    tags: asJsonArray(r.tags),
    assigneeId: r.assignee_id != null ? String(r.assignee_id) : null,
    claimedBy: r.claimed_by != null ? String(r.claimed_by) : null,
    claimedAt: ms(r.claimed_at),
    lastHeartbeat: ms(r.last_heartbeat),
    progressNote: String(r.progress_note ?? ""),
    artifacts: asJsonArray(r.artifacts),
    createdAt: ms(r.created_at) ?? Date.now(),
    updatedAt: ms(r.updated_at) ?? Date.now(),
    delivery: r.delivery != null ? String(r.delivery) : undefined,
    externalId: r.external_id != null ? String(r.external_id) : null,
    source: r.source != null ? String(r.source) : null,
    usage: rowMissionUsage(r.usage),
  };
}

const SEED_AGENT_IDS = new Set([
  "agent_scout",
  "agent_forge",
  "agent_lens",
  "agent_relay",
  "agent_night",
  "agent_hermes",
  "agent_grok",
  "agent_omp",
  "agent_openclaw",
]);

function rowAgent(r: Record<string, unknown>): Agent {
  const notes = r.notes != null ? String(r.notes) : undefined;
  const id = String(r.id);
  const isDemo =
    r.is_demo === true ||
    r.is_demo === "t" ||
    r.is_demo === 1 ||
    notes === "seed" ||
    SEED_AGENT_IDS.has(id);
  return {
    id,
    name: String(r.name),
    harness: String(r.harness) as HarnessKind,
    role: String(r.role ?? ""),
    status: String(r.status ?? "online") as AgentStatus,
    skills: asJsonArray(r.skills),
    lastHeartbeat: ms(r.last_heartbeat) ?? Date.now(),
    currentMissionId: r.current_mission_id != null ? String(r.current_mission_id) : null,
    notes,
    isDemo: Boolean(isDemo),
  };
}

function rowCall(r: Record<string, unknown>): HumanCall {
  return {
    id: String(r.id),
    missionId: String(r.mission_id),
    agentId: r.agent_id != null ? String(r.agent_id) : null,
    projectId: r.project_id != null ? String(r.project_id) : null,
    question: String(r.question),
    urgency: String(r.urgency ?? "p2") as Priority,
    createdAt: ms(r.created_at) ?? Date.now(),
    resolvedAt: ms(r.resolved_at),
    reply: r.reply != null ? String(r.reply) : null,
  };
}

function rowEvent(r: Record<string, unknown>): MissionEvent {
  let meta: Record<string, string> | undefined;
  if (r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)) {
    meta = Object.fromEntries(
      Object.entries(r.meta as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }
  return {
    id: String(r.id),
    missionId: r.mission_id != null ? String(r.mission_id) : null,
    agentId: r.agent_id != null ? String(r.agent_id) : null,
    projectId: r.project_id != null ? String(r.project_id) : null,
    kind: r.kind as MissionEvent["kind"],
    message: String(r.message),
    at: ms(r.at) ?? Date.now(),
    meta,
  };
}

function rowHistory(r: Record<string, unknown>): MissionHistoryEntry {
  return {
    id: String(r.id),
    missionId: String(r.mission_id),
    projectId: r.project_id != null ? String(r.project_id) : null,
    actorId: r.actor_id != null ? String(r.actor_id) : null,
    actorName: r.actor_name != null ? String(r.actor_name) : null,
    actorKind: (String(r.actor_kind ?? "system") as MissionHistoryEntry["actorKind"]),
    fromColumn: r.from_column != null ? (String(r.from_column) as MissionColumn) : null,
    toColumn: String(r.to_column) as MissionColumn,
    at: ms(r.at) ?? Date.now(),
    note: r.note != null ? String(r.note) : undefined,
    meta:
      r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)
        ? Object.fromEntries(
            Object.entries(r.meta as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : undefined,
  };
}

async function ensureBoardAgent(sql: Sql, projectId: string, agentId: string) {
  if (!projectId || !agentId) return;
  await sql`
    insert into ar_board_agents (project_id, agent_id)
    values (${projectId}, ${agentId})
    on conflict do nothing
  `;
}

async function loadBoard(sql: Sql, projectId?: string | null): Promise<BoardData> {
  const [agents, missions, events, calls] = await Promise.all([
    projectId
      ? sql`
          select distinct a.*
          from ar_agents a
          left join ar_board_agents ba
            on ba.agent_id = a.id and ba.project_id = ${projectId}
          left join ar_api_keys k
            on k.agent_id = a.id
            and k.project_id = ${projectId}
            and k.revoked_at is null
          where coalesce(a.is_demo, false) = false
            and (
              ba.agent_id is not null
              or k.agent_id is not null
              -- Legacy real agents with no board membership yet still surface
              -- until they are keyed/registered onto a board.
              or not exists (
                select 1 from ar_board_agents any_ba where any_ba.agent_id = a.id
              )
            )
          order by a.name asc
        `
      : sql`select * from ar_agents where coalesce(is_demo, false) = false order by name asc`,
    projectId
      ? sql`select * from ar_missions where project_id = ${projectId} order by updated_at desc`
      : sql`select * from ar_missions order by updated_at desc`,
    projectId
      ? sql`select * from ar_events where project_id = ${projectId} or project_id is null order by at desc limit 200`
      : sql`select * from ar_events order by at desc limit 200`,
    projectId
      ? sql`select * from ar_calls where project_id = ${projectId} or project_id is null order by created_at desc`
      : sql`select * from ar_calls order by created_at desc`,
  ]);
  const missionRows = missions.map((r) => rowMission(r as Record<string, unknown>));
  // Filter calls/events to missions in scope when project set
  const agentRows = agents.map((r) => rowAgent(r as Record<string, unknown>));
  if (projectId) {
    const ids = new Set(missionRows.map((m) => m.id));
    return {
      agents: agentRows,
      missions: missionRows,
      events: events
        .map((r) => rowEvent(r as Record<string, unknown>))
        .filter((e) => !e.missionId || ids.has(e.missionId) || e.projectId === projectId),
      calls: calls
        .map((r) => rowCall(r as Record<string, unknown>))
        .filter((c) => ids.has(c.missionId) || c.projectId === projectId),
    };
  }
  return {
    agents: agentRows,
    missions: missionRows,
    events: events.map((r) => rowEvent(r as Record<string, unknown>)),
    calls: calls.map((r) => rowCall(r as Record<string, unknown>)),
  };
}

async function insertAgent(sql: Sql, a: Agent) {
  await sql`
    insert into ar_agents (id, name, harness, role, status, skills, last_heartbeat, current_mission_id, notes, is_demo)
    values (
      ${a.id}, ${a.name}, ${a.harness}, ${a.role}, ${a.status},
      ${JSON.stringify(a.skills)}::jsonb,
      ${ts(a.lastHeartbeat)}, ${a.currentMissionId}, ${a.notes ?? null},
      ${a.isDemo === true}
    )
    on conflict (id) do update set
      name = excluded.name,
      harness = excluded.harness,
      role = excluded.role,
      status = excluded.status,
      skills = excluded.skills,
      last_heartbeat = excluded.last_heartbeat,
      current_mission_id = excluded.current_mission_id,
      notes = excluded.notes,
      is_demo = excluded.is_demo,
      updated_at = now()
  `;
}

async function insertProject(sql: Sql, pr: Project) {
  await sql`
    insert into ar_projects (id, name, slug, description, owner_user_id, created_at, updated_at)
    values (
      ${pr.id},
      ${pr.name},
      ${pr.slug},
      ${pr.description},
      ${pr.ownerUserId ?? null},
      ${ts(pr.createdAt)},
      ${ts(pr.updatedAt)}
    )
    on conflict (id) do update set
      name = excluded.name,
      slug = excluded.slug,
      description = excluded.description,
      owner_user_id = coalesce(excluded.owner_user_id, ar_projects.owner_user_id),
      updated_at = excluded.updated_at
  `;
}

async function insertMission(sql: Sql, m: Mission) {
  const usageJson = m.usage ? JSON.stringify(m.usage) : null;
  await sql`
    insert into ar_missions (
      id, project_id, title, objective, context, constraints_text, acceptance,
      column_id, priority, tags, assignee_id, claimed_by, claimed_at,
      last_heartbeat, progress_note, artifacts, delivery, created_at, updated_at,
      external_id, source, usage
    ) values (
      ${m.id}, ${m.projectId ?? DEFAULT_PROJECT_ID}, ${m.title}, ${m.objective}, ${m.context}, ${m.constraints}, ${m.acceptance},
      ${m.column}, ${m.priority}, ${JSON.stringify(m.tags)}::jsonb,
      ${m.assigneeId}, ${m.claimedBy}, ${ts(m.claimedAt)},
      ${ts(m.lastHeartbeat)}, ${m.progressNote}, ${JSON.stringify(m.artifacts)}::jsonb,
      ${m.delivery ?? null}, ${ts(m.createdAt)}, ${ts(m.updatedAt)},
      ${m.externalId ?? null}, ${m.source ?? null}, ${usageJson}::jsonb
    )
    on conflict (id) do update set
      project_id = excluded.project_id,
      title = excluded.title,
      objective = excluded.objective,
      context = excluded.context,
      constraints_text = excluded.constraints_text,
      acceptance = excluded.acceptance,
      column_id = excluded.column_id,
      priority = excluded.priority,
      tags = excluded.tags,
      assignee_id = excluded.assignee_id,
      claimed_by = excluded.claimed_by,
      claimed_at = excluded.claimed_at,
      last_heartbeat = excluded.last_heartbeat,
      progress_note = excluded.progress_note,
      artifacts = excluded.artifacts,
      delivery = excluded.delivery,
      usage = coalesce(excluded.usage, ar_missions.usage),
      external_id = excluded.external_id,
      source = excluded.source,
      updated_at = excluded.updated_at
  `;
}

async function insertCall(sql: Sql, c: HumanCall) {
  await sql`
    insert into ar_calls (id, mission_id, agent_id, project_id, question, urgency, created_at, resolved_at, reply)
    values (
      ${c.id}, ${c.missionId}, ${c.agentId}, ${c.projectId ?? null}, ${c.question}, ${c.urgency},
      ${ts(c.createdAt)}, ${ts(c.resolvedAt)}, ${c.reply}
    )
    on conflict (id) do update set
      project_id = excluded.project_id,
      resolved_at = excluded.resolved_at,
      reply = excluded.reply
  `;
}

async function insertEvent(sql: Sql, e: MissionEvent) {
  await sql`
    insert into ar_events (id, mission_id, agent_id, project_id, kind, message, at, meta)
    values (
      ${e.id}, ${e.missionId}, ${e.agentId}, ${e.projectId ?? null}, ${e.kind}, ${e.message},
      ${ts(e.at)}, ${e.meta ? JSON.stringify(e.meta) : null}::jsonb
    )
    on conflict (id) do nothing
  `;
}

async function insertHistory(sql: Sql, h: MissionHistoryEntry) {
  await sql`
    insert into ar_mission_history (
      id, mission_id, project_id, actor_id, actor_name, actor_kind,
      from_column, to_column, at, note, meta
    ) values (
      ${h.id}, ${h.missionId}, ${h.projectId ?? null}, ${h.actorId}, ${h.actorName}, ${h.actorKind},
      ${h.fromColumn}, ${h.toColumn}, ${ts(h.at)}, ${h.note ?? null},
      ${h.meta ? JSON.stringify(h.meta) : null}::jsonb
    )
    on conflict (id) do nothing
  `;
}

function historyEntry(opts: {
  missionId: string;
  projectId?: string | null;
  from: MissionColumn | null;
  to: MissionColumn;
  actorId?: string | null;
  actorName?: string | null;
  actorKind?: MissionHistoryEntry["actorKind"];
  note?: string;
  meta?: Record<string, string>;
  at?: number;
}): MissionHistoryEntry {
  return {
    id: uid("hist"),
    missionId: opts.missionId,
    projectId: opts.projectId ?? null,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    actorKind: opts.actorKind ?? "system",
    fromColumn: opts.from,
    toColumn: opts.to,
    at: opts.at ?? Date.now(),
    note: opts.note,
    meta: opts.meta,
  };
}

/** Diff boards and write full snapshot + any new history rows. */
async function persistBoard(
  sql: Sql,
  next: BoardData,
  history: MissionHistoryEntry[] = [],
) {
  for (const a of next.agents) await insertAgent(sql, a);
  for (const m of next.missions) await insertMission(sql, m);
  // Soft-delete removed missions? For demo reset we truncate first.
  for (const c of next.calls) await insertCall(sql, c);
  // Only insert newest events (first 50) that might be new
  for (const e of next.events.slice(0, 30)) await insertEvent(sql, e);
  for (const h of history) await insertHistory(sql, h);
}

async function ensureProjects(sql: Sql) {
  for (const pr of SEED_PROJECTS) await insertProject(sql, structuredClone(pr));
}

async function seedIfEmpty(sql: Sql) {
  await ensureProjects(sql);
  const rows = await sql`select count(*)::int as c from ar_missions`;
  const c = Number((rows[0] as { c: number }).c ?? 0);
  if (c > 0) return;

  for (const pr of SEED_PROJECTS) await insertProject(sql, structuredClone(pr));
  const board: BoardData = {
    agents: structuredClone(SEED_AGENTS),
    missions: structuredClone(SEED_MISSIONS).map((m) => ({
      ...m,
      projectId: m.projectId ?? DEFAULT_PROJECT_ID,
    })),
    events: structuredClone(SEED_EVENTS),
    calls: structuredClone(SEED_CALLS),
  };
  for (const a of board.agents) await insertAgent(sql, a);
  for (const m of board.missions) await insertMission(sql, m);
  for (const c of board.calls) await insertCall(sql, c);
  for (const e of board.events) await insertEvent(sql, e);

  // Seed history for missions that aren't inbox-only: record current column as initial
  for (const m of board.missions) {
    await insertHistory(
      sql,
      historyEntry({
        missionId: m.id,
        projectId: m.projectId,
        from: null,
        to: m.column,
        actorKind: "system",
        actorName: "seed",
        note: "Seeded mission state",
        at: m.createdAt,
      }),
    );
  }
  await sql`
    insert into ar_meta (key, value) values ('seeded', '1')
    on conflict (key) do update set value = '1'
  `;
}

export async function ensureBoardReady(): Promise<void> {
  if (!globalRef.__arBoardReady__) {
    globalRef.__arBoardReady__ = (async () => {
      const sql = await getSql();
      // Tables come from migrations; if missing (fresh pglite mid-boot), wait for migrate
      try {
        await sql`select 1 from ar_missions limit 1`;
      } catch {
        // migrations may still be applying on first pglite boot — retry once
        await new Promise((r) => setTimeout(r, 200));
        await sql`select 1 from ar_missions limit 1`;
      }
      await seedIfEmpty(sql);
    })().catch((err) => {
      globalRef.__arBoardReady__ = undefined;
      throw err;
    });
  }
  await globalRef.__arBoardReady__;
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // Serialize via a promise chain that always advances (even on throw).
  const prev = globalRef.__arBoardChain__ ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((r) => {
    release = r;
  });
  // Next waiter waits on our "done", not a separate gate that can deadlock.
  globalRef.__arBoardChain__ = prev.then(() => done);
  await prev.catch(() => undefined);
  try {
    await ensureBoardReady();
    return await fn();
  } finally {
    release();
  }
}

/** Resolve board id from id or slug (caller must hold lock / ready DB). */
async function lookupProjectId(sql: Sql, ref: string): Promise<string | null> {
  const t = ref.trim();
  if (!t || t === "all" || t === "*" || t === "__all__") return null;
  const rows = (await sql`
    select id, slug from ar_projects
    where id = ${t} or slug = ${t}
    limit 2
  `) as Array<{ id: string; slug: string }>;
  return resolveProjectRef(
    t,
    rows.map((r) => ({ id: String(r.id), slug: String(r.slug ?? "") })),
  );
}

function actorFromBoard(board: BoardData, agentRef?: string | null) {
  if (!agentRef) return { id: null as string | null, name: null as string | null, kind: "operator" as const };
  const a = engine.resolveAgent(board, agentRef);
  if (!a) return { id: agentRef, name: agentRef, kind: "agent" as const };
  return { id: a.id, name: a.name, kind: "agent" as const };
}

function collectHistory(
  before: BoardData,
  after: BoardData,
  actor: { id: string | null; name: string | null; kind: MissionHistoryEntry["actorKind"] },
  note?: string,
): MissionHistoryEntry[] {
  const prev = new Map(before.missions.map((m) => [m.id, m]));
  const out: MissionHistoryEntry[] = [];
  for (const m of after.missions) {
    const p = prev.get(m.id);
    if (!p) {
      out.push(
        historyEntry({
          missionId: m.id,
          projectId: m.projectId,
          from: null,
          to: m.column,
          actorId: actor.id,
          actorName: actor.name,
          actorKind: actor.kind,
          note: note ?? "created",
        }),
      );
      continue;
    }
    if (p.column !== m.column) {
      out.push(
        historyEntry({
          missionId: m.id,
          projectId: m.projectId,
          from: p.column,
          to: m.column,
          actorId: actor.id,
          actorName: actor.name,
          actorKind: actor.kind,
          note,
          meta: {
            claimedBy: m.claimedBy ?? "",
          },
        }),
      );
    }
  }
  return out;
}

async function applyEngine<T>(
  run: (board: BoardData) => EngineResult<T>,
  actorRef?: string | null,
  actorKind: MissionHistoryEntry["actorKind"] = "agent",
  note?: string,
): Promise<EngineResult<T>> {
  return withLock(async () => {
    const sql = await getSql();
    const before = await loadBoard(sql);
    const result = run(before);
    if (!result.ok) return result;
    const actor =
      actorKind === "operator"
        ? { id: actorRef ?? "operator", name: actorRef ?? "operator", kind: "operator" as const }
        : actorFromBoard(before, actorRef);
    if (actorKind === "agent" && actorRef) {
      // keep
    }
    const hist = collectHistory(before, result.board, { ...actor, kind: actorKind }, note);
    await persistBoard(sql, result.board, hist);
    return result;
  });
}

export const durableBoard = {
  snapshot: (projectId?: string | null) =>
    withLock(async () => {
      const sql = await getSql();
      return loadBoard(sql, projectId);
    }),

  /**
   * Full client-agent fleet for the operator UI.
   * Includes non-demo agents that:
   *  - belong to any of the allowed boards, or
   *  - have an active API key on an allowed board, or
   *  - have no board membership yet (legacy / just registered).
   * When allowedProjectIds is null/undefined, returns every non-demo agent (unrestricted).
   * When it is [] (signed-in user with zero readable boards), memberships/keys are empty —
   * never treat empty array as unrestricted (that leaked private boards).
   */
  listFleetAgents: (allowedProjectIds?: string[] | null) =>
    withLock(async () => {
      const sql = await getSql();
      // null = unrestricted; Set (possibly empty) = restricted to those board ids
      const allowed =
        allowedProjectIds == null ? null : new Set(allowedProjectIds);

      const rows = (await sql`
        select * from ar_agents
        where coalesce(is_demo, false) = false
        order by name asc
      `) as Record<string, unknown>[];

      const memberships = (await sql`
        select project_id, agent_id from ar_board_agents
      `) as Array<{ project_id: string; agent_id: string }>;

      const keyRows = (await sql`
        select id, project_id, agent_id, key_prefix, key_suffix, last_used_at, revoked_at
        from ar_api_keys
        where agent_id is not null
      `) as Array<Record<string, unknown>>;

      const byAgent = new Map<string, string[]>();
      for (const m of memberships) {
        const aid = String(m.agent_id);
        const pid = String(m.project_id);
        if (allowed && !allowed.has(pid)) continue;
        const list = byAgent.get(aid) ?? [];
        if (!list.includes(pid)) list.push(pid);
        byAgent.set(aid, list);
      }

      const keyBoards = new Map<string, string[]>();
      const tipsByAgent = new Map<string, AgentKeyTip[]>();
      for (const k of keyRows) {
        const aid = String(k.agent_id);
        const pid = String(k.project_id);
        const revokedAt = ms(k.revoked_at);
        if (allowed && !allowed.has(pid)) continue;
        if (!revokedAt) {
          const list = keyBoards.get(aid) ?? [];
          if (!list.includes(pid)) list.push(pid);
          keyBoards.set(aid, list);
        }
        const prefix = String(k.key_prefix ?? "");
        const suffixRaw =
          k.key_suffix != null && String(k.key_suffix).trim()
            ? String(k.key_suffix).trim()
            : prefix.slice(-6);
        const tip: AgentKeyTip = {
          id: String(k.id),
          projectId: pid,
          prefix,
          suffix: suffixRaw.slice(-6),
          lastUsedAt: ms(k.last_used_at),
          revokedAt,
        };
        const tips = tipsByAgent.get(aid) ?? [];
        tips.push(tip);
        tipsByAgent.set(aid, tips);
      }

      const agentsOnAnyBoard = new Set(memberships.map((m) => String(m.agent_id)));

      return rows
        .map((r) => {
          const agent = rowAgent(r);
          if (agent.isDemo) return null;
          const boards = byAgent.get(agent.id) ?? [];
          const keyPids = keyBoards.get(agent.id) ?? [];
          const orphan = !agentsOnAnyBoard.has(agent.id);
          if (allowed) {
            const visible =
              boards.length > 0 || keyPids.length > 0 || orphan;
            if (!visible) return null;
          }
          // Membership + active key boards both count as "connected" for UI highlight.
          const connected = [...boards];
          for (const pid of keyPids) {
            if (!connected.includes(pid)) connected.push(pid);
          }
          agent.boardIds = connected;
          const tips = (tipsByAgent.get(agent.id) ?? [])
            .filter((t) => !t.revokedAt)
            .sort(
              (a, b) =>
                (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
                a.prefix.localeCompare(b.prefix),
            );
          agent.keyTips = tips;
          return agent;
        })
        .filter((a): a is Agent => a != null)
        .sort((a, b) => a.name.localeCompare(b.name));
    }),

  getAgentProfile: (agentRef: string, opts?: { allowedProjectIds?: string[] | null }) =>
    withLock(async (): Promise<AgentProfile | null> => {
      const sql = await getSql();
      const ref = agentRef.trim();
      if (!ref) return null;

      const agentRows = (await sql`
        select * from ar_agents
        where id = ${ref} or lower(name) = ${ref.toLowerCase()}
        limit 1
      `) as Record<string, unknown>[];
      if (!agentRows.length) return null;
      const agent = rowAgent(agentRows[0]!);
      if (agent.isDemo) {
        // still allow profile for demos if asked, but fleet hides them
      }

      // null = unrestricted; empty Set = no board access (do not fail open)
      const allowed =
        opts?.allowedProjectIds == null
          ? null
          : new Set(opts.allowedProjectIds);

      const memberships = (await sql`
        select project_id from ar_board_agents where agent_id = ${agent.id}
      `) as Array<{ project_id: string }>;
      agent.boardIds = memberships
        .map((m) => String(m.project_id))
        .filter((id) => !allowed || allowed.has(id));

      const keyRows = (await sql`
        select id, project_id, key_prefix, key_suffix, last_used_at, revoked_at
        from ar_api_keys
        where agent_id = ${agent.id}
        order by created_at desc
      `) as Array<Record<string, unknown>>;
      const keys: AgentKeyTip[] = [];
      for (const k of keyRows) {
        const pid = String(k.project_id);
        if (allowed && !allowed.has(pid)) continue;
        const prefix = String(k.key_prefix ?? "");
        const suffixRaw =
          k.key_suffix != null && String(k.key_suffix).trim()
            ? String(k.key_suffix).trim()
            : prefix.slice(-6);
        keys.push({
          id: String(k.id),
          projectId: pid,
          prefix,
          suffix: suffixRaw.slice(-6),
          lastUsedAt: ms(k.last_used_at),
          revokedAt: ms(k.revoked_at),
        });
      }
      agent.keyTips = keys.filter((k) => !k.revokedAt);

      const missions = (await sql`
        select * from ar_missions
        where claimed_by = ${agent.id}
           or claimed_by = ${agent.name}
           or assignee_id = ${agent.id}
        order by updated_at desc
      `) as Record<string, unknown>[];
      const missionRows = missions
        .map((r) => rowMission(r))
        .filter((m) => !allowed || allowed.has(m.projectId));

      const activeMissions = missionRows
        .filter((m) => !["done"].includes(m.column))
        .map((m) => ({
          id: m.id,
          title: m.title,
          column: m.column,
          projectId: m.projectId,
          priority: m.priority,
          updatedAt: m.updatedAt,
        }));

      const titleById = new Map(missionRows.map((m) => [m.id, m.title]));
      // Also load titles for events that reference other missions
      const eventRows = (await sql`
        select * from ar_events
        where agent_id = ${agent.id}
           or agent_id = ${agent.name}
        order by at desc
        limit 400
      `) as Record<string, unknown>[];
      let events = eventRows
        .map((r) => rowEvent(r))
        .filter((e) => !allowed || !e.projectId || allowed.has(e.projectId));

      const missingMissionIds = [
        ...new Set(
          events
            .map((e) => e.missionId)
            .filter((id): id is string => !!id && !titleById.has(id)),
        ),
      ];
      if (missingMissionIds.length) {
        for (const mid of missingMissionIds.slice(0, 80)) {
          // Never load titles from private boards outside the caller's readable set.
          const mr = (await sql`
            select id, title, project_id from ar_missions where id = ${mid} limit 1
          `) as Array<{ id: string; title: string; project_id: string }>;
          if (!mr[0]) continue;
          const pid = String(mr[0].project_id);
          if (allowed && !allowed.has(pid)) continue;
          titleById.set(String(mr[0].id), String(mr[0].title));
        }
      }
      // Drop activity that points at missions outside readable boards (no title leak).
      if (allowed) {
        events = events.filter((e) => {
          if (e.projectId) return allowed.has(e.projectId);
          if (e.missionId) return titleById.has(e.missionId);
          return true;
        });
      }

      const calls = (await sql`
        select * from ar_calls
        where agent_id = ${agent.id} or agent_id = ${agent.name}
        order by created_at desc
        limit 100
      `) as Record<string, unknown>[];
      const callRows = calls
        .map((r) => rowCall(r))
        .filter((c) => !allowed || !c.projectId || allowed.has(c.projectId));

      function statsForWindow(hours: number): AgentProfileStats {
        const since = Date.now() - hours * 3600_000;
        const inWin = events.filter((e) => e.at >= since);
        const claims = inWin.filter((e) => e.kind === "mission_claimed").length;
        const heartbeats = inWin.filter(
          (e) => e.kind === "heartbeat" || e.kind === "progress",
        ).length;
        const deliveries = inWin.filter((e) => e.kind === "delivery").length;
        const escalations = inWin.filter((e) => e.kind === "escalation").length;
        const releases = inWin.filter((e) => e.kind === "mission_released").length;
        const missionsDone = inWin.filter(
          (e) =>
            e.kind === "delivery" ||
            (e.kind === "mission_moved" &&
              /done|review/i.test(e.message)),
        ).length;
        const openCalls = callRows.filter(
          (c) => !c.resolvedAt && c.createdAt >= since,
        ).length;
        const lastActivityAt =
          inWin.reduce<number | null>((acc, e) => {
            if (acc == null || e.at > acc) return e.at;
            return acc;
          }, null) ??
          (agent.lastHeartbeat >= since ? agent.lastHeartbeat : null);
        return {
          windowHours: hours,
          claims,
          heartbeats,
          deliveries,
          escalations,
          releases,
          missionsDone,
          openCalls,
          activeMissions: activeMissions.length,
          lastActivityAt,
        };
      }

      const recentActivity: AgentProfileActivity[] = events.slice(0, 40).map((e) => ({
        id: e.id,
        kind: e.kind,
        message: e.message,
        at: e.at,
        missionId: e.missionId,
        missionTitle: e.missionId ? titleById.get(e.missionId) ?? null : null,
        projectId: e.projectId ?? null,
      }));

      return {
        agent,
        keys,
        stats24h: statsForWindow(24),
        stats7d: statsForWindow(24 * 7),
        activeMissions,
        recentActivity,
      };
    }),

  listProjects: (opts?: {
    ownerUserId?: string | null;
    includeShared?: boolean;
    admin?: boolean;
    /** Include soft-archived boards (default false for rails). */
    includeArchived?: boolean;
  }) =>
    withLock(async () => {
      const sql = await getSql();
      await ensureProjects(sql);
      const owner = opts?.ownerUserId?.trim() || null;
      const includeShared = opts?.includeShared !== false;
      const admin = opts?.admin === true;
      const includeArchived = opts?.includeArchived === true;
      let rows: Record<string, unknown>[];
      if (admin || !owner) {
        rows = (
          includeArchived
            ? await sql`select * from ar_projects order by name asc`
            : await sql`
                select * from ar_projects
                where archived_at is null
                order by name asc
              `
        ) as Record<string, unknown>[];
      } else if (includeShared) {
        rows = (
          includeArchived
            ? await sql`
                select * from ar_projects
                where owner_user_id = ${owner} or owner_user_id is null
                order by
                  case when owner_user_id = ${owner} then 0 else 1 end,
                  name asc
              `
            : await sql`
                select * from ar_projects
                where (owner_user_id = ${owner} or owner_user_id is null)
                  and archived_at is null
                order by
                  case when owner_user_id = ${owner} then 0 else 1 end,
                  name asc
              `
        ) as Record<string, unknown>[];
      } else {
        rows = (
          includeArchived
            ? await sql`
                select * from ar_projects
                where owner_user_id = ${owner}
                order by name asc
              `
            : await sql`
                select * from ar_projects
                where owner_user_id = ${owner}
                  and archived_at is null
                order by name asc
              `
        ) as Record<string, unknown>[];
      }
      return rows.map((r) => rowProject(r));
    }),

  createProject: (input: {
    name: string;
    slug?: string;
    description?: string;
    ownerUserId?: string | null;
  }) =>
    withLock(async () => {
      const sql = await getSql();
      const name = input.name.trim();
      if (!name) throw new Error("name required");
      const baseSlug = (input.slug?.trim() || name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || uid("board");
      // Unique slug: append short suffix if taken
      let slug = baseSlug;
      for (let i = 0; i < 8; i++) {
        const hit = await sql`select id from ar_projects where slug = ${slug} limit 1`;
        if (!hit[0]) break;
        slug = `${baseSlug}-${uid("x").slice(-4)}`;
      }
      const pr: Project = {
        id: uid("board"),
        name,
        slug,
        description: (input.description ?? "").trim(),
        ownerUserId: input.ownerUserId ?? null,
        archivedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await insertProject(sql, pr);
      return pr;
    }),

  getProject: (projectId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = (await sql`
        select * from ar_projects where id = ${projectId} limit 1
      `) as Record<string, unknown>[];
      return rows[0] ? rowProject(rows[0]) : null;
    }),

  /** Load a single mission by id (no board scope). Callers must enforce tenancy. */
  getMission: (missionId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = (await sql`
        select * from ar_missions where id = ${missionId} limit 1
      `) as Record<string, unknown>[];
      return rows[0] ? rowMission(rows[0]) : null;
    }),

  /** API key row metadata for ownership checks (no secret). */
  getApiKeyMeta: (keyId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = (await sql`
        select id, project_id, agent_id, name, revoked_at
        from ar_api_keys
        where id = ${keyId}
        limit 1
      `) as Record<string, unknown>[];
      if (!rows[0]) return null;
      const x = rows[0];
      return {
        id: String(x.id),
        projectId: String(x.project_id),
        agentId: x.agent_id != null ? String(x.agent_id) : null,
        name: String(x.name ?? ""),
        revokedAt: ms(x.revoked_at),
      };
    }),

  /** Resolve board id from id or slug. */
  resolveProjectId: (ref: string) =>
    withLock(async () => {
      const sql = await getSql();
      return lookupProjectId(sql, ref);
    }),

  /**
   * True if agent may create/poll work on this board:
   * membership in ar_board_agents, or an active API key on that board.
   */
  agentCanAccessBoard: (agentId: string, projectId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const mem = (await sql`
        select 1 from ar_board_agents
        where agent_id = ${agentId} and project_id = ${projectId}
        limit 1
      `) as unknown[];
      if (mem[0]) return true;
      const key = (await sql`
        select 1 from ar_api_keys
        where agent_id = ${agentId}
          and project_id = ${projectId}
          and revoked_at is null
        limit 1
      `) as unknown[];
      return Boolean(key[0]);
    }),

  /** Idempotent board membership for an existing agent. */
  grantBoardAccess: (agentId: string, projectId: string) =>
    withLock(async () => {
      const sql = await getSql();
      await ensureBoardAgent(sql, projectId, agentId);
      return true;
    }),

  /** Remove board membership (does not revoke API keys). */
  revokeBoardAccess: (agentId: string, projectId: string) =>
    withLock(async () => {
      const sql = await getSql();
      await sql`
        delete from ar_board_agents
        where agent_id = ${agentId} and project_id = ${projectId}
      `;
      return true;
    }),

  /** Platform admin: all boards with owner email + counts. */
  listPlatformBoards: (opts?: { includeArchived?: boolean }) =>
    withLock(async () => {
      const sql = await getSql();
      const includeArchived = opts?.includeArchived === true;
      const boards = (
        includeArchived
          ? await sql`select * from ar_projects order by name asc`
          : await sql`
              select * from ar_projects
              where archived_at is null
              order by name asc
            `
      ) as Record<string, unknown>[];
      const users = (await sql`
        select id, name, email from "user"
      `) as Array<Record<string, unknown>>;
      const userMap = new Map(
        users.map((u) => [
          String(u.id),
          {
            name: u.name != null ? String(u.name) : "",
            email: u.email != null ? String(u.email) : null,
          },
        ]),
      );
      const missionCounts = (await sql`
        select project_id, count(*)::int as n,
          count(*) filter (where column = 'running')::int as running,
          count(*) filter (where column = 'ready')::int as ready
        from ar_missions
        group by project_id
      `) as Array<Record<string, unknown>>;
      const mc = new Map(
        missionCounts.map((r) => [
          String(r.project_id),
          {
            missions: Number(r.n ?? 0),
            running: Number(r.running ?? 0),
            ready: Number(r.ready ?? 0),
          },
        ]),
      );
      const agentCounts = (await sql`
        select project_id, count(*)::int as n from ar_board_agents group by project_id
      `) as Array<{ project_id: string; n: number }>;
      const ac = new Map(agentCounts.map((r) => [String(r.project_id), Number(r.n)]));
      return boards.map((r) => {
        const pr = rowProject(r);
        const owner = pr.ownerUserId ? userMap.get(pr.ownerUserId) : null;
        const counts = mc.get(pr.id) ?? { missions: 0, running: 0, ready: 0 };
        return {
          id: pr.id,
          name: pr.name,
          slug: pr.slug,
          description: pr.description,
          ownerUserId: pr.ownerUserId,
          ownerName: owner?.name ?? null,
          ownerEmail: owner?.email ?? null,
          archivedAt: pr.archivedAt ?? null,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          missionCount: counts.missions,
          runningCount: counts.running,
          readyCount: counts.ready,
          agentCount: ac.get(pr.id) ?? 0,
          shared: !pr.ownerUserId,
        };
      });
    }),

  /** Platform admin: agent fleet + key health. */
  listPlatformAgents: () =>
    withLock(async () => {
      const sql = await getSql();
      const agents = (await sql`
        select * from ar_agents
        where coalesce(is_demo, false) = false
        order by name asc
      `) as Record<string, unknown>[];
      const memberships = (await sql`
        select agent_id, project_id from ar_board_agents
      `) as Array<{ agent_id: string; project_id: string }>;
      const byAgent = new Map<string, string[]>();
      for (const m of memberships) {
        const list = byAgent.get(String(m.agent_id)) ?? [];
        list.push(String(m.project_id));
        byAgent.set(String(m.agent_id), list);
      }
      const keys = (await sql`
        select id, agent_id, project_id, key_prefix, key_suffix, created_at, revoked_at, last_used_at, key_ciphertext
        from ar_api_keys
        where agent_id is not null
        order by created_at desc
      `) as Array<Record<string, unknown>>;
      const keysByAgent = new Map<string, Array<Record<string, unknown>>>();
      for (const k of keys) {
        const aid = String(k.agent_id);
        const list = keysByAgent.get(aid) ?? [];
        list.push(k);
        keysByAgent.set(aid, list);
      }
      return agents.map((r) => {
        const a = rowAgent(r);
        const boards = byAgent.get(a.id) ?? [];
        const klist = keysByAgent.get(a.id) ?? [];
        const active = klist.filter((k) => !ms(k.revoked_at));
        const lastKeyUse = active.reduce<number | null>((acc, k) => {
          const t = ms(k.last_used_at);
          if (t == null) return acc;
          if (acc == null || t > acc) return t;
          return acc;
        }, null);
        const orphan = boards.length === 0 && active.length === 0;
        return {
          id: a.id,
          name: a.name,
          harness: a.harness,
          role: a.role,
          status: a.status,
          lastHeartbeat: a.lastHeartbeat,
          currentMissionId: a.currentMissionId,
          boardIds: boards,
          boardCount: boards.length,
          activeKeyCount: active.length,
          totalKeyCount: klist.length,
          revealableKeyCount: active.filter((k) => Boolean(k.key_ciphertext)).length,
          lastKeyUseAt: lastKeyUse,
          orphan,
          keys: active.slice(0, 8).map((k) => ({
            id: String(k.id),
            projectId: String(k.project_id),
            keyPrefix: String(k.key_prefix ?? ""),
            keySuffix: String(k.key_suffix ?? "").slice(-6),
            revealable: Boolean(k.key_ciphertext),
            createdAt: ms(k.created_at),
            lastUsedAt: ms(k.last_used_at),
          })),
        };
      });
    }),

  transferBoardOwnership: (boardId: string, newOwnerUserId: string | null) =>
    withLock(async () => {
      const sql = await getSql();
      const now = Date.now();
      await sql`
        update ar_projects
        set owner_user_id = ${newOwnerUserId}, updated_at = ${ts(now)}
        where id = ${boardId}
      `;
      const rows = (await sql`
        select * from ar_projects where id = ${boardId} limit 1
      `) as Record<string, unknown>[];
      return rows[0] ? rowProject(rows[0]) : null;
    }),

  bulkMoveMissions: (
    missionIds: string[],
    column: MissionColumn,
    actor = "operator",
  ) =>
    withLock(async () => {
      const sql = await getSql();
      let moved = 0;
      for (const id of missionIds) {
        const rows = await sql`select * from ar_missions where id = ${id} limit 1`;
        if (!rows[0]) continue;
        const m = rowMission(rows[0] as Record<string, unknown>);
        if (m.column === column) continue;
        const next: Mission = { ...m, column, updatedAt: Date.now() };
        await insertMission(sql, next);
        await insertEvent(sql, {
          id: uid("ev"),
          missionId: id,
          agentId: null,
          projectId: m.projectId,
          kind: "mission_moved",
          message: `Moved ${m.column} → ${column} · ${m.title}`,
          at: Date.now(),
          meta: { actor, bulk: "1" },
        });
        await insertHistory(sql, {
          id: uid("hist"),
          missionId: id,
          projectId: m.projectId,
          actorId: actor,
          actorName: actor,
          actorKind: "operator",
          fromColumn: m.column,
          toColumn: column,
          at: Date.now(),
          note: "bulk accept",
        });
        moved++;
      }
      return { moved, column };
    }),

  /** Platform admin: list human accounts + roles + board counts. */
  listPlatformUsers: () =>
    withLock(async () => {
      const sql = await getSql();
      const users = (await sql`
        select id, name, email, "emailVerified", "createdAt", "updatedAt"
        from "user"
        order by "createdAt" desc
        limit 500
      `) as Array<Record<string, unknown>>;
      const roles = (await sql`
        select user_id, email, role from ar_operator_roles
      `) as Array<Record<string, unknown>>;
      const roleByUser = new Map<string, string>();
      const roleByEmail = new Map<string, string>();
      for (const r of roles) {
        if (r.user_id != null) roleByUser.set(String(r.user_id), String(r.role));
        if (r.email != null) roleByEmail.set(String(r.email).toLowerCase(), String(r.role));
      }
      const boardCounts = (await sql`
        select owner_user_id as uid, count(*)::int as n
        from ar_projects
        where owner_user_id is not null
          and archived_at is null
        group by owner_user_id
      `) as Array<{ uid: string; n: number }>;
      const boardsByOwner = new Map(boardCounts.map((r) => [String(r.uid), Number(r.n)]));
      const flags = (await sql`
        select user_id, disabled_at, disabled_reason from ar_user_admin
      `) as Array<Record<string, unknown>>;
      const flagByUser = new Map(
        flags.map((f) => [
          String(f.user_id),
          {
            disabledAt: ms(f.disabled_at),
            disabledReason:
              f.disabled_reason != null ? String(f.disabled_reason) : null,
          },
        ]),
      );
      return users.map((u) => {
        const id = String(u.id);
        const email = u.email != null ? String(u.email) : null;
        const role =
          roleByUser.get(id) ??
          (email ? roleByEmail.get(email.toLowerCase()) : null) ??
          null;
        const flag = flagByUser.get(id);
        return {
          id,
          name: u.name != null ? String(u.name) : "",
          email,
          emailVerified: Boolean(u.emailVerified),
          createdAt: ms(u.createdAt) ?? Date.now(),
          updatedAt: ms(u.updatedAt) ?? Date.now(),
          role,
          boardCount: boardsByOwner.get(id) ?? 0,
          disabled: Boolean(flag?.disabledAt),
          disabledAt: flag?.disabledAt ?? null,
          disabledReason: flag?.disabledReason ?? null,
        };
      });
    }),

  /** True when platform admin has disabled this account. */
  isUserDisabled: (userId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = (await sql`
        select disabled_at from ar_user_admin
        where user_id = ${userId} and disabled_at is not null
        limit 1
      `) as Array<{ disabled_at: unknown }>;
      return Boolean(rows[0]);
    }),

  setUserDisabled: (input: {
    userId: string;
    disabled: boolean;
    reason?: string | null;
  }) =>
    withLock(async () => {
      const sql = await getSql();
      const uid = input.userId.trim();
      if (!uid) throw new Error("userId required");
      if (input.disabled) {
        await sql`
          insert into ar_user_admin (user_id, disabled_at, disabled_reason, updated_at)
          values (${uid}, now(), ${input.reason?.trim() || null}, now())
          on conflict (user_id) do update set
            disabled_at = now(),
            disabled_reason = excluded.disabled_reason,
            updated_at = now()
        `;
        // Kill active sessions so a disabled user cannot keep using a cached cookie.
        await sql`delete from "session" where "userId" = ${uid}`;
      } else {
        await sql`
          insert into ar_user_admin (user_id, disabled_at, disabled_reason, updated_at)
          values (${uid}, null, null, now())
          on conflict (user_id) do update set
            disabled_at = null,
            disabled_reason = null,
            updated_at = now()
        `;
      }
      return { userId: uid, disabled: input.disabled };
    }),

  /**
   * Create a human operator account (email/password) for invite flows.
   * Uses Better Auth-compatible password hash on the credential account row.
   */
  adminCreateUser: (input: {
    email: string;
    name?: string;
    password: string;
    role?: string;
    emailVerified?: boolean;
  }) =>
    withLock(async () => {
      const sql = await getSql();
      const email = input.email.trim().toLowerCase();
      if (!email || !email.includes("@")) throw new Error("valid email required");
      if (!input.password || input.password.length < 8) {
        throw new Error("password must be at least 8 characters");
      }
      const existing = (await sql`
        select id from "user" where lower(email) = ${email} limit 1
      `) as Array<{ id: string }>;
      if (existing[0]) throw new Error("user already exists");

      const { hashPassword } = await import("better-auth/crypto");
      const passwordHash = await hashPassword(input.password);
      const userId = uid("usr");
      const name = (input.name?.trim() || email.split("@")[0] || "operator").slice(0, 120);
      const verified = input.emailVerified !== false;
      await sql`
        insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${userId}, ${name}, ${email}, ${verified}, now(), now())
      `;
      const accountId = uid("acc");
      await sql`
        insert into "account" (
          id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
        )
        values (
          ${accountId}, ${email}, 'credential', ${userId}, ${passwordHash}, now(), now()
        )
      `;
      const role = (input.role?.trim() || "operator") as string;
      if (role === "viewer" || role === "operator" || role === "admin") {
        await sql`
          insert into ar_operator_roles (user_id, email, role, updated_at)
          values (${userId}, ${email}, ${role}, now())
          on conflict (user_id) do update set
            email = excluded.email,
            role = excluded.role,
            updated_at = now()
        `;
      }
      return { id: userId, name, email, role };
    }),

  adminResetUserPassword: (input: { userId: string; password: string }) =>
    withLock(async () => {
      const sql = await getSql();
      const uidIn = input.userId.trim();
      if (!uidIn) throw new Error("userId required");
      if (!input.password || input.password.length < 8) {
        throw new Error("password must be at least 8 characters");
      }
      const users = (await sql`
        select id, email from "user" where id = ${uidIn} limit 1
      `) as Array<{ id: string; email: string }>;
      if (!users[0]) throw new Error("user not found");
      const { hashPassword } = await import("better-auth/crypto");
      const passwordHash = await hashPassword(input.password);
      const email = String(users[0].email);
      const accounts = (await sql`
        select id from "account"
        where "userId" = ${uidIn} and "providerId" = 'credential'
        limit 1
      `) as Array<{ id: string }>;
      if (accounts[0]) {
        await sql`
          update "account"
          set password = ${passwordHash}, "updatedAt" = now()
          where id = ${accounts[0].id}
        `;
      } else {
        await sql`
          insert into "account" (
            id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
          )
          values (
            ${uid("acc")}, ${email}, 'credential', ${uidIn}, ${passwordHash}, now(), now()
          )
        `;
      }
      // Force re-login after password reset
      await sql`delete from "session" where "userId" = ${uidIn}`;
      return { userId: uidIn, email };
    }),

  /** Platform admin: aggregate usage/velocity (no private mission bodies). */
  platformUsage: (rangeDays = 7) =>
    withLock(async () => {
      const sql = await getSql();
      const days = Math.max(1, Math.min(90, rangeDays));
      const since = Date.now() - days * 86_400_000;
      const sinceTs = ts(since);

      const byOwner = (await sql`
        select
          p.owner_user_id as owner_id,
          count(distinct p.id)::int as boards,
          count(m.id)::int as missions,
          count(*) filter (where m.column = 'done')::int as done,
          count(*) filter (where m.column = 'running')::int as running,
          count(*) filter (where m.column = 'ready')::int as ready,
          count(*) filter (where m.column = 'needs_human')::int as needs_human,
          max(m.updated_at) as last_mission_at
        from ar_projects p
        left join ar_missions m
          on m.project_id = p.id
          and m.updated_at >= ${sinceTs}
        where p.owner_user_id is not null
          and p.archived_at is null
        group by p.owner_user_id
        order by count(m.id) desc nulls last
        limit 200
      `) as Array<Record<string, unknown>>;

      const users = (await sql`
        select id, name, email from "user"
      `) as Array<Record<string, unknown>>;
      const userMap = new Map(
        users.map((u) => [
          String(u.id),
          {
            name: u.name != null ? String(u.name) : "",
            email: u.email != null ? String(u.email) : null,
          },
        ]),
      );

      const byAgent = (await sql`
        select
          a.id as agent_id,
          a.name as agent_name,
          a.status,
          a.last_heartbeat,
          count(*) filter (where e.kind ilike '%claim%')::int as claims,
          count(*) filter (where e.kind ilike '%heartbeat%' or e.kind ilike '%progress%')::int as heartbeats,
          count(*) filter (where e.kind ilike '%deliver%')::int as deliveries,
          count(*) filter (where e.kind ilike '%escalat%' or e.kind ilike '%human%')::int as escalations,
          max(e.at) as last_event_at
        from ar_agents a
        left join ar_events e
          on e.agent_id = a.id
          and e.at >= ${sinceTs}
        where coalesce(a.is_demo, false) = false
        group by a.id, a.name, a.status, a.last_heartbeat
        order by count(e.id) desc nulls last
        limit 200
      `) as Array<Record<string, unknown>>;

      const memberships = (await sql`
        select agent_id, count(*)::int as n from ar_board_agents group by agent_id
      `) as Array<{ agent_id: string; n: number }>;
      const memMap = new Map(memberships.map((r) => [String(r.agent_id), Number(r.n)]));

      const totals = (await sql`
        select
          count(*)::int as missions,
          count(*) filter (where column = 'done')::int as done,
          count(*) filter (where column = 'running')::int as running,
          count(*) filter (where column = 'ready')::int as ready,
          count(*) filter (where column = 'needs_human')::int as needs_human
        from ar_missions
        where updated_at >= ${sinceTs}
      `) as Array<Record<string, unknown>>;

      return {
        rangeDays: days,
        since,
        totals: {
          missions: Number(totals[0]?.missions ?? 0),
          done: Number(totals[0]?.done ?? 0),
          running: Number(totals[0]?.running ?? 0),
          ready: Number(totals[0]?.ready ?? 0),
          needsHuman: Number(totals[0]?.needs_human ?? 0),
        },
        users: byOwner.map((r) => {
          const ownerId = r.owner_id != null ? String(r.owner_id) : "";
          const u = userMap.get(ownerId);
          return {
            userId: ownerId,
            name: u?.name ?? "",
            email: u?.email ?? null,
            boards: Number(r.boards ?? 0),
            missions: Number(r.missions ?? 0),
            done: Number(r.done ?? 0),
            running: Number(r.running ?? 0),
            ready: Number(r.ready ?? 0),
            needsHuman: Number(r.needs_human ?? 0),
            lastMissionAt: ms(r.last_mission_at),
          };
        }),
        agents: byAgent.map((r) => ({
          agentId: String(r.agent_id),
          name: String(r.agent_name ?? ""),
          status: String(r.status ?? "offline"),
          lastHeartbeat: ms(r.last_heartbeat),
          boardCount: memMap.get(String(r.agent_id)) ?? 0,
          claims: Number(r.claims ?? 0),
          heartbeats: Number(r.heartbeats ?? 0),
          deliveries: Number(r.deliveries ?? 0),
          escalations: Number(r.escalations ?? 0),
          lastEventAt: ms(r.last_event_at),
        })),
      };
    }),

  archiveProject: (projectId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const now = Date.now();
      await sql`
        update ar_projects
        set archived_at = ${ts(now)}, updated_at = ${ts(now)}
        where id = ${projectId}
      `;
      const rows = (await sql`
        select * from ar_projects where id = ${projectId} limit 1
      `) as Record<string, unknown>[];
      return rows[0] ? rowProject(rows[0]) : null;
    }),

  unarchiveProject: (projectId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const now = Date.now();
      await sql`
        update ar_projects
        set archived_at = null, updated_at = ${ts(now)}
        where id = ${projectId}
      `;
      const rows = (await sql`
        select * from ar_projects where id = ${projectId} limit 1
      `) as Record<string, unknown>[];
      return rows[0] ? rowProject(rows[0]) : null;
    }),

  /**
   * Hard-delete a board and its scoped data (missions, events, calls, history,
   * keys, settings, memberships). Shared seed boards (no owner) refuse unless force.
   */
  deleteProject: (projectId: string, opts?: { force?: boolean }) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = (await sql`
        select * from ar_projects where id = ${projectId} limit 1
      `) as Record<string, unknown>[];
      if (!rows[0]) throw new Error("board not found");
      const pr = rowProject(rows[0]);
      if (
        !opts?.force &&
        (pr.id === "proj_default" || pr.id === "proj_platform" || !pr.ownerUserId)
      ) {
        throw new Error("Cannot delete shared/demo boards — archive instead");
      }

      // Scoped cleanup (order respects FKs where present)
      await sql`delete from ar_mission_history where project_id = ${projectId}`;
      await sql`delete from ar_events where project_id = ${projectId}`;
      await sql`delete from ar_calls where project_id = ${projectId}`;
      await sql`delete from ar_missions where project_id = ${projectId}`;
      await sql`delete from ar_api_keys where project_id = ${projectId}`;
      await sql`delete from ar_project_settings where project_id = ${projectId}`;
      await sql`delete from ar_board_agents where project_id = ${projectId}`;
      await sql`delete from ar_projects where id = ${projectId}`;
      return { id: projectId, name: pr.name };
    }),

  poll: (opts: Parameters<typeof engine.pollMissions>[1]) =>
    withLock(async () => {
      const sql = await getSql();
      const rawProject = opts?.projectId?.trim();
      let projectId = rawProject || undefined;
      if (rawProject) {
        const resolved = await lookupProjectId(sql, rawProject);
        // Unknown slug/id → empty board (do not fall open to all missions)
        if (!resolved) {
          return engine.pollMissions(
            { agents: [], missions: [], events: [], calls: [] },
            { ...opts, projectId: rawProject },
          );
        }
        projectId = resolved;
      }
      const board = await loadBoard(sql, projectId ?? null);
      return engine.pollMissions(board, { ...opts, projectId });
    }),

  claim: (missionId: string, agent: string) =>
    withLock(async () => {
      const sql = await getSql();
      // Full agent set so claim can resolve / auto-register clients
      const before = await loadBoard(sql, null);
      const result = engine.claimMission(before, missionId, agent);
      if (!result.ok) return result;
      const hist = collectHistory(before, result.board, {
        id: result.data.agent.id,
        name: result.data.agent.name,
        kind: "agent",
      }, "claim");
      await persistBoard(sql, result.board, hist);
      const m = result.board.missions.find((x) => x.id === missionId);
      if (m?.projectId) {
        await ensureBoardAgent(sql, m.projectId, result.data.agent.id);
      }
      return result;
    }),

  heartbeat: (missionId: string, agent: string, note?: string) =>
    applyEngine((b) => engine.heartbeatMission(b, missionId, agent, note), agent, "agent", note),

  escalate: (missionId: string, agent: string, question: string) =>
    applyEngine(
      (b) => engine.escalateMission(b, missionId, agent, question),
      agent,
      "agent",
      question,
    ),

  deliver: (
    missionId: string,
    agent: string,
    summary: string,
    artifacts?: string[],
    usage?: import("./types").MissionUsage | null,
  ) =>
    applyEngine(
      (b) => engine.deliverMission(b, missionId, agent, summary, artifacts, usage),
      agent,
      "agent",
      summary,
    ),

  updateMissionFields: (
    missionId: string,
    patch: Partial<{
      title: string;
      objective: string;
      context: string;
      constraints: string;
      acceptance: string;
      priority: Priority;
      tags: string[];
    }>,
  ) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`select * from ar_missions where id = ${missionId} limit 1`;
      if (!rows[0]) {
        return {
          ok: false as const,
          status: 404,
          error: "mission not found",
          code: "mission_not_found",
        };
      }
      const m = rowMission(rows[0] as Record<string, unknown>);
      const next: Mission = {
        ...m,
        title: patch.title !== undefined ? patch.title.trim() : m.title,
        objective: patch.objective !== undefined ? patch.objective.trim() : m.objective,
        context: patch.context !== undefined ? patch.context.trim() : m.context,
        constraints:
          patch.constraints !== undefined ? patch.constraints.trim() : m.constraints,
        acceptance:
          patch.acceptance !== undefined ? patch.acceptance.trim() : m.acceptance,
        priority: patch.priority ?? m.priority,
        tags: patch.tags ?? m.tags,
        updatedAt: Date.now(),
      };
      await insertMission(sql, next);
      await insertEvent(sql, {
        id: uid("ev"),
        missionId,
        agentId: null,
        projectId: next.projectId,
        kind: "note",
        message: `Mission updated · ${next.title}`,
        at: Date.now(),
      });
      return { ok: true as const, mission: engine.missionSummary(next) };
    }),

  moveMissionToProject: (missionId: string, targetProjectId: string, actor = "operator") =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`select * from ar_missions where id = ${missionId} limit 1`;
      if (!rows[0]) {
        return {
          ok: false as const,
          status: 404,
          error: "mission not found",
          code: "mission_not_found",
        };
      }
      const m = rowMission(rows[0] as Record<string, unknown>);
      if (m.projectId === targetProjectId) {
        return { ok: true as const, mission: engine.missionSummary(m) };
      }
      const board = await sql`select id from ar_projects where id = ${targetProjectId} limit 1`;
      if (!board[0]) {
        return {
          ok: false as const,
          status: 404,
          error: "board not found",
          code: "board_not_found",
        };
      }
      const from = m.projectId;
      const next: Mission = { ...m, projectId: targetProjectId, updatedAt: Date.now() };
      await insertMission(sql, next);
      await sql`update ar_events set project_id = ${targetProjectId} where mission_id = ${missionId}`;
      await sql`update ar_calls set project_id = ${targetProjectId} where mission_id = ${missionId}`;
      await sql`update ar_mission_history set project_id = ${targetProjectId} where mission_id = ${missionId}`;
      await insertEvent(sql, {
        id: uid("ev"),
        missionId,
        agentId: null,
        projectId: targetProjectId,
        kind: "mission_moved",
        message: `Moved board ${from} → ${targetProjectId} · ${m.title}`,
        at: Date.now(),
        meta: { from_project: from, to_project: targetProjectId, actor },
      });
      await insertHistory(
        sql,
        historyEntry({
          missionId,
          projectId: targetProjectId,
          actorId: actor,
          actorName: actor,
          actorKind: "operator",
          from: m.column,
          to: m.column,
          note: `board ${from} → ${targetProjectId}`,
        }),
      );
      return { ok: true as const, mission: engine.missionSummary(next) };
    }),

  reply: (callId: string, reply: string, operator = "operator") =>
    applyEngine((b) => engine.replyToCall(b, callId, reply), operator, "operator", reply),

  registerAgent: (
    input: Parameters<typeof engine.registerAgent>[1] & { projectId?: string | null },
  ) =>
    withLock(async () => {
      const sql = await getSql();
      // Full agent list for uniqueness check
      const board = await loadBoard(sql, null);
      const result = engine.registerAgent(board, input);
      if (!result.ok) return result;
      const hist = collectHistory(board, result.board, {
        id: input.name,
        name: input.name,
        kind: "operator",
      }, "register agent");
      await persistBoard(sql, result.board, hist);
      const projectId = input.projectId?.trim();
      if (projectId) {
        await ensureBoardAgent(sql, projectId, result.data.agent.id);
      }
      return result;
    }),

  updateAgent: (
    agentRef: string,
    patch: {
      role?: string;
      skills?: string[];
      status?: import("./types").AgentStatus;
      harness?: import("./types").HarnessKind;
      notes?: string;
    },
  ) =>
    withLock(async () => {
      const sql = await getSql();
      const board = await loadBoard(sql, null);
      const result = engine.updateAgent(board, agentRef, patch);
      if (!result.ok) return result;
      const hist = collectHistory(board, result.board, {
        id: "operator",
        name: "operator",
        kind: "operator",
      }, "update agent");
      await persistBoard(sql, result.board, hist);
      return result;
    }),

  moveMission: (missionId: string, column: MissionColumn, actor = "operator") =>
    applyEngine(
      (b) => {
        const mission = b.missions.find((m) => m.id === missionId);
        if (!mission) {
          return { ok: false, status: 404, error: `Unknown mission: ${missionId}`, code: "mission_not_found" };
        }
        if (mission.column === column) {
          return { ok: true, board: b, data: { mission: engine.missionSummary(mission) } };
        }
        const nextMissions = b.missions.map((m) =>
          m.id === missionId
            ? {
                ...m,
                column,
                updatedAt: Date.now(),
                ...(column === "ready"
                  ? { claimedBy: null, claimedAt: null }
                  : {}),
              }
            : m,
        );
        const ev = {
            id: uid("ev"),
            at: Date.now(),
            missionId,
            agentId: null as string | null,
            kind: "mission_moved" as const,
            message: `Moved to ${column.replace("_", " ")}: ${mission.title}`,
            meta: { from: mission.column, to: column, actor },
          };
        const events = [ev, ...b.events].slice(0, 200);
        const board = { ...b, missions: nextMissions, events };
        const updated = board.missions.find((m) => m.id === missionId)!;
        return { ok: true, board, data: { mission: engine.missionSummary(updated) } };
      },
      actor,
      "operator",
      `move → ${column}`,
    ),

  createMission: (input: {
    title: string;
    objective: string;
    context?: string;
    constraints?: string;
    acceptance?: string;
    priority?: Priority;
    tags?: string[];
    column?: MissionColumn;
    projectId?: string;
    /** When set, record agent as creator (client file path). */
    createdByAgentId?: string | null;
    createdByAgentName?: string | null;
  }) =>
    applyEngine(
      (b) => {
        const id = uid("msn");
        const agentId = input.createdByAgentId ?? null;
        const agentLabel =
          input.createdByAgentName?.trim() ||
          input.createdByAgentId?.trim() ||
          null;
        const mission: Mission = {
          id,
          projectId: input.projectId ?? DEFAULT_PROJECT_ID,
          title: input.title.trim(),
          objective: input.objective.trim(),
          context: (input.context ?? "").trim(),
          constraints: (input.constraints ?? "").trim(),
          acceptance: (input.acceptance ?? "").trim(),
          column: input.column ?? "inbox",
          priority: input.priority ?? "p2",
          tags: input.tags ?? [],
          assigneeId: null,
          claimedBy: null,
          claimedAt: null,
          lastHeartbeat: null,
          progressNote: "",
          artifacts: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const board: BoardData = {
          ...b,
          missions: [mission, ...b.missions],
          events: [
            {
              id: uid("ev"),
              at: Date.now(),
              missionId: id,
              agentId,
              projectId: mission.projectId,
              kind: "mission_created" as const,
              message: agentLabel
                ? `Created by ${agentLabel} · ${mission.title}`
                : `Created · ${mission.title}`,
            },
            ...b.events,
          ].slice(0, 200),
        };
        return { ok: true, board, data: { mission: engine.missionSummary(mission) } };
      },
      input.createdByAgentName ?? input.createdByAgentId ?? "operator",
      input.createdByAgentId || input.createdByAgentName ? "agent" : "operator",
      "created",
    ),

  history: (missionId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`
        select * from ar_mission_history
        where mission_id = ${missionId}
        order by at asc
      `;
      return rows.map((r) => rowHistory(r as Record<string, unknown>));
    }),

  recentHistory: (limit = 100, projectId?: string | null) =>
    withLock(async () => {
      const sql = await getSql();
      const lim = Math.min(Math.max(limit, 1), 500);
      const rows = projectId
        ? await sql`
            select * from ar_mission_history
            where project_id = ${projectId}
            order by at desc
            limit ${lim}
          `
        : await sql`
            select * from ar_mission_history
            order by at desc
            limit ${lim}
          `;
      return rows.map((r) => rowHistory(r as Record<string, unknown>));
    }),

  adminSnapshot: async (
    projectId?: string | null,
    opts?: { allowedProjectIds?: string[] | null },
  ) => {
    const allBoards = !projectId || projectId === "all";
    const board = await durableBoard.snapshot(allBoards ? null : projectId);
    let history = await durableBoard.recentHistory(150, allBoards ? null : projectId);
    let missions = board.missions;
    let events = board.events;
    let calls = board.calls;
    // Tenancy: null/undefined allowedProjectIds = unrestricted (open mode / admin-all).
    // [] = signed-in user with zero readable boards — MUST return empty, not all data.
    // Non-empty = filter to those project ids only.
    // BUG (2026-08-05): `allowed && allowed.length > 0` failed open on [] and leaked
    // every private board to new operators (e.g. re-registered gumbyender@gmail.com).
    const allowed = opts?.allowedProjectIds;
    if (allBoards && allowed != null) {
      if (allowed.length === 0) {
        missions = [];
        events = [];
        calls = [];
        history = [];
      } else {
        const allow = new Set(allowed);
        missions = missions.filter((m) => allow.has(m.projectId));
        const mid = new Set(missions.map((m) => m.id));
        events = events.filter(
          (e) =>
            (e.projectId && allow.has(e.projectId)) ||
            (e.missionId && mid.has(e.missionId)) ||
            !e.missionId,
        );
        calls = calls.filter(
          (c) =>
            (c.projectId && allow.has(c.projectId)) || mid.has(c.missionId),
        );
        history = history.filter(
          (h) =>
            (h.projectId && allow.has(h.projectId)) ||
            mid.has(h.missionId),
        );
      }
    }
    const byColumn: Record<string, number> = {};
    for (const m of missions) {
      byColumn[m.column] = (byColumn[m.column] ?? 0) + 1;
    }
    return {
      serverTime: Date.now(),
      agents: board.agents,
      missions,
      events,
      calls,
      history,
      stats: {
        missions: missions.length,
        agents: board.agents.length,
        openCalls: calls.filter((c) => !c.resolvedAt).length,
        events: events.length,
        history: history.length,
        byColumn,
        scope: allBoards ? ("all" as const) : ("board" as const),
      },
    };
  },

  exportActive: () =>
    withLock(async () => {
      const sql = await getSql();
      const board = await loadBoard(sql);
      return engine.exportActive(board);
    }),

  reset: () =>
    withLock(async () => {
      const sql = await getSql();
      await sql`delete from ar_mission_history`;
      await sql`delete from ar_events`;
      await sql`delete from ar_calls`;
      await sql`delete from ar_missions`;
      await sql`delete from ar_agents`;
      await sql`delete from ar_meta where key = 'seeded'`;
      // keep projects table; ensure seed projects exist
      await seedIfEmpty(sql);
      return loadBoard(sql);
    }),

  ingestGitHubIssue: (input: GitHubIngestInput) =>
    withLock(async () => {
      const sql = await getSql();
      await ensureProjects(sql);
      const mapped = mapGitHubIssueToMission(input);
      const existing = await sql`
        select * from ar_missions where external_id = ${mapped.externalId} limit 1
      `;
      if (existing[0]) {
        const prev = rowMission(existing[0] as Record<string, unknown>);
        const next: Mission = {
          ...prev,
          title: mapped.title,
          objective: mapped.objective,
          context: mapped.context,
          constraints: mapped.constraints,
          acceptance: mapped.acceptance,
          priority: mapped.priority,
          tags: mapped.tags,
          artifacts: mapped.artifacts.length ? mapped.artifacts : prev.artifacts,
          column: mapped.closed ? "done" : prev.column === "done" && !mapped.closed ? "ready" : prev.column,
          updatedAt: Date.now(),
          source: "github",
          externalId: mapped.externalId,
          projectId: mapped.projectId || prev.projectId,
        };
        // If closed, force done with history
        const hist: MissionHistoryEntry[] = [];
        if (prev.column !== next.column) {
          hist.push(
            historyEntry({
              missionId: next.id,
              projectId: next.projectId,
              from: prev.column,
              to: next.column,
              actorKind: "system",
              actorName: "github",
              note: mapped.closed ? "issue closed" : "issue updated",
            }),
          );
        }
        await insertMission(sql, next);
        for (const h of hist) await insertHistory(sql, h);
        await insertEvent(sql, {
          id: uid("ev"),
          missionId: next.id,
          agentId: null,
          projectId: next.projectId,
          kind: "note",
          message: `GitHub sync · ${mapped.externalId}`,
          at: Date.now(),
        });
        return { created: false, mission: next };
      }

      const mission: Mission = {
        id: uid("msn"),
        projectId: mapped.projectId,
        title: mapped.title,
        objective: mapped.objective,
        context: mapped.context,
        constraints: mapped.constraints,
        acceptance: mapped.acceptance,
        column: mapped.column,
        priority: mapped.priority,
        tags: mapped.tags,
        assigneeId: null,
        claimedBy: null,
        claimedAt: null,
        lastHeartbeat: null,
        progressNote: "",
        artifacts: mapped.artifacts,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        externalId: mapped.externalId,
        source: "github",
      };
      await insertMission(sql, mission);
      await insertHistory(
        sql,
        historyEntry({
          missionId: mission.id,
          projectId: mission.projectId,
          from: null,
          to: mission.column,
          actorKind: "system",
          actorName: "github",
          note: "ingested from GitHub issue",
        }),
      );
      await insertEvent(sql, {
        id: uid("ev"),
        missionId: mission.id,
        agentId: null,
        projectId: mission.projectId,
        kind: "mission_created",
        message: `GitHub issue · ${mapped.externalId} · ${mission.title}`,
        at: Date.now(),
      });
      return { created: true, mission };
    }),

  journalMarkdown: (missionId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`select * from ar_missions where id = ${missionId} limit 1`;
      if (!rows[0]) return null;
      const mission = rowMission(rows[0] as Record<string, unknown>);
      const histRows = await sql`
        select * from ar_mission_history
        where mission_id = ${missionId}
        order by at asc
      `;
      const history = histRows.map((r) => rowHistory(r as Record<string, unknown>));
      return renderMissionJournalMarkdown(mission, history);
    }),

  listApiKeys: (projectId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`
        select id, project_id, agent_id, name, key_prefix, key_suffix, key_ciphertext,
               created_at, revoked_at, last_used_at
        from ar_api_keys
        where project_id = ${projectId}
        order by created_at desc
      `;
      return rows.map((r) => {
        const x = r as Record<string, unknown>;
        const prefix = String(x.key_prefix ?? "");
        const suffix =
          x.key_suffix != null && String(x.key_suffix).trim()
            ? String(x.key_suffix).trim()
            : prefix.slice(-6);
        return {
          id: String(x.id),
          projectId: String(x.project_id),
          agentId: x.agent_id != null ? String(x.agent_id) : null,
          name: String(x.name ?? ""),
          keyPrefix: prefix,
          keySuffix: suffix.slice(-6),
          revealable: Boolean(x.key_ciphertext),
          createdAt: ms(x.created_at) ?? Date.now(),
          revokedAt: ms(x.revoked_at),
          lastUsedAt: ms(x.last_used_at),
        };
      });
    }),

  listAgentApiKeys: (agentId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`
        select id, project_id, agent_id, name, key_prefix, key_suffix, key_ciphertext,
               created_at, revoked_at, last_used_at
        from ar_api_keys
        where agent_id = ${agentId}
        order by created_at desc
      `;
      return rows.map((r) => {
        const x = r as Record<string, unknown>;
        const prefix = String(x.key_prefix ?? "");
        const suffix =
          x.key_suffix != null && String(x.key_suffix).trim()
            ? String(x.key_suffix).trim()
            : prefix.slice(-6);
        return {
          id: String(x.id),
          projectId: String(x.project_id),
          agentId: x.agent_id != null ? String(x.agent_id) : null,
          name: String(x.name ?? ""),
          keyPrefix: prefix,
          keySuffix: suffix.slice(-6),
          revealable: Boolean(x.key_ciphertext) && !ms(x.revoked_at),
          createdAt: ms(x.created_at) ?? Date.now(),
          revokedAt: ms(x.revoked_at),
          lastUsedAt: ms(x.last_used_at),
        };
      });
    }),

  revealApiKey: (keyId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = (await sql`
        select id, project_id, agent_id, name, key_prefix, key_suffix, key_ciphertext, revoked_at
        from ar_api_keys
        where id = ${keyId}
        limit 1
      `) as Record<string, unknown>[];
      if (!rows[0]) return null;
      const x = rows[0];
      if (ms(x.revoked_at)) {
        return { ok: false as const, error: "key_revoked" };
      }
      const sealed =
        x.key_ciphertext != null ? String(x.key_ciphertext) : "";
      const secret = unsealApiKeySecret(sealed);
      if (!secret) {
        return {
          ok: false as const,
          error: "not_revealable",
          keyPrefix: String(x.key_prefix ?? ""),
          keySuffix: String(x.key_suffix ?? "").slice(-6) || String(x.key_prefix ?? "").slice(-6),
        };
      }
      return {
        ok: true as const,
        id: String(x.id),
        projectId: String(x.project_id),
        agentId: x.agent_id != null ? String(x.agent_id) : null,
        name: String(x.name ?? ""),
        keyPrefix: String(x.key_prefix ?? ""),
        keySuffix: String(x.key_suffix ?? "").slice(-6),
        secret,
      };
    }),

  createApiKey: (input: { projectId: string; agentId?: string | null; name?: string }) =>
    withLock(async () => {
      const sql = await getSql();
      const mat = createApiKeyMaterial({
        id: uid("key"),
        projectId: input.projectId,
        agentId: input.agentId,
        name: input.name,
      });
      const ciphertext = sealApiKeySecret(mat.secret);
      await sql`
        insert into ar_api_keys (
          id, project_id, agent_id, name, key_prefix, key_suffix, key_hash, key_ciphertext, created_at
        )
        values (
          ${mat.id}, ${mat.projectId}, ${mat.agentId}, ${mat.name},
          ${mat.prefix}, ${mat.suffix}, ${mat.hash}, ${ciphertext}, ${ts(mat.createdAt)}
        )
      `;
      if (mat.agentId) {
        await ensureBoardAgent(sql, mat.projectId, mat.agentId);
      }
      return {
        id: mat.id,
        projectId: mat.projectId,
        agentId: mat.agentId,
        name: mat.name,
        keyPrefix: mat.prefix,
        keySuffix: mat.suffix,
        revealable: true,
        createdAt: mat.createdAt,
        revokedAt: null as number | null,
        lastUsedAt: null as number | null,
        secret: mat.secret,
      };
    }),

  revokeApiKey: (keyId: string) =>
    withLock(async () => {
      const sql = await getSql();
      await sql`
        update ar_api_keys set revoked_at = now() where id = ${keyId} and revoked_at is null
      `;
      return true;
    }),

  verifyPresentedApiKey: (secret: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`
        select id, project_id, agent_id, key_hash, revoked_at from ar_api_keys
      `;
      const candidates = rows.map((r) => {
        const x = r as Record<string, unknown>;
        return {
          id: String(x.id),
          projectId: String(x.project_id),
          agentId: x.agent_id != null ? String(x.agent_id) : null,
          keyHash: String(x.key_hash),
          revokedAt: ms(x.revoked_at),
        };
      });
      const hit = verifyApiKeyAgainstHashes(secret, candidates);
      if (hit) {
        await sql`update ar_api_keys set last_used_at = now() where id = ${hit.id}`;
      }
      return hit;
    }),

  getOperatorPrefs: (userId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = (await sql`
        select * from ar_operator_prefs where user_id = ${userId} limit 1
      `) as Record<string, unknown>[];
      if (!rows[0]) {
        return { userId, theme: null as string | null, prefs: {} as Record<string, unknown> };
      }
      const x = rows[0];
      const prefs =
        x.prefs && typeof x.prefs === "object" && !Array.isArray(x.prefs)
          ? (x.prefs as Record<string, unknown>)
          : {};
      return {
        userId,
        theme: x.theme != null ? String(x.theme) : null,
        prefs,
      };
    }),

  setOperatorPrefs: (
    userId: string,
    patch: { theme?: string | null; prefs?: Record<string, unknown> },
  ) =>
    withLock(async () => {
      const sql = await getSql();
      const cur = (await sql`
        select * from ar_operator_prefs where user_id = ${userId} limit 1
      `) as Record<string, unknown>[];
      const prev = cur[0] ?? {};
      const theme =
        patch.theme !== undefined
          ? patch.theme
          : prev.theme != null
            ? String(prev.theme)
            : null;
      const prevPrefs =
        prev.prefs && typeof prev.prefs === "object" && !Array.isArray(prev.prefs)
          ? (prev.prefs as Record<string, unknown>)
          : {};
      const prefs = patch.prefs ? { ...prevPrefs, ...patch.prefs } : prevPrefs;
      const prefsJson = JSON.stringify(prefs);
      await sql`
        insert into ar_operator_prefs (user_id, theme, prefs, updated_at)
        values (${userId}, ${theme}, ${prefsJson}::jsonb, now())
        on conflict (user_id) do update set
          theme = excluded.theme,
          prefs = excluded.prefs,
          updated_at = now()
      `;
      return { userId, theme, prefs };
    }),

  getProjectSettings: (projectId: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`
        select * from ar_project_settings where project_id = ${projectId} limit 1
      `;
      if (!rows[0]) {
        return {
          projectId,
          githubWebhookSecret: null as string | null,
          githubRepo: null as string | null,
          replyWebhookUrl: null as string | null,
          hasGithubSecret: false,
        };
      }
      const x = rows[0] as Record<string, unknown>;
      const secret = x.github_webhook_secret != null ? String(x.github_webhook_secret) : null;
      return {
        projectId,
        githubWebhookSecret: secret,
        githubRepo: x.github_repo != null ? String(x.github_repo) : null,
        replyWebhookUrl: x.reply_webhook_url != null ? String(x.reply_webhook_url) : null,
        hasGithubSecret: Boolean(secret),
      };
    }),

  updateProjectSettings: (
    projectId: string,
    patch: {
      githubWebhookSecret?: string | null;
      githubRepo?: string | null;
      replyWebhookUrl?: string | null;
    },
  ) =>
    withLock(async () => {
      const sql = await getSql();
      const cur = await sql`select * from ar_project_settings where project_id = ${projectId} limit 1`;
      const prev = (cur[0] as Record<string, unknown> | undefined) ?? {};
      const secret =
        patch.githubWebhookSecret !== undefined
          ? patch.githubWebhookSecret
          : prev.github_webhook_secret != null
            ? String(prev.github_webhook_secret)
            : null;
      const repo =
        patch.githubRepo !== undefined
          ? patch.githubRepo
          : prev.github_repo != null
            ? String(prev.github_repo)
            : null;
      const hook =
        patch.replyWebhookUrl !== undefined
          ? patch.replyWebhookUrl
          : prev.reply_webhook_url != null
            ? String(prev.reply_webhook_url)
            : null;
      await sql`
        insert into ar_project_settings (project_id, github_webhook_secret, github_repo, reply_webhook_url, updated_at)
        values (${projectId}, ${secret}, ${repo}, ${hook}, now())
        on conflict (project_id) do update set
          github_webhook_secret = excluded.github_webhook_secret,
          github_repo = excluded.github_repo,
          reply_webhook_url = excluded.reply_webhook_url,
          updated_at = now()
      `;
      return {
        projectId,
        githubWebhookSecret: secret,
        githubRepo: repo,
        replyWebhookUrl: hook,
        hasGithubSecret: Boolean(secret),
      };
    }),

  findMissionByExternalId: (externalId: string, projectId?: string | null) =>
    withLock(async () => {
      const sql = await getSql();
      const ext = externalId.trim();
      if (!ext) return null;
      const rows = projectId
        ? ((await sql`
            select * from ar_missions
            where external_id = ${ext} and project_id = ${projectId}
            order by updated_at desc
            limit 1
          `) as Record<string, unknown>[])
        : ((await sql`
            select * from ar_missions
            where external_id = ${ext}
            order by updated_at desc
            limit 1
          `) as Record<string, unknown>[]);
      return rows[0] ? rowMission(rows[0]) : null;
    }),

  attachMissionArtifact: (missionId: string, url: string, note?: string) =>
    withLock(async () => {
      const sql = await getSql();
      const rows = await sql`select * from ar_missions where id = ${missionId} limit 1`;
      if (!rows[0]) return null;
      const m = rowMission(rows[0] as Record<string, unknown>);
      const artifacts = Array.from(new Set([...m.artifacts, url.trim()].filter(Boolean)));
      const next = { ...m, artifacts, updatedAt: Date.now() };
      await insertMission(sql, next);
      await insertEvent(sql, {
        id: uid("ev"),
        missionId,
        agentId: null,
        projectId: m.projectId,
        kind: "note",
        message: note?.trim() ? `Artifact · ${note.trim()} · ${url}` : `Artifact · ${url}`,
        at: Date.now(),
      });
      return next;
    }),

  exportHistory: (opts: { projectId?: string | null; missionId?: string | null; format: "json" | "csv" }) =>
    withLock(async () => {
      const sql = await getSql();
      let rows;
      if (opts.missionId) {
        rows = await sql`
          select * from ar_mission_history where mission_id = ${opts.missionId} order by at asc
        `;
      } else if (opts.projectId) {
        rows = await sql`
          select * from ar_mission_history where project_id = ${opts.projectId} order by at asc
        `;
      } else {
        rows = await sql`select * from ar_mission_history order by at asc limit 5000`;
      }
      const history = rows.map((r) => rowHistory(r as Record<string, unknown>));
      if (opts.format === "csv") return { format: "csv" as const, body: historyToCsv(history), count: history.length };
      return { format: "json" as const, body: historyToJson(history), count: history.length };
    }),

  getOperatorRole: (userId: string, email?: string | null) =>
    withLock(async () => {
      const sql = await getSql();
      const byId = await sql`
        select role from ar_operator_roles where user_id = ${userId} limit 1
      `;
      if (byId[0]) {
        const r = String((byId[0] as Record<string, unknown>).role);
        if (r === "viewer" || r === "operator" || r === "admin") return r as import("./auth/roles").OperatorRole;
      }
      if (email?.trim()) {
        const byEmail = await sql`
          select role from ar_operator_roles where lower(email) = ${email.trim().toLowerCase()} limit 1
        `;
        if (byEmail[0]) {
          const r = String((byEmail[0] as Record<string, unknown>).role);
          if (r === "viewer" || r === "operator" || r === "admin") return r as import("./auth/roles").OperatorRole;
        }
      }
      return null;
    }),

  setOperatorRole: (input: {
    userId: string;
    email?: string | null;
    role: import("./auth/roles").OperatorRole;
  }) =>
    withLock(async () => {
      const sql = await getSql();
      await sql`
        insert into ar_operator_roles (user_id, email, role, updated_at)
        values (
          ${input.userId},
          ${input.email ?? null},
          ${input.role},
          now()
        )
        on conflict (user_id) do update set
          email = excluded.email,
          role = excluded.role,
          updated_at = now()
      `;
      return { userId: input.userId, email: input.email ?? null, role: input.role };
    }),

  /** reply that also dispatches webhook when configured */
  replyToCallWithWebhook: async (callId: string, replyText: string, operator = "operator") => {
    const result = await durableBoard.reply(callId, replyText, operator);
    if (!result.ok) return { result, webhook: null as null | object };
    const missionId = result.data.mission?.id ?? "";
    // Read settings without nesting locks: chain after reply released
    const meta = await withLock(async () => {
      const s = await getSql();
      const calls = await s`select * from ar_calls where id = ${callId} limit 1`;
      const callRow = calls[0] as Record<string, unknown> | undefined;
      let projectId =
        (callRow?.project_id != null ? String(callRow.project_id) : null) ??
        (result.data.mission as { projectId?: string } | null | undefined)?.projectId ??
        null;
      if (!projectId && missionId) {
        const rows = await s`select project_id from ar_missions where id = ${missionId} limit 1`;
        const r = rows[0] as Record<string, unknown> | undefined;
        projectId = r?.project_id != null ? String(r.project_id) : null;
      }
      let replyWebhookUrl: string | null = null;
      if (projectId) {
        const st = await s`select reply_webhook_url from ar_project_settings where project_id = ${projectId} limit 1`;
        const sr = st[0] as Record<string, unknown> | undefined;
        replyWebhookUrl = sr?.reply_webhook_url != null ? String(sr.reply_webhook_url) : null;
      }
      return {
        missionId: missionId || (callRow ? String(callRow.mission_id) : ""),
        projectId,
        agentId: callRow?.agent_id != null ? String(callRow.agent_id) : null,
        replyWebhookUrl,
      };
    });
    let webhook: object | null = null;
    if (meta.replyWebhookUrl) {
      const payload = buildReplyWebhookPayload({
        callId,
        missionId: meta.missionId,
        projectId: meta.projectId,
        reply: replyText,
        agentId: meta.agentId,
      });
      const dispatched = await dispatchReplyWebhook(meta.replyWebhookUrl, payload);
      webhook = { payload, dispatched };
    }
    return { result, webhook };
  },
};
