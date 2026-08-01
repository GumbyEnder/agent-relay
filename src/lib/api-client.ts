/**
 * Browser client for the shared Agent Relay board API.
 * UI and external agents use the same /api/agent surface.
 */
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

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api/agent${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || (data && typeof data === "object" && "ok" in data && data.ok === false)) {
    const err = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return data;
}

export interface BoardSnapshot {
  ok: true;
  agents: Agent[];
  missions: Mission[];
  events: MissionEvent[];
  calls: HumanCall[];
}

export const agentApi = {
  board: () => req<BoardSnapshot>("GET", "/board"),
  health: () => req<{ ok: boolean; version?: string }>("GET", "/health"),
  claim: (missionId: string, agent: string) =>
    req("POST", `/missions/${missionId}/claim`, { agent }),
  releaseViaMove: (missionId: string) =>
    req("POST", `/missions/${missionId}/move`, { column: "ready", actor: "operator" }),
  heartbeat: (missionId: string, agent: string, note?: string) =>
    req("POST", `/missions/${missionId}/heartbeat`, { agent, note }),
  escalate: (missionId: string, agent: string, question: string) =>
    req("POST", `/missions/${missionId}/escalate`, { agent, question }),
  deliver: (missionId: string, agent: string, summary: string) =>
    req("POST", `/missions/${missionId}/deliver`, { agent, summary }),
  reply: (callId: string, reply: string) =>
    req("POST", `/calls/${callId}/reply`, { reply }),
  move: (missionId: string, column: MissionColumn, actor = "operator") =>
    req("POST", `/missions/${missionId}/move`, { column, actor }),
  createMission: (input: {
    title: string;
    objective: string;
    context?: string;
    constraints?: string;
    acceptance?: string;
    priority?: Priority;
    tags?: string[];
    column?: MissionColumn;
  }) => req<{ ok: true; mission: { id: string } }>("POST", "/missions", input),
  registerAgent: (input: {
    name: string;
    harness: HarnessKind;
    role: string;
    skills?: string[];
  }) => req("POST", "/agents", input),
  setAgentStatus: async (_id: string, _status: AgentStatus) => {
    // no dedicated endpoint yet — refresh board only
  },
  removeAgent: async (_id: string) => {
    /* not exposed */
  },
  history: (missionId: string) =>
    req<{ ok: true; history: MissionHistoryEntry[] }>(
      "GET",
      `/missions/${missionId}/history`,
    ),
  exportActive: async () => {
    const data = await req<{ ok: true } & Record<string, unknown>>("GET", "/export");
    const { ok: _o, ...rest } = data;
    return JSON.stringify(rest, null, 2);
  },
  reset: () => req("POST", "/reset", {}),
};
