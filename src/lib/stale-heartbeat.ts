/**
 * Stale-heartbeat policy for Running missions.
 * Pure classifiers — UI and poll/admin surfaces call these.
 */
import type { Mission, MissionColumn } from "./types";

/** Default: 5 minutes without heartbeat on Running → stale risk. */
export const DEFAULT_STALE_HEARTBEAT_MS = 5 * 60 * 1000;

export type MissionHealth = "ok" | "stale" | "orphaned" | "n/a";

export interface StalePolicy {
  /** Max age of lastHeartbeat (or claimedAt fallback) before stale. */
  thresholdMs: number;
  /** Columns that require heartbeats. */
  columns: readonly MissionColumn[];
}

export const DEFAULT_STALE_POLICY: StalePolicy = {
  thresholdMs: DEFAULT_STALE_HEARTBEAT_MS,
  columns: ["running"],
};

/** Effective heartbeat timestamp: lastHeartbeat, else claimedAt, else null. */
export function effectiveHeartbeatAt(m: Pick<Mission, "lastHeartbeat" | "claimedAt">): number | null {
  if (typeof m.lastHeartbeat === "number" && m.lastHeartbeat > 0) return m.lastHeartbeat;
  if (typeof m.claimedAt === "number" && m.claimedAt > 0) return m.claimedAt;
  return null;
}

/**
 * Classify a single mission against the stale policy.
 * - n/a: not in a heartbeat column
 * - orphaned: in heartbeat column but no claim/heartbeat clock
 * - stale: clock older than threshold
 * - ok: fresh heartbeat
 */
export function classifyMissionHealth(
  m: Pick<Mission, "column" | "lastHeartbeat" | "claimedAt" | "claimedBy">,
  nowMs: number,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): MissionHealth {
  if (!policy.columns.includes(m.column)) return "n/a";
  const at = effectiveHeartbeatAt(m);
  if (at == null) return "orphaned";
  if (nowMs - at > policy.thresholdMs) return "stale";
  return "ok";
}

export function isStaleMission(
  m: Pick<Mission, "column" | "lastHeartbeat" | "claimedAt" | "claimedBy">,
  nowMs: number,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): boolean {
  return classifyMissionHealth(m, nowMs, policy) === "stale";
}

/** Running (or policy columns) missions past the threshold — reclaim candidates. */
export function listStaleMissions<T extends Mission>(
  missions: T[],
  nowMs: number,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): T[] {
  return missions.filter((m) => isStaleMission(m, nowMs, policy));
}

export function staleSummary(
  missions: Mission[],
  nowMs: number,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): {
  thresholdMs: number;
  staleCount: number;
  orphanedCount: number;
  okCount: number;
  staleIds: string[];
} {
  let staleCount = 0;
  let orphanedCount = 0;
  let okCount = 0;
  const staleIds: string[] = [];
  for (const m of missions) {
    const h = classifyMissionHealth(m, nowMs, policy);
    if (h === "stale") {
      staleCount++;
      staleIds.push(m.id);
    } else if (h === "orphaned") orphanedCount++;
    else if (h === "ok") okCount++;
  }
  return {
    thresholdMs: policy.thresholdMs,
    staleCount,
    orphanedCount,
    okCount,
    staleIds,
  };
}

export function policyFromEnv(
  env: NodeJS.ProcessEnv = typeof process !== "undefined" ? process.env : {},
): StalePolicy {
  const raw = env.AGENT_RELAY_STALE_HEARTBEAT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return {
    ...DEFAULT_STALE_POLICY,
    thresholdMs:
      Number.isFinite(n) && n >= 1000 ? n : DEFAULT_STALE_HEARTBEAT_MS,
  };
}
