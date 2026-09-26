export type MissionColumn =
  | "inbox"
  | "ready"
  | "running"
  | "needs_human"
  | "review"
  | "done"
  | "blocked";

export type Priority = "p0" | "p1" | "p2" | "p3";

export const COLUMNS: MissionColumn[] = [
  "inbox",
  "ready",
  "running",
  "needs_human",
  "review",
  "done",
  "blocked",
];

export const COLUMN_LABEL: Record<MissionColumn, string> = {
  inbox: "Inbox",
  ready: "Ready",
  running: "Running",
  needs_human: "Needs",
  review: "Review",
  done: "Done",
  blocked: "Blocked",
};

export interface Board {
  id: string;
  name: string;
  slug: string;
  description?: string;
}

export interface Mission {
  id: string;
  projectId: string;
  title: string;
  objective?: string;
  context?: string;
  constraints?: string;
  acceptance?: string;
  column: MissionColumn;
  priority?: Priority | string;
  tags?: string[];
  assigneeId?: string | null;
  claimedBy?: string | null;
  claimedAt?: number | null;
  lastHeartbeat?: number | null;
  progressNote?: string;
  artifacts?: string[];
  createdAt?: number;
  updatedAt?: number;
  delivery?: string | null;
}

export interface HumanCall {
  id: string;
  missionId: string;
  agentId?: string | null;
  question: string;
  urgency?: string;
  createdAt: number;
  resolvedAt?: number | null;
  reply?: string | null;
}

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
  agent: string;
  board: string;
  pollIntervalMs: number;
  staleMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const baseUrl = (env.DEVBOARDS_BASE_URL || "https://app.devboards.ai").replace(/\/$/, "");
  const apiKey = env.DEVBOARDS_API_KEY || "";
  const agent = env.DEVBOARDS_AGENT || "frodo";
  const board = env.DEVBOARDS_BOARD || "";
  const pollIntervalMs = Number(env.DEVBOARDS_POLL_INTERVAL || 30) * 1000;
  const staleMs = Number(env.DEVBOARDS_STALE_MS || 300_000);
  if (!apiKey) {
    throw new Error("DEVBOARDS_API_KEY is required");
  }
  return { baseUrl, apiKey, agent, board, pollIntervalMs, staleMs };
}

export function isStale(m: Mission, staleMs: number, now = Date.now()): boolean {
  if (m.column !== "running") return false;
  const hb = m.lastHeartbeat ?? m.claimedAt ?? m.updatedAt ?? 0;
  if (!hb) return true;
  return now - hb > staleMs;
}
