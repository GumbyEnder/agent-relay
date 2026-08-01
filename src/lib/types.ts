export type MissionColumn =
  | "inbox"
  | "ready"
  | "running"
  | "needs_human"
  | "review"
  | "done"
  | "blocked";

export type Priority = "p0" | "p1" | "p2" | "p3";

export type HarnessKind =
  | "claude_code"
  | "codex"
  | "cursor"
  | "opencode"
  | "gemini_cli"
  | "copilot"
  | "amp"
  | "mcp"
  | "custom";

export type AgentStatus = "online" | "busy" | "idle" | "offline" | "error";

export type EventKind =
  | "mission_created"
  | "mission_moved"
  | "mission_claimed"
  | "mission_released"
  | "heartbeat"
  | "progress"
  | "escalation"
  | "human_reply"
  | "delivery"
  | "agent_registered"
  | "agent_status"
  | "note";

export interface Agent {
  id: string;
  name: string;
  harness: HarnessKind;
  role: string;
  status: AgentStatus;
  skills: string[];
  lastHeartbeat: number;
  currentMissionId: string | null;
  notes?: string;
}

export interface MissionEvent {
  id: string;
  missionId: string | null;
  agentId: string | null;
  projectId?: string | null;
  kind: EventKind;
  message: string;
  at: number;
  meta?: Record<string, string>;
}

export interface HumanCall {
  id: string;
  missionId: string;
  agentId: string | null;
  projectId?: string | null;
  question: string;
  urgency: Priority;
  createdAt: number;
  resolvedAt: number | null;
  reply: string | null;
}

/** Product name: Board. Internal/API still use "project" in paths and ids. */
export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  /** Owning human user id (Better Auth). Null = shared/legacy seed board. */
  ownerUserId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Alias for product copy */
export type Board = Project;

export interface Mission {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  context: string;
  constraints: string;
  acceptance: string;
  column: MissionColumn;
  priority: Priority;
  tags: string[];
  assigneeId: string | null;
  claimedBy: string | null;
  claimedAt: number | null;
  lastHeartbeat: number | null;
  progressNote: string;
  artifacts: string[];
  createdAt: number;
  updatedAt: number;
  delivery?: string;
  externalId?: string | null;
  source?: string | null;
}

export const COLUMNS: {
  id: MissionColumn;
  label: string;
  hint: string;
}[] = [
  { id: "inbox", label: "Inbox", hint: "Untriaged missions" },
  { id: "ready", label: "Ready", hint: "Claimable by any agent" },
  { id: "running", label: "Running", hint: "Active agent work" },
  { id: "needs_human", label: "Needs Human", hint: "Blocked on operator" },
  { id: "review", label: "Review", hint: "Awaiting acceptance" },
  { id: "done", label: "Done", hint: "Delivered" },
  { id: "blocked", label: "Blocked", hint: "Hard stop" },
];

export const HARNESS_LABELS: Record<HarnessKind, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  gemini_cli: "Gemini CLI",
  copilot: "Copilot",
  amp: "Amp",
  mcp: "MCP Client",
  custom: "Custom",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  p0: "P0 · Critical",
  p1: "P1 · High",
  p2: "P2 · Normal",
  p3: "P3 · Low",
};

export const COLUMN_STATUS_COLOR: Record<MissionColumn, string> = {
  inbox: "var(--color-status-inbox)",
  ready: "var(--color-status-ready)",
  running: "var(--color-status-running)",
  needs_human: "var(--color-status-human)",
  review: "var(--color-status-review)",
  done: "var(--color-status-done)",
  blocked: "var(--color-status-blocked)",
};

/** Append-only mission column/status change record. */
export interface MissionHistoryEntry {
  id: string;
  missionId: string;
  projectId?: string | null;
  actorId: string | null;
  actorName: string | null;
  /** agent | operator | system */
  actorKind: "agent" | "operator" | "system";
  fromColumn: MissionColumn | null;
  toColumn: MissionColumn;
  at: number;
  note?: string;
  meta?: Record<string, string>;
}
