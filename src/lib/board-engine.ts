import type {
  Agent,
  AgentStatus,
  HarnessKind,
  HumanCall,
  Mission,
  MissionColumn,
  MissionEvent,
  Priority,
} from "./types";
import { uid } from "./utils";

export interface BoardData {
  agents: Agent[];
  missions: Mission[];
  events: MissionEvent[];
  calls: HumanCall[];
}

export type EngineError = {
  ok: false;
  status: number;
  error: string;
  code?: string;
};

export type EngineOk<T> = { ok: true; data: T; board: BoardData };

export type EngineResult<T> = EngineOk<T> | EngineError;

function pushEvent(
  events: MissionEvent[],
  partial: Omit<MissionEvent, "id" | "at"> & { at?: number },
): MissionEvent[] {
  return [
    {
      id: uid("ev"),
      at: partial.at ?? Date.now(),
      ...partial,
    },
    ...events,
  ].slice(0, 200);
}

function touchMission(m: Mission, patch: Partial<Mission>): Mission {
  return { ...m, ...patch, updatedAt: Date.now() };
}

export function resolveAgent(
  board: BoardData,
  ref: string | undefined | null,
): Agent | undefined {
  if (!ref) return undefined;
  const key = ref.trim().toLowerCase();
  return board.agents.find(
    (a) => a.id === ref || a.id.toLowerCase() === key || a.name.toLowerCase() === key,
  );
}

export function missionSummary(m: Mission) {
  return {
    id: m.id,
    projectId: m.projectId,
    title: m.title,
    objective: m.objective,
    context: m.context,
    constraints: m.constraints,
    acceptance: m.acceptance,
    column: m.column,
    priority: m.priority,
    tags: m.tags,
    claimedBy: m.claimedBy,
    claimedAt: m.claimedAt,
    lastHeartbeat: m.lastHeartbeat,
    progressNote: m.progressNote,
    artifacts: m.artifacts,
    delivery: m.delivery,
    externalId: m.externalId ?? null,
    source: m.source ?? null,
    usage: m.usage ?? null,
    updatedAt: m.updatedAt,
  };
}

export function pollMissions(
  board: BoardData,
  opts: {
    column?: MissionColumn;
    limit?: number;
    agent?: string;
    tags?: string[];
    /** When set, mission must share at least one tag with this skill list. */
    skills?: string[];
    /**
     * When true and agent resolves with skills, also require mission tags ∩ agent.skills
     * (in addition to explicit skills/tags filters). Default true when agent has skills.
     */
    matchAgentSkills?: boolean;
    projectId?: string;
  } = {},
): EngineResult<{ missions: ReturnType<typeof missionSummary>[]; agent: string | null }> {
  const column = opts.column ?? "ready";
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const agent = resolveAgent(board, opts.agent);
  const tagFilter = (opts.tags ?? []).map((t) => t.toLowerCase());
  const skillFilter = (opts.skills ?? []).map((s) => s.toLowerCase());
  const agentSkills = (agent?.skills ?? []).map((s) => s.toLowerCase());
  // Only when explicitly requested — default poll must remain unfiltered by agent skills.
  const useAgentSkills = opts.matchAgentSkills === true && agentSkills.length > 0;

  let list = board.missions.filter((m) => {
    if (opts.projectId && m.projectId !== opts.projectId) return false;
    if (m.column !== column) return false;
    if (column === "ready" || column === "inbox") {
      if (m.claimedBy) return false;
    }
    const tags = m.tags.map((t) => t.toLowerCase());
    if (tagFilter.length) {
      if (!tagFilter.every((t) => tags.includes(t))) return false;
    }
    // Explicit skills query: mission tags must intersect the skill set
    if (skillFilter.length) {
      if (!skillFilter.some((s) => tags.includes(s))) return false;
    }
    // Optional agent skill routing when no explicit filters
    if (useAgentSkills && agentSkills.length) {
      if (!agentSkills.some((s) => tags.includes(s))) return false;
    }
    return true;
  });

  // Prefer higher priority
  const rank: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
  list = [...list].sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt - b.createdAt);

  return {
    ok: true,
    board,
    data: {
      agent: agent?.name ?? opts.agent ?? null,
      missions: list.slice(0, limit).map(missionSummary),
    },
  };
}

/** Atomic claim — reject if already claimed by another agent. */
export function claimMission(
  board: BoardData,
  missionId: string,
  agentRef: string,
): EngineResult<{ mission: ReturnType<typeof missionSummary>; agent: Agent }> {
  const ensured = ensureAgent(board, agentRef, { harness: "custom", role: "client" });
  board = ensured.board;
  const agent = ensured.agent;
  const mission = board.missions.find((m) => m.id === missionId);
  if (!mission) {
    return { ok: false, status: 404, error: `Unknown mission: ${missionId}`, code: "mission_not_found" };
  }
  if (mission.claimedBy && mission.claimedBy !== agent.id) {
    const holder = board.agents.find((a) => a.id === mission.claimedBy);
    return {
      ok: false,
      status: 409,
      error: `Mission already claimed by ${holder?.name ?? mission.claimedBy}`,
      code: "already_claimed",
    };
  }
  if (!["ready", "inbox", "running"].includes(mission.column) && mission.claimedBy !== agent.id) {
    return {
      ok: false,
      status: 409,
      error: `Mission is in ${mission.column}; claim only from ready/inbox (or re-claim own running)`,
      code: "invalid_column",
    };
  }

  const now = Date.now();
  const missions = board.missions.map((m) =>
    m.id === missionId
      ? touchMission(m, {
          claimedBy: agent.id,
          claimedAt: m.claimedAt ?? now,
          assigneeId: agent.id,
          column: m.column === "ready" || m.column === "inbox" ? "running" : m.column,
          lastHeartbeat: now,
        })
      : m,
  );
  const agents = board.agents.map((a) => {
    if (a.id === agent.id) {
      return {
        ...a,
        status: "busy" as AgentStatus,
        currentMissionId: missionId,
        lastHeartbeat: now,
      };
    }
    if (a.currentMissionId === missionId && a.id !== agent.id) {
      return {
        ...a,
        currentMissionId: null,
        status: a.status === "busy" ? ("idle" as const) : a.status,
      };
    }
    return a;
  });
  const next: BoardData = {
    ...board,
    missions,
    agents,
    events: pushEvent(board.events, {
      missionId,
      agentId: agent.id,
      kind: "mission_claimed",
      message: `${agent.name} claimed · ${mission.title}`,
    }),
  };
  const updated = next.missions.find((m) => m.id === missionId)!;
  return {
    ok: true,
    board: next,
    data: { mission: missionSummary(updated), agent: agents.find((a) => a.id === agent.id)! },
  };
}

export function heartbeatMission(
  board: BoardData,
  missionId: string,
  agentRef: string,
  note?: string,
): EngineResult<{ mission: ReturnType<typeof missionSummary> }> {
  const ensured = ensureAgent(board, agentRef, { harness: "custom", role: "client" });
  board = ensured.board;
  const agent = ensured.agent;
  const mission = board.missions.find((m) => m.id === missionId);
  if (!mission) {
    return { ok: false, status: 404, error: `Unknown mission: ${missionId}`, code: "mission_not_found" };
  }
  if (mission.claimedBy && mission.claimedBy !== agent.id) {
    return {
      ok: false,
      status: 403,
      error: "Only the claiming agent may heartbeat this mission",
      code: "not_claimer",
    };
  }

  const now = Date.now();
  const missions = board.missions.map((m) =>
    m.id === missionId
      ? touchMission(m, {
          lastHeartbeat: now,
          progressNote: note?.trim() ? note.trim() : m.progressNote,
          claimedBy: m.claimedBy ?? agent.id,
        })
      : m,
  );
  const agents = board.agents.map((a) =>
    a.id === agent.id
      ? { ...a, lastHeartbeat: now, status: "busy" as const, currentMissionId: missionId }
      : a,
  );
  const next: BoardData = {
    ...board,
    missions,
    agents,
    events: pushEvent(board.events, {
      missionId,
      agentId: agent.id,
      kind: "heartbeat",
      message: note?.trim() ? `Heartbeat · ${note.trim()}` : `Heartbeat · ${mission.title}`,
    }),
  };
  return {
    ok: true,
    board: next,
    data: { mission: missionSummary(next.missions.find((m) => m.id === missionId)!) },
  };
}

export function escalateMission(
  board: BoardData,
  missionId: string,
  agentRef: string,
  question: string,
): EngineResult<{ call: HumanCall; mission: ReturnType<typeof missionSummary> }> {
  const ensured = ensureAgent(board, agentRef, { harness: "custom", role: "client" });
  board = ensured.board;
  const agent = ensured.agent;
  const mission = board.missions.find((m) => m.id === missionId);
  if (!mission) {
    return { ok: false, status: 404, error: `Unknown mission: ${missionId}`, code: "mission_not_found" };
  }
  const q = question.trim();
  if (!q) {
    return { ok: false, status: 400, error: "question is required (one clear decision)", code: "bad_request" };
  }

  const call: HumanCall = {
    id: uid("call"),
    missionId,
    agentId: agent.id,
    question: q,
    urgency: mission.priority,
    createdAt: Date.now(),
    resolvedAt: null,
    reply: null,
  };
  const missions = board.missions.map((m) =>
    m.id === missionId
      ? touchMission(m, { column: "needs_human", progressNote: q })
      : m,
  );
  const next: BoardData = {
    ...board,
    missions,
    calls: [call, ...board.calls],
    events: pushEvent(board.events, {
      missionId,
      agentId: agent.id,
      kind: "escalation",
      message: `Needs human · ${q}`,
    }),
  };
  return {
    ok: true,
    board: next,
    data: { call, mission: missionSummary(next.missions.find((m) => m.id === missionId)!) },
  };
}

export function deliverMission(
  board: BoardData,
  missionId: string,
  agentRef: string,
  summary: string,
  artifacts: string[] = [],
  usage?: import("./types").MissionUsage | null,
): EngineResult<{ mission: ReturnType<typeof missionSummary> }> {
  const ensured = ensureAgent(board, agentRef, { harness: "custom", role: "client" });
  board = ensured.board;
  const agent = ensured.agent;
  const mission = board.missions.find((m) => m.id === missionId);
  if (!mission) {
    return { ok: false, status: 404, error: `Unknown mission: ${missionId}`, code: "mission_not_found" };
  }
  if (mission.claimedBy && mission.claimedBy !== agent.id) {
    return {
      ok: false,
      status: 403,
      error: "Only the claiming agent may deliver this mission",
      code: "not_claimer",
    };
  }

  const now = Date.now();
  const delivery = summary.trim() || mission.delivery || "";
  const missions = board.missions.map((m) =>
    m.id === missionId
      ? touchMission(m, {
          column: "review",
          delivery,
          artifacts: artifacts.length ? artifacts : m.artifacts,
          lastHeartbeat: now,
          ...(usage ? { usage } : {}),
        })
      : m,
  );
  const agents = board.agents.map((a) =>
    a.id === agent.id || a.currentMissionId === missionId
      ? {
          ...a,
          currentMissionId: a.currentMissionId === missionId ? null : a.currentMissionId,
          status: a.currentMissionId === missionId ? ("idle" as const) : a.status,
          lastHeartbeat: a.id === agent.id ? now : a.lastHeartbeat,
        }
      : a,
  );
  const next: BoardData = {
    ...board,
    missions,
    agents,
    events: pushEvent(board.events, {
      missionId,
      agentId: agent.id,
      kind: "delivery",
      message: `Delivered for review · ${mission.title}`,
    }),
  };
  return {
    ok: true,
    board: next,
    data: { mission: missionSummary(next.missions.find((m) => m.id === missionId)!) },
  };
}

export function replyToCall(
  board: BoardData,
  callId: string,
  reply: string,
): EngineResult<{ call: HumanCall; mission: ReturnType<typeof missionSummary> | null }> {
  const call = board.calls.find((c) => c.id === callId);
  if (!call) {
    return { ok: false, status: 404, error: `Unknown call: ${callId}`, code: "call_not_found" };
  }
  const text = reply.trim();
  if (!text) {
    return { ok: false, status: 400, error: "reply is required", code: "bad_request" };
  }
  const calls = board.calls.map((c) =>
    c.id === callId ? { ...c, reply: text, resolvedAt: Date.now() } : c,
  );
  const missions = board.missions.map((m) =>
    m.id === call.missionId && m.column === "needs_human"
      ? touchMission(m, {
          column: "running",
          progressNote: `Human reply: ${text}`,
        })
      : m,
  );
  const next: BoardData = {
    ...board,
    calls,
    missions,
    events: pushEvent(board.events, {
      missionId: call.missionId,
      agentId: call.agentId,
      kind: "human_reply",
      message: `Human replied · ${text}`,
    }),
  };
  const mission = next.missions.find((m) => m.id === call.missionId);
  return {
    ok: true,
    board: next,
    data: {
      call: next.calls.find((c) => c.id === callId)!,
      mission: mission ? missionSummary(mission) : null,
    },
  };
}

/** Ensure agent exists by name/id; create if missing (client agents often skip UI roster). */
export function ensureAgent(
  board: BoardData,
  ref: string,
  opts?: { harness?: HarnessKind; role?: string; skills?: string[] },
): { board: BoardData; agent: Agent; created: boolean } {
  const existing = resolveAgent(board, ref);
  if (existing) return { board, agent: existing, created: false };
  const name = ref.trim().toLowerCase().replace(/\s+/g, "-") || uid("agent");
  const agent: Agent = {
    id: uid("agent"),
    name,
    harness: opts?.harness ?? "custom",
    role: (opts?.role ?? "client").trim() || "client",
    status: "online",
    skills: opts?.skills ?? [],
    lastHeartbeat: Date.now(),
    currentMissionId: null,
    isDemo: false,
  };
  return {
    board: {
      ...board,
      agents: [agent, ...board.agents],
      events: pushEvent(board.events, {
        missionId: null,
        agentId: agent.id,
        kind: "agent_registered",
        message: `Agent auto-registered · ${agent.name} (${agent.harness})`,
      }),
    },
    agent,
    created: true,
  };
}

export function registerAgent(
  board: BoardData,
  input: {
    name: string;
    harness: HarnessKind;
    role?: string;
    skills?: string[];
  },
): EngineResult<{ agent: Agent }> {
  const name = input.name.trim().toLowerCase().replace(/\s+/g, "-");
  if (!name) {
    return { ok: false, status: 400, error: "name is required", code: "bad_request" };
  }
  const existing = board.agents.find((a) => a.name === name);
  if (existing) {
    // Idempotent: return existing real agent (upgrade out of demo if needed)
    const agent: Agent = {
      ...existing,
      harness: input.harness || existing.harness,
      role: (input.role ?? existing.role).trim() || existing.role,
      skills: input.skills ?? existing.skills,
      status: "online",
      lastHeartbeat: Date.now(),
      isDemo: false,
      notes: existing.isDemo ? undefined : existing.notes,
    };
    return {
      ok: true,
      board: {
        ...board,
        agents: board.agents.map((a) => (a.id === agent.id ? agent : a)),
      },
      data: { agent },
    };
  }
  const agent: Agent = {
    id: uid("agent"),
    name,
    harness: input.harness,
    role: (input.role ?? "agent").trim() || "agent",
    status: "online",
    skills: input.skills ?? [],
    lastHeartbeat: Date.now(),
    currentMissionId: null,
    isDemo: false,
  };
  const next: BoardData = {
    ...board,
    agents: [agent, ...board.agents],
    events: pushEvent(board.events, {
      missionId: null,
      agentId: agent.id,
      kind: "agent_registered",
      message: `Agent registered · ${agent.name} (${input.harness})`,
    }),
  };
  return { ok: true, board: next, data: { agent } };
}

export function exportActive(board: BoardData) {
  return {
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    missions: board.missions.filter((m) => m.column !== "done"),
    agents: board.agents,
    open_calls: board.calls.filter((c) => !c.resolvedAt),
  };
}
