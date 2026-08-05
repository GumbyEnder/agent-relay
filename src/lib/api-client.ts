/**
 * Browser client for the shared Agent Relay board API.
 * UI and external agents use the same /api/agent surface.
 */
import type {
  Agent,
  AgentProfile,
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
  listKeys: (projectId: string) =>
    req<{ ok: true; keys: Array<Record<string, unknown>> }>(
      "GET",
      `/keys?project=${encodeURIComponent(projectId)}`,
    ),
  listAgentKeys: (agentId: string) =>
    req<{ ok: true; keys: Array<Record<string, unknown>> }>(
      "GET",
      `/keys?agent=${encodeURIComponent(agentId)}`,
    ),
  revealApiKey: (keyId: string) =>
    req<{
      ok: true;
      key: {
        id: string;
        secret: string;
        keyPrefix?: string;
        keySuffix?: string;
        name?: string;
      };
    }>("POST", `/keys/${encodeURIComponent(keyId)}/reveal`, {}),
  createApiKey: (input: { projectId: string; agentId?: string | null; name?: string }) =>
    req<{ ok: true; key: Record<string, unknown> & { secret?: string } }>("POST", "/keys", input),
  revokeApiKey: (id: string) =>
    req<{ ok: true }>("POST", `/keys/${id}/revoke`, {}),
  getSettings: (projectId: string) =>
    req<{ ok: true; settings: Record<string, unknown> }>(
      "GET",
      `/projects/${projectId}/settings`,
    ),
  updateSettings: (projectId: string, patch: Record<string, unknown>) =>
    req<{ ok: true; settings: Record<string, unknown> }>(
      "POST",
      `/projects/${projectId}/settings`,
      patch,
    ),
  exportHistory: async (opts: { projectId?: string; format?: "json" | "csv"; missionId?: string }) => {
    const q = new URLSearchParams({ history: "1", format: opts.format ?? "json" });
    if (opts.projectId) q.set("project", opts.projectId);
    if (opts.missionId) q.set("mission", opts.missionId);
    const res = await fetch(`/api/agent/export?${q}`);
    if ((opts.format ?? "json") === "csv") return res.text();
    return res.json();
  },

  agentProfile: (agentId: string) =>
    req<{ ok: true } & AgentProfile>(
      "GET",
      `/agents/${encodeURIComponent(agentId)}/profile`,
    ),
  getPrefs: () =>
    req<{ ok: true; userId: string; theme: string | null; prefs: Record<string, unknown> }>(
      "GET",
      "/me/prefs",
    ),
  setPrefs: (patch: { theme?: string | null; prefs?: Record<string, unknown> }) =>
    req<{ ok: true; userId: string; theme: string | null; prefs: Record<string, unknown> }>(
      "POST",
      "/me/prefs",
      patch,
    ),

  board: (projectId?: string | null) => {
    // null / "all" / "*" → every board the operator can access
    const q =
      !projectId || projectId === "all" || projectId === "*" || projectId === "__all__"
        ? "?project=all"
        : `?project=${encodeURIComponent(projectId)}`;
    return req<BoardSnapshot>("GET", `/board${q}`);
  },
  admin: (projectId?: string | null) => {
    const q =
      !projectId || projectId === "all" || projectId === "*" || projectId === "__all__"
        ? "?project=all"
        : `?project=${encodeURIComponent(projectId)}`;
    return req<Record<string, unknown>>("GET", `/admin${q}`);
  },
  listProjects: () =>
    req<{
      ok: true;
      boards?: Array<{
        id: string;
        name: string;
        slug: string;
        description: string;
        ownerUserId?: string | null;
        createdAt?: number;
        updatedAt?: number;
      }>;
      projects: Array<{
        id: string;
        name: string;
        slug: string;
        description: string;
        ownerUserId?: string | null;
        createdAt?: number;
        updatedAt?: number;
      }>;
    }>("GET", "/boards"),
  createProject: (input: { name: string; slug?: string; description?: string }) =>
    req<{
      ok: true;
      board?: { id: string; name: string; slug: string; ownerUserId?: string | null };
      project: { id: string; name: string; slug: string; ownerUserId?: string | null };
    }>("POST", "/boards", input),
  createBoard: (input: { name: string; slug?: string; description?: string }) =>
    req<{
      ok: true;
      board: { id: string; name: string; slug: string; ownerUserId?: string | null };
      project: { id: string; name: string; slug: string; ownerUserId?: string | null };
    }>("POST", "/boards", input),
  listBoards: (opts?: { includeArchived?: boolean }) =>
    req<{
      ok: true;
      boards: Array<{
        id: string;
        name: string;
        slug: string;
        description: string;
        ownerUserId?: string | null;
        archivedAt?: number | null;
        createdAt?: number;
        updatedAt?: number;
      }>;
      projects: Array<{
        id: string;
        name: string;
        slug: string;
        description: string;
        ownerUserId?: string | null;
        archivedAt?: number | null;
      }>;
    }>(
      "GET",
      `/boards${opts?.includeArchived ? "?archived=1" : ""}`,
    ),
  archiveBoard: (boardId: string) =>
    req<{ ok: true; board: { id: string; name: string; archivedAt?: number | null } }>(
      "POST",
      `/boards/${encodeURIComponent(boardId)}/archive`,
      {},
    ),
  unarchiveBoard: (boardId: string) =>
    req<{ ok: true; board: { id: string; name: string; archivedAt?: number | null } }>(
      "POST",
      `/boards/${encodeURIComponent(boardId)}/unarchive`,
      {},
    ),
  deleteBoard: (boardId: string) =>
    req<{ ok: true; deleted: { id: string; name: string } }>(
      "DELETE",
      `/boards/${encodeURIComponent(boardId)}`,
    ),
  ingestGitHub: (body: unknown) =>
    req<{ ok: true; created: boolean; mission: { id: string; externalId?: string } }>(
      "POST",
      "/ingest/github",
      body,
    ),
  journal: (missionId: string) =>
    req<{ ok: true; markdown: string }>("GET", `/missions/${missionId}/journal`),
  health: () => req<{ ok: boolean; version?: string }>("GET", "/health"),
  claim: (missionId: string, agent: string) =>
    req("POST", `/missions/${missionId}/claim`, { agent }),
  releaseViaMove: (missionId: string) =>
    req("POST", `/missions/${missionId}/move`, { column: "ready", actor: "operator" }),
  heartbeat: (missionId: string, agent: string, note?: string) =>
    req("POST", `/missions/${missionId}/heartbeat`, { agent, note }),
  escalate: (missionId: string, agent: string, question: string) =>
    req("POST", `/missions/${missionId}/escalate`, { agent, question }),
  deliver: (
    missionId: string,
    agent: string,
    summary: string,
    usage?: import("./types").MissionUsage | null,
  ) =>
    req("POST", `/missions/${missionId}/deliver`, {
      agent,
      summary,
      ...(usage ? { usage } : {}),
    }),
  reply: (callId: string, reply: string) =>
    req("POST", `/calls/${callId}/reply`, { reply }),
  move: (missionId: string, column: MissionColumn, actor = "operator") =>
    req("POST", `/missions/${missionId}/move`, { column, actor }),
  transferMission: (missionId: string, projectId: string) =>
    req<{ ok: true; mission: { id: string; projectId: string } }>(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/transfer`,
      { projectId },
    ),
  attachArtifact: (missionId: string, url: string, note?: string) =>
    req<{ ok: true; mission: Mission }>(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/artifacts`,
      { url, note },
    ),
  boardSummary: (projectId?: string | null) => {
    const q =
      !projectId || projectId === "all" || projectId === "__all__"
        ? ""
        : `?project=${encodeURIComponent(projectId)}`;
    return req<{ ok: true; markdown: string; totals: Record<string, number> }>(
      "GET",
      `/summary${q}`,
    );
  },
  updateMission: (
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
    req<{ ok: true; mission: { id: string } }>(
      "PATCH",
      `/missions/${encodeURIComponent(missionId)}`,
      patch,
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
  }) => req<{ ok: true; mission: { id: string } }>("POST", "/missions", input),
  registerAgent: (input: {
    name: string;
    harness: HarnessKind;
    role: string;
    skills?: string[];
    projectId?: string | null;
    /** Default true when projectId set — mint board-bound ark_ with the agent. */
    issueKey?: boolean;
    keyName?: string;
  }) =>
    req<{
      ok: true;
      agent: Agent;
      key?: Record<string, unknown> & { secret?: string };
      keyError?: string;
      issuedKey?: boolean;
    }>("POST", "/agents", input),
  updateAgent: (
    agentId: string,
    patch: {
      role?: string;
      skills?: string[];
      status?: AgentStatus;
      harness?: HarnessKind;
      notes?: string;
    },
  ) =>
    req<{ ok: true; agent: import("./types").Agent }>(
      "PATCH",
      `/agents/${encodeURIComponent(agentId)}`,
      patch,
    ),
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
  grantAgentBoard: (agentId: string, projectId: string) =>
    req<{ ok: true; boardIds: string[] }>(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/boards`,
      { projectId },
    ),
  revokeAgentBoard: (agentId: string, projectId: string) =>
    req<{ ok: true; boardIds: string[] }>(
      "DELETE",
      `/agents/${encodeURIComponent(agentId)}/boards/${encodeURIComponent(projectId)}`,
    ),
  adminListUsers: () =>
    req<{
      ok: true;
      users: Array<{
        id: string;
        name: string;
        email: string | null;
        emailVerified: boolean;
        createdAt: number;
        role: string | null;
        boardCount: number;
        disabled?: boolean;
        disabledAt?: number | null;
        disabledReason?: string | null;
      }>;
    }>("GET", "/admin/users"),
  adminCreateUser: (input: {
    email: string;
    password: string;
    name?: string;
    role?: "viewer" | "operator" | "admin";
  }) =>
    req<{ ok: true; user: { id: string; email: string; name: string; role: string } }>(
      "POST",
      "/admin/users",
      input,
    ),
  adminDisableUser: (userId: string, reason?: string) =>
    req<{ ok: true; userId: string; disabled: boolean }>(
      "POST",
      `/admin/users/${encodeURIComponent(userId)}/disable`,
      { reason },
    ),
  adminEnableUser: (userId: string) =>
    req<{ ok: true; userId: string; disabled: boolean }>(
      "POST",
      `/admin/users/${encodeURIComponent(userId)}/enable`,
      {},
    ),
  adminResetUserPassword: (userId: string, password: string) =>
    req<{ ok: true; userId: string; email: string }>(
      "POST",
      `/admin/users/${encodeURIComponent(userId)}/reset-password`,
      { password },
    ),
  adminUsage: (range: string = "7d") =>
    req<Record<string, unknown>>("GET", `/admin/usage?range=${encodeURIComponent(range)}`),
  setRole: (input: {
    userId: string;
    role: "viewer" | "operator" | "admin";
    email?: string | null;
  }) => req<{ ok: true }>("POST", "/roles", input),
  bulkMoveMissions: (ids: string[], column: MissionColumn) =>
    req<{ ok: true; moved: number; allowed: number; requested: number }>(
      "POST",
      "/missions/bulk-move",
      { ids, column },
    ),
  adminListBoards: (opts?: { includeArchived?: boolean }) =>
    req<{ ok: true; boards: Array<Record<string, unknown>> }>(
      "GET",
      `/admin/boards${opts?.includeArchived ? "?archived=1" : ""}`,
    ),
  adminListAgents: () =>
    req<{ ok: true; agents: Array<Record<string, unknown>> }>("GET", "/admin/agents"),
  adminTransferBoard: (
    boardId: string,
    body: { userId?: string | null; email?: string; shared?: boolean },
  ) =>
    req<{ ok: true; board: unknown }>(
      "POST",
      `/admin/boards/${encodeURIComponent(boardId)}/transfer`,
      body,
    ),
};
