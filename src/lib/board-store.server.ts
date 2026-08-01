/**
 * Durable board store (Postgres via DATABASE_URL, else PGLite).
 * All agent API + UI paths share this single source of truth.
 */
import { getSql, type Sql } from "./db";
import { SEED_AGENTS, SEED_CALLS, SEED_EVENTS, SEED_MISSIONS } from "./seed";
import type {
  Agent,
  AgentStatus,
  HarnessKind,
  HumanCall,
  Mission,
  MissionColumn,
  MissionEvent,
  MissionHistoryEntry,
  Priority,
} from "./types";
import { uid } from "./utils";
import type { BoardData, EngineResult } from "./board-engine";
import * as engine from "./board-engine";

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

function rowMission(r: Record<string, unknown>): Mission {
  return {
    id: String(r.id),
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
  };
}

function rowAgent(r: Record<string, unknown>): Agent {
  return {
    id: String(r.id),
    name: String(r.name),
    harness: String(r.harness) as HarnessKind,
    role: String(r.role ?? ""),
    status: String(r.status ?? "online") as AgentStatus,
    skills: asJsonArray(r.skills),
    lastHeartbeat: ms(r.last_heartbeat) ?? Date.now(),
    currentMissionId: r.current_mission_id != null ? String(r.current_mission_id) : null,
    notes: r.notes != null ? String(r.notes) : undefined,
  };
}

function rowCall(r: Record<string, unknown>): HumanCall {
  return {
    id: String(r.id),
    missionId: String(r.mission_id),
    agentId: r.agent_id != null ? String(r.agent_id) : null,
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

async function loadBoard(sql: Sql): Promise<BoardData> {
  const [agents, missions, events, calls] = await Promise.all([
    sql`select * from ar_agents order by name asc`,
    sql`select * from ar_missions order by updated_at desc`,
    sql`select * from ar_events order by at desc limit 200`,
    sql`select * from ar_calls order by created_at desc`,
  ]);
  return {
    agents: agents.map((r) => rowAgent(r as Record<string, unknown>)),
    missions: missions.map((r) => rowMission(r as Record<string, unknown>)),
    events: events.map((r) => rowEvent(r as Record<string, unknown>)),
    calls: calls.map((r) => rowCall(r as Record<string, unknown>)),
  };
}

async function insertAgent(sql: Sql, a: Agent) {
  await sql`
    insert into ar_agents (id, name, harness, role, status, skills, last_heartbeat, current_mission_id, notes)
    values (
      ${a.id}, ${a.name}, ${a.harness}, ${a.role}, ${a.status},
      ${JSON.stringify(a.skills)}::jsonb,
      ${ts(a.lastHeartbeat)}, ${a.currentMissionId}, ${a.notes ?? null}
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
      updated_at = now()
  `;
}

async function insertMission(sql: Sql, m: Mission) {
  await sql`
    insert into ar_missions (
      id, title, objective, context, constraints_text, acceptance,
      column_id, priority, tags, assignee_id, claimed_by, claimed_at,
      last_heartbeat, progress_note, artifacts, delivery, created_at, updated_at
    ) values (
      ${m.id}, ${m.title}, ${m.objective}, ${m.context}, ${m.constraints}, ${m.acceptance},
      ${m.column}, ${m.priority}, ${JSON.stringify(m.tags)}::jsonb,
      ${m.assigneeId}, ${m.claimedBy}, ${ts(m.claimedAt)},
      ${ts(m.lastHeartbeat)}, ${m.progressNote}, ${JSON.stringify(m.artifacts)}::jsonb,
      ${m.delivery ?? null}, ${ts(m.createdAt)}, ${ts(m.updatedAt)}
    )
    on conflict (id) do update set
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
      updated_at = excluded.updated_at
  `;
}

async function insertCall(sql: Sql, c: HumanCall) {
  await sql`
    insert into ar_calls (id, mission_id, agent_id, question, urgency, created_at, resolved_at, reply)
    values (
      ${c.id}, ${c.missionId}, ${c.agentId}, ${c.question}, ${c.urgency},
      ${ts(c.createdAt)}, ${ts(c.resolvedAt)}, ${c.reply}
    )
    on conflict (id) do update set
      resolved_at = excluded.resolved_at,
      reply = excluded.reply
  `;
}

async function insertEvent(sql: Sql, e: MissionEvent) {
  await sql`
    insert into ar_events (id, mission_id, agent_id, kind, message, at, meta)
    values (
      ${e.id}, ${e.missionId}, ${e.agentId}, ${e.kind}, ${e.message},
      ${ts(e.at)}, ${e.meta ? JSON.stringify(e.meta) : null}::jsonb
    )
    on conflict (id) do nothing
  `;
}

async function insertHistory(sql: Sql, h: MissionHistoryEntry) {
  await sql`
    insert into ar_mission_history (
      id, mission_id, actor_id, actor_name, actor_kind,
      from_column, to_column, at, note, meta
    ) values (
      ${h.id}, ${h.missionId}, ${h.actorId}, ${h.actorName}, ${h.actorKind},
      ${h.fromColumn}, ${h.toColumn}, ${ts(h.at)}, ${h.note ?? null},
      ${h.meta ? JSON.stringify(h.meta) : null}::jsonb
    )
    on conflict (id) do nothing
  `;
}

function historyEntry(opts: {
  missionId: string;
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

async function seedIfEmpty(sql: Sql) {
  const rows = await sql`select count(*)::int as c from ar_missions`;
  const c = Number((rows[0] as { c: number }).c ?? 0);
  if (c > 0) return;

  const board: BoardData = {
    agents: structuredClone(SEED_AGENTS),
    missions: structuredClone(SEED_MISSIONS),
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
  const prev = globalRef.__arBoardChain__ ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  globalRef.__arBoardChain__ = prev.then(() => gate);
  await prev.catch(() => undefined);
  try {
    await ensureBoardReady();
    return await fn();
  } finally {
    release();
  }
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
  snapshot: () =>
    withLock(async () => {
      const sql = await getSql();
      return loadBoard(sql);
    }),

  poll: (opts: Parameters<typeof engine.pollMissions>[1]) =>
    withLock(async () => {
      const sql = await getSql();
      const board = await loadBoard(sql);
      return engine.pollMissions(board, opts);
    }),

  claim: (missionId: string, agent: string) =>
    applyEngine((b) => engine.claimMission(b, missionId, agent), agent, "agent", "claim"),

  heartbeat: (missionId: string, agent: string, note?: string) =>
    applyEngine((b) => engine.heartbeatMission(b, missionId, agent, note), agent, "agent", note),

  escalate: (missionId: string, agent: string, question: string) =>
    applyEngine(
      (b) => engine.escalateMission(b, missionId, agent, question),
      agent,
      "agent",
      question,
    ),

  deliver: (missionId: string, agent: string, summary: string, artifacts?: string[]) =>
    applyEngine(
      (b) => engine.deliverMission(b, missionId, agent, summary, artifacts),
      agent,
      "agent",
      summary,
    ),

  reply: (callId: string, reply: string, operator = "operator") =>
    applyEngine((b) => engine.replyToCall(b, callId, reply), operator, "operator", reply),

  registerAgent: (input: Parameters<typeof engine.registerAgent>[1]) =>
    applyEngine((b) => engine.registerAgent(b, input), input.name, "operator", "register agent"),

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
  }) =>
    applyEngine(
      (b) => {
        const id = uid("msn");
        const mission: Mission = {
          id,
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
              agentId: null as string | null,
              kind: "mission_created" as const,
              message: `Created · ${mission.title}`,
            },
            ...b.events,
          ].slice(0, 200),
        };
        return { ok: true, board, data: { mission: engine.missionSummary(mission) } };
      },
      "operator",
      "operator",
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
      await seedIfEmpty(sql);
      return loadBoard(sql);
    }),
};
